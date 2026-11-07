import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type {
  DesktopModelInfo,
  DesktopModelList,
  DesktopModelPullProgress,
  DesktopProviderStatus,
  DesktopSpeechSetupStatus,
} from '../../../desktop/contracts.ts';

const CONTEXT_OPTIONS = [4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144];

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_024 ? `${Math.round(tokens / 1_024)}K` : String(tokens);
}

function isCurrent(model: DesktopModelInfo, current: string): boolean {
  return model.name === current || model.name === `${current}:latest`;
}

/** "huihui_ai/qwen3-abliterated:14b" → "qwen3-abliterated:14b"; the source goes in the meta line. */
function shortName(name: string): string {
  return name.split('/').at(-1) ?? name;
}

/** Where a model comes from, when it is not an official library model ("huihui_ai", "hf.co/Youssofal"). */
function modelSource(name: string): string | undefined {
  const parts = name.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : undefined;
}

/** "huihui_ai · 14.8B · 9.0 GB · 40K max" */
function modelMeta(model: DesktopModelInfo): string {
  return [modelSource(model.name), model.parameterSize, formatBytes(model.sizeBytes), model.contextLength ? `${formatTokens(model.contextLength)} max` : undefined]
    .filter(Boolean).join(' · ');
}

function CapabilityBadges({ model }: { readonly model: DesktopModelInfo }) {
  const tools = model.capabilities.includes('tools');
  const known = model.capabilities.length > 0;
  return (
    <span className="model-badges">
      {known && !tools && <span className="model-badge model-badge-warn" title="Cannot read files, run commands, or open apps in Vyomara">Chat only</span>}
      {tools && <span className="model-badge" title="Can use Vyomara's coding and app tools">Tools</span>}
      {model.capabilities.includes('thinking') && <span className="model-badge">Thinking</span>}
      {model.capabilities.includes('vision') && <span className="model-badge">Vision</span>}
    </span>
  );
}

/**
 * Run any local Ollama model from the app: list installed models with their
 * capabilities, switch, tune context and thinking, download, and remove.
 */
