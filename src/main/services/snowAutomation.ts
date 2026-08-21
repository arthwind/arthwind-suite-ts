/**
 * Automação de preenchimento do "Create Damage Report Entry" no ServiceNow (SNOW),
 * a partir da planilha já gerada pelo SNOW Processor (snowProcessor.ts).
 *
 * Os campos do formulário NÃO são <select> nativos — são um widget de combobox
 * custom do ServiceNow (clica pra abrir, filtra numa caixa de busca, clica na
 * opção exata da lista). `selectFromComboBox` cobre esse padrão.
 *
 * Sessão de login: usa um perfil de navegador PERSISTENTE (launchPersistentContext),
 * salvo em %APPDATA%/ArthwindSuite/snow_browser_profile — login feito manualmente
 * uma vez em `openServiceNowForLogin` continua valendo nas próximas rodadas, sem
 * precisar logar de novo a cada execução.
 */
import { chromium, BrowserContext, Page } from 'playwright'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import path from 'path'
import fs from 'fs'
import os from 'os'
import https from 'https'
import http from 'http'
import sharp from 'sharp'
import { SnowMappings } from './snowProcessor'
import { getBladesForTurbine } from './bladeSets'
import { getWindfarmConfig } from './windfarmConfig'
import { checkpoint, AutomationStoppedError } from './automationControl'
import { registerTab } from './tabRegistry'

export interface DamageReportRow {
  bladeSerialNumber: string // serial completo (13 dígitos) — bate com o combobox
  subComponent: string // termo de busca no dropdown "Sub Component"
  failureType: string // termo de busca no dropdown "Failure Type"
  damageDescription: string
  dfDistanceStart: number
  dfDistanceEnd: number
  profileDepthStart: number | string
  profileDepthEnd: number | string
  insideOutside: string
  bladeSection: string
  bladeSubSection: string
  bladeArea: string
  sizeMm: number
  amountOfFindings: number // sempre 1
  photoUrls: string[] // 1+ fotos — sobem numeradas 01_/02_/... (form pede isso pra sequência)
  isBlankImage?: boolean
  excelRowIndex: number // linha (1-based) na planilha original
}


type LogFn = (msg: string) => void

function isVideoFile(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.avi') || lower.endsWith('.mkv')
}

function profileDir(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), '.config')
  const dir = path.join(appData, 'ArthwindSuite', 'snow_browser_profile')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

let sharedContext: BrowserContext | null = null

async function getContext(headless: boolean): Promise<BrowserContext> {
  if (sharedContext) return sharedContext
  sharedContext = await chromium.launchPersistentContext(profileDir(), {
    headless,
    // 1920x991, não 1920x1080 — medido de verdade abrindo um Chromium maximizado
    // numa tela 1920x1080 (window.innerWidth/innerHeight): a área de conteúdo real é
    // 89px menor em altura, ocupados pela barra de título + abas + barra de endereço
    // do próprio navegador. Usar 1920x1080 deixava sobrando espaço em branco embaixo
    // (a página "sobrava" da janela de verdade).
    viewport: { width: 1920, height: 991 }
  })
  return sharedContext
}

/** Abre um Chrome visível pra login manual — o perfil persistente guarda a sessão,
 * então isso só precisa ser feito de novo quando a sessão expirar de verdade. */
export async function openServiceNowForLogin(
  url: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const context = await getContext(false)
    const page = context.pages()[0] || (await context.newPage())
    await page.bringToFront()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

export async function closeServiceNowSession(): Promise<{ success: boolean }> {
  if (sharedContext) {
    await sharedContext.close().catch(() => {})
    sharedContext = null
  }
  return { success: true }
}

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    lib
      .get(url, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
      .on('error', reject)
  })
}

export async function ensureBlankImageFile(localPhotosDir?: string): Promise<string> {
  if (localPhotosDir && fs.existsSync(localPhotosDir)) {
    const candidates = ['Blank Image.jpg', 'blank_image.jpg', 'Blank Image.jpeg', 'blank.jpg']
    for (const cand of candidates) {
      const p = path.join(localPhotosDir, cand)
      if (fs.existsSync(p)) return p
    }
  }

  const dst = path.join(os.tmpdir(), 'Blank Image.jpg')
  if (!fs.existsSync(dst)) {
    try {
      await sharp({
        create: {
          width: 800,
          height: 600,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).jpeg({ quality: 80 }).toFile(dst)
    } catch {}
  }
  return dst
}

// ─── Preenchimento do formulário ─────────────────────────────────────────────

/** Base compartilhada entre todo formulário do ServiceNow que a automação preenche
 * (Create Damage Report Entry, Create Inspection Report, ...) — o widget de
 * combobox custom (Select2/sn-select), campo de texto por label e checkbox por
 * label se comportam do mesmo jeito nos dois formulários; só os campos em si e o
 * que fazer com eles muda por formulário. Extraída de `DamageEntryFiller` (era só
 * dele até a automação do Inspection Report existir). */
class ServiceNowFormFiller {
  constructor(
    protected page: Page,
    protected log: LogFn
  ) {}

  /** Retorna a página principal ou o iframe gsft_main do ServiceNow se ele existir */
  protected getScope() {
    const mainFrame = this.page.frames().find((f) => f.name() === 'gsft_main' || f.url().includes('.do'))
    return mainFrame || this.page
  }

  /** Lê o valor atual de um campo de texto pelo label — contraparte de leitura do
   * `fillText`, usada pra CONFERIR (não preencher) se o que está salvo na tela bate
   * com o que devia ter sido preenchido. */
  protected async readTextValue(fieldLabel: string): Promise<string> {
    const scope = this.getScope()
    const locators = [
      scope.getByLabel(fieldLabel, { exact: false }).first(),
      scope.locator(`textarea[aria-label*="${fieldLabel}"], input[aria-label*="${fieldLabel}"]`).first()
    ]
    for (const field of locators) {
      try {
        if (await field.isVisible({ timeout: 2000 }).catch(() => false)) {
          return ((await field.inputValue().catch(() => '')) || '').trim()
        }
      } catch {}
    }
    return ''
  }

  /** Lê o texto atualmente mostrado no container visível do combobox (o que ficou
   * selecionado) — usada por `selectFromComboBox` pra CONFERIR se o clique realmente
   * selecionou o valor certo, em vez de assumir que "clicou em algo" = "selecionou o
   * valor certo". */
  protected async readComboBoxValue(fieldLabel: string): Promise<string> {
    const scope = this.getScope()
    const candidates = [
      scope.locator('.select2-container').filter({ has: scope.getByText(fieldLabel, { exact: false }) }).locator('.select2-chosen, .select2-choice').first(),
      scope.locator('div.form-group', { hasText: fieldLabel }).locator('.select2-chosen, .select2-choice').first(),
      scope.locator('.form-group, .sc-form-field').filter({ hasText: fieldLabel }).locator('.select2-chosen, .select2-choice').first()
    ]
    for (const c of candidates) {
      const visible = await c.isVisible({ timeout: 800 }).catch(() => false)
      if (!visible) continue
      const text = ((await c.textContent().catch(() => '')) || '').trim()
      if (text) return text
    }
    return ''
  }

  /** Widget de combobox custom do ServiceNow (Select2 / sn-select) — clica pra
   * abrir, filtra pela caixa de busca se ela aparecer, clica na opção com fallbacks.
   *
   * IMPORTANTE (bug real, achado conferindo manualmente o ServiceNow): um clique que
   * "pareceu" funcionar (nenhum erro, nenhuma exceção) podia na verdade não ter
   * selecionado NADA — se nenhum candidato batesse de verdade, o código antigo só
   * seguia em frente silenciosamente, deixando o campo com o que já estivesse
   * selecionado ali antes (ex.: um valor que o próprio ServiceNow lembra da sessão).
   * Isso gerou defeito cadastrado na PÁ ERRADA (0549 em vez de 0548) sem nenhum aviso
   * — só foi descoberto conferindo manualmente a tabela depois. Por isso agora, depois
   * de clicar, LÊ DE VOLTA o que ficou selecionado e compara com o que devia ser; se
   * não bater, tenta mais uma vez do zero, e se ainda assim não bater, FALHA a linha
   * com um erro claro em vez de seguir preenchendo com dado errado. */
  protected async selectFromComboBox(
    fieldLabel: string,
    optionText: string,
    waitAfterMs: number = 600
  ): Promise<void> {
    if (!optionText) return
    const scope = this.getScope()

    const attemptOnce = async (): Promise<void> => {
      // No Select2 do ServiceNow, o elemento de foco (.select2-focusser) fica sob o container visível (<a class="select2-choice">).
      // O clique direto no focusser causa "intercepts pointer events". Usar { force: true } no container visível resolve 100%.
      let opened = false

      // 1. Tentar localizar o container visível do Select2 associado à label
      const openCandidates = [
        scope.locator('.select2-container').filter({ has: scope.getByText(fieldLabel, { exact: false }) }).locator('.select2-choice').first(),
        scope.locator('div.form-group', { hasText: fieldLabel }).locator('.select2-choice, .select2-container').first(),
        scope.locator('.form-group, .sc-form-field').filter({ hasText: fieldLabel }).locator('.select2-choice').first(),
        scope.locator('.select2-choice').first(),
        scope.getByRole('combobox', { name: fieldLabel }).first(),
        scope.getByLabel(fieldLabel, { exact: false }).first()
      ]

      for (const candidate of openCandidates) {
        try {
          if (await candidate.isVisible({ timeout: 1200 }).catch(() => false)) {
            await candidate.click({ force: true })
            opened = true
            break
          }
        } catch {
          /* tenta próximo */
        }
      }

      if (!opened) {
        await scope.getByLabel(fieldLabel, { exact: false }).first().click({ force: true }).catch(() => {})
      }

      await this.page.waitForTimeout(300)

      // 2. Tenta digitar na caixa de busca do Select2 se aparecer (.select2-input)
      const searchBox = scope
        .locator('.select2-input, input.select2-search, input[role="combobox"]')
        .last()
        .or(scope.getByRole('textbox').last())

      if (await searchBox.isVisible({ timeout: 1500 }).catch(() => false)) {
        await searchBox.fill(optionText)
        await this.page.waitForTimeout(400) // tempo pro Select2 filtrar as opções no DOM
      }

      // 3. Seletores em cascata de fallback pra cobrir a estrutura Select2 e papéis ARIA do ServiceNow
      const optionLocators = [
        scope.locator('.select2-result-label', { hasText: optionText }).first(),
        scope.locator('li.select2-result', { hasText: optionText }).first(),
        scope.locator('.select2-results li', { hasText: optionText }).first(),
        scope.getByRole('option', { name: optionText, exact: true }).first(),
        scope.getByRole('option', { name: optionText }).first(),
        scope.locator('li', { hasText: optionText }).first(),
        scope.locator('div', { hasText: optionText }).first(),
        scope.getByText(optionText, { exact: true }).first()
      ]

      let selected = false
      for (const locator of optionLocators) {
        try {
          if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
            await locator.click({ force: true })
            selected = true
            break
          }
        } catch {
          /* tenta próximo seletor */
        }
      }

      if (!selected) {
        // Tenta um clique forçado caso o elemento esteja oculto por overlay
        await scope.getByText(optionText, { exact: true }).first().click({ force: true }).catch(() => {})
      }

      // Aguarda a reação/cascata client-side do ServiceNow para popular os campos dependentes (ex: Sub Component -> Failure Type)
      await this.page.waitForTimeout(waitAfterMs)
    }

    const matches = (current: string): boolean => {
      if (!current) return false
      const a = current.trim().toLowerCase()
      const b = optionText.trim().toLowerCase()
      return a.includes(b) || b.includes(a)
    }

    // Lê o valor duas vezes, com um intervalo entre elas, e só aceita se as DUAS
    // baterem com o esperado — uma leitura só corria risco de condição de corrida: o
    // valor podia estar certo no instante da leitura e mudar logo depois (script
    // client do ServiceNow, re-render do Select2, cascata de outro campo), sob carga
    // (várias abas concorrentes). Achado em teste real: campo "Blade serial number"
    // lido como correto uma vez, mas o valor final no formulário era outra pá — a
    // verificação de leitura única não pegava isso.
    const readStable = async (): Promise<string> => {
      const first = await this.readComboBoxValue(fieldLabel)
      await this.page.waitForTimeout(600)
      const second = await this.readComboBoxValue(fieldLabel)
      return matches2(first, second) ? second : ''
    }
    const matches2 = (a: string, b: string): boolean => {
      const na = a.trim().toLowerCase()
      const nb = b.trim().toLowerCase()
      return !!na && !!nb && (na.includes(nb) || nb.includes(na))
    }

    this.log(`    Selecionando [${fieldLabel}]: "${optionText}"`)
    await attemptOnce()

    let current = await readStable()
    if (!matches(current)) {
      this.log(`  ⚠ [${fieldLabel}] Seleção não confirmada/estável (queria "${optionText}", ficou "${current || '(vazio/instável)'}") — tentando de novo...`)
      await attemptOnce()
      current = await readStable()
    }

    if (!matches(current)) {
      throw new Error(
        `Falha ao selecionar [${fieldLabel}] = "${optionText}" — mesmo após retentativa, o campo ficou com "${current || '(vazio/instável)'}". Linha abortada pra não cadastrar dado errado.`
      )
    }
  }

  protected async fillText(fieldLabel: string, value: string | number): Promise<void> {
    const scope = this.getScope()
    const locators = [
      scope.getByLabel(fieldLabel, { exact: false }).first(),
      scope.locator(`textarea[aria-label*="${fieldLabel}"], input[aria-label*="${fieldLabel}"]`).first(),
      scope.locator(`div.form-group:has-text("${fieldLabel}") textarea, div.form-group:has-text("${fieldLabel}") input`).first()
    ]

    for (const field of locators) {
      try {
        if (await field.isVisible({ timeout: 3000 }).catch(() => false)) {
          await field.fill(String(value))
          return
        }
      } catch {}
    }

    const primary = scope.getByLabel(fieldLabel, { exact: false }).first()
    await primary.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    await primary.fill(String(value)).catch(() => {})
  }

  /** Marca/desmarca um checkbox pelo texto do label — mesmo padrão já usado em
   * `addOptionalFields` pro checkbox "Set Optional Fields", generalizado. Não faz
   * nada se já estiver no estado pedido (evita clique duplo que às vezes reabre um
   * painel client-side do ServiceNow). */
  protected async setCheckbox(fieldLabel: string, checked: boolean = true): Promise<void> {
    const scope = this.getScope()
    const checkbox = scope
      .locator('label', { hasText: fieldLabel })
      .locator('input[type="checkbox"]')
      .or(scope.getByLabel(fieldLabel, { exact: false }))
      .first()

    const visible = await checkbox.isVisible({ timeout: 2000 }).catch(() => false)
    if (!visible) {
      this.log(`  ⚠ Checkbox [${fieldLabel}] não encontrado — pulando.`)
      return
    }

    const isChecked = await checkbox.isChecked().catch(() => false)
    if (isChecked === checked) return

    if (checked) {
      await checkbox.check({ force: true }).catch(async () => {
        await checkbox.click({ force: true })
      })
    } else {
      await checkbox.uncheck({ force: true }).catch(async () => {
        await checkbox.click({ force: true })
      })
    }
    this.log(`  ${checked ? '✓' : '·'} Checkbox [${fieldLabel}] ${checked ? 'marcado' : 'desmarcado'}.`)
  }

  /** Clica no botão de submissão do formulário (Submit/Save/Insert, PT ou EN) —
   * mesma cascata de seletores que já era usada só dentro de `DamageEntryFiller.fill`,
   * generalizada pra qualquer formulário. Devolve se achou e clicou em algum botão. */
  protected async submitForm(): Promise<boolean> {
    const scope = this.getScope()
    const submitBtnLocators = [
      scope.getByRole('button', { name: /^submit$/i }),
      scope.getByRole('button', { name: /^save$/i }),
      scope.getByRole('button', { name: /^insert$/i }),
      scope.getByRole('button', { name: /^salvar$/i }),
      scope.getByRole('button', { name: /submit|insert|salvar|gravar/i })
    ]

    for (const btn of submitBtnLocators) {
      try {
        if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await btn.click()
          return true
        }
      } catch {
        /* tenta próximo */
      }
    }

    const fallback = scope.getByRole('button', { name: /submit|save|insert|salvar/i }).first()
    if (await fallback.isVisible({ timeout: 1000 }).catch(() => false)) {
      await fallback.click()
      return true
    }
    return false
  }
}

class DamageEntryFiller extends ServiceNowFormFiller {
  private buildPhotoBaseName(data: DamageReportRow): string {
    const shortSn = extractBladeSn(data.bladeSerialNumber)
    const paddedBladeSn = String(shortSn).replace(/^B/i, '').padStart(4, '0')
    const bladeCode = `B${paddedBladeSn}`

    const areaCode = SnowMappings.areaToFileCode(data.bladeArea)

    let secCode = 'S1'
    if (data.bladeSection === 'Section 2') secCode = 'S2'
    else if (data.bladeSection === 'Section 3') secCode = 'S3'
    else if (data.bladeSection.match(/^Section\s*(\d+)$/i)) {
      const match = data.bladeSection.match(/^Section\s*(\d+)$/i)
      if (match) secCode = `S${match[1]}`
    } else if (data.bladeSection.match(/^S\d+$/i)) {
      secCode = data.bladeSection.toUpperCase()
    }

    return `${bladeCode}_${secCode}_${areaCode}_DF${data.dfDistanceStart}-${data.dfDistanceEnd}`
  }

  /** Espera o upload de um arquivo (tipicamente vídeo) terminar de verdade no
   * ServiceNow, verificando periodicamente se o nome do arquivo já apareceu na
   * lista de anexos, em vez de um `waitForTimeout` fixo que não sabe quanto
   * tempo o upload de fato leva. Se o timeout estourar sem confirmação, segue
   * em frente mesmo assim (mesma filosofia de degradação graciosa do resto do
   * arquivo) — só loga o aviso. */
  private async waitForAttachmentUploaded(
    scope: ReturnType<DamageEntryFiller['getScope']>,
    fileName: string,
    timeoutMs: number = 180000
  ): Promise<void> {
    const pollIntervalMs = 1000
    const logEveryMs = 15000
    const start = Date.now()
    let lastLog = start
    this.log(`  ⏳ Enviando vídeo (${fileName})... isso pode levar alguns minutos.`)
    while (Date.now() - start < timeoutMs) {
      const appeared = await scope
        .getByText(fileName, { exact: false })
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
      if (appeared) {
        this.log(`  ✓ Upload do vídeo (${fileName}) concluído em ${Math.round((Date.now() - start) / 1000)}s.`)
        return
      }
      if (Date.now() - lastLog >= logEveryMs) {
        lastLog = Date.now()
        this.log(`  ⏳ Ainda enviando o vídeo (${fileName})... (${Math.round((Date.now() - start) / 1000)}s)`)
      }
      await this.page.waitForTimeout(pollIntervalMs)
    }
    this.log(`  ⚠ Não foi possível confirmar o fim do upload do vídeo (${fileName}) em ${Math.round(timeoutMs / 1000)}s — seguindo mesmo assim.`)
  }

