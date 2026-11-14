const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  setTheme: (dark) => ipcRenderer.invoke('set-theme', dark),
  setLearnMode: (on) => ipcRenderer.invoke('set-learn-mode', on),
  setOpacity: (v) => ipcRenderer.invoke('set-opacity', v),
  listBoards: () => ipcRenderer.invoke('boards-list'),
  loadBoard: (id) => ipcRenderer.invoke('board-load', id),
  saveBoard: (id, json) => ipcRenderer.invoke('board-save', id, json),
  saveBoardSync: (id, json) => ipcRenderer.sendSync('board-save-sync', id, json),
  createBoard: (name) => ipcRenderer.invoke('board-create', name),
  renameBoard: (id, name) => ipcRenderer.invoke('board-rename', id, name),
  deleteBoard: (id) => ipcRenderer.invoke('board-delete', id),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  writeClipboard: (dataURL, marker) => ipcRenderer.invoke('write-clipboard', dataURL, marker),
  savePng: (dataURL) => ipcRenderer.invoke('save-png', dataURL),
  getVersion: () => ipcRenderer.invoke('app-version'),
});
