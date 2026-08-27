// components/SnowModule.jsx
// Módulo do Processador SNOW/NAWP — Converte planilhas de inspeção interna/externa, baixa fotos e desenha polígonos

import { useState, useEffect, useRef } from 'react';
import { Icons } from '../constants/icons.jsx';

const MAX_LOGS = 500;

export default function SnowModule({ D }) {
  const [mode, setMode] = useState('single'); // 'single' | 'batch'
  const [excelPath, setExcelPath] = useState('');
  const [excelPaths, setExcelPaths] = useState([]);
  const [outputDir, setOutputDir] = useState('');
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [result, setResult] = useState(null);
  const logsEndRef = useRef(null);

  // Listen to IPC events from main process
  useEffect(() => {
    const handleProgress = (e) => {
      const { message, type, current, total } = e.detail || {};
      if (message) {
        setLogs((prev) => {
          const next = [...prev, { text: message, type: type || 'info' }];
          return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
        });
      }
      if (typeof current === 'number' && typeof total === 'number') {
        setProgress({ current, total });
      }
    };

    const handleBatchStatus = (e) => {
      const { current, total } = e.detail || {};
      if (typeof current === 'number' && typeof total === 'number') {
        setBatchProgress({ current, total });
      }
    };

    window.addEventListener('snow_progress', handleProgress);
    window.addEventListener('snow_batch_status', handleBatchStatus);

    return () => {
      window.removeEventListener('snow_progress', handleProgress);
      window.removeEventListener('snow_batch_status', handleBatchStatus);
    };
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const pickSingleFile = async () => {
    const picked = await window.pywebview.api.pick_file('xlsx');
    if (picked) setExcelPath(picked);
  };

  const pickMultipleFiles = async () => {
    const picked = await window.pywebview.api.pick_files('xlsx');
    if (picked && picked.length > 0) setExcelPaths(picked);
  };

  const pickFolder = async () => {
    const picked = await window.pywebview.api.pick_folder();
    if (picked) setOutputDir(picked);
  };

  const handleRun = async () => {
    if (mode === 'single' && !excelPath) return;
    if (mode === 'batch' && excelPaths.length === 0) return;
    if (!outputDir) return;

    setRunning(true);
    setRan(false);
    setLogs([]);
    setProgress({ current: 0, total: 0 });
    setBatchProgress({ current: 0, total: 0 });
    setResult(null);

    try {
      if (mode === 'single') {
        const res = await window.pywebview.api.snow_process_excel(excelPath, outputDir);
        setResult(res);
        if (res.success) {
          setLogs((prev) => [...prev, { text: 'Processamento concluído com sucesso!', type: 'success' }]);
        } else {
          setLogs((prev) => [...prev, { text: `Falha: ${res.error}`, type: 'error' }]);
        }
      } else {
        const res = await window.pywebview.api.snow_process_excel_batch(excelPaths, outputDir);
        setResult(res);
        if (res.success) {
          setLogs((prev) => [...prev, { text: 'Processamento em lote finalizado!', type: 'success' }]);
        } else {
          setLogs((prev) => [...prev, { text: `Erro no lote: ${res.error}`, type: 'error' }]);
        }
      }
    } catch (err) {
      setLogs((prev) => [...prev, { text: `Erro crítico: ${err.message || err}`, type: 'error' }]);
    } finally {
      setRunning(false);
      setRan(true);
    }
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
        flex: '0 0 340px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        overflowY: 'auto',
        paddingRight: '4px'
      }}>
        {/* Abas de Modo (Única vs Lote) */}
        <div style={{
          display: 'flex',
          background: D.bgCard,
          border: `1px solid ${D.borderLight}`,
          borderRadius: '8px',
          padding: '2px',
          gap: '2px'
        }}>
          <button
            onClick={() => !running && setMode('single')}
            style={{
              flex: 1,
              padding: '6px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: mode === 'single' ? 600 : 400,
              background: mode === 'single' ? D.bgHover : 'transparent',
              color: mode === 'single' ? D.textPrimary : D.textMuted,
              border: 0,
              cursor: running ? 'not-allowed' : 'pointer'
            }}
          >
            Planilha Única
          </button>
          <button
            onClick={() => !running && setMode('batch')}
            style={{
              flex: 1,
              padding: '6px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: mode === 'batch' ? 600 : 400,
              background: mode === 'batch' ? D.bgHover : 'transparent',
              color: mode === 'batch' ? D.textPrimary : D.textMuted,
              border: 0,
              cursor: running ? 'not-allowed' : 'pointer'
            }}
          >
            Processar Lote (Batch)
          </button>
        </div>

        {/* Input: Planilha */}
        {mode === 'single' ? (
          <div className="form-group">
            <div className="field-label" style={{ color: D.textMuted }}>Planilha de Inspeção (Excel)</div>
            <div className="form-input-row">
              <div
                className={`input-field${excelPath ? " filled" : ""}`}
                onClick={!running ? pickSingleFile : undefined}
                style={{ cursor: running ? 'not-allowed' : 'pointer' }}
              >
                <span style={{ display: 'flex', color: excelPath ? accent : D.textMuted, flexShrink: 0 }}>{Icons.file(excelPath ? accent : D.textMuted)}</span>
                <span className="input-field-text" title={excelPath || 'Selecione o arquivo .xlsx'}>
                  {excelPath ? excelPath.split('\\').pop() : 'Selecione o arquivo .xlsx'}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="form-group">
            <div className="field-label" style={{ color: D.textMuted }}>Arquivos em Lote (Excel)</div>
            <div className="form-input-row">
              <div
                className={`input-field${excelPaths.length > 0 ? " filled" : ""}`}
                onClick={!running ? pickMultipleFiles : undefined}
                style={{ cursor: running ? 'not-allowed' : 'pointer' }}
              >
                <span style={{ display: 'flex', color: excelPaths.length > 0 ? accent : D.textMuted, flexShrink: 0 }}>{Icons.file(excelPaths.length > 0 ? accent : D.textMuted)}</span>
                <span className="input-field-text">
                  {excelPaths.length > 0 ? `${excelPaths.length} arquivos selecionados` : 'Selecione os arquivos .xlsx'}
                </span>
              </div>
            </div>
            {excelPaths.length > 0 && (
              <div style={{ fontSize: '11px', color: D.textMuted, marginTop: '4px', maxHeight: '60px', overflowY: 'auto' }}>
                {excelPaths.map(p => p.split('\\').pop()).join(', ')}
              </div>
            )}
          </div>
        )}

        {/* Input: Destino */}
        <div className="form-group">
          <div className="field-label" style={{ color: D.textMuted }}>Pasta de Destino (Output)</div>
          <div className="form-input-row">
            <div
              className={`input-field${outputDir ? " filled" : ""}`}
              onClick={!running ? pickFolder : undefined}
              style={{ cursor: running ? 'not-allowed' : 'pointer' }}
            >
              <span style={{ display: 'flex', color: outputDir ? accent : D.textMuted, flexShrink: 0 }}>{Icons.folderOpen(outputDir ? accent : D.textMuted)}</span>
              <span className="input-field-text" title={outputDir || 'Selecione a pasta de saída'}>
                {outputDir || 'Selecione a pasta de saída'}
              </span>
            </div>
          </div>
        </div>

        {/* Botão de Abrir Pasta de Destino */}
        {outputDir && (
          <button
            onClick={() => window.pywebview?.api?.open_folder?.(outputDir)}
            style={{
              background: D.bgCard,
              border: `1px solid ${D.borderLight}`,
              color: D.textPrimary,
              borderRadius: '8px',
              padding: '8px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px'
            }}
          >
            {Icons.opendir(D.textPrimary)} Abrir Pasta de Destino
          </button>
        )}

        {/* Botão de Run */}
        <button
          onClick={handleRun}
          disabled={running || (mode === 'single' ? !excelPath : excelPaths.length === 0) || !outputDir}
          style={{
            background: running ? D.bgHover : accent,
            color: '#fff',
            border: 0,
            borderRadius: '8px',
            padding: '10px',
            fontSize: '13px',
            fontWeight: 600,
            cursor: (running || (mode === 'single' ? !excelPath : excelPaths.length === 0) || !outputDir) ? 'not-allowed' : 'pointer',
            opacity: (running || (mode === 'single' ? !excelPath : excelPaths.length === 0) || !outputDir) ? 0.6 : 1,
            marginTop: 'auto'
          }}
        >
          {running ? 'Processando...' : 'Iniciar Processamento'}
        </button>
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
        {/* Progresso de Lote */}
        {mode === 'batch' && batchProgress.total > 0 && (
          <div style={{ marginBottom: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: D.textPrimary, fontWeight: 600, marginBottom: '6px' }}>
              <span>Lote Geral (Planilhas)</span>
              <span>{batchProgress.current} / {batchProgress.total}</span>
            </div>
            <div style={{ height: '6px', background: D.bgHover, borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                background: D.success,
                width: `${(batchProgress.current / batchProgress.total) * 100}%`,
                transition: 'width 0.3s ease'
              }} />
            </div>
          </div>
        )}

        {/* Progresso de Downloads da Planilha Atual */}
        {progress.total > 0 && (
          <div style={{ marginBottom: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: D.textSecond, marginBottom: '6px' }}>
              <span>Downloads / Marcação de Fotos</span>
              <span>{progress.current} / {progress.total}</span>
            </div>
            <div style={{ height: '6px', background: D.bgHover, borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                background: accent,
                width: `${(progress.current / progress.total) * 100}%`,
                transition: 'width 0.1s ease'
              }} />
            </div>
          </div>
        )}

        {/* Logs */}
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