  private async uploadPhotos(
    data: DamageReportRow,
    localPhotoFiles: string[] = [],
    waitForVideoUpload: boolean = true
  ): Promise<void> {
    const tempPaths: string[] = []

    try {
      if (data.isBlankImage) {
        // Blank Image é só 1 foto (não par pic1/pic2 como um defeito normal) — o
        // usuário apontou que estava subindo a mesma imagem duas vezes à toa.
        const blankPath = await ensureBlankImageFile()
        const dst1 = path.join(os.tmpdir(), 'Blank Image.jpg')
        if (blankPath !== dst1) {
          fs.copyFileSync(blankPath, dst1)
        }
        tempPaths.push(dst1)
        this.log(`  Enviando 1 foto Blank Image...`)
      } else if (localPhotoFiles && localPhotoFiles.length > 0) {

        // Preserva 100% ESTRITAMENTE a nomenclatura original do Módulo 23 (ex: B0414_S2_PS_DF59.2-59.2_pic1.jpeg)
        for (const srcPath of localPhotoFiles) {
          const originalName = path.basename(srcPath)
          const dstPath = path.join(os.tmpdir(), originalName)
          fs.copyFileSync(srcPath, dstPath)
          tempPaths.push(dstPath)
        }
        this.log(`  Enviando ${tempPaths.length} foto(s) com nomes estritos do Módulo 23 (${tempPaths.map(p => path.basename(p)).join(', ')})...`)
      } else if (data.photoUrls && data.photoUrls.length > 0 && data.photoUrls[0].startsWith('http')) {
        // Fallback da nuvem: gera pic1 e pic2 com o nome estrito oficial do Módulo 23 (SEM prefixo 01_ ou 02_)
        const baseName = this.buildPhotoBaseName(data)
        const buffer = await fetchBuffer(data.photoUrls[0])

        const p1Name = `${baseName}_pic1.jpeg`
        const p2Name = `${baseName}_pic2.jpeg`
        const dst1 = path.join(os.tmpdir(), p1Name)
        const dst2 = path.join(os.tmpdir(), p2Name)

        fs.writeFileSync(dst1, buffer)
        fs.writeFileSync(dst2, buffer)
        tempPaths.push(dst1, dst2)
        this.log(`  Enviando 2 foto(s) com nomes estritos (${p1Name}, ${p2Name})...`)
      } else if (data.photoUrls && data.photoUrls.length > 0) {
        this.log(`  ℹ Arquivo de mídia (${data.photoUrls[0]}) não encontrado na pasta local. Ignorando anexo.`)
      }



      if (tempPaths.length > 0) {
        const scope = this.getScope()

        for (let i = 0; i < tempPaths.length; i++) {
          const filePath = tempPaths[i]
          const fileName = path.basename(filePath)

          // 1. Clica no botão "Add attachments" (📎) para cada foto individualmente
          //
          // O fallback antigo (`a, button` com `hasText: /attachment/i`) era largo
          // demais — bug real achado em teste: depois que a 1ª foto de uma linha já
          // tinha subido e aparecia anexada na tela, esse seletor às vezes casava
          // com o link/legenda da PRÓPRIA foto já anexada em vez do botão de
          // adicionar, e o clique abria uma aba nova do Chromium com a imagem — que
          // ficava sendo tratada como se fosse a aba do formulário dali em diante
          // (travando ou "fechando a instância" na linha seguinte). Trocado pra
          // exigir "add" JUNTO com "attachment" no texto, não só a palavra solta —
          // não bate mais com um anexo já existente, só com o botão de adicionar.
          const attachmentBtn = scope
            .locator('.attachment-button, [title*="attachment" i]')
            .or(scope.getByText(/add attachments?/i))
            .or(scope.locator('a, button', { hasText: /add attachments?/i }))
            .first()

          let setViaChooser = false
          if (await attachmentBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            const pagesBefore = this.page.context().pages().length
            const fileChooserPromise = this.page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null)
            await attachmentBtn.click({ force: true }).catch(() => {})
            const fileChooser = await fileChooserPromise

            // Rede de segurança: esse clique NUNCA deveria abrir uma aba nova (só o
            // seletor de arquivo nativo, capturado acima) — se abriu, é sinal de que
            // acertou outra coisa por engano (ver comentário acima). Fecha a aba
            // extra na hora, antes que o resto do código tenha chance de pegá-la por
            // engano como se fosse a aba do formulário.
            const pagesNow = this.page.context().pages()
            if (pagesNow.length > pagesBefore) {
              for (const extraPage of pagesNow.slice(pagesBefore)) {
                if (extraPage !== this.page && !extraPage.isClosed()) {
                  this.log(`  ⚠ O clique em "Add attachments" abriu uma aba inesperada — fechando (provavelmente acertou um anexo já existente por engano).`)
                  await extraPage.close().catch(() => {})
                }
              }
            }

            if (fileChooser) {
              await fileChooser.setFiles([filePath])
              setViaChooser = true
              this.log(`  ✓ Foto ${i + 1}/${tempPaths.length} (${fileName}) anexada via filechooser!`)
            }
          }

          if (!setViaChooser) {
            const fileInput = scope.locator('input[type="file"]').last().or(scope.locator('input[type="file"]').first())
            await fileInput.evaluate((el: HTMLInputElement) => el.setAttribute('multiple', 'multiple')).catch(() => {})
            await fileInput.setInputFiles([filePath])
            this.log(`  ✓ Foto ${i + 1}/${tempPaths.length} (${fileName}) anexada via input DOM!`)
          }

          // Aguarda o encerramento do upload do ServiceNow para o arquivo atual.
          // Vídeo é bem maior que foto — 1.5s fixo bastava pra foto mas terminava
          // ANTES do upload de vídeo de verdade concluir. Pra vídeo, por padrão,
          // espera o nome do arquivo aparecer na lista de anexos (sinal de upload
          // concluído), com timeout generoso e log periódico pra não parecer travado.
          //
          // waitForVideoUpload=false (fase 3 de vídeos em runSnowDamageAutomation):
          // dispara o upload e segue sem esperar terminar — essa aba fica aberta pra
          // revisão manual, o upload continua em segundo plano enquanto os próximos
          // vídeos são preenchidos noutras abas (cascata). Só uma pausa mínima pra
          // garantir que o clique/seleção do arquivo realmente registrou.
          if (isVideoFile(fileName)) {
            if (waitForVideoUpload) {
              await this.waitForAttachmentUploaded(scope, fileName)
            } else {
              await this.page.waitForTimeout(800)
            }
          } else {
            await this.page.waitForTimeout(1500)
          }
        }
      }
    } catch (err: any) {
      this.log(`  ⚠ Erro no upload de fotos: ${err.message || err}`)
    } finally {
      for (const p of tempPaths) {
        try {
          fs.unlinkSync(p)
        } catch {
          /* ignore */
        }
      }
    }
  }


  private async addOptionalFields(optionSearchText: string = '241'): Promise<void> {
    const scope = this.getScope()
    this.log(`    Configurando Optional Fields ("${optionSearchText}")...`)

    try {
      // 1. Marca o checkbox "Set Optional Fields" se não estiver marcado
      const setOptionalCheckbox = scope
        .locator('label', { hasText: /set optional fields/i })
        .locator('input[type="checkbox"]')
        .or(scope.getByLabel(/set optional fields/i))
        .first()

      if (await setOptionalCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
        const isChecked = await setOptionalCheckbox.isChecked().catch(() => false)
        if (!isChecked) {
          await setOptionalCheckbox.check({ force: true }).catch(async () => {
            await setOptionalCheckbox.click({ force: true })
          })
          this.log(`    ✓ Checkbox 'Set Optional Fields' marcado.`)
          await this.page.waitForTimeout(500)
        }
      } else {
        await scope.getByText(/set optional fields/i).first().click({ force: true }).catch(() => {})
        await this.page.waitForTimeout(500)
      }

      // Se a opção SN_241 já está presente na tabela Optional Fields, não adiciona de novo
      const alreadyAdded = await scope.getByText(/SN_241|NR81\.5/i).first().isVisible({ timeout: 1000 }).catch(() => false)
      if (alreadyAdded) {
        this.log(`    ✓ Opção SN_241 já está presente na tabela Optional Fields.`)
        return
      }

      // 2. Clicar no botão "Add" da seção Optional Fields para abrir a modal "Add Row"
      const addBtns = scope.locator('button, a.btn, input[type="button"]').filter({ hasText: /^add$/i })
      let clickedAddTable = false
      for (let i = 0; i < await addBtns.count(); i++) {
        const btn = addBtns.nth(i)
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ force: true })
          clickedAddTable = true
          break
        }
      }

      if (!clickedAddTable) {
        await scope.getByText(/^add$/i).first().click({ force: true }).catch(() => {})
      }

      this.log(`    ✓ Clicado no botão Add. Aguardando a modal 'Add Row'...`)
      await this.page.waitForTimeout(600)

      // 3. Modal "Add Row" (busca na página global para encontrar a modal e a lista Select2 anexada ao document.body)
      const modal = this.page.locator('.modal-dialog, .modal-content, [role="dialog"]').first()
      await modal.waitFor({ state: 'visible', timeout: 5000 })

      // Clica no campo "Option" no modal (Select2)
      const optionField = modal
        .locator('.select2-choice')
        .or(modal.getByRole('combobox', { name: /option/i }))
        .or(modal.getByLabel(/option/i, { exact: false }))
        .first()

      await optionField.click({ force: true })
      await this.page.waitForTimeout(300)

      // Digita "241" na caixa de busca do Select2 visível no body
      const searchBox = this.page
        .locator('.select2-input:visible, input.select2-search:visible, input[role="combobox"]:visible')
        .last()

      if (await searchBox.isVisible({ timeout: 2000 }).catch(() => false)) {
        await searchBox.fill(optionSearchText)
        await this.page.waitForTimeout(400)
        // Pressiona Enter para confirmar a seleção destacada no Select2
        await searchBox.press('Enter').catch(() => {})
        await this.page.waitForTimeout(300)
      }

      // Clicar explicitamente na opção visível no Select2 caso o Enter não tenha fechado o dropdown
      const optionItem = this.page
        .locator('.select2-result-label:visible, li.select2-result:visible, .select2-highlighted:visible', { hasText: /241|SN_241/i })
        .first()

      if (await optionItem.isVisible({ timeout: 1000 }).catch(() => false)) {
        await optionItem.click({ force: true }).catch(() => {})
        await this.page.waitForTimeout(300)
      }

      // 4. Marca o checkbox "True / False" se disponível no modal
      const trueFalseCheckbox = modal
        .getByLabel(/true\s*\/\s*false/i)
        .or(modal.locator('label', { hasText: /true\s*\/\s*false/i }).locator('input[type="checkbox"]'))
        .or(modal.locator('input[type="checkbox"]'))
        .first()

      if (await trueFalseCheckbox.isVisible({ timeout: 1500 }).catch(() => false)) {
        const isTrueChecked = await trueFalseCheckbox.isChecked().catch(() => false)
        if (!isTrueChecked) {
          await trueFalseCheckbox.check({ force: true }).catch(async () => {
            await trueFalseCheckbox.click({ force: true })
          })
          this.log(`    ✓ Checkbox 'True / False' marcado.`)
          await this.page.waitForTimeout(300)
        }
      }

      // 5. Clicar no botão "Add" DENTRO da modal para salvar a linha
      const modalAddBtn = modal
        .getByRole('button', { name: /^add$/i })
        .or(modal.locator('button.btn-primary', { hasText: /^add$/i }))
        .first()

      await modalAddBtn.click({ force: true })
      this.log(`    ✓ Opção SN_241 adicionada com sucesso na modal!`)
      await this.page.waitForTimeout(800)

    } catch (err: any) {
      this.log(`    ⚠ Erro ao configurar Optional Fields: ${err.message || err}`)
    }
  }

  /** Clica Submit — extraído de `fill()` pra poder ser chamado separadamente na Fase
   * 3 (vídeo), DEPOIS de confirmar que o upload de verdade terminou (submeter antes
   * disso submeteria o formulário sem o anexo).
   *
   * NÃO tenta mais ler o número da entrada criada (ex.: "DAM1115650") de volta da
   * tela — confirmado pelo usuário que esse valor nunca fica acessível durante a
   * submissão (só aparece depois, numa planilha de auditoria à parte do
   * ServiceNow); a tentativa de ler sempre falhava (5s de espera à toa em toda
   * submissão) e nunca tinha como preencher a coluna "SNOW Entry #" de verdade. A
   * detecção de "já submetido" continua garantida só pela auditoria ao vivo da
   * tabela do ServiceNow (`checkRowExistsInLiveTable`/`auditLiveDamageEntries`),
   * que não depende desse número. */
  async submitAndReadEntry(): Promise<void> {
    this.log(`  Submetendo formulário...`)
    const submitted = await this.submitForm()
    if (!submitted) {
      throw new Error('Não achou nenhum botão de Submit/Save/Insert visível pra clicar.')
    }

    await this.page.waitForLoadState('networkidle').catch(() => {})
    await this.page.waitForTimeout(1000)
  }

  async fill(
    data: DamageReportRow,
    localPhotoFiles: string[] = [],
    autoSubmit: boolean = false,
    waitForVideoUpload: boolean = true
  ): Promise<void> {
    this.log(
      `Preenchendo: ${data.bladeSerialNumber} | ${data.subComponent} | ${data.failureType} | DF ${data.dfDistanceStart}-${data.dfDistanceEnd}`
    )

    await this.selectFromComboBox('Blade serial number', data.bladeSerialNumber, 800)
    // 1200ms de espera após selecionar Sub Component para permitir que o ServiceNow execute o Script Client que popula o Failure Type
    await this.selectFromComboBox('Sub Component', data.subComponent, 1200)
    await this.selectFromComboBox('Failure Type', data.failureType, 800)

    if (data.damageDescription) {
      await this.fillText('Damage Description', data.damageDescription)
    }

    await this.fillText('DF distance - Start (m)', data.dfDistanceStart)
    await this.fillText('DF distance - End (m)', data.dfDistanceEnd)
    await this.fillText('Profile Depth (%) Start', data.profileDepthStart)
    await this.fillText('Profile Depth (%) End', data.profileDepthEnd)

    // Cascata: cada campo só popula de verdade depois do anterior ser escolhido.
    await this.selectFromComboBox('Inside/Outside', data.insideOutside, 800)
    await this.selectFromComboBox('Blade section', data.bladeSection, 800)
    await this.selectFromComboBox('Blade sub-section', data.bladeSubSection, 800)

    // Se o campo "Blade shear web" estiver visível (ex.: quando Blade sub-section é Shear Web)
    const scope = this.getScope()
    const isShearWebVisible =
      (await scope.getByLabel('Blade shear web', { exact: false }).first().isVisible({ timeout: 1200 }).catch(() => false)) ||
      (await scope.locator('div.form-group, .select2-container', { hasText: /blade shear web/i }).first().isVisible({ timeout: 1200 }).catch(() => false))

    if (isShearWebVisible) {
      this.log(`    Campo 'Blade shear web' detectado visível.`)
      const shearWebValue = data.bladeArea && /shear\s*web/i.test(data.bladeArea) ? data.bladeArea : 'Shear Web 1'
      await this.selectFromComboBox('Blade shear web', shearWebValue, 800)
    } else {
      // "Blade area" e "Blade shear web" são mutuamente exclusivos — quando Blade
      // sub-section é "Shear Web", o ServiceNow troca o campo "Blade area" pelo campo
      // "Blade shear web" (não aparecem os dois juntos na tela). Tentar selecionar
      // "Blade area" nesse caso falhava (campo nem existe), e a verificação
      // pós-seleção corretamente pegava isso como erro — o fix de verdade é nem
      // tentar, já que o valor já foi capturado acima em "Blade shear web".
      await this.selectFromComboBox('Blade area', data.bladeArea, 800)
    }

    await this.fillText('Size (mm)', data.sizeMm)
    await this.fillText('Amount of Findings', data.amountOfFindings ?? 1)

    // Preenche a caixa de Optional fields (opções: SN_241) e clica no botão Add
    await this.addOptionalFields('241')

    // Anexa as fotos com nomes estritos do Módulo 23
    await this.uploadPhotos(data, localPhotoFiles, waitForVideoUpload)



    // Submissão do formulário: somente realizada se autoSubmit for true
    if (autoSubmit) {
      await this.submitAndReadEntry()
    } else {
      this.log(`  ✓ Formulário e fotos preenchidos! (Modo conferência ativo: mantendo formulário aberto).`)
    }
  }



}

// ─── Fase 0: "Create Inspection Report" — etapa anterior ao Damage Report Entry ──
// Cada INC (já criado de antemão pela NAWP) precisa desse cabeçalho de inspeção
// preenchido e submetido ANTES da tela de Damage Report Entries ficar acessível.
// Mapeamento de campos fechado com o usuário — ver docs/snow-automation.md.

/** Dados de uma pá pro Inspection Report — só o que o formulário usa (serial
 * completo de 13 dígitos). `null` quando a pá não foi achada em `blade_sets.json`
 * (turbina ainda não cadastrada na lista, ou só tem 1-2 pás nela). */
export interface InspectionReportBladeData {
  serial: string | null
}

export interface InspectionReportData {
  technician: string // digitado por quem roda — sempre variável, nunca vem de arquivo
  inspectionStartDate: string // DD/MM/YYYY — igual ao formato do campo no formulário
  bladeA: InspectionReportBladeData
  bladeB: InspectionReportBladeData
  bladeC: InspectionReportBladeData
  bladeSetNumber: string | null // os 4 últimos dígitos do serial — mesmo pras 3 pás
  windfarm: string | null // campo `windfarm` de blade_sets.json — chave pra achar a config do parque
  purchaseOrder: string | null // vem da config do parque (windfarmConfig.ts) — null se o parque ainda não foi cadastrado
}

/** Monta `InspectionReportData` pra uma turbina a partir de `blade_sets.json`
 * (via `getBladesForTurbine`) + os dados já lidos da planilha de controle. Não
 * precisa de nada além do WTG e da Data Coleta — os seriais e o Set Number vêm
 * todos da lista de pás. O Purchase Order vem da config do PARQUE dessa
 * turbina (`windfarmConfig.ts`) — cada parque tem o seu, ao contrário do
 * Blade type/Access method, que são fixos pra toda a campanha (pedido do
 * usuário: "o modelo de blade não vai mudar", só muda nomenclatura de turbina
 * e técnicos/PO por parque). */
export function buildInspectionReportData(
  wtg: string,
  dataColeta: string,
  technician: string
): InspectionReportData {
  const blades = getBladesForTurbine(wtg)
  const [a, b, c] = blades
  const windfarm = blades[0]?.windfarm ?? null
  const config = windfarm ? getWindfarmConfig(windfarm) : null
  return {
    technician,
    inspectionStartDate: dataColeta,
    bladeA: { serial: a?.serial ?? null },
    bladeB: { serial: b?.serial ?? null },
    bladeC: { serial: c?.serial ?? null },
    bladeSetNumber: blades[0]?.setNumber ?? null,
    windfarm,
    purchaseOrder: config?.purchaseOrder || null
  }
}

/** Valores fixos pra toda a campanha, em QUALQUER parque — pedido do usuário:
 * o modelo da pá e o método de acesso não mudam entre parques, só a
 * nomenclatura de turbina e os técnicos/líder/PO (ver `windfarmConfig.ts`). */
const INSPECTION_REPORT_FIXED = {
  accessMethod: 'Visual inspection: Other',
  bladeType: 'NR81.5' // NÃO "NR81.5 - AI-D" — tem os dois valores no dropdown
}

// ─── Daily Activity Report — anexo obrigatório de toda tela de Inspection Report ──
// A própria tela do ServiceNow avisa (bloco "Instructions(Mandatory)" visível em
// toda página com "Add Damage Entry"): tem que baixar um molde de logbook diário,
// preencher e subir de volta como anexo, com o número do relatório (IR######, NÃO
// o INC) no nome do arquivo — senão "não será considerado". Pedido do usuário: a
// automação gera esse arquivo (usando o molde empacotado, `deriveSetNumberFromSerial`-
// style — sem baixar nada do ServiceNow) e sobe sozinha, junto com o Inspection Report.

function findDailyReportTemplate(): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', 'resources', 'daily_activity_report_template.xlsx'),
    path.join(__dirname, '..', '..', '..', 'resources', 'daily_activity_report_template.xlsx'),
    path.join(__dirname, 'resources', 'daily_activity_report_template.xlsx')
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

/** Acha o caminho (dentro do .xlsx, que é um zip) do XML da aba "Activities" —
 * dinamicamente, via workbook.xml + workbook.xml.rels, em vez de assumir
 * "sheet1.xml" — o número muda se alguém reordenar as abas ao gerar um molde
 * novo a partir do ServiceNow. */
async function findActivitiesSheetPath(zip: JSZip): Promise<string> {
  const wbXmlFile = zip.file('xl/workbook.xml')
  if (!wbXmlFile) throw new Error('xl/workbook.xml não encontrado no molde — arquivo não é um .xlsx válido.')
  const wbXml = await wbXmlFile.async('string')
  const sheetMatch = wbXml.match(/<sheet[^>]*name="Activities"[^>]*\/>/)
  if (!sheetMatch) throw new Error('Aba "Activities" não encontrada no molde.')
  const ridMatch = sheetMatch[0].match(/r:id="([^"]+)"/)
  if (!ridMatch) throw new Error('Aba "Activities" sem r:id no molde.')

  const relsFile = zip.file('xl/_rels/workbook.xml.rels')
  if (!relsFile) throw new Error('xl/_rels/workbook.xml.rels não encontrado no molde.')
  const relsXml = await relsFile.async('string')
  const relMatch = relsXml.match(new RegExp(`<Relationship[^>]*Id="${ridMatch[1]}"[^>]*Target="([^"]+)"`))
  if (!relMatch) throw new Error('Relação da aba "Activities" não encontrada em workbook.xml.rels.')

  return 'xl/' + relMatch[1].replace(/^\.?\/?/, '')
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Gera o Daily Activity Report preenchido a partir do molde empacotado — 3 linhas
 * (uma por pá, na MESMA ordem Blade A/B/C já usada no resto do Inspection Report),
 * "Blade 1/2/3 Completed" fixo em Details of Activity, "Inspection Internal" fixo
 * em Activity (mesmo valor do exemplo real de referência), 1.5h de Working Time
 * (idem). Técnico alterna entre os 2 nomes da campanha por turbina — não é
 * informação relevante pro cliente, só precisa estar preenchido (pedido do
 * usuário). Retorna `null` se o molde não foi encontrado (não trava o resto do
 * fluxo — só loga o aviso e segue sem o anexo).
 *
 * NÃO usa ExcelJS — achado real em teste: o ExcelJS TRAVA PRA SEMPRE (nunca
 * resolve nem rejeita) tentando ler o molde de verdade do ServiceNow, mesmo o
 * arquivo em branco sem nenhuma edição (confirmado isolado, fora do app). E o
 * usuário confirmou que uma versão reconstruída do zero (sem essa trava, mas
 * também sem a estrutura exata do molde oficial) dá erro na hora de finalizar
 * o Inspection Report no ServiceNow — o arquivo TEM que ser bit-a-bit o molde
 * deles, só com os dados inseridos. Por isso a geração agora edita o XML bruto
 * dentro do .zip (.xlsx é um zip) via JSZip — o resto do arquivo (fórmulas,
 * estilos, abas ReadMe/dropdowns/Variables, tabelas) fica 100% intacto, só os
 * `<c>` (célula) das 3 linhas de dados são inseridos/alterados. */
async function generateDailyActivityReport(
  data: InspectionReportData,
  inspectionDate: string,
  technicianIndex: number,
  irNumber: string,
  log: LogFn
): Promise<string | null> {
  const templatePath = findDailyReportTemplate()
  if (!templatePath) {
    log(`  ⚠ Molde do Daily Activity Report não encontrado (resources/daily_activity_report_template.xlsx) — pulando anexo.`)
    return null
  }

  const config = data.windfarm ? getWindfarmConfig(data.windfarm) : null
  if (!config) {
    log(`  ⚠ Parque "${data.windfarm ?? '?'}" sem líder/técnico cadastrado (Configuração por Parque) — pulando Daily Activity Report.`)
    return null
  }
  const technicians = config.technicians.length > 0 ? config.technicians : ['']
  const technician = technicians[technicianIndex % technicians.length]

  const blades = [data.bladeA.serial, data.bladeB.serial, data.bladeC.serial]
  const rowNums = [5, 6, 7]

  try {
    const templateBuf = fs.readFileSync(templatePath)
    const zip = await JSZip.loadAsync(templateBuf)
    const sheetPath = await findActivitiesSheetPath(zip)
    const sheetFile = zip.file(sheetPath)
    if (!sheetFile) throw new Error(`Arquivo "${sheetPath}" não encontrado dentro do molde.`)
    let xml = await sheetFile.async('string')

    let filledAny = false
    for (let i = 0; i < 3; i++) {
      const serial = blades[i]
      if (!serial) continue
      const row = rowNums[i]

      // Âncora conhecida do molde oficial: nas linhas 5-7, a célula L (Working
      // Time) já existe vazia ("<c r="L5" s="2"/>") — colunas A-K não existem
      // ainda (linha em branco de verdade). Insere as novas células ANTES dela
      // (ordem de coluna certa: A,B,C,D,E,J,K,L) e dá valor pra própria L.
      const anchor = `<c r="L${row}" s="2"/>`
      if (!xml.includes(anchor)) {
        throw new Error(`Âncora da linha ${row} não encontrada no molde — a estrutura pode ter mudado (avise antes de usar um molde novo).`)
      }

      // Estilo de cada célula tem que ser o índice de estilo PADRÃO da coluna
      // (visto em <cols> no XML do molde: A=24, B/C=2, D/E/J/K=26) — nunca
      // deixar sem `s=` (índice 0 implícito). Achado real: sem isso a célula
      // fica com o estilo padrão da planilha, que NÃO tem
      // `<protection locked="0"/>` como as colunas de entrada de dado têm —
      // com a proteção de folha ativa no molde, isso trava a célula (aparece
      // como texto fixo, não editável, exatamente o que o usuário reportou).
      const cellStr = (ref: string, text: string, styleIdx: number) =>
        `<c r="${ref}" s="${styleIdx}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`
      // Coluna C ("Blade Position (Pitch #)") — pedido do usuário: casa a
      // ordem das 3 linhas com Pitch 1/2/3 = Blade A/B/C, igual já é usado no
      // resto do Inspection Report.
      const newCells =
        cellStr(`A${row}`, inspectionDate, 24) +
        cellStr(`B${row}`, serial, 2) +
        cellStr(`C${row}`, `Pitch ${i + 1}`, 2) +
        cellStr(`D${row}`, config.leader, 26) +
        cellStr(`E${row}`, technician, 26) +
        cellStr(`J${row}`, 'Inspection Internal', 26) +
        cellStr(`K${row}`, `Blade ${i + 1} Completed`, 26)
      const replacement = `${newCells}<c r="L${row}" s="2"><v>1.5</v></c>`

      xml = xml.replace(anchor, replacement)
      filledAny = true
    }

    if (!filledAny) {
      log(`  ⚠ Nenhuma pá com serial conhecido pro Daily Activity Report — pulando anexo.`)
      return null
    }

    zip.file(sheetPath, xml)
    // compression: 'DEFLATE' — sem isso o JSZip usa STORE (sem compressão) por
    // padrão, e o arquivo sai ~4x maior que o molde original à toa.
    const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const outPath = path.join(os.tmpdir(), `Daily Activity Report_${irNumber}.xlsx`)
    fs.writeFileSync(outPath, outBuf)
    return outPath
  } catch (err: any) {
    log(`  ⚠ Falha ao gerar o Daily Activity Report a partir do molde: ${err.message || err}`)
    return null
  }
}

