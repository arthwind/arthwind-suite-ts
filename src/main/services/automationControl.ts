/**
 * Controle de Pausar/Parar da automação SNOW — pedido do usuário: hoje, pra
 * parar a automação por qualquer motivo, só fechando e reabrindo o app. Um
 * único estado compartilhado (processo inteiro roda uma automação por vez) que
 * os loops chamam entre uma linha/turbina e outra — nunca no meio de preencher
 * um formulário, pra nunca deixar nada pela metade.
 */

type LogFn = (msg: string) => void

let paused = false
let stopRequested = false
let resumeWaiters: (() => void)[] = []

/** Erro especial lançado por `checkpoint()` quando o usuário pediu Parar — os
 * loops que chamam `checkpoint()` deixam propagar; o topo (`runFullAutomation`/
 * `runSnowDamageAutomation`) captura isso e devolve um resultado limpo de
 * "interrompido pelo usuário", não um erro de verdade. */
export class AutomationStoppedError extends Error {
  constructor() {
    super('Automação interrompida pelo usuário.')
    this.name = 'AutomationStoppedError'
  }
}

/** Chamar sempre no INÍCIO de uma nova execução (Rodar Agora / Automação
 * Completa / item da fila) — limpa qualquer Parar/Pausar que tenha sobrado de
 * uma execução anterior, senão a próxima nem começaria. */
export function resetAutomationControl(): void {
  paused = false
  stopRequested = false
  resumeWaiters = []
}

export function pauseAutomation(): void {
  paused = true
}

export function resumeAutomation(): void {
  paused = false
  const waiters = resumeWaiters
  resumeWaiters = []
  for (const resolve of waiters) resolve()
}

export function stopAutomation(): void {
  stopRequested = true
  // Se estava pausado esperando, libera o `await` no checkpoint pra ele
  // conseguir checar `stopRequested` e lançar o erro na hora, em vez de ficar
  // preso esperando um "retomar" que nunca vem.
  resumeAutomation()
}

export function isPaused(): boolean {
  return paused
}

export function isStopRequested(): boolean {
  return stopRequested
}

/** Ponto de checagem — chamado entre uma linha/turbina e outra (nunca no meio
 * de preencher um formulário). Se Parar foi pedido, lança `AutomationStoppedError`
 * (o chamador deixa propagar até o topo). Se Pausar foi pedido, espera até
 * alguém chamar `resumeAutomation()` (ou `stopAutomation()`, que libera e já
 * lança o erro de parada). */
export async function checkpoint(log: LogFn): Promise<void> {
  if (stopRequested) throw new AutomationStoppedError()

  if (paused) {
    log('⏸ Pausado — aguardando retomar...')
    await new Promise<void>((resolve) => resumeWaiters.push(resolve))
    if (stopRequested) throw new AutomationStoppedError()
    log('▶ Retomado.')
  }
}
