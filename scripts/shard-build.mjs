#!/usr/bin/env node
/**
 * scripts/shard-build.mjs
 * ------------------------------------------------------------------
 * 分片构建 Quartz 站点。
 *
 * 为什么需要它：
 *   Quartz v5 的解析器会把 content/ 里【所有】文档一次性读进内存，全部解析完
 *   才开始输出。1GB 语料在 16GB 的构建机上必然堆溢出（实测：解析阶段涨到
 *   8GB 被 V8 强杀，exit 134）。
 *
 * 做法（不改动 Quartz 任何源码）：
 *   1) 把 content/ 按目录切成若干小片（每片约 SHARD_MB 兆），每片单独跑一次
 *      `quartz build -d <片目录> -o <片输出目录>`，内存占用按片体积等比下降；
 *   2) 额外再跑一个「骨架片」：包含全部文档、但每篇只保留开头 STUB_CHARS 个字符。
 *      它体积极小，却能生成完整的目录页 / 首页 / sitemap.xml / RSS / 静态资源，
 *      以及完整的 static/contentIndex.json（侧栏导航就是靠这个文件）。
 *   3) 合并：骨架片输出打底 → 各内容片输出覆盖上去。
 *      于是正文页是「真」的，聚合类页面是「全」的。
 *
 * 断点续跑 / 增量：
 *   每片算一个内容哈希，写进 .shard-state/<片名>.hash。
 *   输出目录已存在且哈希一致 → 跳过该片（配合 CI 上的缓存，就只重建改动过的片）。
 *
 * 用法：
 *   node scripts/shard-build.mjs --plan-only    # 只算计划与哈希（生成缓存 key 用）
 *   node scripts/shard-build.mjs                # 构建 + 合并
 *
 * 可调环境变量：
 *   SHARD_MB            每片目标体积上限，默认 120（MB）
 *   SHARD_PARALLEL      同时构建几片，默认 1（串行）。>1 有 esbuild 死锁风险
 *   SHARD_TIMEOUT_MIN   单片超时分钟数，默认 30；超时强杀并报错
 *   SHARD_HEAP_MB       单片 Node 堆上限，默认 4096（MB）
 *   STUB_CHARS          骨架片每篇保留正文字符数，默认 2000
 *   SHARD_FORCE=1       忽略已有输出，全部重建
 *   SHARD_SKIP_MERGE=1  只构建，不合并
 *   SHARD_ALLOW_MISSING=1  允许某些文档没有正文页（默认不允许，直接报错）
 * ------------------------------------------------------------------
 */

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"

// ------------------------------ 配置 ------------------------------
const ROOT = process.cwd()
const CONTENT_DIR = path.join(ROOT, "content")
const SHARD_IN_DIR = path.join(ROOT, ".shards")
const SHARD_OUT_DIR = path.join(ROOT, ".shards-out")
const SHARD_STATE_DIR = path.join(ROOT, ".shard-state")
const DIST_DIR = path.join(ROOT, "public")
const PLAN_FILE = path.join(ROOT, "shard-plan.json")

const MB = 1024 * 1024
const BUDGET_BYTES = Math.max(0.1, Number(process.env.SHARD_MB ?? 120)) * MB
// 默认逐片串行构建：并行跑多个 Quartz 构建会触发 esbuild 服务进程死锁
// （本机实测：同一个分片单独跑 13 秒，两个一起跑会无限卡住）。
// 构建机核数多、又愿意承担风险时，可用 SHARD_PARALLEL=2 试，但要盯日志。
const PARALLEL = Math.max(1, Number(process.env.SHARD_PARALLEL ?? 1))
const TIMEOUT_MIN = Math.max(1, Number(process.env.SHARD_TIMEOUT_MIN ?? 30))
const HEAP_MB = Math.max(512, Number(process.env.SHARD_HEAP_MB ?? 4096))
const STUB_CHARS = Math.max(200, Number(process.env.STUB_CHARS ?? 2000))
const FORCE = process.env.SHARD_FORCE === "1"
const SKIP_MERGE = process.env.SHARD_SKIP_MERGE === "1"
const PLAN_ONLY = process.argv.includes("--plan-only")
const SKELETON_NAME = "s00-skeleton"

