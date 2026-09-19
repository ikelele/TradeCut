// Снимки окон приложения — для проверки внешнего вида глазами.
// Открывает каждое окно в его настоящем размере, подставляет правдоподобные
// данные и сохраняет PNG рядом, в test-assets/screens.
// Запуск: npx electron scripts/window-screenshots.js

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, ipcMain } = require('electron')

const { initAppPaths } = require('../electron/paths')

const RENDERER_DIR = path.join(__dirname, '..', 'electron', 'renderer')
const PRELOAD_PATH = path.join(__dirname, '..', 'electron', 'preload.js')
const OUT_DIR = path.join(__dirname, '..', 'test-assets', 'screens')
const SAMPLE_CLIP = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')

// Правдоподобные данные: пустые списки и нули не показывают, как окно
// выглядит в реальной работе.
const PRESETS = [
  { name: 'Стакан 1', x: 0, y: 81, width: 570, height: 1359, sourceWidth: 3440, sourceHeight: 1440 },
  { name: 'Стакан 2', x: 570, y: 81, width: 570, height: 1359, sourceWidth: 3440, sourceHeight: 1440 },
  { name: 'Стакан 3', x: 1140, y: 81, width: 573, height: 1359, sourceWidth: 3440, sourceHeight: 1440 }
]

const TRADES = [
  { label: 'DEEPUSDT SHORT 09-18 12:38 47s', clipPath: 'C:\\Trades\\2026-09-18\\DEEPUSDT SHORT Binance 2026-09-18 12-38-23.mp4' },
  { label: 'UBUSDT COMBO 09-18 12:15 214s', clipPath: 'C:\\Trades\\2026-09-18\\UBUSDT COMBOx3 Binance 2026-09-18 12-15-02.mp4' },
  { label: '龙虾USDT LONG 09-18 11:11 63s', clipPath: 'C:\\Trades\\2026-09-18\\龙虾USDT LONG Binance 2026-09-18 11-11-52.mp4' }
]

async function shoot(page, { width, height }, prepare) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: '#1e1e22',
    webPreferences: { preload: PRELOAD_PATH, contextIsolation: true, nodeIntegration: false, sandbox: false }
  })

  const errors = []
  win.webContents.on('console-message', (event) => {
    const level = typeof event === 'object' && event !== null ? event.level : ''
    const message = typeof event === 'object' && event !== null ? event.message : ''
    if (level === 'error' || level === 3) errors.push(message)
  })

  await win.loadFile(path.join(RENDERER_DIR, page))
  await new Promise((resolve) => setTimeout(resolve, 800))
  if (prepare) {
    await win.webContents.executeJavaScript(prepare)
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }

  const image = await win.webContents.capturePage()
  const file = path.join(OUT_DIR, page.replace('.html', '') + (prepare ? '-2' : '') + '.png')
  fs.writeFileSync(file, image.toPNG())
  console.log(`${page}${prepare ? ' (после действий)' : ''} -> ${path.basename(file)}${errors.length ? '  ОШИБКИ: ' + errors.join(' | ') : ''}`)
  win.hide() // не destroy: он ломает загрузку следующего окна
}

app.whenReady().then(async () => {
  initAppPaths()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const { loadConfig } = require('../src/config')
  const config = loadConfig()
  config.clip.cropPresets = PRESETS

  ipcMain.handle('config:get', () => config)
  ipcMain.handle('trades:list', () => TRADES)
  ipcMain.handle('crop:dropped-file', () => null)
  ipcMain.handle('dialog:pick-video', () => SAMPLE_CLIP)
  ipcMain.handle('crop-presets:list', () => PRESETS)
  ipcMain.handle('crop-presets:save', (_e, incoming) => (Array.isArray(incoming) ? incoming : [incoming]))
  ipcMain.handle('crop-presets:delete', () => PRESETS)
  ipcMain.handle('panels:detect', () => ({
    vertical: [0, 100, 200], horizontal: [30], variants: [[0, 100, 200]], width: 320, height: 240
  }))
  ipcMain.handle('config:save', (_e, incoming) => incoming)
  ipcMain.handle('crop:guided', () => true)
  ipcMain.handle('setup:check-obs', () => ({ connected: true, replayBufferActive: true }))
  ipcMain.handle('setup:check-terminal', () => ({
    terminalName: 'TigerTrade',
    logsDir: 'C:\\Users\\Trader\\AppData\\Roaming\\TigerTrade\\Data\\Logs',
    files: ['WorkLog_20260918.log', 'WorkLog_20260917.log'],
    lastWriteMs: Date.now()
  }))
  ipcMain.handle('setup:save-replay', () => ({ clipPath: 'C:\\Trades\\replays\\повтор.mp4' }))

  ipcMain.handle('app:version', () => ({ version: '1.5.1', installKind: 'installed' }))
  ipcMain.handle('updates:check', () => ({ state: 'none', current: '1.5.1' }))
  ipcMain.handle('status:get', () => ({
    state: 'ok',
    paused: false,
    obsPasswordSet: true,
    terminal: 'vataga',
    obsUrl: 'ws://127.0.0.1:4455',
    clipsDir: 'C:/Users/Trader/Videos/TradeCut/clips',
    areasCount: 6,
    autoCropDetect: true,
    autoCropArea: 'стакан 4',
    version: '1.5.1'
  }))
  ipcMain.handle('replay:save', () => ({ clipPath: 'C:/Trades/replays/повтор.mp4' }))
  ipcMain.on('folder:open', () => {})
  ipcMain.on('window:open-main', () => {})

  await shoot('main.html', { width: 760, height: 620 })
  await shoot('settings.html', { width: 700, height: 720 })
  await shoot('setup.html', { width: 660, height: 700 })

  // Помощник после проверки OBS — тот вид, ради которого он и сделан
  await shoot('setup.html', { width: 660, height: 700 }, `
    new Promise((resolve) => {
      document.getElementById('check-obs').click()
      setTimeout(resolve, 400)
    })
  `)
  await shoot('help.html', { width: 680, height: 720 })
  await shoot('crop.html', { width: 620, height: 700 })

  // Окно обрезки с открытым превью — основной рабочий вид
  await shoot('crop.html', { width: 1100, height: 900 }, `
    new Promise((resolve) => {
      document.getElementById('pick').click()
      setTimeout(() => {
        document.querySelector('[data-role="pick-visually"]').click()
        setTimeout(resolve, 900)
      }, 300)
    })
  `)

  console.log('\nСнимки в ' + OUT_DIR)
  app.exit(0)
}).catch((error) => {
  console.error('Не удалось снять окна:', error)
  app.exit(1)
})
