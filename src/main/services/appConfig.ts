import Store from 'electron-store'
import os from 'os'
import path from 'path'

interface AppConfigSchema {
  debug: boolean
  theme: string
  lastPaths: Record<string, string>
}

// Mesma pasta usada por todos os outros serviços (windfarmConfig.ts,
// bladeSets.ts, runLogger.ts) e pelo config.json legado da era
// Python/pywebview — fixada explicitamente em vez de deixar o electron-store
// derivar do productName ("Arthwind Suite", com espaço), que cairia numa
// pasta %APPDATA% diferente. Como o nome e a pasta são os mesmos do arquivo
// legado, o electron-store já carrega o config.json existente como próprio
// store na primeira leitura — não precisa de migração separada.
const appData =
  process.env.APPDATA ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'))
const configDir = path.join(appData, 'ArthwindSuite')

const store = new Store<AppConfigSchema>({
  name: 'config',
  cwd: configDir,
  defaults: {
    debug: false,
    theme: 'light',
    lastPaths: {}
  }
})

export function getDebugMode(): boolean {
  return store.get('debug')
}

export function setDebugMode(enabled: boolean): void {
  store.set('debug', enabled)
}

export function getThemeMode(): string {
  return store.get('theme')
}

export function setThemeMode(mode: string): void {
  store.set('theme', mode)
}

export function getLastPaths(): Record<string, string> {
  return store.get('lastPaths')
}

export function setLastPaths(paths: Record<string, string>): void {
  store.set('lastPaths', paths)
}