export function ModelsPanel({
  headingRef,
  disabled,
  onSelected,
  onClose,
  assistantName = 'Vyom',
}: {
  /** The selected assistant's name (Vyom or Vyomara). */
  readonly assistantName?: string;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly disabled: boolean;
  readonly onSelected: (status: DesktopProviderStatus) => void;
  readonly onClose: () => void;
}) {
  const [modelList, setModelList] = useState<DesktopModelList>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [modelToPull, setModelToPull] = useState('');
  const [pull, setPull] = useState<DesktopModelPullProgress & { readonly done?: boolean }>();
  const [removing, setRemoving] = useState<string>();
  const [removeConfirmation, setRemoveConfirmation] = useState('');
  const pulling = pull !== undefined && pull.done !== true;
  const [speech, setSpeech] = useState<DesktopSpeechSetupStatus>();
  const [speechProgress, setSpeechProgress] = useState<number>();
  const locked = disabled || busy || pulling;

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      setModelList(await window.vyomara.listModels());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Installed models could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    headingRef.current?.focus();
    void refresh();
    void window.vyomara.getSpeechSetupStatus().then(setSpeech).catch(() => undefined);
    const stopPull = window.vyomara.onModelPullProgress(progress => setPull(progress));
    const stopSpeech = window.vyomara.onSpeechRecognition(event => {
      if (event.type === 'model-progress' && event.total > 0) setSpeechProgress(Math.round(event.received / event.total * 100));
      if (event.type === 'model-ready') setSpeechProgress(undefined);
    });
    return () => {
      stopPull();
      stopSpeech();
    };
  }, []);

  const chooseSpeech = (model: 'fast' | 'best') => act(async () => {
    setSpeech(await window.vyomara.selectSpeechModel(model));
  }, 'The speech model could not be selected.');

  const downloadSpeech = () => act(async () => {
    setSpeechProgress(0);
    await window.vyomara.downloadSpeechModel();
    setSpeechProgress(undefined);
    setSpeech(await window.vyomara.getSpeechSetupStatus());
    setNotice('Speech model downloaded. Turn listening on with the orb.');
  }, 'The speech model could not be downloaded.');

  async function act(work: () => Promise<void>, failure: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    } finally {
      setBusy(false);
    }
  }

  const choose = (model: DesktopModelInfo) => act(async () => {
    onSelected(await window.vyomara.selectModel(model.name));
    const limit = model.contextLength;
    if (limit !== undefined && modelList && modelList.settings.numCtx > limit) {
      onSelected(await window.vyomara.setModelSettings({ numCtx: limit }));
    }
    if (!model.capabilities.includes('tools') && model.capabilities.length > 0) {
      setNotice(`${model.name} is chat-only: it cannot read files, run commands, or open apps.`);
    }
    await refresh();
  }, 'The model could not be selected.');

  const updateSettings = (settings: { numCtx?: number; think?: boolean }) => act(async () => {
    onSelected(await window.vyomara.setModelSettings(settings));
    setModelList(current => current ? { ...current, settings: { ...current.settings, ...settings } } : current);
  }, 'The setting could not be saved.');

  const remove = (name: string) => act(async () => {
    await window.vyomara.deleteModel(name, removeConfirmation);
    setRemoving(undefined);
    setRemoveConfirmation('');
    setNotice(`${name} was removed from Ollama.`);
    await refresh();
  }, 'The model could not be removed.');

  const startOllama = () => act(async () => {
    await window.vyomara.startOllama();
    await refresh();
  }, 'Ollama could not be started.');

  async function download(): Promise<void> {
    const name = modelToPull.trim();
    if (!name || pulling) return;
    setError(undefined);
    setNotice(undefined);
    setPull({ model: name, status: 'starting' });
    try {
      await window.vyomara.pullModel(name);
      setPull({ model: name, status: 'downloaded', done: true });
      setModelToPull('');
      await refresh();
    } catch (cause) {
      setPull(undefined);
      setError(cause instanceof Error ? cause.message : 'The model could not be downloaded.');
    }
  }

  const current = modelList?.models.find(model => isCurrent(model, modelList.current));
  const contextLimit = current?.contextLength ?? 262_144;
  const contextOptions = CONTEXT_OPTIONS.filter(option => option <= contextLimit);
  const supportsThinking = current?.capabilities.includes('thinking') === true;

  return (
    <aside id="models-panel" className="activity-panel models-panel" aria-label="Local models">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">RUNS ON THIS MAC</p>
          <h2 ref={headingRef} tabIndex={-1}>Models</h2>
        </div>
        <button className="history-close" type="button" onClick={onClose}>Close</button>
      </div>
      <div className="history-content models-content" aria-live="polite">
        {loading ? (
          <p className="history-message" role="status">Loading installed models…</p>
        ) : modelList && !modelList.available ? (
          <div className="model-section">
            <p className="history-message history-error" role="alert">Ollama is not running, so no local model can answer.</p>
            <button className="history-action" type="button" onClick={() => void startOllama()} disabled={locked}>
              {busy ? 'Starting Ollama…' : 'Start Ollama'}
            </button>
          </div>
        ) : modelList && modelList.models.length > 0 ? (
          <>
            {current && (
              <section className="model-current" aria-label="Model in use">
                <div className="model-card-head">
                  <span className="model-name" title={current.name}>{shortName(current.name)}</span>
                  <span className="model-in-use">In use</span>
                </div>
                <span className="model-meta">{modelMeta(current)}</span>
                <CapabilityBadges model={current} />
                <div className="model-settings">
                  <label className="model-setting" title="How much of your files and conversation the model can keep in mind. Larger uses more RAM and is slower; 32K suits coding on a 24 GB Mac.">
                    <span>Context</span>
                    <select
                      id="model-context"
                      className="model-select"
                      value={contextOptions.includes(modelList.settings.numCtx) ? modelList.settings.numCtx : ''}
                      onChange={event => void updateSettings({ numCtx: Number(event.target.value) })}
                      disabled={locked}
                    >
                      {!contextOptions.includes(modelList.settings.numCtx) && <option value="">{formatTokens(modelList.settings.numCtx)}</option>}
                      {contextOptions.map(option => <option key={option} value={option}>{formatTokens(option)}</option>)}
                    </select>
                  </label>
                  <label className="model-setting" title={supportsThinking ? 'Thinks before answering: better on hard problems, slower.' : 'This model cannot think step by step.'}>
                    <input
                      type="checkbox"
                      checked={supportsThinking && modelList.settings.think}
                      onChange={event => void updateSettings({ think: event.target.checked })}
                      disabled={locked || !supportsThinking}
                    />
                    <span>Think first</span>
                  </label>
                </div>
              </section>
            )}

            <p className="model-group-title">Installed</p>
            <ul className="model-list">
              {modelList.models.filter(model => !isCurrent(model, modelList.current)).map(model => (
                <li key={model.name} className="model-item">
                  <div className="model-item-info">
                    <span className="model-name" title={model.name}>{shortName(model.name)}</span>
                    <span className="model-meta">{modelMeta(model)}</span>
                    <CapabilityBadges model={model} />
                  </div>
                  {removing === model.name ? (
                    <div className="model-remove">
                      <input
                        id={`remove-${model.name}`}
                        className="model-confirm"
                        value={removeConfirmation}
                        onChange={event => setRemoveConfirmation(event.target.value)}
                        placeholder="Type DELETE"
                        aria-label={`Type DELETE to remove ${model.name}`}
                        autoComplete="off"
                      />
                      <button className="history-danger" type="button" disabled={removeConfirmation !== 'DELETE' || locked} onClick={() => void remove(model.name)}>Remove</button>
                      <button className="model-icon-button" type="button" onClick={() => { setRemoving(undefined); setRemoveConfirmation(''); }} aria-label="Cancel">✕</button>
                    </div>
                  ) : (
                    <div className="model-item-actions">
                      <button className="model-use" type="button" onClick={() => void choose(model)} disabled={locked}>Use</button>
                      <button
                        className="model-icon-button"
                        type="button"
                        disabled={locked}
                        onClick={() => { setRemoving(model.name); setRemoveConfirmation(''); }}
                        aria-label={`Remove ${model.name}`}
                        title={`Remove ${model.name} (frees ${formatBytes(model.sizeBytes)})`}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5" /></svg>
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : !error ? (
          <p className="history-message">No models are installed in Ollama yet. Download one below.</p>
        ) : null}

        {error && <p className="history-message history-error" role="alert">{error}</p>}
        {notice && <p className="history-notice" role="status">{notice}</p>}

        {modelList?.available !== false && (
          <form className="model-pull" onSubmit={event => { event.preventDefault(); void download(); }}>
            <p className="model-group-title">Add a model</p>
            <div className="model-pull-row">
              <input
                id="model-pull-name"
                className="model-confirm"
                value={modelToPull}
                onChange={event => setModelToPull(event.target.value)}
                placeholder="qwen3:14b or hf.co/user/repo:Q4_K_M"
                aria-label="Model to download"
                title="Any name from ollama.com/library, or a Hugging Face GGUF as hf.co/<user>/<repo>:<quantization>. For coding pick one with Tools; 24 GB of RAM fits about 14B (27B in Q3)."
                autoComplete="off"
                disabled={pulling}
              />
              <button className="model-use" type="submit" disabled={!modelToPull.trim() || pulling}>
                {pulling ? '…' : 'Download'}
              </button>
            </div>
            {pull && (
              <div className="model-progress" role="status">
                <span>{pull.model}: {pull.status}{pull.total ? ` · ${Math.round(((pull.completed ?? 0) / pull.total) * 100)}%` : ''}</span>
                {pull.total ? <progress value={pull.completed ?? 0} max={pull.total} /> : null}
              </div>
            )}
          </form>
        )}

        {speech && (
          <section className="model-voice" aria-label="Voice recognition">
            <p className="model-group-title" title={`Speech is recognised on this Mac with whisper.cpp; audio never leaves it. Press the orb (or ⌥Space) and talk: ${assistantName} answers on screen and aloud. Say “bas” to end.`}>
              Voice recognition
            </p>
            <div className="model-segmented" role="radiogroup" aria-label="Voice model">
              {speech.models.map(model => (
                <button
                  key={model.id}
                  type="button"
                  role="radio"
                  aria-checked={speech.model === model.id}
                  className={speech.model === model.id ? 'model-segment-active' : ''}
                  onClick={() => void chooseSpeech(model.id)}
                  disabled={locked || speechProgress !== undefined}
                  title={`${model.label} · ${model.approxMegabytes} MB${model.ready ? '' : ' · not downloaded'}`}
                >
                  {model.id === 'best' ? 'Best · Hindi + English' : 'Fast · English'}
                </button>
              ))}
            </div>
            {!speech.models.find(model => model.id === speech.model)?.ready && (
              <button className="history-action" type="button" onClick={() => void downloadSpeech()} disabled={locked || speech.listeningEnabled}>
                {speechProgress !== undefined ? `Downloading… ${speechProgress}%` : 'Download this voice model'}
              </button>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}
