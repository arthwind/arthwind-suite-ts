import { useState, useEffect } from 'react';
import { Icons } from '../constants/icons.jsx';
import { docContent } from '../constants/translations.js';
import GpsSelector from './GpsSelector.jsx';
import BladeSplitSelector from './BladeSplitSelector.jsx';
import ReconstruirSelector from './ReconstruirSelector.jsx';
import GoproRawSelector from './GoproRawSelector.jsx';
import HorizonModule from './HorizonModule.jsx';

import WorkflowModule from './WorkflowModule.jsx';
import ReconstruirModule from './ReconstruirModule.jsx';
import ArthnexUploaderModule from './ArthnexUploaderModule.jsx';
import SnowModule from './SnowModule.jsx';
import SnowAutomationModule from './SnowAutomationModule.jsx';

// Módulos autônomos (arquivo próprio, estado interno grande — fila, log,
// automações demoradas) que NÃO podem ser desmontados ao trocar de aba, senão
// perdem tudo (relatado pelo usuário: saiu da Automação SNOW rodando, voltou e
// não tinha mais como pausar/parar, mesmo o log continuando a rodar). Cada um
// só é montado na primeira vez que a aba é aberta ("visited"), e depois disso
// fica sempre montado — só escondido com `display:none` quando não é a aba
// ativa. `display:'contents'` quando ativo pra não interferir no layout do
// módulo (ele se comporta como se fosse filho direto de `.module-form`, igual
// já era antes dessa mudança).
const KEEP_ALIVE_MODULES = {
  19: (props) => <ArthnexUploaderModule T={props.T} D={props.D} />,
  17: (props) => <WorkflowModule T={props.T} D={props.D} isPyWebView={props.isPyWebView} onOpenFolder={props.onOpenFolder} />,
  16: (props) => <HorizonModule D={props.D} isPyWebView={props.isPyWebView} onOpenFolder={props.onOpenFolder} />,
  11: (props) => <ReconstruirModule D={props.D} isPyWebView={props.isPyWebView} onOpenFolder={props.onOpenFolder} />,
  23: (props) => <SnowModule D={props.D} />,
  24: (props) => <SnowAutomationModule D={props.D} />,
};

