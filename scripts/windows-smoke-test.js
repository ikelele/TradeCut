// Автоматическая проверка окон (настройки / обрезка / сделки): что они
// загружаются, preload отдаёт window.api, форма настроек реально заполняется
// значениями из config.json, а в консоли рендерера нет ошибок.
// Запуск: npx electron scripts/windows-smoke-test.js
const path = require('path')
const { app, BrowserWindow, ipcMain } = require('electron')

const { initAppPaths } = require('../electron/paths')

const RENDERER_DIR = path.join(__dirname, '..', 'electron', 'renderer')
const PRELOAD_PATH = path.join(__dirname, '..', 'electron', 'preload.js')

const problems = []
const notes = []

function openPage(page) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload: PRELOAD_PATH, contextIsolation: true, nodeIntegration: false, sandbox: false }
    })

    win.webContents.on('console-message', (event) => {
      const level = typeof event === 'object' && event !== null ? event.level : arguments[1]
      const message = typeof event === 'object' && event !== null ? event.message : arguments[2]
      if (level === 'error' || level === 3) problems.push(`[${page}] console error: ${message}`)
    })
    win.webContents.on('preload-error', (_e, preloadPath, error) => {
      problems.push(`[${page}] preload упал (${preloadPath}): ${error.message}`)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      problems.push(`[${page}] процесс рендерера умер: ${details.reason}`)
    })

    win.webContents.once('did-finish-load', () => {
      // Даём отработать асинхронным window.api.*().then(...) внутри страницы
      setTimeout(() => resolve(win), 700)
    })
    win.webContents.once('did-fail-load', (_e, code, description) => {
      problems.push(`[${page}] страница не загрузилась: ${description} (${code})`)
      resolve(win)
    })

    win.loadFile(path.join(RENDERER_DIR, page))
  })
}

async function check(win, page, description, script, validate) {
  try {
    const value = await win.webContents.executeJavaScript(script)
    if (validate(value)) notes.push(`[${page}] OK: ${description} (${JSON.stringify(value)})`)
    else problems.push(`[${page}] НЕ ПРОШЛО: ${description} — получено ${JSON.stringify(value)}`)
  } catch (error) {
    problems.push(`[${page}] ошибка при проверке "${description}": ${error.message}`)
  }
}