/** Acha o número do relatório (IR######, formato diferente do INC) — a própria
 * tela expõe ele dentro do bloco de instruções obrigatórias ("Example: Daily
 * Activity Report_IR0066857"), então não precisa de um seletor dedicado: procura o
 * texto visível e extrai o que vem depois de "Daily Activity Report" (confirmado
 * pelo usuário: esse "exemplo" no texto não é genérico, é o número de verdade
 * daquela turbina). */
async function extractDailyReportIrNumber(page: Page, log: LogFn): Promise<string | null> {
  const scopes = [page, ...page.frames()]
  for (const s of scopes) {
    const el = s.getByText(/Daily Activity Report[_\s-]/i).first()
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      const text = ((await el.textContent().catch(() => '')) || '')
      const m = text.match(/Daily Activity Report[_\s-]+([A-Za-z]{1,3}\d{4,})/i)
      if (m) return m[1].toUpperCase()
    }
  }
  log(`  ⚠ Não achou o número do relatório (IR######) no texto de instruções da tela.`)
  return null
}

class InspectionReportFiller extends ServiceNowFormFiller {
  async fill(data: InspectionReportData): Promise<boolean> {
    this.log(`Preenchendo Inspection Report — technician: ${data.technician}, data: ${data.inspectionStartDate}`)

    await this.setCheckbox('Safety checklist read and followed', true)
    await this.fillText('Responsible technicians', data.technician)
    await this.fillText('Inspection Start Date', data.inspectionStartDate)
    // Inspection End Date é sempre o MESMO dia da Data Coleta (pedido do usuário —
    // a inspeção é sempre feita num único dia) — mesmo valor do Start Date, sem
    // precisar de coluna própria na planilha de controle nem do checkbox
    // "Inspection break" (que fica desmarcado, como já era).
    await this.fillText('Inspection End Date', data.inspectionStartDate)
    await this.selectFromComboBox('Access method', INSPECTION_REPORT_FIXED.accessMethod, 800)
    await this.selectFromComboBox('Blade type', INSPECTION_REPORT_FIXED.bladeType, 800)
    if (data.purchaseOrder) {
      await this.fillText('Purchase Order', data.purchaseOrder)
    } else {
      this.log(`  ⚠ Parque "${data.windfarm ?? '?'}" sem Purchase Order cadastrado — campo deixado como estava.`)
    }

    if (data.bladeA.serial) await this.fillText('Blade A serial number', data.bladeA.serial)
    else this.log(`  ⚠ Blade A não encontrada em blade_sets.json — campo deixado como estava.`)
    if (data.bladeB.serial) await this.fillText('Blade B serial number', data.bladeB.serial)
    else this.log(`  ⚠ Blade B não encontrada em blade_sets.json — campo deixado como estava.`)
    if (data.bladeC.serial) await this.fillText('Blade C serial number', data.bladeC.serial)
    else this.log(`  ⚠ Blade C não encontrada em blade_sets.json — campo deixado como estava.`)

    if (data.bladeSetNumber) {
      await this.fillText('Blade set number', data.bladeSetNumber)
    } else {
      this.log(`  ⚠ Blade set number não encontrado em blade_sets.json — campo deixado como estava.`)
    }

    // Blade manufacturing location fica vazio de propósito (fixo pra campanha) —
    // nenhuma chamada de preenchimento pra esse campo.

    const submitted = await this.submitForm()
    if (!submitted) {
      this.log(`  ✗ Não achou o botão Submit do Inspection Report.`)
      return false
    }

    await this.page.waitForLoadState('networkidle').catch(() => {})

    // Depois do Submit, o ServiceNow processa a requisição (é um formulário de
    // catálogo) antes de carregar a página de verdade do Inspection Report —
    // aquela com "Add Damage Entry" já disponível (achado em teste real: um
    // tempo fixo depois do Submit não bastava, e a URL capturada logo em
    // seguida não era a página certa pro Módulo 24 continuar; a auditoria
    // seguinte nunca achava a tabela "Damage Report Entries"). Espera esse
    // marcador aparecer de verdade em vez de confiar num tempo fixo.
    const scopes = [this.page, ...this.page.frames()]
    let ready = false
    for (const s of scopes) {
      const marker = s.getByRole('button', { name: /add damage entry/i })
      if (await waitVisibleWithRetry(marker, 20, 1500)) {
        ready = true
        break
      }
    }

    if (ready) {
      this.log(`  ✓ Inspection Report submetido e carregado (Add Damage Entry disponível).`)
    } else {
      this.log(`  ⚠ Inspection Report submetido, mas a página não confirmou carregamento em ~30s — seguindo mesmo assim.`)
    }
    return true
  }

  /** Confere se já existe um anexo "Daily Activity Report" na lista de anexos da
   * tela (visível tanto pra Inspection Report recém-criado quanto já existente)
   * — usa o mesmo texto do rótulo de download achado no diagnóstico real
   * ("Download attachment <nome do arquivo>"). Usuário pediu: sem isso, rodar a
   * automação de novo pra uma turbina cujo Inspection Report já existia subia o
   * Daily Activity Report DE NOVO toda vez, gerando duplicata. */
  async hasDailyActivityReportAttached(): Promise<boolean> {
    const scope = this.getScope()
    const existing = scope
      .locator('a[aria-label*="Daily Activity Report" i]')
      .or(scope.getByText(/daily activity report/i))
      .first()
    return await existing.isVisible({ timeout: 2000 }).catch(() => false)
  }

  /** Anexa um arquivo já gerado (o Daily Activity Report) na tela do Inspection
   * Report. Achado real em teste (print do usuário): diferente do formulário de
   * Damage Entry (onde o botão "Add attachments" já abre o seletor nativo de
   * arquivo direto no clique), o ícone de anexo (📎) do CABEÇALHO de um registro
   * já existente (Inspection Report em modo "show"/já submetido) abre primeiro um
   * MODAL "Add attachments" com um link "Choose a file" DENTRO — só esse segundo
   * clique dispara o seletor de arquivo de verdade. O código tentava só o
   * primeiro clique e desistia ("Não abriu o seletor de arquivo"). Agora cobre os
   * dois fluxos: se o seletor já abrir no primeiro clique (padrão do Damage
   * Entry), usa ele; se não abrir mas o modal aparecer, clica "Choose a file"
   * dentro dele. */
  async uploadAttachment(filePath: string, label: string): Promise<boolean> {
    const scope = this.getScope()

    // Achado real em teste (dumpAttachmentDebugInfo): a tela tem VÁRIOS elementos
    // com "attachment" no title/class — inclusive um <div class="...
    // attachment-button..." title="Add an attachment"> (singular, só o ícone do
    // cabeçalho) que NÃO abre nada de útil ao clicar. O botão de verdade é
    // <button class="...sp-attachment-add..." aria-label="Add attachments">
    // (plural, mesmo texto da instrução da tela). `.or()` não garante prioridade
    // — `.first()` pega o primeiro em ordem de DOM entre TODOS os candidatos
    // unidos, não o primeiro da lista de alternativas — por isso o `<div>` errado
    // ganhava. Agora tenta o botão específico e confirmado PRIMEIRO, sozinho, e
    // só cai no seletor largo (mais chance de pegar o elemento errado) se esse
    // específico não existir.
    const specificBtn = scope.locator('button.sp-attachment-add, button[aria-label="Add attachments" i]').first()
    let attachmentBtn = specificBtn
    let usedFallback = false

    if (!(await specificBtn.isVisible({ timeout: 2000 }).catch(() => false))) {
      usedFallback = true
      attachmentBtn = scope
        .locator('.attachment-button, [title*="attachment" i]')
        .or(scope.getByText(/add attachments?/i))
        .or(scope.locator('a, button', { hasText: /add attachments?/i }))
        .first()
    }

    if (!(await attachmentBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
      this.log(`  ⚠ Botão "Add attachments" não encontrado — não deu pra subir ${label}.`)
      await this.dumpAttachmentDebugInfo(label)
      return false
    }
    if (usedFallback) {
      this.log(`  ⚠ Botão específico de anexo não encontrado — usando seletor largo (pode clicar no elemento errado).`)
    }

    const pagesBefore = this.page.context().pages().length
    let fileChooserPromise = this.page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null)
    await attachmentBtn.click({ force: true }).catch(() => {})
    let fileChooser = await fileChooserPromise

    if (!fileChooser) {
      // Não abriu direto — confere se caiu no modal "Add attachments" com
      // "Choose a file" dentro, e clica nele.
      const chooseFileLink = scope.getByText(/choose a file/i).first()
      if (await chooseFileLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        fileChooserPromise = this.page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null)
        await chooseFileLink.click({ force: true }).catch(() => {})
        fileChooser = await fileChooserPromise
      }
    }

    const pagesNow = this.page.context().pages()
    if (pagesNow.length > pagesBefore) {
      for (const extraPage of pagesNow.slice(pagesBefore)) {
        if (extraPage !== this.page && !extraPage.isClosed()) await extraPage.close().catch(() => {})
      }
    }

    if (!fileChooser) {
      this.log(`  ⚠ Não abriu o seletor de arquivo pra anexar ${label}.`)
      // Diagnóstico: usuário reportou que o clique não faz NADA visível (nem o
      // modal abre) — sinal de que o seletor está clicando no elemento errado.
      // Em vez de tentar adivinhar de novo às cegas, tira um screenshot + lista
      // todo elemento com "attach" no title/aria-label/class pra achar o elemento
      // certo com dado real na próxima falha, não mais chute.
      await this.dumpAttachmentDebugInfo(label)
      return false
    }

    await fileChooser.setFiles([filePath])
    this.log(`  ✓ ${label} anexado: ${path.basename(filePath)}`)
    await this.page.waitForTimeout(1500)

    // Se o modal "Add attachments" ainda estiver aberto (fluxo de 2 cliques),
    // fecha pelo X antes de seguir — evita ele ficar cobrindo a tela.
    const closeModalBtn = scope.locator('[aria-label="Close" i]').first()
    if (await closeModalBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await closeModalBtn.click({ force: true }).catch(() => {})
    }

    return true
  }

  /** Diagnóstico pra falha de upload de anexo (usuário reportou: o clique não faz
   * NADA visível, nem o modal abre — sinal de que o seletor está clicando no
   * elemento errado, ou num elemento sem handler nenhum). Salva um screenshot da
   * tela no momento da falha + lista todo elemento com "attach" no
   * title/aria-label/class, pra achar o elemento certo com dado real na próxima
   * falha em vez de tentar outro seletor no escuro de novo. Nunca lança erro —
   * é só um extra de diagnóstico, não pode derrubar o resto da automação. */
  private async dumpAttachmentDebugInfo(label: string): Promise<void> {
    try {
      const dir = path.join(os.tmpdir(), 'arthwind-attachment-debug')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const screenshotPath = path.join(dir, `${stamp}_${label.replace(/\s+/g, '_')}.png`)
      await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
      this.log(`  🔍 [debug] Screenshot salvo: ${screenshotPath}`)

      const scope = this.getScope()
      const candidates = scope.locator('[title*="attach" i], [aria-label*="attach" i], [class*="attach" i]')
      const count = await candidates.count().catch(() => 0)
      this.log(`  🔍 [debug] ${count} elemento(s) com "attach" no title/aria-label/class:`)
      for (let i = 0; i < Math.min(count, 10); i++) {
        const el = candidates.nth(i)
        const tag = await el.evaluate((n) => n.tagName).catch(() => '?')
        const title = await el.getAttribute('title').catch(() => null)
        const ariaLabel = await el.getAttribute('aria-label').catch(() => null)
        const cls = await el.getAttribute('class').catch(() => null)
        const visible = await el.isVisible().catch(() => false)
        this.log(`    - <${tag}> visible=${visible} title="${title || ''}" aria-label="${ariaLabel || ''}" class="${cls || ''}"`)
      }
    } catch (err: any) {
      this.log(`  ⚠ [debug] Falha ao gerar diagnóstico: ${err.message || err}`)
    }
  }

  /** Segunda auditoria pedida pelo usuário: confere se os dados que a automação
   * preencheu no Inspection Report realmente estão salvos na tela ANTES de seguir
   * pra auditoria dos defeitos — pega de cara um campo que "pareceu" preencher mas
   * não colou (mesmo tipo de bug já visto no Select2 dos defeitos), sem esperar o
   * usuário notar só depois de já ter subido tudo. Roda tanto pra 'create' (recém
   * submetido) quanto pra 'show' (já existia) — não assume nada, sempre lê a tela. */
  async verifyFilled(data: InspectionReportData): Promise<{ ok: boolean; mismatches: string[] }> {
    const mismatches: string[] = []

    const checkText = async (label: string, expected: string | null) => {
      if (!expected) return
      const actual = await this.readTextValue(label)
      if (actual.trim() !== expected.trim()) {
        mismatches.push(`${label}: esperado "${expected}", achado "${actual || '(vazio)'}"`)
      }
    }
    const checkCombo = async (label: string, expected: string) => {
      const actual = await this.readComboBoxValue(label)
      if (!actual.toLowerCase().includes(expected.toLowerCase())) {
        mismatches.push(`${label}: esperado "${expected}", achado "${actual || '(vazio)'}"`)
      }
    }

    await checkText('Responsible technicians', data.technician)
    await checkText('Inspection Start Date', data.inspectionStartDate)
    await checkText('Inspection End Date', data.inspectionStartDate)
    await checkCombo('Access method', INSPECTION_REPORT_FIXED.accessMethod)
    await checkCombo('Blade type', INSPECTION_REPORT_FIXED.bladeType)
    await checkText('Purchase Order', data.purchaseOrder)
    await checkText('Blade A serial number', data.bladeA.serial)
    await checkText('Blade B serial number', data.bladeB.serial)
    await checkText('Blade C serial number', data.bladeC.serial)
    await checkText('Blade set number', data.bladeSetNumber)

    if (mismatches.length === 0) {
      this.log(`  ✓ Auditoria do Inspection Report: todos os campos conferidos batem.`)
    } else {
      this.log(`  ⚠ Auditoria do Inspection Report encontrou ${mismatches.length} divergência(s):`)
      for (const m of mismatches) this.log(`    - ${m}`)
    }

    return { ok: mismatches.length === 0, mismatches }
  }
}

/** Navega até a tela do INC: portal (mesma origem de `incidentUrl`) → tile "My
 * Inspection Reports" → lista "Technical Incidents" com busca → pesquisa o INC →
 * clica no resultado único. Selectors ainda não confirmados contra o ServiceNow
 * de verdade — mesmo processo iterativo já usado pro resto do Módulo 24 (ver
 * docs/snow-automation.md pra atualizações depois do primeiro teste real). */
/** Espera um locator ficar visível tentando várias vezes com intervalo, em vez de
 * uma única checagem — o portal do ServiceNow é um app Angular (Service Portal)
 * que pode levar vários segundos pra renderizar de verdade mesmo depois do DOM
 * "carregado" (`domcontentloaded`/`networkidle` não garantem que o Angular já
 * bootou e desenhou os componentes). Mesmo padrão de paciência já usado em
 * `openDamageEntryForm` (retry loop) pro resto do módulo. */
async function waitVisibleWithRetry(
  locator: ReturnType<Page['locator']>,
  attempts: number = 12,
  intervalMs: number = 1000
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) return true
    await locator.page().waitForTimeout(intervalMs).catch(() => {})
  }
  return false
}

export async function findAndOpenIncident(
  page: Page,
  portalOrigin: string,
  incNumber: string,
  log: LogFn
): Promise<boolean> {
  await page.goto(portalOrigin, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1500)

  const tile = page.getByText(/my inspection reports/i).first()
  if (await waitVisibleWithRetry(tile)) {
    await tile.click({ force: true }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1500)
  } else {
    log(`  ⚠ Não achou o tile "My Inspection Reports" na home do portal (esperou ~12s) — tentando seguir mesmo assim.`)
  }

  const searchBox = page
    .getByPlaceholder(/keyword search/i)
    .or(page.locator('input[type="search"]'))
    .first()

  if (!(await waitVisibleWithRetry(searchBox))) {
    log(`  ⚠ Não achou a caixa de busca "Keyword Search" na lista "Technical Incidents" (esperou ~12s).`)
    return false
  }
  await searchBox.fill(incNumber)
  await searchBox.press('Enter').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(1000)

  const resultLink = page.getByText(incNumber, { exact: true }).first()
  if (!(await waitVisibleWithRetry(resultLink))) {
    log(`  ⚠ INC "${incNumber}" não apareceu na busca de Technical Incidents (esperou ~12s).`)
    return false
  }
  await resultLink.click({ force: true }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1500)
  return true
}

export type InspectionReportState = 'create' | 'show' | 'unknown'

/** Lê qual botão de Ações aparece na tela do INC — decide se precisa preencher o
 * Inspection Report do zero ("create") ou se já existe e só falta abrir ("show"). */
export async function detectInspectionReportState(page: Page, log: LogFn): Promise<InspectionReportState> {
  const scopes = [page, ...page.frames()]
  for (const s of scopes) {
    const createBtn = s.getByRole('button', { name: /create inspection report/i }).or(
      s.getByRole('link', { name: /create inspection report/i })
    )
    if (await createBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      return 'create'
    }
    const showBtn = s.getByRole('button', { name: /show inspection report/i }).or(
      s.getByRole('link', { name: /show inspection report/i })
    )
    if (await showBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      return 'show'
    }
  }
  log(`  ⚠ Não achou nem "Create Inspection Report" nem "Show Inspection Report" na tela do INC.`)
  return 'unknown'
}

/** Clica no botão certo ("Create Inspection Report" ou "Show Inspection Report",
 * conforme `state`) e espera a navegação assentar. */
async function clickInspectionReportButton(page: Page, state: 'create' | 'show', log: LogFn): Promise<boolean> {
  const label = state === 'create' ? /create inspection report/i : /show inspection report/i
  const scopes = [page, ...page.frames()]
  for (const s of scopes) {
    const btn = s.getByRole('button', { name: label }).or(s.getByRole('link', { name: label })).first()
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click({ force: true }).catch(() => {})
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      await page.waitForTimeout(1500)
      return true
    }
  }
  log(`  ⚠ Não achou o botão "${state === 'create' ? 'Create' : 'Show'} Inspection Report" pra clicar.`)
  return false
}

/** Fase 0 completa: garante que o Inspection Report da turbina existe e está
 * submetido antes do resto do pipeline (Damage Report Entries) começar. Devolve
 * `false` se não conseguiu (o chamador decide se aborta essa turbina ou segue
 * mesmo assim). */
export async function ensureInspectionReport(
  page: Page,
  portalOrigin: string,
  entry: TurbineIncEntry,
  technician: string,
  log: LogFn
): Promise<boolean> {
  const found = await findAndOpenIncident(page, portalOrigin, entry.incNumber, log)
  if (!found) return false

  const state = await detectInspectionReportState(page, log)
  if (state === 'unknown') return false

  const clicked = await clickInspectionReportButton(page, state, log)
  if (!clicked) return false

  if (state === 'show') {
    log(`  ✓ Inspection Report de ${entry.wtg} (${entry.incNumber}) já existia — nada a preencher.`)
    return true
  }

  const data = buildInspectionReportData(entry.wtg, entry.dataColeta, technician)
  const filler = new InspectionReportFiller(page, log)
  return filler.fill(data)
}

export interface InspectionReportRunOptions {
  headless?: boolean
  // Filtro opcional — só processa esses números de INC. Pensado pra testar com 1
  // turbina antes de rodar a planilha de controle inteira (ver seção Verificação
  // do plano) sem precisar de um arquivo separado só com 1 linha.
  onlyIncNumbers?: string[]
  // Pula turbinas cujo "Status SNOW (Cliente)" já é "Enviado..." — Inspection
  // Report já deve existir pra esses casos (ver `isAlreadySentToClient`). Padrão
  // true: sem isso, rodar a planilha de controle inteira numa campanha já em
  // andamento batia erro de "INC não apareceu na busca" pra toda turbina já
  // avançada, mascarando as que realmente precisavam de atenção.
  skipAlreadySent?: boolean
}

export interface InspectionReportRunResult {
  success: boolean
  processed: number
  failed: number
  errors: string[]
  error?: string
}

/** Fase 0 completa: lê a planilha de controle inteira (ou um filtro dela) e roda
 * `ensureInspectionReport` pra cada turbina, uma aba por vez. Não abre a fila
 * overnight nem o resto do pipeline de Damage Report Entries — só garante que o
 * Inspection Report de cada turbina existe e está submetido. */
