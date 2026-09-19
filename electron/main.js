const fs = require('fs')
const path = require('path')
const { app, ipcMain, shell, dialog, screen, BrowserWindow } = require('electron')

const { initAppPaths, getInstallKind } = require('./paths')
const { createUpdater } = require('./updater')
const { createTray } = require('./tray')
const { createNotifier } = require('./notifier')
const autostart = require('./autostart')
const { setWindowsLogger, openMainWindow, getMainWindow, openAreasWindow, openCropWindow, openHelpWindow, openSetupWindow } = require('./windows')

const APP_USER_MODEL_ID = 'com.tradecut.app'

// Расширения, которые считаем "видео перетащили на .exe". Ограничиваем список
// осознанно: в argv может прилететь что угодно (ключи Electron, пути), а
// открывать окно обрезки имеет смысл только для настоящего видеофайла.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.flv', '.ts', '.webm', '.m4v'])

// Длина повтора, который помощник сохраняет ради одного кадра с терминалом.
// Короткий намеренно: он нужен как картинка для разметки областей, а не как
// запись, и лишние минуты тут только ждать дольше.
const SETUP_REPLAY_SEC = 15

function findVideoFileArg(argv) {
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue
    if (!VIDEO_EXTENSIONS.has(path.extname(arg).toLowerCase())) continue
    try {
      if (fs.statSync(arg).isFile()) return path.resolve(arg)
    } catch {
      // не файл/нет доступа — просто не наш аргумент
    }
  }
  return null
}

const initialFileArg = findVideoFileArg(process.argv)

// Отрисовка окон — без видеокарты.
//
// Симптом, из-за которого это появилось: при автозапуске вместе с Windows
// окно из меню трея открывалось ПУСТЫМ (даже статический заголовок страницы
// не появлялся) и только через запасной таймаут, а значок в трее оставался
// пустым местом. То есть рендерер не мог загрузить даже локальный файл.
// Похоже на застрявший процесс графики: при входе в систему видеодрайвер ещё
// поднимается, а портативная сборка в этот момент как раз распаковывает себя
// во временную папку, и её сканирует антивирус. Рендерер ждёт графику,
// которой нет, и не рисует ничего до перезапуска приложения.
//
// Наши окна — это простые формы, аппаратное ускорение им не нужно вообще,
// поэтому проще исключить графический процесс, чем ловить его состояние.
// Вызывать обязательно до готовности app.
app.disableHardwareAcceleration()

// Одна копия приложения на систему. Побочный полезный эффект: если основное
// приложение уже висит в трее, а пользователь перетащил файл на .exe — второй
// процесс не поднимает второй трей, а передаёт путь первому (см. second-instance).
if (!app.requestSingleInstanceLock({ fileArg: initialFileArg })) {
  app.quit()
} else {
  main()
}

