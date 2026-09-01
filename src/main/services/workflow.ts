import fs from 'fs'
import path from 'path'
import { dialog } from 'electron'
import ExcelJS from 'exceljs'
import exifr from 'exifr'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { cryptoService } from './crypto'
import { PACKER_REGION_MAP } from './packer'

// ─── Constants and Types ──────────────────────────────────────────────────────

const SUPPORTED_EXTS = new Set(['.JPG', '.JPEG'])
const _GOPRO_NUM_RE = /G(?:OPR|0\d\d)(\d+)/i

// Split de linha CSV com suporte a campos entre aspas (permite o delimitador aparecer
// dentro de um campo citado) — o pandas/csv.DictReader do Python tratam isso
// corretamente; o split ingênuo por delimitador não. Não cobre campo citado com quebra
// de linha embutida (as linhas já vêm pré-quebradas por \r?\n antes de chegar aqui).
function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      result.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  result.push(cur)
  return result
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Python's round() usa "round half to even" (banker's rounding) em vez do
// "round half away from zero" do Math.round do JS — só divergem exatamente em .5.
function roundHalfToEven(n: number): number {
  const floor = Math.floor(n)
  const diff = n - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

const _CANON_INTERNAL: Record<string, string> = {
  wo: 'WO',
  parque: 'Parque',
  complexo: 'Parque',
  wtg: 'WTG',
  aerogerador: 'WTG',
  status: 'Status.',
  ultimoacesso: 'Ultimo Acesso',
  datarecoleta: 'Data recoleta',
  uploada: 'UPLOAD A',
  uploadb: 'UPLOAD B',
  uploadc: 'UPLOAD C',
  bladea: 'BLADE A',
  bladeb: 'BLADE B',
  bladec: 'BLADE C',
}

const _CANON_EXTERNAL: Record<string, string> = {
  wfid: 'WF Id',
  windfarm: 'Wind Farm',
  turbineid: 'Turbine Id',
  status: 'Status',
  uploaddate: 'Upload Date',
  inspectiondate: 'Inspection Date',
}

interface EmailTableRecord {
  site: string
  turbine: string
  blade: string
  wo: string
  date: string
  client: string
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

export function colKey(name: any): string {
  if (name === null || name === undefined) return ''
  let s = String(name).trim().toLowerCase()
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return s.replace(/[^a-z0-9]/g, '')
}

export function normalizeText(val: any): string {
  if (val === null || val === undefined) return ''
  let s = String(val).trim().toLowerCase()
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  s = s.replace(/[^a-z0-9]/g, '')
  s = s.replace(/([a-z])0+(\d+)/g, '$1$2')
  s = s.replace(/\b0+(\d+)/g, '$1')
  return s
}

export function normalizeWo(val: any): string {
  if (val === null || val === undefined) return ''
  let s = String(val).trim().toLowerCase()
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  s = s.replace(/[^a-z0-9]/g, ' ')
  const parts = s.split(/\s+/)
  const cleanedParts: string[] = []
  for (const p of parts) {
    if (!p) continue
    if (/^\d+$/.test(p)) {
      cleanedParts.push(String(parseInt(p, 10)))
    } else {
      cleanedParts.push(p.replace(/0+(\d+)/g, '$1'))
    }
  }
  return cleanedParts.join('')
}

export function wosMatch(wo1: string, wo2: string): boolean {
  if (!wo1 || !wo2) return true

  const tokenize = (woStr: string): string[] => {
    let s = String(woStr).trim().toLowerCase()
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    const rawParts = s.split(/[^a-z0-9]+/)
    const parts: string[] = []
    for (const p of rawParts) {
      if (!p) continue
      if (/^\d+$/.test(p)) {
        parts.push(String(parseInt(p, 10)))
      } else {
        parts.push(p.replace(/0+(\d+)/g, '$1'))
      }
    }
    return parts
  }

  const p1 = tokenize(wo1)
  const p2 = tokenize(wo2)
  if (p1.length === 0 || p2.length === 0) return true

  const minLen = Math.min(p1.length, p2.length)
  for (let i = 0; i < minLen; i++) {
    if (p1[i] !== p2[i]) return false
  }
  return true
}

export function standardizeTurbineId(turb: any, site: any): string {
  if (turb === null || turb === undefined || String(turb).trim() === '')
    return ''
  let s = String(turb).trim().toLowerCase()
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  let siteClean = String(site).trim().toLowerCase()
  siteClean = siteClean.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  siteClean = siteClean.replace(/[^a-z0-9]/g, '')

  s = s.replace(/[-_]/g, ' ')
  s = s.replace(
    /\b(aca|ge|ica|eur|mv|fl|lh|ve|ave)(viii|vii|vi|iii|ii|iv|ix|x|v|i)\b/g,
    '$1 $2'
  )
  s = s.replace(/\bviii\b/g, '8')
  s = s.replace(/\bvii\b/g, '7')
  s = s.replace(/\bvi\b/g, '6')
  s = s.replace(/\biii\b/g, '3')
  s = s.replace(/\bii\b/g, '2')
  s = s.replace(/\biv\b/g, '4')
  s = s.replace(/\bi\b/g, '1')
  s = s.replace(/\bv\b/g, '5')
  s = s.replace(/\bix\b/g, '9')
  s = s.replace(/\bx\b/g, '10')
  s = s.replace(/\bpa2\b/g, 'p2a')
  s = s.replace(/\bpb2\b/g, 'p2b')
  s = s.replace(/\bpb3\b/g, 'p3b')

  if (siteClean.includes('folhalarga')) {
    s = s.replace(/\bsja02\b/g, 'sja22')
    s = s.replace(/\bsja2\b/g, 'sja22')
  }

  s = s.replace(/^(aeros?|wtg|aerogerador|turbine|maquina)\b/g, '')
  s = s.replace(/^aero\s+/g, '')
  s = s.replace(/\b(sg|ts)\b/g, '')
  s = s.replace(/([0-9])(sg|ts)\b/g, '$1')

  if (siteClean.includes('quixaba')) {
    s = s.replace(/^(qxb|qui)(?=[0-9]|\b)/g, '')
  } else if (siteClean.includes('gravier')) {
    s = s.replace(/^(grr|grv)(?=[0-9]|\b)/g, '')
  } else if (siteClean.includes('assurua')) {
    s = s.replace(/^(as4|as5|as3|as|a)(?=[0-9]|\b)/g, '')
  } else if (siteClean.includes('catanduba')) {
    s = s.replace(/^cat(?=[0-9]|\b)/g, '')
  } else if (siteClean.includes('serido')) {
    s = s.replace(/^ser(?=[0-9]|\b)/g, '')
  } else if (siteClean.includes('chui')) {
    s = s.replace(/^ch(?=[0-9]|\b)/g, '')
  } else if (
    siteClean.includes('coxilha') ||
    siteClean.includes('entorno') ||
    siteClean.includes('cerrochato')
  ) {
    s = s.replace(/^(ecn|cn|ecc|ecse)(?=[0-9]|\b)/g, '')
  }

  s = s
    .split(/\s+/)
    .map(p => {
      if (/^[0-9]+$/.test(p)) {
        return p.replace(/^0+(\d)/, '$1')
      }
      return p
    })
    .join(' ')

  s = s.replace(/[^a-z0-9]/g, '')
  s = s.replace(/([a-z])0+(\d+)/g, '$1$2')
  s = s.replace(/\b0+(\d+)/g, '$1')
  return s
}

export function turbinesMatch(t1: string, t2: string, site = ''): boolean {
  const t1Std = standardizeTurbineId(t1, site)
  const t2Std = standardizeTurbineId(t2, site)
  if (t1Std === t2Std) return true
  if (!t1Std || !t2Std) return false

  const n1 = t1Std.match(/\d+/g)
  const n2 = t2Std.match(/\d+/g)
  if (n1 && n2) {
    if (parseInt(n1[n1.length - 1], 10) === parseInt(n2[n2.length - 1], 10)) {
      const p1 = t1Std.replace(/\d/g, '')
      const p2 = t2Std.replace(/\d/g, '')
      if (!p1 || !p2 || p1 === p2) return true
    }
  }
  return false
}

export function sitesMatch(site1: string, site2: string, turbId = ''): boolean {
  let s1 = normalizeText(site1)
  let s2 = normalizeText(site2)
  if (!s1 || !s2) return false

  const tClean = String(turbId).trim().toLowerCase()
  if (
    tClean.startsWith('ica') &&
    (s1.includes('acaua') || s2.includes('acaua')) &&
    (s1.includes('icara') || s2.includes('icara'))
  ) {
    return true
  }
  if (
    tClean.startsWith('ecc') &&
    (s1.includes('coxilha') || s2.includes('coxilha')) &&
    (s1.includes('cerrochato') || s2.includes('cerrochato'))
  ) {
    return true
  }
  if (
    (tClean.startsWith('ecse') || tClean.startsWith('ese')) &&
    (s1.includes('coxilha') || s2.includes('coxilha')) &&
    (s1.includes('entorno') || s2.includes('entorno'))
  ) {
    return true
  }

  if (s1.includes(s2) || s2.includes(s1)) return true

  const words = [
    'complexoeolico',
    'complexo',
    'eolico',
    'parqueeolico',
    'parque',
    'ventosde',
    'ventos',
    'usina',
  ]
  for (const word of words) {
    if (s1.startsWith(word)) s1 = s1.substring(word.length)
    if (s2.startsWith(word)) s2 = s2.substring(word.length)
  }

  const suffixes = ['sgre', 'ge', 'cesi', '1', '2', '3', '4', '5']
  for (const suffix of suffixes) {
    if (s1.endsWith(suffix)) s1 = s1.substring(0, s1.length - suffix.length)
    if (s2.endsWith(suffix)) s2 = s2.substring(0, s2.length - suffix.length)
  }

  if (!s1 || !s2) return false
  if (s1.includes(s2) || s2.includes(s1)) return true

  for (let i = 0; i < s1.length - 4; i++) {
    const sub = s1.substring(i, i + 5)
    if (s2.includes(sub)) return true
  }

  return false
}

export function parseCsv(content: string): any[] {
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return []

  const delimiter = content.includes(';') ? ';' : ','
  const headers = parseCsvLine(lines[0], delimiter).map(h =>
    h.trim().replace(/^"|"$/g, '')
  )

  const results: any[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    let parts: string[] = []
    let currentPart = ''
    let inQuotes = false
    for (let cIdx = 0; cIdx < line.length; cIdx++) {
      const char = line[cIdx]
      if (char === '"') {
        inQuotes = !inQuotes
      } else if (char === delimiter && !inQuotes) {
        parts.push(currentPart.trim())
        currentPart = ''
      } else {
        currentPart += char
      }
    }
    parts.push(currentPart.trim())

    const obj: any = {}
    headers.forEach((h, idx) => {
      let val = parts[idx] || ''
      val = val.replace(/^"|"$/g, '')
      obj[h] = val
    })
    results.push(obj)
  }
  return results
}

export function parseDate(value: any): Date | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value
  }
  const s = String(value).trim()
  if (!s || ['nat', 'nan', 'none', 'n/a'].includes(s.toLowerCase())) {
    return null
  }

  // ISO style: YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10)
    const month = parseInt(isoMatch[2], 10) - 1
    const day = parseInt(isoMatch[3], 10)
    const d = new Date(year, month, day)
    return isNaN(d.getTime()) ? null : d
  }

  // BR style: DD/MM/YYYY
  const brMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/)
  if (brMatch) {
    const day = parseInt(brMatch[1], 10)
    const month = parseInt(brMatch[2], 10) - 1
    const year = parseInt(brMatch[3], 10)
    const d = new Date(year, month, day)
    return isNaN(d.getTime()) ? null : d
  }

  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

export async function extractGpsAltitude(
  imagePath: string
): Promise<number | null> {
  try {
    const data = await exifr.parse(imagePath)
    if (data && data.GPSAltitude !== undefined) {
      let alt = parseFloat(data.GPSAltitude)
      if (data.GPSAltitudeRef === 1 || data.GPSAltitudeRef === '\u0001') {
        alt = -alt
      }
      return parseFloat(alt.toFixed(3))
    }
  } catch {
    // Ignore and fallback
  }
  return null
}

export function extractDjiTimestamp(filename: string): Date {
  try {
    const parts = filename.split('_')
    if (parts.length >= 2 && parts[1].length === 14) {
      const p = parts[1]
      const year = parseInt(p.substring(0, 4), 10)
      const month = parseInt(p.substring(4, 6), 10) - 1
      const day = parseInt(p.substring(6, 8), 10)
      const hour = parseInt(p.substring(8, 10), 10)
      const min = parseInt(p.substring(10, 12), 10)
      const sec = parseInt(p.substring(12, 14), 10)
      const d = new Date(year, month, day, hour, min, sec)
      if (!isNaN(d.getTime())) return d
    }
  } catch {
    // Ignore
  }
  return new Date(0)
}

function _normalizeFilename(name: string): string {
  let s = name.trim().toLowerCase()
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/[^a-z0-9_\-\.]/g, '')
  const ext = path.extname(s).toLowerCase()
  const stem = path.basename(s, ext)
  return stem + ext
}

function _buildImageCache(
  folder: string,
  sendLog?: (text: string, type?: string) => void
): Record<string, string> {
  const cache: Record<string, string> = {}
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    const list = fs.readdirSync(dir, { withFileTypes: true })
    for (const f of list) {
      const fullPath = path.join(dir, f.name)
      if (f.isDirectory()) {
        if (!f.name.startsWith('.')) walk(fullPath)
      } else {
        const ext = path.extname(f.name).toUpperCase()
        if (SUPPORTED_EXTS.has(ext)) {
          const key = _normalizeFilename(f.name)
          if (cache[key]) {
            if (sendLog) sendLog(`⚠ Duplicado ignorado: ${f.name}`, 'warning')
          } else {
            cache[key] = fullPath
          }
        }
      }
    }
  }
  walk(folder)
  return cache
}

// Lista plana de imagens, sem cache/dedup por nome — usada nos pontos em que o Python
// original percorre a pasta inteira via rglob() e processa cada arquivo físico
// individualmente, mesmo que dois arquivos em subpastas diferentes tenham o mesmo nome
// (caso comum em fotos GoPro sequenciais repetidas por região).
function _listImagesFlat(folder: string): string[] {
  const results: string[] = []
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    const list = fs.readdirSync(dir, { withFileTypes: true })
    for (const f of list) {
      const fullPath = path.join(dir, f.name)
      if (f.isDirectory()) {
        walk(fullPath)
      } else {
        const ext = path.extname(f.name).toUpperCase()
        if (SUPPORTED_EXTS.has(ext)) {
          results.push(fullPath)
        }
      }
    }
  }
  walk(folder)
  return results
}

function formatLocationForName(value: any): number {
  const n = parseFloat(value)
  return isNaN(n) ? -1 : Math.trunc(n)
}

function formatMmPx(value: any): string {
  const n = parseFloat(value)
  return isNaN(n) ? 'UNKNOWN' : n.toFixed(5).replace('.', '_')
}

