// components/Batch360StitcherModule.jsx
// Módulo de Costura 360 (MediaSDK) — Suporte a lote (pasta) ou arquivo individual

import { useEffect, useRef, useState } from 'react'
import { Icons } from '../constants/icons.jsx'

const MAX_LOGS = 300

export default function Batch360StitcherModule({ D, isPyWebView }) {
  const [targetType, setTargetType] = useState('batch') // 'batch' (pasta) ou 'single' (arquivo)
  const [targetPath, setTargetPath] = useState('')
  const [running, setRunning] = useState(false)
  const [ran, setRan] = useState(false)
  const [logs, setLogs] = useState([])
  const [result, setResult] = useState(null)
  const logsEndRef = useRef(null)

  // Escuta eventos batch_stitch_log vindos do Main
  useEffect(() => {
    const handler = e => {
      const { message, type } = e.detail || {}
      setLogs(prev => {
        const next = [...prev, { text: message, type: type || 'info' }]
        return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
      })
    }
    window.addEventListener('batch_stitch_log', handler)
    return () => window.removeEventListener('batch_stitch_log', handler)
  }, [])

  // Auto scroll de logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const handlePickTarget = async () => {
    if (!isPyWebView) return
    if (targetType === 'batch') {
      const picked = await window.pywebview.api.pick_folder()
      if (picked) setTargetPath(picked)
    } else {
      const picked = await window.pywebview.api.pick_file()
      if (picked) setTargetPath(picked)
    }
  }

  const handleRun = async () => {
    if (!targetPath) return
    setRunning(true)
    setRan(false)
    setLogs([])
    setResult(null)

    try {
      const res = await window.pywebview.api.batch_360_stitch(
        targetPath,
        'auto'
      )
      setResult(res)
    } catch (err) {
      setLogs(prev => [
        ...prev,
        { text: `Erro: ${err.message || err}`, type: 'error' },
      ])
    } finally {
      setRunning(false)
      setRan(true)
    }
  }

  const logColor = type => {
    if (type === 'success') return D.success
    if (type === 'error') return D.error
    if (type === 'warning') return D.warning
    return D.textSecond
  }

  const accent = '#7c3aed' // Roxo da categoria Arthbot

  return (
    <div style={{ display: 'flex', gap: '18px', height: '100%', minHeight: 0 }}>
      {/* Painel esquerdo — Configuração */}
      <div
        style={{
          flex: '0 0 350px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          overflowY: 'auto',
          paddingRight: '4px',
        }}
      >
        {/* Cabeçalho do Módulo */}
        <div
          style={{
            background: D.bgCard,
            border: `1px solid ${D.border}`,
            borderRadius: '10px',
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              color: accent,
              fontWeight: 700,
              fontSize: '13px',
            }}
          >
            {Icons.videoCamera(accent, 16)}
            <span>Costura de Vídeos 360</span>
          </div>
          <div
            style={{ fontSize: '12px', color: D.textSecond, lineHeight: '1.5' }}
          >
            Processa vídeos brutos (duas lentes fisheye) e gera os vídeos 360°
            esféricos correspondentes (
            <code style={{ color: D.textPrimary }}>_stitched.mp4</code>)
            diretamente pelo MediaSDK.
          </div>
        </div>

        {/* Seletor de Tipo: Pasta (Lote) vs Arquivo Único */}
        <div>
          <div
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: D.textMuted,
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
              marginBottom: '8px',
            }}
          >
            Tipo de Entrada
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '8px',
            }}
          >
            <button
              onClick={() => {
                setTargetType('batch')
                setTargetPath('')
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '10px',
                borderRadius: '8px',
                border: `1px solid ${targetType === 'batch' ? accent : D.border}`,
                background: targetType === 'batch' ? `${accent}18` : D.inputBg,
                color: targetType === 'batch' ? D.textPrimary : D.textSecond,
                fontSize: '12px',
                fontWeight: targetType === 'batch' ? 700 : 500,
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              {Icons.folder(targetType === 'batch' ? accent : D.textMuted)}
              <span>Em Lote (Pasta)</span>
            </button>

            <button
              onClick={() => {
                setTargetType('single')
                setTargetPath('')
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '10px',
                borderRadius: '8px',
                border: `1px solid ${targetType === 'single' ? accent : D.border}`,
                background: targetType === 'single' ? `${accent}18` : D.inputBg,
                color: targetType === 'single' ? D.textPrimary : D.textSecond,
                fontSize: '12px',
                fontWeight: targetType === 'single' ? 700 : 500,
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              {Icons.file(targetType === 'single' ? accent : D.textMuted)}
              <span>Arquivo Único</span>
            </button>
          </div>
        </div>

        {/* Seleção do Arquivo / Pasta */}
        <div>
          <div
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: D.textMuted,
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
              marginBottom: '6px',
            }}
          >
            {targetType === 'batch'
              ? 'Pasta de Vídeos 360'
              : 'Arquivo de Vídeo 360 Bruto'}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <div
              style={{
                flex: 1,
                background: D.inputBg,
                border: `1px solid ${targetPath ? accent + '55' : D.border}`,
                borderRadius: '8px',
                padding: '9px 12px',
                fontSize: '12px',
                color: targetPath ? D.textPrimary : D.textMuted,
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'border-color 0.2s',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              onClick={handlePickTarget}
              title={
                targetPath ||
                (targetType === 'batch'
                  ? 'Clique para selecionar a pasta'
                  : 'Clique para selecionar o vídeo')
              }
            >
              {targetPath ||
                (targetType === 'batch'
                  ? 'Selecionar pasta de vídeos...'
                  : 'Selecionar arquivo .mp4 / .insv...')}
            </div>
            {targetPath && (
              <button
                onClick={() => setTargetPath('')}
                style={{
                  background: `${D.error}15`,
                  border: `1px solid ${D.error}30`,
                  borderRadius: '8px',
                  color: D.error,
                  cursor: 'pointer',
                  padding: '0 10px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title="Limpar seleção"
              >
                {Icons.close(D.error)}
              </button>
            )}
          </div>
          {targetPath && (
            <div
              style={{
                fontSize: '11px',
                color: D.textMuted,
                marginTop: '4px',
                paddingLeft: '2px',
                wordBreak: 'break-all',
              }}
            >
              {targetPath}
            </div>
          )}
        </div>

        {/* Resultado de Conclusão */}
        {ran && result && (
          <div
            style={{
              background: result.success ? `${D.success}12` : `${D.error}12`,
              border: `1px solid ${result.success ? D.success : D.error}30`,
              borderRadius: '10px',
              padding: '12px 16px',
            }}
          >
            <div
              style={{
                color: result.success ? D.success : D.error,
                fontWeight: 700,
                fontSize: '13px',
                marginBottom: '4px',
              }}
            >
              {result.success ? 'Concluído com sucesso!' : 'Erro na execução'}
            </div>
            {result.success && (
              <div style={{ fontSize: '12px', color: D.textSecond }}>
                <strong style={{ color: D.textPrimary }}>{result.count}</strong>{' '}
                vídeo(s) costurado(s) com sucesso.
              </div>
            )}
            {result.error && (
              <div style={{ fontSize: '12px', color: D.error }}>
                {result.error}
              </div>
            )}
          </div>
        )}

        {/* Botão de execução */}
        <button
          onClick={handleRun}
          disabled={running || !targetPath}
          style={{
            background: running || !targetPath ? D.accentSofter : accent,
            color: running || !targetPath ? D.textMuted : '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '12px',
            fontSize: '13.5px',
            fontWeight: 700,
            cursor: running || !targetPath ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
        >
          {running ? (
            'Costurando vídeos...'
          ) : (
            <>
              {Icons.play('#fff', 13)}
              <span>
                {targetType === 'batch'
                  ? 'Iniciar Costura em Lote'
                  : 'Costurar Vídeo'}
              </span>
            </>
          )}
        </button>

        {/* Barra de progresso indeterminada */}
        {running && (
          <div
            style={{
              height: '3px',
              background: D.accentSofter,
              borderRadius: '2px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: '40%',
                background: accent,
                borderRadius: '2px',
                animation: 'indeterminate 1.4s ease infinite',
              }}
            />
          </div>
        )}
      </div>

      {/* Painel direito — Log */}
      <div
        style={{
          flex: 1,
          background: D.logBg,
          borderRadius: '10px',
          border: `1px solid ${D.border}`,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: `1px solid ${D.border}`,
            fontSize: '11px',
            fontWeight: 700,
            color: D.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {Icons.terminal(D.textMuted)}
            <span>Log de Execução</span>
          </div>
          {logs.length > 0 && (
            <button
              onClick={() => setLogs([])}
              style={{
                background: 'none',
                border: 'none',
                color: D.textMuted,
                cursor: 'pointer',
                fontSize: '11px',
                padding: '2px 6px',
                borderRadius: '4px',
              }}
            >
              Limpar
            </button>
          )}
        </div>
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '10px 14px',
            fontFamily: 'monospace',
            fontSize: '11.5px',
            lineHeight: '1.7',
          }}
        >
          {logs.length === 0 && !running && (
            <div style={{ color: D.textMuted, fontStyle: 'italic' }}>
              Selecione {targetType === 'batch' ? 'uma pasta' : 'um vídeo'} e
              clique em "
              {targetType === 'batch'
                ? 'Iniciar Costura em Lote'
                : 'Costurar Vídeo'}
              " para iniciar...
            </div>
          )}
          {logs.map((log, i) => (
            <div
              key={i}
              style={{ color: logColor(log.type), marginBottom: '1px' }}
            >
              {log.text}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  )
}
