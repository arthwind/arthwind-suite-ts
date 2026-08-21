/**
 * Gerenciador de abas abertas — pedido do usuário: na prática, abas ficam
 * abertas de propósito (revisão de defeito/vídeo em modo Conferência Manual)
 * ou sobram por engano depois de um erro, e vão acumulando RAM até travar a
 * máquina, sem nenhuma visibilidade de quantas/quais estão abertas.
 *
 * O Playwright já sabe quais páginas existem (`context.pages()`) — o que falta
 * é METADADO (por que essa aba está aberta, de qual turbina/pá). Este módulo
 * só guarda esse metadado ao lado da própria `Page`; a limpeza de abas
 * `'transient'` esquecidas por erro é automática (varredura periódica), e as
 * de revisão (`'defect-review'`/`'video-review'`) só fecham por ação do
 * usuário — nunca sozinhas, porque são de propósito.
 */
import type { Page } from 'playwright'

export type TabPurpose = 'defect-review' | 'video-review' | 'audit' | 'transient'

export interface TabInfo {
  id: string
  purpose: TabPurpose
  turbine?: string
  blade?: string
  label: string
  openedAt: number
}

interface TabEntry {
  page: Page
  info: TabInfo
}

const tabs = new Map<string, TabEntry>()
let nextId = 1

/** Abas `'transient'` (checagem de login, auditoria, busca de INC) deveriam
 * sempre terminar rápido — se uma ainda estiver aberta depois desse tempo, é
 * vazamento de um caminho de erro que não fechou, e pode ser descartada sem
 * dó (não guarda trabalho de ninguém, ao contrário das abas de revisão). */
const TRANSIENT_MAX_AGE_MS = 2 * 60 * 1000
const SWEEP_INTERVAL_MS = 30 * 1000

export function registerTab(page: Page, info: Omit<TabInfo, 'id' | 'openedAt'>): string {
  const id = String(nextId++)
  const full: TabInfo = { ...info, id, openedAt: Date.now() }
  tabs.set(id, { page, info: full })
  page.on('close', () => tabs.delete(id))
  return id
}

/** Reclassifica uma aba já registrada — usado quando um vídeo esgota as
 * retentativas de confirmação sem sucesso: deixa de ser `'transient'`
 * (poderia ser fechada sozinha pela varredura) e vira `'video-review'`
 * (precisa de alguém olhar, nunca fecha sozinha). */
export function reclassifyTab(id: string, purpose: TabPurpose): void {
  const entry = tabs.get(id)
  if (entry) entry.info.purpose = purpose
}

/** Lista só as abas de REVISÃO (de propósito) — as `'transient'`/`'audit'` não
 * aparecem pro usuário porque deveriam se resolver sozinhas; se aparecessem,
 * só confundiriam sem dar nenhuma ação útil pra fazer com elas. */
export function listReviewTabs(): TabInfo[] {
  return [...tabs.values()]
    .map((e) => e.info)
    .filter((info) => info.purpose === 'defect-review' || info.purpose === 'video-review')
    .sort((a, b) => a.openedAt - b.openedAt)
}

export async function closeTab(id: string): Promise<boolean> {
  const entry = tabs.get(id)
  if (!entry) return false
  await entry.page.close().catch(() => {})
  tabs.delete(id)
  return true
}

export async function closeAllReviewTabs(): Promise<number> {
  const ids = listReviewTabs().map((t) => t.id)
  for (const id of ids) await closeTab(id)
  return ids.length
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

function sweepStaleTransientTabs(): void {
  const now = Date.now()
  for (const [id, entry] of tabs) {
    if (entry.info.purpose === 'transient' && now - entry.info.openedAt > TRANSIENT_MAX_AGE_MS) {
      entry.page.close().catch(() => {})
      tabs.delete(id)
    }
  }
}

/** Chamado uma vez, na inicialização do app (ver index.ts) — mantém a
 * varredura rodando o processo inteiro, não só durante uma automação. */
export function startTabSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(sweepStaleTransientTabs, SWEEP_INTERVAL_MS)
}