app.whenReady().then(async () => {
  initAppPaths()
  const { loadConfig } = require('../src/config')
  const config = loadConfig()
  // Области кадра подставляем свои: у настоящего конфига их может не быть
  // вовсе, а проверять надо окно с ними — из них строится и список
  // "что вырезать сразу".
  config.clip.cropPresets = [
    { name: 'Левый стакан', x: 0, y: 0, width: 160, height: 240, sourceWidth: 320, sourceHeight: 240 }
  ]

  // Иконки трея: проверяем ровно тот путь, которым их берёт приложение —
  // что файл читается и что размер уже уменьшен под трей, а не остаётся
  // 256x256 (именно на таком значке Windows и оставляла пустое место).
  // Сам Tray не создаём: он мигнул бы значком в трее у работающего приложения.
  const { loadTrayIcon, getTrayIconSizePx } = require('../electron/tray')
  const expectedPx = getTrayIconSizePx()
  for (const file of ['tray-ok.ico', 'tray-warn.ico', 'tray-error.ico', 'tray-paused.ico', 'tray-flash.ico']) {
    const image = loadTrayIcon(file)
    const size = image.getSize()
    if (image.isEmpty()) problems.push(`[tray] иконка ${file} не прочиталась`)
    else if (size.width !== expectedPx || size.height !== expectedPx) {
      problems.push(`[tray] иконка ${file} должна быть ${expectedPx}px, а не ${size.width}x${size.height}`)
    } else notes.push(`[tray] OK: иконка ${file} читается и ужата до ${size.width}px`)
  }

  // Минимальные заглушки IPC, которых ждут страницы
  ipcMain.handle('config:get', () => config)
  ipcMain.handle('trades:list', () => ([
    { label: 'TESTUSDT LONG 08-02 00:10', clipPath: 'C:\\clips\\test.mp4' }
  ]))
  ipcMain.handle('crop:dropped-file', () => null)
  // Кнопка "Выбрать файл..." отдаёт тестовый клип — так проверки превью идут
  // тем же путём, что и у пользователя, а не подсовывают видео напрямую.
  ipcMain.handle('dialog:pick-video', () => path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv'))
  // Границы панелей для тестового кадра 320x240: две вертикальные линии делят
  // его на три колонки, одна горизонтальная отделяет "шапку".
  ipcMain.handle('panels:detect', () => ({
    vertical: [0, 100, 200],
    horizontal: [30],
    variants: [[0, 100, 200], [0, 50, 100, 150, 200, 250]],
    width: 320,
    height: 240
  }))
  ipcMain.handle('crop:run', () => 'C:\\clips\\2026-09-18\\готовый.mp4')
  ipcMain.handle('shell:reveal', () => undefined)
  ipcMain.handle('crop-presets:delete', () => ([]))
  ipcMain.handle('crop-presets:save', (_event, incoming) => (Array.isArray(incoming) ? incoming : [incoming]))
  ipcMain.handle('crop-presets:list', () => ([
    { name: 'Левый стакан', x: 0, y: 0, width: 160, height: 240, sourceWidth: 320, sourceHeight: 240 }
  ]))

  // Помощник первой настройки. Проверки возвращают заранее известные ответы —
  // нам важно не поговорить с настоящим OBS, а увидеть, что окно правильно
  // показывает три разных исхода: не подключилось / подключилось без буфера /
  // всё готово. Их легко перепутать в один красный цвет, а действия у них разные.
  const OBS_ANSWERS = [
    { connected: false, replayBufferActive: false, error: 'connect ECONNREFUSED 127.0.0.1:4455' },
    { connected: false, replayBufferActive: false, error: 'Authentication failed.' },
    { connected: true, replayBufferActive: false },
    { connected: true, replayBufferActive: true }
  ]
  let obsAnswerIndex = 0
  ipcMain.handle('setup:check-obs', () => OBS_ANSWERS[Math.min(obsAnswerIndex++, OBS_ANSWERS.length - 1)])
  ipcMain.handle('setup:check-terminal', (_event, terminalType) => ({
    terminalName: terminalType === 'vataga' ? 'Vataga' : 'TigerTrade',
    logsDir: 'C:\\проверка\\Logs',
    files: ['C:\\проверка\\Logs\\WorkLog_20260918.log'],
    lastWriteMs: Date.UTC(2026, 8, 18, 9, 30)
  }))
  ipcMain.handle('setup:save-replay', () => ({ clipPath: 'C:\\replays\\проверка.mp4' }))
  // Окно обрезки спрашивает это при каждом открытии
  ipcMain.handle('crop:guided', () => false)
  // Помощник сохраняет настройки на каждом переходе между шагами
  ipcMain.handle('config:save', (_event, incoming) => incoming)
  // Последний шаг помощника зовёт окно настроек — в тесте открывать его не надо
  ipcMain.on('settings:open', () => {})
  ipcMain.handle('main:initial-tab', () => null)
  ipcMain.handle('app:restart', () => ({ ok: true }))
  ipcMain.handle('app:version', () => ({ version: '9.9.9', installKind: 'installed' }))
  // Главное окно спрашивает состояние слежения и умеет звать повтор
  let statusAnswer = {
    state: 'warn',
    paused: false,
    obsPasswordSet: false,
    terminal: 'tigertrade',
    obsUrl: 'ws://127.0.0.1:4455',
    clipsDir: 'C:\Видео\TradeCut\clips',
    areasCount: 1,
    autoCropDetect: false,
    autoCropArea: '',
    version: '9.9.9'
  }
  ipcMain.handle('status:get', () => statusAnswer)
  ipcMain.handle('replay:save', () => ({ clipPath: 'C:\replays\проверка.mp4' }))
  ipcMain.on('folder:open', () => {})
  ipcMain.on('window:open-main', () => {})
  // Проверка обновлений отвечает по очереди всем, чем может: сначала "всё
  // свежее", потом пустой список выпусков, потом настоящая ошибка сети.
  const UPDATE_ANSWERS = [
    { state: 'none', current: '9.9.9' },
    { state: 'error', current: '9.9.9', error: 'No published versions on GitHub' },
    { state: 'error', current: '9.9.9', error: 'getaddrinfo ENOTFOUND github.com' }
  ]
  let updateAnswerIndex = 0
  ipcMain.handle('updates:check', () => UPDATE_ANSWERS[Math.min(updateAnswerIndex++, UPDATE_ANSWERS.length - 1)])

  const mainWin = await openPage('main.html')

  // Главное окно отвечает на вопрос "работает ли программа" словами, а не
  // цветом значка, который надо знать наизусть.
  await check(mainWin, 'main.html', 'состояние показано словами и с подсказкой, что делать', `
    (() => ({
      dot: document.getElementById('status-dot').className,
      title: document.getElementById('status-title').textContent,
      detail: document.getElementById('status-detail').textContent
    }))()
  `, (v) => v && /status-dot-warn/.test(v.dot) && /Нет связи с OBS/.test(v.title)
       && /Пароль от OBS не задан/.test(v.detail))

  await check(mainWin, 'main.html', 'сводка настроек собрана',
    '[...document.querySelectorAll("#facts dt")].map(el => el.textContent)',
    (v) => Array.isArray(v) && v.includes('Терминал') && v.includes('Клипы') && v.includes('Версия'))

  await check(mainWin, 'main.html', 'кнопки повтора взяты из настроек',
    '[...document.querySelectorAll("[data-role=replay] .option")].map(b => b.textContent)',
    (v) => Array.isArray(v) && v.length === config.clip.replayPresetsSec.length && v[0] === '15 сек')

  await check(mainWin, 'main.html', 'вкладки переключаются', `
    (() => {
      const clipsTab = [...document.querySelectorAll('.tab')].find(t => t.dataset.tab === 'clips')
      const before = document.querySelector('[data-panel=clips]').hidden
      clipsTab.click()
      return {
        before,
        after: document.querySelector('[data-panel=clips]').hidden,
        nowHidden: document.querySelector('[data-panel=now]').hidden,
        selected: clipsTab.getAttribute('aria-selected')
      }
    })()
  `, (v) => v && v.before === true && v.after === false && v.nowHidden === true && v.selected === 'true')

  await check(mainWin, 'main.html', 'список сделок отрисован во вкладке',
    'document.querySelectorAll(".trade-item").length', (v) => v === 1)
  await check(mainWin, 'main.html', 'кнопка "Вырезать" заблокирована до выбора сделки',
    'document.getElementById("run").disabled', (v) => v === true)
  await check(mainWin, 'main.html', 'выбор сделки разблокирует кнопку',
    'document.querySelector(".trade-item").click(); document.getElementById("run").disabled', (v) => v === false)


  const settings = mainWin
  await check(settings, 'main.html (настройки)', 'preload отдал window.api', 'typeof window.api', (v) => v === 'object')
  await check(settings, 'main.html (настройки)', 'поле адреса OBS заполнено из конфига',
    'document.getElementById("obs-url").value', (v) => typeof v === 'string' && v.length > 0)
  await check(settings, 'main.html (настройки)', 'чекбокс объединения сделок отражает конфиг',
    'document.getElementById("merge-enabled").checked', (v) => v === Boolean(config.clip.mergeTradesEnabled))
  // Ноль тут значит "не делить кадр", и поле должно быть ПУСТЫМ: ноль в графе
  // "на сколько частей" выглядит как поломка, а не как осознанная настройка.
  await check(settings, 'main.html (настройки)', 'количество частей кадра: ноль показывается пустым полем', `
    (() => {
      const el = document.getElementById('stakan-count')
      const shown = el.value
      el.value = ''
      const collectedEmpty = collectForm().clip.stakanCount
      el.value = shown
      return { shown, collectedEmpty, expected: ${JSON.stringify(config.clip.stakanCount)} }
    })()
  `, (v) => v && v.collectedEmpty === 0
       && (v.expected > 0 ? Number(v.shown) === v.expected : v.shown === ''))
  // Удаление отдельных клипов серии — единственное поведение по умолчанию,
  // которое стирает файлы, поэтому проверяем именно исходное состояние галки.
  await check(settings, 'main.html (настройки)', 'галка "резать из трея без звука" отражает конфиг',
    'document.getElementById("tray-crop-muted").checked', (v) => v === Boolean(config.clip.trayCropMuted))
  await check(settings, 'main.html (настройки)', 'галка "оставлять отдельные клипы серии" отражает конфиг',
    'document.getElementById("keep-parts").checked', (v) => v === Boolean(config.clip.keepMergedParts))
  await check(settings, 'main.html (настройки)', 'из настроек можно открыть справку',
    'typeof window.api.openHelp === "function" && !!document.getElementById("open-help")', (v) => v === true)
  await check(settings, 'main.html (настройки)', 'списки пресетов показываются строкой через запятую', `
    (() => {
      const replay = document.getElementById('replay-presets')
      const speed = document.getElementById('speed-presets')
      return { replay: replay.value, speed: speed.value }
    })()
  `, (v) => v && v.replay === config.clip.replayPresetsSec.join(', ')
       && v.speed === config.clip.speedPresets.join(', '))
  await check(settings, 'main.html (настройки)', 'список своих областей кадра есть',
    '!!document.querySelector("[data-role=preset-list]")', (v) => v === true)
  // Выбирать «что вырезать сразу» можно только из настроенных областей —
  // список строится из них же, плюс «не вырезать» первым пунктом.
  await check(settings, 'main.html (настройки)', 'автообрезка предлагает настроенные области и «не вырезать»',
    `(() => {
       const select = document.getElementById('auto-crop-area')
       return {
         options: [...select.options].map((o) => o.textContent),
         firstValue: select.options[0].value,
         selected: select.value
       }
     })()`,
    (v) => v && v.options[0] === 'Не вырезать' && v.firstValue === ''
      && v.options.includes('Левый стакан') && v.selected === '')

  await check(settings, 'main.html (настройки)', 'выбранная область уезжает в конфиг при сохранении',
    `(() => {
       document.getElementById('auto-crop-area').value = 'Левый стакан'
       document.getElementById('auto-crop-delete-full').checked = true
       document.getElementById('auto-crop-detect').checked = true
       const collected = collectForm()
       return {
         area: collected.clip.autoCropArea,
         deleteFull: collected.clip.autoCropDeleteFull,
         detect: collected.clip.autoCropDetect
       }
     })()`,
    (v) => v && v.area === 'Левый стакан' && v.deleteFull === true && v.detect === true)

  await check(settings, 'main.html (настройки)', 'из настроек можно открыть окно настройки областей',
    'typeof window.api.openCropWindow === "function" && !!document.getElementById("open-crop")', (v) => v === true)
  await check(settings, 'main.html (настройки)', 'сохранение из настроек не теряет настроенные области', `
    (() => {
      const collected = collectForm()
      return Array.isArray(collected.clip.cropPresets)
    })()
  `, (v) => v === true)
  await check(settings, 'main.html (настройки)', 'папка клипов заполнена',
    'document.getElementById("output-dir").value', (v) => typeof v === 'string' && v.length > 0)
  await check(settings, 'main.html (настройки)', 'папка для повторов из трея заполнена',
    'document.getElementById("manual-replay-dir").value', (v) => v === config.clip.manualReplayOutputDir)
  await check(settings, 'main.html (настройки)', 'есть переключатель терминалов Vataga/TigerTrade',
    '[...document.querySelectorAll("[data-role=terminal] .option")].map(b => b.textContent)',
    (v) => Array.isArray(v) && v.includes('Vataga') && v.includes('TigerTrade'))
  await check(settings, 'main.html (настройки)', 'выбран терминал из конфига',
    'document.querySelector("[data-role=terminal] .option[aria-pressed=true]").textContent',
    (v) => v === (config.terminal.type === 'tigertrade' ? 'TigerTrade' : 'Vataga'))
  await check(settings, 'main.html (настройки)', 'переключение терминала меняет подсказку про путь', `
    (() => {
      const buttons = [...document.querySelectorAll("[data-role=terminal] .option")]
      const tiger = buttons.find(b => b.textContent === "TigerTrade")
      const vataga = buttons.find(b => b.textContent === "Vataga")
      tiger.click()
      const tigerHint = document.getElementById("terminal-dir-hint").textContent
      vataga.click()
      const vatagaHint = document.getElementById("terminal-dir-hint").textContent
      return tigerHint.includes("TigerTrade") && vatagaHint.includes("Vataga") && tigerHint !== vatagaHint
    })()
  `, (v) => v === true)

  // Загрузка идёт минутами и без единого признака жизни выглядит как зависшая
  // программа. Шлём события тем же каналом, которым их шлёт основной процесс —
  // так проверяется и проброс через preload, а не только разбор в окне.
  const sendProgress = async (event) => {
    settings.webContents.send('updates:progress', event)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  await sendProgress({ stage: 'downloading', percent: 42, transferred: 57 * 1024 * 1024, total: 136 * 1024 * 1024 })
  await check(settings, 'main.html (настройки)', 'ход загрузки обновления виден в окне',
    `(() => {
       const el = document.getElementById('update-status')
       return { cls: el.className, text: el.textContent }
     })()`,
    (v) => v && /42%/.test(v.text) && /57 из 136 МБ/.test(v.text))

  await sendProgress({ stage: 'downloaded', version: '9.9.10' })
  await check(settings, 'main.html (настройки)', 'после загрузки сказано, что ставить будет при перезапуске',
    `(() => {
       const el = document.getElementById('update-status')
       return { cls: el.className, text: el.textContent }
     })()`,
    (v) => v && /ok/.test(v.cls) && /9\.9\.10 загружена/.test(v.text) && /перезапуске/.test(v.text))

  await check(settings, 'main.html (настройки)', 'версия программы показана в настройках',
    'document.getElementById("app-version").textContent',
    (v) => typeof v === 'string' && v.includes('9.9.9') && v.includes('установленная'))

  // Кнопка проверки обязана отвечать на каждое нажатие, в том числе "у тебя
  // последняя версия": проверка при запуске в этом случае молчит осознанно, но
  // молчание в ответ на нажатую кнопку читается как поломка.
  await check(settings, 'main.html (настройки)', 'проверка обновлений отвечает на каждое нажатие', `
    (async () => {
      const button = document.getElementById('check-updates')
      const status = document.getElementById('update-status')
      const results = []
      for (let i = 0; i < 3; i++) {
        button.click()
        await new Promise((resolve) => setTimeout(resolve, 250))
        results.push({ cls: status.className, text: status.textContent })
      }
      return results
    })()
  `, (v) => Array.isArray(v) && v.length === 3
       // Всё свежее — и это надо сказать вслух
       && /ok/.test(v[0].cls) && /последняя версия — 9\.9\.9/.test(v[0].text)
       // Выпусков нет вовсе — не поломка, и пугать красным незачем
       && !/error/.test(v[1].cls) && /нет ни одного выпуска/.test(v[1].text)
       // А вот сеть не отвечает — это уже ошибка
       && /error/.test(v[2].cls) && /ENOTFOUND/.test(v[2].text))

  const help = await openPage('help.html')
  await check(help, 'help.html', 'справка загрузилась и в ней есть разделы',
    '[...document.querySelectorAll(".help-block h2")].map(h => h.textContent)',
    (v) => Array.isArray(v) && v.length >= 4)
  await check(help, 'help.html', 'в справке есть шаги первого запуска',
    'document.querySelectorAll(".help-block ol li").length', (v) => v >= 4)
  await check(help, 'help.html', 'кнопка журнала проброшена в окно',
    'typeof window.api.openLogsFolder === "function" && !!document.getElementById("open-logs")', (v) => v === true)

  const crop = await openPage('crop.html')
  await check(crop, 'crop.html', 'кнопка "Вырезать" заблокирована без файла',
    'document.getElementById("run").disabled', (v) => v === true)
  await check(crop, 'crop.html', 'по умолчанию выбран "Весь кадр", даже когда есть пресеты',
    `(() => {
       const buttons = [...document.querySelectorAll("[data-role=stakan] .option")]
       const pressed = buttons.filter(b => b.getAttribute('aria-pressed') === 'true')
       return { first: buttons[0].textContent, pressed: pressed.map(b => b.textContent) }
     })()`, (v) => v.first === 'Весь кадр' && v.pressed.length === 1 && v.pressed[0] === 'Весь кадр')
  await check(crop, 'crop.html', 'без стакана, скорости и обрезки работа не запускается',
    `(() => {
       document.querySelector("[data-role=stakan] .option").click()
       const statusEl = document.getElementById('status')
       runCrop({ clipPath: 'C:\\\\nope.mp4', options: { stakanIndex: null, speedFactor: 1, trimStart: 0, trimEnd: 0 }, button: document.getElementById('run'), statusEl })
       return statusEl.textContent
     })()`, (v) => typeof v === 'string' && v.includes('Нечего делать'))
  await check(crop, 'crop.html', 'кнопки скорости строятся из настроек и всегда содержат «Обычная»',
    '[...document.querySelectorAll("[data-role=speed] .option")].map(b => b.textContent)',
    (v) => Array.isArray(v) && v[0] === 'Обычная'
      && v.length === new Set([1, ...config.clip.speedPresets]).size)
  await check(crop, 'crop.html', 'галка "Без звука" есть и по умолчанию снята',
    '!!document.getElementById("mute") && document.getElementById("mute").checked === false', (v) => v === true)
  await check(crop, 'crop.html', 'одна только галка "Без звука" уже считается работой',
    `(() => {
       document.getElementById('mute').checked = true
       const statusEl = document.getElementById('status')
       statusEl.textContent = ''
       runCrop({ clipPath: null, options: { stakanIndex: null, speedFactor: 1, trimStart: 0, trimEnd: 0, mute: true }, button: document.getElementById('run'), statusEl })
       document.getElementById('mute').checked = false
       return statusEl.textContent
     })()`, (v) => typeof v === 'string' && !v.includes('Нечего делать'))
  await check(crop, 'crop.html', 'зона перетаскивания есть',
    '!!document.getElementById("dropzone")', (v) => v === true)
  // Подсказка помощника: обычное окно обрезки её не показывает (заглушка
  // crop:guided отвечает "нет"), но сама разметка и проброс должны быть на месте.
  await check(crop, 'crop.html', 'подсказка помощника есть и в обычном окне скрыта',
    `(() => {
       const banner = document.getElementById('guided-banner')
       return {
         exists: !!banner,
         hidden: banner ? banner.hidden : null,
         steps: banner ? banner.querySelectorAll('li').length : 0,
         wired: typeof window.api.isGuidedCrop === 'function'
       }
     })()`, (v) => v && v.exists === true && v.hidden === true && v.steps === 5 && v.wired === true)
  await check(crop, 'crop.html', 'getPathForFile проброшен в окно',
    'typeof window.api.getPathForFile', (v) => v === 'function')

  // Визуальная обрезка. Проверяем именно то, что могло молча не заработать:
  // политика безопасности страницы способна запретить и загрузку видео, и
  // позиционирование рамки — а внешне окно при этом выглядит целым.
  // Когда свои области настроены, расчётное деление на равные части из выбора
  // убирается: держать рядом измеренные границы и приблизительные незачем.
  await check(crop, 'crop.html', 'настроенные области вытесняют деление на равные части',
    '[...document.querySelectorAll("[data-role=stakan] .option")].map(b => b.textContent)',
    (v) => Array.isArray(v) && v.includes('Левый стакан') && v.includes('Весь кадр')
      && !v.some((label) => /^Стакан \d+$/.test(label)))

  // Идём тем же путём, что и пользователь: выбрать файл кнопкой, затем открыть
  // превью. Раньше здесь видео подсовывалось напрямую в элемент, и из-за этого
  // поиск границ не знал пути к файлу — проверка этого не замечала.
  await check(crop, 'crop.html', 'видео открывается из окна и рамка ставится по размеру кадра', `
    new Promise((resolve) => {
      const preview = document.querySelector('[data-role="preview"]')
      const video = preview.querySelector('[data-role="video"]')
      const box = preview.querySelector('[data-role="box"]')
      video.addEventListener('loadedmetadata', () => setTimeout(() => resolve({
        natural: [video.videoWidth, video.videoHeight],
        boxHidden: box.hidden,
        // Если CSP запретит присваивание style, ширина останется пустой
        boxWidth: box.style.width,
        sizeText: preview.querySelector('[data-role="size"]').textContent
      }), 150), { once: true })
      video.addEventListener('error', () => resolve({ error: video.error && video.error.code }), { once: true })
      setTimeout(() => resolve({ error: 'timeout' }), 6000)

      document.getElementById('pick').click()
      setTimeout(() => document.querySelector('[data-role="pick-visually"]').click(), 200)
    })
  `, (v) => v && !v.error && v.natural[0] === 320 && v.boxHidden === false && /px$/.test(v.boxWidth || ''))

  // Кадр не должен вылезать за отведённую долю высоты окна: иначе на большом
  // экране ползунок перемотки и кнопки уедут за нижний край.
  await check(crop, 'crop.html', 'высота кадра ограничена долей от высоты окна', `
    (() => {
      const video = document.querySelector('[data-role="video"]')
      const stage = document.querySelector('[data-role="stage"]')
      return {
        limit: stage.style.maxWidth,
        videoHeight: video.clientHeight,
        allowed: Math.round(window.innerHeight * 0.62),
        // Коробка сцены обязана совпадать с картинкой — на этом держится
        // пересчёт координат рамки
        sameWidth: stage.clientWidth === video.clientWidth
      }
    })()
  `, (v) => v && /px$/.test(v.limit || '') && v.videoHeight <= v.allowed + 1 && v.sameWidth === true)

  // Поиск границ панелей: линии должны отрисоваться, а двойной щелчок —
  // выделить панель ровно от линии до линии. Это главная польза детектора:
  // попасть мышью в границу с точностью до пикселя невозможно.
  await check(crop, 'crop.html', 'найденные границы рисуются направляющими', `
    (async () => {
      document.querySelector('[data-role="detect"]').click()
      await new Promise((resolve) => setTimeout(resolve, 400))
      const guides = document.querySelector('[data-role="guides"]')
      return {
        vertical: guides.querySelectorAll('.guide-vertical').length,
        horizontal: guides.querySelectorAll('.guide-horizontal').length,
        variantShown: !document.querySelector('[data-role="variant"]').hidden
      }
    })()
  `, (v) => v && v.vertical === 3 && v.horizontal === 1 && v.variantShown === true)

  // Разовая настройка под свой монитор: одна кнопка сохраняет все найденные
  // колонки как области. Раньше единственной настройкой было деление на шесть
  // равных частей от 3440 пикселей — разрешения монитора автора.
  await check(crop, 'crop.html', 'кнопка сохраняет все найденные области разом', `
    (async () => {
      const button = document.querySelector('[data-role="save-all"]')
      const hidden = button.hidden
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      return {
        hidden,
        status: document.querySelector('[data-role="status"]').textContent,
        options: [...document.querySelectorAll("[data-role=stakan] .option")].map(b => b.textContent)
      }
    })()
  `, (v) => v && v.hidden === false && /Сохранено областей: 3/.test(v.status || '')
       && v.options.includes('Стакан 1') && v.options.includes('Стакан 3'))

  // Нажатие на кнопку области должно показывать её прямо на кадре — иначе по
  // названию "Стакан 2" не понять, что именно вырежется.
  // Нажатие на кнопку области не должно разворачивать окно во весь экран:
  // человек может просто выбирать, что резать, не собираясь ничего смотреть.
  await check(crop, 'crop.html', 'выбор области сам по себе не открывает превью', `
    (async () => {
      const preview = document.querySelector('[data-role="preview"]')
      const pick = document.querySelector('[data-role="pick-visually"]')
      if (!preview.hidden) pick.click() // закрываем, если осталось открытым
      await new Promise((resolve) => setTimeout(resolve, 200))

      const buttons = [...document.querySelectorAll("[data-role=stakan] .option")]
      const target = buttons.find(b => /Стакан/.test(b.textContent)) || buttons[1]
      const closedBefore = preview.hidden
      target.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      return { closedBefore, stillClosed: preview.hidden }
    })()
  `, (v) => v && v.closedBefore === true && v.stillClosed === true)

  // А когда превью открыто кнопкой — выбранная область сразу видна на кадре.
  await check(crop, 'crop.html', 'при открытом превью выбор области виден на кадре', `
    (async () => {
      const preview = document.querySelector('[data-role="preview"]')
      const pick = document.querySelector('[data-role="pick-visually"]')
      const buttons = [...document.querySelectorAll("[data-role=stakan] .option")]
      const size = () => document.querySelector('[data-role="size"]').textContent

      buttons[0].click() // "Весь кадр"
      if (preview.hidden) pick.click()
      await new Promise((resolve) => setTimeout(resolve, 900))
      const whole = size()

      const area = buttons.find(b => /Стакан/.test(b.textContent)) || buttons[1]
      area.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      return { whole, area: size(), label: area.textContent }
    })()
  `, (v) => v && /^320x240/.test(v.whole || '') && /^100x/.test(v.area || ''))


  await check(crop, 'crop.html', 'двойной щелчок выделяет панель от границы до границы', `
    (async () => {
      // Границы относятся к загруженному кадру и сбрасываются при повторном
      // открытии превью — ищем их заново.
      document.querySelector('[data-role="detect"]').click()
      const stage = document.querySelector('[data-role="stage"]')
      const video = document.querySelector('[data-role="video"]')
      const box = document.querySelector('[data-role="box"]')
      const bounds = stage.getBoundingClientRect()
      // Точка внутри средней колонки (между линиями 100 и 200 из 320)
      const scale = video.clientWidth / 320
      await new Promise((resolve) => setTimeout(resolve, 400))
      box.dispatchEvent(new MouseEvent('dblclick', {
        clientX: bounds.left + 150 * scale, clientY: bounds.top + 100, bubbles: true
      }))
      return {
        size: document.querySelector('[data-role="size"]').textContent,
        left: box.style.left
      }
    })()
  `, (v) => v && /^100x\d+ из 320x240$/.test(v.size || ''))

  // Дорожка обрезки по времени: ручки должны писать в те же числовые поля,
  // которые читает getOptions — иначе на дорожке одно, а вырежется другое.
  await check(crop, 'crop.html', 'ручка на дорожке задаёт обрезку и та видна в форме', `
    (() => {
      const timeline = document.querySelector('[data-role="timeline"]')
      const handle = timeline.querySelector('[data-trim="end"]')
      const summary = document.querySelector('[data-role="trim-summary"]')
      const bounds = timeline.getBoundingClientRect()
      const hiddenBefore = summary.hidden
      handle.setPointerCapture = () => {}
      handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: bounds.right, clientY: bounds.top + 10, bubbles: true, pointerId: 2 }))
      // Тянем ручку конца к середине дорожки — отрезаем половину клипа
      handle.dispatchEvent(new PointerEvent('pointermove', { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + 10, bubbles: true, pointerId: 2 }))
      handle.dispatchEvent(new PointerEvent('pointerup', { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + 10, bubbles: true, pointerId: 2 }))
      return {
        hiddenBefore,
        summary: summary.hidden ? '' : summary.textContent,
        label: document.querySelector('[data-role="trim-label"]').textContent
      }
    })()
  `, (v) => v && v.hiddenBefore === true && /с конца/.test(v.summary || '') && /Останется/.test(v.label || ''))

  await check(crop, 'crop.html', 'числовых полей обрезки больше нет',
    '!document.getElementById("trim-start") && !document.getElementById("trim-end")', (v) => v === true)

  // Превью должно звучать: раньше видео стояло с атрибутом muted, и звук при
  // проигрывании не шёл вовсе.
  await check(crop, 'crop.html', 'звук в превью включён и выключается кнопкой', `
    (() => {
      const video = document.querySelector('[data-role="video"]')
      const button = document.querySelector('[data-role="sound"]')
      const initial = video.muted
      button.click()
      const afterClick = video.muted
      button.click()
      return { initial, afterClick, restored: video.muted, label: button.textContent }
    })()
  `, (v) => v && v.initial === false && v.afterClick === true && v.restored === false)

  await check(crop, 'crop.html', 'поле имени файла есть и по умолчанию пустое',
    `(() => {
       const el = document.getElementById('output-name')
       return el ? { value: el.value, hasPlaceholder: el.placeholder.length > 0 } : null
     })()`, (v) => v && v.value === '' && v.hasPlaceholder === true)

  await check(crop, 'crop.html', 'рамка тянется мышью и пересчитывается в пиксели кадра', `
    (() => {
      const preview = document.querySelector('[data-role="preview"]')
      const box = preview.querySelector('[data-role="box"]')
      const handle = box.querySelector('[data-handle="e"]')
      const before = box.style.width
      const down = new PointerEvent('pointerdown', { clientX: 300, clientY: 100, bubbles: true, pointerId: 1 })
      handle.setPointerCapture = () => {}
      handle.dispatchEvent(down)
      handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 100, bubbles: true, pointerId: 1 }))
      handle.dispatchEvent(new PointerEvent('pointerup', { clientX: 200, clientY: 100, bubbles: true, pointerId: 1 }))
      return { before, after: box.style.width, size: preview.querySelector('[data-role="size"]').textContent }
    })()
  `, (v) => v && v.before !== v.after && /^\d+x\d+ из 320x240$/.test(v.size || ''))

  // Сетка областей: человек говорит, на сколько частей делить, и сразу видит
  // их на кадре с номерами. Это единственный путь для тех, у кого поиск границ
  // не сработал, поэтому проверяем его целиком — от ввода числа до сохранения.
  // Идёт последней: сетка меняет и разбивку, и список сохранённых областей.
  await check(crop, 'crop.html', 'число частей сразу рисует пронумерованные области', `
    (async () => {
      const input = document.querySelector('[data-role="grid-count"]')
      input.value = '6'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 150))
      return {
        cells: document.querySelectorAll('.grid-cell').length,
        numbers: [...document.querySelectorAll('.grid-number')].map((el) => el.textContent).join(''),
        dividers: document.querySelectorAll('.grid-edge-vertical').length,
        edges: document.querySelectorAll('.grid-edge-horizontal').length,
        boxHidden: document.querySelector('[data-role="box"]').hidden
      }
    })()
  `, (v) => v && v.cells === 6 && v.numbers === '123456' && v.dividers === 5
       && v.edges === 2 && v.boxHidden === true)

  // Границы двигаются мышью — это главное действие в этом режиме.
  await check(crop, 'crop.html', 'границу можно подвинуть мышью', `
    (() => {
      const cellWidth = () => document.querySelector('.grid-cell').getBoundingClientRect().width
      const before = cellWidth()
      const divider = document.querySelectorAll('.grid-edge-vertical')[0]
      const bounds = document.querySelector('[data-role="stage"]').getBoundingClientRect()
      divider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: bounds.left + 50, clientY: bounds.top + 50 }))
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: bounds.left + 20, clientY: bounds.top + 50 }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      return { before, after: cellWidth() }
    })()
  `, (v) => v && v.after < v.before)

  // Одна кнопка создаёт все шесть областей разом: по отдельности сохранять
  // каждую — ровно тот ритуал, ради избавления от которого это и сделано.
  await check(crop, 'crop.html', 'одна кнопка сохраняет все области сетки', `
    (async () => {
      document.querySelector('[data-role="save-all"]').click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      return document.querySelector('[data-role="status"]').textContent
    })()
  `, (v) => typeof v === 'string' && /Сохранено областей: 6/.test(v))


  // Помощник первой настройки. Главное, что здесь может молча сломаться:
  // шаги перестают переключаться, проверки показывают не тот исход, а данные
  // с предыдущего шага теряются при переходе на следующий.
  const setup = await openPage('setup.html')
  await check(setup, 'setup.html', 'открывается на первом шаге из четырёх', `
    (() => ({
      counter: document.getElementById('step-counter').textContent,
      obsShown: !document.getElementById('step-obs').hidden,
      terminalShown: !document.getElementById('step-terminal').hidden,
      backHidden: document.getElementById('back').hidden
    }))()
  `, (v) => v && /1 из 4/.test(v.counter || '') && v.obsShown === true
       && v.terminalShown === false && v.backHidden === true)

  await check(setup, 'setup.html', 'поля OBS заполнены из конфига',
    'document.getElementById("obs-url").value', (v) => v === config.obs.url)

  // Четыре исхода проверки OBS должны читаться по-разному, и это не
  // придирка: советовать «проверь, запущен ли OBS» тому, кому OBS только что
  // ответил «пароль не тот», — значит гонять его перепроверять исправное.
  await check(setup, 'setup.html', 'проверка OBS различает исходы и советует по делу', `
    (async () => {
      const button = document.getElementById('check-obs')
      const status = document.getElementById('obs-status')
      const results = []
      for (let i = 0; i < 4; i++) {
        button.click()
        await new Promise((resolve) => setTimeout(resolve, 250))
        results.push({ cls: status.className, text: status.textContent })
      }
      return results
    })()
  `, (v) => Array.isArray(v) && v.length === 4
       // Никто не отвечает: про OBS и галку сервера — уместно
       && /error/.test(v[0].cls) && /запущен ли OBS/.test(v[0].text)
       // Пароль не тот: OBS заведомо жив, речь должна идти только о пароле
       && /error/.test(v[1].cls) && /Пароль не подошёл/.test(v[1].text)
       && !/запущен ли OBS/.test(v[1].text)
       // Подключились, но буфер выключен — предупреждение, а не ошибка
       && /warn/.test(v[2].cls) && /буфер повтора/.test(v[2].text)
       && /ok/.test(v[3].cls))

  await check(setup, 'setup.html', 'переход на второй шаг сохраняет введённый пароль OBS', `
    (async () => {
      document.getElementById('obs-password').value = 'пароль-для-проверки'
      document.getElementById('next').click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      return {
        counter: document.getElementById('step-counter').textContent,
        terminalShown: !document.getElementById('step-terminal').hidden,
        backShown: !document.getElementById('back').hidden
      }
    })()
  `, (v) => v && /2 из 4/.test(v.counter || '') && v.terminalShown === true && v.backShown === true)

  await check(setup, 'setup.html', 'есть выбор терминала и проверка журнала показывает папку', `
    (async () => {
      const options = [...document.querySelectorAll('[data-role=terminal] .option')].map(b => b.textContent)
      document.getElementById('check-terminal').click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      const status = document.getElementById('terminal-status')
      return { options, cls: status.className, text: status.textContent }
    })()
  `, (v) => v && v.options.includes('Vataga') && v.options.includes('TigerTrade')
       && /ok/.test(v.cls) && /Logs/.test(v.text) && /последняя запись/.test(v.text))

  await check(setup, 'setup.html', 'третий шаг — области кадра, и он ещё не последний', `
    (async () => {
      document.getElementById('next').click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      return {
        counter: document.getElementById('step-counter').textContent,
        areasShown: !document.getElementById('step-areas').hidden,
        nextLabel: document.getElementById('next').textContent,
        skipHidden: document.getElementById('skip').hidden
      }
    })()
  `, (v) => v && /3 из 4/.test(v.counter || '') && v.areasShown === true
       && v.nextLabel === 'Дальше' && v.skipHidden === false)

  await check(setup, 'setup.html', 'сохранение повтора отчитывается об успехе и зовёт обратно', `
    (async () => {
      document.getElementById('save-replay').click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const status = document.getElementById('areas-status')
      return { cls: status.className, text: status.textContent }
    })()
  `, (v) => v && /ok/.test(v.cls) && /окно разметки/.test(v.text) && /последний шаг/.test(v.text))

  // Последний шаг отправляет в настройки: всё остальное живёт со значениями по
  // умолчанию, но один раз посмотреть на них стоит.
  await check(setup, 'setup.html', 'четвёртый шаг открывает настройки и заканчивает помощника', `
    (async () => {
      document.getElementById('next').click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const before = {
        counter: document.getElementById('step-counter').textContent,
        settingsShown: !document.getElementById('step-settings').hidden,
        nextLabel: document.getElementById('next').textContent,
        skipHidden: document.getElementById('skip').hidden,
        wired: typeof window.api.openSettings === 'function'
      }
      document.getElementById('open-settings').click()
      await new Promise((resolve) => setTimeout(resolve, 200))
      const status = document.getElementById('settings-status')
      return { ...before, statusCls: status.className, statusText: status.textContent }
    })()
  `, (v) => v && /4 из 4/.test(v.counter || '') && v.settingsShown === true
       && v.nextLabel === 'Готово' && v.skipHidden === true && v.wired === true
       && /ok/.test(v.statusCls) && /закончил/.test(v.statusText))

  for (const note of notes) console.log(note)
  if (problems.length > 0) {
    console.log('\nПРОБЛЕМЫ:')
    for (const problem of problems) console.log(`  - ${problem}`)
    app.exit(1)
  } else {
    console.log('\nВсе окна прошли проверку.')
    app.exit(0)
  }
}).catch((error) => {
  console.error('Смоук-тест упал:', error)
  app.exit(1)
})
