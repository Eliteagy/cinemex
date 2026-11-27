// The only bridge between the editor UI and the PC.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ec', {
  importDialog: () => ipcRenderer.invoke('media:import-dialog'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  importPaths: (paths) => ipcRenderer.invoke('media:import', paths),
  allowMedia: (paths) => ipcRenderer.invoke('media:allow', paths),
  transcribe: (file, opts) => ipcRenderer.invoke('captions:transcribe', file, opts),
  userFont: (name) => ipcRenderer.invoke('fonts:user', name),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  fontFile: (family) => ipcRenderer.invoke('fonts:file', family),
  listCaptionStyles: () => ipcRenderer.invoke('styles:list'),
  saveCaptionStyle: (id, style) => ipcRenderer.invoke('styles:save', id, style),
  deleteCaptionStyle: (id) => ipcRenderer.invoke('styles:delete', id),
  captionClips: (clip, words, opts) => ipcRenderer.invoke('captions:clips', clip, words, opts),
  matte: (req) => ipcRenderer.invoke('matte:run', req),
  detectFace: (req) => ipcRenderer.invoke('face:detect', req),
  generateEffects: (category, request, opts) => ipcRenderer.invoke('effects:generate', category, request, opts),
  cancelEffects: () => ipcRenderer.invoke('effects:cancel'),
  onEffectResult: (cb) => {
    const f = (_e, r) => cb(r);
    ipcRenderer.on('effects:result', f);
    return () => ipcRenderer.removeListener('effects:result', f);
  },
  listEffects: () => ipcRenderer.invoke('effects:list'),
  saveEffect: (recipe, name) => ipcRenderer.invoke('effects:save', recipe, name),
  renameEffect: (id, name) => ipcRenderer.invoke('effects:rename', id, name),
  deleteEffect: (id) => ipcRenderer.invoke('effects:delete', id),
  listCaptionModels: () => ipcRenderer.invoke('capmodels:list'),
  saveCaptionModel: (id, model) => ipcRenderer.invoke('capmodels:save', id, model),
  deleteCaptionModel: (id) => ipcRenderer.invoke('capmodels:delete', id),
  onMatteProgress: (cb) => {
    const f = (_e, m) => cb(m);
    ipcRenderer.on('matte:progress', f);
    return () => ipcRenderer.removeListener('matte:progress', f);
  },
  exportVideo: (project, opts) => ipcRenderer.invoke('export:run', project, opts),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  aiAsk: (prompt, opts) => ipcRenderer.invoke('ai:ask', prompt, opts),
  findHotclips: (words, opts) => ipcRenderer.invoke('ai:hotclips', words, opts),
  cancelAi: () => ipcRenderer.invoke('ai:cancel'),
  dubVoices: () => ipcRenderer.invoke('dub:voices'),
  dub: (cues, opts) => ipcRenderer.invoke('dub:run', cues, opts),
  onAiProgress: (cb) => {
    const f = (_e, p) => cb(p);
    ipcRenderer.on('ai:progress', f);
    return () => ipcRenderer.removeListener('ai:progress', f);
  },
  buildShorts: (media, clips, opts) => ipcRenderer.invoke('shorts:build', media, clips, opts),
  onShortsProgress: (cb) => {
    const f = (_e, p) => cb(p);
    ipcRenderer.on('shorts:progress', f);
    return () => ipcRenderer.removeListener('shorts:progress', f);
  },
  onExportProgress: (cb) => {
    const f = (_e, p) => cb(p);
    ipcRenderer.on('export:progress', f);
    return () => ipcRenderer.removeListener('export:progress', f);
  },
  saveProject: (project, file) => ipcRenderer.invoke('project:save', project, file),
  openProject: (file) => ipcRenderer.invoke('project:open', file ?? null),
  capcutList: () => ipcRenderer.invoke('capcut:list'),
  capcutImport: (file) => ipcRenderer.invoke('capcut:import', file),
  peaks: (file) => ipcRenderer.invoke('media:peaks', file),
  saveText: (name, content, ext) => ipcRenderer.invoke('text:save', name, content, ext),
  openText: (ext) => ipcRenderer.invoke('text:open', ext),
  pickLut: () => ipcRenderer.invoke('lut:pick'),
  writeSrt: (file, content) => ipcRenderer.invoke('srt:write', file, content),
  readSrt: (file) => ipcRenderer.invoke('srt:read', file),
  reveal: (file) => ipcRenderer.invoke('shell:reveal', file),
  mcpInfo: () => ipcRenderer.invoke('mcp:info'),
  sfxList: () => ipcRenderer.invoke('sfx:list'),
  freezeFrame: (file, time) => ipcRenderer.invoke('media:freeze', file, time),
  saveVoice: (bytes) => ipcRenderer.invoke('voice:save', bytes),
  paths: () => ipcRenderer.invoke('app:paths'),
  // Ligação (live link with the other computer) and updates from GitHub.
  collabGet: () => ipcRenderer.invoke('collab:get'),
  collabSet: (patch) => ipcRenderer.invoke('collab:set', patch),
  collabPickFolder: () => ipcRenderer.invoke('collab:pick-folder'),
  collabMakeFolder: () => ipcRenderer.invoke('collab:make-folder'),
  collabNewCode: () => ipcRenderer.invoke('collab:new-code'),
  collabGetCode: () => ipcRenderer.invoke('collab:get-code'),
  collabInvite: () => ipcRenderer.invoke('collab:invite'),
  collabUseLink: (link) => ipcRenderer.invoke('collab:use-link', link),
  onCollabOpen: (cb) => {
    const f = () => cb();
    ipcRenderer.on('collab:open', f);
    return () => ipcRenderer.removeListener('collab:open', f);
  },
  collabSetCode: (code) => ipcRenderer.invoke('collab:set-code', code),
  collabConnect: () => ipcRenderer.invoke('collab:connect'),
  collabDisconnect: () => ipcRenderer.invoke('collab:disconnect'),
  collabSend: (msg) => ipcRenderer.invoke('collab:send', msg),
  onCollabStatus: (cb) => {
    const f = (_e, s) => cb(s);
    ipcRenderer.on('collab:status', f);
    return () => ipcRenderer.removeListener('collab:status', f);
  },
  onCollabMessage: (cb) => {
    const f = (_e, m) => cb(m);
    ipcRenderer.on('collab:message', f);
    return () => ipcRenderer.removeListener('collab:message', f);
  },
  updateInfo: (opts) => ipcRenderer.invoke('update:info', opts),
  updateApply: () => ipcRenderer.invoke('update:apply'),
  onUpdateStep: (cb) => {
    const f = (_e, s) => cb(s);
    ipcRenderer.on('update:step', f);
    return () => ipcRenderer.removeListener('update:step', f);
  },
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  claudeStatus: (who) => ipcRenderer.invoke('claude:status', who),
  claudeSend: (projectKey, text, who) => ipcRenderer.invoke('claude:send', projectKey, text, who),
  claudeCancel: (who) => ipcRenderer.invoke('claude:cancel', who),
  claudeReset: (projectKey, who) => ipcRenderer.invoke('claude:reset', projectKey, who),
  onClaudeEvent: (cb) => {
    const f = (_e, ev) => cb(ev);
    ipcRenderer.on('claude:event', f);
    return () => ipcRenderer.removeListener('claude:event', f);
  },
  onMcpCall: (handler) => {
    const f = async (_e, { id, name, args }) => {
      try {
        ipcRenderer.send('mcp:result', { id, ok: true, result: await handler(name, args) });
      } catch (err) {
        ipcRenderer.send('mcp:result', { id, ok: false, error: String(err && err.message ? err.message : err) });
      }
    };
    ipcRenderer.on('mcp:call', f);
    return () => ipcRenderer.removeListener('mcp:call', f);
  },
});
