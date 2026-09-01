import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'

// Mapeamento dinâmico para evitar código repetitivo no Preload
const ipcMethods = [
  'get_debug_mode',
  'get_theme_mode',
  'get_last_paths',
  'set_debug_mode',
  'set_theme_mode',
  'set_last_paths',
  'organizar_imagens',
  'json_para_csv_organizar',
  'processar_json',
  'organizar_fotos',
  'converter_csv',
  'extrair_gps_z',
  'corrigir_blade_split',
  'corrigir_z_zero',
  'recuperar_fotos_perdidas',
  'reconstruir_csv',
  'packer_plataforma',
  'arthnex_organizar',
  'calibrar_z_gopro_raw',
  'vincular_arthnex_csv',
  'carregar_fotos_gps',
  'analisar_blade_split',
  'carregar_fotos_reconstruir',
  'analisar_gopro_raw',
  'open_folder',
  'pick_folder',
  'pick_file',
  'pick_files',
  'arthnex_listar_workorders',
  'arthnex_listar_pas',
  'arthnex_upload_multi',
  'arthnex_descobrir_csvs',
  'arthnex_analisar_csvs',
  // Novos métodos adicionados do Módulo de Workflow & Auditoria
  'testar_conexao_imap',
  'buscar_smartsheet_api',
  'analisar_workflow',
  'gerar_planilha_sr_pendente',
  'save_image',
  // Métodos Horizon e Reconstruir
  'horizon_analisar',
  'horizon_validar_requisitos',
  'horizon_gerar_pacote',
  'horizon_corrigir_damages_direto',
  'substituir_videos_360',
  'enviar_videos_drive',
  'detectar_estrutura_abc',
  'ler_json_referencia_pixel_mm',
  'reconstruir_csv_multi',
  'carregar_fotos_reconstruir_sync',
  'batch_360_stitch',
  'snow_process_excel',
  'snow_process_excel_batch',
  'snow_automation_login',
  'snow_automation_close',
  'snow_automation_get_blades',
  'snow_automation_run',
  // Métodos de Integração Direta com o Arthnex
  'arthnex_login',
  'arthnex_verify_mfa',
  'arthnex_google_login',
  'arthnex_logout',
  'arthnex_get_auth',
  'arthnex_set_env',
  'arthnex_set_token',
  'arthnex_get_workorders',
  'arthnex_get_turbines_blades',
  'arthnex_get_defects',
  'snow_process_arthnex',
  'uploader_get_hierarchy',
  'arthnex_get_operation_events',
  'arthnex_get_technician_by_turbine',
  // Métodos de Automação Avançada SNOW
  'snow_read_turbine_inc_list',
  'snow_inspection_report_run',
  'snow_full_automation_run',
  'snow_automation_reset_control',
  'snow_automation_pause',
  'snow_automation_resume',
  'snow_automation_stop',
  'snow_automation_list_open_tabs',
  'snow_automation_close_tab',
  'snow_automation_close_all_review_tabs',
  'snow_automation_open_logs_folder',
  'snow_windfarm_config_list',
  'snow_windfarm_config_save',
  'snow_windfarm_config_delete',
]

const api: Record<string, (...args: any[]) => Promise<any>> = {}

for (const method of ipcMethods) {
  api[method] = (...args: any[]) => ipcRenderer.invoke(method, ...args)
}

// Configuração dos escutadores de eventos vindos do processo Main (Python-style event dispatching)
const events = [
  'arthlog',
  'arthdone',
  'arthprogress',
  'arthnex_batch_progress',
  'gps_fotos_loaded',
  'blade_split_analise',
  'fotos_reconstruir_loaded',
  'gopro_raw_analise',
  'batch_stitch_log',
  'snow_progress',
  'snow_batch_status',
  'snow_automation_log',
]

for (const eventName of events) {
  ipcRenderer.on(eventName, (_event, data) => {
    window.dispatchEvent(new CustomEvent(eventName, { detail: data }))
  })
}

// Exposição do barramento IPC nos escopos globais
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    // Compatibilidade legada para o código existente do PyWebView
    contextBridge.exposeInMainWorld('pywebview', { api })
  } catch (error) {
    console.error('Erro ao expor APIs no preload:', error)
  }
} else {
  // @ts-ignore (fallback para contextos sem isolamento)
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
  // @ts-ignore
  window.pywebview = { api }
}
