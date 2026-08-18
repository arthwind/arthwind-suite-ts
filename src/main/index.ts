import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import os from 'os'
import fs from 'fs'
import path from 'path'

// Import Services
import { packerPlataforma } from './services/packer'
import {
  organizarImagens,
  jsonParaCsvOrganizar,
  processarJson,
  organizarFotosJson,
  converterCsv,
  extrairGpsZ,
  corrigirZ0,
  recuperarFotosPerdidas,
  reconstruirCsv,
  padronizarGoPro,
  analisarGoProRaw,
  calibrarZGoProRaw,
  vincularArthnexCsv,
  carregarFotosGps,
  analisarBladeSplit,
  carregarFotosReconstruir,
  corrigirBladeSplit,
  analisarWorkflow,
  gerarPlanilhaSrPendente,
  buscarSmartsheetApi,
  fetchEmailViaImap,
  detectarEstruturaAbc,
  lerJsonReferenciaPixelMm,
  reconstruirCsvMulti
} from './services/workflow'

import {
  horizonAnalisar,
  horizonValidarRequisitos,
  horizonGerarPacote,
  horizonCorrigirDamagesDireto
} from './services/horizon'
import {
  listarWorkorders,
  listarPasPendentes,
  uploadMultiplasCsv,
  descobrirCsvsUpload,
  analisarAmbiguidadesCsvs
} from './services/uploader'
import { substituirVideos360 } from './services/videoReplacer'
import { enviarVideosDrive } from './services/videoUploader'
import { batchStitchDirectory } from './services/batch360Stitcher'
import { processSnowExcel, processSnowExcelBatch } from './services/snowProcessor'
import {
  openServiceNowForLogin,
  closeServiceNowSession,
  runSnowDamageAutomation,
  getSpreadsheetBlades,
  readTurbineIncList,
  runInspectionReportPhase,
  runFullAutomation
} from './services/snowAutomation'


