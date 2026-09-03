import fs from 'fs'
import os from 'os'
import path from 'path'

export type ArthnexEnv = 'production' | 'homolog' | 'local'

export interface ArthnexAuthConfig {
  token: string
  refreshToken?: string
  user?: {
    id: number
    name: string
    email: string
    role?: string
    client_id?: number | null
  }
  environment: ArthnexEnv
  customBackendUrl?: string
}

export interface WorkorderSummary {
  workorders_id: string
  description: string
  client_id: number
  windfarm_id: number
  activity: string
  active: boolean
  client_name: string
  windfarm_local: string
  total_packages?: number
}

export interface TurbineBladeItem {
  windblade_id: number
  wo_package_id: number
  blade: string
  blade_letter: string
  blade_id: number
  blade_model: string
  blade_size: string
  has_gallery: boolean
  is_360: boolean
}

export interface TurbinePackageItem {
  id: number
  workorder_id: string
  turbine_id: number
  turbine: string
  activity?: string
  workorder_description: string
  windfarm_id: number
  is_upload_validated: boolean
  windblades: TurbineBladeItem[]
}

export interface ArthnexDefect {
  id: number
  damage_id: number
  name: string
  severity: number
  status: string
  description?: string
  location?: number
  section?: string
  surface?: string
  side?: string
  coordinates?: string
  gallery_id?: number
  image_url?: string
  is_360?: boolean
  repair_action?: string
  sub_component?: string
  date?: string
}

export interface ArthnexGalleryPicture {
  id: number
  windblade_id: number
  pixel_size_mm?: string | null
  width?: number | null
  height?: number | null
  workorder_id: string
  thumbnail?: boolean | null
  gallery_location?: string | null
  gallery_location_default?: string | null
  picture_order?: number | null
  region?: number
  image_url: string
  created_at?: string | null
}

const DEFAULT_ENDPOINTS: Record<
  ArthnexEnv,
  { backend: string; scheduler: string }
> = {
  production: {
    backend: 'https://backend.arthnex.com/',
    scheduler: 'https://scheduler.arthnex.com/',
  },
  homolog: {
    backend: 'https://backend-homolog.arthnex.com/',
    scheduler: 'https://scheduler-homolog.arthnex.com/',
  },
  local: {
    backend: 'http://localhost:8082/',
    scheduler: 'http://localhost:3333/',
  },
}

const SCHEDULER_API_KEY = '22F9C68C-BC34-46A5-B10F-9E58759C7B95'

export class ArthnexApiService {
  private configPath: string
  private authConfig: ArthnexAuthConfig | null = null