function main() {
  app.setAppUserModelId(APP_USER_MODEL_ID)

  // Режим разовой обрезки: приложение запустили перетаскиванием файла, а не как
  // фоновый трей. Тогда ни OBS, ни слежения за логами — только окно обрезки.
  const cropOnlyMode = Boolean(initialFileArg)

  // clipPath для окон обрезки: webContents.id -> путь к файлу. Окно спрашивает
  // свой файл само (crop:dropped-file), т.к. одновременно может быть открыто
  // несколько окон с разными файлами.
  const cropWindowFiles = new Map()
  // Клип, с которым открыли окно разметки: помощник настройки только что
  // сохранил ради кадра повтор и передаёт его сюда.
  const areasWindowFiles = new Map()

  let logger = null
  let log = (message) => console.log(message)
  // Состояние слежения. Раньше жило внутри startTrayApp и было видно только
  // трею — теперь его спрашивает и главное окно, а оно открывается когда
  // угодно, в том числе до того, как трей успел что-то поменять.
  let restarting = false
  let paused = false
  let obsState = 'disconnected'
  let replayBufferActive = true // оптимистично, пока не проверили обратное
  let actionError = null
  let tray = null
  let notifier = null
  let appCore = null
  let updater = null
  let config = null

  // Одно место, где решается, в каком состоянии программа. Им пользуются и
  // значок в трее, и главное окно — иначе они разошлись бы во мнениях.
  // Наружу отдаётся только состояние, а словами его описывает тот, кто
  // показывает: в трее нужна короткая строка, в окне — человеческая.
  function currentStatus() {
    if (paused) return { state: 'paused' }
    if (actionError) return { state: 'error', text: actionError }
    if (obsState !== 'connected') return { state: 'warn' }
    return { state: replayBufferActive ? 'ok' : 'bufferOff' }
  }

  function statusForWindow() {
    const { resolveMediaPath } = require('../src/appPaths')
    return {
      ...currentStatus(),
      paused,
      terminal: config ? config.terminal.type : null,
      obsUrl: config ? config.obs.url : null,
      obsPasswordSet: Boolean(config && config.obs.password),
      clipsDir: config ? resolveMediaPath(config.clip.outputDir) : null,
      areasCount: config ? (config.clip.cropPresets || []).length : 0,
      autoCropDetect: Boolean(config && config.clip.autoCropDetect),
      autoCropArea: config ? config.clip.autoCropArea : '',
      version: app.getVersion()
    }
  }

  let pendingMainTab = null

  function openMainOnTab(tab) {
    const existing = getMainWindow()
    pendingMainTab = tab
    openMainWindow()
    if (existing) existing.webContents.send('main:show-tab', tab)
  }

  function pushStatusToWindow() {
    const win = getMainWindow()
    if (win) win.webContents.send('status:changed', statusForWindow())
  }

  function openAreasWindowFor(filePath) {
    const win = openAreasWindow()
    const id = win.webContents.id
    if (filePath) areasWindowFiles.set(id, filePath)
    win.on('closed', () => areasWindowFiles.delete(id))
    return win
  }

  function openCropWindowFor(filePath) {
    const win = openCropWindow()
    const id = win.webContents.id
    cropWindowFiles.set(id, filePath)
    win.on('closed', () => cropWindowFiles.delete(id))
    return win
  }

  app.on('second-instance', (_event, argv, _cwd, additionalData) => {
    const fileArg = (additionalData && additionalData.fileArg) || findVideoFileArg(argv)
    if (fileArg) {
      openCropWindowFor(fileArg)
      return
    }
    // Запустили второй раз без файла. Окно тут НЕ открываем: при автозапуске
    // с Windows вторая копия вполне может стартовать сама (например, осталась
    // старая запись в реестре), и приложение вместо тихого старта в трее
    // показывало окно. Просто поднимаем уже открытое, если оно есть.
    log('Программа уже работает — повторный запуск проигнорирован')
    const existing = getMainWindow()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return
    }
    // ...но и молчать нельзя. С ярлыка на рабочем столе это выглядит так,
    // будто программа не запускается вовсе: щёлкнул — и ничего. Значок в трее
    // при этом есть, просто его не заметили или он в скрытых.
    if (notifier) notifier.notifyAlreadyRunning()
  })

  // В трей-режиме закрытие окон не должно завершать приложение — оно живёт в трее.
  app.on('window-all-closed', () => {
    if (cropOnlyMode) app.quit()
  })

  app.whenReady().then(async () => {
    initAppPaths((message) => console.log(message))

    // Загружаем конфиг и логгер только после initAppPaths — они пишут рядом с
    // exe / в %LOCALAPPDATA% и зависят от вычисленных путей.
    const { loadConfig, wasConfigJustCreated } = require('../src/config')
    const { createLogger } = require('../src/logger')

    logger = createLogger()
    log = logger.log
    config = loadConfig()
    // Спрашиваем сразу после загрузки: признак живёт внутри config.js и
    // относится к тому, был ли файл создан этим самым вызовом loadConfig.
    const firstRun = wasConfigJustCreated()
    // Помощник нужен не только на самом первом запуске. Без пароля от OBS
    // программа не может ровно ничего — видео берётся только оттуда. В этом же
    // положении оказываются те, кто помощника пропустил, и те, у кого после
    // переустановки остался старый config.json, до которого руки не дошли:
    // файл есть, первым запуском он не считается, а настроен не был.
    const needsSetup = firstRun || !config.obs.password
    notifier = createNotifier({ log })

    registerIpcHandlers()

    if (cropOnlyMode) {
      log(`Разовая обрезка файла (перетащен на приложение): ${initialFileArg}`)
      openCropWindowFor(initialFileArg)
      return
    }

    await startTrayApp()

    // Помощник первой настройки — после того, как трей поднялся: он проверяет
    // подключение к OBS и умеет сохранить повтор, а для этого нужно уже
    // работающее приложение, а не только окно.
    if (needsSetup) {
      log(firstRun
        ? 'Первый запуск: config.json создан заново, открываю помощника настройки'
        : 'Пароль от OBS не задан — без него работать не с чем, открываю помощника настройки')
      openSetupWindow()
    }

    // Проверка обновлений идёт последней и в фоне: она не должна задерживать
    // запуск слежения за сделками.
    updater = createUpdater({
      installKind: getInstallKind(),
      log,
      // Ход загрузки — в окно настроек, если оно открыто. Больше ста мегабайт
      // без единого признака жизни выглядят как зависшая программа.
      onEvent: (event) => {
        const win = getMainWindow()
        if (win) win.webContents.send('updates:progress', event)
        if (event.stage === 'downloaded' && notifier) {
          notifier.notifyIssue(`Обновление ${event.version} загружено — установится при перезапуске`)
        }
      }
    })
    updater.start()
  }).catch((error) => {
    const message = `Фатальная ошибка при запуске: ${error.stack || error.message}`
    if (logger) logger.error(message)
    else console.error(message)
    app.exit(1)
  })

  // Перезапуски слежения выстраиваем в цепочку: два сохранения подряд (а в
  // помощнике настройки это обычное дело — шаг за шагом) иначе полезли бы
  // останавливать и поднимать слежение одновременно.
  let restartChain = Promise.resolve()

  function restartWatchingInBackground() {
    restartChain = restartChain.then(async () => {
      log('Перезапускаю слежение, чтобы применить настройки...')
      await appCore.stop()
      await appCore.start()
      log('Настройки применены')
    }).catch((error) => {
      const message = `Не удалось перезапустить слежение: ${error.message}`
      log(message)
      if (notifier) notifier.notifyIssue(message)
    })
    return restartChain
  }

  function registerIpcHandlers() {
    ipcMain.handle('trades:list', () => (appCore ? appCore.getRecentClips() : []))

    ipcMain.handle('crop:dropped-file', (event) => cropWindowFiles.get(event.sender.id) || null)

    ipcMain.handle('areas:clip', (event) => areasWindowFiles.get(event.sender.id) || null)
    ipcMain.on('areas:open', () => openAreasWindowFor(null))

    // Проверки помощника первой настройки. Смысл всех трёх один: показать
    // человеку результат сразу, а не оставить выяснять по цвету значка в трее,
    // почему ничего не происходит.
    ipcMain.handle('setup:check-obs', async (_event, url, password) => {
      const { checkObsConnection } = require('../src/obsClient')
      const result = await checkObsConnection({ url, password })
      log(`Проверка OBS (${url}): ${result.connected ? 'подключено' : 'не подключено'}` +
        `${result.connected ? `, буфер повтора ${result.replayBufferActive ? 'включён' : 'выключен'}` : ''}` +
        `${result.error ? ` — ${result.error}` : ''}`)
      return result
    })

    ipcMain.handle('setup:check-terminal', async (_event, terminalType) => {
      const { checkTerminalLogs } = require('../src/terminalLog')
      const result = await checkTerminalLogs(terminalType, config.terminal.logsDirOverride)
      log(`Проверка журнала ${result.terminalName}: ${result.logsDir} — файлов ${result.files.length}`)
      return result
    })

    // Первый запуск: клипов ещё нет ни одного, а размечать области можно
    // только по картинке. Поэтому кадр берём прямо из буфера OBS — он к этому
    // моменту уже настроен предыдущими шагами и держит последние минуты экрана.
    ipcMain.handle('setup:save-replay', async () => {
      if (!appCore) return { error: 'Слежение за сделками ещё не запущено' }

      // Пароль от OBS сохранён на первом шаге, и слежение от этого
      // перезапускается в фоне. Пока перезапуск идёт, подключения к OBS нет —
      // дожидаемся его, иначе повтор сорвался бы на ровном месте.
      await restartChain

      const { clipPath, error } = await appCore.saveManualReplay(SETUP_REPLAY_SEC)
      if (error) return { error }

      openAreasWindowFor(clipPath)
      return { clipPath }
    })

    ipcMain.on('setup:open', () => openSetupWindow())

    // Последний шаг помощника отправляет сюда: всё остальное живёт со
    // значениями по умолчанию, но взглянуть на них один раз стоит.
    ipcMain.on('settings:open', () => openMainOnTab('settings'))

    ipcMain.handle('app:version', () => ({ version: app.getVersion(), installKind: getInstallKind() }))

    ipcMain.handle('status:get', () => statusForWindow())

    // Повтор по требованию — то же, что пункт в трее, но из окна.
    ipcMain.handle('replay:save', async (_event, durationSec) => {
      if (!appCore) return { error: 'Слежение за сделками ещё не запущено' }
      return appCore.saveManualReplay(Number(durationSec) || 15)
    })

    // Папка целиком, а не файл в ней: shell:reveal умеет только подсветить
    // конкретный файл, а здесь открывать надо саму папку клипов.
    ipcMain.on('folder:open', (_event, dirPath) => {
      if (dirPath) shell.openPath(dirPath)
    })
    ipcMain.on('window:open-main', () => openMainWindow())

    ipcMain.handle('main:initial-tab', () => {
      const tab = pendingMainTab
      pendingMainTab = null
      return tab
    })

    // Перезапуск слежения переехал из трея в окно: это действие на случай
    // «что-то заклинило», и ему место рядом с тем, что показывает состояние.
    ipcMain.handle('app:restart', async () => {
      if (!appCore) return { error: 'Слежение ещё не запущено' }
      await restartWatchingInBackground()
      return { ok: true }
    })

    // Проверка обновлений по кнопке. В отличие от той, что при запуске, эта
    // отвечает всегда — окно настроек показывает итог у себя. Молчание в ответ
    // на нажатую кнопку читается как поломка.
    ipcMain.handle('updates:check', async () => {
      if (!updater) return { state: 'error', version: app.getVersion(), error: 'Обновления ещё не готовы к проверке' }
      log('Проверяю обновления по запросу из настроек')
      return updater.check()
    })

    ipcMain.handle('dialog:pick-video', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(win, {
        title: 'Выбери клип для обрезки',
        properties: ['openFile'],
        filters: [
          { name: 'Видео', extensions: ['mp4', 'mkv', 'mov', 'avi', 'flv', 'ts', 'webm', 'm4v'] },
          { name: 'Все файлы', extensions: ['*'] }
        ]
      })
      return result.canceled ? null : result.filePaths[0]
    })

    ipcMain.handle('dialog:pick-folder', async (event, currentPath) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(win, {
        title: 'Выбери папку',
        defaultPath: currentPath || undefined,
        properties: ['openDirectory', 'createDirectory']
      })
      return result.canceled ? null : result.filePaths[0]
    })

    ipcMain.handle('config:get', () => config)

    ipcMain.handle('config:save', async (_event, incoming) => {
      const { saveConfig } = require('../src/config')
      const saved = saveConfig(incoming)
      // Именно мутируем существующий объект, а не заменяем ссылку: createApp
      // захватил config по ссылке, и подмена переменной до него бы не дошла.
      Object.assign(config.obs, saved.obs)
      Object.assign(config.terminal, saved.terminal)
      Object.assign(config.clip, saved.clip)
      Object.assign(config.polling, saved.polling)
      log('Настройки сохранены в config.json')

      // Часть настроек (адрес OBS, интервалы, папка логов) читается только при
      // старте слежения — чтобы применить их, поднимаем слежение заново.
      //
      // Но ОКНО этого не ждёт. Перезапуск лезет в сеть, к OBS, и время его
      // работы ничем сверху не ограничено; окну же нужно знать ровно одно —
      // что настройки записаны. Когда ответ ждал перезапуска, подвисшее
      // подключение намертво вешало и окно: кнопка гасла и не возвращалась.
      if (appCore) restartWatchingInBackground()
      if (tray) {
        tray.setTrayHistoryLimit(config.clip.recentTradesHistorySize)
        tray.setStakanCount(config.clip.stakanCount)
        tray.setPresets({
          speedPresets: config.clip.speedPresets,
          replayPresetsSec: config.clip.replayPresetsSec
        })
        tray.setCropPresets(config.clip.cropPresets)
      }
      return config
    })

    ipcMain.handle('crop:run', async (_event, clipPath, options) => {
      const { cropClipToStakan } = require('../src/stakanCrop')
      const stakanOutputDir = require('../src/appPaths').resolveMediaPath(config.clip.stakanOutputDir)
      log(`Обрезка по запросу из окна: ${clipPath} ${JSON.stringify(options)}`)
      const outputPath = await cropClipToStakan(clipPath, options.stakanIndex ?? null, stakanOutputDir, options)
      log(`Готово: ${outputPath}`)
      return outputPath
    })

    // Поиск границ панелей терминала по кадру видео. Считается здесь, а не в
    // окне: кадр 3440x1440 — это ~20 МБ пикселей, и передавать их в окно ради
    // разбора незачем, наружу уходит только короткий список линий.
    ipcMain.handle('panels:detect', async (_event, clipPath, timeSec) => {
      const { probeVideoSize } = require('../src/clipper')
      const { grabFrameRgba } = require('../src/videoFrame')
      const { detectPanelGuides } = require('../src/panelDetect')

      const size = await probeVideoSize(clipPath)
      const frame = await grabFrameRgba(clipPath, timeSec, size)
      const guides = detectPanelGuides(frame)
      log(`Границы панелей по кадру ${clipPath}: вариантов ${guides.variants.length}, линий в лучшем ${guides.vertical.length}`)
      return { ...guides, width: size.width, height: size.height }
    })

    ipcMain.handle('crop-presets:list', () => config.clip.cropPresets)

    function applyCropPresets(nextPresets, logMessage) {
      const { saveConfig } = require('../src/config')
      const saved = saveConfig({ ...config, clip: { ...config.clip, cropPresets: nextPresets } })
      Object.assign(config.clip, saved.clip)
      if (tray) tray.setCropPresets(config.clip.cropPresets)
      log(logMessage)
      return config.clip.cropPresets
    }

    // Принимает как один пресет, так и целый набор: кнопка "Сохранить все
    // области" в превью отдаёт сразу все найденные стаканы.
    ipcMain.handle('crop-presets:save', (_event, incoming) => {
      const presets = (Array.isArray(incoming) ? incoming : [incoming])
        .map((preset) => ({ ...preset, name: String((preset && preset.name) || '').trim() }))
        .filter((preset) => preset.name)

      // Пресет с тем же именем заменяем, а не плодим второй: пользователь
      // почти наверняка переснимает ту же область точнее.
      const names = new Set(presets.map((preset) => preset.name))
      const rest = config.clip.cropPresets.filter((item) => !names.has(item.name))
      return applyCropPresets([...rest, ...presets],
        `Сохранено областей обрезки: ${presets.length} (${presets.map((p) => p.name).join(', ')})`)
    })

    ipcMain.handle('crop-presets:delete', (_event, name) => {
      const target = String(name || '').trim()
      return applyCropPresets(config.clip.cropPresets.filter((item) => item.name !== target),
        `Удалена область обрезки «${target}»`)
    })

    ipcMain.handle('shell:reveal', (_event, filePath) => {
      shell.showItemInFolder(filePath)
    })

    ipcMain.on('crop:open-for', (_event, filePath) => {
      if (filePath) openCropWindowFor(filePath)
    })

    // Из настроек: там нельзя нарисовать область, поэтому оттуда открывается
    // окно обрезки, где для этого есть картинка.
    ipcMain.on('crop:open', () => openCropWindow())

    ipcMain.on('help:open', () => openHelpWindow())

    ipcMain.on('logs:open', () => {
      if (logger) shell.openPath(logger.getLogDir())
    })

    ipcMain.on('window:close', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) win.close()
    })

    // Окно обрезки под форму сделано узким, а превью клипа в нём разглядывать
    // невозможно. На время превью разворачиваем окно почти на весь экран и
    // возвращаем прежний размер, когда превью закрыли.
    const boundsBeforePreview = new Map() // webContents.id -> прежние границы
    // Пока превью открыто, окно развёрнуто почти во весь экран и выглядит как
    // отдельное "окно выделения". Крестик в нём закрывал всё окно разом —
    // хотя человек ожидал вернуться к обычному виду обрезки. Поэтому первый
    // крестик просто закрывает превью; второй, уже в обычном окне, закроет
    // окно, как и положено.
    const previewCloseGuards = new Map()
    // Размер меняем одним движением. Самодельная анимация через несколько
    // setBounds подряд выглядела дёргано: окно перерисовывается рывками, это
    // хуже честного мгновенного перехода. Своей анимации у Windows для
    // setBounds нет — флаг animate работает только на macOS.

    ipcMain.on('window:preview-mode', (event, enabled) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return
      const key = event.sender.id

      if (enabled) {
        if (boundsBeforePreview.has(key)) return // уже развёрнуто
        boundsBeforePreview.set(key, win.getBounds())

        const guard = (event) => {
          event.preventDefault()
          win.webContents.send('preview:dismiss')
        }
        win.on('close', guard)
        previewCloseGuards.set(key, guard)

        // Окно могут закрыть, не выходя из превью — тогда возвращать размер
        // уже некуда, и запись о нём просто копилась бы.
        win.once('closed', () => {
          boundsBeforePreview.delete(key)
          previewCloseGuards.delete(key)
        })
        const { workArea } = screen.getDisplayMatching(win.getBounds())
        const margin = 0.04
        win.setBounds({
          x: Math.round(workArea.x + workArea.width * margin),
          y: Math.round(workArea.y + workArea.height * margin),
          width: Math.round(workArea.width * (1 - margin * 2)),
          height: Math.round(workArea.height * (1 - margin * 2))
        })
        return
      }

      const guard = previewCloseGuards.get(key)
      if (guard) {
        win.off('close', guard)
        previewCloseGuards.delete(key)
      }

      const previous = boundsBeforePreview.get(key)
      boundsBeforePreview.delete(key)
      // Развёрнутое вручную окно оставляем как есть: пользователь сам решил,
      // каким ему быть, и схлопывать его обратно было бы неожиданно.
      if (previous && !win.isMaximized()) win.setBounds(previous)
    })
  }

  // Диагностика отрисовки: без неё "окно открылось пустым" не отличить от
  // "страница не загрузилась" и от "упал вспомогательный процесс". Пишется
  // один раз при старте плюс по факту падений — строк в логе почти не даёт.
  function logRenderingDiagnostics() {
    log(`Запущено из: ${process.execPath}`)

    app.on('child-process-gone', (_event, details) => {
      log(`Упал вспомогательный процесс Chromium: ${details.type}${details.name ? ` (${details.name})` : ''} — ${details.reason}, код ${details.exitCode}`)
    })

    app.on('render-process-gone', (_event, webContents, details) => {
      log(`Упал процесс отрисовки окна: ${details.reason}, код ${details.exitCode}`)
    })
  }

  function pushTradesToWindow(trades) {
    const win = getMainWindow()
    if (win) win.webContents.send('trades:updated', trades)
  }

  async function startTrayApp() {
    const { createApp } = require('../src/app')

    // Версия в журнале обязательна: без неё по логу не отличить, какая сборка
    // сейчас работает, а при разборе жалобы это первое, что нужно знать.
    log(`TradeCut ${app.getVersion()} (${getInstallKind()})`)
    log('Конфигурация загружена')
    log(`Файлы логов приложения лежат в: ${logger.getLogDir()}`)
    setWindowsLogger(log)
    require('../src/clipper').setClipperLogger(log)
    autostart.migrateLegacyAutostart(log)
    autostart.repointAutostartIfMoved(APP_USER_MODEL_ID, log)
    logRenderingDiagnostics()

    // Единая точка принятия решения, что показать на иконке трея — приоритет:
    // пауза > ошибка последнего действия (рестарт/пауза) > статус OBS >
    // статус Replay Buffer. Во время самого рестарта/переключения паузы
    // ничего не трогаем — там статус выставляется явно по ходу операции.
    function renderTrayStatus() {
      if (restarting) return
      const { state, text } = currentStatus()
      tray.setStatus(state, state === 'error' ? text : undefined)
      pushStatusToWindow()
    }

    tray = createTray({
      autostartAvailable: autostart.isAvailable(),
      autostartChecked: autostart.isAvailable() && autostart.isEnabled(),
      trayHistoryLimit: config.clip.recentTradesHistorySize,
      cropPresets: config.clip.cropPresets,
      stakanCount: config.clip.stakanCount,
      speedPresets: config.clip.speedPresets,
      replayPresetsSec: config.clip.replayPresetsSec,
      log,
      onToggleAutostart: () => {
        try {
          const next = !autostart.isEnabled()
          autostart.setEnabled(next)
          tray.setAutostartChecked(next)
          log(next ? 'Автозапуск при старте Windows включён' : 'Автозапуск при старте Windows отключён')
        } catch (error) {
          log(`Не удалось изменить автозапуск: ${error.message}`)
          notifier.notifyIssue(`Не удалось изменить автозапуск: ${error.message}`)
        }
      },
      onRestart: async () => {
        if (restarting) return
        if (paused) {
          log('Приложение на паузе — сначала нажми "Возобновить"')
          return
        }
        restarting = true
        actionError = null
        try {
          log('Перезапуск по команде из трея...')
          tray.setStatus('warn', 'Перезапуск...')
          await appCore.stop()
          await appCore.start()
          log('Перезапущено')
        } catch (error) {
          log(`Ошибка при перезапуске: ${error.message}`)
          actionError = `Ошибка при перезапуске: ${error.message}`
          notifier.notifyIssue(actionError)
        } finally {
          restarting = false
          renderTrayStatus()
        }
      },
      onTogglePause: async () => {
        if (restarting) return
        restarting = true // используем тот же флаг занятости, что и рестарт
        actionError = null
        try {
          if (paused) {
            log('Возобновляю по команде из трея...')
            await appCore.start()
            paused = false
          } else {
            log('Ставлю на паузу по команде из трея...')
            await appCore.stop()
            paused = true
          }
          tray.setPauseState(paused)
          log(paused ? 'На паузе' : 'Возобновлено')
        } catch (error) {
          log(`Ошибка при переключении паузы: ${error.message}`)
          actionError = `Ошибка при переключении паузы: ${error.message}`
          notifier.notifyIssue(actionError)
        } finally {
          restarting = false
          renderTrayStatus()
        }
      },
      onPickStakan: (clipPath, stakanIndex, options) => {
        void appCore.cropRecentClip(clipPath, stakanIndex, options)
      },
      onOpenMainWindow: () => openMainWindow(),
      onOpenCropFor: (clipPath) => openCropWindowFor(clipPath),
      onSaveManualReplay: (durationSec) => appCore.saveManualReplay(durationSec),
      onExit: async () => {
        log('Остановка (выход из трея)...')
        try {
          if (updater) updater.stop()
          await appCore.stop()
        } finally {
          tray.destroy()
          app.exit(0)
        }
      }
    })

    appCore = createApp({
      config,
      log,
      onStatusChange: (state) => {
        obsState = state
        if (state === 'connected') actionError = null // свежий успех перекрывает старую ошибку действия
        renderTrayStatus()
      },
      onReplayBufferStatusChange: (active) => {
        replayBufferActive = active
        renderTrayStatus()
      },
      // История поменялась без новой сделки: отдельные клипы серии удалены,
      // и ссылки на них надо убрать из трея и окна, иначе обрезка не найдёт файл.
      onHistoryChanged: (recentClips) => {
        tray.updateRecentClips(recentClips)
        pushTradesToWindow(recentClips)
      },
      onClipReady: (_trade, _clipPath, recentClips) => {
        // Без toast — при стабильной работе они быстро надоедают. Вместо этого
        // короткое мигание иконки трея, чтобы заметить факт "клип готов" боковым
        // зрением, не отвлекаясь на всплывающее окно.
        tray.flashIcon()
        tray.updateRecentClips(recentClips)
        pushTradesToWindow(recentClips)
      },
      // Клипы по алертам в историю сделок не идут — только тот же сигнал
      // "готово" миганием иконки.
      // Ручное действие — тут уведомление уместно: пользователь нажал и ждёт
      // подтверждения, что повтор действительно сохранился.
      onManualReplayReady: (clipPath, durationSec) => {
        tray.flashIcon()
        notifier.notifyManualReplayReady(clipPath, durationSec)
      },
      onStakanReady: (_outputPath, stakanIndex, speedFactor) => {
        notifier.notifyStakanReady(stakanIndex, speedFactor)
      },
      onIssue: (message) => notifier.notifyIssue(message)
    })

    await appCore.start()
  }
}
