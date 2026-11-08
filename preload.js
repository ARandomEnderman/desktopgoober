// The only bridge between the pet page and Electron. pet.js also runs without it (open pet.html in a browser):
// then it fakes a desktop inside the page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pet', {
  init: () => ipcRenderer.invoke('init'),
  move: (x, y) => ipcRenderer.send('move', x, y),
  ignore: (on) => ipcRenderer.send('ignore', on),
  cursorTo: (x, y) => ipcRenderer.send('cursorTo', x, y),
  save: (patch) => ipcRenderer.send('save', patch),
  menu: () => ipcRenderer.send('menu'),
  on: (ch, fn) => ipcRenderer.on(ch, (e, v) => fn(v)),
});