// ------------------------------ 工具 ------------------------------
const log = (...a) => console.log(...a)
const fmtMB = (b) => (b / MB).toFixed(1) + "MB"
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex")

async function sha1File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1")
    const s = fs.createReadStream(p)
    s.on("data", (d) => h.update(d))
    s.on("end", () => resolve(h.digest("hex")))
    s.on("error", reject)
  })
}

/** 递归列出目录下所有文件（返回 posix 相对路径） */
async function walkFiles(dir, base = dir, acc = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === "node_modules") continue
      await walkFiles(full, base, acc)
    } else if (e.isFile()) {
      acc.push(path.relative(base, full).split(path.sep).join("/"))
    }
  }
  return acc
}

/** 把一个目录的内容复制进另一个目录（同名覆盖） */
async function copyTree(src, dest) {
  await fsp.mkdir(dest, { recursive: true })
  await fsp.cp(src, dest, { recursive: true, force: true, errorOnExist: false })
}

// --------------------------- 1. 扫描内容 ---------------------------
async function scanContent() {
  const rels = (await walkFiles(CONTENT_DIR)).filter((r) => r.endsWith(".md")).sort()
  const files = []
  for (const rel of rels) {
    const abs = path.join(CONTENT_DIR, rel)
    const st = await fsp.stat(abs)
    files.push({ rel, abs, size: st.size })
  }
  return files
}

// --------------------------- 2. 切分片 ---------------------------
/** 先按目录分组，再把目录按体积装箱；单个目录超预算时按文件切成多段 */
function planShards(files) {
  const groups = new Map()
  for (const f of files) {
    const dir = path.posix.dirname(f.rel)
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir).push(f)
  }

  const units = []
  for (const dir of [...groups.keys()].sort()) {
    const list = groups.get(dir).slice().sort((a, b) => a.rel.localeCompare(b.rel))
    const bytes = list.reduce((s, f) => s + f.size, 0)
    if (bytes <= BUDGET_BYTES) {
      units.push({ label: dir, files: list, bytes })
      continue
    }
    // 超大目录：按预算切块
    let cur = []
    let curBytes = 0
    for (const f of list) {
      if (cur.length && curBytes + f.size > BUDGET_BYTES) {
        units.push({ label: dir + " (part)", files: cur, bytes: curBytes })
        cur = []
        curBytes = 0
      }
      cur.push(f)
      curBytes += f.size
    }
    if (cur.length) units.push({ label: dir + " (part)", files: cur, bytes: curBytes })
  }

  // 装箱：贪心放进当前最小的箱子（体积均衡，而不是目录均衡）
  const shards = []
  for (const u of units) {
    let target = null
    for (const s of shards) {
      if (s.bytes + u.bytes <= BUDGET_BYTES && (!target || s.bytes < target.bytes)) target = s
    }
    if (!target) {
      target = { name: "", label: [], files: [], bytes: 0 }
      shards.push(target)
    }
    target.files.push(...u.files)
    target.label.push(u.label)
    target.bytes += u.bytes
  }

  shards.sort((a, b) => b.bytes - a.bytes)
  return shards.map((s, i) => ({
    name: "s" + String(i + 1).padStart(2, "0"),
    label: s.label.join(" + "),
    bytes: s.bytes,
    files: s.files.map((f) => ({ rel: f.rel, size: f.size })),
  }))
}

