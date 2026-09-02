import fs from 'fs'
import os from 'os'
import { join } from 'path'
import path from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import icon from '../../resources/icon.png?asset'

// Import Services
import { packerPlataforma } from './services/packer'
import {
  analisarBladeSplit,
  analisarGoProRaw,
  analisarWorkflow,
  buscarSmartsheetApi,
  calibrarZGoProRaw,
  carregarFotosGps,
  carregarFotosReconstruir,
  converterCsv,
  corrigirBladeSplit,
  corrigirZ0,
  detectarEstruturaAbc,
  extrairGpsZ,
  fetchEmailViaImap,
  gerarPlanilhaSrPendente,
  jsonParaCsvOrganizar,
  lerJsonReferenciaPixelMm,
  organizarFotosJson,
  organizarImagens,
  padronizarGoPro,
  processarJson,
  reconstruirCsv,
  reconstruirCsvMulti,
  recuperarFotosPerdidas,
  vincularArthnexCsv,
} from './services/workflow'

import {
  getDebugMode,
  getLastPaths,
  getThemeMode,
  setDebugMode,
  setLastPaths,
  setThemeMode,
} from './services/appConfig'
import { ArthnexEnv, arthnexApi } from './services/arthnexApi'
import {
  pauseAutomation,
  resetAutomationControl,
  resumeAutomation,
  stopAutomation,
} from './services/automationControl'
import { batchStitchDirectory } from './services/batch360Stitcher'
import {
  extractHorizonTaskIdsFromXlsx,
  horizonAnalisar,
  horizonCorrigirDamagesDireto,
  horizonGerarPacote,
  horizonProcessarFromArthnex,
  horizonValidarRequisitos,
  listXlsxSheets,
} from './services/horizon'
import {
  getLogsDir,
  markCurrentRun,
  setCurrentRunLogger,
  wrapWithRunLogger,
} from './services/runLogger'
import {
  closeServiceNowSession,
  getSpreadsheetBlades,
  openServiceNowForLogin,
  readTurbineIncList,
  runFullAutomation,
  runInspectionReportPhase,
  runSnowDamageAutomation,
} from './services/snowAutomation'
import {
  processSnowExcel,
  processSnowExcelBatch,
  processSnowFromArthnex,
} from './services/snowProcessor'
import {
  closeAllReviewTabs,
  closeTab,
  listReviewTabs,
  startTabSweep,
} from './services/tabRegistry'
import {
  analisarAmbiguidadesCsvs,
  descobrirCsvsUpload,
  listarPasPendentes,
  listarWorkorders,
  obterHierarquiaWorkorder,
  uploadMultiplasCsv,
} from './services/uploader'
import { substituirVideos360 } from './services/videoReplacer'
import { enviarVideosDrive } from './services/videoUploader'
import {
  deleteWindfarmConfig,
  listWindfarmConfigs,
  saveWindfarmConfig,
} from './services/windfarmConfig'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1050,
    height: 750,
    show: false,
    autoHideMenuBar: true,
    icon: icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler(details => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register IPC handlers when ready
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.arthwind.suite')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ─── Preference Config IPC Handlers ──────────────────────────────────────────
  ipcMain.handle('get_debug_mode', () => {
    return getDebugMode()
  })

  ipcMain.handle('set_debug_mode', (_event, enabled: boolean) => {
    try {
      setDebugMode(enabled)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get_theme_mode', () => {
    return getThemeMode()
  })

  ipcMain.handle('set_theme_mode', (_event, mode: string) => {
    try {
      setThemeMode(mode)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get_last_paths', () => {
    return getLastPaths()
  })

  ipcMain.handle('set_last_paths', (_event, paths: any) => {
    try {
      setLastPaths(paths)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── File Pickers & OS integrations ──────────────────────────────────────────
  ipcMain.handle('pick_file', async (_event, fileType?: string) => {
    let filters: { name: string; extensions: string[] }[] = []
    if (fileType === 'excel') {
      filters = [{ name: 'Excel Files', extensions: ['xlsx', 'xls'] }]
    } else if (fileType === 'csv') {
      filters = [{ name: 'CSV Files', extensions: ['csv'] }]
    } else if (fileType === 'json') {
      filters = [{ name: 'JSON Files', extensions: ['json'] }]
    } else if (fileType === 'all') {
      filters = [{ name: 'All Files', extensions: ['*'] }]
    }

    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters,
    })
    if (result.canceled) return null
    return result.filePaths[0] || null
  })

  ipcMain.handle('pick_files', async (_event, fileType?: string) => {
    let filters: { name: string; extensions: string[] }[] = []
    if (fileType === 'excel') {
      filters = [{ name: 'Excel Files', extensions: ['xlsx', 'xls'] }]
    } else if (fileType === 'csv') {
      filters = [{ name: 'CSV Files', extensions: ['csv'] }]
    } else if (fileType === 'json') {
      filters = [{ name: 'JSON Files', extensions: ['json'] }]
    }

    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters,
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle('pick_folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    if (result.canceled) return null
    return result.filePaths[0] || null
  })

  ipcMain.handle('open_folder', async (_event, folderPath: string) => {
    if (folderPath) {
      try {
        let target = folderPath
        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isFile()) {
          target = path.dirname(folderPath)
        }
        if (fs.existsSync(target)) {
          await shell.openPath(target)
        }
      } catch (err) {
        console.error('Error opening folder:', err)
      }
    }
  })

  ipcMain.handle(
    'save_image',
    async (_event, base64Data: string, defaultName: string) => {
      try {
        const desktop = path.join(os.homedir(), 'Desktop')
        const destPath = path.join(desktop, defaultName)
        let cleanBase64 = base64Data
        if (base64Data.includes(',')) {
          cleanBase64 = base64Data.split(',')[1]
        }
        const buffer = Buffer.from(cleanBase64, 'base64')
        fs.writeFileSync(destPath, buffer)
        shell.showItemInFolder(destPath)
        return { success: true, path: destPath }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  // ─── Services IPC Handlers ───────────────────────────────────────────────────
  // Vários módulos de workflow.ts são disparados pelo renderer no estilo "fire-and-forget"
  // (usePyWebView.js chama a API sem aguardar a Promise, e só sai do estado "rodando"
  // quando recebe o evento 'arthdone') — sem emitir esse evento, a UI fica girando pra
  // sempre. `withArthDone` garante a emissão exatamente uma vez ao final (sucesso OU erro),
  // não importa quantos `return` existam dentro da função de serviço — mais seguro do que
  // cada função lembrar de emitir isso sozinha em todo caminho de saída.
  function withArthDone<
    T extends (
      event: Electron.IpcMainInvokeEvent,
      ...args: any[]
    ) => Promise<any>,
  >(handler: T) {
    return async (
      event: Electron.IpcMainInvokeEvent,
      ...args: Parameters<T> extends [any, ...infer R] ? R : never
    ) => {
      try {
        return await handler(event, ...args)
      } finally {
        event.sender.send('arthdone', {})
      }
    }
  }

  ipcMain.handle(
    'organizar_imagens',
    withArthDone(
      (
        event,
        csvPath: string,
        fotosDir: string,
        mode: string,
        dryRun: boolean
      ) => {
        return organizarImagens(csvPath, fotosDir, mode, dryRun, event.sender)
      }
    )
  )

  ipcMain.handle(
    'json_para_csv_organizar',
    withArthDone((event, jsonPath: string) => {
      return jsonParaCsvOrganizar(jsonPath, event.sender)
    })
  )

  ipcMain.handle(
    'processar_json',
    withArthDone((event, jsonPath: string) => {
      return processarJson(jsonPath, event.sender)
    })
  )

  ipcMain.handle(
    'organizar_fotos',
    withArthDone((event, jsonPath: string, sourceFolder: string) => {
      return organizarFotosJson(jsonPath, sourceFolder, event.sender)
    })
  )

  ipcMain.handle(
    'converter_csv',
    withArthDone((event, csvPath: string, gerarXlsx: boolean) => {
      return converterCsv(csvPath, gerarXlsx, event.sender)
    })
  )

  ipcMain.handle(
    'extrair_gps_z',
    withArthDone((event, pasta: string, raizNome: string) => {
      return extrairGpsZ(pasta, raizNome, event.sender)
    })
  )

  ipcMain.handle(
    'corrigir_z_zero',
    withArthDone(
      (event, csvPath: string, fotosDir: string, raizNome: string) => {
        return corrigirZ0(csvPath, fotosDir, raizNome, event.sender)
      }
    )
  )

  ipcMain.handle(
    'recuperar_fotos_perdidas',
    withArthDone((event, jsonPath: string, fotosDir: string) => {
      return recuperarFotosPerdidas(jsonPath, fotosDir, event.sender)
    })
  )

  ipcMain.handle(
    'reconstruir_csv',
    withArthDone((event, pasta: string, bladeSn: string, sides: any[]) => {
      return reconstruirCsv(pasta, bladeSn, sides, event.sender)
    })
  )

  // packer_plataforma já emite 'arthdone' internamente (packer.ts) — não precisa do wrapper.
  ipcMain.handle('packer_plataforma', (event, pasta: string) => {
    return packerPlataforma(pasta, event.sender)
  })

  ipcMain.handle(
    'arthnex_organizar',
    withArthDone((event, fotosDir: string, dryRun: boolean) => {
      return padronizarGoPro(fotosDir, dryRun, event.sender)
    })
  )

  ipcMain.handle(
    'calibrar_z_gopro_raw',
    withArthDone(
      (
        event,
        pastaBlade: string,
        turbine: string,
        bladeSn: string,
        referencias: any
      ) => {
        return calibrarZGoProRaw(
          pastaBlade,
          turbine,
          bladeSn,
          referencias,
          event.sender
        )
      }
    )
  )

  ipcMain.handle(
    'vincular_arthnex_csv',
    withArthDone((event, csvPath: string, fotosDir: string) => {
      return vincularArthnexCsv(csvPath, fotosDir, event.sender)
    })
  )

  // As três abaixo (GPS, Blade Split, GoPro RAW) alimentam um botão "Analisar" na UI que
  // fica esperando um evento (gps_fotos_loaded / blade_split_analise / gopro_raw_analise)
  // pra sair do estado de loading — sem emitir o evento, o botão gira pra sempre mesmo
  // com o resultado já pronto no retorno da própria função.
  ipcMain.handle('carregar_fotos_gps', async (event, pasta: string) => {
    const fotos = await carregarFotosGps(pasta, event.sender)
    event.sender.send('gps_fotos_loaded', { fotos })
    return fotos
  })

  ipcMain.handle(
    'analisar_blade_split',
    async (event, filePath: string, threshold: number) => {
      const suspeitos = await analisarBladeSplit(
        filePath,
        threshold,
        event.sender
      )
      event.sender.send('blade_split_analise', { suspeitos })
      return suspeitos
    }
  )

  ipcMain.handle('carregar_fotos_reconstruir', (event, pasta: string) => {
    return carregarFotosReconstruir(pasta, event.sender)
  })

  ipcMain.handle('analisar_gopro_raw', async (event, pastaBlade: string) => {
    const regioes = await analisarGoProRaw(pastaBlade, event.sender)
    event.sender.send('gopro_raw_analise', { regioes })
    return regioes
  })

  ipcMain.handle(
    'substituir_videos_360',
    withArthDone(
      (event, outputFolder: string, targetFolder: string, dryRun: boolean) => {
        return substituirVideos360(
          outputFolder,
          targetFolder,
          dryRun,
          event.sender
        )
      }
    )
  )

  ipcMain.handle(
    'enviar_videos_drive',
    withArthDone(
      (event, localFolder: string, driveFolder: string, dryRun: boolean) => {
        return enviarVideosDrive(localFolder, driveFolder, dryRun, event.sender)
      }
    )
  )

  ipcMain.handle(
    'corrigir_blade_split',
    withArthDone((event, filePath: string, correcoes: any[]) => {
      return corrigirBladeSplit(filePath, correcoes, event.sender)
    })
  )

  // ─── Workflow & Smartsheet Auditor IPC Handlers ──────────────────────────────
  ipcMain.handle(
    'testar_conexao_imap',
    async (
      _event,
      host,
      port,
      username,
      password,
      use_ssl = true,
      subject_filter = ''
    ) => {
      const res = await fetchEmailViaImap({
        host,
        port,
        username,
        password,
        use_ssl,
        subject_filter,
      })
      if (res.success) {
        return {
          success: true,
          message: 'Conectado com sucesso à caixa de entrada!',
        }
      }
      return { success: false, error: res.error || 'Erro desconhecido' }
    }
  )

  ipcMain.handle(
    'buscar_smartsheet_api',
    (_event, sheetId: string, token?: string) => {
      return buscarSmartsheetApi(sheetId, token)
    }
  )

  ipcMain.handle(
    'analisar_workflow',
    (
      event,
      smartsheetPath: string,
      startDate?: string,
      endDate?: string,
      vendorPath?: string,
      emailContent?: string,
      emailFilePath?: string,
      imapConfig?: any,
      operationalFormPath?: string
    ) => {
      return analisarWorkflow(
        smartsheetPath,
        startDate,
        endDate,
        vendorPath,
        emailContent,
        emailFilePath,
        imapConfig,
        operationalFormPath,
        event.sender
      )
    }
  )

  ipcMain.handle(
    'gerar_planilha_sr_pendente',
    (event, smartsheetPath: string) => {
      return gerarPlanilhaSrPendente(smartsheetPath, event.sender)
    }
  )

  // ─── Uploader IPC Handlers ───────────────────────────────────────────────────
  // A UI espera { success, data|error } — as funções do serviço retornam o array cru
  // da API da Arthnex (ou lançam em caso de erro HTTP), então o wrapping é feito aqui.
  ipcMain.handle(
    'arthnex_listar_workorders',
    async (_event, useHomolog?: boolean) => {
      try {
        const data = await listarWorkorders(useHomolog)
        return { success: true, data }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle(
    'arthnex_listar_pas',
    async (_event, workorderId: string, useHomolog?: boolean) => {
      try {
        const data = await listarPasPendentes(workorderId, useHomolog)
        return { success: true, data }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle(
    'arthnex_upload_multi',
    (
      event,
      csvPaths: string[],
      workorderId: string,
      pSurface: string,
      collectDate: string,
      useHomolog?: boolean,
      manualOverrides?: Record<string, string>
    ) => {
      return uploadMultiplasCsv(
        csvPaths,
        workorderId,
        pSurface,
        collectDate,
        useHomolog,
        event.sender,
        manualOverrides
      )
    }
  )

  ipcMain.handle('arthnex_descobrir_csvs', (_event, rootPath: string) => {
    return descobrirCsvsUpload(rootPath)
  })

  ipcMain.handle(
    'arthnex_analisar_csvs',
    (_event, csvPaths: string[], blades: any[]) => {
      return analisarAmbiguidadesCsvs(csvPaths, blades)
    }
  )

  // ─── Horizon IPC Handlers ────────────────────────────────────────────────────
  ipcMain.handle(
    'horizon_analisar',
    async (_event, horizonPaths: string[], atwPaths: string[]) => {
      return horizonAnalisar(horizonPaths, atwPaths)
    }
  )

  ipcMain.handle(
    'horizon_validar_requisitos',
    async (
      _event,
      horizonPaths: string[],
      summaryPaths: string[],
      detailsPath: string,
      damagesPaths: string[],
      turbinasRemovidas: string[],
      vinculosConfirmados: Record<string, string>
    ) => {
      return horizonValidarRequisitos(
        horizonPaths,
        summaryPaths,
        detailsPath,
        damagesPaths,
        turbinasRemovidas,
        vinculosConfirmados
      )
    }
  )

  ipcMain.handle(
    'horizon_gerar_pacote',
    async (
      _event,
      horizonPaths: string[],
      summaryPaths: string[],
      detailsPath: string,
      damagesPaths: string[],
      vinculosConfirmados: Record<string, string>,
      turbinasRemovidas: string[],
      turbinasHorizonRemovidas: string[]
    ) => {
      return horizonGerarPacote(
        horizonPaths,
        summaryPaths,
        detailsPath,
        damagesPaths,
        vinculosConfirmados,
        turbinasRemovidas,
        turbinasHorizonRemovidas
      )
    }
  )

  ipcMain.handle(
    'horizon_corrigir_damages_direto',
    async (event, paths: string[], siteName: string) => {
      return horizonCorrigirDamagesDireto(paths, siteName, event.sender)
    }
  )

  ipcMain.handle(
    'horizon_list_xlsx_sheets',
    async (_event, filePath: string) => {
      return listXlsxSheets(filePath)
    }
  )

  ipcMain.handle(
    'horizon_extract_task_ids',
    async (_event, filePath: string, sheetName?: string) => {
      return extractHorizonTaskIdsFromXlsx(filePath, sheetName)
    }
  )

  ipcMain.handle('horizon_process_from_arthnex', async (event, params: any) => {
    return horizonProcessarFromArthnex({
      ...params,
      sendLog: (text: string, type?: string) =>
        event.sender.send('log', { text, type }),
    })
  })

  // ─── Reconstruir & Rebuilder IPC Handlers ────────────────────────────────────
  ipcMain.handle('detectar_estrutura_abc', async (_event, rootPath: string) => {
    return detectarEstruturaAbc(rootPath)
  })

  ipcMain.handle(
    'ler_json_referencia_pixel_mm',
    async (_event, jsonPath: string) => {
      return lerJsonReferenciaPixelMm(jsonPath)
    }
  )

  ipcMain.handle(
    'reconstruir_csv_multi',
    async (
      event,
      tabs: any[],
      workorder: string,
      turbine: string,
      genUploaderCsv: boolean,
      jsonRefPath: string
    ) => {
      return reconstruirCsvMulti(
        tabs,
        workorder,
        turbine,
        genUploaderCsv,
        jsonRefPath,
        event.sender
      )
    }
  )

  ipcMain.handle(
    'carregar_fotos_reconstruir_sync',
    async (event, pasta: string) => {
      const fotos = await carregarFotosReconstruir(pasta, event.sender)
      return { success: true, fotos }
    }
  )

  // ─── Batch 360 Stitcher IPC Handler ──────────────────────────────────────────
  ipcMain.handle(
    'batch_360_stitch',
    async (
      event,
      rootDir: string,
      mode: 'insprj' | 'mediasdk' | 'ffmpeg' | 'auto'
    ) => {
      return batchStitchDirectory(rootDir, mode, event.sender)
    }
  )

  // ─── SNOW Processor IPC Handlers ──────────────────────────────────────────────
  ipcMain.handle(
    'snow_process_excel',
    async (event, excelPath: string, outputDir: string) => {
      return processSnowExcel(excelPath, outputDir, event.sender)
    }
  )

  ipcMain.handle(
    'snow_process_excel_batch',
    async (event, excelPaths: string[], outputDir: string) => {
      return processSnowExcelBatch(excelPaths, outputDir, event.sender)
    }
  )

  // ─── SNOW Automation (preenchimento do Damage Report Entry) ──────────────────
  ipcMain.handle('snow_automation_login', async (_event, url: string) => {
    return openServiceNowForLogin(url)
  })

  ipcMain.handle('snow_automation_close', async () => {
    return closeServiceNowSession()
  })

  ipcMain.handle(
    'snow_automation_get_blades',
    async (_event, excelPath: string) => {
      return getSpreadsheetBlades(excelPath)
    }
  )

  ipcMain.handle(
    'snow_automation_run',
    async (
      event,
      excelPath: string,
      incidentUrl: string,
      options: {
        headless?: boolean
        startRow?: number
        endRow?: number
        selectedBlades?: string[]
      }
    ) => {
      const { log, logger } = wrapWithRunLogger(
        'snow_defeitos',
        (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => {
          event.sender.send('snow_automation_log', { msg, type })
        }
      )
      setCurrentRunLogger(logger)
      try {
        return await runSnowDamageAutomation(
          excelPath,
          incidentUrl,
          options,
          log
        )
      } finally {
        logger.close()
        setCurrentRunLogger(null)
      }
    }
  )

  // ─── Arthnex Platform Handlers ─────────────────────────────────────────────
  ipcMain.handle(
    'arthnex_login',
    async (_event, email: string, pass: string, env: ArthnexEnv) => {
      return arthnexApi.login(email, pass, env)
    }
  )

  ipcMain.handle(
    'arthnex_verify_mfa',
    async (_event, code: string, tempToken: string, env: ArthnexEnv) => {
      return arthnexApi.verifyMfa(code, tempToken, env)
    }
  )

  ipcMain.handle(
    'arthnex_google_login',
    async (_event, env: ArthnexEnv = 'homolog') => {
      return new Promise(resolve => {
        const baseUrl =
          env === 'homolog'
            ? 'https://backend-homolog.arthnex.com/'
            : 'https://backend.arthnex.com/'
        const authUrl = `${baseUrl}auth/google`

        const authWindow = new BrowserWindow({
          width: 550,
          height: 680,
          title: 'Login com Conta Google — Arthnex',
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        })

        let resolved = false

        const checkUrl = (url: string) => {
          if (url.includes('sso-callback') && url.includes('token=')) {
            try {
              const parsed = new URL(url)
              const token = parsed.searchParams.get('token')
              const refreshToken = parsed.searchParams.get('refreshToken')
              if (token) {
                arthnexApi.setDirectToken(token, refreshToken || undefined, env)
                resolved = true
                authWindow.close()
                resolve({ success: true, token, refreshToken })
              }
            } catch {
              // parse error
            }
          }
        }

        authWindow.webContents.on('will-redirect', (_e, url) => checkUrl(url))
        authWindow.webContents.on('did-navigate', (_e, url) => checkUrl(url))

        authWindow.on('closed', () => {
          if (!resolved) {
            resolve({
              success: false,
              error: 'Login cancelado ou janela fechada',
            })
          }
        })

        authWindow.loadURL(authUrl)
      })
    }
  )

  ipcMain.handle('arthnex_logout', async () => {
    arthnexApi.logout()
    return { success: true }
  })

  ipcMain.handle('arthnex_get_auth', async () => {
    return arthnexApi.getAuth()
  })

  ipcMain.handle('arthnex_set_env', async (_event, env: ArthnexEnv) => {
    arthnexApi.setEnv(env)
    return { success: true }
  })

  ipcMain.handle(
    'arthnex_set_token',
    async (_event, token: string, env: ArthnexEnv) => {
      arthnexApi.setDirectToken(token, undefined, env)
      return { success: true }
    }
  )

  ipcMain.handle(
    'arthnex_get_workorders',
    async (_event, search?: string, page?: number, limit?: number) => {
      try {
        const wos = await arthnexApi.getWorkorders(search, page, limit)
        return { success: true, workorders: wos }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  // ─── SNOW Automation — Fase 0 (Create Inspection Report) ──────────────────────
  ipcMain.handle(
    'snow_read_turbine_inc_list',
    async (_event, xlsxPath: string) => {
      return readTurbineIncList(xlsxPath)
    }
  )

  ipcMain.handle(
    'snow_inspection_report_run',
    async (
      event,
      controlXlsxPath: string,
      portalOrigin: string,
      technician: string,
      options: { headless?: boolean; onlyIncNumbers?: string[] }
    ) => {
      const { log, logger } = wrapWithRunLogger(
        'snow_inspection_report',
        (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => {
          event.sender.send('snow_automation_log', { msg, type })
        }
      )
      setCurrentRunLogger(logger)
      try {
        return await runInspectionReportPhase(
          controlXlsxPath,
          portalOrigin,
          technician,
          options,
          log
        )
      } finally {
        logger.close()
        setCurrentRunLogger(null)
      }
    }
  )

  ipcMain.handle(
    'arthnex_get_turbines_blades',
    async (_event, woId: string, windfarmId?: number) => {
      try {
        const data = await arthnexApi.getTurbinesAndBladesByWo(woId, windfarmId)
        return { success: true, data }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle('arthnex_get_defects', async (_event, params: any) => {
    try {
      const defects = await arthnexApi.getDefectsByBlade(params)
      return { success: true, defects }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('snow_process_arthnex', async (event, params: any) => {
    return processSnowFromArthnex({
      ...params,
      sender: event.sender,
    })
  })

  ipcMain.handle(
    'uploader_get_hierarchy',
    async (_event, woId: string, useHomolog?: boolean) => {
      try {
        const data = await obterHierarquiaWorkorder(woId, useHomolog)
        return { success: true, data }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle(
    'arthnex_get_operation_events',
    async (_event, search?: string, page?: number, pageSize?: number) => {
      try {
        const res = await arthnexApi.getOperationEvents(search, page, pageSize)
        return { success: true, ...res }
      } catch (err: any) {
        return { success: false, error: err.message, total: 0, data: [] }
      }
    }
  )

  ipcMain.handle(
    'arthnex_get_technician_by_turbine',
    async (_event, turbineName: string, woId?: string) => {
      try {
        const res = await arthnexApi.getTechnicianAndDateByTurbine(
          turbineName,
          woId
        )
        return { success: true, ...res }
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
          leader: 'ALLAN THIAGO',
          technician: '',
          date: '',
          technicians: [],
        }
      }
    }
  )

  // ─── SNOW Automation — controle de Pausar/Parar ───────────────────────────────
  ipcMain.handle('snow_automation_reset_control', async () => {
    resetAutomationControl()
    return { success: true }
  })
  ipcMain.handle('snow_automation_pause', async () => {
    pauseAutomation()
    markCurrentRun('PAUSADO pelo usuário')
    return { success: true }
  })
  ipcMain.handle('snow_automation_resume', async () => {
    resumeAutomation()
    markCurrentRun('RETOMADO pelo usuário')
    return { success: true }
  })
  ipcMain.handle('snow_automation_stop', async () => {
    stopAutomation()
    markCurrentRun('PARADO pelo usuário')
    return { success: true }
  })

  // ─── SNOW Automation — gerenciador de abas abertas ────────────────────────────
  ipcMain.handle('snow_automation_list_open_tabs', async () => {
    return listReviewTabs()
  })
  ipcMain.handle('snow_automation_close_tab', async (_event, id: string) => {
    return { success: await closeTab(id) }
  })
  ipcMain.handle('snow_automation_close_all_review_tabs', async () => {
    return { closed: await closeAllReviewTabs() }
  })

  // ─── SNOW Automation — logs completos em arquivo ──────────────────────────────
  ipcMain.handle('snow_automation_open_logs_folder', async () => {
    await shell.openPath(getLogsDir())
    return { success: true }
  })

  // ─── SNOW Automation — configuração por parque (líder/técnicos/PO) ───────────
  ipcMain.handle('snow_windfarm_config_list', async () => {
    return listWindfarmConfigs()
  })
  ipcMain.handle(
    'snow_windfarm_config_save',
    async (_event, config: Parameters<typeof saveWindfarmConfig>[0]) => {
      return saveWindfarmConfig(config)
    }
  )
  ipcMain.handle(
    'snow_windfarm_config_delete',
    async (_event, windfarm: string) => {
      return deleteWindfarmConfig(windfarm)
    }
  )

  // ─── SNOW Automation — Completa (Fase 0 + Módulo 24 numa passada só) ──────────
  ipcMain.handle(
    'snow_full_automation_run',
    async (
      event,
      controlXlsxPath: string,
      wtgRootFolder: string,
      portalOrigin: string,
      technician: string,
      options: Parameters<typeof runFullAutomation>[4]
    ) => {
      const { log, logger } = wrapWithRunLogger(
        'snow_completa',
        (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => {
          event.sender.send('snow_automation_log', { msg, type })
        }
      )
      setCurrentRunLogger(logger)
      try {
        return await runFullAutomation(
          controlXlsxPath,
          wtgRootFolder,
          portalOrigin,
          technician,
          options,
          log
        )
      } finally {
        logger.close()
        setCurrentRunLogger(null)
      }
    }
  )

  startTabSweep()

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Marca no arquivo de log da execução em andamento (se houver) que o
  // programa foi fechado com uma automação rodando — pedido do usuário, pra
  // não ficar tentando adivinhar pela última linha normal do arquivo.
  markCurrentRun('FECHADO pelo usuário (programa encerrado)')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