export async function runInspectionReportPhase(
  controlXlsxPath: string,
  portalOrigin: string,
  technician: string,
  options: InspectionReportRunOptions,
  log_fn?: LogFn
): Promise<InspectionReportRunResult> {
  const log = log_fn || (() => {})
  const { success, entries, error } = await readTurbineIncList(controlXlsxPath)
  if (!success) {
    return { success: false, processed: 0, failed: 0, errors: [], error: error || 'Falha ao ler a planilha de controle.' }
  }

  let filtered = entries
  if (options.onlyIncNumbers && options.onlyIncNumbers.length > 0) {
    const wanted = new Set(options.onlyIncNumbers.map((s) => s.trim()))
    filtered = entries.filter((e) => wanted.has(e.incNumber))
  }

  const skipAlreadySent = options.skipAlreadySent ?? true
  if (skipAlreadySent) {
    const beforeCount = filtered.length
    filtered = filtered.filter((e) => !isAlreadySentToClient(e.statusSnow))
    const skippedCount = beforeCount - filtered.length
    if (skippedCount > 0) {
      log(`ℹ ${skippedCount} turbina(s) com Status SNOW "Enviado..." na planilha de controle — Inspection Report já deve existir, pulando sem tentar buscar.`)
    }
  }

  if (filtered.length === 0) {
    return {
      success: false,
      processed: 0,
      failed: 0,
      errors: [],
      error: 'Nenhuma turbina encontrada (planilha vazia ou filtro sem correspondência).'
    }
  }

  log(`🏗 Fase 0 (Inspection Report): ${filtered.length} turbina(s) a processar.`)

  let context: BrowserContext
  try {
    context = await getContext(options.headless ?? false)
  } catch {
    await closeServiceNowSession()
    context = await getContext(options.headless ?? false)
  }

  // Garante sessão logada ANTES de navegar pra qualquer coisa — mesmo motivo de
  // `ensureAuthenticatedPage` no resto do Módulo 24: a home do portal pode
  // mostrar uma tela PARCIAL de login/SSO em vez do portal de verdade se a
  // sessão expirou (ou é a primeira vez), e sem essa checagem o código seguia
  // direto tentando achar o tile "My Inspection Reports" numa tela que nem
  // carregou de verdade — dando erro na primeira turbina sempre que precisava
  // logar, em vez de esperar/pedir login como o resto da automação já faz.
  // SEMPRE abre uma aba nova pra essa checagem — nunca "acha qualquer página
  // aberta" no contexto. Bug real achado em teste (diagnosticado pelo usuário):
  // abas de vídeo ficam abertas de propósito esperando revisão manual (podem ser
  // de QUALQUER turbina já processada nessa sessão) — `context.pages().find(p =>
  // !p.isClosed())` não distingue essas abas de uma página genuinamente livre pra
  // reaproveitar, e podia acabar pegando a aba de vídeo de outra pá por engano.
  const authPage = await context.newPage()
  const ready = await ensureAuthenticatedPage(authPage, portalOrigin, log, options.headless ?? false)
  if (!ready) {
    return {
      success: false,
      processed: 0,
      failed: 0,
      errors: [],
      error: 'Sessão do ServiceNow não autenticada (login necessário).'
    }
  }

  let processed = 0
  let failed = 0
  const errors: string[] = []

  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i]
    const prefix = `[${i + 1}/${filtered.length}]`
    const page = await context.newPage()
    try {
      const ok = await ensureInspectionReport(page, portalOrigin, entry, technician, log)
      if (ok) {
        processed++
        log(`✓ ${prefix} ${entry.wtg} (${entry.incNumber}) OK.`)
      } else {
        failed++
        const msg = `✗ ${prefix} ${entry.wtg} (${entry.incNumber}) falhou.`
        errors.push(msg)
        log(msg)
      }
    } catch (err: any) {
      failed++
      const msg = `✗ ${prefix} ${entry.wtg} (${entry.incNumber}) erro: ${err.message}`
      errors.push(msg)
      log(msg)
    } finally {
      await page.close().catch(() => {})
    }
  }

  log(`🏁 Fase 0 concluída: ${processed} ok, ${failed} falha(s).`)
  return { success: true, processed, failed, errors }
}

// ─── Automação completa: Fase 0 + Módulo 24, numa passada só ────────────────
// Une a busca do INC/Inspection Report com o cadastro dos defeitos — pra cada
// turbina, decide Create/Show, preenche o cabeçalho se precisar, e sobe os
// defeitos da pasta local correspondente, sem precisar que o usuário digite
// nenhuma URL de Damage Report (a página já está lá depois da Fase 0).

export interface FullAutomationOptions {
  headless?: boolean
  // Mesmo filtro/motivo de InspectionReportRunOptions.skipAlreadySent.
  skipAlreadySent?: boolean
  // 'all' processa toda turbina pendente que já tem pasta pronta em
  // wtgRootFolder; 'next' processa só a primeira da planilha de controle
  // (nessa ordem) que estiver pendente e com pasta pronta.
  mode: 'all' | 'next'
  // Repassadas pro Módulo 24 (autoSubmit, categorias, dryRun, etc.) — mesmas
  // opções de sempre, ver RunAutomationOptions. localPhotosDir é preenchido
  // automaticamente a partir da pasta da turbina, não precisa vir aqui.
  moduleOptions?: RunAutomationOptions
}

export interface FullAutomationResult {
  success: boolean
  processed: number
  failed: number
  // Pendentes na planilha de controle, mas sem pasta pronta ainda em
  // wtgRootFolder — não são erro, só ainda não chegaram no Módulo 23.
  skippedNoFolder: number
  errors: string[]
  error?: string
  // true quando o usuário pediu Parar no meio da fila — não é uma falha, `success`
  // continua true, só indica que sobrou turbina sem processar de propósito.
  stopped?: boolean
}

export async function runFullAutomation(
  controlXlsxPath: string,
  wtgRootFolder: string,
  portalOrigin: string,
  technician: string,
  options: FullAutomationOptions,
  log_fn?: LogFn
): Promise<FullAutomationResult> {
  const log = log_fn || (() => {})
  const { success, entries, error } = await readTurbineIncList(controlXlsxPath)
  if (!success) {
    return { success: false, processed: 0, failed: 0, skippedNoFolder: 0, errors: [], error: error || 'Falha ao ler a planilha de controle.' }
  }

  const skipAlreadySent = options.skipAlreadySent ?? true
  let pending = skipAlreadySent ? entries.filter((e) => !isAlreadySentToClient(e.statusSnow)) : entries

  const folders = scanWtgFolders(wtgRootFolder)
  const folderMap = new Map(folders.map((f) => [f.wtg, f]))

  const matched: { entry: TurbineIncEntry; folder: WtgFolderInfo }[] = []
  let skippedNoFolder = 0
  for (const e of pending) {
    const folder = folderMap.get(normalizeWtg(e.wtg))
    if (folder) {
      matched.push({ entry: e, folder })
    } else {
      skippedNoFolder++
    }
  }

  if (skippedNoFolder > 0) {
    log(`ℹ ${skippedNoFolder} turbina(s) pendente(s) na planilha, mas sem pasta pronta em "${wtgRootFolder}" ainda — puladas (não é erro).`)
  }

  const toProcess = options.mode === 'next' ? matched.slice(0, 1) : matched

  if (toProcess.length === 0) {
    return {
      success: false,
      processed: 0,
      failed: 0,
      skippedNoFolder,
      errors: [],
      error: `Nenhuma turbina pronta pra processar (pendente na planilha + com pasta em "${wtgRootFolder}").`
    }
  }

  log(`🚀 Automação completa: ${toProcess.length} turbina(s) prontas (Inspection Report + Defeitos).`)

  let context: BrowserContext
  try {
    context = await getContext(options.headless ?? false)
  } catch {
    await closeServiceNowSession()
    context = await getContext(options.headless ?? false)
  }

  // SEMPRE abre uma aba nova pra essa checagem — nunca "acha qualquer página
  // aberta" no contexto. Bug real achado em teste (diagnosticado pelo usuário):
  // abas de vídeo ficam abertas de propósito esperando revisão manual (podem ser
  // de QUALQUER turbina já processada nessa sessão) — `context.pages().find(p =>
  // !p.isClosed())` não distingue essas abas de uma página genuinamente livre pra
  // reaproveitar, e podia acabar pegando a aba de vídeo de outra pá por engano.
  const authPage = await context.newPage()
  const ready = await ensureAuthenticatedPage(authPage, portalOrigin, log, options.headless ?? false)
  if (!ready) {
    return {
      success: false,
      processed: 0,
      failed: 0,
      skippedNoFolder,
      errors: [],
      error: 'Sessão do ServiceNow não autenticada (login necessário).'
    }
  }

  // Fecha essa aba de checagem de login — bug real achado em teste: ela ficava
  // aberta na home do portal (portalOrigin) pelo resto da execução inteira, e o
  // Módulo 24 (que pega "a primeira página não-fechada" do contexto pra montar a
  // auditoria) podia acabar pegando ELA por engano em vez de abrir uma página
  // nova de verdade — a auditoria ficava tentando (e nunca conseguindo) contra a
  // home do portal, em vez do Inspection Report da turbina. Abre uma aba em
  // branco ANTES de fechar, pra nunca zerar as abas (senão a janela do Chromium
  // fecha inteira) — uma aba em `about:blank` é segura de reaproveitar depois,
  // porque `ensureAuthenticatedPage` sempre navega ela pra URL certa (não tem
  // como confundir "já estou lá" com uma página em branco).
  await context.newPage().catch(() => {})
  await authPage.close().catch(() => {})

  let processed = 0
  let failed = 0
  const errors: string[] = []

  for (let i = 0; i < toProcess.length; i++) {
    // Ponto de checagem de Pausar/Parar — sempre ENTRE turbinas, nunca no meio
    // de uma (pedido do usuário: responder em segundos, não esperar a turbina
    // inteira acabar). Se Parar foi pedido, sai do loop e devolve resultado
    // limpo (não é falha) em vez de um erro de verdade.
    try {
      await checkpoint(log)
    } catch (err) {
      if (err instanceof AutomationStoppedError) {
        log(`⏹ Parado pelo usuário — ${processed} ok, ${failed} falha(s), ${toProcess.length - i} turbina(s) não processada(s).`)
        return { success: true, processed, failed, skippedNoFolder, errors, stopped: true }
      }
      throw err
    }

    const { entry, folder } = toProcess[i]
    const prefix = `[${i + 1}/${toProcess.length}]`
    const page = await context.newPage()
    registerTab(page, { purpose: 'transient', turbine: entry.wtg, label: 'Inspection Report' })
    try {
      const found = await findAndOpenIncident(page, portalOrigin, entry.incNumber, log)
      if (!found) throw new Error('INC não encontrado na busca de Technical Incidents.')

      const state = await detectInspectionReportState(page, log)
      if (state === 'unknown') throw new Error('Não achou nem "Create" nem "Show Inspection Report" na tela do INC.')

      const clicked = await clickInspectionReportButton(page, state, log)
      if (!clicked) {
        throw new Error(`Não conseguiu clicar em "${state === 'create' ? 'Create' : 'Show'} Inspection Report".`)
      }

      const data = buildInspectionReportData(entry.wtg, entry.dataColeta, technician)
      const filler = new InspectionReportFiller(page, log)

      if (state === 'create') {
        const submitted = await filler.fill(data)
        if (!submitted) throw new Error('Falha ao submeter o Inspection Report.')
      } else {
        log(`  ✓ ${prefix} Inspection Report de ${entry.wtg} já existia — indo direto pros defeitos.`)
      }

      // Segunda auditoria pedida pelo usuário: confere se o que devia estar
      // preenchido no Inspection Report realmente está salvo na tela ANTES de
      // seguir pros defeitos — não trava a turbina se achar divergência (só
      // reporta), porque casos 'show' de report já existente há muito tempo
      // podem legitimamente ter sido preenchidos com outro técnico/data.
      await filler.verifyFilled(data)

      // Daily Activity Report: anexo obrigatório em toda tela de Inspection
      // Report (instrução visível na própria página), com o número do relatório
      // (IR######, não o INC) no nome do arquivo — esse número está embutido no
      // próprio texto de instruções, não precisa de campo separado.
      //
      // Bug real achado pelo usuário: rodando a automação de novo pra uma
      // turbina cujo Inspection Report já existia (`state === 'show'`), o
      // Daily Activity Report subia DE NOVO toda vez — sem checar se já tinha
      // sido enviado numa rodada anterior. Agora confere a lista de anexos já
      // existente na tela ANTES de gerar/subir nada.
      if (await filler.hasDailyActivityReportAttached()) {
        log(`  ℹ ${prefix} Daily Activity Report já estava anexado — não sobe de novo.`)
      } else {
        const irNumber = await extractDailyReportIrNumber(page, log)
        if (irNumber) {
          const reportPath = await generateDailyActivityReport(data, entry.dataColeta, i, irNumber, log)
          if (reportPath) {
            await filler.uploadAttachment(reportPath, 'Daily Activity Report')
          }
        } else {
          log(`  ⚠ ${prefix} Não achou o número do relatório na tela — Daily Activity Report não foi gerado.`)
        }
      }

      // A página já está onde o Módulo 24 espera estar depois de receber uma
      // URL de Inspection Report — usa a URL atual em vez de pedir pro
      // usuário digitar uma. Fecha essa aba antes de chamar o Módulo 24
      // porque ele abre/gerencia as próprias abas a partir daqui.
      const derivedIncidentUrl = page.url()
      log(`  ℹ ${prefix} URL do Inspection Report capturada: ${derivedIncidentUrl}`)
      await page.close().catch(() => {})

      // Espera o fechamento de verdade se propagar antes de seguir — bug real
      // achado em teste: `page.close()` pode resolver antes do Playwright/CDP
      // terminar de remover a página de `context.pages()` de fato (folga maior
      // no Windows), e a auditoria do Módulo 24 logo em seguida (que pega "a
      // primeira página não-fechada" do contexto) podia acabar pegando ESSA
      // mesma página, ainda numa janela de tempo em que `isClosed()` não tinha
      // virado true de verdade — resultando em "não conseguiu acessar" na
      // auditoria, mesmo já tendo fechado a aba explicitamente.
      let waitedMs = 0
      while (!page.isClosed() && waitedMs < 3000) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        waitedMs += 100
      }
      await new Promise((resolve) => setTimeout(resolve, 300))

      const moduleResult = await runSnowDamageAutomation(
        folder.excelPath,
        derivedIncidentUrl,
        {
          ...(options.moduleOptions || {}),
          headless: options.headless,
          ...(folder.photosDir ? { localPhotosDir: folder.photosDir } : {})
        },
        (m) => log(`  ${prefix} ${m}`)
      )

      if (moduleResult.success) {
        processed++
        log(`✓ ${prefix} ${entry.wtg} (${entry.incNumber}): ${moduleResult.processed} defeito(s) ok, ${moduleResult.failed} falha(s).`)
      } else {
        failed++
        const msg = `✗ ${prefix} ${entry.wtg} (${entry.incNumber}): ${moduleResult.error}`
        errors.push(msg)
        log(msg)
      }
    } catch (err: any) {
      failed++
      const msg = `✗ ${prefix} ${entry.wtg} (${entry.incNumber}): ${err.message}`
      errors.push(msg)
      log(msg)
      await page.close().catch(() => {})
    }
  }

  log(`🏁 Automação completa concluída: ${processed} ok, ${failed} falha(s), ${skippedNoFolder} sem pasta pronta.`)
  return { success: true, processed, failed, skippedNoFolder, errors }
}

// ─── Leitura da planilha (mesmo layout de saída do SNOW Processor) ──────────
// A ordem bate com OUTPUT_HEADERS de snowProcessor.ts:
// A Blade serial | B Sub Component | C Failure Type | D Damage Description |
// E DF Start | F DF End | G PD Start | H PD End | I Inside/Outside |
// J Blade section | K Blade sub-section | L Blade area | M Size | N Link das fotos

async function readDamageRows(excelPath: string): Promise<{ rows: DamageReportRow[] }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(excelPath)
  const ws = wb.worksheets[0]
  const rows: DamageReportRow[] = []
  let lastValidBladeSerial = ''

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const rawBlade = String(row.getCell(1).value ?? '').trim()
    if (!rawBlade) continue

    let isBlankImage = false
    let bladeSerial = rawBlade

    if (rawBlade.toLowerCase() === 'blank image') {
      // Não existe opção pra desligar isso: toda inspeção, sem exceção, exige
      // exatamente 5 entradas Blank Image — não é um comportamento facultativo (mesmo
      // motivo do skipSubmitted não ser mais um checkbox). A auditoria por contagem
      // (ver scanCurrentListPage) que evita duplicar, não a exclusão dessas linhas.
      isBlankImage = true
      bladeSerial = lastValidBladeSerial
    } else {
      lastValidBladeSerial = rawBlade
    }

    if (!bladeSerial) continue


    const photoLinkRaw = String(row.getCell(14).value ?? '').trim()
    const photoUrls = photoLinkRaw
      ? photoLinkRaw
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : []

    const subComponent = String(row.getCell(2).value ?? '').trim()
    let failureType = String(row.getCell(3).value ?? '').trim()

    // Regra de negócio do cliente: "Air inclusion" com sub-componente "Web Laminate" não existe no SNOW.
    // Nesses casos, altera para "Type of failure is missing"
    if (/web\s*laminate/i.test(subComponent) && /air\s*inclusion|bubbles/i.test(failureType)) {
      failureType = 'Type of failure is missing'
    }

    rows.push({
      bladeSerialNumber: bladeSerial,
      subComponent,
      failureType,
      damageDescription: String(row.getCell(4).value ?? '').trim(),
      dfDistanceStart: Number(row.getCell(5).value ?? 0),
      dfDistanceEnd: Number(row.getCell(6).value ?? 0),
      profileDepthStart: (row.getCell(7).value as number | string) ?? '',
      profileDepthEnd: (row.getCell(8).value as number | string) ?? '',
      insideOutside: String(row.getCell(9).value ?? '').trim(),
      bladeSection: String(row.getCell(10).value ?? '').trim(),
      bladeSubSection: String(row.getCell(11).value ?? '').trim(),
      bladeArea: String(row.getCell(12).value ?? '').trim(),
      sizeMm: Number(row.getCell(13).value ?? 0),
      amountOfFindings: 1,
      photoUrls,
      isBlankImage,
      excelRowIndex: r
    })
  }
  return { rows }
}


/** Extrai o S/N de 4 dígitos exatos do serial completo (ex.: "A1 811 0413 0115" -> "0413" ou "B0413_S2..." -> "0413") */
export function extractBladeSn(bladeSerial: string): string {
  if (!bladeSerial) return ''
  const trimmed = bladeSerial.trim()

  // 1. Estrutura padrão: "A1 811 0410 0115" -> tokens[2] é "0410"
  const tokens = trimmed.split(/[\s\-_]+/)
  if (tokens.length >= 4 && /^\d{4}$/.test(tokens[2])) {
    return tokens[2]
  }

  // 2. Nomes de arquivo ou códigos como "B0413_S2..." ou "0413"
  const match = trimmed.match(/(?:B|^|[\s\-_])(\d{4})(?:[\s\-_]|$)/i)
  if (match) {
    return match[1]
  }

  // 3. Fallback genérico para 4 dígitos
  const match4 = trimmed.match(/\d{4}/)
  if (match4) {
    return match4[0]
  }

  return trimmed
}

// ─── Leitura e Inspeção de Pás da Planilha ─────────────────────────────────

export interface BladeSummary {
  bladeSerialNumber: string
  shortSn: string
  count: number
  startRow: number // 1-based index na planilha Excel
  endRow: number // 1-based index na planilha Excel
}

export async function getSpreadsheetBlades(
  excelPath: string
): Promise<{ success: boolean; blades: BladeSummary[]; error?: string }> {
  try {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(excelPath)
    const ws = wb.worksheets[0]
    const map = new Map<string, BladeSummary>()
    let lastValidBladeSerial = ''

    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const rawBlade = String(row.getCell(1).value ?? '').trim()
      if (!rawBlade) continue

      let bladeSerial = rawBlade
      if (rawBlade.toLowerCase() === 'blank image') {
        if (!lastValidBladeSerial) continue
        bladeSerial = lastValidBladeSerial
      } else {
        lastValidBladeSerial = rawBlade
      }

      // Extrai S/N de 4 dígitos exatos (ex.: "A1 811 0410 0115" -> "0410")
      const shortSn = extractBladeSn(bladeSerial)

      if (!map.has(bladeSerial)) {
        map.set(bladeSerial, {
          bladeSerialNumber: bladeSerial,
          shortSn,
          count: 1,
          startRow: r,
          endRow: r
        })
      } else {
        const item = map.get(bladeSerial)!
        item.count += 1
        item.endRow = r
      }
    }

    return { success: true, blades: Array.from(map.values()) }
  } catch (err: any) {
    return { success: false, blades: [], error: err.message }
  }
}

// ─── Planilha de controle (Turbina → INC → Data Coleta) ─────────────────────
// Fonte pra Fase 0 (Inspection Report) — planilha de controle mantida pela equipe
// ("Status Envio ServiceNOW - <cliente>.xlsx", aba "Turbinas"), colunas na ordem:
// A WTG | B Turbina ID | C INC (SNOW) | D Data Coleta | E Data Report |
// F Estado de Inspeção | G Status Arthnex | H Status SNOW (Cliente) | I Observações.
// Só as 4 primeiras colunas importam pra Fase 0 — o resto é status de acompanhamento
// interno, sem uso na automação.

export interface TurbineIncEntry {
  wtg: string // ex.: "VSR03-01"
  turbineId: string // ex.: "90626"
  incNumber: string // ex.: "INC3034373"
  dataColeta: string // ex.: "18/06/2026" — já no formato DD/MM/YYYY que o campo do
  // formulário "Inspection Start Date" espera, sem conversão extra necessária
  statusSnow: string // coluna H "Status SNOW (Cliente)" — "Pendente" | "Enviado com
  // Correção" | "Enviado sem Correção" | "" — usado só pra pular turbinas cujo
  // defeito já foi enviado ao cliente (só é possível se o Inspection Report já
  // existir de verdade no ServiceNow, então nem vale a pena tentar buscar de novo)
}

/** Uma turbina com Status SNOW já "Enviado..." (com ou sem correção) teve seus
 * defeitos submetidos ao cliente — pré-requisito lógico é o Inspection Report já
 * existir e estar submetido, então essas turbinas não precisam (e normalmente nem
 * conseguem) passar pela Fase 0 de novo. Achado em teste real: rodar a planilha de
 * controle inteira sem esse filtro batia em erro de "INC não apareceu na busca"
 * pra boa parte das turbinas já avançadas — não é um erro de verdade, é só um INC
 * que já saiu do estado buscável na lista "Technical Incidents" nessa etapa. */
export function isAlreadySentToClient(statusSnow: string): boolean {
  return /^enviado/i.test(statusSnow.trim())
}

export async function readTurbineIncList(
  xlsxPath: string
): Promise<{ success: boolean; entries: TurbineIncEntry[]; error?: string }> {
  try {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsxPath)
    const ws = wb.getWorksheet('Turbinas') || wb.worksheets[0]
    const entries: TurbineIncEntry[] = []

    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const wtg = String(row.getCell(1).value ?? '').trim()
      const turbineId = String(row.getCell(2).value ?? '').trim()
      const incNumber = String(row.getCell(3).value ?? '').trim()
      if (!wtg || !incNumber) continue // linha vazia ou fora do padrão — pula

      // ExcelJS lê célula formatada como data como um objeto Date de verdade, não
      // como texto "18/06/2026" — reformata pro padrão DD/MM/YYYY do formulário.
      const dataColetaValue = row.getCell(4).value
      const dataColeta =
        dataColetaValue instanceof Date
          ? `${String(dataColetaValue.getDate()).padStart(2, '0')}/${String(dataColetaValue.getMonth() + 1).padStart(2, '0')}/${dataColetaValue.getFullYear()}`
          : String(dataColetaValue ?? '').trim()

      const statusSnow = String(row.getCell(8).value ?? '').trim()

      entries.push({ wtg, turbineId, incNumber, dataColeta, statusSnow })
    }

    return { success: true, entries }
  } catch (err: any) {
    return { success: false, entries: [], error: err.message }
  }
}