function _writeMissingFile(
  outputDir: string,
  missing: string[],
  modulo: string
): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const outName = `missing_data_${ts}.txt`
  const outPath = path.join(outputDir, outName)
  const lines = [
    'Arthwind Suite — arquivos nao encontrados',
    `Modulo: ${modulo}`,
    `Data: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    `Total: ${missing.length} arquivo(s)`,
    '-'.repeat(50),
    ...missing,
  ]
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8')
  return outName
}

function _fixPixelMm(values: any[]): any[] {
  const result = [...values]
  const n = result.length

  const isValid = (v: any): boolean => {
    const f = parseFloat(v)
    return !isNaN(f) && f >= 0.1 && f <= 1.0
  }

  for (let i = 0; i < n; i++) {
    if (isValid(result[i])) {
      continue
    }

    let prevIdx: number | null = null
    let prevVal: number | null = null
    for (let j = i - 1; j >= 0; j--) {
      if (isValid(result[j])) {
        prevIdx = j
        prevVal = parseFloat(result[j])
        break
      }
    }

    let nextIdx: number | null = null
    let nextVal: number | null = null
    for (let j = i + 1; j < n; j++) {
      if (isValid(result[j])) {
        nextIdx = j
        nextVal = parseFloat(result[j])
        break
      }
    }

    if (
      prevVal !== null &&
      nextVal !== null &&
      prevIdx !== null &&
      nextIdx !== null
    ) {
      const t = (i - prevIdx) / (nextIdx - prevIdx)
      result[i] = parseFloat((prevVal + t * (nextVal - prevVal)).toFixed(6))
    } else if (prevVal !== null) {
      result[i] = prevVal
    } else if (nextVal !== null) {
      result[i] = nextVal
    }
  }

  return result.map(v => (typeof v === 'number' ? v : parseFloat(v) || 0))
}

// ─── IMAP / EML Parser ────────────────────────────────────────────────────────

export function parseEmailTables(htmlContent: string): EmailTableRecord[] {
  const tables: string[][][] = []
  let currentTable: string[][] = []
  let currentRow: string[] = []
  let currentCell: string[] = []
  let inTd = false
  let inTh = false

  const tagRegex = /<([^>]+)>/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tagRegex.exec(htmlContent)) !== null) {
    const textBetween = htmlContent.substring(lastIndex, match.index)
    if (inTd || inTh) {
      currentCell.push(textBetween)
    }

    const tagContent = match[1].trim()
    const tagName = tagContent.split(/\s+/)[0].toLowerCase()

    if (tagName === 'td' || tagName === 'th') {
      inTd = tagName === 'td'
      inTh = tagName === 'th'
      currentCell = []
    } else if (tagName === '/td' || tagName === '/th') {
      inTd = false
      inTh = false
      const cellText = currentCell
        .join('')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#\d+;/g, '')
        .trim()
      currentRow.push(cellText)
    } else if (tagName === 'tr') {
      currentRow = []
    } else if (tagName === '/tr') {
      if (currentRow.length > 0) {
        currentTable.push(currentRow)
      }
    } else if (tagName === 'table') {
      currentTable = []
    } else if (tagName === '/table') {
      if (currentTable.length > 0) {
        tables.push(currentTable)
      }
    }

    lastIndex = tagRegex.lastIndex
  }

  const records: EmailTableRecord[] = []
  for (const table of tables) {
    let siteCol = -1
    let turbCol = -1
    let bladeCol = -1
    let woCol = -1
    let clientCol = -1
    let dateCol = -1
    let headerIdx = -1

    for (let idx = 0; idx < Math.min(5, table.length); idx++) {
      const row = table[idx]
      const rowLower = row.map(c => c.toLowerCase())
      for (let colIdx = 0; colIdx < rowLower.length; colIdx++) {
        const colVal = rowLower[colIdx]

        if (
          [
            'site',
            'parque',
            'complexo',
            'farm',
            'projeto',
            'empreendimento',
            'wind park',
            'wind_farm',
          ].some(kw => colVal.includes(kw))
        ) {
          siteCol = colIdx
        }
        if (
          [
            'turbine',
            'turbina',
            'wtg',
            'aerogerador',
            'aerog',
            'maquina',
            'máquina',
          ].some(kw => colVal.includes(kw))
        ) {
          turbCol = colIdx
        }
        if (
          ['blade', 'pa', 'pá', 'component', 'blade_id'].some(kw =>
            colVal.includes(kw)
          )
        ) {
          bladeCol = colIdx
        }
        if (
          ['wo', 'work order', 'os', 'ordem', 'descri'].some(kw =>
            colVal.includes(kw)
          )
        ) {
          woCol = colIdx
        }
        if (
          ['cliente', 'client', 'contratante', 'customer'].some(kw =>
            colVal.includes(kw)
          )
        ) {
          clientCol = colIdx
        }
        if (
          [
            'data coleta',
            'data da coleta',
            'data inspec',
            'inspection date',
            'date of inspection',
            'coleta',
          ].some(kw => colVal.includes(kw))
        ) {
          dateCol = colIdx
        } else if (
          dateCol === -1 &&
          ['date', 'data'].some(kw => colVal.includes(kw))
        ) {
          dateCol = colIdx
        }
      }

      if (siteCol !== -1 && turbCol !== -1) {
        headerIdx = idx
        break
      }
    }

    if (headerIdx !== -1) {
      for (let rIdx = headerIdx + 1; rIdx < table.length; rIdx++) {
        const row = table[rIdx]
        if (row.length > Math.max(siteCol, turbCol)) {
          const siteVal = row[siteCol]?.trim() || ''
          const turbVal = row[turbCol]?.trim() || ''
          const bladeVal =
            bladeCol !== -1 && row.length > bladeCol
              ? row[bladeCol]?.trim() || ''
              : ''
          const woVal =
            woCol !== -1 && row.length > woCol ? row[woCol]?.trim() || '' : ''
          const dateVal =
            dateCol !== -1 && row.length > dateCol
              ? row[dateCol]?.trim() || ''
              : ''
          const clientVal =
            clientCol !== -1 && row.length > clientCol
              ? row[clientCol]?.trim() || ''
              : ''

          if (siteVal && turbVal) {
            records.push({
              site: siteVal,
              turbine: turbVal,
              blade: bladeVal,
              wo: woVal,
              date: dateVal,
              client: clientVal,
            })
          }
        }
      }
    }
  }

  if (records.length === 0) {
    const lines = htmlContent
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    for (const line of lines) {
      const parts = line.split('\t').map(p => p.trim())
      if (parts.length >= 2) {
        const firstLower = parts[0].toLowerCase()
        const secondLower = parts[1].toLowerCase()
        if (
          ['site', 'parque', 'complexo', 'farm'].includes(firstLower) ||
          ['turbine', 'turbina', 'wtg', 'aerogerador'].includes(secondLower)
        ) {
          continue
        }

        let detectedDate = ''
        for (let i = 2; i < parts.length; i++) {
          const p = parts[i]
          if (
            /^\d{4}[-/]\d{2}[-/]\d{2}/.test(p) ||
            /^\d{2}[-/]\d{2}[-/]\d{4}/.test(p)
          ) {
            detectedDate = p
            break
          }
        }

        records.push({
          site: parts[0],
          turbine: parts[1],
          blade: parts[2] || '',
          wo: parts[3] || '',
          date: detectedDate,
          client: parts[4] || '',
        })
      }
    }
  }

  return records
}

export async function fetchEmailViaImap(config: any): Promise<any> {
  const client = new ImapFlow({
    host: config.host,
    port: parseInt(config.port, 10) || 993,
    secure: config.use_ssl !== false,
    auth: {
      user: config.username,
      pass: config.password,
    },
    logger: false,
  })

  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')

    const criteria = config.subject_filter
      ? { subject: config.subject_filter }
      : { all: true }
    const searchRes = await client.search(criteria)
    const uids = searchRes || []

    uids.sort((a, b) => a - b)
    const limit = 15
    const selectedUids = uids.slice(-limit)

    const allRecords: any[] = []
    let latestDate = 'N/A'
    let latestBody = ''

    for (let i = selectedUids.length - 1; i >= 0; i--) {
      const uid = selectedUids[i]
      const msgData = await client.fetchOne(String(uid), { source: true })
      if (msgData && msgData.source) {
        const parsed = await simpleParser(msgData.source)
        const emailDate = parsed.date ? parsed.date.toString() : 'N/A'
        if (i === selectedUids.length - 1) {
          latestDate = emailDate
        }

        const body = parsed.html || parsed.text || ''
        if (i === selectedUids.length - 1) {
          latestBody = body
        }

        const recs = parseEmailTables(body)
        recs.forEach((r: any) => {
          r.date =
            r.date ||
            (parsed.date ? parsed.date.toISOString().split('T')[0] : 'N/A')
          allRecords.push(r)
        })
      }
    }

    lock.release()
    await client.logout()

    return {
      success: true,
      body: latestBody,
      email_date: latestDate,
      records: allRecords,
    }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || String(err),
    }
  }
}

// ─── Smartsheet / Excel Layout detection ──────────────────────────────────────

async function readExcelAsJson(
  buffer: Buffer,
  sheetPattern?: RegExp
): Promise<any[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as any)

  let worksheet = workbook.worksheets[0]
  if (sheetPattern) {
    for (const ws of workbook.worksheets) {
      if (sheetPattern.test(ws.name.toUpperCase())) {
        worksheet = ws
        break
      }
    }
  }

  const results: any[] = []
  if (!worksheet) return results

  const headers: string[] = []
  const headerRow = worksheet.getRow(1)
  for (let col = 1; col <= worksheet.columnCount; col++) {
    const val = headerRow.getCell(col).text
    headers[col] = val ? val.trim() : ''
  }

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return

    const obj: any = {}
    let hasData = false
    for (let col = 1; col <= worksheet.columnCount; col++) {
      const header = headers[col]
      if (!header) continue

      const cell = row.getCell(col)
      let val: any = cell.value
      if (val && typeof val === 'object' && 'result' in val) {
        val = val.result
      }
      if (cell.type === ExcelJS.ValueType.Date) {
        val = cell.value
      }

      obj[header] = val !== null && val !== undefined ? val : ''
      if (val !== null && val !== undefined && val !== '') {
        hasData = true
      }
    }

    if (hasData) {
      results.push(obj)
    }
  })

  return results
}

function _detectLayout(rows: any[]): { canonRows: any[]; isInternal: boolean } {
  if (rows.length === 0) return { canonRows: [], isInternal: false }

  const headers = Object.keys(rows[0])
  const keys = new Set(headers.map(colKey))

  const hasExternal =
    keys.has('wfid') || keys.has('turbineid') || keys.has('windfarm')
  const hasInternal =
    keys.has('wtg') ||
    keys.has('bladea') ||
    (keys.has('wo') && keys.has('parque'))

  let isInternal = false
  if (hasExternal && !hasInternal) {
    isInternal = false
  } else if (hasInternal && !hasExternal) {
    isInternal = true
  } else {
    // Search ambiguous fields in values
    isInternal = false
    for (let idx = 0; idx < Math.min(rows.length, 10); idx++) {
      const rowVals = Object.values(rows[idx]).map(colKey)
      const valKeys = new Set(rowVals)
      if (valKeys.has('wo') || valKeys.has('wtg') || valKeys.has('bladea')) {
        isInternal = true
        break
      }
    }
  }

  const canon = isInternal ? _CANON_INTERNAL : _CANON_EXTERNAL
  const canonRows = rows.map(row => {
    const newRow: any = {}
    Object.keys(row).forEach(key => {
      const k = colKey(key)
      if (canon[k]) {
        newRow[canon[k]] = row[key]
      } else {
        newRow[key] = row[key]
      }
    })
    return newRow
  })

  return { canonRows, isInternal }
}

function writeSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  data: any[]
): void {
  if (!data || data.length === 0) return
  const ws = workbook.addWorksheet(sheetName)

  const headers = Object.keys(data[0])
  ws.columns = headers.map(h => ({ header: h, key: h, width: 22 }))

  data.forEach(item => {
    const rowObj: any = {}
    headers.forEach(h => {
      let val = item[h]
      if (val instanceof Date) {
        rowObj[h] = val.toISOString().split('T')[0]
      } else {
        rowObj[h] = val !== null && val !== undefined ? String(val) : ''
      }
    })
    ws.addRow(rowObj)
  })
}

// ─── Exported Electron IPC Services ──────────────────────────────────────────

export async function buscarSmartsheetApi(
  sheetId: string,
  token?: string
): Promise<any> {
  try {
    const finalToken = (token || 'QfVWUV2PCDT63FIadzJqQxdUFNCX0iSwFkfQA').trim()
    let finalSheetId = sheetId.trim()

    if (finalSheetId.includes('/')) {
      if (finalSheetId.includes('/sheets/')) {
        const parts = finalSheetId.split('/sheets/')
        finalSheetId = parts[1].split('?')[0]
      } else {
        finalSheetId =
          finalSheetId.split('/').pop()?.split('?')[0] || finalSheetId
      }
    }

    const res = await fetch(
      `https://api.smartsheet.com/2.0/sheets/${finalSheetId}`,
      {
        headers: {
          Authorization: `Bearer ${finalToken}`,
          Accept: 'application/vnd.ms-excel',
        },
      }
    )

    if (!res.ok) {
      const errText = await res.text()
      return {
        success: false,
        error: `Smartsheet API erro (${res.status}): ${errText.substring(0, 200)}`,
      }
    }

    const arrayBuffer = await res.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const tempDir = path.join(process.cwd(), 'temp_smartsheet_downloads')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    // Clean old files
    const now = Date.now()
    const files = fs.readdirSync(tempDir)
    for (const file of files) {
      try {
        const filePath = path.join(tempDir, file)
        const stats = fs.statSync(filePath)
        if (now - stats.mtimeMs > 3600 * 1000) {
          fs.unlinkSync(filePath)
        }
      } catch {
        // Ignore
      }
    }

    const tempFilePath = path.join(
      tempDir,
      `smartsheet_${finalSheetId}_${Math.floor(now / 1000)}.xlsx`
    )
    fs.writeFileSync(tempFilePath, buffer)

    return {
      success: true,
      file_path: tempFilePath,
      fileName: `smartsheet_${finalSheetId}.xlsx`,
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

async function _parseOperationalForm(
  operationalFormContent: Buffer,
  startDate?: string,
  endDate?: string
): Promise<Record<string, any>> {
  const operationalRecords: Record<string, any> = {}
  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(operationalFormContent as any)

    let worksheet = workbook.worksheets[0]
    for (const ws of workbook.worksheets) {
      if (/FORM_OPERACIONAL|OPERACIONAL/i.test(ws.name.toUpperCase())) {
        worksheet = ws
        break
      }
    }
    if (!worksheet) return operationalRecords

    const headers: string[] = []
    const headerRow = worksheet.getRow(1)
    headerRow.eachCell((cell, colNumber) => {
      headers[colNumber] = cell.text ? String(cell.text).trim() : ''
    })

    const sd = startDate ? parseDate(startDate) : null
    const ed = endDate ? parseDate(endDate) : null

    const aeroCols: { colIndex: number; name: string }[] = []
    headers.forEach((h, idx) => {
      if (h && /^AERO\s*\d+$/i.test(h)) {
        aeroCols.push({ colIndex: idx, name: h })
      }
    })

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return

      let rawDate: any = null
      let woVal = ''
      let siteOrig = ''
      let pilot = ''
      let helper = ''
      let drone = ''
      let escopo = ''

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const header = headers[colNumber]
        if (!header) return
        const hUpper = header.toUpperCase()
        if (hUpper === 'DATA') rawDate = cell.value
        else if (hUpper === 'WO')
          woVal = cell.text ? String(cell.text).trim() : ''
        else if (hUpper === 'PROJETO')
          siteOrig = cell.text ? String(cell.text).trim() : ''
        else if (hUpper === 'PILOTO')
          pilot = cell.text ? String(cell.text).trim() : ''
        else if (hUpper === 'AUXILIAR')
          helper = cell.text ? String(cell.text).trim() : ''
        else if (hUpper === 'DRONE')
          drone = cell.text ? String(cell.text).trim() : ''
        else if (hUpper === 'ESCOPO')
          escopo = cell.text ? String(cell.text).trim() : ''
      })

      if (escopo && escopo.toUpperCase().trim() !== 'EXTERNAS') {
        return
      }

      if (!rawDate) return
      const dt = parseDate(rawDate)
      if (dt) {
        if (sd && dt < sd) return
        if (ed && dt > ed) return
      }

      const dateStr = dt
        ? dt.toISOString().split('T')[0]
        : String(rawDate).trim()
      const woNorm = normalizeWo(woVal)
      const siteNorm = normalizeText(siteOrig)

      aeroCols.forEach(col => {
        const cell = row.getCell(col.colIndex)
        const turbVal = cell.text ? String(cell.text).trim() : ''
        if (turbVal) {
          const turbOrig = turbVal
          const turbNorm = standardizeTurbineId(turbOrig, siteOrig)
          if (siteNorm && turbNorm) {
            const key = `${siteNorm}_${turbNorm}_${woNorm}`
            operationalRecords[key] = {
              site_orig: siteOrig,
              turb_orig: turbOrig,
              wo: woVal,
              wo_norm: woNorm,
              date: dateStr,
              pilot: pilot || 'N/A',
              helper: helper || 'N/A',
              drone: drone || 'N/A',
              _key: [siteNorm, turbNorm, woNorm],
            }
          }
        }
      })
    })
  } catch (e) {
    console.error('Error parsing operational form:', e)
  }
  return operationalRecords
}

// Staged matching: (1) site, (2) janela de data ≤45d, (3) preferência de WO, (4) nome da
// turbina. O nome da turbina só é comparado DENTRO do pool já escolhido por data/WO (nunca
// misturando entre pools) — isso evita que nomes genéricos (WTG1, WTG2…) cruzem campanhas
// diferentes. Replica _staged_match do Python (workflow_processor.py) passo a passo.
function _stagedMatch(
  refDate: string,
  refWo: string,
  refSiteNorm: string,
  refTurbNorm: string,
  refSiteOrig: string,
  candidates: Record<string, any>
): { matchedVal: any; woMismatch: boolean } | null {
  const refDateOk = !!refDate && refDate !== 'N/A'
  const refDt = refDateOk ? parseDate(refDate) : null

  const woPool: { val: any; diff: number }[] = []
  const datePool: { val: any; diff: number }[] = []
  const nodatePool: any[] = []

  for (const val of Object.values(candidates)) {
    const key = val._key
    if (!key) continue
    const cSiteNorm = key[0]
    const candDate = val.date || ''
    const candDateOk = !!candDate && candDate !== 'N/A'

    if (!sitesMatch(refSiteNorm, cSiteNorm, val.turb_orig || '')) {
      continue
    }

    if (refDateOk && candDateOk) {
      const candDt = parseDate(candDate)
      const diff =
        refDt && candDt
          ? Math.abs(
              Math.round(
                (refDt.getTime() - candDt.getTime()) / (1000 * 60 * 60 * 24)
              )
            )
          : null
      if (diff === null || diff > 45) continue
      if (wosMatch(refWo, val.wo || '')) {
        woPool.push({ val, diff })
      } else {
        datePool.push({ val, diff })
      }
    } else {
      nodatePool.push(val)
    }
  }

  let pool: any[]
  let woMismatch: boolean
  if (woPool.length > 0) {
    pool = [...woPool].sort((a, b) => a.diff - b.diff).map(x => x.val)
    woMismatch = false
  } else if (datePool.length > 0) {
    pool = [...datePool].sort((a, b) => a.diff - b.diff).map(x => x.val)
    woMismatch = true
  } else {
    pool = nodatePool
    woMismatch = false
  }

  for (const val of pool) {
    const key = val._key
    if (turbinesMatch(refTurbNorm, key[1], refSiteOrig)) {
      return { matchedVal: val, woMismatch }
    }
  }

  return null
}

