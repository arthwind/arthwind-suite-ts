import fs from 'fs'
import os from 'os'
import path from 'path'

interface AppConfigSchema {
  debug: boolean
  theme: string
  lastPaths: Record<string, string>
}

const appData =
  process.env.APPDATA ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'))
const configDir = path.join(appData, 'ArthwindSuite')
const configFile = path.join(configDir, 'config.json')

function loadConfig(): AppConfigSchema {
  try {
    if (fs.existsSync(configFile)) {
      return JSON.parse(fs.readFileSync(configFile, 'utf-8'))
    }
  } catch {}
  return {
    debug: false,
    theme: 'light',
    lastPaths: {},
  }
}

function saveConfig(cfg: Partial<AppConfigSchema>): void {
  try {
    fs.mkdirSync(configDir, { recursive: true })
    const current = loadConfig()
    const updated = { ...current, ...cfg }
    fs.writeFileSync(configFile, JSON.stringify(updated, null, 2), 'utf-8')
  } catch {}
}

export function getDebugMode(): boolean {
  return loadConfig().debug ?? false
}

export function setDebugMode(enabled: boolean): void {
  saveConfig({ debug: enabled })
}

export function getThemeMode(): string {
  return loadConfig().theme || 'light'
}

export function setThemeMode(mode: string): void {
  saveConfig({ theme: mode })
}

export function getLastPaths(): Record<string, string> {
  return loadConfig().lastPaths || {}
}

export function setLastPaths(paths: Record<string, string>): void {
  saveConfig({ lastPaths: paths })
}