/** Remove tudo que não é letra/número e deixa maiúsculo — usada pra cruzar o WTG
 * da planilha de controle ("VSR19-04") com o nome da pasta local em
 * `D:\SNOW\WTG'S` ("VSR-19-04", com um hífen a mais) sem precisar decidir qual
 * dos dois formatos é "o certo". */
function normalizeWtg(s: string): string {
  return s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export interface WtgFolderInfo {
  wtg: string // normalizado via normalizeWtg — bate com o WTG da planilha de controle
  excelPath: string
  photosDir: string | null
}

/** Varre a pasta raiz (`D:\SNOW\WTG'S` na prática) atrás de subpastas com um
 * Excel `..._Novo_Excel.xlsx` dentro (padrão de saída do Módulo 23) — é isso que
 * confirma que os defeitos de uma turbina já estão prontos pra subir. Não lê
 * conteúdo nenhum, só localiza os caminhos; `runFullAutomation` decide o que
 * fazer com cada um. */
export function scanWtgFolders(rootDir: string): WtgFolderInfo[] {
  const results: WtgFolderInfo[] = []
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const d of dirents) {
    if (!d.isDirectory()) continue
    const folderPath = path.join(rootDir, d.name)
    let files: string[]
    try {
      files = fs.readdirSync(folderPath)
    } catch {
      continue
    }
    const excelFile = files.find((f) => /_Novo_Excel\.xlsx$/i.test(f))
    if (!excelFile) continue

    const photosDir = path.join(folderPath, 'Fotos')
    results.push({
      wtg: normalizeWtg(d.name),
      excelPath: path.join(folderPath, excelFile),
      photosDir: fs.existsSync(photosDir) ? photosDir : null
    })
  }

  return results
}

// ─── Busca de Fotos Locais Geradas pelo Módulo 23 ───────────────────────────

export interface LocalPhotoPair {
  pic1Path?: string
  pic2Path?: string
  videoPath?: string
}

/**
 * Mapeia previamente a pasta Fotos/ gerada pelo Módulo 23 no início da automação.
 * Indexa cada defeito pelas chaves (ex.: "0413_df58.5" ou "0413_df58.5-59")
 * com os caminhos absolutos exatos das fotos pic1.jpeg, pic2.jpeg e vídeos (mp4/mov/avi) no disco.
 */
export function buildLocalPhotosMap(localPhotosDir: string): Map<string, LocalPhotoPair> {
  const map = new Map<string, LocalPhotoPair>()
  if (!localPhotosDir || !fs.existsSync(localPhotosDir)) return map

  const scannedDirs = new Set<string>()

  function scan(dir: string) {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true })
      for (const item of items) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) {
          scan(full)
        } else if (item.isFile()) {
          const lower = item.name.toLowerCase()
          const isImg = lower.endsWith('.jpeg') || lower.endsWith('.jpg') || lower.endsWith('.png')
          const isVid = lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.avi') || lower.endsWith('.mkv')
          if (!isImg && !isVid) continue

          const shortSn = extractBladeSn(item.name).toLowerCase()
          const dfMatch = lower.match(/df[\d\.\-_]+/)
          const dfKey = dfMatch ? dfMatch[0] : ''
          const secMatch = lower.match(/s1|s2/i)
          const secKey = secMatch ? secMatch[0].toLowerCase() : ''
          const areaMatch = lower.match(/(?:^|_)(ps|ss)(?:_|\.|$)/i)
          const areaKey = areaMatch ? areaMatch[1].toLowerCase() : ''

          if (shortSn && dfKey) {
            const keysToSet: string[] = []
            if (secKey && areaKey) {
              keysToSet.push(`${shortSn}_${secKey}_${areaKey}_${dfKey}`)
            }
            keysToSet.push(`${shortSn}_${dfKey}`)

            for (const key of keysToSet) {
              if (!map.has(key)) {
                map.set(key, {})
              }
              const entry = map.get(key)!
              if (lower.includes('pic1')) {
                entry.pic1Path = full
              } else if (lower.includes('pic2')) {
                entry.pic2Path = full
              } else if (isVid || lower.includes('video') || lower.includes('vid')) {
                entry.videoPath = full
              }
            }
          }
        }
      }
    } catch {}
  }

  function scanWithParent(dir: string) {
    if (!dir || !fs.existsSync(dir) || scannedDirs.has(dir)) return
    scannedDirs.add(dir)
    scan(dir)

    const parent = path.dirname(dir)
    if (parent && fs.existsSync(parent) && !scannedDirs.has(parent)) {
      const candidates = ['Videos', 'Vídeos', 'videos', 'vídeos', 'Fotos', 'fotos']
      for (const cand of candidates) {
        const candPath = path.join(parent, cand)
        if (fs.existsSync(candPath) && !scannedDirs.has(candPath)) {
          scannedDirs.add(candPath)
          scan(candPath)
        }
      }
    }
  }

  scanWithParent(localPhotosDir)
  return map
}

export function findLocalPhotosFromMap(photosMap: Map<string, LocalPhotoPair>, data: DamageReportRow): string[] {
  if (!photosMap || photosMap.size === 0) return []

  const shortSn = extractBladeSn(data.bladeSerialNumber).toLowerCase()
  const secCode = /section\s*2|s2/i.test(data.bladeSection) ? 's2' : 's1'
  const areaCode = data.bladeArea ? data.bladeArea.toLowerCase() : 'ss'
  const df1 = `df${data.dfDistanceStart}-${data.dfDistanceEnd}`.toLowerCase()
  const df2 = `df${data.dfDistanceStart}`.toLowerCase()

  const result: string[] = []

  // Tenta chave específica com Seção e Área primeiro (ex: "0379_s1_ps_df45_df50")
  let entry =
    photosMap.get(`${shortSn}_${secCode}_${areaCode}_${df1}`) ||
    photosMap.get(`${shortSn}_${secCode}_${areaCode}_${df2}`) ||
    photosMap.get(`${shortSn}_${secCode}_${areaCode}_df45_df50`) ||
    photosMap.get(`${shortSn}_${secCode}_${areaCode}_df45-50`) ||
    photosMap.get(`${shortSn}_${df1}`) ||
    photosMap.get(`${shortSn}_${df2}`)

  const isVideoRow = data.dfDistanceStart === 45 && data.dfDistanceEnd === 50


  if (entry) {
    if (isVideoRow) {
      if (entry.videoPath) result.push(entry.videoPath)
    } else {
      if (entry.pic1Path) result.push(entry.pic1Path)
      if (entry.pic2Path) result.push(entry.pic2Path)
    }
  }

  return result
}

export function findLocalPhotosForDamage(localPhotosDir: string, data: DamageReportRow): string[] {
  if (!localPhotosDir || !fs.existsSync(localPhotosDir)) return []

  const shortSn = extractBladeSn(data.bladeSerialNumber).toLowerCase() // ex: "0413"
  const dfStartStr = String(data.dfDistanceStart).trim().toLowerCase() // ex: "58.5"

  const pic1Files: string[] = []
  const pic2Files: string[] = []
  const videoFiles: string[] = []
  const scannedDirs = new Set<string>()

  function scan(dir: string) {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true })
      for (const item of items) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) {
          scan(full)
        } else if (item.isFile()) {
          const lower = item.name.toLowerCase()
          const isImg = lower.endsWith('.jpeg') || lower.endsWith('.jpg') || lower.endsWith('.png')
          const isVid = lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.avi') || lower.endsWith('.mkv')
          if (!isImg && !isVid) continue

          // Verifica se o caminho absoluto ou o nome do arquivo contém a pá (ex: "0413" ou "b0413")
          const hasSn = !shortSn || lower.includes(shortSn) || full.toLowerCase().includes(`\\${shortSn}\\`) || full.toLowerCase().includes(`/${shortSn}/`)
          // Verifica se o nome do arquivo contém a distância do DF (ex: "df58.5")
          const hasDf = lower.includes(`df${dfStartStr}`)

          if (hasSn && (hasDf || isVid)) {
            if (lower.includes('pic1')) {
              pic1Files.push(full)
            } else if (lower.includes('pic2')) {
              pic2Files.push(full)
            } else if (isVid) {
              let secCode = 'S1'
              if (/section\s*2|s2/i.test(data.bladeSection)) secCode = 'S2'

              let areaCode = 'SS'
              if (/ps|pressure/i.test(data.bladeArea)) areaCode = 'PS'

              // Se o nome do arquivo indicar S1/S2 ou PS/SS diferente do esperado nesta linha, ignora
              if (lower.includes('s1') && secCode !== 'S1') continue
              if (lower.includes('s2') && secCode !== 'S2') continue
              if (lower.includes('ps') && areaCode !== 'PS') continue
              if (lower.includes('ss') && areaCode !== 'SS') continue

              const targetName = `B${shortSn}_${secCode}_${areaCode}_DF45_DF50.mp4`
              if (path.basename(full).toLowerCase() === targetName.toLowerCase()) {
                videoFiles.push(full)
              } else {
                const dst = path.join(os.tmpdir(), targetName)
                try {
                  fs.copyFileSync(full, dst)
                  videoFiles.push(dst)
                } catch {
                  videoFiles.push(full)
                }
              }
            }
          }
        }
      }
    } catch {}
  }

  function scanWithParent(dir: string) {
    if (!dir || !fs.existsSync(dir) || scannedDirs.has(dir)) return
    scannedDirs.add(dir)
    scan(dir)

    const parent = path.dirname(dir)
    if (parent && fs.existsSync(parent) && !scannedDirs.has(parent)) {
      const candidates = ['Videos', 'Vídeos', 'videos', 'vídeos', 'Fotos', 'fotos']
      for (const cand of candidates) {
        const candPath = path.join(parent, cand)
        if (fs.existsSync(candPath) && !scannedDirs.has(candPath)) {
          scannedDirs.add(candPath)
          scan(candPath)
        }
      }
    }
  }

  scanWithParent(localPhotosDir)

  const isVideoRow = data.dfDistanceStart === 45 && data.dfDistanceEnd === 50
  const result: string[] = []

  if (isVideoRow) {
    if (videoFiles.length > 0) result.push(videoFiles[0])
  } else {
    if (pic1Files.length > 0) result.push(pic1Files[0])
    if (pic2Files.length > 0) result.push(pic2Files[0])
  }

  return result
}



// ─── Entry point ──────────────────────────────────────────────────────────

export interface RunAutomationOptions {
  headless?: boolean
  startRow?: number // 1-based, inclusive
  endRow?: number // 1-based, inclusive
  selectedBlades?: string[] // Lista de seriais de pás selecionados para processar
  localPhotosDir?: string // Pasta local com as fotos geradas pelo Módulo 23 (contendo _pic1 e _pic2)
  autoSubmit?: boolean // Se true, clica em Submit no formulário. Padrão: false.
  // Não existe mais opção pra desligar o "ignorar já submetido" (histórico local +
  // auditoria ao vivo) — sempre roda, incondicional (evita duplicata, não é um
  // comportamento facultativo que faça sentido desligar).
  //
  // Substituem o antigo `processOnlyVideos` (só ligava/desligava vídeo) — cada
  // categoria (Defeitos / Blank Images / Vídeos) roda independente, com auditoria
  // própria, e todas vêm marcadas por padrão (`true` se não informado). Desmarcar
  // Vídeos, por exemplo, faz a auditoria nem tentar ler o nome dos anexos (a parte
  // mais lenta) já que não vai processar vídeo nenhum nessa rodada.
  includeDefects?: boolean
  includeBlanks?: boolean
  includeVideos?: boolean
  // Modo auditoria: roda a leitura da planilha + auditoria ao vivo do ServiceNow
  // normalmente (mesma lógica, mesma precisão), mas PÁRA antes da fase de
  // preenchimento — não abre nenhum formulário, não anexa foto nenhuma, não clica
  // em nada. Só reporta o que falta (ver `RunAutomationResult.missingDefects` /
  // `missingBlanks` / `missingVideos` e o log detalhado linha a linha). Padrão: false.
  dryRun?: boolean
}

export interface LiveAuditResult {
  auditSet: Set<string>
  tableFound: boolean
  blankImageCount: number
}

/** Clica no link "Damage Report Entries" dentro da seção "Related Lists" do Inspection
 * Report (mostra um badge com a contagem ao lado, ex.: "Damage Report Entries [8]") —
 * abre uma tela de LISTA separada (não é a mesma página do relatório). Precisa de
 * scroll até o final da página primeiro, já que essa seção fica depois do formulário. */
async function navigateToDamageEntriesList(page: Page, log: LogFn): Promise<boolean> {
  const urlBefore = page.url()

  // Testa TODAS as ocorrências do texto (não só a primeira) e só considera sucesso
  // se a URL de fato mudar depois do clique — bug possível descartado por essa
  // checagem: clicar em algo visível com o texto certo, mas que não é o link de
  // verdade (ex.: um <span> decorativo, ou o texto duplicado em outro lugar da
  // página), o que "parecia" funcionar (clique sem erro) mas não navegava a
  // lugar nenhum. `debugCounts=true` loga quantas ocorrências foram achadas em
  // cada escopo, pra saber se o problema é "não achou nada" ou "achou mas não
  // conseguiu navegar" na próxima rodada de diagnóstico, se ainda falhar.
  const tryClick = async (debugCounts: boolean): Promise<boolean> => {
    const scopes = [page, ...page.frames()]
    for (let scopeIdx = 0; scopeIdx < scopes.length; scopeIdx++) {
      const s = scopes[scopeIdx]
      const candidates = s.getByText(/damage report entries/i)
      const count = await candidates.count().catch(() => 0)
      if (debugCounts) {
        log(`    (escopo ${scopeIdx}: ${count} ocorrência(s) de "damage report entries")`)
      }
      for (let i = 0; i < count; i++) {
        const candidate = candidates.nth(i)
        const visible = await candidate.isVisible({ timeout: 500 }).catch(() => false)
        if (!visible) continue
        await candidate.scrollIntoViewIfNeeded().catch(() => {})
        await candidate.click({ force: true }).catch(() => {})
        await page.waitForTimeout(700)
        if (page.url() !== urlBefore) return true
        if (debugCounts) {
          log(`    (escopo ${scopeIdx}, ocorrência ${i + 1}: clicou mas a URL não mudou — tentando próxima ocorrência)`)
        }
      }
    }
    return false
  }

  if (await tryClick(false)) {
    log(`  ✓ Clicado no link 'Damage Report Entries' (Related Lists)`)
    return true
  }

  // A seção "Related Lists" fica no final do formulário e pode carregar via AJAX
  // DEPOIS do resto da página já estar visível — a contagem ao lado de cada lista
  // (ex.: "Damage Report Entries 19") vem de uma chamada separada. Rola até o fim
  // e tenta várias vezes com intervalo (até ~15s), com diagnóstico detalhado nas
  // últimas tentativas caso continue falhando.
  const MAX_ATTEMPTS = 15
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {})
    const debugThisAttempt = attempt >= MAX_ATTEMPTS - 3 // só nas últimas 3, evita poluir o log
    if (await tryClick(debugThisAttempt)) {
      log(`  ✓ Clicado no link 'Damage Report Entries' (após rolar até o final da página, tentativa ${attempt + 1})`)
      return true
    }
    await page.waitForTimeout(1000)
  }
  log(`  ⚠ Depois de ${MAX_ATTEMPTS} tentativas, o link "Damage Report Entries" nunca resultou em navegação de verdade.`)
  return false
}

/** Lê a página ATUAL da lista "Damage Report Entries" por ÍNDICE DE COLUNA (usa o
 * cabeçalho pra achar "Blade serial number" e "DF distance - Start (m)"), em vez de
 * escanear o texto inteiro da linha atrás de qualquer número — elimina o risco de
 * falso-positivo (pegar um número de outra coluna/sys_id por engano) que a varredura
 * por texto livre tinha. Acumula direto no `auditSet` recebido (pra dar pra chamar de
 * novo por cada página, sem perder o que já foi lido). Devolve se achou uma tabela
 * válida nessa página (não quantas entradas — pode ser 0 numa página vazia). */
/** Normaliza texto de Sub Component pra comparação tolerante (minúsculo, espaços
 * colapsados, sem pontuação nas bordas) — o texto pode vir com diferenças bobas
 * de formatação entre a planilha e a tabela ao vivo do ServiceNow. */
function normalizeSubComponent(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^[-–—\s]+|[-–—\s]+$/g, '')
}

/** Mesma normalização de `normalizeSubComponent`, mas tolerante a plural/singular —
 * achado em teste real: a planilha grava "Air Inclusion" (singular) mas a tabela ao
 * vivo do ServiceNow mostra "Air inclusions" (plural); o mesmo padrão já tinha causado
 * confusão antes com "Foreign Object" (planilha) x "Foreign objects" (SNOW). Sem essa
 * tolerância, a chave da auditoria nunca batia com a chave da planilha por causa de um
 * "s" a mais/a menos, fazendo o robô não reconhecer defeitos (inclusive duplicatas) já
 * cadastrados. Usada SÓ pro Failure Type — Sub Component/Section/Area continuam
 * usando `normalizeSubComponent` sem essa tolerância (não há evidência do mesmo
 * problema ali, e "SS"/"PS" são curtos demais pra arriscar strip de "s" gratuito). */
function normalizeFailureType(s: string): string {
  return normalizeSubComponent(s).replace(/s$/, '')
}

/** Clica numa linha de vídeo ambígua (abre o painel de detalhe, view mestre/detalhe —
 * a lista continua visível ao lado) e lê o NOME DO ANEXO (ex.:
 * "B0545_S2_PS_DF45_DF50.mp4") em vez de tentar ler os campos do formulário. Motivo:
 * numa entrada JÁ CADASTRADA, os campos (Blade section, Sub Component etc.) ficam
 * travados/não-interativos — sem a mesma marcação `<label for="...">` do formulário de
 * criação (confirmado pelo usuário: são caixas de texto bloqueadas). O nome do anexo,
 * por outro lado, continua sendo um link de texto normal, e já contém a Section+Area
 * codificadas no próprio nome (padrão do Módulo 23).
 *
 * Confirma que o painel já atualizou pra linha certa procurando o NÚMERO da entrada
 * (ex.: "DAM1117031") na tela — não dá pra usar a DF aqui, porque ela é IGUAL pras 4
 * linhas do mesmo grupo ambíguo de vídeo.
 *
 * Dois bugs reais já achados nessa checagem de "painel atualizou", nos dois teste real:
 * 1ª tentativa — `getByText(numero)` em QUALQUER lugar da página batia com a própria
 * linha da lista (que já mostra esse número numa célula, antes até do clique).
 * 2ª tentativa — `getByLabel('Number', {exact:true})` não achava o CAMPO com o valor,
 * só o RÓTULO "Number" em si (porque não existe `<label for="...">` de verdade nesse
 * painel travado) — o log mostrou literalmente "campo Number mostra agora \"Number\""
 * (o texto do próprio rótulo, não o valor).
 * Corrigido pra 3ª abordagem: procura o NÚMERO em si (não um rótulo) em qualquer lugar
 * da tela, mas filtra fora qualquer ocorrência dentro de uma `<table>` — a lista é uma
 * tabela, o painel de detalhe não é, então isso separa as duas ocorrências sem
 * depender de rótulo/associação de formulário nenhuma. */
/** Resultado da leitura do anexo de uma linha "candidata a vídeo" (DF 45 + Failure
 * Type "Type of failure is missing"). Esse Failure Type NÃO é exclusivo de vídeo —
 * o Módulo 23 também usa o mesmo texto fixo pra vários defeitos de FOTO (ex.:
 * "Bonding paste failure", "LPS Disconnected/Damaged", "Damaged Laminate" — ver
 * `SnowMappings.FAILURE_TYPES` em snowProcessor.ts). Achado em teste real: um
 * defeito de foto caiu por coincidência em DF 45 com esse Failure Type, entrou no
 * fluxo de vídeo, nunca achou um `.mp4` (porque não tem vídeo nenhum, é foto),
 * ficou 15s tentando e nunca foi marcado como já cadastrado — arriscando duplicata
 * no reprocessamento seguinte. */
type AttachmentReadResult =
  | { kind: 'video'; filename: string }
  | { kind: 'photo' }
  | { kind: 'unknown' }

async function readRowAttachmentKind(
  page: Page,
  expectedDamNumber: string,
  log: LogFn,
  timeoutMs: number = 15000
): Promise<AttachmentReadResult> {
  if (!expectedDamNumber) return { kind: 'unknown' }
  const expectedNorm = expectedDamNumber.trim()
  const deadline = Date.now() + timeoutMs
  let lastSeenOutsideTable = false
  let bestCandidateCount = 0

  const findOutsideTable = async (s: Page | import('playwright').Frame): Promise<boolean> => {
    const candidates = s.getByText(expectedNorm, { exact: false })
    const count = await candidates.count().catch(() => 0)
    bestCandidateCount = Math.max(bestCandidateCount, count)
    for (let i = 0; i < count; i++) {
      const el = candidates.nth(i)
      const visible = await el.isVisible({ timeout: 300 }).catch(() => false)
      if (!visible) continue
      const insideTable = await el.locator('xpath=ancestor::table').count().catch(() => 1)
      if (insideTable === 0) return true
    }
    return false
  }

  while (Date.now() < deadline) {
    const scopes = [page, ...page.frames()]
    for (const s of scopes) {
      const foundOutsideTable = await findOutsideTable(s)
      if (foundOutsideTable !== lastSeenOutsideTable) {
        lastSeenOutsideTable = foundOutsideTable
        log(`    (procurando "${expectedNorm}" fora da tabela da lista — ${foundOutsideTable ? 'achado, confirmando anexo' : 'ainda não achado'})`)
      }
      if (!foundOutsideTable) continue // painel ainda não mostra esse número fora da lista — segue esperando

      const videoAttachment = s.getByText(/\.mp4$/i).first()
      if (await videoAttachment.isVisible({ timeout: 500 }).catch(() => false)) {
        const text = ((await videoAttachment.textContent().catch(() => '')) || '').trim()
        if (text) return { kind: 'video', filename: text }
      }

      // Não achou .mp4 — antes de continuar esperando (achando que o vídeo ainda
      // não terminou de aparecer), confirma se já tem uma FOTO anexada. Se tiver,
      // não é vídeo nenhum — é um defeito de foto que só coincide em DF 45 +
      // Failure Type, e já está cadastrado de verdade.
      const photoAttachment = s.getByText(/\.(jpe?g|png)$/i).first()
      if (await photoAttachment.isVisible({ timeout: 500 }).catch(() => false)) {
        log(`    (achou "${expectedNorm}" fora da tabela com anexo de FOTO, não vídeo — não é uma linha de vídeo de verdade, é um defeito comum)`)
        return { kind: 'photo' }
      }

      log(`    (achou "${expectedNorm}" fora da tabela, mas não achou nenhum anexo .mp4/foto visível ainda)`)
    }
    await page.waitForTimeout(500)
  }
  log(`    (timeout: "${expectedNorm}" nunca apareceu fora da tabela da lista — ${bestCandidateCount} ocorrência(s) do número vistas no total, todas dentro de tabela)`)
  return { kind: 'unknown' }
}

