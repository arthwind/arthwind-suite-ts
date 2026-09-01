import html2canvas from 'html2canvas'
import { useCallback, useState } from 'react'
import { Icons } from '../constants/icons.jsx'

export default function WorkflowModule({ T, D, isPyWebView, onOpenFolder }) {
  const [smartsheetFile, setSmartsheetFile] = useState('')
  const [vendorFile, setVendorFile] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [running, setRunning] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  // Audit States
  const [useEmailAudit, setUseEmailAudit] = useState(true)
  const [useOperationalAudit, setUseOperationalAudit] = useState(true)

  const imapHost = 'imap.gmail.com'
  const imapPort = '993'
  const imapSSL = true
  const imapUser = 'joao.oliveira@arthwind.com.br'
  const imapPass = 'vhew bwpl zbca pqdg'

  // surface can be "interna" or "externa"
  const [surface, setSurface] = useState(
    () => localStorage.getItem('workflow_surface') || 'externa'
  )
  const isLoggedIn = true
  const testingImap = false

  const [operationalFile, setOperationalFile] = useState('')
  const [operationalSource, setOperationalSource] = useState('api')
  const [operationalSheetId, setOperationalSheetId] = useState(
    'https://app.smartsheet.com/sheets/4QrQQFJgQqcH3fmVx3MjJ6RQpCcF2hFv8W7VQRV1?view=grid'
  )

  // Drag and drop / UI states
  const [dragOverSmartsheet, setDragOverSmartsheet] = useState(false)
  const [dragOverVendor, setDragOverVendor] = useState(false)
  const [dragOverEmailFile, setDragOverEmailFile] = useState(false)
  const [dragOverOperational, setDragOverOperational] = useState(false)

  // Live filter states
  const [searchTermEmail, setSearchTermEmail] = useState('')
  const [filterDivergencia, setFilterDivergencia] = useState('')
  const [searchTermEscapes, setSearchTermEscapes] = useState('')
  const [searchTermTriangulation, setSearchTermTriangulation] = useState('')
  const [searchTermOperational, setSearchTermOperational] = useState('')

  const handleDragOver = (e, type) => {
    e.preventDefault()
    if (type === 'smartsheet') setDragOverSmartsheet(true)
    if (type === 'vendor') setDragOverVendor(true)
    if (type === 'email') setDragOverEmailFile(true)
    if (type === 'operational') setDragOverOperational(true)
  }

  const handleDragLeave = type => {
    if (type === 'smartsheet') setDragOverSmartsheet(false)
    if (type === 'vendor') setDragOverVendor(false)
    if (type === 'email') setDragOverEmailFile(false)
    if (type === 'operational') setDragOverOperational(false)
  }

  const handleDrop = (e, type) => {
    e.preventDefault()
    if (type === 'smartsheet') setDragOverSmartsheet(false)
    if (type === 'vendor') setDragOverVendor(false)
    if (type === 'email') setDragOverEmailFile(false)
    if (type === 'operational') setDragOverOperational(false)

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0]
      const filePath = file.path || file.name
      if (type === 'smartsheet') {
        setSmartsheetFile(filePath)
        setResult(null)
        setError('')
      } else if (type === 'vendor') {
        setVendorFile(filePath)
        setResult(null)
        setError('')
      } else if (type === 'email') {
        setEmailFilePath(filePath)
        setError('')
      } else if (type === 'operational') {
        setOperationalFile(filePath)
        setResult(null)
        setError('')
      }
    }
  }

  // Helper to extract a clean name from the email
  const getUserName = email => {
    if (!email) return ''
    const part = email.split('@')[0]
    return part
      .split(/[._-]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }

  const handleSurfaceChange = newSurface => {
    setSurface(newSurface)
    localStorage.setItem('workflow_surface', newSurface)
    if (newSurface === 'interna') {
      setApiSheetId('3528856243070852')
    } else {
      setApiSheetId('1216187166838660')
    }
    setResult(null)
    setError('')
  }

  // Smartsheet API integration states
  const [smartsheetSource, setSmartsheetSource] = useState('api')
  const [apiSheetId, setApiSheetId] = useState(() => {
    const savedSurface = localStorage.getItem('workflow_surface') || 'externa'
    return savedSurface === 'interna' ? '3528856243070852' : '1216187166838660'
  })

  const pickSmartsheet = async () => {
    if (!isPyWebView) return
    const path = await window.pywebview.api.pick_file('excel')
    if (path) {
      setSmartsheetFile(path)
      setResult(null)
      setError('')
    }
  }

  const pickVendor = async () => {
    if (!isPyWebView) return
    const path = await window.pywebview.api.pick_file('csv')
    if (path) {
      setVendorFile(path)
      setResult(null)
      setError('')
    }
  }

  const pickEmailFile = async () => {
    if (!isPyWebView) return
    const path = await window.pywebview.api.pick_file('all')
    if (path) {
      setEmailFilePath(path)
      setError('')
    }
  }

  const pickOperationalFile = async () => {
    if (!isPyWebView) return
    const path = await window.pywebview.api.pick_file('excel')
    if (path) {
      setOperationalFile(path)
      setResult(null)
      setError('')
    }
  }

  const testImapConnection = async () => {
    setTestingImap(true)
    setError('')
    try {
      const res = await window.pywebview.api.testar_conexao_imap(
        imapHost,
        imapPort,
        imapUser,
        imapPass,
        imapSSL,
        surface === 'interna' ? 'interna' : 'externa'
      )
      if (res.success) {
        alert('Autenticado com sucesso!')
        setIsLoggedIn(true)
        localStorage.setItem('imap_user', imapUser)
        localStorage.setItem('imap_pass', imapPass)
      } else {
        setError(
          res.error ||
            'Erro ao conectar. Verifique suas credenciais e se a Senha de Aplicativo está correta.'
        )
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setTestingImap(false)
    }
  }

  const handleRun = async () => {
    let filePath = smartsheetFile
    const isApiMode = smartsheetSource !== 'local'

    // Validação de datas: obrigatório quando o formulário operacional está ativo
    if (useOperationalAudit && !startDate && !endDate) {
      setError(
        'Com a auditoria operacional ativa é obrigatório definir ao menos a data de início do período. Sem um range de datas o matching entre o Smartsheet e o formulário operacional pode demorar indefinidamente.'
      )
      return
    }

    setRunning(true)
    setError('')
    setResult(null)

    try {
      if (isApiMode) {
        if (!apiSheetId) {
          setError(
            'Por favor, forneça o ID ou link completo da planilha do Smartsheet.'
          )
          setRunning(false)
          return
        }
        const downloadRes =
          await window.pywebview.api.buscar_smartsheet_api(apiSheetId)
        if (!downloadRes.success) {
          setError(
            downloadRes.error || 'Falha ao baixar planilha do Smartsheet.'
          )
          setRunning(false)
          return
        }
        filePath = downloadRes.file_path
      } else {
        if (!filePath) {
          setError('Selecione um arquivo de planilha do Smartsheet.')
          setRunning(false)
          return
        }
      }
      let operationalPath = null
      if (useOperationalAudit) {
        const downloadRes = await window.pywebview.api.buscar_smartsheet_api(
          '4QrQQFJgQqcH3fmVx3MjJ6RQpCcF2hFv8W7VQRV1'
        )
        if (!downloadRes.success) {
          setError(
            'Falha ao baixar planilha do Formulário Operacional do Smartsheet: ' +
              (downloadRes.error || 'Erro desconhecido')
          )
          setRunning(false)
          return
        }
        operationalPath = downloadRes.file_path
      }

      const imapConfig = useEmailAudit
        ? {
            host: imapHost,
            port: imapPort,
            username: imapUser,
            password: imapPass,
            use_ssl: imapSSL,
            subject_filter: surface === 'interna' ? 'interna' : 'externa',
          }
        : null

      const emailVal = null
      const emailFileVal = null

      const res = await window.pywebview.api.analisar_workflow(
        filePath,
        startDate || null,
        endDate || null,
        vendorFile || null,
        emailVal,
        emailFileVal,
        imapConfig,
        operationalPath
      )
      if (res.success) {
        setResult(res)
      } else {
        setError(res.error || 'Erro desconhecido ao analisar workflow')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  const handleExportSRPendente = async () => {
    let filePath = smartsheetFile
    const isApiMode = smartsheetSource !== 'local'
    setRunning(true)
    setError('')
    try {
      if (isApiMode) {
        if (!apiSheetId) {
          setError(
            'Por favor, forneça o ID ou link completo da planilha do Smartsheet.'
          )
          setRunning(false)
          return
        }
        const downloadRes =
          await window.pywebview.api.buscar_smartsheet_api(apiSheetId)
        if (!downloadRes.success) {
          setError(
            downloadRes.error || 'Falha ao baixar planilha do Smartsheet.'
          )
          setRunning(false)
          return
        }
        filePath = downloadRes.file_path
      } else {
        if (!filePath) {
          setError('Selecione um arquivo de planilha do Smartsheet.')
          setRunning(false)
          return
        }
      }

      const res =
        await window.pywebview.api.gerar_planilha_sr_pendente(filePath)
      if (res.success) {
        alert(
          `Planilha de SR Pendente gerada com sucesso!\nCaminho: ${res.output_file}\nTotal de aerogeradores: ${res.count}`
        )
        if (window.pywebview.api.open_folder) {
          window.pywebview.api.open_folder(res.output_file)
        }
      } else {
        setError(res.error || 'Erro ao gerar planilha de SR Pendente.')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  const renderStatusDonutChart = counts => {
    const total =
      (counts.verde || 0) +
      (counts.cinza || 0) +
      (counts.amarelo || 0) +
      (counts.vermelho || 0)
    if (total === 0) return null

    const data = [
      { label: 'Verde', count: counts.verde || 0, color: D.success },
      { label: 'Cinza', count: counts.cinza || 0, color: D.textSecond },
      { label: 'Amarelo', count: counts.amarelo || 0, color: D.warning },
      { label: 'Vermelho', count: counts.vermelho || 0, color: D.error },
    ]

    let accumulatedAngle = 0
    const radius = 50
    const strokeWidth = 14
    const circumference = 2 * Math.PI * radius

    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '25px',
          justifyContent: 'center',
          padding: '10px 0',
          flexWrap: 'wrap',
        }}
      >
        <svg
          width="140"
          height="140"
          viewBox="0 0 140 140"
          style={{ flexShrink: 0 }}
        >
          <circle
            cx="70"
            cy="70"
            r={radius}
            fill="transparent"
            stroke={D.border}
            strokeWidth={strokeWidth}
          />
          {data.map((item, idx) => {
            if (item.count === 0) return null
            const percentage = item.count / total
            const strokeLength = percentage * circumference
            const strokeOffset = circumference - strokeLength + accumulatedAngle
            accumulatedAngle -= strokeLength

            return (
              <circle
                key={idx}
                cx="70"
                cy="70"
                r={radius}
                fill="transparent"
                stroke={item.color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${strokeLength} ${circumference}`}
                strokeDashoffset={strokeOffset}
                transform="rotate(-90 70 70)"
                strokeLinecap="round"
                style={{ transition: 'stroke-dashoffset 0.5s ease' }}
              />
            )
          })}
          <text
            x="70"
            y="68"
            textAnchor="middle"
            dominantBaseline="middle"
            fill={D.textPrimary}
            style={{
              fontSize: '16px',
              fontWeight: 'bold',
              fontFamily: 'inherit',
            }}
          >
            {total}
          </text>
          <text
            x="70"
            y="84"
            textAnchor="middle"
            dominantBaseline="middle"
            fill={D.textMuted}
            style={{
              fontSize: '9px',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              fontFamily: 'inherit',
            }}
          >
            Total WTGs
          </text>
        </svg>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            fontSize: '12px',
            flex: 1,
            minWidth: '150px',
          }}
        >
          {data.map((item, idx) => {
            if (item.count === 0) return null
            const pct = ((item.count / total) * 100).toFixed(1)
            return (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <span
                    style={{
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      background: item.color,
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  ></span>
                  <span style={{ color: D.textSecond }}>{item.label}</span>
                </div>
                <span style={{ color: D.textPrimary, fontWeight: '600' }}>
                  {item.count}{' '}
                  <span
                    style={{
                      color: D.textMuted,
                      fontSize: '11px',
                      fontWeight: 'normal',
                    }}
                  >
                    ({pct}%)
                  </span>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const exportReportAsImage = async () => {
    try {
      setIsExporting(true)
      await new Promise(r => setTimeout(r, 200))

      const element = document.getElementById('triangulation-dashboard')
      if (!element) {
        setError('Elemento do dashboard não encontrado.')
        setIsExporting(false)
        return
      }

      const canvas = await html2canvas(element, { backgroundColor: '#1a1a1a' })
      const dataUrl = canvas.toDataURL('image/png')
      const filename = (() => {
        let campaignsStr = ''
        if (
          result &&
          result.triangulacao &&
          result.triangulacao.campaigns &&
          result.triangulacao.campaigns.length > 0
        ) {
          campaignsStr = '_' + result.triangulacao.campaigns.join('_')
        } else if (result && result.resumo && result.resumo.length > 0) {
          campaignsStr = '_' + result.resumo.map(r => r.WF_Id).join('_')
        }
        campaignsStr = campaignsStr
          .replace(/[\\/*?:"<>|]/g, '')
          .replace(/\s+/g, '_')
        if (campaignsStr.length > 40)
          campaignsStr = campaignsStr.substring(0, 40)

        const now = new Date()
        const pad = n => String(n).padStart(2, '0')
        const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

        return `Relatorio_Auditoria${campaignsStr}_${timestamp}.png`
      })()

      if (isPyWebView) {
        try {
          const res = await window.pywebview.api.save_image(dataUrl, filename)
          if (res && res.success) {
            // alert("Salvo em: " + res.path);
          } else if (res && res.error !== 'Cancelado') {
            setError('Erro da API Pywebview: ' + res.error)
          }
        } catch (apiErr) {
          setError('Erro Crítico na API: ' + String(apiErr))
        }
      } else {
        const link = document.createElement('a')
        link.download = filename
        link.href = dataUrl
        link.click()
      }
    } catch (err) {
      setError('Erro ao gerar imagem html2canvas: ' + String(err))
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div className="horizon-module">
      {/* Smartsheet Source Selector */}
      <div
        style={{
          background: D.bgCard,
          padding: '15px',
          borderRadius: '8px',
          border: `1px solid ${D.border}`,
          marginBottom: '20px',
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: '15px',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: '200px' }}>
            <div
              className="field-label"
              style={{ color: D.textMuted, marginBottom: '6px' }}
            >
              Tipo de Campanha
            </div>
            <select
              value={surface}
              onChange={e => handleSurfaceChange(e.target.value)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: D.inputBg,
                color: D.textPrimary,
                border: `1px solid ${D.border}`,
                borderRadius: '6px',
                padding: '8px 10px',
                fontSize: '13px',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            >
              <option value="externa">
                📡 Projetos Externos (ATW_QLDE_034)
              </option>
              <option value="interna">
                📡 Projetos Internos (ATW_QLDE_003)
              </option>
            </select>
          </div>

          <div style={{ flex: 1, minWidth: '200px' }}>
            <div
              className="field-label"
              style={{ color: D.textMuted, marginBottom: '6px' }}
            >
              Origem da Planilha
            </div>
            <select
              value={smartsheetSource}
              onChange={e => {
                setSmartsheetSource(e.target.value)
                setError('')
                setResult(null)
              }}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: D.inputBg,
                color: D.textPrimary,
                border: `1px solid ${D.border}`,
                borderRadius: '6px',
                padding: '8px 10px',
                fontSize: '13px',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            >
              <option value="api">📡 Baixar via Smartsheet API</option>
              <option value="custom">✏️ Outro ID/Link de Planilha [API]</option>
              <option value="local">
                📂 Selecionar arquivo Excel local...
              </option>
            </select>
          </div>

          {smartsheetSource === 'custom' && (
            <div style={{ flex: 1.5, minWidth: '250px' }}>
              <div
                className="field-label"
                style={{ color: D.textMuted, marginBottom: '6px' }}
              >
                ID ou URL da Planilha
              </div>
              <input
                type="text"
                placeholder="Ex: jC8CPvCqGG6H6q6q6mHQFW75rHv839qXmf656Pq1"
                value={apiSheetId}
                onChange={e => setApiSheetId(e.target.value)}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  background: D.inputBg,
                  color: D.textPrimary,
                  border: `1px solid ${D.border}`,
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '13px',
                  outline: 'none',
                  fontFamily: 'inherit',
                }}
              />
            </div>
          )}
        </div>

        {smartsheetSource === 'local' && (
          <div
            className="form-group"
            style={{ marginTop: '15px', marginBottom: '0' }}
          >
            <div
              className="field-label"
              style={{ color: D.textMuted, marginBottom: '6px' }}
            >
              Arquivo Excel Local
              <div className="info-tooltip-container">
                <span className="info-tooltip-icon">❓</span>
                <span className="info-tooltip-bubble">
                  Arraste e solte o arquivo Excel exportado do Smartsheet ou
                  clique para abrir o seletor.
                </span>
              </div>
            </div>
            <div
              className={`dropzone-card${dragOverSmartsheet ? ' dragover' : ''}${smartsheetFile ? ' filled' : ''}`}
              onClick={pickSmartsheet}
              onDragOver={e => handleDragOver(e, 'smartsheet')}
              onDragLeave={() => handleDragLeave('smartsheet')}
              onDrop={e => handleDrop(e, 'smartsheet')}
              style={{ minHeight: '100px' }}
            >
              <div className="dropzone-card-icon">
                {Icons.file(smartsheetFile ? D.accent : D.textMuted)}
              </div>
              <div
                style={{
                  textAlign: 'center',
                  color: smartsheetFile ? D.textPrimary : D.textSecond,
                  fontSize: '13px',
                  wordBreak: 'break-all',
                  padding: '0 10px',
                }}
              >
                {smartsheetFile ? (
                  <strong>{smartsheetFile.split(/[\\/]/).pop()}</strong>
                ) : (
                  'Arraste o arquivo Excel aqui ou clique para selecionar'
                )}
              </div>
              {smartsheetFile && (
                <div
                  style={{
                    fontSize: '11px',
                    color: D.textMuted,
                    wordBreak: 'break-all',
                    maxWidth: '100%',
                  }}
                >
                  {smartsheetFile}
                </div>
              )}
              {smartsheetFile && (
                <button
                  className="input-field-clear"
                  onClick={e => {
                    e.stopPropagation()
                    setSmartsheetFile('')
                    setResult(null)
                  }}
                  style={{
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {Icons.close(D.textMuted)}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="form-group" style={{ marginBottom: '15px' }}>
        <div className="field-label" style={{ color: D.textMuted }}>
          Arthnex Summary CSV (Opcional - Para Triangulação)
          <div className="info-tooltip-container">
            <span className="info-tooltip-icon">❓</span>
            <span className="info-tooltip-bubble">
              Selecione o arquivo CSV do Arthnex Summary para realizar o
              cruzamento de aerogeradores auditados.
            </span>
          </div>
        </div>
        <div
          className={`dropzone-card${dragOverVendor ? ' dragover' : ''}${vendorFile ? ' filled' : ''}`}
          onClick={pickVendor}
          onDragOver={e => handleDragOver(e, 'vendor')}
          onDragLeave={() => handleDragLeave('vendor')}
          onDrop={e => handleDrop(e, 'vendor')}
          style={{ minHeight: '100px' }}
        >
          <div className="dropzone-card-icon">
            {Icons.file(vendorFile ? D.accent : D.textMuted)}
          </div>
          <div
            style={{
              textAlign: 'center',
              color: vendorFile ? D.textPrimary : D.textSecond,
              fontSize: '13px',
              wordBreak: 'break-all',
              padding: '0 10px',
            }}
          >
            {vendorFile ? (
              <strong>{vendorFile.split(/[\\/]/).pop()}</strong>
            ) : (
              'Arraste o arquivo CSV do Arthnex Summary ou clique para selecionar'
            )}
          </div>
          {vendorFile && (
            <div
              style={{
                fontSize: '11px',
                color: D.textMuted,
                wordBreak: 'break-all',
                maxWidth: '100%',
              }}
            >
              {vendorFile}
            </div>
          )}
          {vendorFile && (
            <button
              className="input-field-clear"
              onClick={e => {
                e.stopPropagation()
                setVendorFile('')
                setResult(null)
              }}
              style={{
                position: 'absolute',
                top: '10px',
                right: '10px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {Icons.close(D.textMuted)}
            </button>
          )}
        </div>
      </div>

      {/* Opções de Auditoria Integradas */}
      <div
        style={{
          display: 'flex',
          gap: '20px',
          marginBottom: '15px',
          flexWrap: 'wrap',
          background: D.bgCard,
          padding: '12px 15px',
          borderRadius: '8px',
          border: `1px solid ${D.border}`,
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: '600',
            color: D.textPrimary,
          }}
        >
          <input
            type="checkbox"
            checked={useEmailAudit}
            onChange={e => {
              setUseEmailAudit(e.target.checked)
              setResult(null)
            }}
            style={{
              width: '15px',
              height: '15px',
              accentColor: D.accent,
              cursor: 'pointer',
            }}
          />
          📧 Executar Auditoria do E-mail Diário (IMAP)
        </label>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: '600',
            color: D.textPrimary,
          }}
        >
          <input
            type="checkbox"
            checked={useOperationalAudit}
            onChange={e => {
              setUseOperationalAudit(e.target.checked)
              setResult(null)
            }}
            style={{
              width: '15px',
              height: '15px',
              accentColor: D.accent,
              cursor: 'pointer',
            }}
          />
          📋 Executar Triangulação de Campo (Formulário Operacional)
        </label>
      </div>

      {/* Date Filters */}
      <div
        className="form-group"
        style={{ marginBottom: '20px', display: 'flex', gap: '15px' }}
      >
        <div style={{ flex: 1 }}>
          <div className="field-label" style={{ color: D.textMuted }}>
            Data Inicial (Opcional)
          </div>
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: D.inputBg,
              color: D.textPrimary,
              border: `1px solid ${D.border}`,
              borderRadius: '6px',
              padding: '7px 10px',
              fontSize: '12.5px',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div className="field-label" style={{ color: D.textMuted }}>
            Data Final (Opcional)
          </div>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: D.inputBg,
              color: D.textPrimary,
              border: `1px solid ${D.border}`,
              borderRadius: '6px',
              padding: '7px 10px',
              fontSize: '12.5px',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>
      </div>

      {error && (
        <div
          style={{
            background: D.error + '22',
            color: D.error,
            padding: '12px',
            borderRadius: '8px',
            marginBottom: '20px',
          }}
        >
          <strong>Erro:</strong> {error}
        </div>
      )}

      {/* Action Button */}
      <div className="action-row" style={{ marginBottom: '20px' }}>
        <button
          className={`run-btn${running ? ' running' : ''}`}
          onClick={handleRun}
          disabled={
            running ||
            (smartsheetSource !== 'local' ? !apiSheetId : !smartsheetFile)
          }
        >
          {running ? T.processing : 'Analisar Workflow'}
        </button>
        <button
          className="sec-btn"
          onClick={handleExportSRPendente}
          disabled={
            running ||
            (smartsheetSource !== 'local' ? !apiSheetId : !smartsheetFile)
          }
        >
          {running ? 'Processando...' : 'Exportar SR Pendente'}
        </button>
        {result && (
          <div className="action-done">
            <div className="done-label" style={{ color: D.success }}>
              {Icons.check(D.success)}
              {T.done}
            </div>
            {result.output_file && isPyWebView && (
              <button
                className="open-output-btn"
                onClick={() => onOpenFolder(result.output_file)}
                style={{ border: `1px solid ${D.border}`, color: D.textSecond }}
              >
                {Icons.opendir(D.textSecond)}
                {T.open_output}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Skeleton Loading Panel when running */}
      {running && (
        <div
          style={{
            marginTop: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '15px',
            }}
          >
            <div className="skeleton-pulse" style={{ height: '70px' }}></div>
            <div className="skeleton-pulse" style={{ height: '70px' }}></div>
          </div>
          <div
            className="skeleton-pulse"
            style={{ height: '180px', borderRadius: '8px' }}
          ></div>
          <div
            className="skeleton-pulse"
            style={{ height: '250px', borderRadius: '8px' }}
          ></div>
        </div>
      )}

      {/* Dashboard Results */}
      {result && (
        <div
          className="workflow-dashboard"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            marginTop: '20px',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '15px',
            }}
          >
            <div
              style={{
                background: D.bgCard,
                padding: '15px',
                borderRadius: '8px',
                border: `1px solid ${D.border}`,
              }}
            >
              <div style={{ color: D.textMuted, fontSize: '12px' }}>
                Total de Campanhas
              </div>
              <div
                style={{
                  color: D.textPrimary,
                  fontSize: '24px',
                  fontWeight: 'bold',
                }}
              >
                {result.total_campanhas}
              </div>
            </div>
            <div
              style={{
                background: D.bgCard,
                padding: '15px',
                borderRadius: '8px',
                border: `1px solid ${D.border}`,
              }}
            >
              <div style={{ color: D.textMuted, fontSize: '12px' }}>
                Total de Escapes/Duplicados
              </div>
              <div
                style={{
                  color: result.total_escapes > 0 ? D.error : D.success,
                  fontSize: '24px',
                  fontWeight: 'bold',
                }}
              >
                {result.total_escapes}
              </div>
            </div>
            {result.operational_discrepancies && (
              <div
                style={{
                  background: D.bgCard,
                  padding: '15px',
                  borderRadius: '8px',
                  border: `1px solid ${D.border}`,
                }}
              >
                <div style={{ color: D.textMuted, fontSize: '12px' }}>
                  Divergências Operacionais
                </div>
                <div
                  style={{
                    color:
                      result.operational_discrepancies.length > 0
                        ? D.error
                        : D.success,
                    fontSize: '24px',
                    fontWeight: 'bold',
                  }}
                >
                  {result.operational_discrepancies.length}
                </div>
              </div>
            )}
          </div>

          {/* Diagnóstico: o que foi extraído do e-mail */}
          {result.email_parsed_summary &&
            result.email_parsed_summary.length > 0 && (
              <div
                style={{
                  background: D.bgCard,
                  borderRadius: '8px',
                  border: `1px solid ${D.border}`,
                  overflow: 'hidden',
                  marginBottom: '20px',
                }}
              >
                <div
                  style={{
                    padding: '12px 15px',
                    borderBottom: `1px solid ${D.border}`,
                    background: D.bgPanel,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      color: D.textPrimary,
                      fontSize: '13px',
                    }}
                  >
                    📨 Registros Extraídos do E-mail (
                    {result.email_parsed_summary.reduce((s, r) => s + r.Qtd, 0)}{' '}
                    turbinas em {result.email_parsed_summary.length} parque(s))
                  </h3>
                  <span style={{ fontSize: '11px', color: D.textMuted }}>
                    Use para verificar se um parque foi reconhecido
                  </span>
                </div>
                <div style={{ overflowX: 'auto', maxHeight: '200px' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      fontSize: '12.5px',
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          background: D.bgPanel,
                          color: D.textMuted,
                          position: 'sticky',
                          top: 0,
                        }}
                      >
                        <th
                          style={{
                            padding: '8px 15px',
                            borderBottom: `1px solid ${D.border}`,
                            textAlign: 'left',
                          }}
                        >
                          Parque
                        </th>
                        <th
                          style={{
                            padding: '8px 15px',
                            borderBottom: `1px solid ${D.border}`,
                            textAlign: 'left',
                          }}
                        >
                          WO
                        </th>
                        <th
                          style={{
                            padding: '8px 15px',
                            borderBottom: `1px solid ${D.border}`,
                            textAlign: 'center',
                          }}
                        >
                          Qtd
                        </th>
                        <th
                          style={{
                            padding: '8px 15px',
                            borderBottom: `1px solid ${D.border}`,
                            textAlign: 'left',
                          }}
                        >
                          Turbinas
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.email_parsed_summary.map((r, idx) => (
                        <tr
                          key={`eps-${idx}`}
                          style={{ borderBottom: `1px solid ${D.borderLight}` }}
                        >
                          <td
                            style={{
                              padding: '7px 15px',
                              color: D.textPrimary,
                              fontWeight: 500,
                            }}
                          >
                            {r.Parque}
                          </td>
                          <td
                            style={{ padding: '7px 15px', color: D.textSecond }}
                          >
                            {r.WO || '—'}
                          </td>
                          <td
                            style={{
                              padding: '7px 15px',
                              color: D.textSecond,
                              textAlign: 'center',
                            }}
                          >
                            {r.Qtd}
                          </td>
                          <td
                            style={{
                              padding: '7px 15px',
                              color: D.textMuted,
                              fontSize: '11.5px',
                            }}
                          >
                            {r.Turbinas}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

          {/* Resultados da Auditoria de E-mail Diário */}
          {result.triangulacao &&
            result.triangulacao.email_audit_results &&
            (() => {
              let auditColor = D.success
              let auditBg = D.success + '11'
              let auditTitle = '✅ E-mail Diário 100% Auditado'

              if (result.triangulacao.email_error) {
                auditColor = D.warning
                auditBg = D.warning + '11'
                auditTitle = '⚠️ Aviso da Auditoria de E-mail'
              } else if (result.triangulacao.email_audit_results.length > 0) {
                auditColor = D.error
                auditBg = D.error + '11'
                auditTitle = `🚨 Divergências no E-mail Diário (${result.triangulacao.email_audit_results.length})`
              }

              const divergenceTypes = Array.from(
                new Set(
                  result.triangulacao.email_audit_results
                    .map(e => e['Tipo de Divergência'])
                    .filter(Boolean)
                )
              )

              const filteredEmailResults =
                result.triangulacao.email_audit_results.filter(e => {
                  const matchesSearch =
                    (e.Parque &&
                      e.Parque.toLowerCase().includes(
                        searchTermEmail.toLowerCase()
                      )) ||
                    (e.Aerogerador &&
                      e.Aerogerador.toLowerCase().includes(
                        searchTermEmail.toLowerCase()
                      )) ||
                    (e['Tipo de Divergência'] &&
                      e['Tipo de Divergência']
                        .toLowerCase()
                        .includes(searchTermEmail.toLowerCase())) ||
                    (e['Ação Recomendada'] &&
                      e['Ação Recomendada']
                        .toLowerCase()
                        .includes(searchTermEmail.toLowerCase()))

                  const matchesFilter =
                    filterDivergencia === '' ||
                    e['Tipo de Divergência'] === filterDivergencia
                  return matchesSearch && matchesFilter
                })

              return (
                <div
                  style={{
                    background: D.bgCard,
                    borderRadius: '8px',
                    border: `1px solid ${auditColor}`,
                    overflow: 'hidden',
                    marginBottom: '20px',
                  }}
                >
                  <div
                    style={{
                      padding: '15px',
                      borderBottom: `1px solid ${D.border}`,
                      background: auditBg,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <h3
                        style={{
                          margin: 0,
                          color: auditColor,
                          fontSize: '14px',
                        }}
                      >
                        {auditTitle}
                      </h3>
                      <p
                        style={{
                          margin: '5px 0 0 0',
                          color: D.textSecond,
                          fontSize: '12px',
                        }}
                      >
                        {result.triangulacao.email_status_msg ||
                          'Cruzamento com o relatório de uploads diários do Arthnex.'}
                      </p>
                    </div>
                  </div>

                  {result.triangulacao.email_audit_results.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        gap: '10px',
                        padding: '10px 15px',
                        background: D.bgPanel,
                        borderBottom: `1px solid ${D.border}`,
                        flexWrap: 'wrap',
                      }}
                    >
                      <input
                        type="text"
                        placeholder="🔎 Buscar por Parque, WTG ou Recomendação..."
                        value={searchTermEmail}
                        onChange={e => setSearchTermEmail(e.target.value)}
                        style={{
                          flex: 1.5,
                          minWidth: '200px',
                          padding: '6px 10px',
                          fontSize: '12.5px',
                          background: D.inputBg,
                          color: D.textPrimary,
                          border: `1px solid ${D.border}`,
                          borderRadius: '4px',
                          outline: 'none',
                          fontFamily: 'inherit',
                        }}
                      />
                      <select
                        value={filterDivergencia}
                        onChange={e => setFilterDivergencia(e.target.value)}
                        style={{
                          flex: 1,
                          minWidth: '180px',
                          padding: '6px 10px',
                          fontSize: '12.5px',
                          background: D.inputBg,
                          color: D.textPrimary,
                          border: `1px solid ${D.border}`,
                          borderRadius: '4px',
                          outline: 'none',
                          fontFamily: 'inherit',
                        }}
                      >
                        <option value="">
                          📋 Filtrar por Divergência (Todos)
                        </option>
                        {divergenceTypes.map((type, idx) => (
                          <option key={idx} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {filteredEmailResults.length > 0 ? (
                    <div style={{ overflowX: 'auto', maxHeight: '350px' }}>
                      <table
                        style={{
                          width: '100%',
                          borderCollapse: 'collapse',
                          fontSize: '13px',
                        }}
                      >
                        <thead>
                          <tr
                            style={{
                              background: D.bgPanel,
                              color: D.textMuted,
                              textAlign: 'left',
                              position: 'sticky',
                              top: 0,
                            }}
                          >
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '15%',
                              }}
                            >
                              Parque
                            </th>
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '10%',
                              }}
                            >
                              WTG
                            </th>
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '15%',
                              }}
                            >
                              Data no E-mail
                            </th>
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '18%',
                              }}
                            >
                              No E-mail
                            </th>
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '18%',
                              }}
                            >
                              No Smartsheet
                            </th>
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '24%',
                              }}
                            >
                              Divergência / Ação
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredEmailResults.map((e, idx) => (
                            <tr
                              key={`em-${idx}`}
                              style={{
                                borderBottom: `1px solid ${D.borderLight}`,
                              }}
                            >
                              <td
                                style={{
                                  padding: '10px 15px',
                                  color: D.textPrimary,
                                }}
                              >
                                {e.Parque}
                              </td>
                              <td
                                style={{
                                  padding: '10px 15px',
                                  color: D.textPrimary,
                                }}
                              >
                                {e.Aerogerador}
                              </td>
                              <td
                                style={{
                                  padding: '10px 15px',
                                  color: D.textSecond,
                                }}
                              >
                                {e['Data no E-mail'] || 'N/A'}
                              </td>
                              <td
                                style={{
                                  padding: '10px 15px',
                                  color: D.textSecond,
                                }}
                              >
                                {e['Status no E-mail']}
                              </td>
                              <td
                                style={{
                                  padding: '10px 15px',
                                  color: D.textSecond,
                                }}
                              >
                                {e['Status no Smartsheet']}
                              </td>
                              <td style={{ padding: '10px 15px' }}>
                                <div
                                  style={{ color: D.error, fontWeight: '500' }}
                                >
                                  {e['Tipo de Divergência']}
                                </div>
                                <div
                                  style={{
                                    color: D.textMuted,
                                    fontSize: '11px',
                                    marginTop: '2px',
                                  }}
                                >
                                  {e['Ação Recomendada']}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div
                      style={{
                        padding: '20px',
                        textAlign: 'center',
                        color: D.textSecond,
                        fontSize: '13.5px',
                      }}
                    >
                      {result.triangulacao.email_error ? (
                        <span style={{ color: D.warning, fontWeight: '500' }}>
                          ⚠️ {result.triangulacao.email_error}
                        </span>
                      ) : result.triangulacao.email_audit_results.length > 0 ? (
                        'Nenhum resultado corresponde à busca/filtro.'
                      ) : (
                        'Nenhuma divergência encontrada entre os uploads do e-mail e as atualizações no Smartsheet! 🎉'
                      )}
                    </div>
                  )}
                </div>
              )
            })()}

          {/* Resultados da Auditoria Operacional (Triangulação de Campo) */}
          {result.operational_discrepancies &&
            (() => {
              let auditColor = D.success
              let auditBg = D.success + '11'
              let auditTitle = '✅ Auditoria Operacional 100% Regular'

              if (result.operational_discrepancies.length > 0) {
                auditColor = D.error
                auditBg = D.error + '11'
                auditTitle = `🚨 Divergências na Auditoria Operacional (${result.operational_discrepancies.length})`
              }

              const filteredOperationalResults =
                result.operational_discrepancies.filter(e => {
                  const matchesSearch =
                    (e.Parque &&
                      e.Parque.toLowerCase().includes(
                        searchTermOperational.toLowerCase()
                      )) ||
                    (e.Aerogerador &&
                      e.Aerogerador.toLowerCase().includes(
                        searchTermOperational.toLowerCase()
                      )) ||
                    (e.Piloto &&
                      e.Piloto.toLowerCase().includes(
                        searchTermOperational.toLowerCase()
                      )) ||
                    (e.Auxiliar &&
                      e.Auxiliar.toLowerCase().includes(
                        searchTermOperational.toLowerCase()
                      )) ||
                    (e.Drone &&
                      e.Drone.toLowerCase().includes(
                        searchTermOperational.toLowerCase()
                      )) ||
                    (e['Tipo de Divergência'] &&
                      e['Tipo de Divergência']
                        .toLowerCase()
                        .includes(searchTermOperational.toLowerCase())) ||
                    (e['Ação Recomendada'] &&
                      e['Ação Recomendada']
                        .toLowerCase()
                        .includes(searchTermOperational.toLowerCase()))
                  return matchesSearch
                })

              return (
                <div
                  style={{
                    background: D.bgCard,
                    borderRadius: '8px',
                    border: `1px solid ${auditColor}`,
                    overflow: 'hidden',
                    marginBottom: '20px',
                  }}
                >
                  <div
                    style={{
                      padding: '15px',
                      borderBottom: `1px solid ${D.border}`,
                      background: auditBg,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <h3
                        style={{
                          margin: 0,
                          color: auditColor,
                          fontSize: '14px',
                        }}
                      >
                        {auditTitle}
                      </h3>
                      <p
                        style={{
                          margin: '5px 0 0 0',
                          color: D.textSecond,
                          fontSize: '12px',
                        }}
                      >
                        Cruzamento entre Smartsheet, E-mail Diário e o
                        Formulário Operacional de Campo.
                      </p>
                    </div>
                  </div>

                  {result.operational_discrepancies.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        padding: '10px 15px',
                        background: D.bgPanel,
                        borderBottom: `1px solid ${D.border}`,
                      }}
                    >
                      <input
                        type="text"
                        placeholder="🔎 Buscar por Parque, WTG, Piloto, Drone ou Recomendação..."
                        value={searchTermOperational}
                        onChange={e => setSearchTermOperational(e.target.value)}
                        style={{
                          flex: 1,
                          padding: '6px 10px',
                          fontSize: '12.5px',
                          background: D.inputBg,
                          color: D.textPrimary,
                          border: `1px solid ${D.border}`,
                          borderRadius: '4px',
                          outline: 'none',
                          fontFamily: 'inherit',
                        }}
                      />
                    </div>
                  )}

                  {filteredOperationalResults.length > 0 ? (
                    <div style={{ overflowX: 'auto', maxHeight: '350px' }}>
                      <table
                        style={{
                          width: '100%',
                          borderCollapse: 'collapse',
                          fontSize: '13px',
                        }}
                      >
                        <thead>
                          <tr
                            style={{
                              background: D.bgPanel,
                              color: D.textMuted,
                              textAlign: 'left',
                              position: 'sticky',
                              top: 0,
                            }}
                          >
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '15%',
                              }}
                            >
                              Parque
                            </th>
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '10%',
                              }}
                            >
                              WTG
                            </th>
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '15%',
                              }}
                            >
                              Data no Campo
                            </th>
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '25%',
                              }}
                            >
                              Equipe (Piloto / Auxiliar / Drone)
                            </th>
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '15%',
                              }}
                            >
                              Status
                            </th>
                            <th
                              style={{
                                padding: '10px 15px',
                                borderBottom: `1px solid ${D.border}`,
                                width: '20%',
                              }}
                            >
                              Recomendação
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredOperationalResults.map((e, idx) => (
                            <tr
                              key={`op-${idx}`}
                              style={{
                                borderBottom: `1px solid ${D.borderLight}`,
                              }}
                            >
                              <td
                                style={{
                                  padding: '10px 15px',
                                  color: D.textPrimary,
                                }}
                              >
                                {e.Parque}
                              </td>
                              <td
                                style={{
                                  padding: '10px 15px',
                                  color: D.textPrimary,
                                }}
                              >
                                {e.Aerogerador}
                              </td>
                              <td
                                style={{
                                  padding: '10px 15px',
                                  color: D.textSecond,
                                }}
                              >
                                {e['Data no Campo'] || 'N/A'}
                              </td>
                              <td
                                style={{
                                  padding: '10px 15px',
                                  color: D.textSecond,
                                }}
                              >
                                {e.Piloto !== 'N/A' ||
                                e.Auxiliar !== 'N/A' ||
                                e.Drone !== 'N/A' ? (
                                  <div>
                                    <div>
                                      👤 <strong>Piloto:</strong> {e.Piloto}
                                    </div>
                                    <div>
                                      👥 <strong>Auxiliar:</strong> {e.Auxiliar}
                                    </div>
                                    <div>
                                      🚁 <strong>Drone:</strong> {e.Drone}
                                    </div>
                                  </div>
                                ) : (
                                  'N/A'
                                )}
                              </td>
                              <td style={{ padding: '10px 15px' }}>
                                <div
                                  style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: '4px',
                                  }}
                                >
                                  {(e.Status || '')
                                    .split(' | ')
                                    .map((st, si) => (
                                      <span
                                        key={si}
                                        style={{
                                          padding: '3px 6px',
                                          borderRadius: '4px',
                                          fontSize: '11px',
                                          fontWeight: 'bold',
                                          background:
                                            st === 'Ausente no E-mail'
                                              ? D.warning + '22'
                                              : st === 'Ausente no Smartsheet'
                                                ? D.error + '22'
                                                : D.textMuted + '22',
                                          color:
                                            st === 'Ausente no E-mail'
                                              ? D.warning
                                              : st === 'Ausente no Smartsheet'
                                                ? D.error
                                                : D.textMuted,
                                        }}
                                      >
                                        {st}
                                      </span>
                                    ))}
                                </div>
                                <div
                                  style={{
                                    color: D.textSecond,
                                    fontSize: '11px',
                                    marginTop: '6px',
                                  }}
                                >
                                  {e['Tipo de Divergência']}
                                </div>
                              </td>
                              <td
                                style={{
                                  padding: '10px 15px',
                                  color: D.textMuted,
                                  fontSize: '12px',
                                }}
                              >
                                {e['Ação Recomendada']}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div
                      style={{
                        padding: '20px',
                        textAlign: 'center',
                        color: D.textSecond,
                        fontSize: '13.5px',
                      }}
                    >
                      {result.operational_discrepancies.length > 0
                        ? 'Nenhum resultado corresponde à busca/filtro.'
                        : 'Nenhuma divergência operacional encontrada! 🎉'}
                    </div>
                  )}
                </div>
              )
            })()}

          {/* Alertas de Escape - Somente se NÃO tiver Vendor */}
          {(!result.triangulacao || !result.triangulacao.has_vendor) &&
            result.escapes &&
            result.escapes.length > 0 &&
            (() => {
              const filteredEscapes = result.escapes.filter(
                e =>
                  (e.Wind_Farm &&
                    e.Wind_Farm.toLowerCase().includes(
                      searchTermEscapes.toLowerCase()
                    )) ||
                  (e.Turbine_Id &&
                    e.Turbine_Id.toLowerCase().includes(
                      searchTermEscapes.toLowerCase()
                    ))
              )

              return (
                <div
                  style={{
                    background: D.bgCard,
                    borderRadius: '8px',
                    border: `1px solid ${D.error}`,
                    overflow: 'hidden',
                    marginBottom: '20px',
                  }}
                >
                  <div
                    style={{
                      padding: '15px',
                      borderBottom: `1px solid ${D.border}`,
                      background: D.error + '11',
                    }}
                  >
                    <h3 style={{ margin: 0, color: D.error, fontSize: '14px' }}>
                      🚨 Alertas de Escape Encontrados ({result.escapes.length})
                    </h3>
                    <p
                      style={{
                        margin: '5px 0 0 0',
                        color: D.textSecond,
                        fontSize: '12px',
                      }}
                    >
                      Turbinas lançadas mais de uma vez na mesma Campanha sem
                      marcação de recoleta (*)
                    </p>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      padding: '10px 15px',
                      background: D.bgPanel,
                      borderBottom: `1px solid ${D.border}`,
                    }}
                  >
                    <input
                      type="text"
                      placeholder="🔎 Filtrar escapes..."
                      value={searchTermEscapes}
                      onChange={e => setSearchTermEscapes(e.target.value)}
                      style={{
                        flex: 1,
                        padding: '6px 10px',
                        fontSize: '12.5px',
                        background: D.inputBg,
                        color: D.textPrimary,
                        border: `1px solid ${D.border}`,
                        borderRadius: '4px',
                        outline: 'none',
                        fontFamily: 'inherit',
                      }}
                    />
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table
                      style={{
                        width: '100%',
                        borderCollapse: 'collapse',
                        fontSize: '13px',
                      }}
                    >
                      <thead>
                        <tr
                          style={{
                            background: D.bgPanel,
                            color: D.textMuted,
                            textAlign: 'left',
                          }}
                        >
                          <th
                            style={{
                              padding: '10px 15px',
                              borderBottom: `1px solid ${D.border}`,
                            }}
                          >
                            Wind Farm
                          </th>
                          <th
                            style={{
                              padding: '10px 15px',
                              borderBottom: `1px solid ${D.border}`,
                            }}
                          >
                            Turbine Id
                          </th>
                          <th
                            style={{
                              padding: '10px 15px',
                              borderBottom: `1px solid ${D.border}`,
                            }}
                          >
                            Qtd Registros
                          </th>
                          <th
                            style={{
                              padding: '10px 15px',
                              borderBottom: `1px solid ${D.border}`,
                            }}
                          >
                            Campanha Envolvida
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredEscapes.map((e, idx) => (
                          <tr
                            key={idx}
                            style={{
                              borderBottom: `1px solid ${D.borderLight}`,
                            }}
                          >
                            <td
                              style={{
                                padding: '10px 15px',
                                color: D.textPrimary,
                              }}
                            >
                              {e.Wind_Farm}
                            </td>
                            <td
                              style={{
                                padding: '10px 15px',
                                color: D.textPrimary,
                              }}
                            >
                              {e.Turbine_Id}
                            </td>
                            <td
                              style={{
                                padding: '10px 15px',
                                color: D.error,
                                fontWeight: 'bold',
                              }}
                            >
                              {e.Registros}
                            </td>
                            <td
                              style={{
                                padding: '10px 15px',
                                color: D.textSecond,
                              }}
                            >
                              {e.WF_Ids}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })()}

          {/* Triangulação Arthnex vs Smartsheet */}
          {result.triangulacao &&
            result.triangulacao.has_vendor &&
            (() => {
              const filteredSmartsheet =
                result.triangulacao.missing_in_smartsheet.filter(
                  e =>
                    (e.Wind_Farm &&
                      e.Wind_Farm.toLowerCase().includes(
                        searchTermTriangulation.toLowerCase()
                      )) ||
                    (e.Turbine_Id &&
                      e.Turbine_Id.toLowerCase().includes(
                        searchTermTriangulation.toLowerCase()
                      ))
                )
              const filteredVendor =
                result.triangulacao.missing_in_vendor.filter(
                  e =>
                    (e.Wind_Farm &&
                      e.Wind_Farm.toLowerCase().includes(
                        searchTermTriangulation.toLowerCase()
                      )) ||
                    (e.Turbine_Id &&
                      e.Turbine_Id.toLowerCase().includes(
                        searchTermTriangulation.toLowerCase()
                      ))
                )

              return (
                <div
                  id="triangulation-dashboard"
                  style={{
                    background: D.bgCard,
                    borderRadius: '8px',
                    border: `1px solid ${D.border}`,
                    overflow: 'hidden',
                  }}
                >
                  {/* Report Header (Visible only when exporting) */}
                  {isExporting && (
                    <div
                      style={{
                        padding: '20px',
                        background: D.bgPanel,
                        borderBottom: `2px solid ${D.accent}`,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                        }}
                      >
                        <div>
                          <h2
                            style={{
                              margin: '0 0 10px 0',
                              color: D.textPrimary,
                              fontSize: '20px',
                            }}
                          >
                            Relatório Oficial de Auditoria QA
                          </h2>
                          <div
                            style={{
                              color: D.textSecond,
                              fontSize: '13px',
                              lineHeight: '1.5',
                            }}
                          >
                            <div>
                              <strong>Campanha(s):</strong>{' '}
                              {result.triangulacao.campaigns
                                ? result.triangulacao.campaigns.join(', ')
                                : 'N/A'}
                            </div>
                            <div>
                              <strong>Parque(s) Eólico(s):</strong>{' '}
                              {result.triangulacao.wind_farms
                                ? result.triangulacao.wind_farms.join(', ')
                                : 'N/A'}
                            </div>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div
                            style={{
                              color: D.textMuted,
                              fontSize: '11px',
                              textTransform: 'uppercase',
                            }}
                          >
                            Data de Emissão
                          </div>
                          <div
                            style={{
                              color: D.textPrimary,
                              fontSize: '14px',
                              fontWeight: 'bold',
                            }}
                          >
                            {new Date().toLocaleDateString('pt-BR')}
                          </div>
                          <div
                            style={{ color: D.textSecond, fontSize: '12px' }}
                          >
                            {new Date().toLocaleTimeString('pt-BR')}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div
                    style={{
                      padding: '15px',
                      borderBottom: `1px solid ${D.border}`,
                      background: D.accent + '11',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <h3
                        style={{ margin: 0, color: D.accent, fontSize: '14px' }}
                      >
                        🔍 Triangulação Arthnex vs Smartsheet
                      </h3>
                      <p
                        style={{
                          margin: '5px 0 0 0',
                          color: D.textSecond,
                          fontSize: '12px',
                        }}
                      >
                        Auditoria Focada: Comparação de Turbinas inspecionadas
                        no período.
                      </p>
                    </div>
                    {!isExporting && (
                      <button
                        onClick={exportReportAsImage}
                        style={{
                          background: D.accent,
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          padding: '8px 12px',
                          fontSize: '12px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                      >
                        📸 Exportar Relatório Visual
                      </button>
                    )}
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        'repeat(auto-fit, minmax(180px, 1fr))',
                      gap: '1px',
                      background: D.border,
                      borderBottom: `1px solid ${D.border}`,
                    }}
                  >
                    <div
                      style={{
                        background: D.bgCard,
                        padding: '15px',
                        textAlign: 'center',
                      }}
                    >
                      <div
                        style={{
                          color: D.textMuted,
                          fontSize: '11px',
                          textTransform: 'uppercase',
                        }}
                      >
                        Match Perfeito
                      </div>
                      <div
                        style={{
                          color: D.success,
                          fontSize: '20px',
                          fontWeight: 'bold',
                        }}
                      >
                        {result.triangulacao.match.length}
                      </div>
                    </div>
                    <div
                      style={{
                        background: D.bgCard,
                        padding: '15px',
                        textAlign: 'center',
                      }}
                    >
                      <div
                        style={{
                          color: D.textMuted,
                          fontSize: '11px',
                          textTransform: 'uppercase',
                        }}
                      >
                        Faltam no Smartsheet
                      </div>
                      <div
                        style={{
                          color:
                            result.triangulacao.missing_in_smartsheet.length > 0
                              ? D.error
                              : D.success,
                          fontSize: '20px',
                          fontWeight: 'bold',
                        }}
                      >
                        {result.triangulacao.missing_in_smartsheet.length}
                      </div>
                    </div>
                    <div
                      style={{
                        background: D.bgCard,
                        padding: '15px',
                        textAlign: 'center',
                      }}
                    >
                      <div
                        style={{
                          color: D.textMuted,
                          fontSize: '11px',
                          textTransform: 'uppercase',
                        }}
                      >
                        Faltam no Arthnex
                      </div>
                      <div
                        style={{
                          color:
                            result.triangulacao.missing_in_vendor.length > 0
                              ? D.warning
                              : D.success,
                          fontSize: '20px',
                          fontWeight: 'bold',
                        }}
                      >
                        {result.triangulacao.missing_in_vendor.length}
                      </div>
                    </div>
                  </div>

                  {(result.triangulacao.missing_in_smartsheet.length > 0 ||
                    result.triangulacao.missing_in_vendor.length > 0) && (
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          padding: '10px 15px',
                          background: D.bgPanel,
                          borderBottom: `1px solid ${D.border}`,
                        }}
                      >
                        <input
                          type="text"
                          placeholder="🔎 Filtrar divergências de triangulação..."
                          value={searchTermTriangulation}
                          onChange={e =>
                            setSearchTermTriangulation(e.target.value)
                          }
                          style={{
                            flex: 1,
                            padding: '6px 10px',
                            fontSize: '12.5px',
                            background: D.inputBg,
                            color: D.textPrimary,
                            border: `1px solid ${D.border}`,
                            borderRadius: '4px',
                            outline: 'none',
                            fontFamily: 'inherit',
                          }}
                        />
                      </div>
                      <div style={{ overflowX: 'auto', maxHeight: '300px' }}>
                        <table
                          style={{
                            width: '100%',
                            borderCollapse: 'collapse',
                            fontSize: '13px',
                          }}
                        >
                          <thead>
                            <tr
                              style={{
                                background: D.bgPanel,
                                color: D.textMuted,
                                textAlign: 'left',
                                position: 'sticky',
                                top: 0,
                              }}
                            >
                              <th
                                style={{
                                  padding: '8px 15px',
                                  borderBottom: `1px solid ${D.border}`,
                                  width: '30%',
                                }}
                              >
                                Wind Farm / Site
                              </th>
                              <th
                                style={{
                                  padding: '8px 15px',
                                  borderBottom: `1px solid ${D.border}`,
                                  width: '20%',
                                }}
                              >
                                Turbina
                              </th>
                              <th
                                style={{
                                  padding: '8px 15px',
                                  borderBottom: `1px solid ${D.border}`,
                                  width: '30%',
                                }}
                              >
                                Problema
                              </th>
                              <th
                                style={{
                                  padding: '8px 15px',
                                  borderBottom: `1px solid ${D.border}`,
                                  width: '20%',
                                }}
                              >
                                Data Coleta / Último Acesso
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredSmartsheet.map((e, idx) => (
                              <tr
                                key={`ms-${idx}`}
                                style={{
                                  borderBottom: `1px solid ${D.borderLight}`,
                                }}
                              >
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.textPrimary,
                                  }}
                                >
                                  {e.Wind_Farm}
                                </td>
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.textPrimary,
                                  }}
                                >
                                  {e.Turbine_Id}
                                </td>
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.error,
                                    fontWeight: '500',
                                  }}
                                >
                                  Não está no Smartsheet
                                </td>
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.textSecond,
                                  }}
                                >
                                  {e.Date || 'N/A'}
                                </td>
                              </tr>
                            ))}
                            {filteredVendor.map((e, idx) => (
                              <tr
                                key={`mv-${idx}`}
                                style={{
                                  borderBottom: `1px solid ${D.borderLight}`,
                                }}
                              >
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.textPrimary,
                                  }}
                                >
                                  {e.Wind_Farm}
                                </td>
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.textPrimary,
                                  }}
                                >
                                  {e.Turbine_Id}
                                </td>
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.warning,
                                    fontWeight: '500',
                                  }}
                                >
                                  Não está no Arthnex
                                </td>
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.textSecond,
                                  }}
                                >
                                  {e.Date || 'N/A'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Divergências de Coleta Parcial vs Completa (Internas) */}
                  {result.triangulacao.divergencias_coleta &&
                    result.triangulacao.divergencias_coleta.length > 0 && (
                      <div style={{ borderTop: `1px solid ${D.border}` }}>
                        <div
                          style={{
                            padding: '12px 15px',
                            background: D.warning + '22',
                          }}
                        >
                          <h4
                            style={{
                              margin: 0,
                              color: D.warning,
                              fontSize: '13.5px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            ⚖️ Divergências de Coleta Parcial vs Completa (
                            {result.triangulacao.divergencias_coleta.length})
                          </h4>
                          <p
                            style={{
                              margin: '3px 0 0 0',
                              color: D.textSecond,
                              fontSize: '11px',
                            }}
                          >
                            Diferença entre a quantidade de pás coletadas no
                            Smartsheet e no Arthnex (Internas).
                          </p>
                        </div>
                        <div style={{ overflowX: 'auto', maxHeight: '250px' }}>
                          <table
                            style={{
                              width: '100%',
                              borderCollapse: 'collapse',
                              fontSize: '12.5px',
                            }}
                          >
                            <thead>
                              <tr
                                style={{
                                  background: D.bgPanel,
                                  color: D.textMuted,
                                  textAlign: 'left',
                                  position: 'sticky',
                                  top: 0,
                                }}
                              >
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                  }}
                                >
                                  Wind Farm / Site
                                </th>
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                  }}
                                >
                                  Turbina
                                </th>
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                    textAlign: 'center',
                                  }}
                                >
                                  Blades Smartsheet
                                </th>
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                    textAlign: 'center',
                                  }}
                                >
                                  Blades Arthnex
                                </th>
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                    textAlign: 'center',
                                  }}
                                >
                                  Diferença
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {result.triangulacao.divergencias_coleta.map(
                                (div, idx) => (
                                  <tr
                                    key={`div-${idx}`}
                                    style={{
                                      borderBottom: `1px solid ${D.borderLight}`,
                                    }}
                                  >
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color: D.textPrimary,
                                      }}
                                    >
                                      {div.Wind_Farm}
                                    </td>
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color: D.textPrimary,
                                      }}
                                    >
                                      {div.Turbine_Id}
                                    </td>
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color: D.textPrimary,
                                        textAlign: 'center',
                                      }}
                                    >
                                      <span style={{ fontWeight: '600' }}>
                                        {div.Smartsheet_Blades}
                                      </span>{' '}
                                      <span
                                        style={{
                                          color: D.textMuted,
                                          fontSize: '11px',
                                        }}
                                      >
                                        ({div.Smartsheet_Blades_Detail})
                                      </span>
                                    </td>
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color: D.textPrimary,
                                        textAlign: 'center',
                                        fontWeight: '600',
                                      }}
                                    >
                                      {div.Vendor_Blades}
                                    </td>
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color:
                                          div.Diferenca > 0
                                            ? D.success
                                            : D.error,
                                        textAlign: 'center',
                                        fontWeight: 'bold',
                                      }}
                                    >
                                      {div.Diferenca > 0
                                        ? `+${div.Diferenca} no Arthnex`
                                        : `${div.Diferenca} no Arthnex`}
                                    </td>
                                  </tr>
                                )
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                  {/* Saúde do Projeto (Status) com SVG Donut Chart */}
                  {result.triangulacao.status_counts && (
                    <div style={{ borderTop: `1px solid ${D.border}` }}>
                      <div style={{ padding: '15px', background: D.bgPanel }}>
                        <h4
                          style={{
                            margin: 0,
                            color: D.textPrimary,
                            fontSize: '13px',
                          }}
                        >
                          📊 Status da Campanha (Smartsheet)
                        </h4>
                        <p
                          style={{
                            margin: '3px 0 0 0',
                            color: D.textMuted,
                            fontSize: '11px',
                          }}
                        >
                          Progresso atual das turbinas no projeto
                        </p>
                      </div>

                      {/* Native Donut Chart Section */}
                      <div
                        style={{
                          padding: '20px',
                          background: D.bgCard,
                          borderBottom: `1px solid ${D.border}`,
                        }}
                      >
                        {renderStatusDonutChart(
                          result.triangulacao.status_counts
                        )}
                      </div>

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns:
                            'repeat(auto-fit, minmax(130px, 1fr))',
                          gap: '1px',
                          background: D.border,
                        }}
                      >
                        <div
                          style={{
                            background: D.bgCard,
                            padding: '12px',
                            textAlign: 'center',
                          }}
                        >
                          <div
                            style={{
                              color: D.success,
                              fontSize: '20px',
                              fontWeight: 'bold',
                            }}
                          >
                            {result.triangulacao.status_counts.verde}
                          </div>
                          <div
                            style={{
                              color: D.textSecond,
                              fontSize: '11px',
                              marginTop: '4px',
                            }}
                          >
                            {result.is_internal
                              ? '🟢 Defeitos Relatados'
                              : '🟢 Já Inspecionado'}
                          </div>
                        </div>
                        <div
                          style={{
                            background: D.bgCard,
                            padding: '12px',
                            textAlign: 'center',
                          }}
                        >
                          <div
                            style={{
                              color: D.textMuted,
                              fontSize: '20px',
                              fontWeight: 'bold',
                            }}
                          >
                            {result.triangulacao.status_counts.cinza}
                          </div>
                          <div
                            style={{
                              color: D.textSecond,
                              fontSize: '11px',
                              marginTop: '4px',
                            }}
                          >
                            {result.is_internal
                              ? '⚪ Inspeção Iniciada'
                              : '⚪ SR Concluído'}
                          </div>
                        </div>
                        <div
                          style={{
                            background: D.bgCard,
                            padding: '12px',
                            textAlign: 'center',
                          }}
                        >
                          <div
                            style={{
                              color: D.warning,
                              fontSize: '20px',
                              fontWeight: 'bold',
                            }}
                          >
                            {result.triangulacao.status_counts.amarelo}
                          </div>
                          <div
                            style={{
                              color: D.textSecond,
                              fontSize: '11px',
                              marginTop: '4px',
                            }}
                          >
                            {result.is_internal
                              ? '🟡 S&R Liberado'
                              : '🟡 Pendências (SR)'}
                          </div>
                        </div>
                        <div
                          style={{
                            background: D.bgCard,
                            padding: '12px',
                            textAlign: 'center',
                          }}
                        >
                          <div
                            style={{
                              color: D.error,
                              fontSize: '20px',
                              fontWeight: 'bold',
                            }}
                          >
                            {result.triangulacao.status_counts.vermelho}
                          </div>
                          <div
                            style={{
                              color: D.textSecond,
                              fontSize: '11px',
                              marginTop: '4px',
                            }}
                          >
                            {result.is_internal
                              ? '🔴 Pendente S&R'
                              : '🔴 Faltando Fazer SR'}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Tabela de Pendências Amarelas */}
                  {result.triangulacao.yellow_issues &&
                    result.triangulacao.yellow_issues.length > 0 && (
                      <div style={{ borderTop: `1px solid ${D.border}` }}>
                        <div
                          style={{
                            padding: '12px 15px',
                            background: D.warning + '11',
                          }}
                        >
                          <h4
                            style={{
                              margin: 0,
                              color: D.warning,
                              fontSize: '13px',
                            }}
                          >
                            ⚠️ Pendências a Resolver (Amarelo)
                          </h4>
                        </div>
                        <div style={{ overflowX: 'auto', maxHeight: '250px' }}>
                          <table
                            style={{
                              width: '100%',
                              borderCollapse: 'collapse',
                              fontSize: '12px',
                            }}
                          >
                            <thead>
                              <tr
                                style={{
                                  background: D.bgPanel,
                                  color: D.textMuted,
                                  textAlign: 'left',
                                  position: 'sticky',
                                  top: 0,
                                }}
                              >
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                    width: '20%',
                                  }}
                                >
                                  Wind Farm
                                </th>
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                    width: '15%',
                                  }}
                                >
                                  Turbina
                                </th>
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                    width: '65%',
                                  }}
                                >
                                  Comentários / Observações
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {result.triangulacao.yellow_issues.map(
                                (issue, idx) => (
                                  <tr
                                    key={`yi-${idx}`}
                                    style={{
                                      borderBottom: `1px solid ${D.borderLight}`,
                                    }}
                                  >
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color: D.textPrimary,
                                      }}
                                    >
                                      {issue.Wind_Farm}
                                    </td>
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color: D.textPrimary,
                                      }}
                                    >
                                      {issue.Turbine_Id}
                                    </td>
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color: D.textSecond,
                                        fontStyle:
                                          issue.Observacoes ===
                                          'Sem comentários'
                                            ? 'italic'
                                            : 'normal',
                                      }}
                                    >
                                      {issue.Observacoes}
                                    </td>
                                  </tr>
                                )
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                  {/* Tabela de Recoletas */}
                  {result.triangulacao.recoletas &&
                    result.triangulacao.recoletas.length > 0 && (
                      <div style={{ borderTop: `1px solid ${D.border}` }}>
                        <div
                          style={{
                            padding: '12px 15px',
                            background: D.accent + '11',
                          }}
                        >
                          <h4
                            style={{
                              margin: 0,
                              color: D.accent,
                              fontSize: '13px',
                            }}
                          >
                            🔄 Rastreio de Recoletas (
                            {result.triangulacao.recoletas.length})
                          </h4>
                          <p
                            style={{
                              margin: '3px 0 0 0',
                              color: D.textMuted,
                              fontSize: '11px',
                            }}
                          >
                            Auditoria de turbinas marcadas com asterisco (*) no
                            Smartsheet
                          </p>
                        </div>
                        <div style={{ overflowX: 'auto', maxHeight: '250px' }}>
                          <table
                            style={{
                              width: '100%',
                              borderCollapse: 'collapse',
                              fontSize: '12px',
                            }}
                          >
                            <thead>
                              <tr
                                style={{
                                  background: D.bgPanel,
                                  color: D.textMuted,
                                  textAlign: 'left',
                                  position: 'sticky',
                                  top: 0,
                                }}
                              >
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                    width: '25%',
                                  }}
                                >
                                  Wind Farm
                                </th>
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                    width: '25%',
                                  }}
                                >
                                  Turbina
                                </th>
                                <th
                                  style={{
                                    padding: '8px 15px',
                                    borderBottom: `1px solid ${D.border}`,
                                    width: '50%',
                                  }}
                                >
                                  Status da Recoleta
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {result.triangulacao.recoletas.map((rec, idx) => {
                                const isSuccess =
                                  rec.Status_Recoleta.includes('Sucesso')
                                const isWarning =
                                  rec.Status_Recoleta.includes('Verificar') ||
                                  rec.Status_Recoleta.includes('Amarelo')
                                const isError =
                                  rec.Status_Recoleta.includes(
                                    'Não iniciada'
                                  ) || rec.Status_Recoleta.includes('Pendente')

                                let statusColor = D.textPrimary
                                if (isSuccess) statusColor = D.success
                                else if (isWarning) statusColor = D.warning
                                else if (isError) statusColor = D.error

                                return (
                                  <tr
                                    key={`rec-${idx}`}
                                    style={{
                                      borderBottom: `1px solid ${D.borderLight}`,
                                    }}
                                  >
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color: D.textPrimary,
                                      }}
                                    >
                                      {rec.Wind_Farm}
                                    </td>
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color: D.textPrimary,
                                      }}
                                    >
                                      {rec.Turbine_Id}
                                    </td>
                                    <td
                                      style={{
                                        padding: '8px 15px',
                                        color: statusColor,
                                        fontWeight: '500',
                                      }}
                                    >
                                      {rec.Status_Recoleta}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                  {/* Tabela de Pás em Solo / Componentes Avulsos */}
                  {result.ground_blades && result.ground_blades.length > 0 && (
                    <div style={{ borderTop: `1px solid ${D.border}` }}>
                      <div
                        style={{
                          padding: '12px 15px',
                          background: D.accent + '11',
                        }}
                      >
                        <h4
                          style={{
                            margin: 0,
                            color: D.accent,
                            fontSize: '13px',
                          }}
                        >
                          📋 Componentes Avulsos / Pás em Solo (
                          {result.ground_blades.length})
                        </h4>
                        <p
                          style={{
                            margin: '3px 0 0 0',
                            color: D.textMuted,
                            fontSize: '11px',
                          }}
                        >
                          Inspeções de pás armazenadas no chão/solo (excluídas
                          da triangulação principal)
                        </p>
                      </div>
                      <div style={{ overflowX: 'auto', maxHeight: '250px' }}>
                        <table
                          style={{
                            width: '100%',
                            borderCollapse: 'collapse',
                            fontSize: '12px',
                          }}
                        >
                          <thead>
                            <tr
                              style={{
                                background: D.bgPanel,
                                color: D.textMuted,
                                textAlign: 'left',
                                position: 'sticky',
                                top: 0,
                              }}
                            >
                              <th
                                style={{
                                  padding: '8px 15px',
                                  borderBottom: `1px solid ${D.border}`,
                                  width: '25%',
                                }}
                              >
                                Parque
                              </th>
                              <th
                                style={{
                                  padding: '8px 15px',
                                  borderBottom: `1px solid ${D.border}`,
                                  width: '25%',
                                }}
                              >
                                Identificação
                              </th>
                              <th
                                style={{
                                  padding: '8px 15px',
                                  borderBottom: `1px solid ${D.border}`,
                                  width: '15%',
                                }}
                              >
                                Status
                              </th>
                              <th
                                style={{
                                  padding: '8px 15px',
                                  borderBottom: `1px solid ${D.border}`,
                                  width: '35%',
                                }}
                              >
                                Observações
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.ground_blades.map((row, idx) => (
                              <tr
                                key={`gr-${idx}`}
                                style={{
                                  borderBottom: `1px solid ${D.borderLight}`,
                                }}
                              >
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.textPrimary,
                                  }}
                                >
                                  {row.Wind_Farm}
                                </td>
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.textPrimary,
                                  }}
                                >
                                  {row.Turbine_Id}
                                </td>
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.textSecond,
                                  }}
                                >
                                  {row.Status}
                                </td>
                                <td
                                  style={{
                                    padding: '8px 15px',
                                    color: D.textMuted,
                                  }}
                                >
                                  {row.Observacoes}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}

          {/* Resumo de Campanhas - Somente se NÃO tiver Vendor */}
          {(!result.triangulacao || !result.triangulacao.has_vendor) &&
            result.resumo &&
            result.resumo.length > 0 && (
              <div
                style={{
                  background: D.bgCard,
                  borderRadius: '8px',
                  border: `1px solid ${D.border}`,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '15px',
                    borderBottom: `1px solid ${D.border}`,
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      color: D.textPrimary,
                      fontSize: '14px',
                    }}
                  >
                    Resumo de Campanhas
                  </h3>
                </div>
                <div style={{ overflowX: 'auto', maxHeight: '400px' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      fontSize: '13px',
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          background: D.bgPanel,
                          color: D.textMuted,
                          textAlign: 'left',
                          position: 'sticky',
                          top: 0,
                        }}
                      >
                        <th
                          style={{
                            padding: '10px 15px',
                            borderBottom: `1px solid ${D.border}`,
                          }}
                        >
                          WF Id
                        </th>
                        <th
                          style={{
                            padding: '10px 15px',
                            borderBottom: `1px solid ${D.border}`,
                          }}
                        >
                          Wind Farm (Campanha)
                        </th>
                        <th
                          style={{
                            padding: '10px 15px',
                            borderBottom: `1px solid ${D.border}`,
                          }}
                        >
                          Total
                        </th>
                        <th
                          style={{
                            padding: '10px 15px',
                            borderBottom: `1px solid ${D.border}`,
                          }}
                        >
                          Originais
                        </th>
                        <th
                          style={{
                            padding: '10px 15px',
                            borderBottom: `1px solid ${D.border}`,
                          }}
                        >
                          Recoletas Feitas
                        </th>
                        <th
                          style={{
                            padding: '10px 15px',
                            borderBottom: `1px solid ${D.border}`,
                          }}
                        >
                          Recoletas Pendentes
                        </th>
                        <th
                          style={{
                            padding: '10px 15px',
                            borderBottom: `1px solid ${D.border}`,
                          }}
                        >
                          % Recoleta
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.resumo.map((row, idx) => (
                        <tr
                          key={idx}
                          style={{ borderBottom: `1px solid ${D.borderLight}` }}
                        >
                          <td style={{ padding: '10px 15px', color: D.accent }}>
                            {row.WF_Id}
                          </td>
                          <td
                            style={{
                              padding: '10px 15px',
                              color: D.textPrimary,
                              fontWeight: '500',
                            }}
                          >
                            {row.Wind_Farm}
                          </td>
                          <td
                            style={{
                              padding: '10px 15px',
                              color: D.textPrimary,
                            }}
                          >
                            {row.Total_Linhas}
                          </td>
                          <td
                            style={{
                              padding: '10px 15px',
                              color: D.textSecond,
                            }}
                          >
                            {row.Linhas_Originais}
                          </td>
                          <td
                            style={{
                              padding: '10px 15px',
                              color:
                                row.Recoletas_Concluidas > 0
                                  ? D.success
                                  : D.textSecond,
                            }}
                          >
                            {row.Recoletas_Concluidas}
                          </td>
                          <td
                            style={{
                              padding: '10px 15px',
                              color:
                                row.Recoletas_Pendentes > 0
                                  ? D.warning
                                  : D.textSecond,
                            }}
                          >
                            {row.Recoletas_Pendentes}
                          </td>
                          <td
                            style={{
                              padding: '10px 15px',
                              color: D.textPrimary,
                            }}
                          >
                            {row.Perc_Recoleta}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  )
}
