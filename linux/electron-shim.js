// ============================================================================
//  electron-shim.js — what stands where Electron stands, on a box with no screen.
//
//  THE POINT OF THIS FILE, stated plainly, because it is the whole design:
//  the console's engine room is main.js, and main.js does not actually need a
//  screen. It reads the fleet tree, talks to the relay, keeps the board, runs
//  the loops and answers 160-odd IPC channels. The only thing tying it to a
//  desktop is that it asks Electron for a window, a tray and a keyring.
//
//  So we give it those, made of nothing, and run the very same file. Not a
//  port, not a second implementation that drifts: ONE main.js, on Windows, on
//  macOS, and here. Every feature the desktop app has arrives on the server the
//  day it is written, because it is the same code answering.
//
//  What is genuinely absent is named honestly rather than faked:
//    · the screen instruments (Motus Max drives in work mode, and says so)
//    · the tray, the window chrome, global hotkeys
//    · the renderer — nothing draws, so every push that would have gone to a
//      window is routed to the event bus instead, which is what lets the
//      terminal show a live feed.
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { makeSafeStorage } = require('./seal');

const APP_ROOT = path.resolve(__dirname, '..');

// Where a Linux desktop keeps a user's application state. Electron resolves
// userData to ~/.config/<name> from package.json's name; we do the same so a
// vault written by the windowed build and one written here are the same vault.
function xdgConfig() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')); }
  catch { return { name: 'cortexinsight', version: '0.0.0' }; }
})();

const USER_DATA = process.env.CORTEX_USER_DATA || path.join(xdgConfig(), pkg.name || 'cortexinsight');

// ---------------------------------------------------------------------------
//  The event bus: everything main.js would have sent to a window.
// ---------------------------------------------------------------------------
const bus = new EventEmitter();
bus.setMaxListeners(0);

// ---------------------------------------------------------------------------
//  app
// ---------------------------------------------------------------------------
const paths = {
  userData: USER_DATA,
  appData: xdgConfig(),
  home: os.homedir(),
  temp: os.tmpdir(),
  downloads: path.join(os.homedir(), 'Downloads'),
  documents: path.join(os.homedir(), 'Documents'),
  desktop: path.join(os.homedir(), 'Desktop'),
  logs: path.join(USER_DATA, 'logs'),
  exe: process.execPath,
  module: process.execPath,
};

const app = new EventEmitter();
app.setMaxListeners(0);
let _readyResolve;
const _ready = new Promise((r) => { _readyResolve = r; });

Object.assign(app, {
  isPackaged: false,
  isQuitting: false,
  getName: () => pkg.name,
  getVersion: () => pkg.version,
  getAppPath: () => APP_ROOT,
  getPath: (n) => {
    if (!paths[n]) throw new Error('unknown path: ' + n);
    return paths[n];
  },
  setPath: (n, p) => { paths[n] = p; },
  getLocale: () => process.env.LANG || 'en-US',
  whenReady: () => _ready,
  focus: () => {},
  hide: () => {},
  show: () => {},
  setAppUserModelId: () => {},
  disableHardwareAcceleration: () => {},
  setLoginItemSettings: () => {},
  getLoginItemSettings: () => ({ openAtLogin: false }),
  commandLine: { appendSwitch: () => {}, appendArgument: () => {}, hasSwitch: () => false, getSwitchValue: () => '' },
  // A second daemon writing the same vault is the bug that once wiped a focus
  // (v1.6.1). The lock is a real file holding a pid: a stale one from a crashed
  // process is reclaimed, a live one is refused.
  requestSingleInstanceLock() {
    const f = path.join(USER_DATA, 'daemon.lock');
    try {
      fs.mkdirSync(USER_DATA, { recursive: true, mode: 0o700 });
      const prev = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
      if (prev && prev !== process.pid) {
        try { process.kill(prev, 0); return false; }   // it answers: it is alive
        catch { /* it is gone; the lock is ours */ }
      }
    } catch { /* no lock yet */ }
    try { fs.writeFileSync(f, String(process.pid), { mode: 0o600 }); } catch { /* not fatal */ }
    process.on('exit', () => { try { fs.unlinkSync(f); } catch {} });
    return true;
  },
  releaseSingleInstanceLock() {},
  quit() { app.isQuitting = true; app.emit('before-quit'); app.emit('will-quit'); process.exit(0); },
  exit(code) { process.exit(code || 0); },
  relaunch() {},
});

