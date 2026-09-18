const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Единственный мост между окнами и основным процессом. Окна не имеют доступа
// к node-API напрямую (contextIsolation), поэтому всё, что им можно, описано
// здесь явным списком.
contextBridge.exposeInMainWorld('api', {
  getTrades: () => ipcRenderer.invoke('trades:list'),
  getDroppedFile: () => ipcRenderer.invoke('crop:dropped-file'),
  cropClip: (clipPath, options) => ipcRenderer.invoke('crop:run', clipPath, options),
  openFolder: (filePath) => ipcRenderer.invoke('shell:reveal', filePath),
  closeWindow: () => ipcRenderer.send('window:close'),
  // Развернуть окно на время превью клипа и вернуть обратно при закрытии
  setPreviewMode: (enabled) => ipcRenderer.send('window:preview-mode', enabled),

  // Путь перетащенного в окно файла. В современных Electron у File больше нет
  // свойства .path — путь отдаёт только webUtils, и только из preload.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  pickVideoFile: () => ipcRenderer.invoke('dialog:pick-video'),
  openCropWindowFor: (filePath) => ipcRenderer.send('crop:open-for', filePath),
  // Пустое окно обрезки — оттуда настраиваются свои области кадра
  openCropWindow: () => ipcRenderer.send('crop:open'),
  openHelp: () => ipcRenderer.send('help:open'),
  // Крестик окна при открытом превью: основной процесс просит закрыть превью
  // вместо самого окна.
  onPreviewDismiss: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('preview:dismiss', handler)
    return () => ipcRenderer.off('preview:dismiss', handler)
  },
  openLogsFolder: () => ipcRenderer.send('logs:open'),
  pickFolder: (currentPath) => ipcRenderer.invoke('dialog:pick-folder', currentPath),

  // Границы панелей терминала, найденные по кадру клипа
  detectPanels: (clipPath, timeSec) => ipcRenderer.invoke('panels:detect', clipPath, timeSec),

  // Области кадра, сохранённые под именем. Живут в config.json, но правятся не
  // в окне настроек, а в окне обрезки — там видно картинку.
  getCropPresets: () => ipcRenderer.invoke('crop-presets:list'),
  saveCropPreset: (preset) => ipcRenderer.invoke('crop-presets:save', preset),
  deleteCropPreset: (name) => ipcRenderer.invoke('crop-presets:delete', name),

  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  onTradesUpdated: (listener) => {
    const handler = (_event, trades) => listener(trades)
    ipcRenderer.on('trades:updated', handler)
    return () => ipcRenderer.off('trades:updated', handler)
  }
})
