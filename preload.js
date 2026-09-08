// preload.js — the only bridge between the sealed renderer and the Node main process.
// contextIsolation is ON; the renderer never touches Node directly. Every capability
// the UI needs is an explicit, named, awaitable channel — nothing more is exposed.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('cortex', {
  // --- auth / lock ---
  unlock: (password) => ipcRenderer.invoke('auth:unlock', password),
  guardStatus: () => ipcRenderer.invoke('guard:status'),
  setup: (password) => ipcRenderer.invoke('auth:setup', password),

  // --- read-only state of the living Cortex ---
  overview: () => ipcRenderer.invoke('cortex:overview'),
  agents: () => ipcRenderer.invoke('cortex:agents'),
  tasks: (opts) => ipcRenderer.invoke('cortex:tasks', opts),
  taskDetail: (id) => ipcRenderer.invoke('cortex:taskDetail', id),
  usage: () => ipcRenderer.invoke('cortex:usage'),
  health: () => ipcRenderer.invoke('cortex:health'),
  security: () => ipcRenderer.invoke('cortex:security'),
  learnings: () => ipcRenderer.invoke('cortex:learnings'),
  nextSteps: () => ipcRenderer.invoke('cortex:nextSteps'),
  focus: () => ipcRenderer.invoke('cortex:focus'),                    // { goal, motus, history, alignment, evidence }
  focusSharpen: (p) => ipcRenderer.invoke('cortex:focusSharpen', p),  // one relay turn: a sharper line and a falsifier
  models: () => ipcRenderer.invoke('cortex:models'),
  settings: () => ipcRenderer.invoke('cortex:settings'),

  // --- Sentinel ---
  notifications: () => ipcRenderer.invoke('cortex:notifications'),
  markNotificationsRead: () => ipcRenderer.invoke('cortex:notifRead'),
  integrity: () => ipcRenderer.invoke('cortex:integrity'),
  acceptIntegrity: (rel) => ipcRenderer.invoke('cortex:integrityAccept', rel),
  heal: (action, arg) => ipcRenderer.invoke('heal:run', { action, arg }),

  // --- Closed loop ---
  proposals: () => ipcRenderer.invoke('cortex:proposals'),
  applyProposal: (p) => ipcRenderer.invoke('cortex:applyProposal', p),
  dismissProposal: (id) => ipcRenderer.invoke('cortex:dismissProposal', id),
  experiments: () => ipcRenderer.invoke('cortex:experiments'),

  // --- Live streaming ---
  liveStatus: () => ipcRenderer.invoke('cortex:liveStatus'),
  liveWatch: (agent) => ipcRenderer.invoke('cortex:liveWatch', agent),
  liveStop: () => ipcRenderer.invoke('cortex:liveStop'),

  // --- v1.2: current work, deliverables, diagnosis, rituals, ledger actions ---
  working: () => ipcRenderer.invoke('cortex:working'),
  outputs: () => ipcRenderer.invoke('cortex:outputs'),
  openPath: (p, reveal) => ipcRenderer.invoke('cortex:openPath', { p, reveal }),
  diagnosis: () => ipcRenderer.invoke('cortex:diagnosis'),
  ritual: (kind) => ipcRenderer.invoke('cortex:ritual', { kind }),
  ledgerAct: (payload) => ipcRenderer.invoke('cortex:ledgerAct', payload),
  propose: (payload) => ipcRenderer.invoke('cortex:propose', payload),
  clear: (key, arg) => ipcRenderer.invoke('cortex:clear', { key, arg }), // wipe an app-owned list
  canary: () => ipcRenderer.invoke('cortex:canary'),                     // the IP-reveal trap
  testCanaryEmail: () => ipcRenderer.invoke('cortex:testCanaryEmail'),   // verify the canary email pipeline

  // --- Arden (the hidden Levels guardian) ---
  ardenObserve: () => ipcRenderer.invoke('cortex:ardenObserve'),
  ardenLog: () => ipcRenderer.invoke('cortex:ardenLog'),
  ardenSeen: () => ipcRenderer.invoke('cortex:ardenSeen'),

  // --- mutations (explicit, confirmed, reversible) ---
  send: (payload) => ipcRenderer.invoke('cortex:send', payload),         // chat / task / steer / goal
  setModel: (payload) => ipcRenderer.invoke('cortex:setModel', payload), // change live model pin (backed up)
  saveSettings: (payload) => ipcRenderer.invoke('cortex:saveSettings', payload),
  reflect: (kind) => ipcRenderer.invoke('cortex:reflect', kind),         // ask Cortex to self-improve
  davaraNextMoves: (reason) => ipcRenderer.invoke('cortex:davaraNextMoves', reason), // Davara → highest-leverage next moves
  vaultStats: () => ipcRenderer.invoke('cortex:vaultStats'),             // app vault size + cleanup recommendation

  // --- v2.0: fleet config (per-agent model + quality) & the runner bridge ---
  fleet: () => ipcRenderer.invoke('cortex:fleet'),
  setAgentConfig: (p) => ipcRenderer.invoke('cortex:setAgentConfig', p),
  bridge: (action) => ipcRenderer.invoke('cortex:bridge', { action }),

  // --- v2.0: control plane (stop / resume / per-agent pause) ---
  control: (patch) => ipcRenderer.invoke('cortex:control', patch),
  pauseAgent: (p) => ipcRenderer.invoke('cortex:pauseAgent', p),

  // --- v2.0: subagents ---
  subagents: (agent) => ipcRenderer.invoke('cortex:subagents', { agent }),
  spawnSubagents: (p) => ipcRenderer.invoke('cortex:spawnSubagents', p),

  // --- v2.0: real token usage + August's own soft caps ---
  usageReal: (force) => ipcRenderer.invoke('cortex:usageReal', { force }),
  setBudget: (p) => ipcRenderer.invoke('cortex:setBudget', p),

  // --- v2.0: the task board ---
  board: () => ipcRenderer.invoke('cortex:board'),
  taskCreate: (p) => ipcRenderer.invoke('cortex:taskCreate', p),
  taskUpdate: (id, patch) => ipcRenderer.invoke('cortex:taskUpdate', { id, patch }),
  taskDelete: (id) => ipcRenderer.invoke('cortex:taskDelete', { id }),
  taskDispatch: (id, extra) => ipcRenderer.invoke('cortex:taskDispatch', { id, extra }),

  // --- v2.0: workflows / MotusModels ---
  workflows: () => ipcRenderer.invoke('cortex:workflows'),
  workflowSave: (def) => ipcRenderer.invoke('cortex:workflowSave', def),
  workflowDelete: (id) => ipcRenderer.invoke('cortex:workflowDelete', { id }),
  workflowRun: (id, seed) => ipcRenderer.invoke('cortex:workflowRun', { id, seed }),
  workflowResume: (runId) => ipcRenderer.invoke('cortex:workflowResume', { runId }),
  workflowEstimate: (id, seed) => ipcRenderer.invoke('cortex:workflowEstimate', { id, seed }),

  // --- v2.0: Duo-Drive autonomous mode ---
  duo: (patch) => ipcRenderer.invoke('cortex:duo', patch),
  duoPass: () => ipcRenderer.invoke('cortex:duoPass'),

  // --- v3: Leverage Loops · project registry · design ethos · work ledger ---
  loops: () => ipcRenderer.invoke('cortex:loops'),
  loopSave: (def) => ipcRenderer.invoke('cortex:loopSave', def),
  loopAct: (id, action) => ipcRenderer.invoke('cortex:loopAct', { id, action }),
  loopRun: (id) => ipcRenderer.invoke('cortex:loopRun', { id }),
  loopInvent: () => ipcRenderer.invoke('cortex:loopInvent'),
  projectSave: (def) => ipcRenderer.invoke('cortex:projectSave', def),
  projectAct: (id, action) => ipcRenderer.invoke('cortex:projectAct', { id, action }),
  saveEthos: (ethos) => ipcRenderer.invoke('cortex:saveEthos', { ethos }),
  duoWork: (f) => ipcRenderer.invoke('cortex:duoWork', f || {}),

  // --- DASH-OPS voice (the key itself never crosses this bridge) ---
  voice: () => ipcRenderer.invoke('cortex:voice'),
  voiceSave: (patch) => ipcRenderer.invoke('cortex:voiceSave', patch),
  voiceList: () => ipcRenderer.invoke('cortex:voiceList'),
  speak: (text, voiceId) => ipcRenderer.invoke('cortex:speak', { text, voiceId }),
  voiceTurn: (p) => ipcRenderer.invoke('cortex:voiceTurn', p),
  transcribe: (audio, mime) => ipcRenderer.invoke('cortex:transcribe', { audio, mime }),
  approveAction: (action) => ipcRenderer.invoke('cortex:approveAction', { action }),
  appReport: (deep) => ipcRenderer.invoke('cortex:appReport', { deep }),
  systemInsight: (question, agent) => ipcRenderer.invoke('cortex:systemInsight', { question, agent }),

  // --- OMNIDRIVE · MOTUS MAX MODE ---
  // Arming is a separate, explicit channel from starting a session on purpose:
  // the interface can never conflate "she may act" with "she is acting".
  omni: () => ipcRenderer.invoke('cortex:omni'),
  omniArm: (p) => ipcRenderer.invoke('cortex:omniArm', p),
  omniDisarm: () => ipcRenderer.invoke('cortex:omniDisarm'),
  omniStart: (p) => ipcRenderer.invoke('cortex:omniStart', p),
  omniFlow: (p) => ipcRenderer.invoke('cortex:omniFlow', p),
  omniStop: () => ipcRenderer.invoke('cortex:omniStop'),
  omniReply: (text, approve) => ipcRenderer.invoke('cortex:omniReply', { text, approve }),
  omniSteer: (text) => ipcRenderer.invoke('cortex:omniSteer', { text }),
  onOmniVoice: (cb) => ipcRenderer.on('cortex:omniVoice', (_e, d) => cb(d)),
  omniFrame: () => ipcRenderer.invoke('cortex:omniFrame'),
  omniSight: () => ipcRenderer.invoke('cortex:omniSight'),
  omniReplay: (id) => ipcRenderer.invoke('cortex:omniReplay', { id }),
  omniReplayFrame: (file) => ipcRenderer.invoke('cortex:omniReplayFrame', { file }),
  autoWork: (p) => ipcRenderer.invoke('cortex:autoWork', p || {}),
  onAutoWork: (cb) => ipcRenderer.on('cortex:autoWork', (_e, d) => cb(d)),
  omniPreview: (on, display) => ipcRenderer.invoke('cortex:omniPreview', { on, display }),
  omniClearLog: () => ipcRenderer.invoke('cortex:omniClearLog'),
  updateCheck: () => ipcRenderer.invoke('cortex:updateCheck'),
  updateApply: () => ipcRenderer.invoke('cortex:updateApply'),

  // --- ON AIR · the Semble LIVE broadcast (selection-only, doubly scrubbed) ---
  onAir: () => ipcRenderer.invoke('cortex:onAir'),
  onAirSet: (p) => ipcRenderer.invoke('cortex:onAirSet', p),
  onAirAuto: () => ipcRenderer.invoke('cortex:onAirAuto'),
  onAirSay: (text) => ipcRenderer.invoke('cortex:onAirSay', { text }),
  compute: () => ipcRenderer.invoke('cortex:compute'),
  computeClear: () => ipcRenderer.invoke('cortex:computeClear'),
  work: () => ipcRenderer.invoke('cortex:work'),
  receipts: () => ipcRenderer.invoke('cortex:receipts'),
  workEnqueue: (body) => ipcRenderer.invoke('cortex:workEnqueue', body),
  workClear: () => ipcRenderer.invoke('cortex:workClear'),
  payouts: () => ipcRenderer.invoke('cortex:payouts'),
  payoutOp: (body) => ipcRenderer.invoke('cortex:payoutOp', body),
  golem: () => ipcRenderer.invoke('cortex:golem'),
  onAirPush: () => ipcRenderer.invoke('cortex:onAirPush'),
  onAirVerify: () => ipcRenderer.invoke('cortex:onAirVerify'),
  onAirDiscover: () => ipcRenderer.invoke('cortex:onAirDiscover'),
  onAirEnforce: () => ipcRenderer.invoke('cortex:onAirEnforce'),
  onAirDrift: () => ipcRenderer.invoke('cortex:onAirDrift'),
  computePledge: (p) => ipcRenderer.invoke('cortex:computePledge', p || {}),
  computeClaimNode: (id) => ipcRenderer.invoke('cortex:computeClaimNode', { id }),
  ipcPerf: () => ipcRenderer.invoke('cortex:ipcPerf'),
  autoWorkWhy: () => ipcRenderer.invoke('cortex:autoWorkWhy'),
  dynamics: () => ipcRenderer.invoke('cortex:dynamics'),
  taskSweep: (p) => ipcRenderer.invoke('cortex:taskSweep', p || {}),
  duoNextAct: (id, action) => ipcRenderer.invoke('cortex:duoNextAct', { id, action }),
  omniPreRead: (agent) => ipcRenderer.invoke('cortex:omniPreRead', { agent }),
  // --- the second stack + the studio + her mind ---
  openai: () => ipcRenderer.invoke('cortex:openai'),
  openaiSave: (p) => ipcRenderer.invoke('cortex:openaiSave', p || {}),
  openaiModels: () => ipcRenderer.invoke('cortex:openaiModels'),
  imageGen: (p) => ipcRenderer.invoke('cortex:imageGen', p || {}),
  studio: () => ipcRenderer.invoke('cortex:studio'),
  studioDelete: (id) => ipcRenderer.invoke('cortex:studioDelete', { id }),
  mind: () => ipcRenderer.invoke('cortex:mind'),
  reading: () => ipcRenderer.invoke('cortex:reading'),
  close: () => ipcRenderer.invoke('cortex:close'),
  closeAct: (id, action) => ipcRenderer.invoke('cortex:closeAct', { id, action }),
  omniHandsWhy: () => ipcRenderer.invoke('cortex:omniHandsWhy'),
  pttKey: () => ipcRenderer.invoke('cortex:pttKey'),
  onPTT: (cb) => ipcRenderer.on('cortex:ptt', () => cb()),
  onAirChat: () => ipcRenderer.invoke('cortex:onAirChat'),
  onAirChatDel: (p) => ipcRenderer.invoke('cortex:onAirChatDel', p),

  // --- THE MAP · STRATEGY · DIVERGENCE · CONTINUITY ---
  // The map is read live off the BuildMode canon, so the app never holds a
  // second copy of the truth — it holds a window onto the one copy.
  map: (zoom, focus) => ipcRenderer.invoke('cortex:map', { zoom, focus }),
  strategicRead: (p) => ipcRenderer.invoke('cortex:strategicRead', p || {}),
  frames: (p) => ipcRenderer.invoke('cortex:frames', p || {}),
  strategy: () => ipcRenderer.invoke('cortex:strategy'),
  threadClear: () => ipcRenderer.invoke('cortex:threadClear'),

  // --- MOTUSMODELS STUDIO ---
  motusModels: () => ipcRenderer.invoke('cortex:motusModels'),
  mmSave: (def) => ipcRenderer.invoke('cortex:mmSave', def),
  mmDelete: (id) => ipcRenderer.invoke('cortex:mmDelete', { id }),
  mmRatify: (id) => ipcRenderer.invoke('cortex:mmRatify', { id }),
  mmEvolve: (id, axis, direction) => ipcRenderer.invoke('cortex:mmEvolve', { id, axis, direction }),
  mmJudge: (id) => ipcRenderer.invoke('cortex:mmJudge', { id }),
  mmMint: (id) => ipcRenderer.invoke('cortex:mmMint', { id }),
  mmBroadcast: (id) => ipcRenderer.invoke('cortex:mmBroadcast', { id }),
  mmRun: (id, seed) => ipcRenderer.invoke('cortex:mmRun', { id, seed }),

  // --- v2.0: the external (OpenRouter) lane ---
  sympathSei: () => ipcRenderer.invoke('cortex:sympathSei'),

  // --- live event stream (main → renderer) ---
  onPulse: (cb) => ipcRenderer.on('cortex:pulse', (_e, data) => cb(data)),
  onWorkflowProgress: (cb) => ipcRenderer.on('cortex:workflowProgress', (_e, data) => cb(data)),
  onDuoPass: (cb) => ipcRenderer.on('cortex:duoPass', (_e, data) => cb(data)),
  onDuoSpeak: (cb) => ipcRenderer.on('cortex:duoSpeak', (_e, data) => cb(data)),
  onSendProgress: (cb) => ipcRenderer.on('cortex:sendProgress', (_e, data) => cb(data)),
  onNotify: (cb) => ipcRenderer.on('cortex:notify', (_e, data) => cb(data)),
  onNavigate: (cb) => ipcRenderer.on('cortex:navigate', (_e, view) => cb(view)),
  onLiveEvent: (cb) => ipcRenderer.on('cortex:liveEvent', (_e, data) => cb(data)),
  onOmni: (cb) => ipcRenderer.on('cortex:omni', (_e, data) => cb(data)),

  // --- frameless window controls ---
  win: {
    min: () => ipcRenderer.invoke('win:min'),
    max: () => ipcRenderer.invoke('win:max'),
    close: () => ipcRenderer.invoke('win:close'),
  },

  // --- view: true frame zoom, so "make it smaller" scales every pixel
  //     proportionally instead of re-flowing a layout. Clamped here rather
  //     than in the renderer: the bridge is the boundary that must hold. ---
  ui: {
    setZoom: (f) => {
      const z = Math.max(0.4, Math.min(2, Number(f) || 1));
      webFrame.setZoomFactor(z);
      return z;
    },
    getZoom: () => webFrame.getZoomFactor(),
  },
});
