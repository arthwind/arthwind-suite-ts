/**
 * Consulta o "Set Number" de uma pá a partir do Blade SN curto do Arthnex (ex: "377"),
 * usando a lista LDV (Windfarm/Turbine/Component/Serial/Set Number) mantida pela equipe.
 *
 * O Blade SN do Arthnex bate com o grupo do meio do serial completo do fabricante —
 * ex.: serial "A1 811 0377 0112" → Blade SN "377" → Set "0112". Confirmado comparando
 * a VSR05-06 (pás 377/404/408, todas do mesmo Set 0112).
 */
import fs from 'fs'
import path from 'path'

interface BladeSetEntry {
  windfarm: string | null
  turbine: string
  turbinePrefix: string
  component: string | null
  serial: string
  bladeSn: string | null
  setNumber: string | null
}

let cache: BladeSetEntry[] | null = null
let cacheMtimeMs = 0

/** Mesma pasta persistente que já guarda o config.json (%APPDATA%/ArthwindSuite/). */
function bladeSetsPath(): string {
  const appdata = process.env.APPDATA
  const folder = appdata ? path.join(appdata, 'ArthwindSuite') : 'ArthwindSuite'
  return path.join(folder, 'blade_sets.json')
}

/** Na primeira execução, copia a lista padrão empacotada com o app pra pasta editável do usuário. */
function seedFromResourcesIfMissing(dest: string): void {
  if (fs.existsSync(dest)) return

  const candidates = [
    path.join(__dirname, '..', '..', 'resources', 'blade_sets.json'),
    path.join(__dirname, '..', '..', '..', 'resources', 'blade_sets.json'),
    path.join(__dirname, 'resources', 'blade_sets.json'),
  ]
  for (const src of candidates) {
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      return
    }
  }
}

/** O Set Number de uma pá é SEMPRE os 4 últimos dígitos do Serial Number
 * completo ("A1/T3 811 XXXX YYYY" → Set = "YYYY", literal, sem tirar nem
 * acrescentar zero à esquerda — Set 1000 é "1000", Set 999 é "0999")
 * (regra confirmada pelo usuário). A coluna "Set Number" da planilha que
 * alimenta essa lista vem preenchida manualmente à parte e, na prática,
 * bate errado ou fica em branco com frequência (achado real: 107 das 208
 * entradas estavam erradas ou vazias) — então em vez de confiar nela,
 * deriva sempre do próprio serial, que é a fonte de verdade. */
export function deriveSetNumberFromSerial(serial: string): string | null {
  const parts = serial.trim().split(/\s+/)
  const last = parts[parts.length - 1]
  return /^\d{4}$/.test(last) ? last : null
}

function loadBladeSets(): BladeSetEntry[] {
  const filePath = bladeSetsPath()
  seedFromResourcesIfMissing(filePath)

  try {
    const stat = fs.statSync(filePath)
    if (cache && stat.mtimeMs === cacheMtimeMs) return cache
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed: BladeSetEntry[] = JSON.parse(raw)
    cache = parsed.map((e) => ({
      ...e,
      setNumber: (e.serial && deriveSetNumberFromSerial(e.serial)) || e.setNumber
    }))
    cacheMtimeMs = stat.mtimeMs
    return cache ?? []
  } catch {
    return []
  }
}

export interface BladeInfo {
  serial: string | null
  setNumber: string | null
}

export type { BladeSetEntry }

/** O Blade SN curto (ex.: "527") NÃO é único globalmente — o mesmo código pode
 * aparecer em turbinas diferentes com Set Number diferente (confirmado: "527"
 * existe tanto na VSR06-01 (Set 0171) quanto na VSR22-01 (Set 175)). Por isso,
 * sempre que a turbina for conhecida, o match é restrito a ela primeiro; só cai
 * pro match global (potencialmente ambíguo) se a turbina não for informada ou
 * não tiver nenhuma pá com esse bladeSn cadastrada. */
function findEntry(bladeSn: string | number, turbine?: string): BladeSetEntry | undefined {
  const key = String(bladeSn).trim().replace(/^B/i, '').replace(/^0+/, '') || '0'
  const entries = loadBladeSets()

  if (turbine) {
    const t = turbine.trim()
    const scoped = entries.filter((e) => e.turbine === t || e.turbinePrefix === t || t.startsWith(e.turbinePrefix))
    const scopedMatch = scoped.find((e) => e.bladeSn === key)
    if (scopedMatch) return scopedMatch
  }

  return entries.find((e) => e.bladeSn === key)
}

/** Retorna o Set Number pro Blade SN dado, ou null se não achar na lista.
 * Passe `turbine` (WTG ou serial completo) sempre que disponível — o bladeSn
 * curto sozinho pode ser ambíguo entre turbinas diferentes. */
export function getSetNumber(bladeSn: string | number, turbine?: string): string | null {
  return findEntry(bladeSn, turbine)?.setNumber ?? null
}

/** Retorna informações completas da pá (Serial de 13 dígitos e Set Number).
 * Passe `turbine` (WTG ou serial completo) sempre que disponível — o bladeSn
 * curto sozinho pode ser ambíguo entre turbinas diferentes. */
export function getBladeInfo(bladeSn: string | number, turbine?: string): BladeInfo {
  const match = findEntry(bladeSn, turbine)
  return {
    serial: match?.serial ?? null,
    setNumber: match?.setNumber ?? null,
  }
}

/** Retorna as (normalmente 3) pás de uma turbina, pelo código WTG (ex.: "VSR03-01") —
 * usa `turbinePrefix`, não `turbine` (que na lista vem como uma string combinada
 * "VSR03-01-90626", não só o código WTG). Ordenada por `component` ("Rotor blade
 * 1/2/3"), que ordena lexicograficamente igual à ordem numérica aqui (1, 2, 3) —
 * assume-se Rotor blade 1→Blade A, 2→Blade B, 3→Blade C no formulário do
 * ServiceNow (a ordem real ainda precisa ser confirmada rodando contra o
 * ServiceNow de verdade). */
export function getBladesForTurbine(wtg: string): BladeSetEntry[] {
  const key = wtg.trim()
  const entries = loadBladeSets()
  return entries
    .filter((e) => e.turbinePrefix === key)
    .sort((a, b) => (a.component || '').localeCompare(b.component || ''))
}

