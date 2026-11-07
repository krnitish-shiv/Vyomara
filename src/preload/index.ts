import type { PersonaId } from '../shared/persona.ts';
import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopActionProposal,
  DesktopChatRequest,
  DesktopFileOperationProposal,
  DesktopModelPullProgress,
  DesktopPipCommand,
  DesktopPipState,
  DesktopPlan,
  DesktopSpeechRecognitionEvent,
  DesktopToolActivity,
  VyomaraDesktopApi,
} from '../desktop/contracts.ts';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
import type { DiagnosticEvent } from '../diagnostics/logger.ts';

const api: VyomaraDesktopApi = {
  publishPipState(state: DesktopPipState) {
    ipcRenderer.send('vyomara:pip-state', state);
  },
  onPipState(listener: (state: DesktopPipState) => void) {
    return subscribe('vyomara:pip-state', listener);
  },
  sendPipCommand(command: DesktopPipCommand) {
    ipcRenderer.send('vyomara:pip-command', command);
  },
  onPipCommand(listener: (command: DesktopPipCommand) => void) {
    return subscribe('vyomara:pip-command', listener);
  },
  getProviderStatus() {
    return ipcRenderer.invoke('vyomara:provider-status');
  },
  sendMessage(request: DesktopChatRequest) {
    return ipcRenderer.invoke('vyomara:chat-send', request);
  },
  onChatText(listener) {
    const handler = (_event: Electron.IpcRendererEvent, chunk: { requestId: string; text: string }): void => {
      listener(chunk);
    };
    ipcRenderer.on('vyomara:chat-text', handler);
    return () => ipcRenderer.removeListener('vyomara:chat-text', handler);
  },
  onFileOperationProposal(listener) {
    const handler = (_event: Electron.IpcRendererEvent, proposal: DesktopFileOperationProposal): void => {
      listener(proposal);
    };
    ipcRenderer.on('vyomara:file-operation-proposed', handler);
    return () => ipcRenderer.removeListener('vyomara:file-operation-proposed', handler);
  },
  approveFileOperation(id: string, confirmation?: string) {
    return ipcRenderer.invoke('vyomara:file-operation-approve', {
      id,
      ...(confirmation === undefined ? {} : { confirmation }),
    });
  },
  rejectFileOperation(id: string) {
    return ipcRenderer.invoke('vyomara:file-operation-reject', id);
  },
  onActionProposal(listener: (proposal: DesktopActionProposal) => void) {
    return subscribe('vyomara:action-proposed', listener);
  },
  approveAction(id: string, always = false) {
    return ipcRenderer.invoke('vyomara:action-approve', { id, always });
  },
  rejectAction(id: string) {
    return ipcRenderer.invoke('vyomara:action-reject', id);
  },
  onToolActivity(listener: (activity: DesktopToolActivity) => void) {
    return subscribe('vyomara:tool-activity', listener);
  },
  listPermissions() {
    return ipcRenderer.invoke('vyomara:permissions-list');
  },
  grantPermission(id: string) {
    return ipcRenderer.invoke('vyomara:permission-grant', id);
  },
  revokePermission(id: string) {
    return ipcRenderer.invoke('vyomara:permission-revoke', id);
  },
  onPlan(listener: (plan: DesktopPlan) => void) {
    return subscribe('vyomara:plan', listener);
  },
  listModels() {
    return ipcRenderer.invoke('vyomara:models-list');
  },
  selectModel(model: string) {
    return ipcRenderer.invoke('vyomara:model-select', model);
  },
  pullModel(model: string) {
    return ipcRenderer.invoke('vyomara:model-pull', model);
  },
  setModelSettings(settings) {
    return ipcRenderer.invoke('vyomara:model-settings-set', settings);
  },
  deleteModel(model: string, confirmation: string) {
    return ipcRenderer.invoke('vyomara:model-delete', { name: model, confirmation });
  },
  startOllama() {
    return ipcRenderer.invoke('vyomara:ollama-start');
  },
  onModelPullProgress(listener: (progress: DesktopModelPullProgress) => void) {
    return subscribe('vyomara:model-pull-progress', listener);
  },
  cancelRequest() {
    return ipcRenderer.invoke('vyomara:chat-cancel');
  },
  listSessions() {
    return ipcRenderer.invoke('vyomara:sessions-list');
  },
  loadSession(sessionId: string) {
    return ipcRenderer.invoke('vyomara:session-load', sessionId);
  },
  exportSession(sessionId: string) {
    return ipcRenderer.invoke('vyomara:session-export', sessionId);
  },
  deleteSession(sessionId: string, confirmation: string) {
    return ipcRenderer.invoke('vyomara:session-delete', { id: sessionId, confirmation });
  },
  getSpeechSetupStatus() {
    return ipcRenderer.invoke('vyomara:speech-setup-status');
  },
  selectSpeechModel(model: 'fast' | 'best') {
    return ipcRenderer.invoke('vyomara:speech-model-select', model);
  },
  downloadSpeechModel() {
    return ipcRenderer.invoke('vyomara:speech-model-download');
  },
  setDictation(active: boolean) {
    return ipcRenderer.invoke('vyomara:speech-dictation', active);
  },
  transcribeSpeech(wav: Uint8Array) {
    return ipcRenderer.invoke('vyomara:speech-transcribe', wav);
  },
  setSpeechListening(enabled: boolean) {
    return ipcRenderer.invoke('vyomara:speech-listening-set', enabled);
  },
  onSpeechRecognition(listener: (event: DesktopSpeechRecognitionEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, recognitionEvent: DesktopSpeechRecognitionEvent): void => {
      listener(recognitionEvent);
    };
    ipcRenderer.on('vyomara:speech-recognition-event', handler);
    return () => ipcRenderer.removeListener('vyomara:speech-recognition-event', handler);
  },
  speakText(text: string) {
    return ipcRenderer.invoke('vyomara:speech-speak', text);
  },
  stopSpeaking() {
    return ipcRenderer.invoke('vyomara:speech-stop');
  },
  approveAllFileOperations(id: string) {
    return ipcRenderer.invoke('vyomara:file-operation-approve-all', id);
  },
  getPipEnabled() {
    return ipcRenderer.invoke('vyomara:pip-enabled-get');
  },
  setPipEnabled(enabled: boolean) {
    return ipcRenderer.invoke('vyomara:pip-enabled-set', enabled);
  },
  openLink(url: string) {
    return ipcRenderer.invoke('vyomara:open-link', url);
  },
  listMemories() {
    return ipcRenderer.invoke('vyomara:memories-list');
  },
  forgetMemory(id: string) {
    return ipcRenderer.invoke('vyomara:memory-forget', id);
  },
  openFileDiff(id: string) {
    return ipcRenderer.invoke('vyomara:file-diff-open', id);
  },
  getUndoStatus() {
    return ipcRenderer.invoke('vyomara:undo-status');
  },
  undoLastChange() {
    return ipcRenderer.invoke('vyomara:undo-last');
  },
  getPersona() {
    return ipcRenderer.invoke('vyomara:persona-get');
  },
  setPersona(id: PersonaId) {
    return ipcRenderer.invoke('vyomara:persona-set', id);
  },
  onActivity(listener: (event: DiagnosticEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, activity: DiagnosticEvent): void => {
      listener(activity);
    };
    ipcRenderer.on('vyomara:activity', handler);
    return () => ipcRenderer.removeListener('vyomara:activity', handler);
  },
};

contextBridge.exposeInMainWorld('vyomara', api);