  constructor() {
    const appData =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : path.join(os.homedir(), '.config'))
    const folder = path.join(appData, 'ArthwindSuite')
    fs.mkdirSync(folder, { recursive: true })
    this.configPath = path.join(folder, 'arthnex_auth.json')
    this.loadAuth()
  }

  private loadAuth(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8')
        this.authConfig = JSON.parse(raw)
      }
    } catch {
      this.authConfig = null
    }
  }

  private saveAuth(config: ArthnexAuthConfig | null): void {
    this.authConfig = config
    try {
      if (config) {
        fs.writeFileSync(
          this.configPath,
          JSON.stringify(config, null, 2),
          'utf-8'
        )
      } else if (fs.existsSync(this.configPath)) {
        fs.unlinkSync(this.configPath)
      }
    } catch {
      // ignore
    }
  }

  public getAuth(): ArthnexAuthConfig | null {
    return this.authConfig
  }

  public getEnv(): ArthnexEnv {
    return this.authConfig?.environment || 'production'
  }

  public setEnv(env: ArthnexEnv): void {
    if (this.authConfig) {
      this.authConfig.environment = env
      this.saveAuth(this.authConfig)
    }
  }

  public getBackendBaseUrl(): string {
    if (this.authConfig?.customBackendUrl) {
      return this.authConfig.customBackendUrl.endsWith('/')
        ? this.authConfig.customBackendUrl
        : `${this.authConfig.customBackendUrl}/`
    }
    const env = this.getEnv()
    return DEFAULT_ENDPOINTS[env].backend
  }

  public getSchedulerBaseUrl(): string {
    const env = this.getEnv()
    return DEFAULT_ENDPOINTS[env].scheduler
  }

  public async ensureFreshToken(): Promise<string | null> {
    this.loadAuth()
    if (!this.authConfig?.token) return null

    let isExpiring = false
    try {
      const parts = this.authConfig.token.split('.')
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1], 'base64').toString('utf-8')
        )
        if (payload.exp && Date.now() >= (payload.exp - 60) * 1000) {
          isExpiring = true
        }
      }
    } catch {
      isExpiring = false
    }

    if (isExpiring && this.authConfig.refreshToken) {
      const refreshed = await this.refreshAccessToken()
      if (refreshed) return this.authConfig.token
    }

    return this.authConfig.token
  }

  public async refreshAccessToken(): Promise<boolean> {
    this.loadAuth()
    if (!this.authConfig?.refreshToken) return false
    const baseUrl = this.getBackendBaseUrl()

    try {
      const resp = await fetch(`${baseUrl}auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.authConfig.refreshToken }),
      })

      if (resp.ok) {
        const data = await resp.json()
        const token = data.token || data.access_token
        const refreshToken =
          data.refreshToken ||
          data.refresh_token ||
          this.authConfig.refreshToken
        if (token) {
          this.setDirectToken(token, refreshToken, this.authConfig.environment)
          return true
        }
      }
    } catch (err) {
      console.warn('Falha ao renovar token JWT do Arthnex:', err)
    }
    return false
  }

  private async getAuthHeadersAsync(): Promise<HeadersInit> {
    await this.ensureFreshToken()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.authConfig?.token) {
      headers.Authorization = `Bearer ${this.authConfig.token}`
    }
    return headers
  }

  private getAuthHeaders(): HeadersInit {
    this.loadAuth()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.authConfig?.token) {
      headers.Authorization = `Bearer ${this.authConfig.token}`
    }
    return headers
  }

  /**
   * Realiza login no backend do Arthnex e armazena o token
   */
  public async login(
    email: string,
    pass: string,
    environment: ArthnexEnv = 'production'
  ): Promise<{
    success: boolean
    user?: any
    mfa_required?: boolean
    temp_token?: string
    error?: string
  }> {
    const env = environment || 'production'
    const baseUrl = DEFAULT_ENDPOINTS[env].backend

    try {
      const resp = await fetch(`${baseUrl}auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass }),
      })

      if (!resp.ok) {
        const errJson = await resp.json().catch(() => null)
        return {
          success: false,
          error:
            errJson?.message || `Erro de autenticação (HTTP ${resp.status})`,
        }
      }

      const data = await resp.json()

      if (data.mfa_required) {
        return {
          success: true,
          mfa_required: true,
          temp_token: data.temp_token,
        }
      }

      const token = data.token || data.access_token
      const refreshToken = data.refresh_token || data.refreshToken
      const user = data.user

      if (!token) {
        return { success: false, error: 'Token não retornado pelo servidor.' }
      }

      this.saveAuth({
        token,
        refreshToken,
        user,
        environment: env,
      })

      return { success: true, user }
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Falha de conexão com o servidor',
      }
    }
  }

  /**
   * Valida o código 2FA enviado por e-mail/SMS
   */
  public async verifyMfa(
    code: string,
    tempToken: string,
    environment: ArthnexEnv = 'production'
  ): Promise<{ success: boolean; user?: any; error?: string }> {
    const env = environment || 'production'
    const baseUrl = DEFAULT_ENDPOINTS[env].backend

    try {
      const resp = await fetch(`${baseUrl}auth/mfa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), temp_token: tempToken }),
      })

      if (!resp.ok) {
        const errJson = await resp.json().catch(() => null)
        return {
          success: false,
          error:
            errJson?.message || `Código 2FA inválido (HTTP ${resp.status})`,
        }
      }

      const data = await resp.json()
      const token = data.token || data.access_token
      const refreshToken = data.refresh_token || data.refreshToken
      const user = data.user

      if (!token) {
        return {
          success: false,
          error: 'Token não retornado após verificação 2FA.',
        }
      }

      this.saveAuth({
        token,
        refreshToken,
        user,
        environment: env,
      })

      return { success: true, user }
    } catch (err: any) {
      return { success: false, error: err.message || 'Falha ao validar 2FA' }
    }
  }

  /**
   * Salva um token JWT diretamente (ex: colado pelo usuário ou capturado pelo Google OAuth)
   */
  public setDirectToken(
    token: string,
    refreshToken?: string,
    env: ArthnexEnv = 'production'
  ): void {
    let user: any = undefined
    try {
      const parts = token.split('.')
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1], 'base64').toString('utf-8')
        )
        user = {
          id: payload.id,
          name: payload.name,
          email: payload.email || '',
          role: payload.user_type_name,
          client_id: payload.client_id,
        }
      }
    } catch {
      // ignore
    }

    this.saveAuth({
      token: token.trim(),
      refreshToken: refreshToken?.trim(),
      user,
      environment: env,
    })
  }

  /**
   * Encerra a sessão local
   */
  public logout(): void {
    this.saveAuth(null)
  }

  /**
   * Lista Ordens de Serviço disponíveis
   */
  public async getWorkorders(
    search = '',
    page = 1,
    limit = 500
  ): Promise<WorkorderSummary[]> {
    const baseUrl = this.getBackendBaseUrl()
    const query = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      pageSize: String(limit),
    })
    if (search) query.append('search', search)

    try {
      const resp = await fetch(`${baseUrl}upload?${query.toString()}`, {
        headers: this.getAuthHeaders(),
      })

      if (resp.ok) {
        const json = await resp.json()
        const list =
          json.data || json.workorders || (Array.isArray(json) ? json : [])
        return list.map((item: any) => ({
          id: item.workorders_id || item.id,
          workorders_id: item.workorders_id || item.id,
          description:
            item.description || item.workorder_description || item.id || '',
          client_id: item.client_id || 0,
          windfarm_id: item.windfarm_id || 0,
          activity: item.activity || '',
          active: item.active ?? true,
          client_name: item.client_name || item.name || '',
          windfarm_local: item.windfarm_local || item.local || '',
        }))
      }
    } catch {
      // fallback
    }

    // Fallback: busca do scheduler caso o backend JWT não esteja logado
    const schedulerUrl = `${this.getSchedulerBaseUrl()}get-active-workorders`
    const schedResp = await fetch(schedulerUrl, {
      headers: { 'x-api-key': SCHEDULER_API_KEY },
    })
    if (!schedResp.ok)
      throw new Error(`HTTP ${schedResp.status} ao listar O.S.`)
    const rawList = await schedResp.json()
    return (rawList || []).map((item: any) => ({
      id: item.workorders_id || item.id,
      workorders_id: item.workorders_id || item.id,
      description:
        item.description || item.workorder_description || item.id || '',
      client_id: item.client_id || 0,
      windfarm_id: item.windfarm_id || 0,
      activity: item.activity || '',
      active: true,
      client_name: item.client_name || item.name || '',
      windfarm_local: item.windfarm_local || item.local || '',
    }))
  }

  /**
   * Obtém a hierarquia de Turbinas e Pás de uma Workorder
   */
  public async getTurbinesAndBladesByWo(
    woId: string,
    windfarmId?: number
  ): Promise<TurbinePackageItem[]> {
    const baseUrl = this.getBackendBaseUrl()

    // 1. Tenta buscar via damages-management (onde ficam as inspeções e defeitos de todas as turbinas)
    if (windfarmId) {
      try {
        const headers = await this.getAuthHeadersAsync()
        const dmUrl = `${baseUrl}damages-management/turbines-by-workorder-windfarm/${woId}/${windfarmId}/false?page=1&pageSize=500`
        const dmResp = await fetch(dmUrl, { headers })
        if (dmResp.ok) {
          const dmJson = await dmResp.json()
          const turbinesList =
            dmJson.data ||
            dmJson.turbines ||
            (Array.isArray(dmJson) ? dmJson : [])
          if (Array.isArray(turbinesList) && turbinesList.length > 0) {
            return turbinesList.map((t: any) => ({
              id: Number(t.id || t.turbine_id),
              turbine_id: Number(t.id || t.turbine_id),
              turbine: t.turbine || `WTG_${t.id}`,
              workorder_id: woId,
              workorder_description: '',
              windfarm_id: windfarmId,
              is_upload_validated: false,
              windblades: (t.blades || []).map((b: any) => ({
                windblade_id: Number(b.id || b.windblade_id),
                wo_package_id: Number(
                  b.wo_package?.id || b.wo_package_id || b.id
                ),
                blade: b.blade || '',
                blade_letter: b.blade_letter || '',
                blade_id: Number(b.id || b.windblade_id),
                blade_model: b.blade_model || '',
                blade_size: b.blade_size || '',
                has_gallery: true,
                is_360: false,
              })),
            }))
          }
        }
      } catch {
        // segue para os outros métodos
      }
    }

    // 2. Tenta buscar via upload/turbines-blades
    try {
      const headers = await this.getAuthHeadersAsync()
      const resp = await fetch(
        `${baseUrl}upload/turbines-blades/${woId}?page=1&limit=500`,
        {
          headers,
        }
      )
      if (resp.ok) {
        const json = await resp.json()
        if (json.data && Array.isArray(json.data) && json.data.length > 0) {
          return json.data as TurbinePackageItem[]
        }
      }
    } catch {
      // fallback
    }

    // 3. Fallback scheduler
    try {
      const schedulerUrl = `${this.getSchedulerBaseUrl()}get-blades-pending-by-wo-packages/${woId}`
      const schedResp = await fetch(schedulerUrl, {
        headers: { 'x-api-key': SCHEDULER_API_KEY },
      })
      if (schedResp.ok) {
        const rawData = await schedResp.json()
        const map = new Map<number, TurbinePackageItem>()
        for (const item of rawData || []) {
          const tId = item.turbine_id || item.turbines?.id || 0
          if (!map.has(tId)) {
            map.set(tId, {
              id: item.id || 0,
              workorder_id: woId,
              turbine_id: tId,
              turbine: item.turbine || item.turbines?.turbine || `WTG_${tId}`,
              workorder_description: '',
              windfarm_id: item.windfarm_id || 0,
              is_upload_validated: false,
              windblades: [],
            })
          }
          const pkg = map.get(tId)!
          pkg.windblades.push({
            windblade_id: item.windblade_id || item.windblade?.id || item.id,
            wo_package_id: item.wo_package_id || item.id,
            blade: item.blade || item.windblade?.blade || '',
            blade_letter:
              item.blade_letter || item.windblade?.blade_letter || '',
            blade_id: item.windblade_id || item.windblade?.id || item.id,
            blade_model:
              item.blade_model ||
              item.windblade?.blade_model?.blade_model ||
              '',
            blade_size:
              item.blade_size || item.windblade?.blade_model?.blade_size || '',
            has_gallery: item.has_gallery ?? false,
            is_360: item.is_360 ?? false,
          })
        }
        if (map.size > 0) {
          return Array.from(map.values())
        }
      }
    } catch {
      // fallback
    }

    return []
  }

  /**
   * Busca defeitos auditados de uma pá para preenchimento no ServiceNow (SNOW)
   */
  public async getDefectsByBlade(params: {
    workorderId: string
    windfarmId: number
    turbineId: number
    windbladeId: number
  }): Promise<ArthnexDefect[]> {
    const { workorderId, windfarmId, turbineId, windbladeId } = params
    const baseUrl = this.getBackendBaseUrl()

    const url = `${baseUrl}damages-management/defects-by-workorder/${workorderId}/${windfarmId}/${turbineId}/${windbladeId}?page=1&pageSize=500`
    let headers = await this.getAuthHeadersAsync()
    let resp = await fetch(url, { headers })

    if (resp.status === 401) {
      const refreshed = await this.refreshAccessToken()
      if (refreshed) {
        headers = await this.getAuthHeadersAsync()
        resp = await fetch(url, { headers })
      }
    }

    if (!resp.ok) {
      throw new Error(
        `HTTP ${resp.status} ao consultar defeitos da pá ${windbladeId}`
      )
    }

    const json = await resp.json()
    const rawDefects =
      json.data || json.defects || (Array.isArray(json) ? json : [])

    return rawDefects.map((d: any) => ({
      id: d.id || d.defect_id,
      damage_id: d.damage?.id || d.defect_id || d.id,
      name:
        d.damage?.description ||
        d.name ||
        d.defect_name ||
        d.failure_type ||
        'Defeito',
      severity: Number(d.severity || d.degree || 1),
      status: d.status ? 'Resolved' : 'Active',
      description: d.comment || d.description || d.damage?.description || '',
      location: Number(d.location || 0),
      section: d.section || '',
      surface: d.surface || 'Outside',
      side: d.section_side || d.side || '',
      coordinates:
        typeof d.polygon === 'string'
          ? d.polygon
          : JSON.stringify(d.polygon || d.coordinates || []),
      gallery_id: d.gallery_id,
      image_url: d.image_url || d.url || '',
      is_360: Boolean(d.is_360),
      repair_action: d.recommendation?.name || d.repair_action || '',
      sub_component: d.component_name || d.sub_component || '',
      layer: d.layer?.layer || '',
      date: d.date || '',
    }))
  }

  /**
   * Busca todas as fotos da galeria de inspeção de uma pá
   */
  public async getPicturesByBlade(
    woId: string,
    windbladeId: number
  ): Promise<ArthnexGalleryPicture[]> {
    const baseUrl = this.getBackendBaseUrl()
    const url = `${baseUrl}upload/pictures?woId=${woId}&windbladeId=${windbladeId}`
    let headers = await this.getAuthHeadersAsync()
    let resp = await fetch(url, { headers })

    if (resp.status === 401) {
      const refreshed = await this.refreshAccessToken()
      if (refreshed) {
        headers = await this.getAuthHeadersAsync()
        resp = await fetch(url, { headers })
      }
    }

    if (!resp.ok) {
      return []
    }

    const json = await resp.json()
    return (json.pictures || []) as ArthnexGalleryPicture[]
  }

  /**
   * Busca a data real de coleta de fotos no campo (colletion_date_photos_turbine)
   */
  public async getCollectDate(
    turbineId: number | string,
    woId: string,
    windbladeId: number | string
  ): Promise<string | null> {
    const baseUrl = this.getBackendBaseUrl()
    const url = `${baseUrl}upload/collect-date/${turbineId}/${woId}/${windbladeId}`
    let headers = await this.getAuthHeadersAsync()
    let resp = await fetch(url, { headers })

    if (resp.status === 401) {
      const refreshed = await this.refreshAccessToken()
      if (refreshed) {
        headers = await this.getAuthHeadersAsync()
        resp = await fetch(url, { headers })
      }
    }

    if (!resp.ok) return null
    try {
      const json = await resp.json()
      return json?.date_photo || null
    } catch {
      return null
    }
  }

  /**
   * Lista eventos de operações / diárias com suporte a busca por turbina ou workorder
   */
  public async getOperationEvents(
    search = '',
    page = 1,
    pageSize = 50
  ): Promise<{ total: number; data: any[] }> {
    const baseUrl = this.getBackendBaseUrl()
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    })
    if (search) query.append('search', search)

    const url = `${baseUrl}operation-events?${query.toString()}`
    let headers = await this.getAuthHeadersAsync()
    let resp = await fetch(url, { headers })

    if (resp.status === 401) {
      const refreshed = await this.refreshAccessToken()
      if (refreshed) {
        headers = await this.getAuthHeadersAsync()
        resp = await fetch(url, { headers })
      }
    }

    if (!resp.ok) {
      return { total: 0, data: [] }
    }

    const json = await resp.json()
    return {
      total: json.total || (Array.isArray(json) ? json.length : 0),
      data: json.data || (Array.isArray(json) ? json : []),
    }
  }

  /**
   * Obtém os detalhes completos de uma operação pelo ID
   */
  public async getOperationById(id: number | string): Promise<any | null> {
    const baseUrl = this.getBackendBaseUrl()
    const url = `${baseUrl}operation-events/${id}`
    let headers = await this.getAuthHeadersAsync()
    let resp = await fetch(url, { headers })

    if (resp.status === 401) {
      const refreshed = await this.refreshAccessToken()
      if (refreshed) {
        headers = await this.getAuthHeadersAsync()
        resp = await fetch(url, { headers })
      }
    }

    if (!resp.ok) return null
    return await resp.json()
  }

  /**
   * Busca automaticamente o técnico e a data de inspeção de uma turbina
   */
  public async getTechnicianAndDateByTurbine(
    turbineName: string,
    woId?: string
  ): Promise<{
    technician: string
    date: string
    leader: string
    technicians: string[]
  }> {
    const defaultResult = {
      technician: '',
      date: '',
      leader: 'ALLAN THIAGO',
      technicians: [] as string[],
    }

    try {
      const res = await this.getOperationEvents(turbineName, 1, 10)
      let ops = res.data || []

      if (woId && ops.length > 0) {
        const filtered = ops.filter((o: any) =>
          String(
            o.workorder?.description || o.workorder_id || o.workorder?.id || ''
          ).includes(woId)
        )
        if (filtered.length > 0) ops = filtered
      }

      if (ops.length === 0 && woId) {
        const woRes = await this.getOperationEvents(woId, 1, 50)
        ops = woRes.data || []
      }

      if (ops.length === 0) return defaultResult

      const targetOpSummary = ops[0]
      const detailedOp =
        (await this.getOperationById(targetOpSummary.id)) || targetOpSummary

      const techs = (detailedOp.technicians || [])
        .map((t: any) => t.name || t.technician_name || String(t))
        .filter(Boolean)
      const dateRaw = detailedOp.date || targetOpSummary.date || ''

      let formattedDate = dateRaw
      if (dateRaw && /^\d{4}-\d{2}-\d{2}/.test(dateRaw)) {
        const [y, m, d] = dateRaw.split('T')[0].split('-')
        formattedDate = `${d}/${m}/${y}`
      }

      return {
        technician: techs[0] || '',
        date: formattedDate,
        leader: 'ALLAN THIAGO',
        technicians: techs,
      }
    } catch {
      return defaultResult
    }
  }
}

export const arthnexApi = new ArthnexApiService()
