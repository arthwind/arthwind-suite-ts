/**
 * Configuração por parque eólico (líder, técnicos, Purchase Order) — pedido do
 * usuário: hoje esses valores são constantes fixas no código, específicas de
 * "Lagoa dos Ventos". Com a Cajuina entrando (e outros parques na LATAM
 * depois, cada um com técnicos diferentes), isso precisa ser editável sem
 * mexer em código. O modelo da pá (Blade type) e o método de acesso continuam
 * fixos pra toda a campanha — só o que varia por parque vira config aqui.
 *
 * Mesmo padrão de `blade_sets.json`: um JSON editável em
 * %APPDATA%/ArthwindSuite/, mas SEM seed automático (não existe "valor padrão"
 * de líder/técnico que faça sentido chutar) — a tela de configuração cuida de
 * criar o arquivo na primeira vez que o usuário salvar um parque.
 */
import fs from 'fs'
import path from 'path'

export interface WindfarmConfig {
  windfarm: string
  leader: string
  technicians: string[]
  purchaseOrder: string
}

function configPath(): string {
  const appdata = process.env.APPDATA
  const folder = appdata ? path.join(appdata, 'ArthwindSuite') : 'ArthwindSuite'
  return path.join(folder, 'windfarm_config.json')
}

export function listWindfarmConfigs(): WindfarmConfig[] {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveWindfarmConfig(config: WindfarmConfig): {
  success: boolean
} {
  const all = listWindfarmConfigs()
  const idx = all.findIndex(c => c.windfarm === config.windfarm)
  if (idx >= 0) all[idx] = config
  else all.push(config)

  const dest = configPath()
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(all, null, 2) + '\n', 'utf-8')
  return { success: true }
}

export function deleteWindfarmConfig(windfarm: string): { success: boolean } {
  const all = listWindfarmConfigs().filter(c => c.windfarm !== windfarm)
  fs.writeFileSync(configPath(), JSON.stringify(all, null, 2) + '\n', 'utf-8')
  return { success: true }
}

/** Busca a config de um parque pelo nome exato do campo `windfarm` de
 * `blade_sets.json` (mesmo valor, já usado pra achar as pás de cada turbina —
 * não precisa de nenhuma lógica nova de nomenclatura de turbina). `null` se
 * o parque ainda não foi cadastrado — quem chama decide se avisa e segue sem
 * preencher, ou aborta. */
export function getWindfarmConfig(windfarm: string): WindfarmConfig | null {
  return listWindfarmConfigs().find(c => c.windfarm === windfarm) ?? null
}
