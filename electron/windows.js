const path = require('path')
const { BrowserWindow } = require('electron')
const { getAssetPath } = require('./paths')

const PRELOAD_PATH = path.join(__dirname, 'preload.js')
const RENDERER_DIR = path.join(__dirname, 'renderer')

// Сколько ждать загрузки страницы, прежде чем вмешаться (см. createWindow).
const SHOW_FALLBACK_MS = 4000
// Сколько раз перезагрузить застрявшую страницу, прежде чем показать как есть.
const MAX_RELOAD_ATTEMPTS = 2

let log = () => {}
function setWindowsLogger(logger) {
  log = logger || (() => {})
}

function baseWindowOptions({ width, height }) {
  return {
    width,
    height,
    minWidth: 520,
    minHeight: 360,
    show: false, // показываем только по ready-to-show, чтобы не мигать пустым окном
    backgroundColor: '#1e1e22',
    icon: getAssetPath('app-icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  }
}

// Окна создаются скрытыми и показываются по ready-to-show, чтобы не мигать
// пустой рамкой. Но полагаться ТОЛЬКО на это событие нельзя: иногда оно не
// приходит вовсе, и окно навсегда остаётся созданным, но невидимым. Для окон,
// которые существуют в одном экземпляре (настройки, список сделок), это
// выглядело так, будто меню в трее перестало работать: ссылка на невидимое
// окно жива, поэтому следующий клик просто "поднимал" его — и не показывал
// ничего до перезапуска приложения.
// Поэтому показываем по первому из трёх поводов: ready-to-show, окончание
// загрузки страницы или просто таймаут.
function createWindow({ page, width, height, title }) {
  const win = new BrowserWindow({ ...baseWindowOptions({ width, height }), title })
  win.removeMenu()

  let shown = false
  let loaded = false
  let reloadsLeft = MAX_RELOAD_ATTEMPTS
  let fallbackTimer = null

  const showOnce = (reason) => {
    if (shown || win.isDestroyed()) return
    shown = true
    // Окно могло остаться свёрнутым с прошлого раза — иначе show() покажет его
    // в панели задач, но на экране ничего не появится.
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (reason !== 'ready-to-show') log(`Окно ${page} показано по запасному поводу: ${reason}`)
  }

  // Если за отведённое время страница так и не загрузилась, показывать пустое
  // окно бессмысленно — сначала пробуем загрузить её заново. Так выглядит
  // застрявший рендерер: окно есть, рамка есть, а содержимого нет вообще.
  const onFallback = () => {
    if (win.isDestroyed()) return
    if (loaded) return showOnce('таймаут')

    if (reloadsLeft > 0) {
      reloadsLeft--
      log(`Окно ${page} не загрузилось за ${SHOW_FALLBACK_MS}мс — перезагружаю страницу (осталось попыток: ${reloadsLeft})`)
      win.webContents.reload()
      fallbackTimer = setTimeout(onFallback, SHOW_FALLBACK_MS)
      return
    }

    log(`Окно ${page} так и не загрузилось — показываю как есть`)
    showOnce('таймаут после перезагрузок')
  }

  fallbackTimer = setTimeout(onFallback, SHOW_FALLBACK_MS)

  const onLoaded = (reason) => {
    loaded = true
    if (fallbackTimer) clearTimeout(fallbackTimer)
    showOnce(reason)
  }

  win.once('ready-to-show', () => onLoaded('ready-to-show'))
  win.webContents.on('did-finish-load', () => onLoaded('did-finish-load'))
  win.webContents.on('did-fail-load', (_event, code, description) => {
    log(`Окно ${page} не загрузилось: ${description} (${code})`)
  })
  win.on('closed', () => {
    if (fallbackTimer) clearTimeout(fallbackTimer)
  })

  win.loadFile(path.join(RENDERER_DIR, page))
  return win
}

// Окно со списком всех сделок сессии. Держим ссылку на единственный экземпляр:
// повторный вызов из трея просто поднимает уже открытое окно, а не плодит копии.
let tradesWindow = null

// Поднимает уже открытое окно. Проверка isVisible обязательна: окно могло
// быть создано, но так и не показаться, и один только focus() его не покажет.
function raiseWindow(win) {
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  return win
}

function openTradesWindow() {
  if (tradesWindow && !tradesWindow.isDestroyed()) {
    return raiseWindow(tradesWindow)
  }
  tradesWindow = createWindow({
    page: 'trades.html',
    width: 760,
    height: 560,
    title: 'TradeCut — сделки'
  })
  tradesWindow.on('closed', () => { tradesWindow = null })
  return tradesWindow
}

function getTradesWindow() {
  return tradesWindow && !tradesWindow.isDestroyed() ? tradesWindow : null
}

// Окно ручной обрезки. Может открываться как с уже известным файлом (его
// перетащили на .exe), так и пустым — тогда файл выбирается в самом окне
// (перетаскиванием или кнопкой). Их может быть несколько одновременно.
function openCropWindow() {
  return createWindow({
    page: 'crop.html',
    width: 620,
    height: 700,
    title: 'TradeCut — обрезка клипа'
  })
}

// Окно "Как пользоваться" — справочное, тоже в одном экземпляре.
let helpWindow = null

function openHelpWindow() {
  if (helpWindow && !helpWindow.isDestroyed()) {
    return raiseWindow(helpWindow)
  }
  helpWindow = createWindow({
    page: 'help.html',
    width: 680,
    height: 720,
    title: 'TradeCut — как пользоваться'
  })
  helpWindow.on('closed', () => { helpWindow = null })
  return helpWindow
}

// Помощник первой настройки. Открывается сам один раз — когда config.json
// создан прямо при этом запуске, — и потом по кнопке из окна "?".
let setupWindow = null

function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    return raiseWindow(setupWindow)
  }
  setupWindow = createWindow({
    page: 'setup.html',
    width: 660,
    height: 700,
    title: 'TradeCut — первая настройка'
  })
  setupWindow.on('closed', () => { setupWindow = null })
  return setupWindow
}

// Окно настроек — единственное, как и окно сделок: незачем открывать две
// копии, которые будут перезаписывать config.json друг за другом.
let settingsWindow = null

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    return raiseWindow(settingsWindow)
  }
  settingsWindow = createWindow({
    page: 'settings.html',
    width: 700,
    height: 720,
    title: 'TradeCut — настройки'
  })
  settingsWindow.on('closed', () => { settingsWindow = null })
  return settingsWindow
}

module.exports = { setWindowsLogger, openTradesWindow, getTradesWindow, openCropWindow, openSettingsWindow, openHelpWindow, openSetupWindow }
