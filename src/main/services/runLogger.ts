/**
 * Log completo em arquivo, por execução — pedido do usuário: o painel da UI
 * tem limite de linhas e sempre rola pra mais recente, difícil de ler depois.
 * Um arquivo por execução, gravado LINHA A LINHA na hora (não em lote no
 * final) — nunca se perde nada mesmo se o app fechar/travar de um jeito feio,
 * não só nos pontos de pausar/parar/fechar.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'

function logsDir(): string {
  const appdata = process.env.APPDATA
  const dir = appdata ? path.join(appdata, 'ArthwindSuite', 'logs') : path.join(os.tmpdir(), 'ArthwindSuite', 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getLogsDir(): string {
  return logsDir()
}

function timestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fileStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

export class RunLogger {
  private filePath: string
  private stream: fs.WriteStream

  constructor(prefix: string) {
    this.filePath = path.join(logsDir(), `${prefix}_${fileStamp(new Date())}.log`)
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' })
  }

  /** Grava uma linha de log já emitida (mesmo texto que aparece no painel),
   * com o timestamp na frente. */
  write(msg: string): void {
    this.stream.write(`[${timestamp(new Date())}] ${msg}\n`)
  }

  /** Linha marcadora — usada nos pontos de pausar/parar/fechar, pra ficar
   * claro no arquivo ONDE a execução foi interrompida, sem precisar adivinhar
   * pela última linha normal. */
  marker(text: string): void {
    this.stream.write(`=== ${text} às ${timestamp(new Date())} ===\n`)
  }

  close(): void {
    this.stream.end()
  }

  get path(): string {
    return this.filePath
  }
}

/** Encapsula um `log_fn` existente pra também gravar cada linha no arquivo —
 * usado nos handlers de IPC (`index.ts`), sem precisar mexer no resto do
 * código de automação, que já emite log normalmente. */
export function wrapWithRunLogger(prefix: string, log: (msg: string) => void): { log: (msg: string) => void; logger: RunLogger } {
  const logger = new RunLogger(prefix)
  return {
    log: (msg: string) => {
      logger.write(msg)
      log(msg)
    },
    logger
  }
}

/** Aponta pro `RunLogger` da execução em andamento (uma automação por vez no
 * processo inteiro) — permite que os handlers de Pausar/Retomar/Parar (que não
 * têm o `logger` local da execução em mãos) gravem a linha marcadora no
 * arquivo certo. */
let current: RunLogger | null = null

export function setCurrentRunLogger(logger: RunLogger | null): void {
  current = logger
}

export function markCurrentRun(text: string): void {
  current?.marker(text)
}
