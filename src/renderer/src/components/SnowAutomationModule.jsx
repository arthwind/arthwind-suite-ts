// components/SnowAutomationModule.jsx
// Automação do "Create Damage Report Entry" na plataforma SNOW — lê a planilha já
// gerada pelo SNOW Processor (módulo 23) e preenche o formulário via navegador
// controlado (Playwright). Sessão de login fica salva num perfil persistente, não
// precisa logar de novo a cada execução (só quando a sessão expirar de verdade).

import { useState, useEffect, useRef } from 'react';

const MAX_LOGS = 800;

export default function SnowAutomationModule({ D }) {
  const [excelPath, setExcelPath] = useState('');
  const [localPhotosDir, setLocalPhotosDir] = useState('');
  const [incidentUrl, setIncidentUrl] = useState('');
  const [headless, setHeadless] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [includeDefects, setIncludeDefects] = useState(true);
  const [includeBlanks, setIncludeBlanks] = useState(true);
  const [includeVideos, setIncludeVideos] = useState(true);
  const [startRow, setStartRow] = useState('');
  const [endRow, setEndRow] = useState('');

  // ── Fase 0: Create Inspection Report (etapa anterior ao Damage Report Entry) ──
  const [controlXlsxPath, setControlXlsxPath] = useState('');
  const [portalOrigin, setPortalOrigin] = useState('');
  const [technician, setTechnician] = useState('');
  const [skipAlreadySent, setSkipAlreadySent] = useState(true);
  const [runningInspectionPhase, setRunningInspectionPhase] = useState(false);


  const [blades, setBlades] = useState([]);
  const [selectedBlades, setSelectedBlades] = useState([]);
  const [loadingBlades, setLoadingBlades] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [running, setRunning] = useState(false);
  const [queue, setQueue] = useState([]);
  const [queueRunning, setQueueRunning] = useState(false);
  const [queueIndex, setQueueIndex] = useState(-1);
  const busy = running || queueRunning || runningInspectionPhase;
  const [ran, setRan] = useState(false);
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const logsEndRef = useRef(null);



  useEffect(() => {
    const handleLog = (e) => {
      const { msg } = e.detail || {};
      if (!msg) return;
      const type = msg.startsWith('✗') ? 'error' : msg.startsWith('✓') ? 'success' : 'info';
      setLogs((prev) => {
        const next = [...prev, { text: msg, type }];
        return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
      });
    };
    window.addEventListener('snow_automation_log', handleLog);
    return () => window.removeEventListener('snow_automation_log', handleLog);
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

  // onlyFirst=true testa só a 1ª turbina da planilha de controle — pensado pra
  // conferir visualmente (headless desligado) antes de rodar a planilha inteira,
  // já que os seletores dessa etapa nova ainda não foram confirmados contra o
  // ServiceNow de verdade.
  const handleRunInspectionPhase = async (onlyFirst) => {
    if (!controlXlsxPath || !portalOrigin.trim() || !technician.trim()) return;
    setRunningInspectionPhase(true);
    setLogs((prev) => [...prev, {
      text: onlyFirst
        ? '▶ Fase 0 (Inspection Report) — testando só a 1ª turbina da planilha de controle...'
        : '▶ Fase 0 (Inspection Report) — rodando a planilha de controle inteira...',
      type: 'info'
    }]);
    try {
      let onlyIncNumbers;
      if (onlyFirst) {
        const list = await window.pywebview.api.snow_read_turbine_inc_list(controlXlsxPath);
        if (!list.success || list.entries.length === 0) {
          setLogs((prev) => [...prev, { text: `✗ Falha ao ler a planilha de controle: ${list.error || 'nenhuma turbina encontrada'}`, type: 'error' }]);
          return;
        }
        // Pega a 1ª turbina AINDA PENDENTE (Status SNOW não começa com "Enviado") —
        // testar numa já enviada só validaria o caminho "Show Inspection Report",
        // não o preenchimento de verdade que precisa de teste.
        const firstPending = list.entries.find((e) => !/^enviado/i.test((e.statusSnow || '').trim())) || list.entries[0];
        onlyIncNumbers = [firstPending.incNumber];
      }
      const res = await window.pywebview.api.snow_inspection_report_run(
        controlXlsxPath,
        portalOrigin.trim(),
        technician.trim(),
        { headless, skipAlreadySent, ...(onlyIncNumbers ? { onlyIncNumbers } : {}) }
      );
      if (res.success) {
        setLogs((prev) => [...prev, {
          text: `✓ Fase 0 concluída: ${res.processed} ok, ${res.failed} falha(s).`,
          type: res.failed > 0 ? 'warning' : 'success'
        }]);
      } else {
        setLogs((prev) => [...prev, { text: `✗ Falha: ${res.error}`, type: 'error' }]);
      }
    } catch (err) {
      setLogs((prev) => [...prev, { text: `Erro crítico: ${err.message || err}`, type: 'error' }]);
    } finally {
      setRunningInspectionPhase(false);
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
          text: '✓ Navegador aberto — faça login manualmente na janela. A sessão fica salva pras próximas vezes.',
          type: 'success'
        }]);
      } else {
        setLogs((prev) => [...prev, { text: `✗ Falha ao abrir navegador: ${res.error}`, type: 'error' }]);
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

    setRunning(true);
    setRan(false);
    setLogs([]);
    setResult(null);

    const options = buildOptions();


    try {
      const res = await window.pywebview.api.snow_automation_run(excelPath, incidentUrl.trim(), options);
      setResult(res);
      if (res.success && res.dryRun) {
        const total = (res.missingDefects || 0) + (res.missingBlanks || 0) + (res.missingVideos || 0);
        setLogs((prev) => [...prev, {
          text: total === 0
            ? `✓ Auditoria concluída: nada faltando.`
            : `⚠ Auditoria concluída: ${total} item(ns) faltando (${res.missingDefects || 0} defeito(s), ${res.missingBlanks || 0} blank(s), ${res.missingVideos || 0} vídeo(s)).`,
          type: total === 0 ? 'success' : 'warning'
        }]);
      } else if (res.success) {
        setLogs((prev) => [...prev, {
          text: `✓ Automação concluída: ${res.processed} ok, ${res.failed} falha(s).`,
          type: res.failed > 0 ? 'warning' : 'success'
        }]);
      } else {
        setLogs((prev) => [...prev, { text: `✗ Falha: ${res.error}`, type: 'error' }]);
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
    setLogs((prev) => [...prev, { text: `➕ Turbina adicionada à fila: ${item.label} (${item.bladeCount} pá(s)).`, type: 'info' }]);
    resetTurbineForm();
  };

  const handleRemoveFromQueue = (id) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  };

  const handleRunQueue = async () => {
    if (queue.length === 0 || busy) return;

    setQueueRunning(true);
    setRan(false);
    setResult(null);
    setLogs((prev) => [...prev, { text: `▶ Iniciando fila overnight com ${queue.length} turbina(s)...`, type: 'info' }]);

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
        // marcado (ou não) no momento do "➕ Adicionar à fila", silenciosamente
        // ignorando qualquer mudança feita depois. startRow/endRow continuam vindo
        // do item (esses sim são por turbina).
        const runOptions = { ...item.options, headless, autoSubmit, includeDefects, includeBlanks, includeVideos, dryRun }
        const res = await window.pywebview.api.snow_automation_run(item.excelPath, item.incidentUrl, runOptions);
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: res.success ? 'done' : 'failed', result: res } : q)));
        if (res.success && res.dryRun) {
          const total = (res.missingDefects || 0) + (res.missingBlanks || 0) + (res.missingVideos || 0);
          setLogs((prev) => [...prev, {
            text: total === 0
              ? `✓ Turbina ${i + 1}/${items.length}: auditoria concluída, nada faltando.`
              : `⚠ Turbina ${i + 1}/${items.length}: auditoria concluída, ${total} item(ns) faltando (${res.missingDefects || 0} defeito(s), ${res.missingBlanks || 0} blank(s), ${res.missingVideos || 0} vídeo(s)).`,
            type: total === 0 ? 'success' : 'warning'
          }]);
        } else if (res.success) {
          setLogs((prev) => [...prev, {
            text: `✓ Turbina ${i + 1}/${items.length} concluída: ${res.processed} ok, ${res.failed} falha(s).`,
            type: res.failed > 0 ? 'warning' : 'success'
          }]);
        } else {
          setLogs((prev) => [...prev, { text: `✗ Turbina ${i + 1}/${items.length} falhou: ${res.error} — seguindo para a próxima.`, type: 'error' }]);
        }
      } catch (err) {
        const msg = err.message || String(err);
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'failed', result: { error: msg } } : q)));
        setLogs((prev) => [...prev, { text: `✗ Turbina ${i + 1}/${items.length} erro crítico: ${msg} — seguindo para a próxima.`, type: 'error' }]);
      }
    }

    setQueueIndex(-1);
    setQueueRunning(false);
    setLogs((prev) => [...prev, { text: `🏁 Fila overnight concluída — ${items.length} turbina(s) processada(s).`, type: 'success' }]);
  };

  const logColor = (type) => {
    if (type === 'success') return D.success;
    if (type === 'error') return D.error;
    if (type === 'warning') return D.warning;
    return D.textSecond;
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
        <div style={{
          background: `${accent}12`,
          border: `1px solid ${accent}40`,
          borderRadius: '8px',
          padding: '10px',
          fontSize: '11px',
          color: D.textSecond,
          lineHeight: '1.5'
        }}>
          Upload de fotos aprimorado: envia automaticamente as 2 fotos do Módulo 23 (pic1 com polígono desenhado + pic2 regional) da pasta local.
        </div>

        {/* Fase 0 — Create Inspection Report (etapa anterior, opcional) */}
        <div style={{
          border: `1px solid ${D.borderLight}`,
          borderRadius: '8px',
          padding: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: D.textPrimary }}>
            Fase 0 — Create Inspection Report
          </div>
          <div style={{ fontSize: '10.5px', color: D.textMuted, lineHeight: '1.4' }}>
            Garante que o Inspection Report de cada turbina existe e está submetido
            (etapa anterior ao cadastro de defeitos abaixo). Ainda em teste — recomendado
            rodar "Testar 1ª turbina" com o navegador visível antes de rodar a planilha inteira.
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <div className="field-label" style={{ color: D.textMuted }}>Planilha de controle (Turbina/INC/Data Coleta)</div>
            <div
              className={`input-field${controlXlsxPath ? " filled" : ""}`}
              onClick={!busy ? pickControlXlsx : undefined}
              style={{ cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              <span style={{ color: controlXlsxPath ? accent : D.textMuted, flexShrink: 0 }}>📁</span>
              <span className="input-field-text" title={controlXlsxPath || 'Selecione o arquivo .xlsx'}>
                {controlXlsxPath ? controlXlsxPath.split('\\').pop() : 'Selecione o arquivo .xlsx'}
              </span>
            </div>
          </div>

          <input
            type="text"
            placeholder="URL do portal ServiceNow (ex: https://empresa.service-now.com)"
            value={portalOrigin}
            onChange={(e) => setPortalOrigin(e.target.value)}
            disabled={busy}
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${D.borderLight}`, background: D.bgCard, color: D.textPrimary, fontSize: '12px' }}
          />
          <input
            type="text"
            placeholder="Responsible technicians (seu nome)"
            value={technician}
            onChange={(e) => setTechnician(e.target.value)}
            disabled={busy}
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${D.borderLight}`, background: D.bgCard, color: D.textPrimary, fontSize: '12px' }}
          />

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: D.textSecond, cursor: 'pointer' }}>
            <input type="checkbox" checked={skipAlreadySent} onChange={(e) => setSkipAlreadySent(e.target.checked)} disabled={busy} />
            Pular turbinas com Status SNOW já "Enviado..." na planilha de controle
          </label>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => handleRunInspectionPhase(true)}
              disabled={busy || !controlXlsxPath || !portalOrigin.trim() || !technician.trim()}
              style={{
                flex: 1,
                background: D.bgCard,
                border: `1px solid ${D.borderLight}`,
                color: D.textPrimary,
                borderRadius: '8px',
                padding: '8px',
                fontSize: '11.5px',
                fontWeight: 500,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: (busy || !controlXlsxPath || !portalOrigin.trim() || !technician.trim()) ? 0.6 : 1
              }}
            >
              Testar 1ª turbina
            </button>
            <button
              onClick={() => handleRunInspectionPhase(false)}
              disabled={busy || !controlXlsxPath || !portalOrigin.trim() || !technician.trim()}
              style={{
                flex: 1,
                background: accent,
                border: `1px solid ${accent}`,
                color: '#fff',
                borderRadius: '8px',
                padding: '8px',
                fontSize: '11.5px',
                fontWeight: 500,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: (busy || !controlXlsxPath || !portalOrigin.trim() || !technician.trim()) ? 0.6 : 1
              }}
            >
              Rodar planilha inteira
            </button>
          </div>
        </div>

        {/* Planilha */}
        <div className="form-group">
          <div className="field-label" style={{ color: D.textMuted }}>Planilha SNOW (gerada pelo módulo 23)</div>
          <div className="form-input-row">
            <div
              className={`input-field${excelPath ? " filled" : ""}`}
              onClick={!busy ? pickExcel : undefined}
              style={{ cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              <span style={{ color: excelPath ? accent : D.textMuted, flexShrink: 0 }}>📁</span>
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
              <span style={{ color: localPhotosDir ? accent : D.textMuted, flexShrink: 0 }}>🖼️</span>
              <span className="input-field-text" title={localPhotosDir || 'Selecione a pasta Fotos/ (opcional)'}>
                {localPhotosDir ? localPhotosDir.split('\\').pop() : 'Selecione a pasta Fotos/ (opcional)'}
              </span>
            </div>
          </div>
          <div style={{ fontSize: '10px', color: D.textMuted, marginTop: '4px' }}>
            Se selecionada, envia pic1 (polígono) + pic2 (zoom regional). Se vazia, baixa do link.
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
            {loggingIn ? 'Abrindo...' : '🔑 Abrir p/ Login'}
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
              opacity: busy ? 0.6 : 1
            }}
          >
            ✕
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
          <div style={{ fontSize: '10px', color: D.textMuted, marginTop: '4px' }}>
            Vazio = processa todas as linhas das pás selecionadas acima.
          </div>
        </div>

        {/* Headless, Submissão & Blank Image */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: D.textSecond, cursor: 'pointer' }}>
            <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} disabled={busy} />
            Rodar em segundo plano (sem mostrar o navegador)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: D.textSecond, cursor: dryRun ? 'not-allowed' : 'pointer', opacity: dryRun ? 0.5 : 1 }}>
            <input type="checkbox" checked={autoSubmit} onChange={(e) => setAutoSubmit(e.target.checked)} disabled={busy || dryRun} />
            Submeter formulário automaticamente (desativado = apenas preenche)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: D.textSecond, cursor: 'pointer' }}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={busy} />
            Modo Auditoria (dry run — só verifica o que falta, não abre nem preenche formulário nenhum)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: D.textSecond, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeDefects} onChange={(e) => setIncludeDefects(e.target.checked)} disabled={busy} />
            Defeitos
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: D.textSecond, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeBlanks} onChange={(e) => setIncludeBlanks(e.target.checked)} disabled={busy} />
            Blank Images
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: D.textSecond, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeVideos} onChange={(e) => setIncludeVideos(e.target.checked)} disabled={busy} />
            Vídeos (DF 45-50)
          </label>
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
                const icon = q.status === 'running' ? '▶' : q.status === 'done' ? '✓' : q.status === 'failed' ? '✗' : '⏳';
                const color = q.status === 'running' ? accent : q.status === 'done' ? D.success : q.status === 'failed' ? D.error : D.textMuted;
                return (
                  <div key={q.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '6px 8px', borderRadius: '6px', border: `1px solid ${D.borderLight}`,
                    background: idx === queueIndex ? `${accent}10` : 'transparent'
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color, fontWeight: 600, fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={q.label}>
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
                        fontSize: '12px', flexShrink: 0, marginLeft: '6px'
                      }}
                    >
                      ✕
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
            ➕ Adicionar à Fila
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
              {queueRunning
                ? `🌙 Rodando fila... (${queueIndex + 1}/${queue.length})`
                : `🌙 Rodar Fila Overnight (${queue.length} turbina(s))`}
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
            {running ? 'Rodando...' : `▶ Rodar Agora (${selectedBlades.length} pá(s))`}
          </button>
        </div>
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
        {result && (
          <div style={{
            display: 'flex', gap: '16px', marginBottom: '14px', fontSize: '12px',
            padding: '10px 12px', borderRadius: '8px', background: D.bgHover
          }}>
            <span style={{ color: D.success, fontWeight: 600 }}>{result.processed ?? 0} ok</span>
            <span style={{ color: result.failed ? D.error : D.textMuted, fontWeight: 600 }}>{result.failed ?? 0} falha(s)</span>
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
              <div key={idx} style={{ color: logColor(log.type), whiteSpace: 'pre-wrap', lineHeight: '1.4' }}>
                {log.text}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}