// ---------------------------------------------------------------------------
//  session — the handlers a page would need, with no page to need them
// ---------------------------------------------------------------------------
const fakeSession = {
  setPermissionRequestHandler: () => {},
  setPermissionCheckHandler: () => {},
  setSpellCheckerLanguages: () => {},
  addWordToSpellCheckerDictionary: () => true,
  clearCache: () => Promise.resolve(),
  clearStorageData: () => Promise.resolve(),
  webRequest: { onBeforeRequest: () => {}, onHeadersReceived: () => {} },
  setCertificateVerifyProc: () => {},
  cookies: { get: () => Promise.resolve([]) },
};
const session = { defaultSession: fakeSession, fromPartition: () => fakeSession };

// ---------------------------------------------------------------------------
//  BrowserWindow — a window-shaped hole. Everything main.js would have drawn
//  goes to the bus, which is how the terminal gets a live feed for free.
// ---------------------------------------------------------------------------
const _windows = [];

class WebContents extends EventEmitter {
  constructor(owner) {
    super();
    this.setMaxListeners(0);
    this._owner = owner;
    this.session = fakeSession;
    this.id = _windows.length + 1;
  }
  send(channel, payload) { bus.emit('push', { channel, payload }); }
  setWindowOpenHandler() {}
  setBackgroundThrottling() {}
  openDevTools() {}
  closeDevTools() {}
  reload() {}
  replaceMisspelling() {}
  isLoading() { return false; }
  getURL() { return ''; }
  focus() {}
  // No compositor, so there is no frame to hand back. Both of these are used
  // only by the visual harnesses and by the About probe, and every caller
  // already copes with nothing coming back.
  executeJavaScript() { return Promise.resolve(null); }
  capturePage() { return Promise.reject(new Error('there is no screen on this host to capture')); }
  print() {}
  insertCSS() { return Promise.resolve(''); }
}

class BrowserWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.setMaxListeners(0);
    this._opts = opts;
    this._destroyed = false;
    this._visible = false;
    this._bounds = { x: 0, y: 0, width: opts.width || 1320, height: opts.height || 860 };
    this.webContents = new WebContents(this);
    this.id = _windows.length + 1;
    _windows.push(this);
  }
  static getAllWindows() { return _windows.filter((w) => !w._destroyed); }
  static fromWebContents(wc) { return wc && wc._owner ? wc._owner : null; }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  show() { this._visible = true; }
  showInactive() { this._visible = true; }
  hide() { this._visible = false; }
  focus() {}
  blur() {}
  minimize() {}
  maximize() {}
  unmaximize() {}
  restore() {}
  isMaximized() { return false; }
  isMinimized() { return false; }
  isVisible() { return this._visible; }
  isDestroyed() { return this._destroyed; }
  isFocused() { return false; }
  setBounds(b) { Object.assign(this._bounds, b || {}); }
  getBounds() { return { ...this._bounds }; }
  setSize(w, h) { this._bounds.width = w; this._bounds.height = h; }
  setMinimumSize() {}
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  setSkipTaskbar() {}
  setOpacity() {}
  setVisibleOnAllWorkspaces() {}
  close() { this.emit('close', { preventDefault: () => {} }); this.destroy(); }
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.emit('closed');
    if (BrowserWindow.getAllWindows().length === 0) app.emit('window-all-closed');
  }
}

// ---------------------------------------------------------------------------
//  ipcMain — the registry IS the product. Every handler main.js registers here
//  is what the control socket, and therefore the terminal, can reach.
// ---------------------------------------------------------------------------
const handlers = new Map();
const ipcMain = new EventEmitter();
ipcMain.setMaxListeners(0);
ipcMain.handle = (channel, fn) => { handlers.set(channel, fn); };
ipcMain.handleOnce = (channel, fn) => {
  handlers.set(channel, (...a) => { handlers.delete(channel); return fn(...a); });
};
ipcMain.removeHandler = (channel) => { handlers.delete(channel); };

