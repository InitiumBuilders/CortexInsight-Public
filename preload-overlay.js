// preload-overlay.js — the HUD's only channel.
//
// The overlay is a window laid over August's whole screen, so its surface area
// is exactly one function: receive state from main and draw it. It can send
// nothing back, reach nothing, and request nothing. A screen-covering window
// with an IPC surface would be a genuinely bad idea; this one has none.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  on: (cb) => ipcRenderer.on('hud', (_e, data) => cb(data)),
});
