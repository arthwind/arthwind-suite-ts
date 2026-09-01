// components/TopBar.jsx — Barra superior com logo, autenticação global Arthnex, tema, idioma e versão

import { useCallback, useEffect, useState } from 'react'
import { Icons } from '../constants/icons.jsx'
import { VERSION } from '../constants/version.js'
import arthwind_ICON from '../icon.js'

export default function TopBar({
  T,
  D,
  lang,
  darkMode,
  setDarkMode,
  toggleLang,
}) {
  const [authData, setAuthData] = useState(null)
  const [loggingIn, setLoggingIn] = useState(false)

  const checkAuth = useCallback(async () => {
    if (
      typeof window.pywebview === 'undefined' &&
      typeof window.api === 'undefined'
    )
      return
    const invoker = window.pywebview?.api || window.api
    try {
      const auth = await invoker.arthnex_get_auth?.()
      if (auth && auth.token) {
        setAuthData(auth)
      } else {
        setAuthData(null)
      }
    } catch {
      setAuthData(null)
    }
  }, [])

  useEffect(() => {
    checkAuth()
    const onAuthChanged = () => checkAuth()
    window.addEventListener('arthnex_auth_changed', onAuthChanged)
    return () =>
      window.removeEventListener('arthnex_auth_changed', onAuthChanged)
  }, [checkAuth])

  const handleGoogleLogin = async () => {
    if (
      typeof window.pywebview === 'undefined' &&
      typeof window.api === 'undefined'
    )
      return
    const invoker = window.pywebview?.api || window.api
    setLoggingIn(true)
    try {
      const res = await invoker.arthnex_google_login?.('homolog')
      if (res && res.success) {
        await checkAuth()
        window.dispatchEvent(new CustomEvent('arthnex_auth_changed'))
      }
    } catch (err) {
      console.error('Erro ao autenticar com Google:', err)
    } finally {
      setLoggingIn(false)
    }
  }

  const handleLogout = async () => {
    const invoker = window.pywebview?.api || window.api
    await invoker.arthnex_logout?.()
    setAuthData(null)
    window.dispatchEvent(new CustomEvent('arthnex_auth_changed'))
  }

  return (
    <div
      className="topbar"
      style={{ background: D.bgDeep, borderBottom: `1px solid ${D.border}` }}
    >
      <div className="topbar-left">
        <img src={arthwind_ICON} alt="arthwind" className="topbar-logo" />
        <div>
          <div className="topbar-title" style={{ color: D.accent }}>
            {T.title}
          </div>
          <div className="topbar-subtitle" style={{ color: D.textMuted }}>
            {T.subtitle}
          </div>
        </div>
      </div>
      <div className="topbar-right">
        {/* Global Arthnex Google Auth Status */}
        {authData && authData.token ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '11px',
              background: D.bgCard,
              padding: '4px 8px',
              borderRadius: '6px',
              border: `1px solid ${D.border}`,
              color: D.textPrimary,
            }}
          >
            <span style={{ color: D.success }}>●</span>
            <span
              style={{
                fontWeight: 600,
                maxWidth: '140px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {authData.user?.name ||
                authData.user?.email ||
                'Arthnex Conectado'}
            </span>
            <button
              onClick={handleLogout}
              title="Desconectar do Arthnex"
              style={{
                background: 'transparent',
                border: 0,
                color: D.textMuted,
                cursor: 'pointer',
                fontSize: '11px',
                padding: '0 2px',
                marginLeft: '2px',
              }}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={handleGoogleLogin}
            disabled={loggingIn}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '11px',
              fontWeight: 600,
              background: '#ffffff',
              color: '#1f2937',
              padding: '4px 10px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              cursor: loggingIn ? 'not-allowed' : 'pointer',
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            <span>{loggingIn ? 'Conectando...' : 'Conectar Arthnex'}</span>
          </button>
        )}

        <div className="topbar-divider" style={{ background: D.border }} />

        <div className="topbar-theme-toggle" style={{ color: D.textMuted }}>
          <Icons.sun />
          <button
            className="toggle-track"
            style={{ background: darkMode ? D.accent : D.border }}
            onClick={() => setDarkMode(d => !d)}
          >
            <div
              className="toggle-knob"
              style={{ left: darkMode ? '19px' : '3px' }}
            />
          </button>
          <Icons.moon />
        </div>
        <div className="topbar-divider" style={{ background: D.border }} />
        <div className="topbar-status">
          <div className="topbar-status-dot" />
          <span className="topbar-version" style={{ color: D.textMuted }}>
            v{VERSION}
          </span>
        </div>
        <button
          className="topbar-lang-btn"
          onClick={toggleLang}
          style={{
            background: D.accentSofter,
            border: `1px solid ${D.border}`,
            color: D.accent,
          }}
          title={lang === 'pt' ? 'Switch to English' : 'Mudar para Português'}
        >
          {lang === 'pt' ? 'PT' : 'EN'}
        </button>
      </div>
    </div>
  )
}
