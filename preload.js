const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const EVENTS = ['scan:progress', 'win:state'];

contextBridge.exposeInMainWorld('api', {
  minimize: () => invoke('win:minimize'),
  maximize: () => invoke('win:maximize'),
  close: () => invoke('win:close'),
  setTheme: (pref) => invoke('theme:set', pref),
  openExternal: (url) => invoke('open:external', url),

  status: () => invoke('auth:status'),
  login: () => invoke('auth:login'),
  logout: () => invoke('auth:logout'),

  load: (key) => invoke('data:load', key),
  setKept: (key, id, on) => invoke('data:whitelist', key, id, on),
  clearHistory: (key) => invoke('data:clearHistory', key),
  exportFile: (filename, content) => invoke('data:export', { filename, content }),
  importDownload: () => invoke('data:import'),
  exportBackup: () => invoke('backup:export'),
  importBackup: () => invoke('backup:import'),
  openDataFolder: () => invoke('data:openFolder'),
  deleteScan: (key, ts) => invoke('data:deleteScan', key, ts),
  trimScans: (key, keep) => invoke('data:trim', key, keep),
  deleteAccount: (key) => invoke('data:deleteAccount', key),
  clearPictures: () => invoke('avatars:clear'),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  usage: () => invoke('usage:get'),
  appInfo: () => invoke('app:info'),
  checkUpdate: () => invoke('app:checkUpdate'),

  scan: () => invoke('ig:scan'),
  cancelScan: () => invoke('ig:cancel'),
  friendship: (key, userId, kind) => invoke('ig:friendship', key, userId, kind),

  on: (ch, fn) => {
    if (!EVENTS.includes(ch)) return () => {};
    const h = (_e, d) => fn(d);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
});