async function buildPlan() {
  const files = await scanContent()
  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const shards = planShards(files)

  // 给每个文件算内容哈希（用于分片哈希）
  const relHash = new Map()
  for (const f of files) relHash.set(f.rel, await sha1File(f.abs))

  for (const s of shards) {
    const h = crypto.createHash("sha1")
    h.update(`heap=${HEAP_MB};c=1\n`)
    for (const f of s.files.slice().sort((a, b) => a.rel.localeCompare(b.rel))) {
      h.update(`${f.rel}\t${relHash.get(f.rel)}\n`)
    }
    s.hash = h.digest("hex").slice(0, 16)
  }

  const skelHash = crypto
    .createHash("sha1")
    .update(`stub=${STUB_CHARS}\n`)
    .update(
      [...relHash.keys()]
        .sort()
        .map((r) => `${r}\t${relHash.get(r)}\n`)
        .join(""),
    )
    .digest("hex")
    .slice(0, 16)

  const planHash = sha1(
    JSON.stringify({
      v: 2,
      budget: BUDGET_BYTES,
      stub: STUB_CHARS,
      heap: HEAP_MB,
      skel: skelHash,
      shards: shards.map((s) => [s.name, s.hash]),
    }),
  ).slice(0, 16)

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    totalFiles: files.length,
    totalBytes,
    budgetMB: BUDGET_BYTES / MB,
    stubChars: STUB_CHARS,
    heapMB: HEAP_MB,
    skeleton: { name: SKELETON_NAME, hash: skelHash, labels: ["（骨架片：全部文档的索引副本）"] },
    planHash,
    shards: shards.map((s) => ({
      name: s.name,
      hash: s.hash,
      bytes: s.bytes,
      fileCount: s.files.length,
      label: s.label,
      files: s.files,
    })),
  }
}

// --------------------------- 3. 准备分片输入 ---------------------------
async function materializeContentShard(shard) {
  const dir = path.join(SHARD_IN_DIR, shard.name)
  await fsp.rm(dir, { recursive: true, force: true })
  for (const f of shard.files) {
    const src = path.join(CONTENT_DIR, f.rel)
    const dst = path.join(dir, f.rel)
    await fsp.mkdir(path.dirname(dst), { recursive: true })
    try {
      await fsp.link(src, dst) // 硬链接：不额外占磁盘，秒级完成
    } catch {
      await fsp.copyFile(src, dst)
    }
  }
}

async function materializeSkeleton(plan) {
  const dir = path.join(SHARD_IN_DIR, SKELETON_NAME)
  await fsp.rm(dir, { recursive: true, force: true })
  const all = []
  for (const s of plan.shards) all.push(...s.files)
  for (const f of all) {
    const src = path.join(CONTENT_DIR, f.rel)
    const dst = path.join(dir, f.rel)
    await fsp.mkdir(path.dirname(dst), { recursive: true })
    const HEAD_BYTES = STUB_CHARS * 4 + 16 // 中文最多 3 字节/字，留足余量
    if (f.size <= HEAD_BYTES) {
      await fsp.copyFile(src, dst)
      continue
    }
    const fd = await fsp.open(src, "r")
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
    await fd.close()
    // 末尾可能截断在半个多字节字符上，先丢掉替换符再按字符数截断
    let text = buf.subarray(0, bytesRead).toString("utf8").replace(/\uFFFD+$/g, "")
    if (text.length > STUB_CHARS) text = text.slice(0, STUB_CHARS)
    await fsp.writeFile(dst, text + "\n", "utf8")
  }
  return all.length
}

// --------------------------- 4. 构建 ---------------------------
function runQuartzBuild(shardName, onLine) {
  const inDir = path.relative(ROOT, path.join(SHARD_IN_DIR, shardName)).split(path.sep).join("/")
  const outDir = path.relative(ROOT, path.join(SHARD_OUT_DIR, shardName)).split(path.sep).join("/")
  const args = [
    "quartz/bootstrap-cli.mjs",
    "build",
    "-d",
    inDir,
    "-o",
    outDir,
    "-c",
    "1",
  ]
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let tail = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* 忽略 */
      }
    }, TIMEOUT_MIN * 60 * 1000)
    const push = (chunk) => {
      const text = chunk.toString()
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 40) tail.shift()
        onLine(line)
      }
    }
    child.stdout.on("data", push)
    child.stderr.on("data", push)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, seconds: (Date.now() - t0) / 1000, tail, timedOut })
    })
  })
}

