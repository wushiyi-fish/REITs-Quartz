// scripts/generate-filter-data.mjs
// 扫描 content/ 目录，生成 static/filter-data.json，供筛选页使用。
// 该文件只包含元数据（标题/路径/维度），不含正文，体积极小（远小于 25MB）。
//
// 运行方式（已在 package.json 的 prebuild 中自动调用）：
//   node scripts/generate-filter-data.mjs
//
// 维度识别规则：
//   交易所  : 路径含 sse -> 上交所, szse -> 深交所
//   类型    : 路径含 首发 / 扩募
//   文件类型: 路径含 招募说明书 / 反馈意见 / 回复意见
//   稿别    : 文件名含 申报稿 / 封卷稿 / 反馈回复稿 等
//   披露时间: 文件名中的 YYYYMMDD / YYYY-MM-DD / YYYY年（也可在 frontmatter 用 披露时间/date/year 覆盖）
//   领域/业态: 优先取 frontmatter 的 area/领域、sector/业态；否则按基金名称关键词推断

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const contentDir = path.join(repoRoot, 'content')
const outDir = path.join(repoRoot, 'static')
const outFile = path.join(outDir, 'filter-data.json')

const IGNORE_DIRS = new Set(['private', 'templates', '.obsidian', '.git'])
const SKIP_FILES = new Set(['filter.md', 'index.md', 'contentIndex.json', 'index.json'])

// ---------- 工具函数 ----------
function walk(dir, cb) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(full, cb)
    } else {
      cb(full)
    }
  }
}

function parseFrontmatter(filePath) {
  try {
    const head = fs.readFileSync(filePath, 'utf8').slice(0, 8192)
    const m = head.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!m) return {}
    const fm = {}
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^([A-Za-z一-龥_]+)\s*[:：]\s*(.*)$/)
      if (mm) fm[mm[1].trim()] = mm[2].trim().replace(/^["']|["']$/g, '')
    }
    return fm
  } catch {
    return {}
  }
}

// 关键词 -> { sector(业态), area(领域) }
const SECTOR_RULES = [
  [/数据中心|算力|idc/i, { sector: '数据中心', area: '基础设施' }],
  [/光伏|风电|水电|核电|能源|京能|三峡/i, { sector: '能源', area: '基础设施' }],
  [/保障性租赁住房|安居|有巢|保障房|华润有巢|公租房/i, { sector: '租赁住房', area: '基础设施' }],
  [/仓储物流|普洛斯|物流/i, { sector: '仓储物流', area: '基础设施' }],
  [/水务|首创|环保|生态|水利|供热|供气|污水处理/i, { sector: '环保水务', area: '基础设施' }],
  [/产业园|智造|张江|临港|东久|高新|经开/i, { sector: '产业园', area: '基础设施' }],
  [/消费|购物中心|百货|奥特莱斯|金鹰|万象|大悦城|吾悦|天街|凯德|龙湖|太古|商业/i, { sector: '消费', area: '商业不动产' }],
  [/写字楼|办公|酒店|公寓/i, { sector: '办公酒店', area: '商业不动产' }],
]

function inferSectorArea(text) {
  for (const [re, val] of SECTOR_RULES) {
    if (re.test(text)) return val
  }
  return { sector: '其他', area: '其他' }
}

function detectDate(text) {
  // YYYYMMDD
  let m = text.match(/(\d{4})(\d{2})(\d{2})/)
  if (m) return { year: m[1], date: `${m[1]}-${m[2]}-${m[3]}` }
  // YYYY-MM-DD 或 YYYY_MM_DD
  m = text.match(/(\d{4})[-_.](\d{2})[-_.](\d{2})/)
  if (m) return { year: m[1], date: `${m[1]}-${m[2]}-${m[3]}` }
  // YYYY年
  m = text.match(/(\d{4})\s*年/)
  if (m) return { year: m[1], date: m[1] }
  return { year: '', date: '' }
}

function detectVersion(base) {
  if (/封卷稿/.test(base)) return '封卷稿'
  if (/反馈回复稿|反馈意见回复/.test(base)) return '反馈回复稿'
  if (/反馈意见/.test(base)) return '反馈意见'
  if (/申报稿|草案/.test(base)) return '申报稿'
  if (/问询/.test(base)) return '问询'
  return ''
}

// ---------- 主逻辑 ----------
const files = []
if (!fs.existsSync(contentDir)) {
  console.error(`[generate-filter-data] 未找到 content 目录: ${contentDir}`)
  process.exit(1)
}

walk(contentDir, (file) => {
  const rel = path.relative(contentDir, file).split(path.sep).join('/')
  if (!rel.toLowerCase().endsWith('.md')) return
  const base = path.basename(rel, '.md')
  if (SKIP_FILES.has(base + '.md')) return

  const segments = rel.split('/').slice(0, -1) // 去掉文件名
  const lowerSegs = segments.map((s) => s.toLowerCase())
  const allText = rel

  // 交易所
  let exchange = ''
  if (lowerSegs.some((s) => s === 'sse' || s.includes('上交所'))) exchange = '上交所'
  else if (lowerSegs.some((s) => s === 'szse' || s.includes('深交所'))) exchange = '深交所'

  // 类型（首发/扩募）
  let type = ''
  if (segments.some((s) => s.includes('扩募'))) type = '扩募'
  else if (segments.some((s) => s.includes('首发'))) type = '首发'

  // 文件类型
  let docType = ''
  if (segments.some((s) => s.includes('招募说明书'))) docType = '招募说明书'
  else if (segments.some((s) => s.includes('反馈意见'))) docType = '反馈意见'
  else if (segments.some((s) => s.includes('回复意见'))) docType = '回复意见'
  else if (segments.some((s) => s.includes('周报'))) docType = '周报'

  const fm = parseFrontmatter(file)

  // 领域 / 业态
  let area = fm.area || fm.领域 || ''
  let sector = fm.sector || fm.业态 || ''
  if (!area || !sector) {
    const inferred = inferSectorArea(allText)
    if (!area) area = inferred.area
    if (!sector) sector = inferred.sector
  }

  // 披露时间
  let { year, date } = detectDate(base)
  if (!year && (fm.披露时间 || fm.date || fm.year)) {
    const fmDate = fm.披露时间 || fm.date || fm.year || ''
    const d = detectDate(fmDate)
    year = d.year
    date = d.date || fmDate
  }

  const version = detectVersion(base)

  // 构建 Quartz 页面 URL：content/x/y/z.md -> /x/y/z/
  const urlPath = rel.replace(/\.md$/, '').split('/').map(encodeURIComponent).join('/')
  const url = '/' + urlPath + '/'

  files.push({
    name: base,
    title: fm.title || base,
    url,
    area,
    sector,
    exchange,
    type,
    docType,
    version,
    year,
    date,
  })
})

files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
const payload = {
  generatedAt: new Date().toISOString(),
  count: files.length,
  files,
}
fs.writeFileSync(outFile, JSON.stringify(payload, null, 0), 'utf8')
console.log(`[generate-filter-data] 已生成 ${files.length} 条记录 -> ${path.relative(repoRoot, outFile)}`)
