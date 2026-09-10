// scripts/shrink-index.mjs
// 解决 Cloudflare Pages 的 25MB 单文件限制：
// Quartz 的 content-index 插件开启 enableIndexJson 后，会把每篇文档的【全文】写入
// contentIndex.json。在内容量很大（~1GB）时该文件会达到数百 MB，导致部署失败。
//
// 本脚本在 build 之后扫描输出目录，把任何 >20MB 的 JSON 中超长的 "content" 字段清空，
// 使文件体积降到几 MB 以内（graph / explorer / backlinks 只依赖 title/links/tags，不受影响）。
// 全文搜索（search 插件）依赖 content 字段，因此请同时在 quartz.config 中关闭 search 插件。
//
// 运行方式（已在 package.json 的 build 中自动调用）：
//   node scripts/shrink-index.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// Quartz 可能的输出目录
const CANDIDATE_DIRS = ['public', 'docs', 'build'].map((d) => path.join(repoRoot, d))
const SIZE_LIMIT = 20 * 1024 * 1024 // 20MB

function walk(dir, cb) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, cb)
    else if (e.name.endsWith('.json')) cb(full)
  }
}

// 递归清除过长的 content 字段（仅删除正文，保留 title/links/tags/filepath 等）
function stripContent(node, minLen = 500) {
  if (Array.isArray(node)) {
    for (const item of node) stripContent(item, minLen)
  } else if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const val = node[key]
      if (key === 'content' && typeof val === 'string' && val.length > minLen) {
        node[key] = ''
      } else if (val && typeof val === 'object') {
        stripContent(val, minLen)
      }
    }
  }
  return node
}

let processed = 0
for (const dir of CANDIDATE_DIRS) {
  if (!fs.existsSync(dir)) continue
  walk(dir, (file) => {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return
    }
    if (stat.size <= SIZE_LIMIT) return
    console.log(`[shrink-index] 发现大文件 (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${path.relative(repoRoot, file)}`)
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const data = JSON.parse(raw)
      stripContent(data)
      fs.writeFileSync(file, JSON.stringify(data), 'utf8')
      const newSize = fs.statSync(file).size
      console.log(`[shrink-index]   已压缩 -> ${(newSize / 1024 / 1024).toFixed(2)}MB`)
      processed++
    } catch (err) {
      console.error(`[shrink-index]   处理失败: ${err.message}`)
    }
  })
}

if (processed === 0) {
  console.log('[shrink-index] 未发现超过 20MB 的 JSON 文件，无需压缩。')
} else {
  console.log(`[shrink-index] 共处理 ${processed} 个大文件。`)
}
