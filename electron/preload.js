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

  // Путь перетащенного в окно файла. В современных Electron у File больше нет
  // свойства .path — путь отдаёт только webUtils, и только из preload.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  pickVideoFile: () => ipcRenderer.invoke('dialog:pick-video'),
  openCropWindowFor: (filePath) => ipcRenderer.send('crop:open-for', filePath),
  // Пустое окно обрезки — оттуда настраиваются свои области кадра
  openCropWindow: () => ipcRenderer.send('crop:open'),
  // Разметка областей — отдельное окно: там у кадра своя задача и свой размер
  openAreas: () => ipcRenderer.send('areas:open'),
  getAreasClip: () => ipcRenderer.invoke('areas:clip'),
  openHelp: () => ipcRenderer.send('help:open'),
  openSetup: () => ipcRenderer.send('setup:open'),
  openSettings: () => ipcRenderer.send('settings:open'),
  openMain: () => ipcRenderer.send('window:open-main'),
  getInitialTab: () => ipcRenderer.invoke('main:initial-tab'),
  onShowTab: (listener) => {
    const handler = (_event, tab) => listener(tab)
    ipcRenderer.on('main:show-tab', handler)
    return () => ipcRenderer.off('main:show-tab', handler)
  },
  restartWatching: () => ipcRenderer.invoke('app:restart'),

  getAppVersion: () => ipcRenderer.invoke('app:version'),

  // Главное окно: состояние слежения и то, что из него можно сделать
  getStatus: () => ipcRenderer.invoke('status:get'),
  onStatusChanged: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('status:changed', handler)
    return () => ipcRenderer.off('status:changed', handler)
  },
  saveReplay: (durationSec) => ipcRenderer.invoke('replay:save', durationSec),
  openFolderPath: (dirPath) => ipcRenderer.send('folder:open', dirPath),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  onUpdateProgress: (listener) => {
    const handler = (_event, progress) => listener(progress)
    ipcRenderer.on('updates:progress', handler)
    return () => ipcRenderer.off('updates:progress', handler)
  },

  // Помощник первой настройки проверяет то, что ввели, ещё до сохранения:
  // иначе "почему не работает" выясняется молча и сильно позже.
  checkObs: (url, password) => ipcRenderer.invoke('setup:check-obs', url, password),
  checkTerminal: (terminalType) => ipcRenderer.invoke('setup:check-terminal', terminalType),
  // Короткий повтор ради кадра: на первом запуске клипов ещё нет, а настроить
  // области можно только по картинке. Открывает окно обрезки с этим файлом.
  saveSetupReplay: () => ipcRenderer.invoke('setup:save-replay'),
  openLogsFolder: () => ipcRenderer.send('logs:open'),
  pickFolder: (currentPath) => ipcRenderer.invoke('dialog:pick-folder', currentPath),

  // Границы панелей терминала, найденные по кадру клипа
  detectPanels: (clipPath, timeSec) => ipcRenderer.invoke('panels:detect', clipPath, timeSec),

  // Кадры из клипа для полоски под дорожкой обрезки
  buildFilmstrip: (clipPath, durationSec) => ipcRenderer.invoke('filmstrip:build', clipPath, durationSec),

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