export default function ModuleForm({
  T, D, lang, active, module,
  filePaths, setFilePaths, options, setOptions,
  running, ran, lastOutput, ranHadError, onReset,
  isWideModule,
  gpsLoading, gpsFotos, gpsRaiz, setGpsRaiz,
  bladeSplitLoading, bladeSplitSuspeitos, setBladeSplitSuspeitos,
  fotosReconstruirLoading, fotosReconstruir,
  goproRawLoading, goproRawRegioes,
  onPickInput, onCarregarGps, onCarregarBladeSplit, onCarregarFotosReconstruir,
  onCarregarGoproRaw, onRun, onOpenFolder,
  isPyWebView,
}) {
  const [expandedDoc, setExpandedDoc] = useState(0);

  // Abas de módulo autônomo já visitadas nessa sessão — cada uma monta na
  // primeira vez e nunca mais desmonta (só fica escondida), pra não perder o
  // estado interno ao trocar de aba.
  const [visitedKeepAlive, setVisitedKeepAlive] = useState(() => (KEEP_ALIVE_MODULES[active] ? [active] : []));
  useEffect(() => {
    if (KEEP_ALIVE_MODULES[active] && !visitedKeepAlive.includes(active)) {
      setVisitedKeepAlive((prev) => [...prev, active]);
    }
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Verifica se todos os inputs obrigatórios estão preenchidos
  const allInputsFilled = module.inputs?.every(inp => !!filePaths[inp.inputId]) ?? true;
  const needsGpsRaiz = (active === 5 || active === 7);
  const canRun = !running && allInputsFilled
    && (!needsGpsRaiz || (gpsRaiz && gpsFotos.length > 0))
    && (active !== 6  || bladeSplitSuspeitos?.length > 0)
    && (active !== 11 || (fotosReconstruir?.length > 0 && options?.blade_sn && options?.sides?.length > 0))
    && (active !== 15 || (
      goproRawRegioes?.length > 0 &&
      options?.turbine?.trim() &&
      options?.blade_sn?.trim()
    ));

  const handlePickInput = async (inp) => {
    const path = await onPickInput(inp);
    if (path) {
      setFilePaths(p => ({ ...p, [inp.inputId]: path }));
    }
  };

  const handleClearInput = (inp) => {
    setFilePaths(p => ({ ...p, [inp.inputId]: "" }));
    if (active === 5 || active === 7) {
      setGpsRaiz("");
    }
  };

  return (
    <div className={`module-form${isWideModule ? " wide" : ""}`}>
      {/* Módulos autônomos: montados uma vez (primeira visita) e nunca mais
          desmontados — só escondidos com display:none quando não ativos. */}
      {visitedKeepAlive.map((id) => (
        <div key={id} style={{ display: active === id ? 'contents' : 'none' }}>
          {KEEP_ALIVE_MODULES[id]({ T, D, isPyWebView, onOpenFolder })}
        </div>
      ))}
      {KEEP_ALIVE_MODULES[active] ? null : module.doc ? (
        <div style={{ paddingBottom: "20px" }}>
          {docContent[lang].map((d, i) => {
            const isExpanded = expandedDoc === i;
            return (
              <div
                key={i}
                className="doc-card"
                onClick={() => setExpandedDoc(isExpanded ? -1 : i)}
                style={{
                  background: D.bgCard,
                  border: `1px solid ${isExpanded ? D.accent : D.borderLight}`,
                  cursor: "pointer",
                  transition: "all 0.2s",
                  marginBottom: "8px",
                  boxShadow: isExpanded ? `0 2px 8px ${D.accentSofter}` : "none"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div className="doc-card-title" style={{ color: isExpanded ? D.accent : D.textPrimary, margin: 0, fontSize: "12.5px" }}>
                    {d.title}
                  </div>
                  <div style={{ color: D.textMuted, transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.25s" }}>
                    ▼
                  </div>
                </div>
                {isExpanded && (
                  <div className="doc-card-body" style={{ color: D.textSecond, marginTop: "12px", borderTop: `1px dashed ${D.borderLight}`, paddingTop: "12px", whiteSpace: "pre-line" }}>
                    {d.body}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          {/* Inputs de arquivo/pasta */}
          {module.inputs.map((inp, i) => {
            const val = filePaths[inp.inputId];
            return (
              <div key={i} className="form-group">
                <div className="field-label" style={{ color: D.textMuted }}>{inp.label}</div>
                <div className="form-input-row">
                  <div
                    className={`input-field${val ? " filled" : ""}`}
                    onClick={() => handlePickInput(inp)}
                  >
                    <span style={{ color: val ? D.accent : D.textMuted, flexShrink: 0 }}>
                      {inp.type === "folder"
                        ? Icons.folder(val ? D.accent : D.textMuted)
                        : Icons.file(val ? D.accent : D.textMuted)}
                    </span>
                    <span className="input-field-text" title={val || inp.placeholder}>
                      {val || inp.placeholder}
                    </span>
                    {val && (
                      <span
                        className="input-field-clear"
                        style={{ color: D.textMuted }}
                        onClick={e => { e.stopPropagation(); handleClearInput(inp); }}
                      >
                        {Icons.close(D.textMuted)}
                      </span>
                    )}
                  </div>
                  {(active === 5 || active === 7) && inp.type === "folder" && val && (
                    <button
                      className="gps-load-btn"
                      onClick={() => onCarregarGps(val)}
                      disabled={gpsLoading}
                      style={{
                        border: `1px solid ${D.accent}`,
                        color: D.accent,
                        opacity: gpsLoading ? 0.6 : 1,
                      }}
                    >
                      {gpsLoading ? T.loading : T.load_photos}
                    </button>
                  )}
                  {active === 11 && inp.inputId === "photos_dir" && val && (
                    <button
                      className="gps-load-btn"
                      onClick={() => onCarregarFotosReconstruir(val)}
                      disabled={fotosReconstruirLoading}
                      style={{
                        border: `1px solid ${D.accent}`,
                        color: D.accent,
                        opacity: fotosReconstruirLoading ? 0.6 : 1,
                      }}
                    >
                      {fotosReconstruirLoading ? T.loading : T.load_photos}
                    </button>
                  )}
                  {active === 6 && inp.inputId === "data_file" && val && (
                    <button
                      className="gps-load-btn"
                      onClick={() => onCarregarBladeSplit(val)}
                      disabled={bladeSplitLoading}
                      style={{
                        border: `1px solid ${D.accent}`,
                        color: D.accent,
                        opacity: bladeSplitLoading ? 0.6 : 1,
                        marginLeft: '8px'
                      }}
                    >
                      {bladeSplitLoading ? T.loading : T.analyze_json}
                    </button>
                  )}
                  {active === 15 && inp.inputId === "blade_dir" && val && (
                    <button
                      className="gps-load-btn"
                      onClick={() => onCarregarGoproRaw(val)}
                      disabled={goproRawLoading}
                      style={{
                        border: `1px solid ${D.accent}`,
                        color: D.accent,
                        opacity: goproRawLoading ? 0.6 : 1,
                        marginLeft: '8px'
                      }}
                    >
                      {goproRawLoading ? T.loading : T.analyze_json}
                    </button>
                  )}
                </div>
                {inp.hint && (
                  <div className="field-hint">{inp.hint}</div>
                )}
              </div>
            );
          })}

          {/* GPS Selector (módulo 5 e 7) */}
          {(active === 5 || active === 7) && (
            <GpsSelector
              T={T} D={D}
              gpsFotos={gpsFotos}
              gpsRaiz={gpsRaiz}
              setGpsRaiz={setGpsRaiz}
            />
          )}

          {/* Reconstruir Selector (módulo 11) */}
          {active === 11 && fotosReconstruir?.length > 0 && (
            <ReconstruirSelector
              D={D}
              fotos={fotosReconstruir}
              setOptions={setOptions}
            />
          )}

          {/* GoPro RAW Selector (módulo 15) */}
          {active === 15 && goproRawRegioes?.length > 0 && (
            <GoproRawSelector
              D={D}
              regioes={goproRawRegioes}
              setOptions={setOptions}
            />
          )}

          {/* Blade Split Selector (módulo 6) */}
          {active === 6 && bladeSplitSuspeitos?.length > 0 && (
            <BladeSplitSelector
              T={T} D={D} lang={lang}
              dataFile={filePaths["data_file"]}
              bladeSplitSuspeitos={bladeSplitSuspeitos}
              setBladeSplitSuspeitos={setBladeSplitSuspeitos}
              setOptions={setOptions}
            />
          )}

          {/* Opções pill ou text */}
          {module.options.length > 0 && (
            <div className="options-row">
              {module.options.map((opt, i) => (
                <div key={i}>
                  <div className="field-label" style={{ color: D.textMuted }}>{opt.label}</div>
                  {opt.type === "text" ? (
                    <input
                      type="text"
                      value={options[opt.optionId] || ""}
                      placeholder={opt.placeholder || ""}
                      onChange={e => setOptions(o => ({ ...o, [opt.optionId]: e.target.value }))}
                      style={{
                        width: "100%", boxSizing: "border-box",
                        background: D.inputBg, color: D.textPrimary,
                        border: `1px solid ${D.border}`, borderRadius: "6px",
                        padding: "7px 10px", fontSize: "12.5px",
                        outline: "none", fontFamily: "inherit",
                      }}
                    />
                  ) : (
                    <div className="pill-group">
                      {opt.choices.map(c => (
                        <button
                          key={c}
                          className={`pill${options[opt.optionId] === c ? " active" : ""}`}
                          onClick={() => setOptions(o => ({ ...o, [opt.optionId]: c }))}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                  {opt.desc && (
                    <div className="option-desc">{opt.desc}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Banner de resultado pós-execução */}
          {ran && !running && (
            <div className={`result-banner ${ranHadError ? "has-error" : "success"}`}>
              <div className="result-banner-icon">
                {ranHadError ? "⚠" : "✓"}
              </div>
              <div className="result-banner-body">
                <div
                  className="result-banner-title"
                  style={{ color: ranHadError ? D.error : D.success }}
                >
                  {ranHadError ? "Erro na execução" : T.done}
                </div>
                <div className="result-banner-text" style={{ color: D.textSecond }}>
                  {ranHadError ? T.done_error_hint : T.done_hint}
                </div>
                <div className="result-banner-actions">
                  {lastOutput && isPyWebView && !ranHadError && (
                    <button
                      className="result-banner-btn primary"
                      onClick={() => onOpenFolder(lastOutput)}
                    >
                      {Icons.opendir("#fff")} {T.open_output}
                    </button>
                  )}
                  <button
                    className="result-banner-btn secondary"
                    onClick={onReset}
                  >
                    {T.run_again}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Botão executar — oculto enquanto exibe o banner de resultado */}
          {module.action && !ran && (
            <div className="action-row">
              <button
                className={`run-btn${running ? " running" : ""}`}
                onClick={onRun}
                disabled={!canRun}
              >
                {running ? T.processing : module.action}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