/** Extrai Section+Area do nome do arquivo de vídeo gerado pelo Módulo 23 (padrão
 * `B{pá}_S{seção}_{área}_DF45_DF50.mp4`, ex.: "B0545_S2_PS_DF45_DF50.mp4" →
 * Section 2 / PS). Devolve já normalizado no mesmo formato que `damageRowAuditKeys`
 * usa pro lado da planilha, pra bater exatamente. */
function parseVideoAttachmentQuadrant(filename: string): { sectionNorm: string; areaNorm: string } | null {
  const match = filename.match(/_S(\d+)_([A-Za-z]{2})_DF/i)
  if (!match) return null
  return { sectionNorm: `section ${match[1]}`, areaNorm: match[2].toLowerCase() }
}

async function scanCurrentListPage(
  page: Page,
  auditSet: Set<string>,
  log: LogFn,
  stats: { blankImageCount: number },
  skipVideoAudit: boolean
): Promise<boolean> {
  const scopes = [page, ...page.frames()]
  for (const s of scopes) {
    const headerCells = s.locator('table thead th, table tr:first-child th, [role="columnheader"]')
    const headerCount = await headerCells.count().catch(() => 0)
    if (headerCount === 0) continue

    const headers: string[] = []
    for (let i = 0; i < headerCount; i++) {
      headers.push(((await headerCells.nth(i).textContent().catch(() => '')) || '').trim().toLowerCase())
    }
    const bladeIdx = headers.findIndex((h) => h.includes('blade serial number'))
    const dfIdx = headers.findIndex((h) => h.includes('df distance'))
    if (bladeIdx === -1 || dfIdx === -1) continue // não é a tabela certa (ou colunas com nome diferente)
    // "Sub Component" e "Failure type" também são colunas visíveis nessa tela —
    // quando achadas, qualificam a chave (pá+sub component+failure type+DF) pra não
    // colapsar defeitos diferentes que caem na MESMA distância DF. Um qualificador só
    // (Sub Component) não bastava: dá pra ter duas linhas com mesma pá, mesmo Sub
    // Component e mesma DF Start, diferindo só no Failure Type (ex.: "Deviation Core
    // Material" x "Delamination" na mesma DF 40.0 — caso real visto numa planilha).
    // Sem essas colunas, cai de volta pra chave antiga (pá+DF), como era antes.
    const subIdx = headers.findIndex((h) => h.includes('sub component'))
    const failureIdx = headers.findIndex((h) => h.includes('failure type') || h.includes('type of failure'))
    // "Blank Image" não tem como ser auditada por pá+DF: quando submetida, o Módulo
    // já reatribui um blade serial REAL (o último válido da planilha), então na tabela
    // ao vivo essa entrada aparece com a pá de alguém, indistinguível de um defeito de
    // verdade por esses campos. O único jeito de reconhecer é pela Damage Description
    // ("Empty entry", texto fixo que o Módulo grava pra essas linhas) — conta quantas
    // já existem no total (não tenta casar linha a linha, não faz sentido: são só 5
    // preenchimentos por turbina, intercambiáveis entre si).
    const descIdx = headers.findIndex((h) => h.includes('damage description'))
    // "Number" (o DAM da entrada, ex.: "DAM1117031") é a primeira coluna com esse nome
    // exato — usada como âncora pra confirmar que o painel de detalhe já atualizou pra
    // linha certa antes de ler o anexo (ver readRowAttachmentKind). DF Start não
    // serve pra isso no caso de vídeo: é IGUAL pras 4 linhas do mesmo grupo ambíguo.
    const numberIdx = headers.findIndex((h) => h === 'number')

    const rows = s.locator('table tbody tr')
    const rowCount = await rows.count().catch(() => 0)

    type RowInfo = { r: number; baseKey: string; dfVal: string; damNumber: string; failureNorm: string }
    const infos: RowInfo[] = []

    for (let r = 0; r < rowCount; r++) {
      const cells = rows.nth(r).locator('td')
      const cellCount = await cells.count().catch(() => 0)
      if (cellCount <= Math.max(bladeIdx, dfIdx)) continue

      if (descIdx !== -1 && cellCount > descIdx) {
        const descText = ((await cells.nth(descIdx).textContent().catch(() => '')) || '').trim()
        if (/empty entry/i.test(descText)) {
          stats.blankImageCount++
          continue
        }
      }

      const bladeText = ((await cells.nth(bladeIdx).textContent().catch(() => '')) || '').trim()
      const dfText = ((await cells.nth(dfIdx).textContent().catch(() => '')) || '').trim()
      const shortSn = extractBladeSn(bladeText).toLowerCase()
      const dfVal = dfText.replace(',', '.')
      if (!shortSn || !dfVal) continue

      const subText = subIdx !== -1 && cellCount > subIdx
        ? ((await cells.nth(subIdx).textContent().catch(() => '')) || '').trim()
        : ''
      const failureText = failureIdx !== -1 && cellCount > failureIdx
        ? ((await cells.nth(failureIdx).textContent().catch(() => '')) || '').trim()
        : ''
      const subNorm = normalizeSubComponent(subText)
      const failureNorm = normalizeFailureType(failureText)

      const baseKey =
        subNorm && failureNorm
          ? `${shortSn}_${subNorm}_${failureNorm}_df${dfVal}`
          : subNorm
            ? `${shortSn}_${subNorm}_df${dfVal}`
            : `${shortSn}_df${dfVal}`
      const damNumber = numberIdx !== -1 && cellCount > numberIdx
        ? ((await cells.nth(numberIdx).textContent().catch(() => '')) || '').trim()
        : ''
      infos.push({ r, baseKey, dfVal, damNumber, failureNorm })
    }

    // Agrupa por assinatura (pá+sub component+failure type+DF) pra achar colisões —
    // mais de uma linha real com exatamente a mesma assinatura. Dois casos bem
    // diferentes caem aqui:
    // 1. Vídeo (DF Start = 45): ESPERADO ter até 4 linhas iguais (uma por quadrante —
    //    Section 1/2 × PS/SS —, que só diferem em campos que não aparecem na lista).
    //    Não são duplicatas de verdade — desambiguadas lendo o nome do anexo de cada
    //    uma (ver readRowAttachmentKind).
    // 2. Qualquer outro DF: mais de uma linha com a mesma pá+componente+falha+DF é,
    //    na prática, sempre uma DUPLICATA de verdade (defeitos reais raramente têm
    //    exatamente essa colisão por acaso) — confirma direto, sem precisar abrir nada.
    const groups = new Map<string, RowInfo[]>()
    for (const info of infos) {
      const arr = groups.get(info.baseKey) || []
      arr.push(info)
      groups.set(info.baseKey, arr)
    }

    const MAX_ATTACHMENT_LOOKUPS = 24 // teto de segurança — cada leitura custa alguns segundos
    let attachmentLookupsUsed = 0

    for (const [baseKey, group] of groups) {
      // DF Start = 45 sozinho NÃO basta — um defeito real pode coincidentemente cair
      // exatamente em DF 45 (achado em teste real: 2 DAMs de defeito de verdade,
      // DF 45, entraram no fluxo de vídeo à toa, gastando ~15s cada tentando achar um
      // anexo .mp4 que nunca existiria). O que realmente identifica uma linha de
      // vídeo é o Failure Type fixo "Type of failure is missing" que o Módulo 23 grava
      // pra essas linhas — exige os dois juntos.
      const isVideoDf = group[0].dfVal === '45' && group[0].failureNorm === 'type of failure is missing'

      if (!isVideoDf) {
        // Não-vídeo: uma linha só é o caso normal (marca direto); mais de uma com a
        // mesma assinatura é, na prática, sempre duplicata (defeitos reais raramente
        // colidem por acaso) — confirma direto também, sem precisar abrir nada.
        auditSet.add(baseKey)
        // Debug: espelha o log "Vai processar" (que mostra as chaves geradas do lado
        // da planilha) do lado da tabela ao vivo — sem isso, quando uma linha já
        // cadastrada continua marcada como pendente não dá pra saber se a chave da
        // tabela ao vivo ficou diferente da chave esperada (Sub Component/Failure Type
        // com texto levemente diferente do que foi digitado, DF lido da coluna errada
        // etc.) sem adivinhar.
        log(`  🔎 [debug] Já na tabela ao vivo: chave "${baseKey}"`)
        if (group.length > 1) {
          log(`  ⚠ ${group.length} linha(s) com a mesma pá+componente+falha+DF ("${baseKey}") fora do padrão de vídeo — tratando como duplicata já cadastrada.`)
        }
        continue
      }

      if (skipVideoAudit) {
        // Categoria "Vídeos" desmarcada nessa rodada — nem tenta ler o anexo (é a
        // parte mais lenta da auditoria, clica + espera o painel de detalhe por linha
        // ambígua). Sem processar vídeo nenhum, não precisa saber o quadrante exato.
        continue
      }

      // Vídeo: NUNCA usa a chave solta (baseKey), nem quando tem só 1 linha no grupo —
      // bug real achado em teste: uma pá com só 1 vídeo já cadastrado (não é "ambíguo",
      // é único) caía no caminho rápido de antes e marcava a chave sem qualificação de
      // quadrante, que bate com os 4 vídeos da planilha daquela pá — fazendo o robô
      // achar que os 4 já existiam quando só 1 existia, e nem chegar a auditar as
      // outras pás direito. Por isso todo grupo de vídeo, tenha 1 ou mais linhas,
      // sempre lê o anexo de cada uma pra saber o quadrante exato.
      if (attachmentLookupsUsed + group.length > MAX_ATTACHMENT_LOOKUPS) {
        log(`  ⚠ Muitas linhas de vídeo pra desambiguar (${group.length}) — acima do teto, NÃO marcando nenhuma como já cadastrada.`)
        continue
      }

      log(`  ℹ ${group.length} vídeo(s) com a mesma pá+DF — lendo o nome do anexo de cada um pra saber qual quadrante (Section+Area) já existe...`)
      for (const info of group) {
        attachmentLookupsUsed++
        await rows.nth(info.r).click({ force: true }).catch(() => {})
        const result = await readRowAttachmentKind(page, info.damNumber, log)
        const quadrant = result.kind === 'video' ? parseVideoAttachmentQuadrant(result.filename) : null
        if (quadrant && result.kind === 'video') {
          auditSet.add(`${baseKey}_${quadrant.sectionNorm}_shell_${quadrant.areaNorm}`)
          log(`  ✓ ${info.damNumber || '?'}: anexo "${result.filename}" → ${quadrant.sectionNorm} / ${quadrant.areaNorm}.`)
        } else if (result.kind === 'photo') {
          // Não é vídeo de verdade (Failure Type "Type of failure is missing" também
          // é usado por defeitos de foto) — marca pela chave normal (sem qualificação
          // de quadrante), igual ao caminho não-vídeo, pra não reprocessar/duplicar.
          auditSet.add(baseKey)
          log(`  ✓ ${info.damNumber || '?'}: tem anexo de foto (não vídeo) — marcando como defeito comum já cadastrado ("${baseKey}").`)
        } else {
          // Sem confirmar qual quadrante é, não marca nada — mesma filosofia de
          // sempre: prefere o risco de reabrir uma aba já feita a pular um vídeo que
          // falta de verdade.
          log(`  ⚠ Não deu pra ler o anexo da linha ${info.damNumber || '(número desconhecido)'} — não marcando como já cadastrada.`)
        }
      }
    }
    return true
  }
  return false
}

/** Clica no controle de "próxima página" da lista (o ServiceNow pagina em blocos de 20
 * — "Rows 1 - 20 of 47", com setas "<"/">" no rodapé) e devolve se avançou de verdade.
 * Não sabemos o seletor exato de antemão, então tenta vários padrões comuns; considera
 * "sem próxima página" se o botão estiver desabilitado/ausente. */
async function goToNextListPage(page: Page, log?: LogFn): Promise<boolean> {
  const scopes = [page, ...page.frames()]
  for (const s of scopes) {
    const candidates = [
      s.locator('button[aria-label="Next"], a[aria-label="Next"]'),
      s.locator('[aria-label*="next page" i]'),
      s.locator('button, a').filter({ hasText: '›' }),
      s.locator('button, a').filter({ hasText: '>' }),
      s.locator('.icon-next, .pagination-next, [class*="next" i]')
    ]
    for (const candidate of candidates) {
      const el = candidate.first()
      if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
        const isDisabled =
          (await el.isDisabled().catch(() => false)) ||
          (await el.getAttribute('aria-disabled').catch(() => null)) === 'true' ||
          (await el.getAttribute('disabled').catch(() => null)) !== null
        if (isDisabled) {
          log?.(`  ℹ Controle de "próxima página" achado mas desabilitado — assumindo fim da lista.`)
          return false
        }
        await el.click({ force: true }).catch(() => {})
        return true
      }
    }
  }
  log?.(`  ℹ Nenhum controle de "próxima página" encontrado nessa tela — lista provavelmente não usa paginação por botão (carrega tudo por rolagem).`)
  return false
}

/** Rola a lista até o fim repetidamente e reconta as linhas de qualquer `<table>` da
 * tela — cobre o caso (achado em teste real: turbina com 39 entradas confirmadas de
 * verdade no ServiceNow, mas a auditoria só lia 16 e nunca tentava avançar de página)
 * em que essa lista específica não usa paginação clássica por botão "próxima" — é um
 * widget Angular (Service Portal) que renderiza/carrega mais linhas conforme rola a
 * tela (scroll infinito ou virtualização). Sem isso, só as linhas já renderizadas na
 * carga inicial entravam na auditoria, e tudo que ficava "abaixo da dobra" nunca era
 * lido — 39 entradas reais viravam 16 encontradas, e as 23 restantes eram tratadas
 * como "faltando" mesmo já cadastradas. Rola até a contagem de linhas parar de
 * crescer por duas leituras seguidas (ou até o teto de segurança). */
async function growVisibleRowsUntilStable(page: Page, log: LogFn): Promise<void> {
  const MAX_SCROLLS = 60
  let lastCount = -1
  let stableStreak = 0

  for (let i = 0; i < MAX_SCROLLS; i++) {
    const scopes = [page, ...page.frames()]
    let count = 0
    let lastRow: import('playwright').Locator | null = null
    for (const s of scopes) {
      const rows = s.locator('table tbody tr')
      const c = await rows.count().catch(() => 0)
      if (c > count) {
        count = c
        lastRow = rows.last()
      }
    }

    if (count === lastCount) {
      stableStreak++
      if (stableStreak >= 2) break // duas leituras seguidas sem crescer — acabou de carregar
    } else {
      if (lastCount !== -1) {
        log(`  ℹ Lista cresceu ao rolar: ${lastCount} → ${count} linha(s).`)
      }
      stableStreak = 0
    }
    lastCount = count

    if (!lastRow) break
    await lastRow.scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(400)
  }
}

/** Lê TODAS as páginas da lista "Damage Report Entries" (pagina em blocos de ~20),
 * avançando pela paginação até acabar ou até um teto de segurança — sem isso, turbinas
 * com mais de 20 defeitos teriam as entradas das páginas seguintes fora da auditoria,
 * voltando a arriscar duplicata pros defeitos que sobrarem depois da primeira página. */
async function scanDamageEntriesTableByColumn(
  page: Page,
  log: LogFn,
  skipVideoAudit: boolean = false
): Promise<{ auditSet: Set<string>; tableFound: boolean; blankImageCount: number }> {
  const auditSet = new Set<string>()
  const stats = { blankImageCount: 0 }
  let tableFound = false
  const MAX_PAGES = 50 // teto de segurança (~1000 entradas) contra loop infinito

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    await page.waitForTimeout(300)
    await growVisibleRowsUntilStable(page, log)

    const before = auditSet.size
    const found = await scanCurrentListPage(page, auditSet, log, stats, skipVideoAudit)
    if (found) {
      tableFound = true
      log(`  ✓ Página ${pageNum} da lista lida (+${auditSet.size - before} entrada(s), total acumulado ${auditSet.size}).`)
    } else if (pageNum === 1) {
      break // não achou tabela nenhuma na primeira página, nem adianta tentar paginar
    }

    const advanced = await goToNextListPage(page, log)
    if (!advanced) break

    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await page.waitForTimeout(800)
  }

  if (stats.blankImageCount > 0) {
    log(`  ℹ ${stats.blankImageCount} entrada(s) "Blank Image" já cadastrada(s) (identificadas pela Damage Description "Empty entry").`)
  }

  return { auditSet, tableFound, blankImageCount: stats.blankImageCount }
}

export async function auditLiveDamageEntries(page: Page, log: LogFn, skipVideoAudit: boolean = false): Promise<LiveAuditResult> {
  log(`🔍 Realizando auditoria ao vivo na tabela Damage Report Entries do ServiceNow...`)
  const originalUrl = page.url()
  try {
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await page.waitForTimeout(1000)

    // A tabela "Damage Report Entries" fica numa tela de LISTA separada, aberta a
    // partir do link em "Related Lists" no fim do Inspection Report — não é a mesma
    // página do relatório (isso foi tentado numa versão anterior e estava errado).
    const navigated = await navigateToDamageEntriesList(page, log)
    if (navigated) {
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      await page.waitForTimeout(1500)
    }

    // Salvaguarda: uma versão ainda mais antiga adivinhava uma URL de lista direto
    // (`/bam?id=u_damage_report_entry_list&...`) que não existe nessa instância do
    // ServiceNow e derrubava a página numa tela de erro/acesso negado. Removida, mas
    // mantém a checagem por segurança — se cair numa tela assim por qualquer motivo,
    // volta pra URL original antes de tentar ler qualquer coisa.
    const errorPageText = await page.locator('body').textContent({ timeout: 2000 }).catch(() => '')
    if (errorPageText && /not allowed to access this page|page you requested was not found/i.test(errorPageText)) {
      log(`  ⚠ Página atual é uma tela de erro/acesso negado — voltando pra URL original antes de auditar.`)
      await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(1500)
    }

    const { auditSet, tableFound, blankImageCount } = await scanDamageEntriesTableByColumn(page, log, skipVideoAudit)

    if (auditSet.size > 0) {
      log(`✓ Auditoria ao vivo do ServiceNow concluída: ${auditSet.size} assinatura(s) de defeito já cadastrada(s) na tabela.`)
    } else if (tableFound) {
      log(`ℹ Auditoria ao vivo do ServiceNow concluída: a tabela foi encontrada e está vazia (nenhum defeito cadastrado ainda).`)
    } else {
      log(`⚠ Auditoria ao vivo NÃO encontrou a tabela 'Damage Report Entries' (não conseguiu navegar até a lista, ou as colunas têm nome diferente do esperado) — não dá pra confirmar o que já está cadastrado. Prosseguindo sem esse filtro (só o histórico local, se houver, é aplicado).`)
    }

    // Volta pra página original do incidente — o resto da automação (clicar em Add
    // Damage Entry etc.) espera estar ali, não na tela de lista que abrimos aqui.
    if (navigated) {
      await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(1000)
    }

    return { auditSet, tableFound, blankImageCount }
  } catch {
    log(`⚠ Auditoria ao vivo falhou (exceção durante a varredura) — prosseguindo sem esse filtro.`)
    await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    return { auditSet: new Set<string>(), tableFound: false, blankImageCount: 0 }
  }
}



/** Detecta se a página atual é uma tela de login/SSO em vez do Inspection Report
 * de verdade. EXIGE dois sinais concordantes (campo de senha visível + algum
 * indício de "Sign in/Log in" visível) — um campo de senha sozinho não basta:
 * ServiceNow mantém widgets de reautenticação escondidos no DOM (opacity:0,
 * fora da viewport) mesmo com a sessão válida, e o Playwright considera esses
 * elementos "visíveis" (opacity não conta pra `isVisible`, só display/visibility
 * /bounding box) — foi exatamente isso que gerou falso-positivo num Inspection
 * Report já autenticado e carregado por completo. */
async function isLoginPage(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase()
  if (/\/login\.do|signin\.do|\/sso\/|\/oauth\/|\/auth\/login|processauth|\/kmsi|microsoftonline\.com|okta\.com/i.test(url)) return true

  const scopes = [page, ...page.frames()]
  for (const s of scopes) {
    const passwordVisible = await s.locator('input[type="password"]').first().isVisible({ timeout: 500 }).catch(() => false)
    if (passwordVisible) {
      const hasSignInCue =
        (await s.getByRole('button', { name: /sign in|log in|entrar/i }).first().isVisible({ timeout: 500 }).catch(() => false)) ||
        (await s.getByText(/sign in to continue|entre com sua conta/i).first().isVisible({ timeout: 500 }).catch(() => false))
      if (hasSignInCue) return true
    }

    // Tela de autenticação de dois fatores (2FA/MFA) — não tem campo de senha
    // visível (a senha já foi digitada e aceita), mas o login AINDA não terminou.
    // Bug real achado pelo usuário: sem essa checagem, assim que o campo de senha
    // sumia da tela (indo pra tela de 2FA), o robô já considerava "login
    // concluído", fechava a aba de checagem achando que a sessão estava pronta, e
    // saía procurando o formulário — com uma sessão que na verdade ainda esperava
    // o segundo fator, travando o resto da automação.
    const has2faCue = await s
      .getByText(
        /two-factor|two factor|verify your identity|approve sign in|authenticator app|enter the code|enter code|we sent a code|verifica[çc][ãa]o em duas etapas|autentica[çc][ãa]o de dois fatores|digite o c[óo]digo|aprovar solicita[çc][ãa]o/i
      )
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false)
    if (has2faCue) return true
  }
  return false
}

/** Garante que a página está autenticada e num estado utilizável antes de a
 * automação prosseguir — substitui o passo manual de clicar em "Abrir p/ Login"
 * antes de rodar. Se a sessão persistente já está logada (caso normal), passa
 * direto. Se cair numa tela de login (sessão expirou, ou primeira vez), traz o
 * navegador pra frente e ESPERA (não falha na hora) até `timeoutMs` — dá tempo
 * de alguém notar e logar manualmente, essencial pra fila overnight não travar
 * inteira por causa de uma sessão vencida na primeira turbina.
 * Em modo headless não tem como pedir login interativo — só espera o tempo
 * padrão de rede e desiste rápido, já que não existe janela pra ninguém ver. */