async function runPool(items, parallel, worker) {
  const results = []
  let idx = 0
  let failed = null
  const runners = new Array(Math.min(parallel, items.length)).fill(0).map(async () => {
    while (true) {
      if (failed) return
      const i = idx++
      if (i >= items.length) return
      const r = await worker(items[i], i)
      results.push(r)
      if (r && r.code !== 0) failed = r
    }
  })
  await Promise.all(runners)
  return { results, failed }
}

function tailText(tail, n = 25) {
  return tail.slice(-n).join("\n")
}

/** 从某个分片的索引里取出「源文件 → 输出页面路径」的映射（用 Quartz 自己的 slug 规则，最保险） */
async function slugPairsOf(shardOut, relSet) {
  const idxPath = path.join(shardOut, "static", "contentIndex.json")
  const pairs = []
  const seen = new Set()
  try {
    const idx = JSON.parse(await fsp.readFile(idxPath, "utf8"))
    for (const v of Object.values(idx)) {
      if (!v || !v.filePath || !v.slug) continue
      if (!relSet.has(v.filePath)) continue
      if (seen.has(v.slug)) continue
      seen.add(v.slug)
      pairs.push({ slug: v.slug, rel: v.filePath })
    }
  } catch {
    /* 索引缺失时走下面的兜底 */
  }
  for (const rel of relSet) {
    if (!pairs.some((p) => p.rel === rel)) {
      pairs.push({ slug: rel.replace(/\.md$/, ""), rel })
    }
  }
  return pairs
}

/**
 * 分片输出里的 static/contentIndex.json 会带上每篇【全文】，体积和正文差不多。
 * 但合并阶段只需要它的 slug ↔ filePath 映射，于是构建完就把它瘦身，
 * 免得缓存里塞进一份毫无用处的全文副本（1GB 语料能省下 1GB+）。
 */
async function trimShardIndex(shardOut) {
  const idxPath = path.join(shardOut, "static", "contentIndex.json")
  try {
    const raw = await fsp.readFile(idxPath, "utf8")
    if (raw.length < 200 * 1024) return 0
    const idx = JSON.parse(raw)
    const out = {}
    for (const [slug, v] of Object.entries(idx)) {
      out[slug] = { slug: v.slug, filePath: v.filePath, title: v.title, links: v.links, tags: v.tags }
    }
    const trimmed = JSON.stringify(out)
    await fsp.writeFile(idxPath, trimmed)
    return raw.length - trimmed.length
  } catch {
    return 0
  }
}