export async function analisarWorkflow(
  smartsheetPath: string,
  startDate?: string,
  endDate?: string,
  vendorPath?: string,
  emailContent?: string,
  emailFilePath?: string,
  imapConfig?: any,
  operationalFormPath?: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Carregando planilha principal...', 'info')
    const ssBuffer = fs.readFileSync(smartsheetPath)
    const rawRows = await readExcelAsJson(
      ssBuffer,
      /003|INTERNOS|ATW_QLDE_003|034|EXTERNAS|ATW_QLDE_034/i
    )

    if (rawRows.length === 0) {
      return {
        success: false,
        error: 'Planilha do Smartsheet vazia ou aba não reconhecida.',
      }
    }

    const { canonRows, isInternal } = _detectLayout(rawRows)

    let obsCol = ''
    if (canonRows.length > 0) {
      for (const col of Object.keys(canonRows[0])) {
        if (col.toLowerCase().includes('observ')) {
          obsCol = col
          break
        }
      }
    }
    if (!obsCol) {
      obsCol = isInternal ? 'Observações sobre coleta' : 'Observações'
    }

    const requiredCols = isInternal
      ? ['WO', 'Parque', 'WTG', 'Status.']
      : ['WF Id', 'Wind Farm', 'Turbine Id', 'Status']
    const firstRow = canonRows[0] || {}
    const missing = requiredCols.filter(col => !(col in firstRow))
    if (missing.length > 0) {
      return {
        success: false,
        error: `Colunas ${isInternal ? 'internas' : 'externas'} obrigatórias não encontradas: ${missing.join(', ')}`,
      }
    }

    let df = canonRows.filter(row => {
      const camp = isInternal ? row['WO'] : row['WF Id']
      if (camp === null || camp === undefined || String(camp).trim() === '')
        return false
      if (/MNT/i.test(String(camp))) return false
      return true
    })

    const dateCol = isInternal ? 'Ultimo Acesso' : 'Inspection Date'
    const sd = startDate ? parseDate(startDate) : null
    const ed = endDate ? parseDate(endDate) : null

    if (sd || ed) {
      df = df.filter(row => {
        const val = row[dateCol]
        if (!val) return false
        const dt = parseDate(val)
        if (!dt) return false
        if (sd && dt < sd) return false
        if (ed && dt > ed) return false
        return true
      })
    }

    if (df.length === 0) {
      return {
        success: false,
        error: 'Nenhum registro encontrado após os filtros básicos/datas.',
      }
    }

    const checkIsGround = (row: any): boolean => {
      if (!isInternal) return false
      const wtgStr = String(row['WTG'] || '').toLowerCase()
      const obsStr = String(row[obsCol] || '').toLowerCase()
      const groundSynonyms = [
        'solo',
        'palas en solo',
        'pá em solo',
        'ground',
        'spare',
        'avulsa',
      ]
      return groundSynonyms.some(
        syn => wtgStr.includes(syn) || obsStr.includes(syn)
      )
    }

    let groundRows: any[] = []
    if (isInternal) {
      groundRows = df.filter(checkIsGround)
      df = df.filter(row => !checkIsGround(row))
    }

    df.forEach(row => {
      let isRecoleta = false
      if (isInternal) {
        const recoCol = 'Data recoleta' in row ? 'Data recoleta' : null
        if (recoCol) {
          const val = row[recoCol]
          isRecoleta =
            val !== null &&
            val !== undefined &&
            String(val).trim() !== '' &&
            String(val).trim() !== 'NaT'
        }
      } else {
        const statusVal = row['Status']
        isRecoleta =
          statusVal !== null &&
          statusVal !== undefined &&
          String(statusVal).includes('*')
      }
      row['Is_Recoleta'] = isRecoleta

      let statusRecoleta = 'N/A'
      if (isRecoleta) {
        if (isInternal) {
          const statusVal = String(row['Status.'] || '').toLowerCase()
          if (
            statusVal.includes('verde') ||
            statusVal.includes('cinza') ||
            statusVal.includes('amarelo')
          ) {
            statusRecoleta = 'Concluída'
          } else {
            statusRecoleta = 'Pendente'
          }
        } else {
          const uploadCol = 'Upload Date'
          const upDate = row[uploadCol]
          if (
            upDate !== null &&
            upDate !== undefined &&
            String(upDate).trim() !== '' &&
            String(upDate).trim() !== 'NaT'
          ) {
            statusRecoleta = 'Concluída'
          } else {
            statusRecoleta = 'Pendente'
          }
        }
      }
      row['Status_Recoleta'] = statusRecoleta
    })

    const escapesList: any[] = []
    const campaignCol = isInternal ? 'WO' : 'WF Id'
    const wfCol = isInternal ? 'Parque' : 'Wind Farm'
    const turbCol = isInternal ? 'WTG' : 'Turbine Id'
    const statusColName = isInternal ? 'Status.' : 'Status'

    const groupCounts: Record<string, number> = {}
    df.forEach(row => {
      const camp = String(row[campaignCol] || '').trim()
      const turb = String(row[turbCol] || '').trim()
      const key = `${camp}::${turb}`
      groupCounts[key] = (groupCounts[key] || 0) + 1
    })

    const isVentika = (siteName: string): boolean => {
      return /venti[kc]a/i.test(siteName)
    }

    for (const [key, count] of Object.entries(groupCounts)) {
      if (count > 1) {
        const [camp, turb] = key.split('::')
        const records = df.filter(
          row =>
            String(row[campaignCol] || '').trim() === camp &&
            String(row[turbCol] || '').trim() === turb
        )
        if (records.length === 0) continue

        const siteName = String(records[0][wfCol] || '')
        if (isInternal && isVentika(siteName)) {
          continue
        }

        const hasRecoleta = records.some(r => r['Is_Recoleta'])
        if (!hasRecoleta) {
          escapesList.push({
            Wind_Farm: siteName,
            Turbine_Id: turb,
            Registros: records.length,
            WF_Ids: camp,
          })
        }
      }
    }

    let emailRecords: any[] = []
    let emailStatusMsg = ''
    let emailImapDate = ''

    if (imapConfig && imapConfig.host) {
      sendLog('Buscando e-mails via IMAP...', 'info')
      const resEmail = await fetchEmailViaImap(imapConfig)
      if (resEmail.success) {
        emailRecords = resEmail.records || []
        emailContent = resEmail.body || ''
        emailImapDate = resEmail.email_date || ''
        emailStatusMsg = `Obtido ${emailRecords.length} registros de e-mails via IMAP.`
      } else {
        emailStatusMsg = `Falha ao conectar no IMAP: ${resEmail.error}`
      }
    }

    if (emailFilePath && fs.existsSync(emailFilePath)) {
      try {
        const fPathLower = emailFilePath.toLowerCase()
        if (fPathLower.endsWith('.eml')) {
          sendLog('Lendo arquivo de e-mail .eml...', 'info')
          const emlBuffer = fs.readFileSync(emailFilePath)
          const parsed = await simpleParser(emlBuffer)
          emailImapDate = parsed.date ? parsed.date.toString() : ''
          emailContent = parsed.html || parsed.text || ''
          emailStatusMsg = 'E-mail carregado do arquivo .eml.'
        } else if (
          fPathLower.endsWith('.html') ||
          fPathLower.endsWith('.htm')
        ) {
          emailContent = fs.readFileSync(emailFilePath, 'utf-8')
          emailStatusMsg = 'E-mail carregado do arquivo HTML.'
        } else if (
          fPathLower.endsWith('.xlsx') ||
          fPathLower.endsWith('.xls')
        ) {
          const fileBuffer = fs.readFileSync(emailFilePath)
          const mailRows = await readExcelAsJson(fileBuffer)
          mailRows.forEach(row_e => {
            let site_v = '',
              turb_v = '',
              blade_v = ''
            Object.keys(row_e).forEach(c => {
              const c_lower = c.toLowerCase()
              if (
                [
                  'site',
                  'parque',
                  'complexo',
                  'farm',
                  'projeto',
                  'empreendimento',
                ].some(kw => c_lower.includes(kw))
              ) {
                site_v = String(row_e[c])
              } else if (
                ['turbine', 'turbina', 'wtg', 'aerogerador', 'aerog'].some(kw =>
                  c_lower.includes(kw)
                )
              ) {
                turb_v = String(row_e[c])
              } else if (
                ['blade', 'pa', 'pá', 'component'].some(kw =>
                  c_lower.includes(kw)
                )
              ) {
                blade_v = String(row_e[c])
              }
            })
            if (site_v && turb_v) {
              emailRecords.push({
                site: site_v,
                turbine: turb_v,
                blade: blade_v,
              })
            }
          })
          emailStatusMsg = 'Dados importados de arquivo Excel.'
        } else if (fPathLower.endsWith('.csv')) {
          const csvContent = fs.readFileSync(emailFilePath, 'utf-8')
          const lines = csvContent.split('\n')
          if (lines.length > 1) {
            const headersMail = lines[0]
              .split(',')
              .map(h => h.trim().replace(/^"|"$/g, ''))
            for (let i = 1; i < lines.length; i++) {
              if (!lines[i].trim()) continue
              const parts = lines[i]
                .split(',')
                .map(p => p.trim().replace(/^"|"$/g, ''))
              const row_c: any = {}
              headersMail.forEach((h, idx) => {
                row_c[h] = parts[idx] || ''
              })
              let site_v = '',
                turb_v = '',
                blade_v = ''
              Object.keys(row_c).forEach(c => {
                const c_lower = c.toLowerCase()
                if (
                  [
                    'site',
                    'parque',
                    'complexo',
                    'farm',
                    'projeto',
                    'empreendimento',
                  ].some(kw => c_lower.includes(kw))
                ) {
                  site_v = String(row_c[c])
                } else if (
                  ['turbine', 'turbina', 'wtg', 'aerogerador', 'aerog'].some(
                    kw => c_lower.includes(kw)
                  )
                ) {
                  turb_v = String(row_c[c])
                } else if (
                  ['blade', 'pa', 'pá', 'component'].some(kw =>
                    c_lower.includes(kw)
                  )
                ) {
                  blade_v = String(row_c[c])
                }
              })
              if (site_v && turb_v) {
                emailRecords.push({
                  site: site_v,
                  turbine: turb_v,
                  blade: blade_v,
                })
              }
            }
          }
          emailStatusMsg = 'Dados importados de arquivo CSV.'
        } else {
          emailContent = fs.readFileSync(emailFilePath, 'utf-8')
          emailStatusMsg = 'Conteúdo de e-mail carregado de arquivo de texto.'
        }
      } catch (err: any) {
        emailStatusMsg = `Erro ao ler arquivo de e-mail: ${err.message}`
      }
    }

    if (emailContent && emailRecords.length === 0) {
      emailRecords = parseEmailTables(emailContent)
      if (!emailStatusMsg) {
        emailStatusMsg = 'E-mail colado/processado com sucesso.'
      }
    }

    const emailAuditResults: any[] = []
    const missingSsRows: any[] = []
    let emailError = ''

    if (
      (emailContent || emailFilePath || (imapConfig && imapConfig.host)) &&
      emailRecords.length === 0
    ) {
      emailError =
        'Nenhum dado ou tabela de e-mail pôde ser extraído. Verifique o conteúdo colado ou os parâmetros de busca do IMAP.'
    }

    let fallbackDate = ''
    if (emailImapDate) {
      try {
        const parsedDt = new Date(emailImapDate)
        if (!isNaN(parsedDt.getTime())) {
          const fallbackDt = new Date(parsedDt.getTime() - 24 * 60 * 60 * 1000)
          fallbackDate = fallbackDt.toISOString().split('T')[0]
        }
      } catch {
        fallbackDate = ''
      }
    }

    emailRecords.forEach(r => {
      if (
        !r.date ||
        String(r.date).trim() === '' ||
        String(r.date).trim() === 'N/A'
      ) {
        r.date = fallbackDate || 'N/A'
      }
      const dVal = r.date
      if (dVal && dVal !== 'N/A') {
        const dtParsed = parseDate(dVal)
        if (dtParsed) {
          r.date = dtParsed.toISOString().split('T')[0]
        }
      }
    })

    if (sd || ed) {
      emailRecords = emailRecords.filter(r => {
        const rDate = r.date
        if (!rDate || rDate === 'N/A') return true
        try {
          const dtVal = new Date(rDate)
          if (isNaN(dtVal.getTime())) return true
          if (sd && dtVal < sd) return false
          if (ed && dtVal > ed) return false
          return true
        } catch {
          return true
        }
      })
    }

    const statusCounts = { verde: 0, cinza: 0, amarelo: 0, vermelho: 0 }
    df.forEach(row => {
      const statusVal = String(row[statusColName] || '').toLowerCase()
      if (statusVal.includes('verde')) statusCounts.verde++
      else if (statusVal.includes('cinza')) statusCounts.cinza++
      else if (statusVal.includes('amarelo')) statusCounts.amarelo++
      else if (statusVal.includes('vermelho')) statusCounts.vermelho++
    })

    const triangulacaoData: any = {
      has_vendor: false,
      match: [],
      missing_in_smartsheet: [],
      missing_in_vendor: [],
      status_counts: statusCounts,
      yellow_issues: [],
      recoletas: [],
      divergencias_coleta: [],
      email_audit_results: emailAuditResults,
      email_status_msg: emailStatusMsg,
      email_error: emailError,
      email_parsed_summary: [],
    }

    const ssByTurb: Record<string, any> = {}
    df.forEach(row => {
      const sOrig = row[wfCol]
      const tOrig = row[turbCol]
      const sNorm = normalizeText(sOrig)
      const tNorm = standardizeTurbineId(tOrig, sOrig)
      const woVal = row['WO'] !== undefined ? row['WO'] : row['WF Id']
      const woNorm = normalizeWo(woVal)

      let ssDateVal = ''
      const dateColName = isInternal ? 'Ultimo Acesso' : 'Inspection Date'
      if (row[dateColName]) {
        const dtVal = parseDate(row[dateColName])
        if (dtVal) {
          ssDateVal = dtVal.toISOString().split('T')[0]
        } else {
          ssDateVal = String(row[dateColName]).trim()
        }
      }

      const key = `${sNorm}_${tNorm}_${woNorm}`
      const ssBlades: string[] = []
      if (isInternal) {
        if (
          row['UPLOAD A'] !== null &&
          row['UPLOAD A'] !== undefined &&
          String(row['UPLOAD A']).trim() !== '' &&
          String(row['UPLOAD A']).trim() !== 'NaT'
        ) {
          ssBlades.push('A')
        }
        if (
          row['UPLOAD B'] !== null &&
          row['UPLOAD B'] !== undefined &&
          String(row['UPLOAD B']).trim() !== '' &&
          String(row['UPLOAD B']).trim() !== 'NaT'
        ) {
          ssBlades.push('B')
        }
        if (
          row['UPLOAD C'] !== null &&
          row['UPLOAD C'] !== undefined &&
          String(row['UPLOAD C']).trim() !== '' &&
          String(row['UPLOAD C']).trim() !== 'NaT'
        ) {
          ssBlades.push('C')
        }
      } else {
        const upDateCol = 'Upload Date'
        if (
          row[upDateCol] !== null &&
          row[upDateCol] !== undefined &&
          String(row[upDateCol]).trim() !== '' &&
          String(row[upDateCol]).trim() !== 'NaT'
        ) {
          ssBlades.push('Completo')
        }
      }

      ssByTurb[key] = {
        site_orig: sOrig,
        turb_orig: tOrig,
        wo: woVal,
        date: ssDateVal,
        blades: ssBlades,
        row: row,
        _key: [sNorm, tNorm, woNorm],
      }
    })

    const emailByTurb: Record<string, any> = {}

    if (emailRecords.length > 0) {
      const epBySite: Record<string, string[]> = {}
      emailRecords.forEach(r => {
        const key = `${r.site || ''}::${r.wo || ''}`
        if (!epBySite[key]) epBySite[key] = []
        epBySite[key].push(r.turbine || '')
      })

      const emailParsedSummary = Object.entries(epBySite).map(
        ([key, turbines]) => {
          const [site, wo] = key.split('::')
          return {
            Parque: site,
            WO: wo,
            Turbinas: turbines.join(', '),
            Qtd: turbines.length,
          }
        }
      )
      triangulacaoData.email_parsed_summary = emailParsedSummary

      emailRecords.forEach(r => {
        const sNorm = normalizeText(r.site)
        const tNorm = standardizeTurbineId(r.turbine, r.site)
        const woNorm = normalizeWo(r.wo)
        if (!sNorm || !tNorm) return

        const key = `${sNorm}_${tNorm}_${woNorm}`
        if (!emailByTurb[key]) {
          emailByTurb[key] = {
            site_orig: r.site,
            turb_orig: r.turbine,
            wo: r.wo || '',
            wo_norm: woNorm,
            client: r.client || '',
            date: r.date || 'N/A',
            blades: [],
            _key: [sNorm, tNorm, woNorm],
          }
        }

        if (r.blade) {
          const bladeClean = String(r.blade).toUpperCase()
          const detected: string[] = []
          if (bladeClean.includes('A')) detected.push('A')
          if (bladeClean.includes('B')) detected.push('B')
          if (bladeClean.includes('C')) detected.push('C')
          if (detected.length === 0) {
            if (bladeClean.includes('1')) detected.push('A')
            if (bladeClean.includes('2')) detected.push('B')
            if (bladeClean.includes('3')) detected.push('C')
          }
          if (detected.length > 0) {
            emailByTurb[key].blades.push(...detected)
          } else {
            emailByTurb[key].blades.push(r.blade)
          }
        } else {
          emailByTurb[key].blades.push('Pá')
        }
      })

      for (const emailInfo of Object.values(emailByTurb)) {
        const [eSNorm, eTNorm] = emailInfo._key
        const emailBlades = emailInfo.blades
        const emailCount = emailBlades.length
        const sOrig = emailInfo.site_orig
        const tOrig = emailInfo.turb_orig
        const emailDate = emailInfo.date

        const matchedSsResult = _stagedMatch(
          emailDate,
          emailInfo.wo,
          eSNorm,
          eTNorm,
          sOrig,
          ssByTurb
        )

        if (!matchedSsResult) {
          emailAuditResults.push({
            Parque: sOrig,
            Aerogerador: tOrig,
            'Data no E-mail': emailDate,
            'Status no E-mail': `${emailCount} pá(s) (${emailBlades.join(', ')})`,
            'Status no Smartsheet': 'Não encontrado no Smartsheet',
            'Tipo de Divergência': 'Aerogerador não cadastrado no Smartsheet',
            'Ação Recomendada': 'Adicionar a máquina no Smartsheet',
          })

          let templateRow: any = null
          for (const row of df) {
            const rSiteNorm = normalizeText(row[wfCol])
            if (
              rSiteNorm &&
              (rSiteNorm.includes(eSNorm) || eSNorm.includes(rSiteNorm))
            ) {
              templateRow = { ...row }
              break
            }
          }
          if (!templateRow) {
            templateRow = {}
            Object.keys(df[0] || {}).forEach(k => {
              templateRow[k] = ''
            })
            templateRow[wfCol] = String(sOrig)
          }

          templateRow[turbCol] = tOrig
          const woColName = isInternal ? 'WO' : 'WF Id'
          templateRow[woColName] = emailInfo.wo

          let clientColInSs = ''
          for (const c of Object.keys(templateRow)) {
            if (c.toLowerCase().includes('client')) {
              clientColInSs = c
              break
            }
          }
          let clientValRaw = emailInfo.client || ''
          if (!clientValRaw && clientColInSs && templateRow[clientColInSs]) {
            clientValRaw = String(templateRow[clientColInSs])
          }
          if (clientColInSs) {
            templateRow[clientColInSs] = String(clientValRaw)
              .toUpperCase()
              .trim()
          }

          const colsToClear = [
            'Status.',
            'Status',
            'UPLOAD A',
            'UPLOAD B',
            'UPLOAD C',
            'Upload Date',
            'Ultimo Acesso',
            'Inspection Date',
          ]
          colsToClear.forEach(col => {
            if (col in templateRow) templateRow[col] = ''
          })
          missingSsRows.push(templateRow)
        } else {
          const matchedSsInfo = matchedSsResult.matchedVal
          const ssBlades = matchedSsInfo.blades
          const ssCount = ssBlades.length

          const emailWoOrig = emailInfo.wo
          const ssWoOrig = String(matchedSsInfo.wo || '')
          const woNormEmail = normalizeWo(emailWoOrig)
          const woNormSs = normalizeWo(ssWoOrig)

          if (emailWoOrig && ssWoOrig && woNormEmail !== woNormSs) {
            emailAuditResults.push({
              Parque: matchedSsInfo.site_orig,
              Aerogerador: matchedSsInfo.turb_orig,
              'Data no E-mail': emailDate,
              'Status no E-mail': `${emailCount} pá(s) (${emailBlades.join(', ')})`,
              'Status no Smartsheet': `OS diferente no SS: ${ssWoOrig}`,
              'Tipo de Divergência': `Nova OS detectada (e-mail: ${emailWoOrig} / SS: ${ssWoOrig})`,
              'Ação Recomendada':
                'Adicionar nova linha no Smartsheet para esta OS e turbina',
            })

            const templateRow = { ...matchedSsInfo.row }
            const woColName = isInternal ? 'WO' : 'WF Id'
            templateRow[woColName] = emailWoOrig
            const colsToClear = [
              'Status.',
              'Status',
              'UPLOAD A',
              'UPLOAD B',
              'UPLOAD C',
              'Upload Date',
              'Ultimo Acesso',
              'Inspection Date',
            ]
            colsToClear.forEach(col => {
              if (col in templateRow) templateRow[col] = ''
            })
            missingSsRows.push(templateRow)
          } else if (isInternal) {
            if (emailCount !== ssCount) {
              emailAuditResults.push({
                Parque: matchedSsInfo.site_orig,
                Aerogerador: matchedSsInfo.turb_orig,
                'Data no E-mail': emailDate,
                'Status no E-mail': `${emailCount} pá(s) (${emailBlades.join(', ')})`,
                'Status no Smartsheet': `${ssCount} pá(s) (${ssBlades.join(', ')})`,
                'Tipo de Divergência': 'Quantidade de uploads divergente',
                'Ação Recomendada':
                  'Atualizar a planilha do Smartsheet ou verificar se o upload no Arthnex falhou',
              })
            } else {
              const emailBladesSet = new Set(
                emailBlades.filter(b => ['A', 'B', 'C'].includes(b))
              )
              const ssBladesSet = new Set(
                ssBlades.filter(b => ['A', 'B', 'C'].includes(b))
              )
              let setsMatch = emailBladesSet.size === ssBladesSet.size
              if (setsMatch) {
                for (const b of emailBladesSet) {
                  if (!ssBladesSet.has(b)) {
                    setsMatch = false
                    break
                  }
                }
              }
              if (!setsMatch) {
                emailAuditResults.push({
                  Parque: matchedSsInfo.site_orig,
                  Aerogerador: matchedSsInfo.turb_orig,
                  'Data no E-mail': emailDate,
                  'Status no E-mail': `${emailCount} pá(s) (${emailBlades.join(', ')})`,
                  'Status no Smartsheet': `${ssCount} pá(s) (${ssBlades.join(', ')})`,
                  'Tipo de Divergência': 'Pás divergentes',
                  'Ação Recomendada':
                    'Corrigir as colunas de UPLOAD no Smartsheet',
                })
              }
            }
          } else {
            const uniqueEmailBlades = Array.from(new Set(emailBlades))
            if (uniqueEmailBlades.length > 0 && uniqueEmailBlades.length < 3) {
              emailAuditResults.push({
                Parque: matchedSsInfo.site_orig,
                Aerogerador: matchedSsInfo.turb_orig,
                'Data no E-mail': emailDate,
                'Status no E-mail': `${uniqueEmailBlades.length} pá(s) (${uniqueEmailBlades.join(', ')})`,
                'Status no Smartsheet': 'N/A (Externa)',
                'Tipo de Divergência': 'Coleta Parcial',
                'Ação Recomendada':
                  'Verificar se as demais pás foram ou serão subidas',
              })
            }
          }
        }
      }

      for (const ssVal of Object.values(ssByTurb)) {
        if (ssVal.blades.length > 0) {
          const [ssSNorm, ssTNorm] = ssVal._key
          const matchedEmailResult = _stagedMatch(
            ssVal.date || '',
            ssVal.wo || '',
            ssSNorm,
            ssTNorm,
            ssVal.site_orig,
            emailByTurb
          )
          const inEmail = matchedEmailResult !== null
          if (!inEmail) {
            const row = ssVal.row
            const uploadDates: string[] = []
            const colsToCheck = [
              'UPLOAD A',
              'UPLOAD B',
              'UPLOAD C',
              'Upload Date',
            ]
            colsToCheck.forEach(col => {
              const val = row[col]
              if (
                val !== null &&
                val !== undefined &&
                String(val).trim() !== '' &&
                String(val).trim() !== 'NaT'
              ) {
                const parsed = parseDate(val)
                if (parsed) {
                  uploadDates.push(parsed.toISOString().split('T')[0])
                }
              }
            })
            const todayStr = new Date().toISOString().split('T')[0]
            if (uploadDates.some(d => d === todayStr)) {
              emailAuditResults.push({
                Parque: ssVal.site_orig,
                Aerogerador: ssVal.turb_orig,
                'Status no E-mail': 'Não consta no e-mail do dia',
                'Status no Smartsheet': `Marcado como subido hoje (${ssVal.blades.join(', ')})`,
                'Tipo de Divergência':
                  'Upload no Smartsheet mas ausente no e-mail',
                'Ação Recomendada':
                  'Verificar se o e-mail diário omitiu essa máquina ou se o Smartsheet foi atualizado incorretamente',
              })
            }
          }
        }
      }
    }

    let operationalRecords: Record<string, any> = {}
    if (operationalFormPath && fs.existsSync(operationalFormPath)) {
      sendLog('Processando formulário operacional...', 'info')
      const opBuffer = fs.readFileSync(operationalFormPath)
      operationalRecords = await _parseOperationalForm(
        opBuffer,
        startDate,
        endDate
      )
    }

    const operationalDiscrepancies: any[] = []

    if (Object.keys(operationalRecords).length > 0) {
      for (const opVal of Object.values(operationalRecords)) {
        const [opSNorm, opTNorm] = opVal._key

        const matchedEmailResult = _stagedMatch(
          opVal.date || '',
          opVal.wo || '',
          opSNorm,
          opTNorm,
          opVal.site_orig,
          emailByTurb
        )

        if (!matchedEmailResult) {
          operationalDiscrepancies.push({
            Parque: opVal.site_orig,
            Aerogerador: opVal.turb_orig,
            WO: opVal.wo,
            'Data no Campo': opVal.date,
            Piloto: opVal.pilot,
            Auxiliar: opVal.helper,
            Drone: opVal.drone,
            Status: 'Ausente no E-mail',
            'Tipo de Divergência': 'Escapou do e-mail diário',
            'Ação Recomendada':
              'Verificar por que a turbina inspecionada não foi listada no e-mail',
          })
        }

        const matchedSsResult = _stagedMatch(
          opVal.date || '',
          opVal.wo || '',
          opSNorm,
          opTNorm,
          opVal.site_orig,
          ssByTurb
        )

        if (!matchedSsResult) {
          operationalDiscrepancies.push({
            Parque: opVal.site_orig,
            Aerogerador: opVal.turb_orig,
            WO: opVal.wo,
            'Data no Campo': opVal.date,
            Piloto: opVal.pilot,
            Auxiliar: opVal.helper,
            Drone: opVal.drone,
            Status: 'Ausente no Smartsheet',
            'Tipo de Divergência': 'Não cadastrado no Smartsheet',
            'Ação Recomendada': 'Cadastrar a máquina no Smartsheet',
          })
        }
      }

      for (const eInfo of Object.values(emailByTurb)) {
        const [eSNorm, eTNorm] = eInfo._key
        const matchedOpResult = _stagedMatch(
          eInfo.date || '',
          eInfo.wo || '',
          eSNorm,
          eTNorm,
          eInfo.site_orig,
          operationalRecords
        )

        if (!matchedOpResult) {
          operationalDiscrepancies.push({
            Parque: eInfo.site_orig,
            Aerogerador: eInfo.turb_orig,
            WO: eInfo.wo,
            'Data no Campo': 'N/A',
            Piloto: 'N/A',
            Auxiliar: 'N/A',
            Drone: 'N/A',
            Status: 'Ausente no Formulário',
            'Tipo de Divergência': 'Ausente no relatório operacional de campo',
            'Ação Recomendada':
              'Verificar com a equipe se a turbina de fato foi voada ou se foi erro no e-mail',
          })
        }
      }

      for (const ssVal of Object.values(ssByTurb)) {
        if (ssVal.blades.length > 0) {
          const [ssSNorm, ssTNorm] = ssVal._key
          const matchedOpResult = _stagedMatch(
            ssVal.date || '',
            ssVal.wo || '',
            ssSNorm,
            ssTNorm,
            ssVal.site_orig,
            operationalRecords
          )

          if (!matchedOpResult) {
            const alreadyExists = operationalDiscrepancies.some(
              d =>
                d['Aerogerador'] === ssVal.turb_orig &&
                d['Status'] === 'Ausente no Formulário' &&
                sitesMatch(d['Parque'], ssVal.site_orig)
            )
            if (!alreadyExists) {
              operationalDiscrepancies.push({
                Parque: ssVal.site_orig,
                Aerogerador: ssVal.turb_orig,
                WO: ssVal.wo,
                'Data no Campo': 'N/A',
                Piloto: 'N/A',
                Auxiliar: 'N/A',
                Drone: 'N/A',
                Status: 'Ausente no Formulário',
                'Tipo de Divergência':
                  'Ausente no relatório operacional de campo',
                'Ação Recomendada':
                  'Verificar com a equipe se a turbina de fato foi voada ou se foi erro no Smartsheet',
              })
            }
          }
        }
      }
    }

    let vendorUniqueSet: Set<string> = new Set()
    let vendorUniqueMap: Record<string, [string, string]> = {}
    let ssUniqueSet: Set<string> = new Set()
    let ssUniqueMap: Record<string, [string, string]> = {}
    let dfVendor: any[] = []

    if (vendorPath && fs.existsSync(vendorPath)) {
      try {
        triangulacaoData.has_vendor = true
        sendLog('Processando dados do Vendor...', 'info')
        let rawVendor: any[] = []
        if (vendorPath.toLowerCase().endsWith('.csv')) {
          const csvText = fs.readFileSync(vendorPath, 'utf-8')
          rawVendor = parseCsv(csvText)
        } else {
          const vBuffer = fs.readFileSync(vendorPath)
          rawVendor = await readExcelAsJson(vBuffer)
        }

        dfVendor = rawVendor
          .map(row => {
            const newRow: any = {}
            Object.keys(row).forEach(k => {
              const k_lower = k.toLowerCase().replace(/[^a-z]/g, '')
              if (
                [
                  'site',
                  'parque',
                  'complexo',
                  'farm',
                  'windfarm',
                  'projeto',
                  'empreendimento',
                ].some(kw => k_lower.includes(kw))
              ) {
                if (
                  !newRow.Site ||
                  k_lower === 'site' ||
                  k_lower === 'windfarm'
                ) {
                  newRow.Site = String(row[k]).trim().toUpperCase()
                }
              } else if (
                [
                  'turbine',
                  'turbina',
                  'wtg',
                  'aerogerador',
                  'aerog',
                  'maquina',
                  'máquina',
                ].some(kw => k_lower.includes(kw))
              ) {
                if (!newRow.Turbine || k_lower === 'turbine') {
                  newRow.Turbine = String(row[k]).trim().toUpperCase()
                }
              } else if (
                [
                  'inspectiondate',
                  'surveydate',
                  'date',
                  'data',
                  'datacoleta',
                ].some(kw => k_lower.includes(kw))
              ) {
                const dt = parseDate(row[k])
                newRow.InspectionDate = dt
                  ? dt.toISOString().split('T')[0]
                  : String(row[k]).trim()
              }
            })
            return newRow
          })
          .filter(r => r.Site && r.Turbine)

        // Mapear os nomes de parques do Vendor (ex: "Oitis") para os nomes canônicos do Smartsheet (ex: "Oitis 1")
        const ssSites = Array.from(
          new Set(
            df.map(row => String(row[wfCol] || '').trim()).filter(Boolean)
          )
        )
        dfVendor.forEach(r => {
          const matchedSsSite = ssSites.find(ssSite =>
            sitesMatch(ssSite, r.Site, r.Turbine)
          )
          if (matchedSsSite) {
            r.Site = matchedSsSite.toUpperCase()
          }
        })

        dfVendor.forEach(r => {
          const sNorm = normalizeText(r.Site)
          const tNorm = standardizeTurbineId(r.Turbine, r.Site)
          const key = `${sNorm}_${tNorm}`
          vendorUniqueSet.add(key)
          vendorUniqueMap[key] = [r.Site, r.Turbine]
        })

        const dfUnique = df.map(row => ({
          wf: String(row[wfCol]).trim().toUpperCase(),
          turb: String(row[turbCol]).trim().toUpperCase(),
        }))

        dfUnique.forEach(r => {
          const sNorm = normalizeText(r.wf)
          const tNorm = standardizeTurbineId(r.turb, r.wf)
          const key = `${sNorm}_${tNorm}`
          ssUniqueSet.add(key)
          ssUniqueMap[key] = [r.wf, r.turb]
        })

        const matchSet = new Set(
          [...vendorUniqueSet].filter(x => ssUniqueSet.has(x))
        )
        const missingSsSet = new Set(
          [...vendorUniqueSet].filter(x => !ssUniqueSet.has(x))
        )
        const missingVendorSet = new Set(
          [...ssUniqueSet].filter(x => !vendorUniqueSet.has(x))
        )

        const getVendorDate = (site: string, turb: string): string => {
          const siteNorm = normalizeText(site)
          const turbNorm = standardizeTurbineId(turb, site)
          const matched = dfVendor.find(
            r =>
              normalizeText(r.Site) === siteNorm &&
              standardizeTurbineId(r.Turbine, r.Site) === turbNorm
          )
          return matched ? matched.InspectionDate || 'N/A' : 'N/A'
        }

        const getSmartsheetDate = (site: string, turb: string): string => {
          const siteNorm = normalizeText(site)
          const turbNorm = standardizeTurbineId(turb, site)
          const dateField = isInternal ? 'Ultimo Acesso' : 'Inspection Date'
          const matched = df.find(
            row =>
              normalizeText(row[wfCol]) === siteNorm &&
              standardizeTurbineId(row[turbCol], row[wfCol]) === turbNorm
          )
          if (matched && matched[dateField]) {
            const dt = parseDate(matched[dateField])
            return dt
              ? dt.toISOString().split('T')[0]
              : String(matched[dateField]).trim()
          }
          return 'N/A'
        }

        triangulacaoData.match = Array.from(matchSet).map(k => ({
          Wind_Farm: vendorUniqueMap[k][0],
          Turbine_Id: vendorUniqueMap[k][1],
        }))

        triangulacaoData.missing_in_smartsheet = Array.from(missingSsSet).map(
          k => ({
            Wind_Farm: vendorUniqueMap[k][0],
            Turbine_Id: vendorUniqueMap[k][1],
            Date: getVendorDate(vendorUniqueMap[k][0], vendorUniqueMap[k][1]),
          })
        )

        triangulacaoData.missing_in_vendor = Array.from(missingVendorSet).map(
          k => ({
            Wind_Farm: ssUniqueMap[k][0],
            Turbine_Id: ssUniqueMap[k][1],
            Date: getSmartsheetDate(ssUniqueMap[k][0], ssUniqueMap[k][1]),
          })
        )

        const divergenciasList: any[] = []
        if (isInternal) {
          matchSet.forEach(k => {
            const [siteNorm, turbNorm] = k.split('_')
            const vendorBladesCount = dfVendor.filter(
              r =>
                normalizeText(r.Site) === siteNorm &&
                standardizeTurbineId(r.Turbine, r.Site) === turbNorm
            ).length
            let ssBlades: string[] = []
            let ssWo = ''
            for (const ssVal of Object.values(ssByTurb)) {
              const [sN, tN] = ssVal._key
              if (sN === siteNorm && tN === turbNorm) {
                ssBlades = ssVal.blades
                ssWo = ssVal.wo
                break
              }
            }
            if (vendorBladesCount !== ssBlades.length) {
              divergenciasList.push({
                WO: ssWo,
                'Wind Farm': ssUniqueMap[k][0],
                'Turbine Id': ssUniqueMap[k][1],
                Vendor_Blades_Count: vendorBladesCount,
                Smartsheet_Blades_Detail: ssBlades.join(', ') || 'Nenhuma',
                Vendor_Blades: vendorBladesCount,
                Diferenca: vendorBladesCount - ssBlades.length,
                Status: 'Divergente',
              })
            }
          })
          triangulacaoData.divergencias_coleta = divergenciasList
        }

        const yellowIssues: any[] = []
        const amareloRows = df.filter(row =>
          String(row[statusColName] || '')
            .toLowerCase()
            .includes('amarelo')
        )
        if (isInternal) {
          const pendOpsCol =
            'Pendencia Operaçoes' in df[0]
              ? 'Pendencia Operaçoes'
              : 'Pendencia Operações' in df[0]
                ? 'Pendencia Operações'
                : 'Pendencia Operacoes'
          const pendVisCol = 'Pendencia Visibilidade'
          const isTrueVal = (val: any): boolean => {
            if (val === null || val === undefined) return false
            const s = String(val).trim().toLowerCase()
            return ['true', '1', '1.0', 'sim', 'verdadeiro'].includes(s)
          }
          amareloRows.forEach(row => {
            const opsVal = row[pendOpsCol]
            const visVal = row[pendVisCol]
            const hasOps = isTrueVal(opsVal)
            const hasVis = isTrueVal(visVal)
            if (hasOps || hasVis) {
              let issueType = 'Operações'
              if (hasOps && hasVis) issueType = 'Operações e Visibilidade'
              else if (hasVis) issueType = 'Visibilidade'
              yellowIssues.push({
                Wind_Farm: row[wfCol],
                Turbine_Id: row[turbCol],
                Issue: issueType,
                Observacoes: row[obsCol] || 'Sem comentários',
              })
            }
          })
        } else {
          amareloRows.forEach(row => {
            yellowIssues.push({
              Wind_Farm: row[wfCol],
              Turbine_Id: row[turbCol],
              Issue: 'Pendente Cliente',
              Observacoes: row[obsCol] || 'Sem comentários',
            })
          })
        }
        triangulacaoData.yellow_issues = yellowIssues

        const recoletasTracking: any[] = []
        if (isInternal) {
          const recoletasRows = df.filter(r => r['Is_Recoleta'])
          const uniqueTurbinesWithRecoleta = Array.from(
            new Set(
              recoletasRows.map(
                r =>
                  `${normalizeText(r[wfCol])}::${standardizeTurbineId(r[turbCol], r[wfCol])}`
              )
            )
          )
          uniqueTurbinesWithRecoleta.forEach(tKey => {
            const [sNorm, tNorm] = tKey.split('::')
            const turbineRecords = df.filter(
              r =>
                normalizeText(r[wfCol]) === sNorm &&
                standardizeTurbineId(r[turbCol], r[wfCol]) === tNorm
            )
            const firstRecord = turbineRecords[0]
            const wf = firstRecord ? firstRecord[wfCol] : 'N/A'
            const turb = firstRecord ? firstRecord[turbCol] : 'N/A'
            let statusRecoleta = ''
            if (turbineRecords.length === 1) {
              statusRecoleta = 'Pendente (Não iniciada no Smartsheet)'
            } else {
              const newLines = turbineRecords.filter(r => !r['Is_Recoleta'])
              if (newLines.length === 0) {
                statusRecoleta = 'Pendente (Aguardando nova inspeção)'
              } else {
                const latestLine = newLines[newLines.length - 1]
                const latestStatusStr = String(
                  latestLine['Status.'] || ''
                ).toLowerCase()
                if (
                  latestStatusStr.includes('verde') ||
                  latestStatusStr.includes('cinza')
                ) {
                  statusRecoleta = 'Concluída com Sucesso'
                } else if (latestStatusStr.includes('vermelho')) {
                  if (vendorUniqueSet.has(`${sNorm}_${tNorm}`)) {
                    statusRecoleta =
                      'Verificar Plataforma/Drive (Arthnex OK, mas SS Vermelho)'
                  } else {
                    statusRecoleta = 'Pendente SR'
                  }
                } else {
                  statusRecoleta = `Pendente (${latestLine['Status.']})`
                }
              }
            }
            recoletasTracking.push({
              Wind_Farm: wf,
              Turbine_Id: turb,
              Status_Recoleta: statusRecoleta,
            })
          })
        } else {
          const hasStarRows = df.filter(r =>
            String(r['Status'] || '').includes('*')
          )
          const uniqueTurbinesWithRecoleta = Array.from(
            new Set(
              hasStarRows.map(
                r =>
                  `${normalizeText(r[wfCol])}::${standardizeTurbineId(r[turbCol], r[wfCol])}`
              )
            )
          )
          uniqueTurbinesWithRecoleta.forEach(tKey => {
            const [sNorm, tNorm] = tKey.split('::')
            const turbineRecords = df.filter(
              r =>
                normalizeText(r[wfCol]) === sNorm &&
                standardizeTurbineId(r[turbCol], r[wfCol]) === tNorm
            )
            const firstRecord = turbineRecords[0]
            const wf = firstRecord ? firstRecord[wfCol] : 'N/A'
            const turb = firstRecord ? firstRecord[turbCol] : 'N/A'
            let statusRecoleta = ''
            if (turbineRecords.length === 1) {
              statusRecoleta = 'Pendente (Não iniciada no Smartsheet)'
            } else {
              const newLines = turbineRecords.filter(
                r => !String(r['Status'] || '').includes('*')
              )
              if (newLines.length === 0) {
                statusRecoleta = 'Pendente (Aguardando nova inspeção)'
              } else {
                const latestLine = newLines[newLines.length - 1]
                const latestStatusStr = String(
                  latestLine['Status'] || ''
                ).toLowerCase()
                if (
                  latestStatusStr.includes('verde') ||
                  latestStatusStr.includes('cinza')
                ) {
                  statusRecoleta = 'Concluída com Sucesso'
                } else if (latestStatusStr.includes('vermelho')) {
                  if (vendorUniqueSet.has(`${sNorm}_${tNorm}`)) {
                    statusRecoleta =
                      'Verificar Plataforma/Drive (Arthnex OK, mas SS Vermelho)'
                  } else {
                    statusRecoleta = 'Pendente SR'
                  }
                } else {
                  statusRecoleta = `Pendente (${latestLine['Status']})`
                }
              }
            }
            recoletasTracking.push({
              Wind_Farm: wf,
              Turbine_Id: turb,
              Status_Recoleta: statusRecoleta,
            })
          })
        }
        triangulacaoData.recoletas = recoletasTracking
      } catch (e) {
        console.error('Vendor triangulation error:', e)
      }
    }

    const resumoList: any[] = []
    if (!vendorPath) {
      const campStats: Record<
        string,
        {
          verde: number
          cinza: number
          amarelo: number
          vermelho: number
          total: number
        }
      > = {}
      const campSiteMap: Record<string, string> = {}

      df.forEach(row => {
        const camp = String(row[campaignCol] || '').trim()
        const st = String(row[statusColName] || '').trim()
        campSiteMap[camp] = String(row[wfCol] || '')

        if (!campStats[camp]) {
          campStats[camp] = {
            verde: 0,
            cinza: 0,
            amarelo: 0,
            vermelho: 0,
            total: 0,
          }
        }
        const stLower = st.toLowerCase()
        if (stLower.includes('verde')) campStats[camp].verde++
        else if (stLower.includes('cinza')) campStats[camp].cinza++
        else if (stLower.includes('amarelo')) campStats[camp].amarelo++
        else if (stLower.includes('vermelho')) campStats[camp].vermelho++
        campStats[camp].total++
      })

      for (const [camp, stats] of Object.entries(campStats)) {
        resumoList.push({
          WF_Id: camp,
          Wind_Farm: campSiteMap[camp] || 'Desconhecido',
          Total_Linhas: stats.total,
          Linhas_Originais: stats.total,
          Linhas_Recoleta: 0,
          Recoletas_Pendentes: 0,
          Recoletas_Concluidas: 0,
          Perc_Recoleta: 0.0,
        })
      }
    }

    const groundList: any[] = []
    if (groundRows.length > 0) {
      groundRows.forEach(row => {
        groundList.push({
          Wind_Farm: String(row[wfCol]),
          Turbine_Id: String(row[turbCol]),
          Status: String(row[statusColName]),
          Observacoes: String(row[obsCol] || 'Sem comentários'),
        })
      })
    }

    let operationalDiscrepanciesConsolidated: any[] = []
    if (operationalDiscrepancies.length > 0) {
      const opC: Record<string, any> = {}
      operationalDiscrepancies.forEach(d => {
        const key = `${d.Parque}::${d.Aerogerador}::${d.WO || ''}`
        if (!opC[key]) {
          opC[key] = {
            ...d,
            _tipos: [d['Tipo de Divergência']],
            _acoes: [d['Ação Recomendada']],
            _status: [d['Status']],
          }
        } else {
          const existing = opC[key]
          if (!existing._tipos.includes(d['Tipo de Divergência']))
            existing._tipos.push(d['Tipo de Divergência'])
          if (!existing._acoes.includes(d['Ação Recomendada']))
            existing._acoes.push(d['Ação Recomendada'])
          if (!existing._status.includes(d['Status']))
            existing._status.push(d['Status'])

          const fields = [
            'Data no Campo',
            'Piloto',
            'Auxiliar',
            'Drone',
          ] as const
          fields.forEach(f => {
            if (
              (existing[f] === 'N/A' || existing[f] === '' || !existing[f]) &&
              d[f] !== 'N/A' &&
              d[f] !== '' &&
              d[f]
            ) {
              existing[f] = d[f]
            }
          })
        }
      })
      operationalDiscrepanciesConsolidated = Object.values(opC).map(e => {
        const r = { ...e }
        r['Tipo de Divergência'] = e._tipos.join(' | ')
        r['Ação Recomendada'] = e._acoes.join(' | ')
        r['Status'] = e._status.join(' | ')
        delete r._tipos
        delete r._acoes
        delete r._status
        return r
      })
    }

    let emailAuditResultsConsolidated: any[] = []
    if (emailAuditResults.length > 0) {
      const eaC: Record<string, any> = {}
      emailAuditResults.forEach(d => {
        const key = `${d.Parque || ''}::${d.Aerogerador || ''}`
        if (!eaC[key]) {
          eaC[key] = {
            ...d,
            _tipos: [d['Tipo de Divergência'] || ''],
            _acoes: [d['Ação Recomendada'] || ''],
            _status_em: [d['Status no E-mail'] || ''],
            _status_ss: [d['Status no Smartsheet'] || ''],
          }
        } else {
          const existing = eaC[key]
          const lists = [
            { listKey: '_tipos', keyName: 'Tipo de Divergência' },
            { listKey: '_acoes', keyName: 'Ação Recomendada' },
            { listKey: '_status_em', keyName: 'Status no E-mail' },
            { listKey: '_status_ss', keyName: 'Status no Smartsheet' },
          ]
          lists.forEach(l => {
            const val = d[l.keyName] || ''
            if (val && !existing[l.listKey].includes(val)) {
              existing[l.listKey].push(val)
            }
          })
          if (
            (existing['Data no E-mail'] === 'N/A' ||
              existing['Data no E-mail'] === '' ||
              !existing['Data no E-mail']) &&
            d['Data no E-mail'] !== 'N/A' &&
            d['Data no E-mail'] !== '' &&
            d['Data no E-mail']
          ) {
            existing['Data no E-mail'] = d['Data no E-mail']
          }
        }
      })
      emailAuditResultsConsolidated = Object.values(eaC).map(e => {
        const r = { ...e }
        r['Tipo de Divergência'] = e._tipos.join(' | ')
        r['Ação Recomendada'] = e._acoes.join(' | ')
        r['Status no E-mail'] = e._status_em.join(' | ')
        r['Status no Smartsheet'] = e._status_ss.join(' | ')
        delete r._tipos
        delete r._acoes
        delete r._status_em
        delete r._status_ss
        return r
      })
    }

    triangulacaoData.email_audit_results = emailAuditResultsConsolidated

    const outWorkbook = new ExcelJS.Workbook()

    if (resumoList.length > 0) {
      writeSheet(outWorkbook, 'Resumo Campanhas', resumoList)
    }
    if (escapesList.length > 0) {
      writeSheet(outWorkbook, 'Alertas de Escape', escapesList)
    }
    if (groundList.length > 0) {
      writeSheet(outWorkbook, 'Componentes Solo', groundList)
    }
    if (operationalDiscrepanciesConsolidated.length > 0) {
      writeSheet(
        outWorkbook,
        'Auditoria Operacional',
        operationalDiscrepanciesConsolidated
      )
    }

    if (triangulacaoData.has_vendor) {
      const tRows: any[] = []
      triangulacaoData.match.forEach((m: any) => {
        tRows.push({
          'Wind Farm': m.Wind_Farm,
          'Turbine Id': m.Turbine_Id,
          Status: 'Bate (100%)',
        })
      })
      triangulacaoData.missing_in_smartsheet.forEach((m: any) => {
        tRows.push({
          'Wind Farm': m.Wind_Farm,
          'Turbine Id': m.Turbine_Id,
          Status: 'Falta no Smartsheet',
        })
      })
      triangulacaoData.missing_in_vendor.forEach((m: any) => {
        tRows.push({
          'Wind Farm': m.Wind_Farm,
          'Turbine Id': m.Turbine_Id,
          Status: 'Falta no Arthnex',
        })
      })
      if (tRows.length > 0) {
        writeSheet(outWorkbook, 'Auditoria Triangulada', tRows)
      }

      if (
        isInternal &&
        triangulacaoData.divergencias_coleta &&
        triangulacaoData.divergencias_coleta.length > 0
      ) {
        writeSheet(
          outWorkbook,
          'Auditoria de Pás',
          triangulacaoData.divergencias_coleta
        )
      }

      if (
        triangulacaoData.yellow_issues &&
        triangulacaoData.yellow_issues.length > 0
      ) {
        writeSheet(
          outWorkbook,
          'Pendências de Coleta',
          triangulacaoData.yellow_issues
        )
      }

      if (triangulacaoData.recoletas && triangulacaoData.recoletas.length > 0) {
        writeSheet(
          outWorkbook,
          'Controle de Recoletas',
          triangulacaoData.recoletas
        )
      }
    }

    if (emailRecords.length > 0) {
      const epSummary = triangulacaoData.email_parsed_summary || []
      if (epSummary.length > 0) {
        writeSheet(outWorkbook, 'E-mail Extraído', epSummary)
      }
      if (emailAuditResultsConsolidated.length > 0) {
        writeSheet(
          outWorkbook,
          'Auditoria E-mail Arthnex',
          emailAuditResultsConsolidated
        )
      }
      if (missingSsRows.length > 0) {
        writeSheet(outWorkbook, 'Novas Linhas Smartsheet', missingSsRows)
      }
    }

    const colsToExport: string[] = []
    if (isInternal) {
      colsToExport.push(
        'WO',
        'Parque',
        'WTG',
        'Status.',
        'BLADE A',
        'UPLOAD A',
        'BLADE B',
        'UPLOAD B',
        'BLADE C',
        'UPLOAD C',
        'Ultimo Acesso'
      )
      if (obsCol) colsToExport.push(obsCol)
    } else {
      colsToExport.push(
        'WF Id',
        'Wind Farm',
        'Turbine Id',
        'Status',
        'Is_Recoleta',
        'Status_Recoleta'
      )
      const uploadCol = 'Upload Date'
      if (uploadCol) colsToExport.push(uploadCol)
      if (obsCol) colsToExport.push(obsCol)
    }

    const exportedData = df.map(row => {
      const r: any = {}
      colsToExport.forEach(col => {
        r[col] = row[col] !== undefined ? row[col] : ''
      })
      return r
    })

    if (exportedData.length > 0) {
      writeSheet(outWorkbook, 'Dados Analisados', exportedData)
    }

    const campaignsSet = new Set<string>()
    df.forEach(row => {
      const camp = String(row[campaignCol] || '').trim()
      if (camp) campaignsSet.add(camp)
    })
    const campaigns = Array.from(campaignsSet)

    const documentsDir = path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      'Documents'
    )
    const outRoot = path.join(
      documentsDir,
      'Arthwind Suite',
      'WORKFLOW_ANALYSIS'
    )
    if (!fs.existsSync(outRoot)) {
      fs.mkdirSync(outRoot, { recursive: true })
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/T/, '_')
      .replace(/\..+/, '')
      .replace(/:/g, '')
    const campName =
      campaigns
        .join('_')
        .replace(/[\/*?:"<>|]/g, '')
        .substring(0, 40) || 'Workflow'
    const outPath = path.join(
      outRoot,
      `Resumo_Workflow_${campName}_${timestamp}.xlsx`
    )

    await outWorkbook.xlsx.writeFile(outPath)

    sendLog(`Relatório gerado em: ${outPath}`, 'success')

    return {
      success: true,
      is_internal: isInternal,
      resumo: resumoList,
      escapes: escapesList,
      ground_blades: groundList,
      triangulacao: triangulacaoData,
      operational_discrepancies: operationalDiscrepanciesConsolidated,
      email_parsed_summary: triangulacaoData.email_parsed_summary || [],
      excel_bytes: null,
      total_campanhas: resumoList.length,
      total_escapes: escapesList.length,
      output_file: outPath,
    }
  } catch (err: any) {
    sendLog(`Erro na análise do workflow: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function gerarPlanilhaSrPendente(
  smartsheetPath: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Lendo planilha Smartsheet...', 'info')
    const ssBuffer = fs.readFileSync(smartsheetPath)
    const rawRows = await readExcelAsJson(
      ssBuffer,
      /003|INTERNOS|ATW_QLDE_003|034|EXTERNAS|ATW_QLDE_034/i
    )

    if (rawRows.length === 0) {
      return { success: false, error: 'Nenhum dado encontrado na planilha.' }
    }

    const { canonRows, isInternal } = _detectLayout(rawRows)

    const statusCol = isInternal ? 'Status.' : 'Status'
    const pendingRows = canonRows.filter(row => {
      const status = String(row[statusCol] || '')
        .trim()
        .toLowerCase()
      return status === 'vermelho'
    })

    if (pendingRows.length === 0) {
      return {
        success: false,
        error: 'Nenhum aerogerador com status Vermelho foi encontrado.',
      }
    }

    const dateCol = isInternal ? 'Ultimo Acesso' : 'Inspection Date'
    const exportRows = pendingRows.map(row => {
      const woVal = row[isInternal ? 'WO' : 'WF Id'] || ''
      const parqueVal = row[isInternal ? 'Parque' : 'Wind Farm'] || ''
      const clientVal = row['Cliente'] || row['Client'] || ''
      const turbinaVal = row[isInternal ? 'WTG' : 'Turbine Id'] || ''
      const pilotoVal = row['Piloto'] || ''
      const rawDate = row[dateCol] || ''

      let dateVal = ''
      const parsedDt = parseDate(rawDate)
      if (parsedDt) {
        dateVal = `${String(parsedDt.getDate()).padStart(2, '0')}/${String(parsedDt.getMonth() + 1).padStart(2, '0')}/${parsedDt.getFullYear()}`
      } else if (rawDate) {
        dateVal = String(rawDate)
      }

      return {
        WO: String(woVal).trim(),
        Parque: String(parqueVal).trim(),
        Cliente: String(clientVal).trim(),
        Turbina: String(turbinaVal).trim(),
        Piloto: String(pilotoVal).trim(),
        'Data da Coleta': dateVal,
      }
    })

    const workbook = new ExcelJS.Workbook()
    writeSheet(workbook, 'SR_Pendentes', exportRows)

    const documentsDir = path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      'Documents'
    )
    const outRoot = path.join(documentsDir, 'Arthwind Suite', 'SR_PENDENTES')
    if (!fs.existsSync(outRoot)) {
      fs.mkdirSync(outRoot, { recursive: true })
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/T/, '_')
      .replace(/\..+/, '')
      .replace(/:/g, '')
    const outPath = path.join(outRoot, `SR_Pendentes_${timestamp}.xlsx`)
    await workbook.xlsx.writeFile(outPath)

    sendLog(
      `Planilha de SRs Pendentes gerada com sucesso: ${outPath}`,
      'success'
    )

    return {
      success: true,
      output_file: outPath,
      count: exportRows.length,
    }
  } catch (err: any) {
    sendLog(`Erro ao gerar planilha de SRs Pendentes: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

// ─── Image S&R organizer ──────────────────────────────────────────────────────

export async function organizarImagens(
  csvPath: string,
  fotosDir: string,
  mode: string,
  dryRun: boolean,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Lendo CSV...', 'info')
    const csvContent = fs.readFileSync(csvPath, 'utf-8')
    let delimiter = ';'
    if (!csvContent.includes(';')) delimiter = ','

    const lines = csvContent.split(/\r?\n/).map(l => parseCsvLine(l, delimiter))
    const headers = lines[0].map(h => h.trim().replace(/^"|"$/g, ''))
    const rows = lines
      .slice(1)
      .filter(l => l.length >= headers.length)
      .map(l => {
        const obj: any = {}
        headers.forEach((h, idx) => {
          obj[h] = l[idx]?.trim().replace(/^"|"$/g, '')
        })
        return obj
      })

    const required = [
      'Blade SN',
      'Side',
      'Original Image',
      'Location',
      'Pixel MM',
    ]
    const missing = required.filter(r => !headers.includes(r))
    if (missing.length > 0) {
      return {
        success: false,
        error: `Colunas ausentes no CSV: ${missing.join(', ')}`,
      }
    }

    // Fix Pixel MM
    const rawPx = rows.map(r => r['Pixel MM'])
    const fixedPx = _fixPixelMm(rawPx)
    let corrections = 0
    rows.forEach((r, idx) => {
      if (String(r['Pixel MM']) !== String(fixedPx[idx])) {
        r['Pixel MM'] = fixedPx[idx]
        corrections++
      }
    })

    if (corrections > 0) {
      sendLog(
        `⚠ ${corrections} valor(es) de Pixel MM corrompidos corrigidos por interpolação.`,
        'warning'
      )
    }

    sendLog('Mapeando arquivos na pasta de fotos...', 'info')
    const imageCache = _buildImageCache(fotosDir)

    const outputDir = path.join(path.dirname(csvPath), 'OUTPUT')
    fs.mkdirSync(outputDir, { recursive: true })

    let copied = 0
    const missingFiles: string[] = []
    const dryRunSamples: string[] = []

    rows.forEach((row, idx) => {
      if (idx % 10 === 0 || idx === rows.length - 1) {
        if (webContents)
          webContents.send('arthprogress', {
            current: idx + 1,
            total: rows.length,
          })
      }

      const blade = String(row['Blade SN'])
        .replace(/[\/*?:"<>|]/g, '')
        .trim()
      const region = String(row['Side']).toUpperCase().trim()
      const original = String(row['Original Image']).trim()

      const norm = _normalizeFilename(original)
      const src = imageCache[norm]

      if (!src) {
        missingFiles.push(`Linha ${idx + 2}: ${original}`)
        return
      }

      const destSubdir = path.join(outputDir, blade, region)
      fs.mkdirSync(destSubdir, { recursive: true })

      let cleanName = path.basename(original)
      if (mode === 'P') {
        const order = idx + 1
        const zFmt = formatLocationForName(row['Location'])
        const mmFmt = formatMmPx(row['Pixel MM'])
        cleanName = `${blade}_${zFmt}_${order}_${mmFmt}.jpg`
      }

      const destPath = path.join(destSubdir, cleanName)
      if (dryRun) {
        if (dryRunSamples.length < 5) {
          dryRunSamples.push(
            `  ${path.basename(src)}  →  ${blade}/${region}/${cleanName}`
          )
        }
      } else {
        fs.copyFileSync(src, destPath)
      }
      copied++
    })

    if (dryRun) {
      sendLog(
        `[DRY-RUN] ${copied}/${rows.length} imagens seriam copiadas · ${missingFiles.length} não encontradas`,
        'warning'
      )
      dryRunSamples.forEach(s => sendLog(s, 'info'))
      if (copied > 5)
        sendLog(`  ... e mais ${copied - 5} operação(ões).`, 'info')
    } else if (missingFiles.length === 0) {
      sendLog(
        `${copied}/${rows.length} imagens organizadas com sucesso`,
        'success'
      )
      sendLog(`Output: ${outputDir}`, 'info')
    } else {
      sendLog(
        `${copied}/${rows.length} imagens organizadas · ${missingFiles.length} não encontradas`,
        'warning'
      )
      sendLog(`Output: ${outputDir}`, 'info')
      const reportName = _writeMissingFile(
        outputDir,
        missingFiles,
        'Organizar Imagens S&R'
      )
      sendLog(`Lista de ausentes salva em OUTPUT/${reportName}`, 'warning')
    }

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro na organização: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function processarJson(
  jsonPath: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Lendo arquivo JSON...', 'info')
    const data = cryptoService.loadJson(jsonPath, [], true)
    const windblades = data.windblades || []
    if (windblades.length === 0) {
      return { success: false, error: 'Nenhum windblade encontrado no JSON.' }
    }

    // SP region fix
    let jsonModified = false
    const validRegions = new Set(['LE', 'SS', 'TE', 'PS'])
    windblades.forEach((item: any) => {
      if (
        String(item.region || '')
          .trim()
          .toUpperCase() === 'SP'
      ) {
        const originalName = String(
          item.image_metadata?.original_file_name || ''
        ).toUpperCase()
        let foundRegion: string | null = null
        for (const r of validRegions) {
          if (
            originalName.includes(`_${r}_`) ||
            originalName.includes(`-${r}-`) ||
            originalName.includes(` ${r} `) ||
            originalName.startsWith(`${r}_`)
          ) {
            foundRegion = r
            break
          }
        }
        if (foundRegion) {
          item.region = foundRegion
          sendLog(
            `⚠ Corrigida região SP na foto ${originalName} para ${foundRegion}`,
            'warning'
          )
          jsonModified = true
        }
      }
    })

    // 2. Group by blade and apply interactive confirmation / fallback to LE
    const bladeGroups: Record<string, any[]> = {}
    windblades.forEach((item: any) => {
      const bKey = `${item.blade_position || ''}_${item.blade_sn || ''}`
      if (!bladeGroups[bKey]) bladeGroups[bKey] = []
      bladeGroups[bKey].push(item)
    })

    for (const [, items] of Object.entries(bladeGroups)) {
      const spItems = items.filter(
        (item: any) =>
          String(item.region || '')
            .trim()
            .toUpperCase() === 'SP'
      )
      if (spItems.length === 0) continue

      const firstItem = items[0]
      const bPos = firstItem.blade_position || ''
      const bSn = firstItem.blade_sn || ''
      let chosenRegion = 'LE'

      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Não', 'Sim'],
        defaultId: 1,
        cancelId: 0,
        title: `Correção de Região 'SP' - Pá ${bSn}`,
        message: `Detectamos ${spItems.length} foto(s) com região 'SP' (não especificada) na Pá ${bSn} (Posição ${bPos}).\n\nA primeira fase do voo deve ser LE (Leading Edge).\n\nDeseja renomear automaticamente estas fotos para 'LE' (Leading Edge)?`,
      })

      if (response === 1) {
        chosenRegion = 'LE'
      } else {
        const { response: resSS } = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Não', 'Sim'],
          defaultId: 0,
          cancelId: 0,
          title: `Correção de Região 'SP' - Pá ${bSn}`,
          message: `Deseja classificar as ${spItems.length} foto(s) da Pá ${bSn} como 'SS' (Suction Side)?`,
        })
        if (resSS === 1) {
          chosenRegion = 'SS'
        } else {
          const { response: resTE } = await dialog.showMessageBox({
            type: 'question',
            buttons: ['Não', 'Sim'],
            defaultId: 0,
            cancelId: 0,
            title: `Correção de Região 'SP' - Pá ${bSn}`,
            message: `Deseja classificar as ${spItems.length} foto(s) da Pá ${bSn} como 'TE' (Trailing Edge)?`,
          })
          if (resTE === 1) {
            chosenRegion = 'TE'
          } else {
            const { response: resPS } = await dialog.showMessageBox({
              type: 'question',
              buttons: ['Não', 'Sim'],
              defaultId: 0,
              cancelId: 0,
              title: `Correção de Região 'SP' - Pá ${bSn}`,
              message: `Deseja classificar as ${spItems.length} foto(s) da Pá ${bSn} como 'PS' (Pressure Side)?`,
            })
            if (resPS === 1) {
              chosenRegion = 'PS'
            } else {
              sendLog(
                `⚠ Todas as opções de região foram recusadas pelo usuário para a Pá ${bSn}. Definido para a região padrão 'LE'.`,
                'warning'
              )
              chosenRegion = 'LE'
            }
          }
        }
      }

      spItems.forEach((item: any) => {
        item.region = chosenRegion
        const originalName = item.image_metadata?.original_file_name || ''
        sendLog(
          `✔ Região da foto '${originalName}' (Pá ${bSn}, ${bPos}) corrigida automaticamente para '${chosenRegion}'.`,
          'success'
        )
      })
      jsonModified = true
    }

    if (jsonModified) {
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8')
      sendLog(
        '✔ Arquivo JSON atualizado com as correções de região.',
        'success'
      )
    }

    const rootFolder = path.dirname(jsonPath)
    sendLog('Mapeando fotos nas pastas locais A/B/C...', 'info')

    // Mapa nome normalizado → dados do windblade (para enriquecer o relatório de fotos corrompidas)
    const windbladeByFile: Record<
      string,
      { bladeSn: string; bladePosition: string; region: string }
    > = {}
    windblades.forEach((item: any) => {
      const original = item.image_metadata?.original_file_name
      if (original) {
        windbladeByFile[_normalizeFilename(original)] = {
          bladeSn: item.blade_sn || '',
          bladePosition: item.blade_position || '',
          region: item.region || '',
        }
      }
    })

    const zeroBytePhotos: {
      name: string
      folder: string
      bladeSn: string
      bladePosition: string
      region: string
    }[] = []
    const imageCache: Record<string, string> = {}

    for (const sub of ['A', 'B', 'C']) {
      const p = path.join(rootFolder, sub)
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        const walk = (dir: string) => {
          const list = fs.readdirSync(dir, { withFileTypes: true })
          for (const f of list) {
            const fullPath = path.join(dir, f.name)
            if (f.isDirectory()) {
              if (!f.name.startsWith('.')) walk(fullPath)
            } else {
              const ext = path.extname(f.name).toUpperCase()
              if (SUPPORTED_EXTS.has(ext)) {
                try {
                  const stat = fs.statSync(fullPath)
                  if (stat.size === 0) {
                    const normKey = _normalizeFilename(f.name)
                    const info = windbladeByFile[normKey] || {
                      bladeSn: '',
                      bladePosition: '',
                      region: '',
                    }
                    zeroBytePhotos.push({ name: f.name, folder: sub, ...info })
                    sendLog(
                      `❌ Foto corrompida (0 bytes): '${f.name}' na pasta ${sub}.`,
                      'error'
                    )
                  }
                } catch (e) {}
                const normKey = _normalizeFilename(f.name)
                const lowKey = f.name.toLowerCase()
                imageCache[normKey] = fullPath
                imageCache[lowKey] = fullPath
              }
            }
          }
        }
        walk(p)
      }
    }

    const uniquePhotosCount = new Set(Object.values(imageCache)).size
    sendLog(`📁 ${uniquePhotosCount} fotos encontradas.`, 'info')
    if (zeroBytePhotos.length > 0) {
      sendLog(
        `⚠ Detectadas ${zeroBytePhotos.length} fotos corrompidas (com tamanho 0 bytes). Seus caminhos foram gerados normalmente no CSV para permitir que você as substitua na pasta física pelo seu backup antes do upload.`,
        'error'
      )

      const reportPath = path.join(
        rootFolder,
        `fotos_corrompidas_0_bytes_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
      )
      const reportLines = [
        'Arthwind Suite — fotos corrompidas (0 bytes)',
        `Data: ${new Date().toISOString()}`,
        `Total: ${zeroBytePhotos.length} foto(s)`,
        '--------------------------------------------------',
        ...zeroBytePhotos.map(
          zb =>
            `ID/Nome: ${zb.name} | Pasta: ${zb.folder} | Blade SN: ${zb.bladeSn || '?'} | Posição: ${zb.bladePosition || '?'} | Região: ${zb.region || '?'}`
        ),
      ]
      fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf-8')
      sendLog(
        `Lista de fotos corrompidas salva em ${path.basename(reportPath)} (na pasta do JSON).`,
        'warning'
      )

      await dialog.showMessageBox({
        type: 'warning',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Fotos Corrompidas Detectadas (0 bytes)',
        message: `Detectamos ${zeroBytePhotos.length} foto(s) com 0 bytes (corrompidas) nas pastas A/B/C.`,
        detail: `Os caminhos delas foram incluídos normalmente no CSV final, mas você deve substituí-las pelo backup físico antes do upload.\n\nUma lista completa foi salva em:\n${reportPath}`,
      })
    }

    const missingPhotos: string[] = []
    windblades.forEach((item: any) => {
      const original = item.image_metadata?.original_file_name
      if (original && !imageCache[original.toLowerCase()]) {
        missingPhotos.push(original)
      }
    })

    let excludeMissing = false
    if (missingPhotos.length > 0) {
      sendLog(
        `⚠ ${missingPhotos.length} fotos do JSON não existem fisicamente nas pastas locais.`,
        'warning'
      )
      missingPhotos.slice(0, 10).forEach(fn => sendLog(`   - ${fn}`, 'warning'))
      if (missingPhotos.length > 10)
        sendLog(
          `   ... e mais ${missingPhotos.length - 10} foto(s).`,
          'warning'
        )

      // Réplica do confirm_fn síncrono do pywebview (create_confirmation_dialog) — no
      // Electron não existe esse atalho de chamar de volta a UI e esperar, mas o próprio
      // processo main já pode abrir um diálogo NATIVO do SO diretamente (dialog.showMessageBox),
      // sem precisar de round-trip pro renderer — mais simples que a ponte original, na real.
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Não', 'Sim'],
        defaultId: 0,
        cancelId: 0,
        title: 'Fotos Faltantes Detectadas',
        message: `Detectamos ${missingPhotos.length} foto(s) no JSON que não existem fisicamente nas pastas A/B/C.`,
        detail:
          'Deseja EXCLUIR as linhas dessas fotos do CSV final para evitar erros de upload? (Se escolher Não, as linhas serão mantidas com o caminho em branco).',
      })
      excludeMissing = response === 1
      if (excludeMissing) {
        sendLog(
          `✔ Confirmado: as ${missingPhotos.length} fotos faltantes serão excluídas do CSV final.`,
          'success'
        )
      } else {
        sendLog(
          '⚠ As linhas das fotos faltantes serão mantidas no CSV com caminho em branco.',
          'warning'
        )
      }
    }

    // Generate output files
    const workorderId = data.workorder_id || ''
    const turbineName = data.turbine_name || ''
    const windFarm = data.wind_farm || ''
    const turbineId = data.turbine_id || ''
    const equipmentId = data.equipment_id || ''
    const surface = data.surface || ''

    const groups: Record<string, any[]> = {}
    windblades.forEach((item: any) => {
      const key = `${item.blade_position}_${item.blade_sn}`
      if (!groups[key]) groups[key] = []
      groups[key].push(item)
    })

    const matchedRows: any[] = []
    let idCounter = 1

    for (const [key, items] of Object.entries(groups)) {
      const bladePosition = items[0].blade_position
      const bladeSn = items[0].blade_sn

      const byRegion: Record<string, any[]> = {}
      items.forEach((item: any) => {
        const r = item.region || ''
        if (!byRegion[r]) byRegion[r] = []
        byRegion[r].push(item)
      })

      const rows: any[] = []
      for (const [region, regionItems] of Object.entries(byRegion)) {
        const isTipToRoot = region === 'SS' || region === 'PS'
        regionItems.sort((a, b) => {
          const tA = extractDjiTimestamp(
            a.image_metadata?.original_file_name || ''
          ).getTime()
          const tB = extractDjiTimestamp(
            b.image_metadata?.original_file_name || ''
          ).getTime()
          return tA - tB
        })
        if (isTipToRoot) {
          regionItems.reverse()
        }

        const rawPx = regionItems.map(
          item => item.image_metadata?.pixel_size || ''
        )
        const fixedPx = _fixPixelMm(rawPx)

        regionItems.forEach((item, idxR) => {
          const originalName = item.image_metadata?.original_file_name || ''
          const location = item.image_metadata?.location || 0
          const pixelSize = fixedPx[idxR]
          const matchedFile = imageCache[originalName.toLowerCase()] || ''
          const imageIdVal = matchedFile
            ? path.relative(rootFolder, matchedFile).replace(/\//g, '\\')
            : ''

          if (!matchedFile && excludeMissing) return // linha excluída por confirmação do usuário

          rows.push({
            id: idCounter,
            workorder: workorderId,
            turbine: turbineName,
            blade: bladeSn,
            region: region,
            image_id: imageIdVal,
            distance_to_hub: location,
            gimbal_pos: 0,
            temperature: 0,
            timestamp: 0,
            mm_px: pixelSize,
          })

          matchedRows.push({
            wind_farm: windFarm,
            turbine_name: turbineName,
            turbine_id: turbineId,
            workorder_id: workorderId,
            equipment_id: equipmentId,
            surface: surface,
            blade_position: bladePosition,
            blade_sn: bladeSn,
            region: region,
            sequence_direction: isTipToRoot ? 'TipToRoot' : 'RootToTip',
            location: location,
            json_date_image_utc: item.image_metadata?.date_image || '',
            json_original_file_name: originalName,
            json_image_file_path: item.image_metadata?.image_file_path || '',
            expected_sequence: idCounter,
            matched_file: matchedFile,
            matched_sequence: idCounter,
            sequence_match: 1,
            delta_seconds: 0,
            flag_far_match: 0,
          })
          idCounter++
        })
      }

      // Write CSV per blade
      const safeKey = key.replace(/[\/*?:"<>|]/g, '').trim()
      const outCsv = path.join(rootFolder, `photo_data_${safeKey}.csv`)
      const headers = [
        'id',
        'workorder',
        'turbine',
        'blade',
        'region',
        'image_id',
        'distance_to_hub',
        'gimbal_pos',
        'temperature',
        'timestamp',
        'mm_px',
      ]
      const csvLines = [headers.join(',')]
      rows.forEach(r => {
        csvLines.push(headers.map(h => r[h]).join(','))
      })
      fs.writeFileSync(outCsv, csvLines.join('\n'), 'utf-8')
      sendLog(`✔ Gerado: photo_data_${safeKey}.csv`, 'success')
    }

    // Write matched CSV
    const matchedHeaders = [
      'wind_farm',
      'turbine_name',
      'turbine_id',
      'workorder_id',
      'equipment_id',
      'surface',
      'blade_position',
      'blade_sn',
      'region',
      'sequence_direction',
      'location',
      'json_date_image_utc',
      'json_original_file_name',
      'json_image_file_path',
      'expected_sequence',
      'matched_file',
      'matched_sequence',
      'sequence_match',
      'delta_seconds',
      'flag_far_match',
    ]
    const matchedLines = [matchedHeaders.join(',')]
    matchedRows.forEach(r => {
      matchedLines.push(
        matchedHeaders
          .map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`)
          .join(',')
      )
    })
    fs.writeFileSync(
      path.join(rootFolder, 'photo_data_matched.csv'),
      matchedLines.join('\n'),
      'utf-8'
    )
    sendLog('✔ photo_data_matched.csv gerado', 'success')

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro ao processar JSON: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function organizarFotosJson(
  jsonPath: string,
  sourceFolder: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Lendo arquivo JSON...', 'info')
    const data = cryptoService.loadJson(jsonPath, [], true)
    const windblades = data.windblades || []
    if (windblades.length === 0) {
      return { success: false, error: 'Nenhum windblade encontrado no JSON.' }
    }

    sendLog('Mapeando fotos da pasta de origem...', 'info')
    // Cache dedicado deste módulo (chave por nome em minúsculas, sem normalização extra,
    // último arquivo encontrado vence em caso de colisão) — igual ao organizar_fotos_api
    // do Python, que é mais simples que o _build_image_cache usado nos outros módulos.
    const imageCache: Record<string, string> = {}
    for (const filePath of _listImagesFlat(sourceFolder)) {
      imageCache[path.basename(filePath).toLowerCase()] = filePath
    }
    const rootFolder = path.dirname(jsonPath)

    let copied = 0
    const missing: string[] = []

    // Assíncrono de propósito — antes usava fs.copyFileSync num forEach síncrono, o que
    // travava o processo principal do Electron INTEIRO (não só essa função) enquanto
    // copiava. Com poucos arquivos pequenos isso passava despercebido, mas com muitos
    // arquivos grandes (ex.: 146 vídeos) travava o app por tempo suficiente pra nem o
    // próprio timeout de segurança do renderer conseguir avisar direito (ele dispara, mas
    // a cópia continua rodando escondida, já que quem trava é o processo principal, não o
    // timer do lado da tela). Usar as versões async + await cede o controle do event loop
    // entre cada arquivo, mantendo o app responsivo durante toda a operação.
    for (let idx = 0; idx < windblades.length; idx++) {
      const item = windblades[idx]
      if (idx % 10 === 0 || idx === windblades.length - 1) {
        if (webContents)
          webContents.send('arthprogress', {
            current: idx + 1,
            total: windblades.length,
          })
      }

      const meta = item.image_metadata || {}
      const originalName = meta.original_file_name
      const targetPath = meta.image_file_path

      if (!originalName || !targetPath) continue

      const src = imageCache[String(originalName).toLowerCase()]
      if (!src) {
        missing.push(originalName)
        continue
      }

      // image_file_path é a pasta que contém a foto (não inclui o nome do arquivo) —
      // usamos os 3 últimos segmentos dessa pasta como estrutura de destino, igual ao Python.
      const parts = targetPath.split(/[\\/]/).filter(Boolean)
      const dirParts = parts.slice(-3)
      const destDir = path.join(rootFolder, ...dirParts)
      const destPath = path.join(destDir, originalName)

      await fs.promises.mkdir(destDir, { recursive: true })
      await fs.promises.copyFile(src, destPath)
      copied++
    }

    if (missing.length === 0) {
      sendLog(
        `${copied}/${windblades.length} fotos organizadas com sucesso`,
        'success'
      )
      sendLog(`Output: ${rootFolder}`, 'info')
    } else {
      sendLog(
        `${copied}/${windblades.length} fotos organizadas · ${missing.length} não encontradas`,
        'warning'
      )
      sendLog(`Output: ${rootFolder}`, 'info')
      const reportName = _writeMissingFile(
        rootFolder,
        missing,
        'Organizar Fotos via JSON'
      )
      sendLog(`Lista de ausentes salva em ${reportName}`, 'warning')
    }

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro ao organizar fotos pelo JSON: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function converterCsv(
  csvPath: string,
  gerarXlsx: boolean,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Lendo CSV...', 'info')
    const csvContent = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '')
    let delimiter = ';'
    let lines = csvContent.split(/\r?\n/).map(l => parseCsvLine(l, delimiter))
    if (lines[0].length === 1 && lines[0][0].includes(',')) {
      delimiter = ','
      lines = csvContent.split(/\r?\n/).map(l => parseCsvLine(l, delimiter))
      sendLog(
        "Delimitador ',' detectado no CSV. Lendo corretamente e convertendo...",
        'info'
      )
    }

    const headers = lines[0].map(h => h.trim().replace(/^"|"$/g, ''))
    const rows = lines
      .slice(1)
      .filter(l => l.length >= headers.length)
      .map(l => {
        const obj: any = {}
        headers.forEach((h, idx) => {
          obj[h] = l[idx]?.trim().replace(/^"|"$/g, '')
        })
        return obj
      })

    const outCsv = csvPath.replace(/\.csv$/i, '_convertido.csv')
    const outLines = [headers.map(h => `"${h}"`).join(',')]
    rows.forEach(r => {
      outLines.push(
        headers
          .map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`)
          .join(',')
      )
    })
    fs.writeFileSync(outCsv, '\uFEFF' + outLines.join('\n'), 'utf-8')
    sendLog(`✔ CSV convertido: ${path.basename(outCsv)}`, 'success')

    if (gerarXlsx) {
      const outXlsx = csvPath.replace(/\.csv$/i, '_convertido.xlsx')
      const workbook = new ExcelJS.Workbook()
      writeSheet(workbook, 'Dados Convertidos', rows)
      await workbook.xlsx.writeFile(outXlsx)
      sendLog(`✔ .xlsx gerado: ${path.basename(outXlsx)}`, 'success')
    }

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro ao converter CSV: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function extrairGpsZ(
  pasta: string,
  raizNome: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Lendo altitudes de GPS das fotos...', 'info')
    const filePaths = _listImagesFlat(pasta).sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b))
    )
    const altitudes: Record<string, number> = {}

    for (let i = 0; i < filePaths.length; i++) {
      if (i % 10 === 0 || i === filePaths.length - 1) {
        if (webContents)
          webContents.send('arthprogress', {
            current: i + 1,
            total: filePaths.length,
          })
      }
      const alt = await extractGpsAltitude(filePaths[i])
      if (alt !== null) {
        altitudes[path.basename(filePaths[i])] = alt
      }
    }

    if (altitudes[raizNome] === undefined) {
      return {
        success: false,
        error: `Foto raiz '${raizNome}' não encontrada ou sem GPS.`,
      }
    }

    const altitudeRaiz = altitudes[raizNome]
    sendLog(`Raiz (Z=0): ${raizNome} (${altitudeRaiz.toFixed(3)} m)`, 'info')

    const resultados = Object.entries(altitudes)
      .sort((a, b) => a[1] - b[1])
      .map(([nome, alt]) => {
        const zRel = (alt - altitudeRaiz) * 1000
        return {
          nome,
          altitude_gps_m: parseFloat(alt.toFixed(3)),
          z_relativo_mm: parseFloat(zRel.toFixed(1)),
        }
      })

    const outCsv = path.join(pasta, 'gps_z_relativo.csv')
    const headers = ['nome', 'altitude_gps_m', 'z_relativo_mm']
    const csvLines = [headers.join(',')]
    resultados.forEach(r => {
      csvLines.push(`${r.nome},${r.altitude_gps_m},${r.z_relativo_mm}`)
    })
    fs.writeFileSync(outCsv, csvLines.join('\n'), 'utf-8')
    sendLog(
      `gps_z_relativo.csv gerado (${resultados.length} linhas)`,
      'success'
    )

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro ao extrair GPS Z: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function corrigirZ0(
  csvPath: string,
  fotosDir: string,
  raizNome: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Carregando CSV...', 'info')
    const csvContent = fs.readFileSync(csvPath, 'utf-8')
    let delimiter = ';'
    if (!csvContent.includes(';')) delimiter = ','

    const lines = csvContent.split(/\r?\n/).map(l => parseCsvLine(l, delimiter))
    const headers = lines[0].map(h => h.trim().replace(/^"|"$/g, ''))
    const rows = lines
      .slice(1)
      .filter(l => l.length >= headers.length)
      .map(l => {
        const obj: any = {}
        headers.forEach((h, idx) => {
          obj[h] = l[idx]?.trim().replace(/^"|"$/g, '')
        })
        return obj
      })

    if (!headers.includes('Location') || !headers.includes('Original Image')) {
      return {
        success: false,
        error:
          "CSV inválido. Colunas 'Location' e 'Original Image' são necessárias.",
      }
    }

    sendLog('Carregando altitudes das fotos...', 'info')
    const imageCache = _buildImageCache(fotosDir)
    const rootNorm = _normalizeFilename(raizNome)
    const rootPath = imageCache[rootNorm]

    if (!rootPath) {
      return {
        success: false,
        error: `Foto raiz '${raizNome}' não encontrada na pasta.`,
      }
    }

    const baseAlt = await extractGpsAltitude(rootPath)
    if (baseAlt === null) {
      return {
        success: false,
        error: `Foto raiz '${raizNome}' não possui altitude no GPS.`,
      }
    }

    sendLog(
      `Altitude Base (Foto Raiz ${raizNome}): ${baseAlt.toFixed(3)} m`,
      'info'
    )
    let mudancas = 0

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const locVal = parseFloat(row['Location'])
      if (locVal === 0) {
        const name = String(row['Original Image']).trim()
        const norm = _normalizeFilename(name)
        const photoPath = imageCache[norm]
        if (photoPath) {
          const alt = await extractGpsAltitude(photoPath)
          if (alt !== null) {
            const newLoc = Math.round((alt - baseAlt) * 1000)
            row['Location'] = String(newLoc)
            mudancas++
          } else {
            sendLog(`⚠ Foto sem GPS ignorada: ${name}`, 'warning')
          }
        } else {
          sendLog(`⚠ Foto não encontrada ignorada: ${name}`, 'warning')
        }
      }
    }

    if (mudancas > 0) {
      const outCsv = csvPath.replace(/\.csv$/i, '_Z_corrigido.csv')
      const outLines = [headers.map(h => `"${h}"`).join(';')]
      rows.forEach(r => {
        outLines.push(
          headers
            .map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`)
            .join(';')
        )
      })
      fs.writeFileSync(outCsv, '\uFEFF' + outLines.join('\n'), 'utf-8')
      sendLog(
        `✔ Correção de Z aplicada! ${mudancas} itens zerados corrigidos.`,
        'success'
      )
      sendLog(`Salvo como: ${path.basename(outCsv)}`, 'success')
    } else {
      sendLog(
        'Nenhuma alteração foi realizada (Nenhum Location=0 precisou de reparo)',
        'info'
      )
    }

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro ao corrigir Z=0: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function recuperarFotosPerdidas(
  jsonPath: string,
  fotosDir: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Lendo arquivo JSON...', 'info')
    const data = cryptoService.loadJson(jsonPath, [], true)
    const windblades = data.windblades || []
    if (windblades.length === 0) {
      return { success: false, error: 'Nenhum windblade encontrado no JSON.' }
    }

    sendLog('Montando cache de fotos do SD Card...', 'info')
    const imageCache = _buildImageCache(fotosDir, sendLog)

    // Group by blade & region (chave interna arbitrária — a região real fica guardada no
    // próprio grupo, evitando reconstrução via split('_') que quebraria se blade_position
    // ou region contivessem underscore)
    const groups: Record<string, { region: string; items: any[] }> = {}
    windblades.forEach((wb: any) => {
      const key = `${wb.blade_position} ${wb.region}`
      if (!groups[key]) groups[key] = { region: wb.region, items: [] }
      groups[key].items.push(wb)
    })

    const outDir = path.join(path.dirname(jsonPath), 'Fotos_Recuperadas')
    const resultados: any[] = []

    for (const { region, items: photos } of Object.values(groups)) {
      const getSeq = (p: any): number => {
        const name = p.image_metadata?.original_file_name || ''
        const m = name.match(/_(\d{4})_V/)
        return m ? parseInt(m[1], 10) : 0
      }

      photos.sort((a, b) => getSeq(a) - getSeq(b))

      const nums: number[] = []
      const photoMap: Record<number, any> = {}
      photos.forEach(p => {
        const seq = getSeq(p)
        if (seq > 0) {
          nums.push(seq)
          photoMap[seq] = p
        }
      })

      if (nums.length === 0) continue

      const missing: number[] = []
      for (let n = nums[0]; n <= nums[nums.length - 1]; n++) {
        if (!nums.includes(n)) missing.push(n)
      }

      const gaps: [number, number][] = []
      if (missing.length > 0) {
        let gs = missing[0]
        let ge = missing[0]
        for (let i = 1; i < missing.length; i++) {
          const n = missing[i]
          if (n === ge + 1) {
            ge = n
          } else {
            gaps.push([gs, ge])
            gs = n
            ge = n
          }
        }
        gaps.push([gs, ge])
      }

      for (const [gapStart, gapEnd] of gaps) {
        let beforeSeq = gapStart - 1
        while (beforeSeq >= nums[0] && !photoMap[beforeSeq]) beforeSeq--
        const before = photoMap[beforeSeq]

        let afterSeq = gapEnd + 1
        while (afterSeq <= nums[nums.length - 1] && !photoMap[afterSeq])
          afterSeq++
        const after = photoMap[afterSeq]

        if (!before || !after) continue

        for (let m = gapStart; m <= gapEnd; m++) {
          const beforeName = before.image_metadata?.original_file_name || ''
          const afterName = after.image_metadata?.original_file_name || ''

          const tBefore = extractDjiTimestamp(beforeName)
          const tAfter = extractDjiTimestamp(afterName)
          if (tBefore.getTime() === 0 || tAfter.getTime() === 0) continue

          sendLog(
            `Buscando foto perdida ${m} (entre ${tBefore.toLocaleTimeString()} e ${tAfter.toLocaleTimeString()})`,
            'info'
          )

          let encontradaPath: string | null = null
          const targetStr = `_${String(m).padStart(4, '0')}_`
          for (const [normName, pPath] of Object.entries(imageCache)) {
            if (normName.includes(targetStr)) {
              const tCand = extractDjiTimestamp(path.basename(pPath))
              if (tCand.getTime() !== 0 && tCand > tBefore && tCand < tAfter) {
                encontradaPath = pPath
                break
              }
            }
          }

          if (encontradaPath) {
            fs.mkdirSync(outDir, { recursive: true })
            const altEncontrada = await extractGpsAltitude(encontradaPath)
            const beforeNorm = _normalizeFilename(beforeName)
            const beforeFile = imageCache[beforeNorm]
            const altBefore = beforeFile
              ? await extractGpsAltitude(beforeFile)
              : null

            let location = 0
            let locType = 'Média Interp.'

            if (altEncontrada !== null && altBefore !== null) {
              const locBefore = parseFloat(before.image_metadata?.location || 0)
              location = locBefore + (altEncontrada - altBefore) * 1000
              locType = 'GPS Precisão'
            }

            // Fallback pra média entre vizinhos sempre que o cálculo por GPS não rendeu
            // (falta de altitude em algum dos dois, ou o resultado deu exatamente 0) —
            // os dois blocos rodam em sequência, igual ao Python, não é um if/else.
            if (location === 0) {
              const loc1 = parseFloat(before.image_metadata?.location || 0)
              const loc2 = parseFloat(after.image_metadata?.location || 0)
              location = (loc1 + loc2) / 2
            }

            const px1 = parseFloat(before.image_metadata?.pixel_size || 0)
            const px2 = parseFloat(after.image_metadata?.pixel_size || 0)
            const pixelSize = (px1 + px2) / 2

            const turbineName = data.turbine_name || 'UNKNOWN'
            const bladeSn = before.blade_sn || 'UNKNOWN'

            const newFn = `${turbineName}_${bladeSn}_${region}_${location.toFixed(2)}_${pixelSize.toFixed(3)}_${path.basename(encontradaPath)}`
            const destPath = path.join(outDir, newFn)

            fs.copyFileSync(encontradaPath, destPath)
            sendLog(
              `✔ Recuperada: ${path.basename(encontradaPath)} -> ${newFn} (Z via ${locType})`,
              'success'
            )

            resultados.push({
              region,
              location: parseFloat(location.toFixed(2)),
              pixel_size: parseFloat(pixelSize.toFixed(3)),
              turbine_name: turbineName,
              blade_sn: bladeSn,
              image: path.basename(encontradaPath),
            })
          }
        }
      }
    }

    if (resultados.length > 0) {
      const csvPath = path.join(outDir, 'relatorio_fotos_recuperadas.csv')
      const headers = [
        'region',
        'location',
        'pixel_size',
        'turbine_name',
        'blade_sn',
        'image',
      ]
      const csvEscape = (v: any) => {
        const s = String(v ?? '')
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }
      const csvLines = [headers.join(';')]
      resultados.forEach(r => {
        csvLines.push(headers.map(h => csvEscape(r[h])).join(';'))
      })
      fs.writeFileSync(csvPath, '\uFEFF' + csvLines.join('\n'), 'utf-8')
      sendLog(
        `Operação concluída. ${resultados.length} fotos salvas na pasta: Fotos_Recuperadas`,
        'success'
      )
    } else {
      sendLog('Nenhuma foto faltando foi detectada ou recuperada.', 'warning')
    }

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro ao recuperar fotos: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function carregarFotosReconstruir(
  pasta: string,
  webContents?: any
): Promise<any[]> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    const filePaths = _listImagesFlat(pasta).sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b))
    )

    if (filePaths.length === 0) {
      sendLog('Nenhuma foto .JPG/.JPEG encontrada na pasta.', 'error')
      return []
    }

    const altitudes: Record<string, number> = {}
    for (const f of filePaths) {
      const alt = await extractGpsAltitude(f)
      if (alt !== null) altitudes[path.basename(f)] = alt
    }

    if (Object.keys(altitudes).length === 0) {
      sendLog('Nenhuma foto com dado GPS encontrada.', 'error')
      return []
    }

    const firstGpsName = filePaths
      .map(f => path.basename(f))
      .find(name => altitudes[name] !== undefined)
    if (!firstGpsName) return []
    const altitudeRaiz = altitudes[firstGpsName]

    const resultado = filePaths.map(f => {
      const name = path.basename(f)
      const z =
        altitudes[name] !== undefined
          ? parseFloat(((altitudes[name] - altitudeRaiz) * 1000).toFixed(1))
          : null
      return { nome: name, z_relativo_mm: z }
    })

    const semGps = resultado.filter(r => r.z_relativo_mm === null).length
    sendLog(`${resultado.length} fotos carregadas · ${semGps} sem GPS.`, 'info')
    return resultado
  } catch (err: any) {
    sendLog(`Erro ao carregar fotos para reconstruir: ${err.message}`, 'error')
    return []
  }
}

export async function reconstruirCsv(
  pasta: string,
  bladeSn: string,
  sides: any[],
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    const flatFiles = _listImagesFlat(pasta)
    const photoList = flatFiles
      .map(f => path.basename(f))
      .sort((a, b) => a.localeCompare(b))

    if (photoList.length === 0) {
      return { success: false, error: 'Nenhuma foto encontrada na pasta.' }
    }

    const altitudes: Record<string, number> = {}
    for (const f of flatFiles) {
      const alt = await extractGpsAltitude(f)
      if (alt !== null) altitudes[path.basename(f)] = alt
    }

    const firstGpsName = photoList.find(name => altitudes[name] !== undefined)
    const altitudeRaiz = firstGpsName ? altitudes[firstGpsName] : null

    const photoZ: Record<string, number> = {}
    photoList.forEach(nome => {
      if (altitudeRaiz !== null && altitudes[nome] !== undefined) {
        photoZ[nome] = parseFloat(
          ((altitudes[nome] - altitudeRaiz) * 1000).toFixed(1)
        )
      } else {
        photoZ[nome] = 0
      }
    })

    const rows: any[] = []
    const usedIndices = new Set<number>()

    for (const sideDef of sides) {
      const side = String(sideDef.side || '')
        .trim()
        .toUpperCase()
      const start = String(sideDef.start || '').trim()
      const end = String(sideDef.end || '').trim()
      const pixelMmAvg = parseFloat(sideDef.pixel_mm_avg || 0.45)

      if (!side || !start || !end) continue
      if (!photoList.includes(start) || !photoList.includes(end)) {
        sendLog(
          `⚠ Foto início/fim não encontrada para o lado ${side}`,
          'warning'
        )
        continue
      }

      let startIdx = photoList.indexOf(start)
      let endIdx = photoList.indexOf(end)
      if (startIdx > endIdx) {
        const tmp = startIdx
        startIdx = endIdx
        endIdx = tmp
      }

      const overlapCount = [...Array(endIdx - startIdx + 1).keys()]
        .map(i => startIdx + i)
        .filter(idx => usedIndices.has(idx)).length
      if (overlapCount > 0) {
        sendLog(
          `⚠ Lado ${side}: ${overlapCount} foto(s) já atribuídas a outro lado — sobreposição removida.`,
          'warning'
        )
      }

      const sidePhotos = photoList
        .slice(startIdx, endIdx + 1)
        .filter((_, idx) => !usedIndices.has(startIdx + idx))

      for (let idx = startIdx; idx <= endIdx; idx++) {
        usedIndices.add(idx)
      }

      const isTipToRoot = side === 'SS' || side === 'PS'
      if (isTipToRoot) {
        sidePhotos.reverse()
        sendLog(`  ↩ Lado ${side}: ordem invertida (tip→root)`, 'info')
      }

      sidePhotos.forEach(nome => {
        const pixelMm = parseFloat(
          (pixelMmAvg + (Math.random() * 0.03 - 0.015)).toFixed(5)
        )
        rows.push({
          'Blade SN': bladeSn,
          Side: side,
          'Original Image': nome,
          Location: roundHalfToEven(photoZ[nome] || 0),
          'Pixel MM': pixelMm,
        })
      })
      sendLog(`✔ Lado ${side}: ${sidePhotos.length} fotos`, 'success')
    }

    if (rows.length === 0) {
      return {
        success: false,
        error: 'Nenhuma linha gerada. Verifique as configurações de lado.',
      }
    }

    const safeSn = bladeSn.replace(/[\/*?:"<>|]/g, '').trim()
    const outCsv = path.join(pasta, `${safeSn}_reconstruido.csv`)
    const headers = [
      'Blade SN',
      'Side',
      'Original Image',
      'Location',
      'Pixel MM',
    ]
    const csvLines = [headers.join(';')]
    rows.forEach(r => {
      csvLines.push(
        `${r['Blade SN']};${r['Side']};${r['Original Image']};${r['Location']};${r['Pixel MM']}`
      )
    })
    fs.writeFileSync(outCsv, '\uFEFF' + csvLines.join('\n'), 'utf-8')
    sendLog(`✔ CSV reconstruído: ${path.basename(outCsv)}`, 'success')

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro na reconstrução: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function reconstruirCsvMulti(
  tabs: any[],
  workorder: string,
  turbine: string,
  genUploaderCsv: boolean,
  jsonRefPath: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    let refDataTop: any = {}
    const refByPosRgn: Record<string, Record<string, any[]>> = {}

    if (jsonRefPath && fs.existsSync(jsonRefPath)) {
      try {
        const refData = cryptoService.loadJson(jsonRefPath, [], true)
        refDataTop = { ...refData }
        delete refDataTop.windblades

        const windblades = refData.windblades || []
        windblades.forEach((entry: any) => {
          const pos =
            String(entry.blade_position || '')
              .trim()
              .toUpperCase() || 'ALL'
          const rgn = String(entry.region || '')
            .trim()
            .toUpperCase()
          if (!refByPosRgn[pos]) refByPosRgn[pos] = {}
          if (!refByPosRgn[pos][rgn]) refByPosRgn[pos][rgn] = []
          refByPosRgn[pos][rgn].push(entry)
        })
        sendLog(
          `✔ JSON de referência carregado: ${path.basename(jsonRefPath)}`,
          'info'
        )
      } catch (err: any) {
        sendLog(
          `⚠ Não foi possível carregar JSON de referência: ${err.message}`,
          'warning'
        )
      }
    }

    const outputDirs: string[] = []
    const processedPastas: string[] = []
    const allWindblades: any[] = []
    let idCounter = 1

    for (const tab of tabs) {
      const bladeLabel = tab.blade_label || '?'
      const pasta = tab.pasta || ''
      const bladeSn = String(tab.blade_sn || '').trim()
      const sidesConfig = tab.sides || []

      if (!fs.existsSync(pasta)) {
        sendLog(`⚠ Pá ${bladeLabel}: pasta não encontrada.`, 'warning')
        continue
      }

      sendLog(`── Pá ${bladeLabel} ── ${path.basename(pasta)}`, 'info')
      const flatFiles = _listImagesFlat(pasta)
      const photoList = flatFiles
        .map(f => path.basename(f))
        .sort((a, b) => a.localeCompare(b))

      if (photoList.length === 0) {
        sendLog(`⚠ Pá ${bladeLabel}: nenhuma foto encontrada.`, 'warning')
        continue
      }

      const altitudes: Record<string, number> = {}
      for (const f of flatFiles) {
        const alt = await extractGpsAltitude(f)
        if (alt !== null) altitudes[path.basename(f)] = alt
      }

      const firstGpsName = photoList.find(name => altitudes[name] !== undefined)
      const altitudeRaiz = firstGpsName ? altitudes[firstGpsName] : null
      const photoZ: Record<string, number> = {}
      photoList.forEach(nome => {
        if (altitudeRaiz !== null && altitudes[nome] !== undefined) {
          photoZ[nome] = parseFloat(
            ((altitudes[nome] - altitudeRaiz) * 1000).toFixed(1)
          )
        } else {
          photoZ[nome] = 0
        }
      })

      const rowsM1: any[] = []
      const rowsUp: any[] = []
      const usedIdx = new Set<number>()

      for (const sideDef of sidesConfig) {
        const side = String(sideDef.side || '')
          .trim()
          .toUpperCase()
        const start = String(sideDef.start || '').trim()
        const end = String(sideDef.end || '').trim()
        const pixelMmAvg = parseFloat(sideDef.pixel_mm_avg || 0.45)

        if (!side || !start || !end) continue
        if (!photoList.includes(start) || !photoList.includes(end)) {
          sendLog(
            `⚠ Pá ${bladeLabel} lado ${side}: foto início/fim não encontrada.`,
            'warning'
          )
          continue
        }

        let si = photoList.indexOf(start)
        let ei = photoList.indexOf(end)
        if (si > ei) {
          const tmp = si
          si = ei
          ei = tmp
        }

        const overlapCount = [...Array(ei - si + 1).keys()]
          .map(i => si + i)
          .filter(idx => usedIdx.has(idx)).length
        if (overlapCount > 0) {
          sendLog(
            `⚠ Pá ${bladeLabel} lado ${side}: ${overlapCount} foto(s) já atribuídas a outro lado — sobreposição removida.`,
            'warning'
          )
        }

        let sidePhotos = photoList
          .slice(si, ei + 1)
          .filter((_, idx) => !usedIdx.has(si + idx))

        for (let idx = si; idx <= ei; idx++) {
          usedIdx.add(idx)
        }

        const isTipToRoot = side === 'SS' || side === 'PS'
        if (isTipToRoot) {
          sidePhotos.reverse()
          sendLog(`  ↩ Lado ${side}: ordem invertida (tip→root)`, 'info')
        }

        sidePhotos.forEach(nome => {
          const pixelMm = parseFloat(
            (pixelMmAvg + (Math.random() * 0.03 - 0.015)).toFixed(5)
          )
          const z = roundHalfToEven(photoZ[nome] || 0)
          rowsM1.push({
            'Blade SN': bladeSn,
            Side: side,
            'Original Image': nome,
            Location: z,
            'Pixel MM': pixelMm,
          })

          if (genUploaderCsv) {
            rowsUp.push({
              id: idCounter,
              workorder: workorder,
              turbine: turbine,
              blade: bladeSn,
              region: side,
              image_id: nome,
              distance_to_hub: z,
              gimbal_pos: 0,
              temperature: 0,
              timestamp: 0,
              mm_px: pixelMm,
            })
            idCounter++
          }
        })
        sendLog(`  ✔ Lado ${side}: ${sidePhotos.length} fotos`, 'success')
      }

      if (rowsM1.length === 0) {
        sendLog(`⚠ Pá ${bladeLabel}: nenhuma linha gerada.`, 'warning')
        continue
      }

      const safeSn =
        bladeSn.replace(/[\/*?:"<>|]/g, '').trim() || `pa_${bladeLabel}`
      const outM1 = path.join(pasta, `${safeSn}_reconstruido.csv`)
      const headersM1 = [
        'Blade SN',
        'Side',
        'Original Image',
        'Location',
        'Pixel MM',
      ]
      const m1Lines = [headersM1.join(';')]
      rowsM1.forEach(r => {
        m1Lines.push(
          `${r['Blade SN']};${r['Side']};${r['Original Image']};${r['Location']};${r['Pixel MM']}`
        )
      })
      fs.writeFileSync(outM1, '\uFEFF' + m1Lines.join('\n'), 'utf-8')
      sendLog(
        `✔ Pá ${bladeLabel}: ${path.basename(outM1)} (${rowsM1.length} linhas)`,
        'success'
      )

      if (genUploaderCsv && rowsUp.length > 0) {
        const outUp = path.join(pasta, `photo_data_${bladeLabel}_${safeSn}.csv`)
        const headersUp = [
          'id',
          'workorder',
          'turbine',
          'blade',
          'region',
          'image_id',
          'distance_to_hub',
          'gimbal_pos',
          'temperature',
          'timestamp',
          'mm_px',
        ]
        const upLines = [headersUp.join(',')]
        rowsUp.forEach(r => {
          upLines.push(headersUp.map(h => r[h]).join(','))
        })
        fs.writeFileSync(outUp, upLines.join('\n'), 'utf-8')
        sendLog(
          `✔ Pá ${bladeLabel}: ${path.basename(outUp)} (Image Uploader)`,
          'success'
        )
      }

      // Merge windblades
      if (jsonRefPath) {
        let refByRgn = refByPosRgn[bladeLabel.toUpperCase()]
        if (!refByRgn) {
          const merged: Record<string, any[]> = {}
          Object.values(refByPosRgn).forEach(posDict => {
            Object.entries(posDict).forEach(([rgn, entries]) => {
              if (!merged[rgn]) merged[rgn] = []
              merged[rgn].push(...entries)
            })
          })
          refByRgn = merged
        }

        const rowsBySide: Record<string, any[]> = {}
        rowsM1.forEach(row => {
          if (!rowsBySide[row.Side]) rowsBySide[row.Side] = []
          rowsBySide[row.Side].push(row)
        })

        Object.entries(rowsBySide).forEach(([side, sideRows]) => {
          let refEntries = refByRgn[side] || []
          if (side === 'SS' || side === 'PS') {
            refEntries = [...refEntries].reverse()
          }
          sideRows.forEach((row, i) => {
            const refE = refEntries[i] || {}
            const nome = row['Original Image']
            allWindblades.push({
              ...refE,
              blade_position: bladeLabel,
              blade_sn: bladeSn,
              region: side,
              file_path: path.join(pasta, nome),
              image_metadata: {
                ...refE.image_metadata,
                original_file_name: nome,
                pixel_size: row['Pixel MM'],
                location: row['Location'],
              },
            })
          })
        })
      } else {
        rowsM1.forEach(row => {
          allWindblades.push({
            blade_position: bladeLabel,
            blade_sn: bladeSn,
            region: row.Side,
            file_path: path.join(pasta, row['Original Image']),
            image_metadata: {
              original_file_name: row['Original Image'],
              pixel_size: row['Pixel MM'],
              location: row['Location'],
            },
          })
        })
      }

      outputDirs.push(pasta)
      processedPastas.push(pasta)
    }

    if (outputDirs.length === 0) {
      return { success: false, error: 'Nenhuma pá processada com sucesso.' }
    }

    if (allWindblades.length > 0) {
      // Find common parent path
      let jsonOutDir = path.dirname(processedPastas[0])
      if (processedPastas.length > 1) {
        // Calculate common directory path
        const splitPaths = processedPastas.map(p => p.split(path.sep))
        const commonParts: string[] = []
        const minLen = Math.min(...splitPaths.map(p => p.length))
        for (let i = 0; i < minLen; i++) {
          const part = splitPaths[0][i]
          if (splitPaths.every(p => p[i] === part)) {
            commonParts.push(part)
          } else {
            break
          }
        }
        jsonOutDir = commonParts.join(path.sep)
      }

      const parts = [workorder, turbine].filter(p => !!p)
      const hasRef = Object.keys(refByPosRgn).length > 0
      const suffix = hasRef ? 'matched' : 'reconstruido'
      let fname =
        parts.length > 0
          ? `photo_data_${suffix}_${parts.join('_')}.json`
          : `photo_data_${suffix}.json`
      fname = fname.replace(/[\/*?:"<>|]/g, '')

      const jsonDoc: any = { ...refDataTop }
      if (workorder) jsonDoc.workorder = workorder
      if (turbine) jsonDoc.turbine = turbine
      jsonDoc.windblades = allWindblades

      const outJson = path.join(jsonOutDir, fname)
      fs.writeFileSync(outJson, JSON.stringify(jsonDoc, null, 2), 'utf-8')
      sendLog(
        `✔ JSON turbina (${suffix}): ${path.basename(outJson)} (${allWindblades.length} entradas)`,
        'success'
      )
    }

    sendLog(`✔ ${outputDirs.length} pá(s) reconstruída(s).`, 'success')
    return { success: true, output_dirs: outputDirs }
  } catch (err: any) {
    sendLog(`Erro na reconstrução multi-blade: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function detectarEstruturaAbc(rootPath: string): Promise<any> {
  try {
    if (!fs.existsSync(rootPath)) return { detected: false, folders: {} }
    const children = fs.readdirSync(rootPath, { withFileTypes: true })
    const found: Record<string, string> = {}

    for (const subdir of children) {
      if (!subdir.isDirectory()) continue
      const name = subdir.name.trim().toUpperCase()
      for (const label of ['A', 'B', 'C']) {
        if (found[label]) continue
        if (
          name === label ||
          name.endsWith(`_${label}`) ||
          name.endsWith(` ${label}`) ||
          name.endsWith(`-${label}`) ||
          name.startsWith(`${label}_`) ||
          name.startsWith(`${label} `)
        ) {
          found[label] = path.join(rootPath, subdir.name)
        }
      }
    }
    return { detected: Object.keys(found).length >= 2, folders: found }
  } catch {
    return { detected: false, folders: {} }
  }
}

export async function padronizarGoPro(
  fotosDir: string,
  dryRun: boolean,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Escaneando fotos GoPro na pasta...', 'info')
    const flatFiles = _listImagesFlat(fotosDir)
    const entries: any[] = []
    const skipped: string[] = []
    let selectSideFixed = 0

    const filenameRe =
      /^.+?--(?<blade>.+?)--(?<region>[A-Za-z]+)_(?<location>\d+)/i
    const fallbackRe = /^.+?--(?<blade>.+?)--[^_]+_(?<location>\d+)/i

    for (const fPath of flatFiles) {
      const stem = path.basename(fPath, path.extname(fPath))
      const m = stem.match(filenameRe)
      if (m && m.groups) {
        entries.push({
          blade: m.groups.blade,
          region: m.groups.region.toUpperCase(),
          location: parseInt(m.groups.location, 10),
          filePath: fPath,
        })
      } else {
        const fall = stem.match(fallbackRe)
        if (fall && fall.groups) {
          const parentFolder = path.basename(path.dirname(fPath)).toUpperCase()
          if (parentFolder in PACKER_REGION_MAP) {
            entries.push({
              blade: fall.groups.blade,
              region: parentFolder,
              location: parseInt(fall.groups.location, 10),
              filePath: fPath,
            })
            selectSideFixed++
          } else {
            skipped.push(path.basename(fPath))
          }
        } else {
          skipped.push(path.basename(fPath))
        }
      }
    }

    if (entries.length === 0) {
      return {
        success: false,
        error: 'Nenhum arquivo com padrão Arthbot reconhecido.',
      }
    }

    if (selectSideFixed > 0) {
      sendLog(
        `  ${selectSideFixed} arquivo(s) com região corrigida automaticamente pelo nome da pasta`,
        'warning'
      )
    }
    if (skipped.length > 0) {
      sendLog(
        `${skipped.length} arquivo(s) sem padrão reconhecido ignorados`,
        'warning'
      )
    }

    // Group by blade & region (chave interna arbitrária — blade/region reais ficam
    // guardados no próprio grupo, evitando reconstrução via split('_') que quebraria
    // se o blade SN contivesse underscore)
    const groups: Record<
      string,
      { blade: string; region: string; items: any[] }
    > = {}
    entries.forEach(e => {
      const key = `${e.blade} ${e.region}`
      if (!groups[key])
        groups[key] = { blade: e.blade, region: e.region, items: [] }
      groups[key].items.push(e)
    })

    // Sort within each group
    Object.values(groups).forEach(g => {
      g.items.sort(
        (a, b) =>
          a.location - b.location ||
          path.basename(a.filePath).localeCompare(path.basename(b.filePath))
      )
    })

    const outputDir = path.join(path.dirname(fotosDir), 'OUTPUT')
    if (!dryRun && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    let copied = 0
    Object.values(groups).forEach(({ blade, region, items }) => {
      const destSubdir = path.join(outputDir, blade, region)

      if (!dryRun && !fs.existsSync(destSubdir)) {
        fs.mkdirSync(destSubdir, { recursive: true })
      }

      items.forEach((item, order) => {
        const cleanName = `${blade}_${item.location}_${order + 1}.jpg`
        const destPath = path.join(destSubdir, cleanName)
        if (dryRun) {
          if (copied < 5) {
            sendLog(
              `  ${path.basename(item.filePath)}  →  ${blade}/${region}/${cleanName}`,
              'info'
            )
          }
        } else {
          fs.copyFileSync(item.filePath, destPath)
        }
        copied++
      })
    })

    if (dryRun) {
      sendLog(
        `[DRY-RUN] ${copied}/${entries.length} imagens seriam copiadas`,
        'warning'
      )
    } else {
      sendLog(
        `${copied}/${entries.length} imagens organizadas com sucesso`,
        'success'
      )
      sendLog(`Output: ${outputDir}`, 'info')
    }

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro ao padronizar GoPro: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function analisarGoProRaw(
  pastaBlade: string,
  webContents?: any
): Promise<any[]> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    if (!fs.existsSync(pastaBlade)) return []
    const list = fs.readdirSync(pastaBlade, { withFileTypes: true })
    const resultados: any[] = []

    for (const subdir of list) {
      if (!subdir.isDirectory()) continue
      const region = subdir.name.toUpperCase()
      if (region === 'VISUAL') continue

      const subpath = path.join(pastaBlade, subdir.name)
      const files = fs.readdirSync(subpath)
      const nums: number[] = []

      for (const file of files) {
        const ext = path.extname(file).toUpperCase()
        if (ext === '.JPG' || ext === '.JPEG') {
          const stem = path.basename(file, ext)
          const m = stem.match(_GOPRO_NUM_RE)
          if (m) {
            nums.push(parseInt(m[1], 10))
          }
        }
      }

      if (nums.length > 0) {
        nums.sort((a, b) => a - b)
        let minN = nums[0]
        let maxN = nums[nums.length - 1]

        // Rollover detection
        if (maxN - minN > 8000) {
          const adjNums = nums
            .map(n => (n < 5000 ? n + 10000 : n))
            .sort((a, b) => a - b)
          minN = adjNums[0] >= 10000 ? adjNums[0] - 10000 : adjNums[0]
          maxN =
            adjNums[adjNums.length - 1] >= 10000
              ? adjNums[adjNums.length - 1] - 10000
              : adjNums[adjNums.length - 1]
        }

        resultados.push({
          region,
          num_min: minN,
          num_max: maxN,
          total: nums.length,
        })
        sendLog(
          `  ${region}: ${nums.length} fotos (Cronológico: ${minN} → ${maxN})`,
          'info'
        )
      }
    }
    return resultados
  } catch (err: any) {
    sendLog(`Erro ao analisar GoPro RAW: ${err.message}`, 'error')
    return []
  }
}

export async function calibrarZGoProRaw(
  pastaBlade: string,
  turbine: string,
  bladeSn: string,
  referencias: any,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    const output = path.join(
      path.dirname(pastaBlade),
      'OUTPUT',
      `${turbine}--${bladeSn}`
    )
    let totalRenomeados = 0

    const list = fs.readdirSync(pastaBlade, { withFileTypes: true })
    for (const subdir of list) {
      if (!subdir.isDirectory()) continue
      const region = subdir.name.toUpperCase()
      if (!(region in PACKER_REGION_MAP)) continue

      if (region === 'VISUAL') {
        const outDir = path.join(output, region)
        fs.mkdirSync(outDir, { recursive: true })
        let vCount = 0
        const files = fs.readdirSync(path.join(pastaBlade, subdir.name))
        for (const file of files) {
          const ext = path.extname(file).toUpperCase()
          if (ext === '.JPG' || ext === '.JPEG') {
            fs.copyFileSync(
              path.join(pastaBlade, subdir.name, file),
              path.join(outDir, file)
            )
            vCount++
          }
        }
        if (vCount > 0) {
          sendLog(
            `  ${region}: ${vCount} foto(s) VISUAL copiada(s) diretamente`,
            'success'
          )
          totalRenomeados += vCount
        }
        continue
      }

      const cfg = referencias[region] || referencias[subdir.name] || {}
      const zInicial = parseInt(cfg.z_inicial || 0, 10) || 0
      const paired = !!cfg.paired
      const transition = parseInt(cfg.transition || 0, 10) || 0
      const photocard = parseInt(cfg.photocard || 0, 10) || 0

      const regionSubdir = path.join(pastaBlade, subdir.name)
      const files = fs.readdirSync(regionSubdir)
      const fotos: any[] = []
      const outDir = path.join(output, region)
      fs.mkdirSync(outDir, { recursive: true })
      let nonGoproCount = 0

      for (const file of files) {
        const ext = path.extname(file).toUpperCase()
        if (ext !== '.JPG' && ext !== '.JPEG') continue

        const filePath = path.join(regionSubdir, file)
        const stem = path.basename(file, ext)
        const m = stem.match(_GOPRO_NUM_RE)
        if (m) {
          const num = parseInt(m[1], 10)
          fotos.push({ num, orig_num: num, filePath })
        } else {
          fs.copyFileSync(filePath, path.join(outDir, file))
          nonGoproCount++
        }
      }

      if (nonGoproCount > 0) {
        sendLog(
          `  ${region}: ${nonGoproCount} foto(s) extra (sem padrão GoPro) copiada(s) diretamente`,
          'info'
        )
        totalRenomeados += nonGoproCount
      }

      if (fotos.length === 0) {
        sendLog(
          `  ${region}: nenhuma foto GoPro para calibrar Z, pulando.`,
          'warning'
        )
        continue
      }

      fotos.sort((a, b) => a.num - b.num)
      const rawNums = fotos.map(f => f.num)

      let adjFotos = fotos
      let adjTransition = transition
      if (rawNums[rawNums.length - 1] - rawNums[0] > 8000) {
        adjFotos = fotos.map(f => ({
          ...f,
          num: f.num < 5000 ? f.num + 10000 : f.num,
        }))
        adjFotos.sort((a, b) => a.num - b.num)
        if (transition > 0 && transition < 5000) {
          adjTransition = transition + 10000
        }
        sendLog(
          `  ${region}: rollover detectado (9999→0001), sequência reordenada.`,
          'info'
        )
      }

      const pairNote =
        paired && transition > 0
          ? ` (pares até GOPR${transition})`
          : paired
            ? ' (todos pareados)'
            : ''
      sendLog(
        `  ${region}: ${adjFotos.length} fotos · z_ini=${zInicial} mm · passo=500 mm${pairNote}`,
        'info'
      )

      let count = 0
      let currentPos = 0
      let photoInPos = 0

      for (const item of adjFotos) {
        let z = zInicial + currentPos * 500
        if (photocard > 0 && item.orig_num === photocard) {
          // Do not increment position
        } else {
          if (paired && (adjTransition <= 0 || item.num < adjTransition)) {
            z = zInicial + currentPos * 500
            photoInPos++
            if (photoInPos === 2) {
              currentPos++
              photoInPos = 0
            }
          } else {
            if (photoInPos === 1) {
              currentPos++
              photoInPos = 0
            }
            z = zInicial + currentPos * 500
            currentPos++
          }
        }

        const stats = fs.statSync(item.filePath)
        const mtime = new Date(stats.mtimeMs)
        const dateStr = `${String(mtime.getMonth() + 1).padStart(2, '0')}-${String(mtime.getDate()).padStart(2, '0')}-${mtime.getFullYear()}`

        const ext = path.extname(item.filePath)
        const stem = path.basename(item.filePath, ext)
        const newName = `${turbine}--${bladeSn}--${region}_${z}_${stem}-0---${dateStr}.JPG`

        fs.copyFileSync(item.filePath, path.join(outDir, newName))
        count++
      }

      sendLog(`  ${region}: ${count} foto(s) renomeada(s)`, 'success')
      totalRenomeados += count
    }

    if (totalRenomeados > 0) {
      sendLog(`Concluído: ${totalRenomeados} foto(s) gerada(s)`, 'success')
      sendLog(`Output: ${output}`, 'info')
    }

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro na calibração GoPro: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function vincularArthnexCsv(
  csvPath: string,
  fotosDir: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    sendLog('Iniciando vínculo Arthnex ↔ CSV...', 'info')
    sendLog('Escaneando fotos exportadas...', 'info')

    const parseArthnexFilename = (filename: string, filepath: string) => {
      const pattern = /^(.+?)--(.+?)--(.+?)_(-?[\d.]+)_(\d+)-\d+\.[jJ][pP][gG]$/
      const match = filename.match(pattern)
      if (!match) return null

      const parentFolder = path.basename(path.dirname(filepath))
      return {
        parque: match[1],
        turbine: match[2],
        blade_sn: match[3],
        location: parseFloat(match[4]),
        platform_order: parseInt(match[5], 10),
        side: parentFolder,
        filename,
        filepath,
      }
    }

    const fotos: any[] = []
    const walk = (dir: string) => {
      const list = fs.readdirSync(dir, { withFileTypes: true })
      for (const f of list) {
        const res = path.join(dir, f.name)
        if (f.isDirectory()) {
          walk(res)
        } else if (f.name.toLowerCase().endsWith('.jpg')) {
          const parsed = parseArthnexFilename(f.name, res)
          if (parsed) fotos.push(parsed)
        }
      }
    }
    walk(fotosDir)

    if (fotos.length === 0) {
      return {
        success: false,
        error: 'Nenhuma foto no padrão Arthnex encontrada no diretório.',
      }
    }

    sendLog(`Encontradas ${fotos.length} fotos Arthnex.`, 'info')

    sendLog('Lendo CSV...', 'info')
    const csvContent = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '')
    let delimiter = ';'
    let lines = csvContent.split(/\r?\n/).map(l => parseCsvLine(l, delimiter))
    let headers = lines[0].map(h => h.trim().replace(/^"|"$/g, ''))
    if (!headers.includes('Blade SN')) {
      delimiter = ','
      lines = csvContent.split(/\r?\n/).map(l => parseCsvLine(l, delimiter))
      headers = lines[0].map(h => h.trim().replace(/^"|"$/g, ''))
    }
    const rows = lines
      .slice(1)
      .filter(l => l.length >= headers.length)
      .map(l => {
        const obj: any = {}
        headers.forEach((h, idx) => {
          obj[h] = l[idx]?.trim().replace(/^"|"$/g, '')
        })
        return obj
      })

    // Tolerante a colunas ausentes (como o csv.DictReader do Python) — só pula a linha
    // se blade_sn ou original_image vierem vazios, em vez de rejeitar o CSV inteiro.
    const linhasCsv = rows
      .map(r => ({
        blade_sn: String(r['Blade SN'] || '').trim(),
        location: parseFloat(r['Location']) || 0,
        side: String(r['Side'] || '').trim(),
        original_image: String(r['Original Image'] || '').trim(),
        row_data: r,
      }))
      .filter(l => l.blade_sn && l.original_image)

    sendLog(`Lidas ${linhasCsv.length} linhas do CSV.`, 'info')

    // Grouping
    const fotosGrupos: Record<string, any[]> = {}
    fotos.forEach(f => {
      const key = `${f.blade_sn}_${f.side}_${f.location}`
      if (!fotosGrupos[key]) fotosGrupos[key] = []
      fotosGrupos[key].push(f)
    })

    const csvGrupos: Record<string, any[]> = {}
    linhasCsv.forEach(l => {
      const key = `${l.blade_sn}_${l.side}_${l.location}`
      if (!csvGrupos[key]) csvGrupos[key] = []
      csvGrupos[key].push(l)
    })

    const matches: any[] = []
    let orfaoCsv = 0
    let orfaoFoto = 0
    let colisoesResolvidas = 0
    const linhasOrfasCsv: any[] = []

    const bladeSnsCsv = new Set(linhasCsv.map(l => l.blade_sn))
    const bladeSnsFotos = new Set(fotos.map(f => f.blade_sn))

    linhasCsv.forEach(l => {
      const key = `${l.blade_sn}_${l.side}_${l.location}`
      let matchedKey = key

      if (!fotosGrupos[key]) {
        // Try inverted side (SS <-> PS)
        let invertedSide = ''
        if (l.side === 'SS') invertedSide = 'PS'
        else if (l.side === 'PS') invertedSide = 'SS'

        const invertedKey = `${l.blade_sn}_${invertedSide}_${l.location}`
        if (invertedSide && fotosGrupos[invertedKey]) {
          matchedKey = invertedKey
        } else {
          orfaoCsv++
          linhasOrfasCsv.push(l)
          return
        }
      }

      const fList = fotosGrupos[matchedKey]
      fList.sort((a, b) => a.platform_order - b.platform_order)

      // c_linhas matches rows
      const cRows = csvGrupos[key] || []
      if (cRows.length > 1 || fList.length > 1) {
        colisoesResolvidas += Math.min(cRows.length, fList.length)
      }

      const minCount = Math.min(cRows.length, fList.length)
      for (let i = 0; i < minCount; i++) {
        matches.push({
          foto: fList[i],
          csv_row: cRows[i],
        })
      }

      if (cRows.length > fList.length) {
        orfaoCsv += cRows.length - fList.length
        linhasOrfasCsv.push(...cRows.slice(fList.length))
      }
      if (fList.length > cRows.length) {
        orfaoFoto += fList.length - cRows.length
      }
    })

    // Check orphan photos — usa blade_sn/side/location originais de cada foto (não
    // reconstrói via split('_') da chave, que quebraria se o blade_sn tivesse underscore)
    const orphanGroupsSeen = new Set<string>()
    fotos.forEach(f => {
      const key = `${f.blade_sn}_${f.side}_${f.location}`
      if (orphanGroupsSeen.has(key)) return
      orphanGroupsSeen.add(key)

      let invertedSide = ''
      if (f.side === 'SS') invertedSide = 'PS'
      else if (f.side === 'PS') invertedSide = 'SS'
      const invertedKey = `${f.blade_sn}_${invertedSide}_${f.location}`

      if (!csvGrupos[key] && !csvGrupos[invertedKey]) {
        orfaoFoto += fotosGrupos[key].length
      }
    })

    if (matches.length === 0) {
      return {
        success: false,
        error: 'Nenhum vínculo encontrado entre CSV e as Fotos!',
      }
    }

    const outDir = path.join(path.dirname(csvPath), 'OUTPUT_ARTHNEX_MATCH')
    fs.mkdirSync(outDir, { recursive: true })

    sendLog(
      `Copiando e renomeando ${matches.length} arquivos vinculados...`,
      'info'
    )

    matches.forEach((m, idx) => {
      if (idx % 10 === 0) {
        if (webContents)
          webContents.send('arthprogress', {
            current: idx,
            total: matches.length,
          })
      }

      const foto = m.foto
      const csvRow = m.csv_row
      const bladeSn = foto.blade_sn
      let targetName = csvRow.original_image
      if (!targetName.toLowerCase().endsWith('.jpg')) {
        targetName += '.JPG'
      }

      const bladeDir = path.join(outDir, bladeSn)
      fs.mkdirSync(bladeDir, { recursive: true })

      const destPath = path.join(bladeDir, targetName)
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(foto.filepath, destPath)
      }
    })

    if (webContents)
      webContents.send('arthprogress', {
        current: matches.length,
        total: matches.length,
      })

    sendLog('\n--- RELATÓRIO DO VÍNCULO ---', 'info')
    sendLog(`✓ Matches OK: ${matches.length}`, 'success')

    if (colisoesResolvidas > 0) {
      sendLog(
        `⚠ Colisões resolvidas por ordem: ${colisoesResolvidas}`,
        'warning'
      )
    }
    if (orfaoCsv > 0) {
      sendLog(
        `⚠ CSV Órfão: ${orfaoCsv} linhas sem foto Arthnex correspondente`,
        'warning'
      )
      const reportPath = path.join(
        path.dirname(csvPath),
        'relatorio_linhas_orfas.csv'
      )
      try {
        if (linhasOrfasCsv.length > 0) {
          const cabecalhos = Object.keys(linhasOrfasCsv[0].row_data)
          const csvLines = [cabecalhos.join(';')]
          linhasOrfasCsv.forEach(l => {
            csvLines.push(cabecalhos.map(h => l.row_data[h]).join(';'))
          })
          fs.writeFileSync(reportPath, '\uFEFF' + csvLines.join('\n'), 'utf-8')
          sendLog(
            `  → Foi gerado um relatório detalhado das faltas em: ${path.basename(reportPath)}`,
            'warning'
          )
        }
      } catch (err: any) {
        sendLog(`Erro ao salvar relatório de órfãos: ${err.message}`, 'warning')
      }
    }

    if (orfaoFoto > 0) {
      sendLog(
        `⚠ Foto Órfã: ${orfaoFoto} fotos Arthnex sem linha no CSV correspondente`,
        'warning'
      )
    }

    const bladesDesaparecidos = Array.from(bladeSnsCsv).filter(
      x => !bladeSnsFotos.has(x)
    )
    if (bladesDesaparecidos.length > 0) {
      sendLog(
        `✗ Blade SNs faltantes nas fotos: ${bladesDesaparecidos.join(', ')}`,
        'error'
      )
    }

    sendLog(
      `\nProcesso concluído! Arquivos renomeados em: ${outDir}`,
      'success'
    )

    return { success: true }
  } catch (err: any) {
    sendLog(`Erro no vínculo Arthnex-CSV: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function analisarBladeSplit(
  filePath: string,
  threshold: number,
  webContents?: any
): Promise<any[]> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.json') {
      sendLog('Analisando JSON para divisão de voo...', 'info')
      const data = cryptoService.loadJson(filePath, [], true)
      const windblades = data.windblades || []
      if (windblades.length === 0) {
        sendLog('Nenhum windblade encontrado no JSON.', 'error')
        return []
      }

      const grupos: Record<string, any[]> = {}
      windblades.forEach((item: any, idx: number) => {
        const pos = item.blade_position || 'UNKNOWN'
        if (!grupos[pos]) grupos[pos] = []
        grupos[pos].push({ original_idx: idx, item })
      })

      const suspeitos: any[] = []
      for (const [pos, itens] of Object.entries(grupos)) {
        if (itens.length > threshold) {
          sendLog(
            `Posição ${pos} tem ${itens.length} fotos (suspeito > ${threshold}). Calculando gaps...`,
            'warning'
          )

          const itensComTempo = itens
            .map(it => {
              const name = it.item.image_metadata?.original_file_name || ''
              const dt = extractDjiTimestamp(name)
              return {
                original_idx: it.original_idx,
                dt,
              }
            })
            .sort((a, b) => a.dt.getTime() - b.dt.getTime())

          const quebras: any[] = []
          for (let i = 1; i < itensComTempo.length; i++) {
            const t0 = itensComTempo[i - 1].dt
            const t1 = itensComTempo[i].dt
            if (t0.getTime() === 0 || t1.getTime() === 0) continue
            const gap = (t1.getTime() - t0.getTime()) / 1000
            if (gap > 60) {
              quebras.push({ index: i, gap_seconds: gap })
            }
          }

          if (quebras.length === 0) continue

          sendLog(
            `-> ${quebras.length} gap(s) encontrado(s) em '${pos}': ` +
              quebras.map(q => `${q.gap_seconds.toFixed(0)}s`).join(', '),
            'warning'
          )

          const limites = [
            0,
            ...quebras.map(q => q.index),
            itensComTempo.length,
          ]
          const sessoes: any[] = []
          for (let sIdx = 0; sIdx < limites.length - 1; sIdx++) {
            const fatia = itensComTempo.slice(limites[sIdx], limites[sIdx + 1])
            const dtsValidos = fatia
              .map(x => x.dt)
              .filter(d => d.getTime() !== 0)
            const tsInicio =
              dtsValidos.length > 0
                ? new Date(Math.min(...dtsValidos.map(d => d.getTime())))
                : null
            const tsFim =
              dtsValidos.length > 0
                ? new Date(Math.max(...dtsValidos.map(d => d.getTime())))
                : null

            sessoes.push({
              session_idx: sIdx,
              ts_inicio: tsInicio ? tsInicio.toISOString() : null,
              ts_fim: tsFim ? tsFim.toISOString() : null,
              total_fotos: fatia.length,
              original_indices: fatia.map(x => x.original_idx),
              itens_com_tempo: fatia,
            })
          }

          suspeitos.push({
            blade_position: pos,
            total_fotos: itens.length,
            sessoes,
          })
        }
      }

      if (suspeitos.length === 0) {
        sendLog(
          'Nenhuma posição parece misturada ou os gaps temporais são normais.',
          'success'
        )
      }
      return suspeitos
    } else if (ext === '.csv') {
      sendLog('Analisando CSV para divisão de voo...', 'info')
      const csvContent = fs.readFileSync(filePath, 'utf-8')
      let delimiter = ';'
      if (!csvContent.includes(';')) delimiter = ','

      const lines = csvContent
        .split(/\r?\n/)
        .map(l => parseCsvLine(l, delimiter))
      const headers = lines[0].map(h => h.trim().replace(/^"|"$/g, ''))
      const rows = lines
        .slice(1)
        .filter(l => l.length >= headers.length)
        .map(l => {
          const obj: any = {}
          headers.forEach((h, idx) => {
            obj[h] = l[idx]?.trim().replace(/^"|"$/g, '')
          })
          return obj
        })

      if (
        !headers.includes('Blade SN') ||
        !headers.includes('Original Image')
      ) {
        sendLog(
          "CSV inválido. Colunas 'Blade SN' e 'Original Image' necessárias.",
          'error'
        )
        return []
      }

      const sideCol =
        ['Side', 'side', 'Blade Side', 'blade_side', 'Image Side'].find(c =>
          headers.includes(c)
        ) || ''

      const grupos: Record<string, any[]> = {}
      rows.forEach((row, idx) => {
        const sn = String(row['Blade SN']).trim()
        if (!grupos[sn]) grupos[sn] = []
        grupos[sn].push({ original_idx: idx, row })
      })

      const suspeitos: any[] = []
      const sessionGap = 300 // default 5 minutes

      for (const [sn, itens] of Object.entries(grupos)) {
        if (itens.length < threshold) continue

        const itensComTempo = itens
          .map(it => {
            const name = String(it.row['Original Image']).trim()
            const dt = extractDjiTimestamp(name)
            const sideVal = sideCol ? String(it.row[sideCol]).trim() : ''
            return {
              original_idx: it.original_idx,
              dt,
              side: ['nan', 'NaN', 'None'].includes(sideVal) ? '' : sideVal,
            }
          })
          .sort((a, b) => a.dt.getTime() - b.dt.getTime())

        const quebras: number[] = []
        for (let i = 1; i < itensComTempo.length; i++) {
          const t0 = itensComTempo[i - 1].dt
          const t1 = itensComTempo[i].dt
          if (t0.getTime() === 0 || t1.getTime() === 0) continue
          const gap = (t1.getTime() - t0.getTime()) / 1000
          if (gap >= sessionGap) {
            quebras.push(i)
          }
        }

        if (quebras.length === 0) continue

        sendLog(
          `Pá ${sn}: ${itensComTempo.length} fotos | ${quebras.length + 1} sessões detectadas`,
          'warning'
        )

        const limites = [0, ...quebras, itensComTempo.length]
        const sessoes: any[] = []
        for (let sIdx = 0; sIdx < limites.length - 1; sIdx++) {
          const fatia = itensComTempo.slice(limites[sIdx], limites[sIdx + 1])
          const dtsValidos = fatia.map(x => x.dt).filter(d => d.getTime() !== 0)
          const tsInicio =
            dtsValidos.length > 0
              ? new Date(Math.min(...dtsValidos.map(d => d.getTime())))
              : null
          const tsFim =
            dtsValidos.length > 0
              ? new Date(Math.max(...dtsValidos.map(d => d.getTime())))
              : null
          const sides = Array.from(
            new Set(fatia.map(x => x.side).filter(s => !!s))
          ).sort()

          sessoes.push({
            session_idx: sIdx,
            ts_inicio: tsInicio ? tsInicio.toISOString() : null,
            ts_fim: tsFim ? tsFim.toISOString() : null,
            total_fotos: fatia.length,
            sides,
            original_indices: fatia.map(x => x.original_idx),
            itens_com_tempo: fatia,
          })
        }

        suspeitos.push({
          blade_sn: sn,
          total_fotos: itensComTempo.length,
          sessoes,
        })
      }

      if (suspeitos.length === 0) {
        sendLog(
          'Nenhuma pá com múltiplas sessões de voo detectadas.',
          'success'
        )
      }
      return suspeitos
    }
  } catch (err: any) {
    sendLog(`Erro na análise de split: ${err.message}`, 'error')
  }
  return []
}

export async function corrigirBladeSplit(
  filePath: string,
  correcoes: any[],
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.json') {
      const data = cryptoService.loadJson(filePath, [], true)
      const windblades = data.windblades || []
      let mudancas = 0

      for (const corr of correcoes) {
        const posOriginal = corr.blade_position
        for (const sessao of corr.sessoes) {
          const novaPos = sessao.novo_blade_position
          const novoSn = sessao.novo_blade_sn

          for (const itemInfo of sessao.itens_com_tempo) {
            const origIdx = itemInfo.original_idx
            const wbItem = windblades[origIdx]
            if (!wbItem) continue

            const bladeSnAntigo = wbItem.blade_sn || ''
            const posAtual = wbItem.blade_position || posOriginal

            if (novaPos === posAtual && novoSn === bladeSnAntigo) continue

            wbItem.blade_position = novaPos
            wbItem.blade_sn = novoSn

            const meta = wbItem.image_metadata || {}
            let oldPath = meta.image_file_path || ''
            if (oldPath) {
              const strFind = escapeRegExp(`${posOriginal}_${bladeSnAntigo}`)
              const strRepl = `${novaPos}_${novoSn}`
              let newPath = oldPath.replace(new RegExp(strFind, 'g'), strRepl)
              newPath = newPath.replace(
                new RegExp(`/${escapeRegExp(posOriginal)}/`, 'g'),
                `/${novaPos}/`
              )
              newPath = newPath.replace(
                new RegExp(`-${escapeRegExp(posOriginal)}-`, 'g'),
                `-${novaPos}-`
              )
              meta.image_file_path = newPath
            }
            mudancas++
          }
        }
      }

      if (mudancas > 0) {
        const outPath = filePath.replace(/\.json$/i, '_corrigido.json')
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8')
        sendLog(`Correção aplicada! ${mudancas} fotos atualizadas.`, 'success')
        sendLog(`Salvo como: ${path.basename(outPath)}`, 'success')
      } else {
        sendLog('Nenhuma mudança foi aplicada.', 'info')
      }
    } else if (ext === '.csv') {
      const csvContent = fs.readFileSync(filePath, 'utf-8')
      let delimiter = ';'
      if (!csvContent.includes(';')) delimiter = ','

      const lines = csvContent
        .split(/\r?\n/)
        .map(l => parseCsvLine(l, delimiter))
      const headers = lines[0].map(h => h.trim().replace(/^"|"$/g, ''))
      const rows = lines
        .slice(1)
        .filter(l => l.length >= headers.length)
        .map(l => {
          const obj: any = {}
          headers.forEach((h, idx) => {
            obj[h] = l[idx]?.trim().replace(/^"|"$/g, '')
          })
          return obj
        })

      const multiplosOriginais = correcoes.length > 1
      let mudancas = 0

      for (const atrib of correcoes) {
        const snOriginal = atrib.blade_sn_original
        const porNovoSn: Record<string, number[]> = {}

        atrib.sessoes.forEach((sessao: any) => {
          const novoSn = sessao.novo_sn
          if (!porNovoSn[novoSn]) porNovoSn[novoSn] = []
          porNovoSn[novoSn].push(...sessao.original_indices)
        })

        for (const [novoSn, indices] of Object.entries(porNovoSn)) {
          if (indices.length === 0) continue

          const dfGrupo = indices.map(idx => {
            const r = { ...rows[idx] }
            r['Blade SN'] = novoSn
            return r
          })

          let outPath = ''
          if (novoSn === snOriginal) {
            outPath = multiplosOriginais
              ? filePath.replace(/\.csv$/i, `_corrigido_${novoSn}.csv`)
              : filePath.replace(/\.csv$/i, '_corrigido.csv')
          } else {
            outPath = filePath.replace(/\.csv$/i, `_split_${novoSn}.csv`)
          }

          const outLines = [headers.map(h => `"${h}"`).join(';')]
          dfGrupo.forEach(r => {
            outLines.push(
              headers
                .map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`)
                .join(';')
            )
          })
          fs.writeFileSync(outPath, outLines.join('\n'), 'utf-8')
          sendLog(
            `✔ CSV gerado para SN ${novoSn}: ${path.basename(outPath)} (${dfGrupo.length} fotos)`,
            'success'
          )
          mudancas++
        }
      }

      if (mudancas === 0) {
        sendLog('Nenhuma mudança foi aplicada.', 'info')
      }
    }
    return { success: true }
  } catch (err: any) {
    sendLog(`Erro ao aplicar correção de split: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function jsonParaCsvOrganizar(
  jsonPath: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    const data = cryptoService.loadJson(jsonPath, [], true)
    const windblades = data.windblades || []
    if (windblades.length === 0) {
      sendLog('Nenhum windblade encontrado no JSON.', 'error')
      return { success: false, error: 'Nenhum windblade encontrado.' }
    }

    const groups: Record<string, any[]> = {}
    windblades.forEach((item: any) => {
      const key = `${item.blade_position || ''}_${item.blade_sn || ''}`
      if (!groups[key]) groups[key] = []
      groups[key].push(item)
    })

    let csvsGerados = 0

    for (const items of Object.values(groups)) {
      const bladeSn = items[0].blade_sn || ''
      const byRegion: Record<string, any[]> = {}
      items.forEach((item: any) => {
        const r = item.region || ''
        if (!byRegion[r]) byRegion[r] = []
        byRegion[r].push(item)
      })

      const rows: any[] = []
      for (const [region, regionItems] of Object.entries(byRegion)) {
        const isTipToRoot = region === 'SS' || region === 'PS'
        regionItems.sort((a, b) => {
          const tA = extractDjiTimestamp(
            a.image_metadata?.original_file_name || ''
          ).getTime()
          const tB = extractDjiTimestamp(
            b.image_metadata?.original_file_name || ''
          ).getTime()
          return tA - tB
        })
        if (isTipToRoot) {
          regionItems.reverse()
        }

        const rawPx = regionItems.map(
          item => item.image_metadata?.pixel_size || ''
        )
        const fixedPx = _fixPixelMm(rawPx)
        let pxCorrections = 0
        rawPx.forEach((o, idx) => {
          if (String(o) !== String(fixedPx[idx])) pxCorrections++
        })
        if (pxCorrections > 0) {
          sendLog(
            `⚠ ${pxCorrections} Pixel MM corrompido(s) corrigidos na região ${region} (${bladeSn}).`,
            'warning'
          )
        }

        regionItems.forEach((item, idxR) => {
          const meta = item.image_metadata || {}
          const originalName = meta.original_file_name || ''
          if (!originalName) return
          rows.push({
            'Blade SN': bladeSn,
            Side: region,
            'Original Image': originalName,
            Location: meta.location || '',
            'Pixel MM': fixedPx[idxR],
          })
        })
      }

      if (rows.length === 0) {
        sendLog(
          `⚠ Blade SN ${bladeSn}: nenhuma imagem encontrada, pulando.`,
          'warning'
        )
        continue
      }

      const safeSn = bladeSn.replace(/[\/*?:"<>|]/g, '').trim()
      const outPath = jsonPath.replace(/\.json$/i, `_${safeSn}_organizar.csv`)
      const headers = [
        'Blade SN',
        'Side',
        'Original Image',
        'Location',
        'Pixel MM',
      ]
      const csvLines = [headers.join(';')]
      rows.forEach(r => {
        csvLines.push(
          `${r['Blade SN']};${r['Side']};${r['Original Image']};${r['Location']};${r['Pixel MM']}`
        )
      })
      fs.writeFileSync(outPath, '\uFEFF' + csvLines.join('\n'), 'utf-8')
      sendLog(
        `✔ ${bladeSn}: ${path.basename(outPath)} (${rows.length} linhas)`,
        'success'
      )
      csvsGerados++
    }

    if (csvsGerados === 0) {
      sendLog('Nenhum CSV gerado — JSON sem imagens válidas.', 'error')
      return { success: false, error: 'Nenhum CSV gerado.' }
    }

    sendLog(
      `${csvsGerados} CSV(s) gerado(s) prontos para o Módulo 1.`,
      'success'
    )
    sendLog(`Output: ${path.dirname(jsonPath)}`, 'info')
    return { success: true }
  } catch (err: any) {
    sendLog(`Erro ao gerar CSV do JSON: ${err.message}`, 'error')
    return { success: false, error: err.message }
  }
}

export async function carregarFotosGps(
  pasta: string,
  webContents?: any
): Promise<any[]> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }

  try {
    const filePaths = _listImagesFlat(pasta).sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b))
    )

    if (filePaths.length === 0) {
      sendLog('Nenhuma foto .JPG/.JPEG encontrada na pasta.', 'error')
      return []
    }

    const resultado: any[] = []
    let semGps = 0

    for (const f of filePaths) {
      const alt = await extractGpsAltitude(f)
      if (alt !== null) {
        resultado.push({
          nome: path.basename(f),
          altitude: parseFloat(alt.toFixed(3)),
        })
      } else {
        semGps++
      }
    }

    sendLog(`${resultado.length} fotos com GPS | ${semGps} sem GPS.`, 'info')
    return resultado
  } catch (err: any) {
    sendLog(`Erro ao carregar fotos GPS: ${err.message}`, 'error')
    return []
  }
}

export async function lerJsonReferenciaPixelMm(
  jsonPath: string,
  webContents?: any
): Promise<any> {
  const sendLog = (text: string, type = 'info') => {
    if (webContents) webContents.send('arthlog', { type, text })
  }
  try {
    const data = cryptoService.loadJson(jsonPath, [], true)
    const windblades = data.windblades || []
    if (windblades.length === 0) {
      return { success: false, error: 'Nenhum windblade encontrado no JSON.' }
    }
    const byRegion: Record<string, number[]> = {}
    windblades.forEach((item: any) => {
      const region = String(item.region || '')
        .trim()
        .toUpperCase()
      if (['LE', 'SS', 'TE', 'PS'].includes(region)) {
        const px = parseFloat(item.image_metadata?.pixel_size)
        if (!isNaN(px) && px >= 0.1 && px <= 1.0) {
          if (!byRegion[region]) byRegion[region] = []
          byRegion[region].push(px)
        }
      }
    })

    const averages: Record<string, number> = {}
    let foundAny = false
    Object.keys(byRegion).forEach(region => {
      const vals = byRegion[region]
      if (vals.length > 0) {
        averages[region] = parseFloat(
          (vals.reduce((sum, v) => sum + v, 0) / vals.length).toFixed(5)
        )
        foundAny = true
      }
    })

    if (!foundAny) {
      return {
        success: false,
        error: 'Nenhum valor de pixel_size válido encontrado no JSON.',
      }
    }

    sendLog(
      `✔ Médias de pixel_mm carregadas do JSON: ${JSON.stringify(averages)}`,
      'success'
    )
    return { success: true, averages }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}