async function ensureAuthenticatedPage(
  page: Page,
  incidentUrl: string,
  log: LogFn,
  headless: boolean
): Promise<boolean> {
  if (!page.url().includes(incidentUrl.split('?')[0])) {
    await page.goto(incidentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})

  if (!(await isLoginPage(page))) return true

  if (headless) {
    log(`⚠ Sessão do ServiceNow não está logada e o modo headless está ativo — não é possível fazer login interativo sem janela visível. Rode uma vez com headless desligado pra logar manualmente.`)
    return false
  }

  log(`🔐 Sessão do ServiceNow não está logada — abrindo a janela do navegador. Faça login manualmente; a automação espera até 5 minutos antes de desistir.`)
  await page.bringToFront().catch(() => {})

  const timeoutMs = 5 * 60 * 1000
  const pollMs = 3000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(pollMs)
    if (!(await isLoginPage(page))) {
      if (!page.url().includes(incidentUrl.split('?')[0])) {
        await page.goto(incidentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      }
      log(`✓ Login detectado — seguindo com a automação.`)
      return true
    }
  }

  log(`✗ Login não foi concluído em 5 minutos — abortando esta turbina.`)
  return false
}

export async function checkRowExistsInLiveTable(page: Page, row: DamageReportRow): Promise<boolean> {
  try {
    const scopes = [page, ...page.frames()]
    const shortSn = extractBladeSn(row.bladeSerialNumber)

    const dfDot = String(row.dfDistanceStart).trim().replace(',', '.')
    const dfComma = String(row.dfDistanceStart).trim().replace('.', ',')

    const cleanSubComp = row.subComponent.replace(/^blade\s+/i, '').trim()

    for (const s of scopes) {
      const rowsLocator = s.locator(
        'table tbody tr, tr[ng-repeat], tr.ng-scope, tr.list_row, tr[sys_id], .list2_body tr, table.list_table tr, div.list-group-item, div.table-responsive tr'
      )
      const count = await rowsLocator.count().catch(() => 0)

      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const text = await rowsLocator.nth(i).textContent().catch(() => '')
          if (!text) continue

          const hasSn = !shortSn || text.includes(shortSn) || text.includes(row.bladeSerialNumber)
          const hasSubComp = text.includes(row.subComponent) || text.includes(cleanSubComp) || (row.subComponent.includes('Shell') && text.includes('Shell'))

          let hasMatch = false
          if (row.dfDistanceStart === 45 && row.dfDistanceEnd === 50) {
            const hasSec = text.includes(row.bladeSection) || (row.bladeSection === 'Section 1' && text.includes('Section 1'))
            const hasArea = text.includes(row.bladeArea)
            hasMatch = hasSn && hasSubComp && (text.includes('45') || text.includes('50')) && hasSec && hasArea
          } else {
            const hasDf = text.includes(dfDot) || text.includes(dfComma)
            hasMatch = hasSn && hasSubComp && hasDf
          }

          if (hasMatch) {
            return true
          }
        }
      }

      // Fallback: varredura no texto completo do body caso a tabela use uma estrutura customizada
      const bodyText = await s.locator('body').textContent().catch(() => '')
      if (bodyText) {
        const hasSn = !shortSn || bodyText.includes(shortSn) || bodyText.includes(row.bladeSerialNumber)
        const hasSubComp = bodyText.includes(row.subComponent) || bodyText.includes(cleanSubComp)
        if (row.dfDistanceStart === 45 && row.dfDistanceEnd === 50) {
          const hasSec = bodyText.includes(row.bladeSection)
          const hasArea = bodyText.includes(row.bladeArea)
          if (hasSn && hasSubComp && (bodyText.includes('DF 45') || bodyText.includes('45-50')) && hasSec && hasArea) {
            return true
          }
        } else {
          const hasDf = bodyText.includes(dfDot) || bodyText.includes(dfComma) || bodyText.includes(`DF ${dfDot}`) || bodyText.includes(`DF ${dfComma}`)
          if (hasSn && hasSubComp && hasDf) {
            return true
          }
        }
      }
    }
  } catch {}
  return false
}



/** Gera as mesmas chaves que `scanDamageEntriesTableByColumn` monta ao ler a tabela ao
 * vivo do ServiceNow (shortSn+DF) — usado pra checar se uma linha da planilha já está
 * cadastrada, ANTES de começar a processar (não só depois, por linha, como
 * `checkRowExistsInLiveTable` já fazia).
 *
 * shortSn+DF sozinho (sem seção/área) só é seguro porque agora o DF vem da coluna
 * certa da tabela ("DF distance - Start (m)"), lido por índice de cabeçalho — não mais
 * de uma varredura de texto livre pegando qualquer número da linha (isso causava
 * falso-positivo, corrigido antes). O risco residual (duas pás diferentes com o mesmo
 * DF exato, uma SS outra PS) é raro e o custo de errar pra esse lado (reprocessar uma
 * linha) é bem menor que pular um defeito real. */
function damageRowAuditKeys(row: DamageReportRow): string[] {
  const shortSn = extractBladeSn(row.bladeSerialNumber).toLowerCase()
  const dfStart = String(row.dfDistanceStart).trim()
  const subNorm = normalizeSubComponent(row.subComponent || '')
  const failureNorm = normalizeFailureType(row.failureType || '')
  const sectionNorm = normalizeSubComponent(row.bladeSection || '')
  const subSectionNorm = normalizeSubComponent(row.bladeSubSection || '')
  const areaNorm = normalizeSubComponent(row.bladeArea || '')

  // Só usa DF START — a tabela ao vivo só mostra a coluna "DF distance - Start", é o
  // único valor comparável de verdade. ANTES também gerava uma chave alternativa
  // usando DF END, achando que isso deixaria a comparação mais tolerante — só que isso
  // criava colisão real: um defeito real (achado numa auditoria manual, VSR-07-02)
  // tinha DF 48.1-48.4 e continuava faltando no ServiceNow, mas um OUTRO defeito real
  // diferente (mesma pá 0566, mesmo Sub Component, mesmo Failure Type "Delamination")
  // já cadastrado começava EXATAMENTE em 48.4 — a chave baseada na DF END do primeiro
  // batia com a chave baseada na DF START do segundo, e o robô achava que o que estava
  // FALTANDO já tinha sido cadastrado. DF ranges que terminam onde outro começa são
  // comuns em dano real (não foi coincidência rara), então usar DF End como fallback
  // tolerante fazia mais mal do que bem.
  //
  // Do mais fraco pro mais forte — mantidos todos como fallback em cascata (mesma
  // lógica de scanCurrentListPage: usa a chave mais qualificada que a tabela ao vivo
  // conseguiu produzir; se ela só tinha Sub Component, ou nem isso, os alternativos
  // ainda batem).
  const keys = [`${shortSn}_df${dfStart}`]
  if (subNorm) {
    keys.push(`${shortSn}_${subNorm}_df${dfStart}`)
  }
  if (subNorm && failureNorm) {
    const base1 = `${shortSn}_${subNorm}_${failureNorm}_df${dfStart}`
    keys.push(base1)
    // Chave totalmente desambiguada por Blade section/sub-section/area — só bate
    // quando scanCurrentListPage precisou abrir o painel de detalhe de uma linha
    // ambígua (ex.: os 4 vídeos DF45-50 de uma pá, que colidem em tudo mais).
    if (sectionNorm || subSectionNorm || areaNorm) {
      keys.push(`${base1}_${sectionNorm}_${subSectionNorm}_${areaNorm}`)
    }
  }
  return keys
}

function rowAlreadyInLiveTable(row: DamageReportRow, auditSet: Set<string>): boolean {
  if (auditSet.size === 0) return false
  return damageRowAuditKeys(row).some((k) => auditSet.has(k))
}

export interface RunAutomationResult {
  success: boolean
  processed: number
  failed: number
  errors: string[]
  error?: string
  // Vídeos (DF 45-50) nunca são auto-submetidos (ver fase 3 de runSnowDamageAutomation)
  // — ficam preenchidos e SEMPRE em abas abertas pra revisão manual, mesmo em modo
  // Submissão Automática. `videosFilled` só conta quando o upload foi CONFIRMADO
  // (nome do arquivo apareceu como anexo) — não basta ter preenchido os campos, já
  // que o upload em si é assíncrono e pode falhar sem erro nenhum no formulário.
  // `videosFailed` só conta depois de esgotadas as rodadas de retentativa
  // automática (ver `MAX_VIDEO_ROUNDS`). Contados à parte de processed/failed
  // porque "confirmado, aguardando revisão" não é a mesma coisa que "ok" ou "falhou".
  videosFilled?: number
  videosFailed?: number
  // Presentes só quando `options.dryRun` foi usado — ver comentário na opção.
  dryRun?: boolean
  missingDefects?: number
  missingBlanks?: number
  missingVideos?: number
  // true quando o usuário pediu Parar no meio — não é falha, `success` continua
  // true, processed/failed/errors refletem o progresso real até o momento.
  stopped?: boolean
}

function isVideoRow(row: DamageReportRow): boolean {
  return row.dfDistanceStart === 45 && row.dfDistanceEnd === 50
}

/** Clica em "Add Damage Entry" (com rolagens/retentativas/timeout) e espera a tela
 * do formulário "Create Damage Entry" ficar pronta na `targetPage` (ou numa sub-aba
 * que o clique tenha aberto). Assume que `targetPage` já está navegada até o
 * Inspection Report certo — extraído do loop principal pra ser reusado também pela
 * fase de vídeos (cada vídeo abre sua própria aba, mas precisa do mesmo fluxo). Devolve
 * a `Page` pronta pra preencher, ou `null` se não conseguiu abrir o formulário. */
async function openDamageEntryForm(
  context: BrowserContext,
  targetPage: Page,
  incidentUrl: string,
  log: LogFn
): Promise<Page | null> {
  // Dá tempo da página assentar antes de sair procurando o botão. Importante
  // principalmente na fase de vídeos: as abas anteriores ainda podem estar subindo
  // vídeo em segundo plano (uso pesado de rede/CPU), então uma aba nova pode demorar
  // bem mais que o normal pra terminar de carregar/renderizar — sem essa espera, a
  // busca pelo botão começava cedo demais e a validação de "formulário abriu" acabava
  // desistindo antes da hora (usuário reportou "não abriu a tempo" especificamente
  // rodando só vídeos, onde essa contenção de rede é mais provável).
  await targetPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})

  // Conta as abas ANTES do clique — usado depois pra decidir se o clique abriu um
  // popup de verdade (ver comentário mais abaixo, perto de `pagesAfterClick`).
  const pagesBeforeClick = context.pages().length

  // Clica no botão "Add Damage Entry" com rolagens, retentativas e timeout limite para evitar travamentos
  let clickedAdd = false
  for (let attempt = 0; attempt < 20; attempt++) {
    const scopes = [targetPage, ...targetPage.frames()]
    for (const s of scopes) {
      const locators = [
        s.locator('button, a', { hasText: /^add damage entry$/i }),
        s.locator('button, a', { hasText: /^create damage entry$/i }),
        s.getByRole('button', { name: /add damage entry|create damage entry|nova entrada/i }),
        s.getByRole('link', { name: /add damage entry|create damage entry|nova entrada/i }),
        s.locator('.btn', { hasText: /damage entry/i }),
        s.locator('button, a', { hasText: /damage entry/i })
      ]
      for (const loc of locators) {
        try {
          if (await loc.first().isVisible({ timeout: 400 }).catch(() => false)) {
            await loc.first().scrollIntoViewIfNeeded().catch(() => {})
            await loc.first().click({ force: true, timeout: 3000 })
            clickedAdd = true
            log(`  ✓ Clicado em 'Add Damage Entry'`)
            break
          }
        } catch {
          /* tenta próximo */
        }
      }
      if (clickedAdd) break
    }
    if (clickedAdd) break
    await targetPage.waitForTimeout(1000)
  }

  if (!clickedAdd) {
    log(`  ⚠ Tentando clique forçado no botão Add Damage Entry...`)
    await targetPage
      .locator('button, a', { hasText: /add damage entry|create damage entry/i })
      .first()
      .click({ force: true, timeout: 3000 })
      .catch(() => {})
  }

  // Se o clique abriu um popup em uma sub-aba, é uma página NOVA que apareceu por
  // causa DESSE clique especificamente — não "a mais recente do contexto inteiro".
  // Bug real diagnosticado pelo usuário: pegar "a mais recente" sem essa checagem
  // podia acidentalmente grudar numa aba de VÍDEO de outra pá/turbina, deixada
  // aberta de propósito esperando revisão manual (nada a ver com este clique),
  // fazendo o preenchimento da linha atual acontecer em cima do formulário errado.
  const pagesAfterClick = context.pages().filter((p) => !p.isClosed())
  const formPage = pagesAfterClick.length > pagesBeforeClick
    ? pagesAfterClick[pagesAfterClick.length - 1]
    : targetPage
  await formPage.bringToFront().catch(() => {})

  // Verifica se a aba atual realmente é o formulário (e não a página do relatório principal Inspection Report)
  const checkFormReady = async (p: Page): Promise<boolean> => {
    const isFormUrl = p.url().includes('u_damage_report_entry') || p.url().includes('damage_entry')
    const scopes = [p, ...p.frames()]
    for (const s of scopes) {
      try {
        const hasSubComponent = await s.getByText(/^sub component$/i).first().isVisible({ timeout: 400 }).catch(() => false)
        const hasFailureType = await s.getByText(/failure type|type of failure/i).first().isVisible({ timeout: 400 }).catch(() => false)
        const hasInsideOutside = await s.getByText(/inside\/outside/i).first().isVisible({ timeout: 400 }).catch(() => false)
        if (isFormUrl || hasSubComponent || hasFailureType || hasInsideOutside) return true
      } catch {}
    }
    return false
  }

  let isFormReady = await checkFormReady(formPage)
  if (!isFormReady) {
    // Aguarda até 15 segundos caso o ServiceNow esteja renderizando o formulário —
    // generoso de propósito: sob carga (várias abas de vídeo subindo ao mesmo tempo),
    // 5s não bastava e a validação desistia cedo demais.
    for (let wait = 0; wait < 30; wait++) {
      await formPage.waitForTimeout(500)
      isFormReady = await checkFormReady(formPage)
      if (isFormReady) break
    }
  }

  // Se ainda assim não abriu o formulário e a tela continua no Inspection Report, tenta clicar novamente no botão Add Damage Entry
  if (!isFormReady) {
    log(`  ⚠ Formulário não abriu na 1ª tentativa. Tentando clicar novamente em 'Add Damage Entry'...`)
    const scopes = [formPage, ...formPage.frames()]
    for (const s of scopes) {
      const loc = s.locator('button, a', { hasText: /add damage entry|create damage entry/i }).first()
      if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {})
        await loc.click({ force: true, timeout: 3000 }).catch(() => {})
        break
      }
    }
    // Mais uma rodada de espera generosa (mesmo motivo do bloco acima) antes de
    // desistir de vez.
    for (let wait = 0; wait < 16; wait++) {
      await formPage.waitForTimeout(500)
      isFormReady = await checkFormReady(formPage)
      if (isFormReady) break
    }
  }

  if (!isFormReady) {
    log(`  ⚠ O formulário de cadastro não abriu na aba de destino. Recarregando página do relatório...`)
    await formPage.goto(incidentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    return null
  }

  return formPage
}

/** Confere, numa aba de vídeo já preenchida e deixada aberta (fase 3, cascata), se
 * o upload de fato TERMINOU de verdade — não só se os campos foram preenchidos
 * (isso é síncrono e sempre "funciona"), procurando o nome do arquivo de vídeo
 * aparecer na lista de anexos do próprio formulário. Mesma lógica de
 * `DamageEntryFiller.waitForAttachmentUploaded`, mas como função solta (chamada de
 * fora da classe, depois que todas as abas de vídeo da rodada já foram abertas —
 * ver comentário na Fase 3 de `runSnowDamageAutomation` sobre por que a checagem
 * roda DEPOIS de abrir todas as abas, não uma de cada vez). */
async function verifyVideoAttached(
  formPage: Page,
  expectedFilename: string,
  log: LogFn,
  timeoutMs: number = 180000
): Promise<boolean> {
  const pollIntervalMs = 1000
  const logEveryMs = 15000
  const start = Date.now()
  let lastLog = start
  while (Date.now() - start < timeoutMs) {
    const scopes = [formPage, ...formPage.frames()]
    for (const s of scopes) {
      const appeared = await s.getByText(expectedFilename, { exact: false }).first().isVisible({ timeout: 500 }).catch(() => false)
      if (appeared) return true
    }
    if (Date.now() - lastLog >= logEveryMs) {
      lastLog = Date.now()
      log(`  ⏳ Ainda conferindo upload de "${expectedFilename}"... (${Math.round((Date.now() - start) / 1000)}s)`)
    }
    await formPage.waitForTimeout(pollIntervalMs).catch(() => {})
  }
  return false
}