// --------------------------- 主流程 ---------------------------
async function main() {
  const t0 = Date.now()
  if (!fs.existsSync(CONTENT_DIR)) {
    console.error(`找不到内容目录：${CONTENT_DIR}`)
    process.exit(1)
  }

  log("== 1/5 扫描内容并制定分片计划 ==")
  const plan = await buildPlan()
  await fsp.writeFile(PLAN_FILE, JSON.stringify(plan, null, 1))
  log(
    `   共 ${plan.totalFiles} 篇 / ${fmtMB(plan.totalBytes)}；切成 ${plan.shards.length} 个内容片，每片上限 ${plan.budgetMB}MB`,
  )
  for (const s of plan.shards) {
    log(`   ${s.name}  ${String(s.fileCount).padStart(4)} 篇  ${fmtMB(s.bytes).padStart(9)}  哈希 ${s.hash}`)
  }
  log(`   计划哈希 planHash=${plan.planHash}`)

  if (PLAN_ONLY) {
    if (process.env.GITHUB_OUTPUT) {
      await fsp.appendFile(
        process.env.GITHUB_OUTPUT,
        `plan_hash=${plan.planHash}\nshard_count=${plan.shards.length}\n`,
      )
    }
    log("   （--plan-only：到此为止）")
    return
  }

  await fsp.mkdir(SHARD_IN_DIR, { recursive: true })
  await fsp.mkdir(SHARD_OUT_DIR, { recursive: true })
  await fsp.mkdir(SHARD_STATE_DIR, { recursive: true })

  // 决定哪些片需要重建
  const tasks = []
  const stateFile = (name) => path.join(SHARD_STATE_DIR, `${name}.hash`)
  const outDirOf = (name) => path.join(SHARD_OUT_DIR, name)
  const isFresh = async (name, hash) => {
    if (FORCE) return false
    try {
      const prev = (await fsp.readFile(stateFile(name), "utf8")).trim()
      if (prev !== hash) return false
      const st = await fsp.stat(outDirOf(name))
      return st.isDirectory()
    } catch {
      return false
    }
  }

  // 骨架片永远重建（体积小、且它决定聚合页面的完整性）
  tasks.push({ name: SKELETON_NAME, hash: plan.skeleton.hash, kind: "skeleton", rebuild: true })
  for (const s of plan.shards) {
    tasks.push({ name: s.name, hash: s.hash, kind: "content", rebuild: !(await isFresh(s.name, s.hash)) })
  }

  const toBuild = tasks.filter((t) => t.rebuild)
  const cached = tasks.filter((t) => !t.rebuild)
  log("")
  log("== 2/5 准备分片输入 ==")
  for (const t of toBuild) {
    if (t.kind === "skeleton") {
      const n = await materializeSkeleton(plan)
      log(`   ${t.name}：生成 ${n} 篇骨架副本（每篇保留 ${plan.stubChars} 字）`)
    } else {
      const shard = plan.shards.find((s) => s.name === t.name)
      await materializeContentShard(shard)
    }
  }
  if (cached.length) log(`   跳过准备（已有输出）：${cached.map((c) => c.name).join(", ")}`)

  log("")
  log(`== 3/5 构建（并发 ${PARALLEL}，单片堆上限 ${HEAP_MB}MB，单片超时 ${TIMEOUT_MIN} 分钟）==`)
  if (PARALLEL > 1) {
    log("   ⚠ 已开启并行构建：Quartz 并发构建曾出现 esbuild 死锁，请留意是否卡住")
  }
  if (cached.length) log(`   命中已有输出，免构建：${cached.map((c) => c.name).join(", ")}`)
  if (toBuild.length === 0) log("   没有需要重建的分片")

  const { results, failed } = await runPool(toBuild, PARALLEL, async (t) => {
    log(`   ▶ ${t.name} 开始构建`)
    const r = await runQuartzBuild(t.name, (line) => {
      if (/error|Error|失败|FATAL|Killed/.test(line)) log(`   [${t.name}] ${line}`)
    })
    if (r.code === 0) {
      const saved = await trimShardIndex(outDirOf(t.name))
      await fsp.writeFile(stateFile(t.name), t.hash + "\n")
      log(
        `   ✔ ${t.name} 完成（${r.seconds.toFixed(0)}s）` +
          (saved > 0 ? `，索引瘦身省下 ${fmtMB(saved)}` : ""),
      )
    } else if (r.timedOut) {
      log(`   ✘ ${t.name} 超时（超过 ${TIMEOUT_MIN} 分钟）已被强制终止`)
      r.code = 124
    } else {
      log(`   ✘ ${t.name} 失败（退出码 ${r.code}，${r.seconds.toFixed(0)}s）`)
    }
    return { name: t.name, ...r }
  })

  if (failed) {
    console.error("")
    console.error(`!! 分片 ${failed.name} 构建失败，最后 25 行日志：`)
    console.error(tailText(failed.tail))
    process.exit(1)
  }

  if (SKIP_MERGE) {
    log("   （SHARD_SKIP_MERGE=1：跳过合并）")
    return
  }

  log("")
  log("== 4/5 合并输出 ==")
  await fsp.rm(DIST_DIR, { recursive: true, force: true })
  await fsp.mkdir(DIST_DIR, { recursive: true })

  // 4.1 骨架片打底：
  //     目录页 / 标签页 / 首页 / 404 / sitemap.xml / RSS / 静态资源 / static/contentIndex.json
  //     这些「聚合类」产物都以看过【全部】文档的骨架片为准；
  //     若让各内容片去覆盖它们，最终只会剩下最后一个分片的局部版本（实测过，目录页会缺文件）。
  await copyTree(outDirOf(SKELETON_NAME), DIST_DIR)

  // 4.2 各内容片只把自己那几篇文档的正文页覆盖上来
  let docCopied = 0
  const missing = []
  for (const shard of plan.shards) {
    const shardOut = outDirOf(shard.name)
    const relSet = new Set(shard.files.map((f) => f.rel))
    const pairs = await slugPairsOf(shardOut, relSet)
    for (const p of pairs) {
      const src = path.join(shardOut, p.slug + ".html")
      const dst = path.join(DIST_DIR, p.slug + ".html")
      if (!fs.existsSync(src)) {
        missing.push(`${p.rel}  →  找不到 ${p.slug}.html`)
        continue
      }
      await fsp.mkdir(path.dirname(dst), { recursive: true })
      await fsp.copyFile(src, dst)
      docCopied++
    }
  }
  log(`   骨架片产出：聚合页 + 侧栏索引 + 静态资源`)
  log(`   内容片覆盖正文页：${docCopied} 篇`)

  // 4.3 完整性校验：每篇源文档都必须有对应的正文页，否则宁可不部署
  if (missing.length) {
    console.error("")
    console.error(`!! 有 ${missing.length} 篇文档没找到生成的正文页：`)
    for (const m of missing.slice(0, 20)) console.error("   " + m)
    if (missing.length > 20) console.error(`   …… 共 ${missing.length} 条`)
    if (process.env.SHARD_ALLOW_MISSING === "1") {
      console.error("   （SHARD_ALLOW_MISSING=1：忽略并继续）")
    } else {
      console.error("   已中止，避免把残缺站点推上线。若确认这些文档本就不该发布，")
      console.error("   把环境变量 SHARD_ALLOW_MISSING 设为 1 再跑一次即可放行。")
      process.exit(1)
    }
  } else {
    log(`   完整性校验通过：${docCopied} 篇文档全部有正文页 ✔`)
  }

  // 清理状态文件残留（避免误入产物）
  log("")
  log("== 5/5 统计 ==")
  let fileCount = 0
  let totalSize = 0
  const oversize = []
  const stack = [DIST_DIR]
  while (stack.length) {
    const d = stack.pop()
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else {
        const st = await fsp.stat(full)
        fileCount++
        totalSize += st.size
        if (st.size > 25 * MB) oversize.push(`${(st.size / MB).toFixed(1)}MB\t${path.relative(DIST_DIR, full)}`)
      }
    }
  }
  log(`   产物目录：public/`)
  log(`   文件数：${fileCount}（Cloudflare Pages 上限 20000）`)
  log(`   总体积：${fmtMB(totalSize)}`)
  try {
    const idx = JSON.parse(await fsp.readFile(path.join(DIST_DIR, "static", "contentIndex.json"), "utf8"))
    const entries = Object.values(idx)
    const linked = entries.filter((v) => (v.links ?? []).length > 0).length
    log(
      `   侧栏索引：${entries.length} 条；其中带内链的 ${linked} 条` +
        (linked === 0 ? "（语料本身几乎没有文档间链接，所以图视图基本是空的，属正常）" : ""),
    )
  } catch {
    log("   ⚠ 没找到 static/contentIndex.json，侧栏可能为空")
  }
  if (oversize.length) {
    log(`   ⚠ 超过 25MiB 单文件上限的文件（有的话会被 Cloudflare 拒收）：`)
    for (const o of oversize) log("     " + o)
  } else {
    log("   单文件均未超过 25MiB ✔")
  }
  log("")
  log(`全部完成，用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
