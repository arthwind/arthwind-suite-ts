import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

function loadEnv(): void {
  const candidates: string[] = []
  const appdata = process.env.APPDATA
  if (appdata) {
    candidates.push(path.join(appdata, 'ArthwindSuite', '.env'))
  }

  // Search up to 5 levels parent directories
  let currentDir = __dirname
  for (let i = 0; i < 5; i++) {
    candidates.push(path.join(currentDir, '.env'))
    currentDir = path.dirname(currentDir)
  }

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, 'utf-8')
        for (const line of content.split('\n')) {
          const match = line.match(/^\s*([^#=]+)=(.*)$/)
          if (match) {
            const key = match[1].trim()
            let val = match[2].trim()
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
            if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1)
            process.env[key] = val
          }
        }
        break // Load first env found
      } catch {
        // Ignore error
      }
    }
  }
}

// Erro de CONFIGURAÇÃO da chave (ausente/tamanho inválido) — distinto de "este valor
// específico não é um ciphertext válido". isCiphertext/decryptJson precisam diferenciar
// os dois: o segundo caso é normal e é ignorado silenciosamente (ex.: um campo que já vem
// em texto puro), mas o primeiro é um erro real que precisa aparecer, não ser engolido.
export class CryptoKeyError extends Error {}

class AESCrypto {
  private _key: Buffer | null = null

  private get key(): Buffer {
    if (this._key === null) {
      loadEnv()
      const raw = process.env.ARTHWIND_CRYPTO_KEY || ''
      if (!raw) {
        // Factory default key: '0019900102030405'
        this._key = Buffer.from('0019900102030405', 'utf-8')
      } else {
        const keyBuf = Buffer.from(raw, 'utf-8')
        if (
          keyBuf.length !== 16 &&
          keyBuf.length !== 24 &&
          keyBuf.length !== 32
        ) {
          throw new CryptoKeyError(
            `ARTHWIND_CRYPTO_KEY deve ter 16, 24 ou 32 bytes (AES-128/192/256). Tamanho atual: ${keyBuf.length}`
          )
        }
        this._key = keyBuf
      }
    }
    return this._key
  }

  private getAlgorithm(key: Buffer): string {
    if (key.length === 32) return 'aes-256-ecb'
    if (key.length === 24) return 'aes-192-ecb'
    return 'aes-128-ecb'
  }

  public decrypt(ciphertext: string): string {
    // Base64 URL-safe to standard base64
    let b64 = ciphertext.trim().replace(/-/g, '+').replace(/_/g, '/')
    b64 += '='.repeat((4 - (b64.length % 4)) % 4)

    let ctBytes: Buffer
    try {
      ctBytes = Buffer.from(b64, 'base64')
    } catch (exc: any) {
      throw new Error(`Base64 inválido: ${exc.message}`)
    }

    if (ctBytes.length === 0 || ctBytes.length % 16 !== 0) {
      throw new Error('Tamanho de ciphertext inválido para AES-ECB')
    }

    const alg = this.getAlgorithm(this.key)
    const decipher = crypto.createDecipheriv(alg, this.key, null)
    decipher.setAutoPadding(true)

    let decrypted = decipher.update(ctBytes)
    decrypted = Buffer.concat([decrypted, decipher.final()])
    return decrypted.toString('utf-8')
  }

  public encrypt(plaintext: string): string {
    const alg = this.getAlgorithm(this.key)
    const cipher = crypto.createCipheriv(alg, this.key, null)
    cipher.setAutoPadding(true)

    let encrypted = cipher.update(plaintext, 'utf-8')
    encrypted = Buffer.concat([encrypted, cipher.final()])

    // Standard base64 to Base64 URL-safe
    return encrypted
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
  }

  public isCiphertext(value: string): boolean {
    try {
      this.decrypt(value)
      return true
    } catch (e) {
      if (e instanceof CryptoKeyError) throw e
      return false
    }
  }

  public decryptJson(data: any, skipKeys: string[] = []): any {
    const skip = new Set(skipKeys)

    const walk = (v: any, key?: string): any => {
      if (typeof v === 'string' && (!key || !skip.has(key))) {
        try {
          return this.decrypt(v)
        } catch (e) {
          if (e instanceof CryptoKeyError) throw e
          return v
        }
      }
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) {
          return v.map(item => walk(item))
        } else {
          const res: any = {}
          for (const [k, val] of Object.entries(v)) {
            res[k] = walk(val, k)
          }
          return res
        }
      }
      return v
    }

    return walk(data)
  }

  public encryptJson(data: any, keys: string[]): any {
    const targetKeys = new Set(keys)

    const walk = (v: any, key?: string): any => {
      if (typeof v === 'string' && key && targetKeys.has(key)) {
        return this.encrypt(v)
      }
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) {
          return v.map(item => walk(item))
        } else {
          const res: any = {}
          for (const [k, val] of Object.entries(v)) {
            res[k] = walk(val, k)
          }
          return res
        }
      }
      return v
    }

    return walk(data)
  }

  public loadJson(
    filePath: string,
    skipKeys: string[] = [],
    persistPlaintext: boolean = false
  ): any {
    const content = fs.readFileSync(filePath, 'utf-8')
    const raw = JSON.parse(content)
    const decrypted = this.decryptJson(raw, skipKeys)

    if (persistPlaintext && JSON.stringify(decrypted) !== JSON.stringify(raw)) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(decrypted, null, 2), 'utf-8')
      } catch {
        // Ignore write failure
      }
    }
    return decrypted
  }

  public saveJson(
    data: any,
    filePath: string,
    encryptKeys?: string[],
    indent: number = 2
  ): void {
    const payload = encryptKeys ? this.encryptJson(data, encryptKeys) : data
    fs.writeFileSync(filePath, JSON.stringify(payload, null, indent), 'utf-8')
  }
}

export const cryptoService = new AESCrypto()
export const ENCRYPTED_FIELDS = [
  'blade_sn',
  'blade_position',
  'region',
  'turbine_name',
  'wind_farm',
  'location',
  'gps_latitude',
  'gps_longitude',
  'pixel_size',
  'distance_to_blade',
]