export async function runSnowDamageAutomation(
  excelPath: string,
  incidentUrl: string,
  options: RunAutomationOptions,
  log_fn?: LogFn
): Promise<RunAutomationResult> {
  const log = log_fn || (() => {})
  // Declarados FORA do try — precisam ficar acessíveis no catch de baixo pra
  // reportar progresso real (não zerado) quando a execução é interrompida no
  // meio por Parar (AutomationStoppedError) em vez de um erro de verdade.
  let processed = 0
  let failed = 0
  const errors: string[] = []
  let videosFilled = 0
  let videosFailed = 0
  try {
    const { rows: allRows } = await readDamageRows(excelPath)
    if (allRows.length === 0) {
      return { success: false, processed: 0, failed: 0, errors: [], error: 'Nenhuma linha válida na planilha.' }
    }

    // Mapeia previamente todas as fotos da pasta local Fotos/ do Módulo 23
    const photosMap = options.localPhotosDir ? buildLocalPhotosMap(options.localPhotosDir) : new Map()
    if (photosMap.size > 0) {
      log(`✓ Mapeamento prévio de fotos concluído: ${photosMap.size} conjunto(s) de fotos indexado(s).`)
    }

    // Filtragem opcional por Pás selecionadas pelo usuário
    let filteredRows = allRows
    if (options.selectedBlades && options.selectedBlades.length > 0) {
      const selectedSet = new Set(options.selectedBlades.map((b) => b.trim()))
      filteredRows = allRows.filter((r) => selectedSet.has(r.bladeSerialNumber.trim()))
      log(`Filtro por Pás ativo: ${options.selectedBlades.length} pá(s) selecionada(s) -> ${filteredRows.length} linha(s).`)
    }

    // Categorias independentes (Defeitos / Blank Images / Vídeos) — todas ligadas por
    // padrão. Desmarcar uma remove as linhas dessa categoria ANTES até da auditoria,
    // pra a categoria vídeo especificamente também pular a parte lenta da auditoria
    // (leitura de anexo) quando não for processar vídeo nenhum nessa rodada.
    const includeDefects = options.includeDefects ?? true
    const includeBlanks = options.includeBlanks ?? true
    const includeVideos = options.includeVideos ?? true
    const beforeCategoryFilter = filteredRows.length
    filteredRows = filteredRows.filter((r) => {
      if (isVideoRow(r)) return includeVideos
      if (r.isBlankImage) return includeBlanks
      return includeDefects
    })
    if (filteredRows.length !== beforeCategoryFilter) {
      log(`Categorias ativas: ${[includeDefects && 'Defeitos', includeBlanks && 'Blanks', includeVideos && 'Vídeos'].filter(Boolean).join(' + ')} -> ${filteredRows.length} linha(s).`)
    }

    if (filteredRows.length === 0) {
      return { success: false, processed: 0, failed: 0, errors: [], error: 'Nenhuma linha corresponde ao filtro selecionado.' }
    }

    const start = Math.max(0, (options.startRow ?? 1) - 1)
    const end = Math.min(filteredRows.length, options.endRow ?? filteredRows.length)
    let rows = filteredRows.slice(start, end)

    const autoSubmit = options.autoSubmit ?? false

    // Abre a página principal para realizar a auditoria prévia ao vivo dos defeitos já cadastrados no ServiceNow
    let auditContext: BrowserContext
    try {
      auditContext = await getContext(options.headless ?? false)
    } catch {
      await closeServiceNowSession()
      auditContext = await getContext(options.headless ?? false)
    }
    // SEMPRE abre uma aba nova — mesmo motivo do `authPage` em `runFullAutomation`
    // (ver comentário lá): abas de vídeo de OUTRAS turbinas/pás ficam abertas de
    // propósito esperando revisão manual, e "achar qualquer página aberta" no
    // contexto compartilhado podia acabar pegando uma delas por engano em vez de
    // uma página genuinamente livre — a auditoria rodava contra a aba errada.
    const auditPage = await auditContext.newPage()

    // Garante sessão logada ANTES de qualquer coisa — antes disso, era preciso
    // clicar em "Abrir p/ Login" manualmente antes de rodar, senão a automação
    // seguia direto numa tela de login/SSO e falhava de forma confusa mais
    // adiante (nem a auditoria nem o "Add Damage Entry" acham nada numa tela de
    // login). Essencial pra fila overnight: cada turbina reusa a mesma sessão,
    // então isso só realmente pausa/espera se a sessão tiver expirado.
    const ready = await ensureAuthenticatedPage(auditPage, incidentUrl, log, options.headless ?? false)
    if (!ready) {
      return {
        success: false,
        processed: 0,
        failed: 0,
        errors: [],
        error: 'Sessão do ServiceNow não autenticada (login necessário).'
      }
    }

    const { auditSet, blankImageCount } = await auditLiveDamageEntries(auditPage, log, !includeVideos)

    // Filtra ANTES de começar (era aqui que o resultado da auditoria era descartado —
    // a mensagem de log rodava, mas nada era de fato usado pra pular linha nenhuma).
    // "Blank Image" fica de fora desse filtro por pá+DF: quando submetida, o Módulo
    // reatribui um blade serial real, então ela apareceria na tabela indistinguível de
    // um defeito de verdade daquela pá — casar por pá+DF arriscaria confundir uma
    // Blank Image já cadastrada com um defeito real ainda não cadastrado (ou vice
    // versa). Tratada à parte logo abaixo, por CONTAGEM.
    if (auditSet.size > 0) {
      const beforeLiveFilter = rows.length
      rows = rows.filter((r) => r.isBlankImage || !rowAlreadyInLiveTable(r, auditSet))
      const skippedLive = beforeLiveFilter - rows.length
      if (skippedLive > 0) {
        log(`ℹ ${skippedLive} linha(s) já cadastrada(s) no ServiceNow (detectado ao vivo) foram ignoradas. (${rows.length} restante(s))`)
      }

      // Diagnóstico: pra cada linha de defeito normal (não Blank/vídeo) que sobrou pra
      // processar, loga as chaves que ela gera — dá pra comparar direto com o que a
      // auditoria encontrou na tabela (linhas "tratando como duplicata..." acima) e
      // confirmar se bateu ou não, sem precisar adivinhar.
      for (const r of rows) {
        if (!r.isBlankImage && !isVideoRow(r)) {
          log(`  🔎 [debug] Vai processar: ${r.bladeSerialNumber} | ${r.subComponent} | ${r.failureType} | DF ${r.dfDistanceStart} — chaves: ${damageRowAuditKeys(r).join(' | ')}`)
        }
      }
    }

    // "Blank Image" não tem como ser casada linha a linha (ver comentário acima) — em
    // vez disso, conta quantas já existem no ServiceNow (via Damage Description "Empty
    // entry") e só deixa passar o suficiente pra completar as 5 exigidas por turbina,
    // descartando o excedente. Preserva a ordem das outras linhas na planilha.
    const blankImagesNeeded = Math.max(0, 5 - blankImageCount)
    let blankImagesKept = 0
    const beforeBlankFilter = rows.length
    rows = rows.filter((r) => {
      if (!r.isBlankImage) return true
      if (blankImagesKept < blankImagesNeeded) {
        blankImagesKept++
        return true
      }
      return false
    })
    const skippedBlank = beforeBlankFilter - rows.length
    if (skippedBlank > 0) {
      log(`ℹ ${skippedBlank} linha(s) "Blank Image" ignoradas — já existem ${blankImageCount} no ServiceNow, precisa de só mais ${blankImagesNeeded} pra completar as 5 exigidas.`)
    }

    // Fila em fases, na ordem pedida: 1) Defeitos normais, 2) Blank Images, 3) Vídeos.
    // Vídeo é tratado à parte (fase 3, depois do loop principal) — preenchimento é
    // quase instantâneo (é cópia/cola), mas o upload do vídeo demora bem mais (dava
    // pra terminar 3-4 formulários no tempo de 1 upload). Bloquear o loop principal
    // esperando cada upload terminar desperdiçava esse tempo à toa. Manter os vídeos
    // FORA do loop principal (em vez de interpolados) evita misturar os dois modelos
    // de execução (síncrono/aba única vs. cascata/múltiplas abas) no meio do processamento.
    const videoRows = rows.filter((r) => isVideoRow(r))
    const nonVideoRows = [
      ...rows.filter((r) => !isVideoRow(r) && !r.isBlankImage),
      ...rows.filter((r) => !isVideoRow(r) && r.isBlankImage)
    ]

    log(`${nonVideoRows.length} defeito(s)/blank(s) + ${videoRows.length} vídeo(s) a processar (Modo: ${autoSubmit ? 'Submissão Automática' : 'Conferência Manual'}).`)

    // Modo auditoria (dry run): já rodou a mesma leitura da planilha + auditoria ao
    // vivo do ServiceNow que uma execução normal roda — só não entra na fase de
    // preenchimento. `nonVideoRows`/`videoRows` nesse ponto JÁ são exatamente as
    // linhas que sobraram depois de descartar tudo que a auditoria confirmou como já
    // cadastrado — ou seja, exatamente o que falta.
    if (options.dryRun) {
      const missingDefects = nonVideoRows.filter((r) => !r.isBlankImage).length
      const missingBlanks = nonVideoRows.filter((r) => r.isBlankImage).length
      const missingVideos = videoRows.length
      const totalMissing = missingDefects + missingBlanks + missingVideos

      log(`\n🔍 MODO AUDITORIA (dry run) — nada foi preenchido, só conferido.`)
      log(`  • Defeitos faltando: ${missingDefects}`)
      log(`  • Blank Images faltando: ${missingBlanks}`)
      log(`  • Vídeos faltando: ${missingVideos}`)

      if (totalMissing === 0) {
        log(`✓ Nada faltando — tudo que está na planilha já foi encontrado no ServiceNow.`)
      } else {
        for (const r of nonVideoRows) {
          const tag = r.isBlankImage ? 'Blank Image' : `${r.subComponent} | ${r.failureType}`
          log(`  ⚠ FALTA: ${r.bladeSerialNumber} | ${tag} | DF ${r.dfDistanceStart}-${r.dfDistanceEnd}`)
        }
        for (const r of videoRows) {
          log(`  🎬 FALTA: ${r.bladeSerialNumber} | ${r.bladeSection || '?'} ${r.bladeArea || '?'} | Vídeo DF 45-50`)
        }
      }

      return {
        success: true,
        processed: 0,
        failed: 0,
        errors: [],
        dryRun: true,
        missingDefects,
        missingBlanks,
        missingVideos
      }
    }

    // ─── Fase 0 (vídeo): dispara o upload de TODOS os vídeos ANTES dos defeitos ───
    // Upload de vídeo é lento no ServiceNow por natureza (processamento do lado do
    // servidor), não por disputa de banda entre abas — então cascatear várias abas
    // ao mesmo tempo não ajuda nem atrapalha o tempo de cada upload individual.
    // O que importa é QUANDO esse tempo de espera é gasto: preencher um defeito
    // (vários campos em cascata) demora bem mais, no relógio, do que preencher os
    // poucos campos de um vídeo. Antes, o vídeo só começava a subir DEPOIS que
    // todos os defeitos já tinham terminado — desperdiçando exatamente o tempo em
    // que o upload podia estar rodando de graça em segundo plano. Agora dispara
    // aqui, no início, pra usar o tempo (maior) da Fase 1 como janela de upload —
    // quando a auditoria de vídeo rodar lá embaixo, depois dos defeitos, a maior
    // parte já deve ter terminado, então a checagem tende a ser rápida em vez de
    // estourar timeout.
    type OpenVideoTab = { row: DamageReportRow; formPage: Page; filler: DamageEntryFiller; expectedFilename: string; prefix: string }

    const fillVideoTab = async (row: DamageReportRow, prefix: string): Promise<OpenVideoTab | 'skip'> => {
      let context: BrowserContext
      try {
        context = await getContext(options.headless ?? false)
      } catch {
        await closeServiceNowSession()
        context = await getContext(options.headless ?? false)
      }

      const targetPage = await context.newPage()
      registerTab(targetPage, { purpose: 'video-review', blade: row.bladeSerialNumber, label: 'Vídeo (DF 45-50)' })
      await targetPage.bringToFront().catch(() => {})
      await targetPage.goto(incidentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})

      const existsInSnow = await checkRowExistsInLiveTable(targetPage, row)
      if (existsInSnow) {
        log(`  ℹ [SNOW Live Audit] ${prefix} já cadastrado na tabela do ServiceNow. Pulando...`)
        await targetPage.close().catch(() => {})
        return 'skip'
      }

      const formPage = await openDamageEntryForm(context, targetPage, incidentUrl, log)
      if (!formPage) {
        throw new Error("A tela 'Create Damage Entry' não carregou a tempo.")
      }

      let localPhotos = options.localPhotosDir
        ? findLocalPhotosFromMap(photosMap, row)
        : []
      if (localPhotos.length === 0 && options.localPhotosDir) {
        localPhotos = findLocalPhotosForDamage(options.localPhotosDir, row)
      }

      const filler = new DamageEntryFiller(formPage, (m) => log(`  ${prefix} ${m}`))
      // autoSubmit=false aqui SEMPRE, mesmo em modo Submissão Automática — só
      // submete depois de confirmar o upload de verdade (feito lá embaixo, depois
      // da Fase 1), nunca antes.
      await filler.fill(row, localPhotos, false, false)

      const videoPath = localPhotos.find((p) => isVideoFile(p))
      const expectedFilename = videoPath ? path.basename(videoPath) : ''
      log(`  ✓ ${prefix} Preenchido e upload iniciado: ${row.bladeSerialNumber}.`)
      return { row, formPage, filler, expectedFilename, prefix }
    }

    const MAX_VIDEO_ROUNDS = 3
    let videoOpenTabs: OpenVideoTab[] = []

    if (videoRows.length > 0) {
      log(`🎬 ${videoRows.length} vídeo(s) — disparando upload de cada um antes dos defeitos, pra usar o tempo de preenchimento da Fase 1 como janela de upload.`)
      for (let vi = 0; vi < videoRows.length; vi++) {
        await checkpoint(log)
        const row = videoRows[vi]
        const prefix = `[Vídeo ${vi + 1}/${videoRows.length}]`
        try {
          const result = await fillVideoTab(row, prefix)
          if (result !== 'skip') videoOpenTabs.push(result)
        } catch (err: any) {
          videosFailed++
          const msg = `✗ ${prefix} FALHOU: ${row.bladeSerialNumber}: ${err.message}`
          errors.push(msg)
          log(msg)
        }
      }
    }

    // ─── Fase 1+2: Defeitos normais e Blank Images, sequencial (como sempre foi) ───
    // Roda em RODADAS de retentativa automática: linhas que falharem numa rodada
    // (timeout, dropdown travado do SNOW, etc.) são retentadas na rodada seguinte, até
    // 3 rodadas no total ou até uma rodada não reduzir nada (sinal de que o problema é
    // persistente, não vale insistir mais) — ideia do usuário, pra não precisar rodar
    // a automação duas vezes manualmente só pra pegar o que falhou na primeira.
    const MAX_ROUNDS = 3
    let currentRoundRows = nonVideoRows

    // Em modo Submissão Automática, a MESMA aba é reaproveitada entre linhas dessa
    // turbina (design intencional: preenche, submete, clica "Add Damage Entry" de
    // novo na mesma aba, sem o custo de abrir uma aba nova a cada defeito). Antes,
    // "qual aba reaproveitar" era decidido buscando `context.pages().find(p =>
    // !p.isClosed())` no CONTEXTO INTEIRO — bug real diagnosticado pelo usuário:
    // as abas de VÍDEO ficam abertas de propósito esperando revisão manual (de
    // QUALQUER pá/turbina já processada nessa sessão, não só a atual), e essa
    // busca não distinguia "uma aba livre pra reaproveitar" de "a aba de vídeo de
    // outra pá esperando o humano revisar" — a próxima linha podia acabar
    // preenchendo o formulário EM CIMA da aba de vídeo errada, misturando dados de
    // pás diferentes. Corrigido rastreando a página explicitamente numa variável
    // local (só dessa turbina, só desse loop) em vez de "adivinhar" no contexto
    // compartilhado — nunca aponta pra aba de vídeo nenhuma, sempre pra própria
    // aba que este loop mesmo abriu.
    let sharedAutoSubmitPage: Page | null = null

    for (let round = 1; round <= MAX_ROUNDS && currentRoundRows.length > 0; round++) {
      if (round > 1) {
        log(`🔁 Rodada ${round}/${MAX_ROUNDS} de retentativa — ${currentRoundRows.length} linha(s) que falharam antes...`)
      }
      const failedThisRound: DamageReportRow[] = []

      for (let i = 0; i < currentRoundRows.length; i++) {
        // Ponto de checagem — sempre ENTRE linhas, nunca no meio de preencher
        // um formulário. Deixa propagar direto (não passa pelo catch de baixo,
        // que trataria como falha de linha) até o topo da função.
        await checkpoint(log)

        const row = currentRoundRows[i]
        const prefix = `[${round > 1 ? `R${round} ` : ''}${i + 1}/${currentRoundRows.length}]`
        // Fora do try pra ficar acessível no catch — precisa disso pra poder fechar a
        // aba se der erro (ver comentário no catch, bug de dropdown travado do SNOW).
        let formPage: Page | null = null
        try {
        let context: BrowserContext
        try {
          context = await getContext(options.headless ?? false)
        } catch {
          await closeServiceNowSession()
          context = await getContext(options.headless ?? false)
        }

        let targetPage: Page
        if (autoSubmit) {
          if (!sharedAutoSubmitPage || sharedAutoSubmitPage.isClosed()) {
            sharedAutoSubmitPage = await context.newPage()
            registerTab(sharedAutoSubmitPage, { purpose: 'transient', label: 'defeitos (auto)' })
          }
          targetPage = sharedAutoSubmitPage
        } else {
          // No modo de conferência manual: abre uma NOVA ABA exclusiva no Chrome para cada linha i
          targetPage = await context.newPage()
          registerTab(targetPage, {
            purpose: 'defect-review',
            blade: row.bladeSerialNumber,
            label: `${row.subComponent} | ${row.failureType}`
          })
        }

        await targetPage.bringToFront().catch(() => {})

        // Compara a URL INTEIRA (com query — é ali que mora o sys_id que distingue
        // um incidente/turbina do outro), não só o caminho antes do "?". Bug real
        // achado na fila overnight: comparando só a base (mesma pra qualquer
        // incidente do ServiceNow), a aba reaproveitada "parecia" já estar no lugar
        // certo e nunca navegava — preenchia dados em cima da página errada.
        if (targetPage.url() !== incidentUrl) {
          await targetPage.goto(incidentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
        }

        // Checagem ao vivo na tabela Damage Report Entries do ServiceNow
        const existsInSnow = await checkRowExistsInLiveTable(targetPage, row)
        if (existsInSnow) {
          log(`  ℹ [SNOW Live Audit] Entrada para ${row.bladeSerialNumber} (${row.subComponent} DF ${row.dfDistanceStart}-${row.dfDistanceEnd}) já cadastrada na tabela do ServiceNow. Pulando...`)
          if (!autoSubmit && context.pages().length > 1) {
            await targetPage.close().catch(() => {})
          }
          continue
        }

        formPage = await openDamageEntryForm(context, targetPage, incidentUrl, log)
        if (!formPage) {
          throw new Error("A tela 'Create Damage Entry' não carregou a tempo.")
        }

        // Cruza a linha atual com o mapa pré-indexado de fotos
        let localPhotos = options.localPhotosDir
          ? findLocalPhotosFromMap(photosMap, row)
          : []

        if (localPhotos.length === 0 && options.localPhotosDir) {
          localPhotos = findLocalPhotosForDamage(options.localPhotosDir, row)
        }

        const filler = new DamageEntryFiller(formPage, (m) => log(`  ${prefix} ${m}`))
        await filler.fill(row, localPhotos, autoSubmit)

        processed++

        log(`✓ ${prefix} OK: ${row.bladeSerialNumber} — ${row.failureType}`)

        if (autoSubmit) {
          await formPage.waitForTimeout(2000)
          const scopes = [formPage, ...formPage.frames()]
          let canSeeCreateBtn = false
          for (const s of scopes) {
            const hasBtn = await s.getByRole('button', { name: /create damage entry|add damage entry|nova entrada/i }).isVisible({ timeout: 500 }).catch(() => false)
            if (hasBtn) {
              canSeeCreateBtn = true
              break
            }
          }

          if (!canSeeCreateBtn) {
            await formPage.goto(incidentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
          }
        } else {
          log(`  ℹ Formulário [${i + 1}/${currentRoundRows.length}] mantido aberto na tela para revisão. Avançando para a próxima linha...`)
        }
      } catch (err: any) {
        const msg = `✗ ${prefix} FALHOU: ${row.bladeSerialNumber} — ${row.failureType}: ${err.message}`
        log(msg)
        failedThisRound.push(row)

        // Bug conhecido do ServiceNow (relatado pelo usuário): quando duas pessoas
        // sobem defeitos ao mesmo tempo, os dropdowns às vezes travam mostrando só
        // "--None--" pra sempre NAQUELA aba/formulário — não é algo que "destrava"
        // tentando de novo na mesma aba (por isso `selectFromComboBox` já teve
        // retentativa e mesmo assim falhou). Em modo automático a aba é reaproveitada
        // entre linhas — sem fazer nada aqui, a próxima linha herdaria a MESMA aba
        // travada e falharia de novo, e de novo, indefinidamente. Descarta a aba
        // (fecha) — a checagem `context.pages().find(p => !p.isClosed())` no início
        // da próxima linha não vai mais achar essa aba fechada, e abre uma nova do
        // zero, "resetando" o problema (ideia do usuário).
        //
        // CUIDADO (apontado pelo usuário): se essa for a ÚNICA aba aberta no contexto,
        // fechar ela pode derrubar a janela do navegador inteira antes da próxima linha
        // ter chance de abrir uma nova — dependendo de como o Windows/Chromium tratam
        // fechar a última aba de uma janela. Por isso abre uma aba nova EM BRANCO
        // primeiro, e só DEPOIS fecha a travada — nunca fica com zero abas abertas.
        if (autoSubmit && formPage) {
          try {
            const ctx = await getContext(options.headless ?? false)
            await ctx.newPage().catch(() => {})
          } catch {
            /* se nem isso der certo, tenta fechar mesmo assim — o próximo getContext() já tem fallback de reabrir a sessão inteira */
          }
          await formPage.close().catch(() => {})
          log(`  ℹ Aba descartada por causa da falha — a próxima linha abre uma aba nova.`)
        }
      }
      } // fim do for de linhas da rodada

      if (failedThisRound.length === 0) break // rodada inteira sem falha — não precisa de mais rodadas

      const noProgress = failedThisRound.length === currentRoundRows.length
      if (round === MAX_ROUNDS || noProgress) {
        // Desiste de vez — contabiliza como falha final só agora (evita contar a
        // mesma linha como "falha" mais de uma vez entre rodadas).
        failed += failedThisRound.length
        for (const row of failedThisRound) {
          errors.push(`✗ FALHOU definitivamente após ${round} tentativa(s): ${row.bladeSerialNumber} — ${row.failureType}`)
        }
        if (noProgress && round < MAX_ROUNDS) {
          log(`⚠ Rodada ${round} não conseguiu reduzir o que falta (${failedThisRound.length} linha(s) continuam falhando) — parando de tentar, provavelmente é um problema persistente.`)
        }
        break
      }
      currentRoundRows = failedThisRound
    }

    if (!autoSubmit) {
      log(`ℹ Defeitos/Blanks concluídos! ${processed} formulário(s) preenchido(s) com sucesso e mantido(s) aberto(s) em abas/janelas para sua revisão final.`)
    }

    // ─── Fase 3: confere (e, se Submissão Automática, submete) os vídeos disparados
    // no início — a essa altura, depois do tempo inteiro gasto preenchendo os
    // defeitos na Fase 1, a maior parte dos uploads já deve ter terminado sozinha.
    if (videoRows.length > 0 && !autoSubmit) {
      // Modo Conferência Manual: o vídeo NUNCA é submetido sozinho de qualquer
      // forma — o Submit final é sempre do inspetor. Conferir o upload aqui só
      // faria sentido se a confirmação decidisse submeter automaticamente, o que
      // não acontece nesse modo — então não confere nada, só reporta quantos
      // foram disparados no início; as abas seguem abertas pra revisão manual.
      videosFilled = videoOpenTabs.length
      log(`🎬 Vídeos: ${videosFilled} disparado(s) aguardando revisão manual, ${videosFailed} falha(s) ao preencher.`)
    } else if (videoRows.length > 0 && autoSubmit) {
      // Submissão Automática: só vale a pena conferir o upload porque a
      // confirmação AUTORIZA o Submit — sem essa checagem o formulário submeteria
      // sem esperar o anexo terminar de subir. Confirmou -> submete e grava o
      // número da entrada na planilha. Não confirmou -> descarta a aba e
      // reprocessa a linha (reabre e repreenche do zero) até `MAX_VIDEO_ROUNDS`
      // rodadas — como o vídeo foi disparado bem antes (não logo antes da
      // checagem), a maioria já deve confirmar na 1ª rodada.
      log(`🎬 Conferindo upload dos ${videoOpenTabs.length} vídeo(s) disparados no início — Submissão Automática: só submete quando confirmar.`)

      let tabsToCheck = videoOpenTabs

      for (let round = 1; round <= MAX_VIDEO_ROUNDS && tabsToCheck.length > 0; round++) {
        if (round > 1) {
          log(`🔁 Rodada ${round}/${MAX_VIDEO_ROUNDS} de vídeo — ${tabsToCheck.length} upload(s) não confirmado(s), reprocessando...`)
        }

        const failedThisRound: DamageReportRow[] = []
        for (const tab of tabsToCheck) {
          if (!tab.expectedFilename) {
            // Não deu pra identificar o arquivo de vídeo esperado (nome local não
            // achado) — não dá pra confirmar o upload, então não submete; fica
            // aberta pra revisão manual em vez de forçar retentativa eterna.
            videosFailed++
            log(`  ⚠ ${tab.prefix} Não foi possível identificar o nome do arquivo esperado — deixando aberta sem confirmar/submeter.`)
            continue
          }
          const confirmed = await verifyVideoAttached(tab.formPage, tab.expectedFilename, log)
          if (!confirmed) {
            log(`  ⚠ ${tab.prefix} Upload de "${tab.expectedFilename}" NÃO confirmado — descartando aba e reprocessando essa linha.`)
            await tab.formPage.close().catch(() => {})
            failedThisRound.push(tab.row)
            continue
          }

          try {
            await tab.filler.submitAndReadEntry()
            videosFilled++
            log(`  ✓ ${tab.prefix} Upload confirmado e entrada submetida: "${tab.expectedFilename}".`)
            await tab.formPage.close().catch(() => {})
          } catch (err: any) {
            videosFailed++
            errors.push(`✗ ${tab.prefix} Upload confirmado mas falhou ao submeter: ${tab.row.bladeSerialNumber}: ${err.message}`)
            log(`  ✗ ${tab.prefix} Upload confirmado mas falhou ao submeter: ${err.message}`)
          }
        }

        if (failedThisRound.length === 0) break
        if (round === MAX_VIDEO_ROUNDS) {
          videosFailed += failedThisRound.length
          for (const row of failedThisRound) {
            errors.push(`✗ Vídeo não confirmou upload após ${round} rodada(s): ${row.bladeSerialNumber}`)
          }
          log(`⚠ ${failedThisRound.length} vídeo(s) não confirmaram upload mesmo após ${round} rodadas — reportando como falha, não vai tentar de novo.`)
          break
        }

        // Reabre e repreenche do zero as linhas que falharam, pra tentar de novo
        // na próxima rodada.
        const reopened: OpenVideoTab[] = []
        for (let vi = 0; vi < failedThisRound.length; vi++) {
          const row = failedThisRound[vi]
          const prefix = `[Vídeo R${round + 1} ${vi + 1}/${failedThisRound.length}]`
          try {
            const result = await fillVideoTab(row, prefix)
            if (result !== 'skip') reopened.push(result)
          } catch (err: any) {
            videosFailed++
            const msg = `✗ ${prefix} FALHOU: ${row.bladeSerialNumber}: ${err.message}`
            errors.push(msg)
            log(msg)
          }
        }
        tabsToCheck = reopened
      }

      log(`🎬 Vídeos concluídos: ${videosFilled} submetido(s) automaticamente, ${videosFailed} falha(s).`)
    }

    log(`Concluído: ${processed} ok, ${failed} falha(s) de ${nonVideoRows.length} defeito(s)/blank(s)${videoRows.length > 0 ? `; ${videosFilled} vídeo(s) ok, ${videosFailed} falha(s)` : ''}.`)
    return { success: true, processed, failed, errors, videosFilled, videosFailed }
  } catch (err: any) {
    if (err instanceof AutomationStoppedError) {
      log(`⏹ Parado pelo usuário — ${processed} ok, ${failed} falha(s) até o momento.`)
      return { success: true, processed, failed, errors, videosFilled, videosFailed, stopped: true }
    }
    return { success: false, processed, failed, errors, error: err.message }
  }
}