// Configuration Helpers
function getConfigPath(): string {
  const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'))
  const folder = path.join(appData, "ArthwindSuite")
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true })
  }
  return path.join(folder, "config.json")
}

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
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
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
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ─── Preference Config IPC Handlers ──────────────────────────────────────────
  ipcMain.handle('get_debug_mode', () => {
    const p = getConfigPath()
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
        return !!data.debug
      } catch {}
    }
    return false
  })

  ipcMain.handle('set_debug_mode', (_event, enabled: boolean) => {
    const p = getConfigPath()
    try {
      let cfg: any = {}
      if (fs.existsSync(p)) {
        cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
      }
      cfg.debug = enabled
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get_theme_mode', () => {
    const p = getConfigPath()
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
        return data.theme || "light"
      } catch {}
    }
    return "light"
  })

  ipcMain.handle('set_theme_mode', (_event, mode: string) => {
    const p = getConfigPath()
    try {
      let cfg: any = {}
      if (fs.existsSync(p)) {
        cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
      }
      cfg.theme = mode
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get_last_paths', () => {
    const p = getConfigPath()
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
        return data.lastPaths || {}
      } catch {}
    }
    return {}
  })

  ipcMain.handle('set_last_paths', (_event, paths: any) => {
    const p = getConfigPath()
    try {
      let cfg: any = {}
      if (fs.existsSync(p)) {
        cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
      }
      cfg.lastPaths = paths
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8')
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
      filters
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
      filters
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle('pick_folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
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

  ipcMain.handle('save_image', async (_event, base64Data: string, defaultName: string) => {
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
  })

  // ─── Services IPC Handlers ───────────────────────────────────────────────────
  // Vários módulos de workflow.ts são disparados pelo renderer no estilo "fire-and-forget"
  // (usePyWebView.js chama a API sem aguardar a Promise, e só sai do estado "rodando"
  // quando recebe o evento 'arthdone') — sem emitir esse evento, a UI fica girando pra
  // sempre. `withArthDone` garante a emissão exatamente uma vez ao final (sucesso OU erro),
  // não importa quantos `return` existam dentro da função de serviço — mais seguro do que
  // cada função lembrar de emitir isso sozinha em todo caminho de saída.
  function withArthDone<T extends (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<any>>(handler: T) {
    return async (event: Electron.IpcMainInvokeEvent, ...args: Parameters<T> extends [any, ...infer R] ? R : never) => {
      try {
        return await handler(event, ...args)
      } finally {
        event.sender.send('arthdone', {})
      }
    }
  }

  ipcMain.handle('organizar_imagens', withArthDone((event, csvPath: string, fotosDir: string, mode: string, dryRun: boolean) => {
    return organizarImagens(csvPath, fotosDir, mode, dryRun, event.sender)
  }))

  ipcMain.handle('json_para_csv_organizar', withArthDone((event, jsonPath: string) => {
    return jsonParaCsvOrganizar(jsonPath, event.sender)
  }))

  ipcMain.handle('processar_json', withArthDone((event, jsonPath: string) => {
    return processarJson(jsonPath, event.sender)
  }))

  ipcMain.handle('organizar_fotos', withArthDone((event, jsonPath: string, sourceFolder: string) => {
    return organizarFotosJson(jsonPath, sourceFolder, event.sender)
  }))

  ipcMain.handle('converter_csv', withArthDone((event, csvPath: string, gerarXlsx: boolean) => {
    return converterCsv(csvPath, gerarXlsx, event.sender)
  }))

  ipcMain.handle('extrair_gps_z', withArthDone((event, pasta: string, raizNome: string) => {
    return extrairGpsZ(pasta, raizNome, event.sender)
  }))

  ipcMain.handle('corrigir_z_zero', withArthDone((event, csvPath: string, fotosDir: string, raizNome: string) => {
    return corrigirZ0(csvPath, fotosDir, raizNome, event.sender)
  }))

  ipcMain.handle('recuperar_fotos_perdidas', withArthDone((event, jsonPath: string, fotosDir: string) => {
    return recuperarFotosPerdidas(jsonPath, fotosDir, event.sender)
  }))

  ipcMain.handle('reconstruir_csv', withArthDone((event, pasta: string, bladeSn: string, sides: any[]) => {
    return reconstruirCsv(pasta, bladeSn, sides, event.sender)
  }))

  // packer_plataforma já emite 'arthdone' internamente (packer.ts) — não precisa do wrapper.
  ipcMain.handle('packer_plataforma', (event, pasta: string) => {
    return packerPlataforma(pasta, event.sender)
  })

  ipcMain.handle('arthnex_organizar', withArthDone((event, fotosDir: string, dryRun: boolean) => {
    return padronizarGoPro(fotosDir, dryRun, event.sender)
  }))

  ipcMain.handle('calibrar_z_gopro_raw', withArthDone((event, pastaBlade: string, turbine: string, bladeSn: string, referencias: any) => {
    return calibrarZGoProRaw(pastaBlade, turbine, bladeSn, referencias, event.sender)
  }))

  ipcMain.handle('vincular_arthnex_csv', withArthDone((event, csvPath: string, fotosDir: string) => {
    return vincularArthnexCsv(csvPath, fotosDir, event.sender)
  }))

  // As três abaixo (GPS, Blade Split, GoPro RAW) alimentam um botão "Analisar" na UI que
  // fica esperando um evento (gps_fotos_loaded / blade_split_analise / gopro_raw_analise)
  // pra sair do estado de loading — sem emitir o evento, o botão gira pra sempre mesmo
  // com o resultado já pronto no retorno da própria função.
  ipcMain.handle('carregar_fotos_gps', async (event, pasta: string) => {
    const fotos = await carregarFotosGps(pasta, event.sender)
    event.sender.send('gps_fotos_loaded', { fotos })
    return fotos
  })

  ipcMain.handle('analisar_blade_split', async (event, filePath: string, threshold: number) => {
    const suspeitos = await analisarBladeSplit(filePath, threshold, event.sender)
    event.sender.send('blade_split_analise', { suspeitos })
    return suspeitos
  })

  ipcMain.handle('carregar_fotos_reconstruir', (event, pasta: string) => {
    return carregarFotosReconstruir(pasta, event.sender)
  })

  ipcMain.handle('analisar_gopro_raw', async (event, pastaBlade: string) => {
    const regioes = await analisarGoProRaw(pastaBlade, event.sender)
    event.sender.send('gopro_raw_analise', { regioes })
    return regioes
  })

  ipcMain.handle('substituir_videos_360', withArthDone((event, outputFolder: string, targetFolder: string, dryRun: boolean) => {
    return substituirVideos360(outputFolder, targetFolder, dryRun, event.sender)
  }))

  ipcMain.handle('enviar_videos_drive', withArthDone((event, localFolder: string, driveFolder: string, dryRun: boolean) => {
    return enviarVideosDrive(localFolder, driveFolder, dryRun, event.sender)
  }))

  ipcMain.handle('corrigir_blade_split', withArthDone((event, filePath: string, correcoes: any[]) => {
    return corrigirBladeSplit(filePath, correcoes, event.sender)
  }))

  // ─── Workflow & Smartsheet Auditor IPC Handlers ──────────────────────────────
  ipcMain.handle('testar_conexao_imap', async (_event, host, port, username, password, use_ssl = true, subject_filter = "") => {
    const res = await fetchEmailViaImap({ host, port, username, password, use_ssl, subject_filter })
    if (res.success) {
      return { success: true, message: "Conectado com sucesso à caixa de entrada!" }
    }
    return { success: false, error: res.error || "Erro desconhecido" }
  })

  ipcMain.handle('buscar_smartsheet_api', (_event, sheetId: string, token?: string) => {
    return buscarSmartsheetApi(sheetId, token)
  })

  ipcMain.handle('analisar_workflow', (event, smartsheetPath: string, startDate?: string, endDate?: string, vendorPath?: string, emailContent?: string, emailFilePath?: string, imapConfig?: any, operationalFormPath?: string) => {
    return analisarWorkflow(smartsheetPath, startDate, endDate, vendorPath, emailContent, emailFilePath, imapConfig, operationalFormPath, event.sender)
  })

  ipcMain.handle('gerar_planilha_sr_pendente', (event, smartsheetPath: string) => {
    return gerarPlanilhaSrPendente(smartsheetPath, event.sender)
  })

  // ─── Uploader IPC Handlers ───────────────────────────────────────────────────
  // A UI espera { success, data|error } — as funções do serviço retornam o array cru
  // da API da Arthnex (ou lançam em caso de erro HTTP), então o wrapping é feito aqui.
  ipcMain.handle('arthnex_listar_workorders', async (_event, useHomolog?: boolean) => {
    try {
      const data = await listarWorkorders(useHomolog)
      return { success: true, data }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('arthnex_listar_pas', async (_event, workorderId: string, useHomolog?: boolean) => {
    try {
      const data = await listarPasPendentes(workorderId, useHomolog)
      return { success: true, data }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('arthnex_upload_multi', (event, csvPaths: string[], workorderId: string, pSurface: string, collectDate: string, useHomolog?: boolean, manualOverrides?: Record<string, string>) => {
    return uploadMultiplasCsv(csvPaths, workorderId, pSurface, collectDate, useHomolog, event.sender, manualOverrides)
  })

  ipcMain.handle('arthnex_descobrir_csvs', (_event, rootPath: string) => {
    return descobrirCsvsUpload(rootPath)
  })

  ipcMain.handle('arthnex_analisar_csvs', (_event, csvPaths: string[], blades: any[]) => {
    return analisarAmbiguidadesCsvs(csvPaths, blades)
  })

  // ─── Horizon IPC Handlers ────────────────────────────────────────────────────
  ipcMain.handle('horizon_analisar', async (_event, horizonPaths: string[], atwPaths: string[]) => {
    return horizonAnalisar(horizonPaths, atwPaths)
  })

  ipcMain.handle('horizon_validar_requisitos', async (_event, horizonPaths: string[], summaryPaths: string[], detailsPath: string, damagesPaths: string[], turbinasRemovidas: string[], vinculosConfirmados: Record<string, string>) => {
    return horizonValidarRequisitos(horizonPaths, summaryPaths, detailsPath, damagesPaths, turbinasRemovidas, vinculosConfirmados)
  })

  ipcMain.handle('horizon_gerar_pacote', async (_event, horizonPaths: string[], summaryPaths: string[], detailsPath: string, damagesPaths: string[], vinculosConfirmados: Record<string, string>, turbinasRemovidas: string[], turbinasHorizonRemovidas: string[]) => {
    return horizonGerarPacote(horizonPaths, summaryPaths, detailsPath, damagesPaths, vinculosConfirmados, turbinasRemovidas, turbinasHorizonRemovidas)
  })

  ipcMain.handle('horizon_corrigir_damages_direto', async (event, paths: string[], siteName: string) => {
    return horizonCorrigirDamagesDireto(paths, siteName, event.sender)
  })

  // ─── Reconstruir & Rebuilder IPC Handlers ────────────────────────────────────
  ipcMain.handle('detectar_estrutura_abc', async (_event, rootPath: string) => {
    return detectarEstruturaAbc(rootPath)
  })

  ipcMain.handle('ler_json_referencia_pixel_mm', async (_event, jsonPath: string) => {
    return lerJsonReferenciaPixelMm(jsonPath)
  })

  ipcMain.handle('reconstruir_csv_multi', async (event, tabs: any[], workorder: string, turbine: string, genUploaderCsv: boolean, jsonRefPath: string) => {
    return reconstruirCsvMulti(tabs, workorder, turbine, genUploaderCsv, jsonRefPath, event.sender)
  })

  ipcMain.handle('carregar_fotos_reconstruir_sync', async (event, pasta: string) => {
    const fotos = await carregarFotosReconstruir(pasta, event.sender)
    return { success: true, fotos }
  })

  // ─── Batch 360 Stitcher IPC Handler ──────────────────────────────────────────
  ipcMain.handle('batch_360_stitch', async (event, rootDir: string, mode: 'insprj' | 'ffmpeg') => {
    return batchStitchDirectory(rootDir, mode, event.sender)
  })

  // ─── SNOW Processor IPC Handlers ──────────────────────────────────────────────
  ipcMain.handle('snow_process_excel', async (event, excelPath: string, outputDir: string) => {
    return processSnowExcel(excelPath, outputDir, event.sender)
  })

  ipcMain.handle('snow_process_excel_batch', async (event, excelPaths: string[], outputDir: string) => {
    return processSnowExcelBatch(excelPaths, outputDir, event.sender)
  })

  // ─── SNOW Automation (preenchimento do Damage Report Entry) ──────────────────
  ipcMain.handle('snow_automation_login', async (_event, url: string) => {
    return openServiceNowForLogin(url)
  })

  ipcMain.handle('snow_automation_close', async () => {
    return closeServiceNowSession()
  })

  ipcMain.handle('snow_automation_get_blades', async (_event, excelPath: string) => {
    return getSpreadsheetBlades(excelPath)
  })

  ipcMain.handle(
    'snow_automation_run',
    async (
      event,
      excelPath: string,
      incidentUrl: string,
      options: { headless?: boolean; startRow?: number; endRow?: number; selectedBlades?: string[] }
    ) => {
      return runSnowDamageAutomation(excelPath, incidentUrl, options, (msg: string) => {
        event.sender.send('snow_automation_log', { msg })
      })
    }
  )

  // ─── SNOW Automation — Fase 0 (Create Inspection Report) ──────────────────────
  ipcMain.handle('snow_read_turbine_inc_list', async (_event, xlsxPath: string) => {
    return readTurbineIncList(xlsxPath)
  })

  ipcMain.handle(
    'snow_inspection_report_run',
    async (
      event,
      controlXlsxPath: string,
      portalOrigin: string,
      technician: string,
      options: { headless?: boolean; onlyIncNumbers?: string[] }
    ) => {
      return runInspectionReportPhase(controlXlsxPath, portalOrigin, technician, options, (msg: string) => {
        event.sender.send('snow_automation_log', { msg })
      })
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
      return runFullAutomation(controlXlsxPath, wtgRootFolder, portalOrigin, technician, options, (msg: string) => {
        event.sender.send('snow_automation_log', { msg })
      })
    }
  )


  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