// ---------------------------------------------------------------------------
//  The rest: present, honest, and doing nothing.
// ---------------------------------------------------------------------------
const notifications = [];
class Notification extends EventEmitter {
  constructor(opts = {}) { super(); this.opts = opts; }
  static isSupported() { return false; }
  show() {
    notifications.push({ ts: new Date().toISOString(), title: this.opts.title || '', body: this.opts.body || '' });
    if (notifications.length > 200) notifications.shift();
    bus.emit('push', { channel: 'host:notify', payload: { title: this.opts.title || '', body: this.opts.body || '' } });
  }
  close() {}
}

class Tray extends EventEmitter {
  constructor() { super(); }
  setToolTip() {} setContextMenu() {} setImage() {} setTitle() {} destroy() {} popUpContextMenu() {}
}

const Menu = {
  buildFromTemplate: (t) => ({ popup: () => {}, closePopup: () => {}, items: t || [] }),
  setApplicationMenu: () => {},
  getApplicationMenu: () => null,
};

const shell = {
  openExternal: (url) => {
    // xdg-open is usually absent on a server. Opening nothing is the correct
    // outcome there, so this never throws and never blocks a turn.
    try { spawn('xdg-open', [String(url)], { detached: true, stdio: 'ignore' }).unref(); } catch { /* headless */ }
    return Promise.resolve();
  },
  openPath: (p) => { try { spawn('xdg-open', [String(p)], { detached: true, stdio: 'ignore' }).unref(); } catch {} return Promise.resolve(''); },
  showItemInFolder: () => {},
  beep: () => {},
  trashItem: () => Promise.resolve(),
};

const globalShortcut = {
  register: () => false,
  registerAll: () => {},
  unregister: () => {},
  unregisterAll: () => {},
  isRegistered: () => false,
};

const screen = {
  getAllDisplays: () => [],
  getPrimaryDisplay: () => ({ id: 0, bounds: { x: 0, y: 0, width: 0, height: 0 }, workArea: { x: 0, y: 0, width: 0, height: 0 }, scaleFactor: 1 }),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
  on: () => {},
};

const desktopCapturer = {
  getSources: () => Promise.reject(new Error('there is no screen on this host to capture')),
};

const nativeImage = {
  createEmpty: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), resize: () => nativeImage.createEmpty() }),
  createFromPath: () => nativeImage.createEmpty(),
  createFromBuffer: () => nativeImage.createEmpty(),
  createFromDataURL: () => nativeImage.createEmpty(),
};

const clipboard = {
  _t: '',
  writeText(t) { this._t = String(t); },
  readText() { return this._t; },
  clear() { this._t = ''; },
};

const dialog = {
  showMessageBox: () => Promise.resolve({ response: 0 }),
  showMessageBoxSync: () => 0,
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
  showErrorBox: () => {},
};

const powerMonitor = new EventEmitter();
powerMonitor.getSystemIdleTime = () => 0;
powerMonitor.getSystemIdleState = () => 'active';

const nativeTheme = new EventEmitter();
nativeTheme.shouldUseDarkColors = true;

const safeStorage = makeSafeStorage(USER_DATA);

const electron = {
  app, BrowserWindow, ipcMain, Notification, shell, Tray, Menu, safeStorage,
  session, globalShortcut, screen, desktopCapturer, nativeImage, clipboard,
  dialog, powerMonitor, nativeTheme,
  contextBridge: { exposeInMainWorld: () => {} },
  ipcRenderer: { invoke: () => Promise.resolve(null), on: () => {}, send: () => {} },
  webFrame: { setZoomFactor: () => {}, getZoomFactor: () => 1 },
};

// Hand the running process what it needs to drive all of this.
electron.__host = {
  bus,
  handlers,
  notifications,
  userData: USER_DATA,
  appRoot: APP_ROOT,
  version: pkg.version,
  markReady: () => _readyResolve(),
  windows: _windows,
};

module.exports = electron;
