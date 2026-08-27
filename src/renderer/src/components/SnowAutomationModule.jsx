// components/SnowAutomationModule.jsx
// Automação do "Create Damage Report Entry" na plataforma SNOW — lê a planilha já
// gerada pelo SNOW Processor (módulo 23) e preenche o formulário via navegador
// controlado (Playwright). Sessão de login fica salva num perfil persistente, não
// precisa logar de novo a cada execução (só quando a sessão expirar de verdade).

import { useState, useEffect, useRef } from 'react';
import { Icons } from '../constants/icons.jsx';

const MAX_LOGS = 800;

export default function SnowAutomationModule({ D }) {
  const [excelPath, setExcelPath] = useState('');
  const [localPhotosDir, setLocalPhotosDir] = useState('');
  const [incidentUrl, setIncidentUrl] = useState('');
  const [headless, setHeadless] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  // Modo Flawless: só avança pra próxima pá quando ela estiver 100% preenchida e
  // submetida (defeito+blank+vídeo) — mais lento que as 3 rodadas padrão, pensado
  // pra fila overnight sem ninguém pra reagir a uma pendência no meio da noite.
  const [flawlessMode, setFlawlessMode] = useState(false);
  const [includeDefects, setIncludeDefects] = useState(true);
  const [includeBlanks, setIncludeBlanks] = useState(true);
  const [includeVideos, setIncludeVideos] = useState(true);
  const [startRow, setStartRow] = useState('');
  const [endRow, setEndRow] = useState('');

  // ── Automação Completa: Inspection Report + Damage Report Entry numa passada só ──
  const [controlXlsxPath, setControlXlsxPath] = useState('');
  const [wtgRootFolder, setWtgRootFolder] = useState('');
  const [portalOrigin, setPortalOrigin] = useState('https://nordexprod.service-now.com/bam?id=external_portal_home');
  const [technician, setTechnician] = useState('');
  const [skipAlreadySent, setSkipAlreadySent] = useState(true);
  const [runningFullAutomation, setRunningFullAutomation] = useState(false);


  const [blades, setBlades] = useState([]);
  const [selectedBlades, setSelectedBlades] = useState([]);
  const [loadingBlades, setLoadingBlades] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [running, setRunning] = useState(false);
  const [queue, setQueue] = useState([]);
  const [queueRunning, setQueueRunning] = useState(false);
  const [queueIndex, setQueueIndex] = useState(-1);
  const busy = running || queueRunning || runningFullAutomation;
  const [ran, setRan] = useState(false);
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const logsEndRef = useRef(null);

  // ── Pausar/Parar ──────────────────────────────────────────────────────────
  const [paused, setPaused] = useState(false);

  // ── Gerenciador de abas abertas ───────────────────────────────────────────
  const [openTabs, setOpenTabs] = useState([]);

  // ── Configuração por parque (líder/técnicos/PO) ───────────────────────────
  const [windfarmConfigs, setWindfarmConfigs] = useState([]);
  const [showWindfarmConfig, setShowWindfarmConfig] = useState(false);
  const [wfEditing, setWfEditing] = useState(null); // null = form fechado
  const [wfName, setWfName] = useState('');
  const [wfLeader, setWfLeader] = useState('');
  const [wfTechnicians, setWfTechnicians] = useState('');
  const [wfPurchaseOrder, setWfPurchaseOrder] = useState('');



  useEffect(() => {
    const handleLog = (e) => {
      const { msg, type } = e.detail || {};
      if (!msg) return;
      setLogs((prev) => {
        const next = [...prev, { text: msg, type: type || 'info' }];
        return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
      });
    };
    window.addEventListener('snow_automation_log', handleLog);
    return () => window.removeEventListener('snow_automation_log', handleLog);
  }, []);

  // Gerenciador de abas: só faz sentido consultar enquanto uma automação está
  // rodando de verdade (abas de revisão só existem durante/depois de um "Rodar").
  useEffect(() => {
    if (!busy) return;
    let cancelled = false;
    const poll = async () => {
      const tabs = await window.pywebview.api.snow_automation_list_open_tabs().catch(() => []);
      if (!cancelled) setOpenTabs(tabs);
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [busy]);

  const loadWindfarmConfigs = async () => {
    const list = await window.pywebview.api.snow_windfarm_config_list().catch(() => []);
    setWindfarmConfigs(list);
  };

  useEffect(() => {
    loadWindfarmConfigs();
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const loadBlades = async (path) => {
    if (!path) return;
    setLoadingBlades(true);
    try {
      const res = await window.pywebview.api.snow_automation_get_blades(path);
      if (res.success && Array.isArray(res.blades)) {
        setBlades(res.blades);
        setSelectedBlades(res.blades.map((b) => b.bladeSerialNumber));
      } else {
        setBlades([]);
        setSelectedBlades([]);
      }
    } catch {
      setBlades([]);
      setSelectedBlades([]);
    } finally {
      setLoadingBlades(false);
    }
  };

  const pickExcel = async () => {
    const picked = await window.pywebview.api.pick_file('xlsx');
    if (picked) {
      setExcelPath(picked);
      loadBlades(picked);
      const lastSlash = Math.max(picked.lastIndexOf('\\'), picked.lastIndexOf('/'));
      if (lastSlash > -1) {
        const folder = picked.substring(0, lastSlash);
        setLocalPhotosDir(`${folder}\\Fotos`);
      }
    }
  };


  const pickPhotosDir = async () => {
    const picked = await window.pywebview.api.pick_folder();
    if (picked) setLocalPhotosDir(picked);
  };

  const pickControlXlsx = async () => {
    const picked = await window.pywebview.api.pick_file('xlsx');
    if (picked) setControlXlsxPath(picked);
  };

  const pickWtgRootFolder = async () => {
    const picked = await window.pywebview.api.pick_folder();
    if (picked) setWtgRootFolder(picked);
  };

  // mode='next' processa só a próxima turbina pendente com pasta pronta (bom pra
  // conferir visualmente antes de soltar tudo); mode='all' processa todas as
  // prontas de uma vez. Fluxo completo: acha o INC, decide Create/Show, preenche
  // o Inspection Report se precisar, e já sobe os defeitos da pasta local
  // correspondente — sem pedir nenhuma URL de Damage Report separada.
  const handleRunFullAutomation = async (mode) => {
    if (!controlXlsxPath || !wtgRootFolder || !portalOrigin.trim() || !technician.trim()) return;
    await window.pywebview.api.snow_automation_reset_control();
    setPaused(false);
    setRunningFullAutomation(true);
    setLogs((prev) => [...prev, {
      text: mode === 'next'
        ? 'Automação Completa — próxima turbina pendente...'
        : 'Automação Completa — todas as turbinas prontas...',
      type: 'info'
    }]);
    try {
      const res = await window.pywebview.api.snow_full_automation_run(
        controlXlsxPath,
        wtgRootFolder,
        portalOrigin.trim(),
        technician.trim(),
        {
          headless,
          skipAlreadySent,
          mode,
          // Sem isso, o Módulo 24 nunca recebia autoSubmit/categorias/dryRun —
          // ficava sempre no padrão (autoSubmit=false), mesmo com a caixa
          // marcada na UI, porque esse objeto simplesmente não existia antes.
          moduleOptions: { autoSubmit, includeDefects, includeBlanks, includeVideos, dryRun, flawlessMode }
        }
      );
      if (res.stopped) {
        setLogs((prev) => [...prev, {
          text: `Parado pelo usuário: ${res.processed} ok, ${res.failed} falha(s).`,
          type: 'warning'
        }]);
      } else if (res.success) {
        setLogs((prev) => [...prev, {
          text: `Automação Completa concluída: ${res.processed} ok, ${res.failed} falha(s), ${res.skippedNoFolder} sem pasta pronta ainda.`,
          type: res.failed > 0 ? 'warning' : 'success'
        }]);
      } else {
        setLogs((prev) => [...prev, { text: `Falha: ${res.error}`, type: 'error' }]);
      }
    } catch (err) {
      setLogs((prev) => [...prev, { text: `Erro crítico: ${err.message || err}`, type: 'error' }]);
    } finally {
      setRunningFullAutomation(false);
    }
  };

  const toggleBlade = (sn) => {
    setSelectedBlades((prev) =>
      prev.includes(sn) ? prev.filter((item) => item !== sn) : [...prev, sn]
    );
  };

  const selectAllBlades = () => {
    setSelectedBlades(blades.map((b) => b.bladeSerialNumber));
  };

  const deselectAllBlades = () => {
    setSelectedBlades([]);
  };

  const handleLogin = async () => {
    if (!incidentUrl.trim()) return;
    setLoggingIn(true);
    setLogs((prev) => [...prev, { text: `Abrindo navegador em: ${incidentUrl}`, type: 'info' }]);
    try {
      const res = await window.pywebview.api.snow_automation_login(incidentUrl.trim());
      if (res.success) {
        setLogs((prev) => [...prev, {
          text: 'Navegador aberto — faça login manualmente na janela. A sessão fica salva pras próximas vezes.',
          type: 'success'
        }]);
      } else {
        setLogs((prev) => [...prev, { text: `Falha ao abrir navegador: ${res.error}`, type: 'error' }]);
      }
    } catch (err) {
      setLogs((prev) => [...prev, { text: `Erro crítico: ${err.message || err}`, type: 'error' }]);
    } finally {
      setLoggingIn(false);
    }
  };

  const handleCloseSession = async () => {
    await window.pywebview.api.snow_automation_close();
    setLogs((prev) => [...prev, { text: 'Sessão do navegador encerrada.', type: 'info' }]);
  };

  const buildOptions = () => ({
    headless,
    selectedBlades,
    localPhotosDir,
    autoSubmit,
    includeDefects,
    includeBlanks,
    includeVideos,
    dryRun,
    flawlessMode,
    ...(startRow ? { startRow: parseInt(startRow, 10) } : {}),
    ...(endRow ? { endRow: parseInt(endRow, 10) } : {}),
  });

  const resetTurbineForm = () => {
    setExcelPath('');
    setLocalPhotosDir('');
    setIncidentUrl('');
    setBlades([]);
    setSelectedBlades([]);
    setStartRow('');
    setEndRow('');
  };

  const handleRun = async () => {
    if (!excelPath || !incidentUrl.trim()) return;

    await window.pywebview.api.snow_automation_reset_control();
    setPaused(false);
    setRunning(true);
    setRan(false);
    setLogs([]);
    setResult(null);

    const options = buildOptions();


    try {
      const res = await window.pywebview.api.snow_automation_run(excelPath, incidentUrl.trim(), options);
      setResult(res);
      if (res.stopped) {
        setLogs((prev) => [...prev, { text: `Parado pelo usuário: ${res.processed} ok, ${res.failed} falha(s).`, type: 'warning' }]);
      } else if (res.success && res.dryRun) {
        const total = (res.missingDefects || 0) + (res.missingBlanks || 0) + (res.missingVideos || 0);
        setLogs((prev) => [...prev, {
          text: total === 0
            ? `Auditoria concluída: nada faltando.`
            : `Auditoria concluída: ${total} item(ns) faltando (${res.missingDefects || 0} defeito(s), ${res.missingBlanks || 0} blank(s), ${res.missingVideos || 0} vídeo(s)).`,
          type: total === 0 ? 'success' : 'warning'
        }]);
      } else if (res.success) {
        setLogs((prev) => [...prev, {
          text: `Automação concluída: ${res.processed} ok, ${res.failed} falha(s).`,
          type: res.failed > 0 ? 'warning' : 'success'
        }]);
      } else {
        setLogs((prev) => [...prev, { text: `Falha: ${res.error}`, type: 'error' }]);
      }
    } catch (err) {
      setLogs((prev) => [...prev, { text: `Erro crítico: ${err.message || err}`, type: 'error' }]);
    } finally {
      setRunning(false);
      setRan(true);
    }
  };

  const handleAddToQueue = () => {
    if (!excelPath || !incidentUrl.trim() || selectedBlades.length === 0) return;
    const item = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      label: excelPath.split('\\').pop().split('/').pop(),
      excelPath,
      incidentUrl: incidentUrl.trim(),
      bladeCount: selectedBlades.length,
      options: buildOptions(),
      status: 'pending', // pending | running | done | failed
      result: null,
    };
    setQueue((prev) => [...prev, item]);
    setLogs((prev) => [...prev, { text: `Turbina adicionada à fila: ${item.label} (${item.bladeCount} pá(s)).`, type: 'info' }]);
    resetTurbineForm();
  };

  const handleRemoveFromQueue = (id) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  };

  const handleRunQueue = async () => {
    if (queue.length === 0 || busy) return;

    await window.pywebview.api.snow_automation_reset_control();
    setPaused(false);
    setQueueRunning(true);
    setRan(false);
    setResult(null);
    setLogs((prev) => [...prev, { text: `Iniciando fila overnight com ${queue.length} turbina(s)...`, type: 'info' }]);

    // Snapshot dos itens no momento do início — a fila roda sequencialmente, uma
    // turbina de cada vez, começando a próxima só quando a anterior terminar por
    // completo (mesma sessão/perfil de navegador, não dá pra rodar duas ao mesmo
    // tempo). Um erro numa turbina NÃO para a fila — é rodada overnight, sem
    // ninguém pra intervir — fica registrado no log e no status do item, e segue.
    const items = queue;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      setQueueIndex(i);
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'running' } : q)));
      setLogs((prev) => [...prev, { text: `\n===== Turbina ${i + 1}/${items.length}: ${item.label} =====`, type: 'info' }]);

      try {
        // headless/autoSubmit/categorias são configurações GLOBAIS (um único
        // checkbox no painel, não por turbina) — usa o valor ATUAL desses campos,
        // não o snapshot congelado de quando a turbina foi adicionada à fila. Sem
        // isso, marcar "Submeter automaticamente" DEPOIS de já ter montado a fila
        // não tinha efeito nenhum: cada item rodava com o autoSubmit que estava
        // marcado (ou não) no momento do "Adicionar à fila", silenciosamente
        // ignorando qualquer mudança feita depois. startRow/endRow continuam vindo
        // do item (esses sim são por turbina).
        const runOptions = { ...item.options, headless, autoSubmit, includeDefects, includeBlanks, includeVideos, dryRun, flawlessMode }
        const res = await window.pywebview.api.snow_automation_run(item.excelPath, item.incidentUrl, runOptions);
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: res.success ? 'done' : 'failed', result: res } : q)));
        if (res.stopped) {
          setLogs((prev) => [...prev, { text: `Fila parada pelo usuário na turbina ${i + 1}/${items.length}: ${res.processed} ok, ${res.failed} falha(s).`, type: 'warning' }]);
          break;
        }
        if (res.success && res.dryRun) {
          const total = (res.missingDefects || 0) + (res.missingBlanks || 0) + (res.missingVideos || 0);
          setLogs((prev) => [...prev, {
            text: total === 0
              ? `Turbina ${i + 1}/${items.length}: auditoria concluída, nada faltando.`
              : `Turbina ${i + 1}/${items.length}: auditoria concluída, ${total} item(ns) faltando (${res.missingDefects || 0} defeito(s), ${res.missingBlanks || 0} blank(s), ${res.missingVideos || 0} vídeo(s)).`,
            type: total === 0 ? 'success' : 'warning'
          }]);
        } else if (res.success) {
          setLogs((prev) => [...prev, {
            text: `Turbina ${i + 1}/${items.length} concluída: ${res.processed} ok, ${res.failed} falha(s).`,
            type: res.failed > 0 ? 'warning' : 'success'
          }]);
        } else {
          setLogs((prev) => [...prev, { text: `Turbina ${i + 1}/${items.length} falhou: ${res.error} — seguindo para a próxima.`, type: 'error' }]);
        }
      } catch (err) {
        const msg = err.message || String(err);
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'failed', result: { error: msg } } : q)));
        setLogs((prev) => [...prev, { text: `Turbina ${i + 1}/${items.length} erro crítico: ${msg} — seguindo para a próxima.`, type: 'error' }]);
      }
    }

    setQueueIndex(-1);
    setQueueRunning(false);
    setLogs((prev) => [...prev, { text: `Fila overnight concluída — ${items.length} turbina(s) processada(s).`, type: 'success' }]);
  };

  const handlePauseToggle = async () => {
    if (paused) {
      await window.pywebview.api.snow_automation_resume();
      setPaused(false);
    } else {
      await window.pywebview.api.snow_automation_pause();
      setPaused(true);
    }
  };

  const handleStop = async () => {
    await window.pywebview.api.snow_automation_stop();
  };

  const handleCloseTab = async (id) => {
    await window.pywebview.api.snow_automation_close_tab(id);
    setOpenTabs((prev) => prev.filter((t) => t.id !== id));
  };

  const handleCloseAllTabs = async () => {
    await window.pywebview.api.snow_automation_close_all_review_tabs();
    setOpenTabs([]);
  };

  const handleOpenLogsFolder = async () => {
    await window.pywebview.api.snow_automation_open_logs_folder();
  };

  const tabAge = (openedAt) => {
    const mins = Math.floor((Date.now() - openedAt) / 60000);
    if (mins < 1) return 'agora';
    if (mins < 60) return `${mins}min`;
    return `${Math.floor(mins / 60)}h${mins % 60}min`;
  };

  const resetWindfarmForm = () => {
    setWfEditing(null);
    setWfName('');
    setWfLeader('');
    setWfTechnicians('');
    setWfPurchaseOrder('');
  };

  const startEditWindfarm = (config) => {
    setWfEditing(config ? config.windfarm : '__new__');
    setWfName(config?.windfarm || '');
    setWfLeader(config?.leader || '');
    setWfTechnicians((config?.technicians || []).join(', '));
    setWfPurchaseOrder(config?.purchaseOrder || '');
  };

  const handleSaveWindfarmConfig = async () => {
    if (!wfName.trim()) return;
    await window.pywebview.api.snow_windfarm_config_save({
      windfarm: wfName.trim(),
      leader: wfLeader.trim(),
      technicians: wfTechnicians.split(',').map((t) => t.trim()).filter(Boolean),
      purchaseOrder: wfPurchaseOrder.trim()
    });
    resetWindfarmForm();
    await loadWindfarmConfigs();
  };

  const handleDeleteWindfarmConfig = async (windfarm) => {
    await window.pywebview.api.snow_windfarm_config_delete(windfarm);
    await loadWindfarmConfigs();
  };

  const logColor = (type) => {
    if (type === 'success') return D.success;
    if (type === 'error') return D.error;
    if (type === 'warning') return D.warning;
    return D.textSecond;
  };

  const logIcon = (type) => {
    const color = logColor(type);
    if (type === 'success') return Icons.checkCircle(color);
    if (type === 'error') return Icons.xCircle(color);
    if (type === 'warning') return Icons.alertTriangle(color);
    return Icons.info(color);
  };

  const accent = '#0284c7'; // Azul do cliente SNOW/NAWP

  return (
    <div style={{ display: 'flex', gap: '18px', height: '100%', minHeight: 0 }}>
      {/* Painel Esquerdo — Configurações */}
      <div style={{
        flex: '0 0 360px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        overflowY: 'auto',
        paddingRight: '4px'
      }}>
        {/* Fase 0 — Create Inspection Report (etapa anterior, opcional) */}
        <div style={{
          border: `1.5px solid ${accent}50`,
          borderRadius: '10px',
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: D.textPrimary, display: 'flex', alignItems: 'center', gap: '8px' }}>
            {Icons.rocket(accent)} Automação Completa
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <div className="field-label" style={{ color: D.textMuted, fontSize: '12px' }}>Planilha de controle (Turbina/INC/Data Coleta)</div>
            <div
              className={`input-field${controlXlsxPath ? " filled" : ""}`}
              onClick={!busy ? pickControlXlsx : undefined}
              style={{ cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              <span style={{ display: 'flex', color: controlXlsxPath ? accent : D.textMuted, flexShrink: 0 }}>{Icons.file(controlXlsxPath ? accent : D.textMuted)}</span>
              <span className="input-field-text" title={controlXlsxPath || 'Selecione o arquivo .xlsx'} style={{ fontSize: '12.5px' }}>
                {controlXlsxPath ? controlXlsxPath.split('\\').pop() : 'Selecione o arquivo .xlsx'}
              </span>
            </div>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <div className="field-label" style={{ color: D.textMuted, fontSize: '12px' }}>Pasta raiz das turbinas (ex: D:\SNOW\WTG'S)</div>
            <div
              className={`input-field${wtgRootFolder ? " filled" : ""}`}
              onClick={!busy ? pickWtgRootFolder : undefined}
              style={{ cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              <span style={{ display: 'flex', color: wtgRootFolder ? accent : D.textMuted, flexShrink: 0 }}>{Icons.folder(wtgRootFolder ? accent : D.textMuted)}</span>
              <span className="input-field-text" title={wtgRootFolder || 'Selecione a pasta raiz'} style={{ fontSize: '12.5px' }}>
                {wtgRootFolder || 'Selecione a pasta raiz'}
              </span>
            </div>
          </div>

          <input
            type="text"
            placeholder="URL do portal ServiceNow (ex: https://empresa.service-now.com)"
            value={portalOrigin}
            onChange={(e) => setPortalOrigin(e.target.value)}
            disabled={busy}
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: '8px', border: `1px solid ${D.borderLight}`, background: D.bgCard, color: D.textPrimary, fontSize: '13px' }}
          />
          <input
            type="text"
            placeholder="Responsible technicians (seu nome)"
            value={technician}
            onChange={(e) => setTechnician(e.target.value)}
            disabled={busy}
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: '8px', border: `1px solid ${D.borderLight}`, background: D.bgCard, color: D.textPrimary, fontSize: '13px' }}
          />

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: D.textSecond, cursor: 'pointer' }}>
            <input type="checkbox" checked={skipAlreadySent} onChange={(e) => setSkipAlreadySent(e.target.checked)} disabled={busy} />
            Pular turbinas com Status SNOW já "Enviado..." na planilha de controle
          </label>

          <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
            <button
              onClick={() => handleRunFullAutomation('next')}
              disabled={busy || !controlXlsxPath || !wtgRootFolder || !portalOrigin.trim() || !technician.trim()}
              style={{
                flex: 1,
                background: D.bgCard,
                border: `1px solid ${D.borderLight}`,
                color: D.textPrimary,
                borderRadius: '8px',
                padding: '11px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: (busy || !controlXlsxPath || !wtgRootFolder || !portalOrigin.trim() || !technician.trim()) ? 0.6 : 1
              }}
            >
              Rodar próxima pendente
            </button>
            <button
              onClick={() => handleRunFullAutomation('all')}
              disabled={busy || !controlXlsxPath || !wtgRootFolder || !portalOrigin.trim() || !technician.trim()}
              style={{
                flex: 1,
                background: accent,
                border: `1px solid ${accent}`,
                color: '#fff',
                borderRadius: '8px',
                padding: '11px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: (busy || !controlXlsxPath || !wtgRootFolder || !portalOrigin.trim() || !technician.trim()) ? 0.6 : 1
              }}
            >
              Rodar todas as prontas
            </button>
          </div>
        </div>

        {busy && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handlePauseToggle}
              style={{
                flex: 1,
                background: paused ? accent : D.bgCard,
                border: `1px solid ${paused ? accent : D.borderLight}`,
                color: paused ? '#fff' : D.textPrimary,
                borderRadius: '8px',
                padding: '9px',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                {paused ? Icons.play('#fff') : Icons.pause(D.textPrimary)} {paused ? 'Retomar' : 'Pausar'}
              </span>
            </button>
            <button
              onClick={handleStop}
              style={{
                flex: 1,
                background: D.bgCard,
                border: `1px solid ${D.error}80`,
                color: D.error,
                borderRadius: '8px',
                padding: '9px',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                {Icons.stop(D.error)} Parar
              </span>
            </button>
          </div>
        )}

        <button
          onClick={() => setShowWindfarmConfig((v) => !v)}
          style={{
            background: 'none',
            border: `1px solid ${D.borderLight}`,
            borderRadius: '8px',
            padding: '8px 10px',
            fontSize: '12px',
            fontWeight: 600,
            color: D.textSecond,
            cursor: 'pointer',
            textAlign: 'left'
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            {Icons.globe(D.textSecond)} Configuração por Parque {showWindfarmConfig ? '▲' : '▼'}
          </span>
        </button>

        {showWindfarmConfig && (
          <div style={{
            border: `1px solid ${D.borderLight}`,
            borderRadius: '8px',
            padding: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}>
            {windfarmConfigs.length === 0 ? (
              <div style={{ fontSize: '11px', color: D.textMuted }}>Nenhum parque cadastrado.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {windfarmConfigs.map((c) => (
                  <div key={c.windfarm} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '6px 8px', borderRadius: '6px', border: `1px solid ${D.borderLight}`
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '11.5px', color: D.textPrimary }}>{c.windfarm}</div>
                      <div style={{ fontSize: '10px', color: D.textMuted }}>
                        {c.leader} · {c.technicians.join(', ')} · PO {c.purchaseOrder || '—'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      <button onClick={() => startEditWindfarm(c)} style={{ background: 'none', border: 0, color: accent, cursor: 'pointer', fontSize: '11px' }}>Editar</button>
                      <button onClick={() => handleDeleteWindfarmConfig(c.windfarm)} style={{ background: 'none', border: 0, color: D.error, cursor: 'pointer', fontSize: '11px' }}>Remover</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {wfEditing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                <input type="text" placeholder="Nome do parque (igual ao 'windfarm' da base de pás)" value={wfName}
                  onChange={(e) => setWfName(e.target.value)} disabled={wfEditing !== '__new__'}
                  style={{ padding: '7px 9px', borderRadius: '6px', border: `1px solid ${D.borderLight}`, background: D.bgCard, color: D.textPrimary, fontSize: '12px' }} />
                <input type="text" placeholder="Líder" value={wfLeader} onChange={(e) => setWfLeader(e.target.value)}
                  style={{ padding: '7px 9px', borderRadius: '6px', border: `1px solid ${D.borderLight}`, background: D.bgCard, color: D.textPrimary, fontSize: '12px' }} />
                <input type="text" placeholder="Técnicos (separados por vírgula)" value={wfTechnicians} onChange={(e) => setWfTechnicians(e.target.value)}
                  style={{ padding: '7px 9px', borderRadius: '6px', border: `1px solid ${D.borderLight}`, background: D.bgCard, color: D.textPrimary, fontSize: '12px' }} />
                <input type="text" placeholder="Purchase Order" value={wfPurchaseOrder} onChange={(e) => setWfPurchaseOrder(e.target.value)}
                  style={{ padding: '7px 9px', borderRadius: '6px', border: `1px solid ${D.borderLight}`, background: D.bgCard, color: D.textPrimary, fontSize: '12px' }} />
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button onClick={handleSaveWindfarmConfig} style={{ flex: 1, background: accent, border: 0, color: '#fff', borderRadius: '6px', padding: '7px', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>Salvar</button>
                  <button onClick={resetWindfarmForm} style={{ flex: 1, background: 'none', border: `1px solid ${D.borderLight}`, color: D.textSecond, borderRadius: '6px', padding: '7px', fontSize: '11.5px', cursor: 'pointer' }}>Cancelar</button>
                </div>
              </div>
            ) : (
              <button onClick={() => startEditWindfarm(null)} style={{ background: 'none', border: `1px dashed ${D.borderLight}`, color: accent, borderRadius: '6px', padding: '7px', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>
                + Adicionar parque
              </button>
            )}
          </div>
        )}

        <label style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '13px',
          fontWeight: 600,
          color: D.textPrimary,
          cursor: 'pointer',
          border: `1.5px solid ${autoSubmit ? accent : D.borderLight}`,
          borderRadius: '8px',
          padding: '10px 12px'
        }}>
          <input type="checkbox" checked={autoSubmit} onChange={(e) => setAutoSubmit(e.target.checked)} disabled={busy || dryRun} />
          Submissão Automática (desativado = apenas preenche, você revisa e submete)
        </label>

        <label style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '13px',
          fontWeight: 600,
          color: D.textPrimary,
          cursor: 'pointer',
          border: `1.5px solid ${flawlessMode ? accent : D.borderLight}`,
          borderRadius: '8px',
          padding: '10px 12px'
        }}>
          <input type="checkbox" checked={flawlessMode} onChange={(e) => setFlawlessMode(e.target.checked)} disabled={busy || dryRun} />
          Modo Flawless (só avança de pá quando tudo — defeito, blank e vídeo — estiver 100% ok; mais lento, ideal pra overnight)
        </label>

        <details style={{
          border: `1px solid ${D.borderLight}`,
          borderRadius: '10px',
          padding: '2px 4px'
        }}>
          <summary style={{
            fontSize: '13px',
            fontWeight: 600,
            color: D.textSecond,
            cursor: 'pointer',
            padding: '10px 8px',
            userSelect: 'none'
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {Icons.gear(D.textSecond)} Turbina manual / fila avulsa (avançado)
            </span>
          </summary>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 8px 12px' }}>

        {/* Planilha */}
        <div className="form-group">
          <div className="field-label" style={{ color: D.textMuted }}>Planilha SNOW (gerada pelo módulo 23)</div>
          <div className="form-input-row">
            <div
              className={`input-field${excelPath ? " filled" : ""}`}
              onClick={!busy ? pickExcel : undefined}
              style={{ cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              <span style={{ display: 'flex', color: excelPath ? accent : D.textMuted, flexShrink: 0 }}>{Icons.file(excelPath ? accent : D.textMuted)}</span>
              <span className="input-field-text" title={excelPath || 'Selecione o arquivo .xlsx'}>
                {excelPath ? excelPath.split('\\').pop() : 'Selecione o arquivo .xlsx'}
              </span>
            </div>
          </div>
        </div>

        {/* Pasta de Fotos Locais do Módulo 23 */}
        <div className="form-group">
          <div className="field-label" style={{ color: D.textMuted }}>Pasta de Fotos Geradas (Módulo 23 - Fotos/)</div>
          <div className="form-input-row">
            <div
              className={`input-field${localPhotosDir ? " filled" : ""}`}
              onClick={!busy ? pickPhotosDir : undefined}
              style={{ cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              <span style={{ display: 'flex', color: localPhotosDir ? accent : D.textMuted, flexShrink: 0 }}>{Icons.photos(localPhotosDir ? accent : D.textMuted)}</span>
              <span className="input-field-text" title={localPhotosDir || 'Selecione a pasta Fotos/ (opcional)'}>
                {localPhotosDir ? localPhotosDir.split('\\').pop() : 'Selecione a pasta Fotos/ (opcional)'}
              </span>
            </div>
          </div>
        </div>


        {/* Pás encontradas */}
        {excelPath && (
          <div style={{
            background: D.bgCard,
            border: `1px solid ${D.borderLight}`,
            borderRadius: '8px',
            padding: '10px',
            fontSize: '12px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontWeight: 600, color: D.textPrimary }}>Pás Encontradas na Planilha:</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  onClick={selectAllBlades}
                  disabled={busy}
                  style={{ background: 'none', border: 0, color: accent, cursor: 'pointer', fontSize: '10px', padding: 0 }}
                >
                  Todas
                </button>
                <span style={{ color: D.borderLight }}>|</span>
                <button
                  type="button"
                  onClick={deselectAllBlades}
                  disabled={busy}
                  style={{ background: 'none', border: 0, color: D.textMuted, cursor: 'pointer', fontSize: '10px', padding: 0 }}
                >
                  Nenhuma
                </button>
              </div>
            </div>

            {loadingBlades ? (
              <div style={{ fontSize: '11px', color: D.textMuted }}>Carregando pás...</div>
            ) : blades.length === 0 ? (
              <div style={{ fontSize: '11px', color: D.textMuted }}>Nenhuma pá válida encontrada.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '140px', overflowY: 'auto' }}>
                {blades.map((b) => {
                  const isChecked = selectedBlades.includes(b.bladeSerialNumber);
                  return (
                    <label
                      key={b.bladeSerialNumber}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: isChecked ? `${accent}10` : 'transparent',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        border: `1px solid ${isChecked ? accent + '40' : D.borderLight}`,
                        cursor: busy ? 'not-allowed' : 'pointer'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleBlade(b.bladeSerialNumber)}
                          disabled={busy}
                        />
                        <span style={{ fontWeight: 600, color: D.textPrimary, fontSize: '11px' }}>
                          Pá S/N {b.shortSn}
                        </span>

                      </div>
                      <span style={{ color: D.textMuted, fontSize: '10px' }}>
                        {b.count} dano(s) (L{b.startRow}-{b.endRow})
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Incidente */}
        <div className="form-group">
          <div className="field-label" style={{ color: D.textMuted }}>URL do Inspection Report (Incidente)</div>
          <input
            type="text"
            value={incidentUrl}
            onChange={(e) => setIncidentUrl(e.target.value)}
            disabled={busy}
            placeholder="https://.../inspection_report.do?sys_id=..."
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 10px',
              borderRadius: '8px',
              border: `1px solid ${D.borderLight}`,
              background: D.bgCard,
              color: D.textPrimary,
              fontSize: '12px'
            }}
          />
        </div>

        {/* Login */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={handleLogin}
            disabled={loggingIn || busy || !incidentUrl.trim()}
            style={{
              flex: 1,
              background: D.bgCard,
              border: `1px solid ${D.borderLight}`,
              color: D.textPrimary,
              borderRadius: '8px',
              padding: '8px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: (loggingIn || busy || !incidentUrl.trim()) ? 'not-allowed' : 'pointer',
              opacity: (loggingIn || busy || !incidentUrl.trim()) ? 0.6 : 1
            }}
          >
            {loggingIn ? 'Abrindo...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>{Icons.key(D.textPrimary)} Abrir p/ Login</span>}
          </button>
          <button
            onClick={handleCloseSession}
            disabled={busy}
            title="Encerra o navegador (não apaga a sessão salva)"
            style={{
              background: D.bgCard,
              border: `1px solid ${D.borderLight}`,
              color: D.textMuted,
              borderRadius: '8px',
              padding: '8px 10px',
              fontSize: '12px',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center'
            }}
          >
            {Icons.close(D.textMuted)}
          </button>
        </div>

        {/* Faixa de linhas (opcional, pra retomar depois de uma falha) */}
        <div className="form-group">
          <div className="field-label" style={{ color: D.textMuted }}>Faixa de linhas filtradas (opcional)</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="number" min="1" placeholder="Início"
              value={startRow} onChange={(e) => setStartRow(e.target.value)}
              disabled={busy}
              style={{ width: '50%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${D.borderLight}`, background: D.bgCard, color: D.textPrimary, fontSize: '12px' }}
            />
            <input
              type="number" min="1" placeholder="Fim"
              value={endRow} onChange={(e) => setEndRow(e.target.value)}
              disabled={busy}
              style={{ width: '50%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${D.borderLight}`, background: D.bgCard, color: D.textPrimary, fontSize: '12px' }}
            />
          </div>
        </div>

        {/* Opções de execução */}
        <div style={{
          border: `1px solid ${D.borderLight}`,
          borderRadius: '8px',
          padding: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          <div style={{ fontSize: '12.5px', fontWeight: 600, color: D.textPrimary }}>Opções de execução</div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: D.textSecond, cursor: 'pointer' }}>
            <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} disabled={busy} />
            Rodar em segundo plano (sem mostrar o navegador)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: D.textSecond, cursor: 'pointer' }}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={busy} />
            Modo Auditoria (dry run — só verifica o que falta, não preenche nada)
          </label>

          <div style={{ height: '1px', background: D.borderLight, margin: '2px 0' }} />

          <div style={{ fontSize: '11px', color: D.textMuted }}>Categorias a processar</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: D.textSecond, cursor: 'pointer' }}>
              <input type="checkbox" checked={includeDefects} onChange={(e) => setIncludeDefects(e.target.checked)} disabled={busy} />
              Defeitos
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: D.textSecond, cursor: 'pointer' }}>
              <input type="checkbox" checked={includeBlanks} onChange={(e) => setIncludeBlanks(e.target.checked)} disabled={busy} />
              Blanks
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: D.textSecond, cursor: 'pointer' }}>
              <input type="checkbox" checked={includeVideos} onChange={(e) => setIncludeVideos(e.target.checked)} disabled={busy} />
              Vídeos
            </label>
          </div>
        </div>






        {/* Fila overnight — várias turbinas, uma de cada vez, sem precisar ficar por perto */}
        {queue.length > 0 && (
          <div style={{
            background: D.bgCard,
            border: `1px solid ${D.borderLight}`,
            borderRadius: '8px',
            padding: '10px',
            fontSize: '12px'
          }}>
            <div style={{ fontWeight: 600, color: D.textPrimary, marginBottom: '8px' }}>
              Fila ({queue.length} turbina(s)):
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '160px', overflowY: 'auto' }}>
              {queue.map((q, idx) => {
                const icon = q.status === 'running' ? Icons.play(accent) : q.status === 'done' ? Icons.check(D.success) : q.status === 'failed' ? Icons.xCircle(D.error) : Icons.hourglass(D.textMuted);
                const color = q.status === 'running' ? accent : q.status === 'done' ? D.success : q.status === 'failed' ? D.error : D.textMuted;
                return (
                  <div key={q.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '6px 8px', borderRadius: '6px', border: `1px solid ${D.borderLight}`,
                    background: idx === queueIndex ? `${accent}10` : 'transparent'
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color, fontWeight: 600, fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '5px' }} title={q.label}>
                        {icon} {q.label}
                      </div>
                      <div style={{ color: D.textMuted, fontSize: '10px' }}>
                        {q.bladeCount} pá(s)
                        {q.status === 'done' && q.result ? ` — ${q.result.processed} ok, ${q.result.failed} falha(s)` : ''}
                        {q.status === 'failed' && q.result?.error ? ` — ${q.result.error}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveFromQueue(q.id)}
                      disabled={busy}
                      title="Remover da fila"
                      style={{
                        background: 'none', border: 0, color: D.textMuted, cursor: busy ? 'not-allowed' : 'pointer',
                        fontSize: '12px', flexShrink: 0, marginLeft: '6px', display: 'flex', alignItems: 'center'
                      }}
                    >
                      {Icons.close(D.textMuted)}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Botões de ação */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: 'auto' }}>
          <button
            onClick={handleAddToQueue}
            disabled={busy || !excelPath || !incidentUrl.trim() || selectedBlades.length === 0}
            title="Adiciona esta turbina à fila e limpa o formulário pra configurar a próxima"
            style={{
              background: D.bgCard,
              border: `1px solid ${accent}60`,
              color: accent,
              borderRadius: '8px',
              padding: '9px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: (busy || !excelPath || !incidentUrl.trim() || selectedBlades.length === 0) ? 'not-allowed' : 'pointer',
              opacity: (busy || !excelPath || !incidentUrl.trim() || selectedBlades.length === 0) ? 0.6 : 1
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>{Icons.plus(accent)} Adicionar à Fila</span>
          </button>

          {queue.length > 0 && (
            <button
              onClick={handleRunQueue}
              disabled={busy}
              style={{
                background: queueRunning ? D.bgHover : '#7c3aed',
                color: '#fff',
                border: 0,
                borderRadius: '8px',
                padding: '10px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy && !queueRunning ? 0.6 : 1
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                {Icons.moon('#fff')} {queueRunning
                  ? `Rodando fila... (${queueIndex + 1}/${queue.length})`
                  : `Rodar Fila Overnight (${queue.length} turbina(s))`}
              </span>
            </button>
          )}

          <button
            onClick={handleRun}
            disabled={busy || !excelPath || !incidentUrl.trim() || selectedBlades.length === 0}
            title="Roda só esta turbina agora, sem passar pela fila"
            style={{
              background: (busy || selectedBlades.length === 0) ? D.bgHover : accent,
              color: '#fff',
              border: 0,
              borderRadius: '8px',
              padding: '10px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: (busy || !excelPath || !incidentUrl.trim() || selectedBlades.length === 0) ? 'not-allowed' : 'pointer',
              opacity: (busy || !excelPath || !incidentUrl.trim() || selectedBlades.length === 0) ? 0.6 : 1
            }}
          >
            {running ? 'Rodando...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>{Icons.play('#fff')} Rodar Agora ({selectedBlades.length} pá(s))</span>}
          </button>
        </div>

          </div>
        </details>
      </div>


      {/* Painel Direito — Logs e Progresso */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: D.bgCard,
        border: `1px solid ${D.borderLight}`,
        borderRadius: '12px',
        padding: '16px',
        minHeight: 0,
        height: '100%'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          {result ? (
            <div style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
              <span style={{ color: D.success, fontWeight: 600 }}>{result.processed ?? 0} ok</span>
              <span style={{ color: result.failed ? D.error : D.textMuted, fontWeight: 600 }}>{result.failed ?? 0} falha(s)</span>
            </div>
          ) : <span />}
          <button
            onClick={handleOpenLogsFolder}
            style={{ background: 'none', border: `1px solid ${D.borderLight}`, color: D.textSecond, borderRadius: '6px', padding: '5px 9px', fontSize: '10.5px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            {Icons.opendir(D.textSecond)} Abrir pasta de logs
          </button>
        </div>

        {openTabs.length > 0 && (
          <div style={{
            border: `1px solid ${D.borderLight}`,
            borderRadius: '8px',
            padding: '8px 10px',
            marginBottom: '10px',
            fontSize: '11px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <span style={{ fontWeight: 600, color: D.textPrimary }}>Abas abertas ({openTabs.length})</span>
              <button onClick={handleCloseAllTabs} style={{ background: 'none', border: 0, color: D.error, cursor: 'pointer', fontSize: '10.5px' }}>Fechar todas</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '120px', overflowY: 'auto' }}>
              {openTabs.map((t) => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px', borderRadius: '5px', background: D.bgHover }}>
                  <span style={{ color: D.textSecond, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {t.purpose === 'video-review' ? Icons.video(D.textSecond) : Icons.fileText(D.textSecond)} {t.turbine || ''} {t.blade ? `· ${t.blade}` : ''} · {t.label} · {tabAge(t.openedAt)}
                  </span>
                  <button onClick={() => handleCloseTab(t.id)} style={{ background: 'none', border: 0, color: D.textMuted, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center' }}>{Icons.close(D.textMuted)}</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{
          flex: 1,
          background: D.bgBody,
          borderRadius: '8px',
          border: `1px solid ${D.borderLight}`,
          padding: '12px',
          fontFamily: 'monospace',
          fontSize: '11px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px'
        }}>
          {logs.length === 0 ? (
            <div style={{ color: D.textMuted, textAlign: 'center', marginTop: '40px' }}>
              Aguardando início do processo...
            </div>
          ) : (
            logs.map((log, idx) => (
              <div key={idx} style={{ color: logColor(log.type), whiteSpace: 'pre-wrap', lineHeight: '1.4', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                <span style={{ display: 'flex', flexShrink: 0, marginTop: '2px' }}>{logIcon(log.type)}</span>
                <span>{log.text}</span>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}
