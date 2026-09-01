// components/LogPanel.jsx — Painel de Feed de Atividades limpo com filtros e suporte a temas

import { useEffect, useMemo, useRef, useState } from 'react'
import { Icons } from '../constants/icons.jsx'

export default function LogPanel({ T, D, logs, onClear }) {
  const scrollRef = useRef(null)
  const [copied, setCopied] = useState(false)
  const [filter, setFilter] = useState('all') // 'all', 'warning', 'error'

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  const counts = useMemo(() => {
    let warn = 0
    let err = 0
    for (const l of logs) {
      if (l.type === 'warning' || l.type === 'warn') warn++
      if (l.type === 'error') err++
    }
    return { all: logs.length, warn, err }
  }, [logs])

  const filteredLogs = useMemo(() => {
    if (filter === 'warning')
      return logs.filter(l => l.type === 'warning' || l.type === 'warn')
    if (filter === 'error') return logs.filter(l => l.type === 'error')
    return logs
  }, [logs, filter])

  const getBadgeProps = type => {
    switch (type) {
      case 'success':
        return {
          label: 'SUCESSO',
          bg: `${D.success}18`,
          color: D.success,
          icon: Icons.checkCircle(D.success),
        }
      case 'warning':
      case 'warn':
        return {
          label: 'AVISO',
          bg: `${D.warning}18`,
          color: D.warning,
          icon: Icons.alertTriangle(D.warning),
        }
      case 'error':
        return {
          label: 'ERRO',
          bg: `${D.error}18`,
          color: D.error,
          icon: Icons.xCircle(D.error),
        }
      default:
        return {
          label: 'INFO',
          bg: `${D.accent}14`,
          color: D.accent,
          icon: Icons.info(D.accent),
        }
    }
  }

  const handleCopy = async () => {
    const text = logs.map(l => `[${l.type.toUpperCase()}] ${l.text}`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* noop */
      }
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="log-panel"
      style={{
        borderLeft: `1px solid ${D.border}`,
        background: D.bgPanel,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top Header */}
      <div
        className="log-header"
        style={{
          borderBottom: `1px solid ${D.border}`,
          padding: '10px 14px',
          background: D.bgCard,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {Icons.terminal(D.accent)}
          <span
            style={{ fontWeight: 600, fontSize: '13px', color: D.textPrimary }}
          >
            Feed de Atividades
          </span>
        </div>

        {logs.length > 0 && (
          <div
            className="log-header-actions"
            style={{ display: 'flex', gap: '8px', alignItems: 'center' }}
          >
            <button
              className="log-action-btn"
              onClick={handleCopy}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                border: `1px solid ${D.border}`,
                background: D.inputBg,
                color: copied ? D.success : D.textPrimary,
                borderRadius: '5px',
                padding: '4px 8px',
                fontSize: '11.5px',
                cursor: 'pointer',
              }}
              title={T.copy_log}
            >
              {Icons.copy(copied ? D.success : D.textSecond)}
              <span>{copied ? T.copied : T.copy_log}</span>
            </button>
            <button
              className="log-clear-btn"
              onClick={onClear}
              style={{
                border: `1px solid ${D.border}`,
                background: D.inputBg,
                color: D.textSecond,
                borderRadius: '5px',
                padding: '4px 8px',
                fontSize: '11.5px',
                cursor: 'pointer',
              }}
            >
              {T.clear}
            </button>
          </div>
        )}
      </div>

      {/* Filter Tabs */}
      {logs.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: '4px',
            padding: '6px 12px',
            background: D.bgCard,
            borderBottom: `1px solid ${D.border}`,
          }}
        >
          <button
            onClick={() => setFilter('all')}
            style={{
              padding: '3px 9px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              background: filter === 'all' ? D.accent : 'transparent',
              color: filter === 'all' ? '#fff' : D.textSecond,
            }}
          >
            Todos ({counts.all})
          </button>
          {counts.warn > 0 && (
            <button
              onClick={() => setFilter('warning')}
              style={{
                padding: '3px 9px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                background: filter === 'warning' ? D.warning : 'transparent',
                color: filter === 'warning' ? '#fff' : D.warning,
              }}
            >
              Alertas ({counts.warn})
            </button>
          )}
          {counts.err > 0 && (
            <button
              onClick={() => setFilter('error')}
              style={{
                padding: '3px 9px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                background: filter === 'error' ? D.error : 'transparent',
                color: filter === 'error' ? '#fff' : D.error,
              }}
            >
              Erros ({counts.err})
            </button>
          )}
        </div>
      )}

      {/* Content Area */}
      <div
        className="log-content"
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          background: D.logBg,
        }}
      >
        {filteredLogs.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: D.textMuted,
              gap: '8px',
              textAlign: 'center',
              fontSize: '12px',
            }}
          >
            {Icons.info(D.textMuted)}
            <span>
              {filter === 'all'
                ? T.log_placeholder
                : 'Nenhum registro com este filtro.'}
            </span>
          </div>
        ) : (
          filteredLogs.map((l, i) => {
            const badge = getBadgeProps(l.type)
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  background: D.inputBg,
                  border: `1px solid ${D.border}`,
                  lineHeight: '1.45',
                  fontSize: '12.5px',
                  color: D.textPrimary,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    marginTop: '1px',
                  }}
                >
                  {badge.icon}
                  <span
                    style={{
                      fontSize: '9.5px',
                      fontWeight: 700,
                      padding: '1px 5px',
                      borderRadius: '3px',
                      background: badge.bg,
                      color: badge.color,
                      letterSpacing: '0.04em',
                    }}
                  >
                    {badge.label}
                  </span>
                </div>
                <div
                  style={{
                    flex: 1,
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {l.text}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
