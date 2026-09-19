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

// Срок ожидания обязателен: проверка, которая ждёт обещания, никогда не
// выполнимого, висит вечно и уносит с собой весь прогон. Падение тут гораздо
// полезнее — оно хотя бы называет виновника.
const CHECK_TIMEOUT_MS = 20000

async function check(win, page, description, script, validate) {
  try {
    const value = await Promise.race([
      win.webContents.executeJavaScript(script),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('проверка не ответила за 20с')), CHECK_TIMEOUT_MS))
    ])
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
  // Кнопка "Выбрать файл..." отдаёт тестовый клип — так проверки редактора идут
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
  // Окно разметки областей получает клип при открытии
  ipcMain.handle('areas:clip', () => path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv'))
  ipcMain.on('areas:open', () => {})
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

  // Разметка областей — отдельное окно, и у него одна задача: кадр занимает
  // всё место, а человек говорит, на сколько частей делить. Раньше это жило
  // вперемешку с обрезкой клипа, и кадру доставались остатки.
  const areas = await openPage('areas.html')

  await check(areas, 'areas.html', 'кадр занимает всё свободное место и не вылезает за него', `
    (() => {
      const frame = document.getElementById('frame')
      const stage = document.getElementById('stage').getBoundingClientRect()
      return {
        available: [frame.clientWidth, frame.clientHeight],
        stage: [Math.round(stage.width), Math.round(stage.height)]
      }
    })()
  `, (v) => v && v.stage[0] > 300
       // Вылезать нельзя ни по одной стороне: на 3440x1440 кадр выходил
       // высотой 1304 при 1100 доступных, и нижняя граница — та самая, которую
       // тянут мышью, — оказывалась за краем окна.
       && v.stage[0] <= v.available[0] + 1 && v.stage[1] <= v.available[1] + 1
       // И при этом упирается хотя бы в одну сторону, иначе место простаивает
       && (v.stage[0] >= v.available[0] - 1 || v.stage[1] >= v.available[1] - 1))

  await check(areas, 'areas.html', 'число стаканов сразу рисует пронумерованные области', `
    (async () => {
      const input = document.getElementById('count')
      input.value = '6'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 150))
      return {
        cells: document.querySelectorAll('.grid-cell').length,
        numbers: [...document.querySelectorAll('.grid-number')].map((el) => el.textContent).join(''),
        dividers: document.querySelectorAll('.grid-edge-vertical').length,
        edges: document.querySelectorAll('.grid-edge-horizontal').length,
        saveEnabled: !document.getElementById('save').disabled
      }
    })()
  `, (v) => v && v.cells === 6 && v.numbers === '123456' && v.dividers === 5
       && v.edges === 2 && v.saveEnabled === true)

  await check(areas, 'areas.html', 'границу можно подвинуть мышью', `
    (() => {
      const width = () => document.querySelector('.grid-cell').getBoundingClientRect().width
      const before = width()
      const divider = document.querySelectorAll('.grid-edge-vertical')[0]
      const bounds = document.getElementById('stage').getBoundingClientRect()
      divider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: bounds.left + 100, clientY: bounds.top + 50 }))
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: bounds.left + 40, clientY: bounds.top + 50 }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      return { before, after: width() }
    })()
  `, (v) => v && v.after < v.before)

  // Верхняя и нижняя границы — ими отрезается заголовок окна терминала.
  await check(areas, 'areas.html', 'верхнюю границу тоже можно подвинуть', `
    (() => {
      const top = () => document.querySelector('.grid-cell').getBoundingClientRect().top
      const before = top()
      const edge = document.querySelectorAll('.grid-edge-horizontal')[0]
      const bounds = document.getElementById('stage').getBoundingClientRect()
      edge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: bounds.left + 100, clientY: bounds.top }))
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: bounds.left + 100, clientY: bounds.top + 40 }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      return { before, after: top() }
    })()
  `, (v) => v && v.after > v.before)

  await check(areas, 'areas.html', 'одна кнопка сохраняет все области разом', `
    (async () => {
      document.getElementById('save').click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const status = document.getElementById('status')
      return { cls: status.className, text: status.textContent }
    })()
  `, (v) => v && /ok/.test(v.cls) && /сохранено областей — 6/i.test(v.text))

  const help = await openPage('help.html')
  await check(help, 'help.html', 'справка загрузилась и в ней есть разделы',
    '[...document.querySelectorAll(".help-block h2")].map(h => h.textContent)',
    (v) => Array.isArray(v) && v.length >= 4)
  await check(help, 'help.html', 'в справке есть шаги первого запуска',
    'document.querySelectorAll(".help-block ol li").length', (v) => v >= 4)
  await check(help, 'help.html', 'кнопка журнала проброшена в окно',
    'typeof window.api.openLogsFolder === "function" && !!document.getElementById("open-logs")', (v) => v === true)

  // Окно обрезки — редактор: кадр забирает всё место, а тонкие полосы сверху
  // и снизу держат управление. Раньше это была обычная страница с кадром
  // посреди неё, и замеры на пяти типовых экранах давали кадру 24–26% высоты
  // окна на ноутбуке, а кнопку «Вырезать» не показывали ни на одном.
  const crop = await openPage('crop.html')

  await check(crop, 'crop.html', 'кнопка "Вырезать" заблокирована без файла',
    'document.getElementById("run").disabled', (v) => v === true)

  // Главное, ради чего окно переделывали: ничего не должно уезжать за край.
  await check(crop, 'crop.html', 'окно не прокручивается, «Вырезать» и настройки видны сразу', `
    (() => {
      const bottom = (id) => Math.round(document.getElementById(id).getBoundingClientRect().bottom)
      return {
        height: window.innerHeight,
        doc: Math.round(document.body.scrollHeight),
        run: bottom('run'),
        settings: bottom('crop-form')
      }
    })()
  `, (v) => v && v.doc <= v.height + 1 && v.run <= v.height && v.settings <= v.height)

  await check(crop, 'crop.html', 'по умолчанию выбран "Весь кадр", даже когда есть пресеты',
    `(() => {
       const buttons = [...document.querySelectorAll("[data-role=stakan] .option")]
       const pressed = buttons.filter(b => b.getAttribute('aria-pressed') === 'true')
       return { first: buttons[0].textContent, pressed: pressed.map(b => b.textContent) }
     })()`, (v) => v.first === 'Весь кадр' && v.pressed.length === 1 && v.pressed[0] === 'Весь кадр')

  await check(crop, 'crop.html', 'без области, скорости и обрезки работа не запускается',
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

  await check(crop, 'crop.html', 'файл бросают прямо на кадр',
    '!!document.getElementById("frame") && !document.getElementById("dropzone")', (v) => v === true)
  await check(crop, 'crop.html', 'getPathForFile проброшен в окно',
    'typeof window.api.getPathForFile', (v) => v === 'function')

  // Идём тем же путём, что и пользователь: выбрать файл кнопкой. Раньше здесь
  // видео подсовывалось напрямую в элемент, и из-за этого поиск границ не знал
  // пути к файлу — проверка этого не замечала.
  await check(crop, 'crop.html', 'видео открывается из окна и рамка ставится по размеру кадра', `
    new Promise((resolve) => {
      const video = document.getElementById('video')
      const box = document.getElementById('box')
      video.addEventListener('loadedmetadata', () => setTimeout(() => resolve({
        natural: [video.videoWidth, video.videoHeight],
        boxHidden: box.hidden,
        // Если CSP запретит присваивание style, ширина останется пустой
        boxWidth: box.style.width,
        sizeText: document.getElementById('size').textContent
      }), 200), { once: true })
      video.addEventListener('error', () => resolve({ error: video.error && video.error.code }), { once: true })
      setTimeout(() => resolve({ error: 'timeout' }), 6000)

      document.getElementById('pick').click()
    })
  `, (v) => v && !v.error && v.natural[0] === 320 && v.boxHidden === false
       && v.boxWidth.endsWith('px') && v.sizeText.includes('целиком'))

  // Кадр обязан целиком помещаться в отведённое место. Пока это считал сам
  // браузер (ширина 100% + пропорции), на 3440x1440 он выходил высотой 1304
  // при 1100 доступных, и низ картинки уезжал за край окна.
  await check(crop, 'crop.html', 'кадр вписан в отведённое место целиком', `
    (() => {
      const frame = document.getElementById('frame')
      const stage = document.getElementById('stage')
      const video = document.getElementById('video')
      const box = stage.getBoundingClientRect()
      return {
        available: [frame.clientWidth, frame.clientHeight],
        stage: [Math.round(box.width), Math.round(box.height)],
        // Коробка сцены обязана совпадать с картинкой — на этом держится
        // пересчёт координат рамки
        sameSize: stage.clientWidth === video.clientWidth && stage.clientHeight === video.clientHeight
      }
    })()
  `, (v) => v && v.sameSize === true
       && v.stage[0] <= v.available[0] + 1 && v.stage[1] <= v.available[1] + 1
       && (v.stage[0] >= v.available[0] - 1 || v.stage[1] >= v.available[1] - 1))

  // Нажатие на кнопку области должно показывать её прямо на кадре — иначе по
  // названию «Левый стакан» не понять, что именно вырежется.
  await check(crop, 'crop.html', 'выбор области сразу виден на кадре', `
    (async () => {
      const buttons = [...document.querySelectorAll("[data-role=stakan] .option")]
      const size = () => document.getElementById('size').textContent

      buttons[0].click() // «Весь кадр»
      await new Promise((resolve) => setTimeout(resolve, 200))
      const whole = size()

      buttons[1].click()
      await new Promise((resolve) => setTimeout(resolve, 200))
      return { whole, area: size(), label: buttons[1].textContent }
    })()
  `, (v) => v && v.whole.startsWith('320x240 целиком') && v.area.startsWith('160x'))

  // Дорожка обрезки по времени: ручки должны менять то же значение, которое
  // уходит в ffmpeg, — иначе на дорожке одно, а вырежется другое.
  await check(crop, 'crop.html', 'ручка на дорожке задаёт обрезку и та уходит в параметры', `
    (() => {
      const timeline = document.getElementById('timeline')
      const handle = timeline.querySelector('[data-trim="end"]')
      const bounds = timeline.getBoundingClientRect()
      const before = editor.getTrim()
      handle.setPointerCapture = () => {}
      handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: bounds.right, clientY: bounds.top + 10, bubbles: true, pointerId: 2 }))
      // Тянем ручку конца к середине дорожки — отрезаем половину клипа
      handle.dispatchEvent(new PointerEvent('pointermove', { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + 10, bubbles: true, pointerId: 2 }))
      handle.dispatchEvent(new PointerEvent('pointerup', { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + 10, bubbles: true, pointerId: 2 }))
      return { before, after: editor.getTrim(), label: document.getElementById('trim-label').textContent }
    })()
  `, (v) => v && v.before.trimEnd === 0 && v.after.trimEnd > 0 && v.label.includes('Останется'))

  // После правки диапазона «плей» обязан показать его с начала. Раньше он
  // прыгал к началу только когда курсор оказывался снаружи, и получалось
  // непредсказуемо: то с начала выделения, то с середины.
  await check(crop, 'crop.html', 'после правки диапазона плей идёт с его начала', `
    (async () => {
      const video = document.getElementById('video')
      const timeline = document.getElementById('timeline')
      const bounds = timeline.getBoundingClientRect()

      const handle = timeline.querySelector('[data-trim="start"]')
      handle.setPointerCapture = () => {}
      const x = bounds.left + bounds.width * 0.2
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: bounds.top + 5, pointerId: 3 }))
      handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: bounds.top + 5, pointerId: 3 }))
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: bounds.top + 5, pointerId: 3 }))
      await new Promise((r) => setTimeout(r, 150))

      // Уводим курсор в середину диапазона — плей всё равно должен начать с начала
      video.currentTime = video.duration * 0.3
      await new Promise((r) => setTimeout(r, 150))
      document.getElementById('play').click()
      const started = video.currentTime
      video.pause()
      return { started, expected: video.duration * 0.2 }
    })()
  `, (v) => v && Math.abs(v.started - v.expected) < 0.3)

  // Отметить границу по текущему кадру — самый быстрый способ обрезать:
  // смотришь и режешь, не целясь ручкой в дорожку.
  await check(crop, 'crop.html', 'кнопки «[» и «]» режут по текущему кадру', `
    (async () => {
      const video = document.getElementById('video')
      document.getElementById('trim-reset').click()
      await new Promise((r) => setTimeout(r, 150))

      video.currentTime = 2
      await new Promise((r) => setTimeout(r, 200))
      document.getElementById('mark-start').click()

      video.currentTime = 6
      await new Promise((r) => setTimeout(r, 200))
      document.getElementById('mark-end').click()
      await new Promise((r) => setTimeout(r, 150))

      return { trim: editor.getTrim(), duration: video.duration }
    })()
  `, (v) => v && Math.abs(v.trim.trimStart - 2) < 0.2 && Math.abs(v.duration - v.trim.trimEnd - 6) < 0.2)

  // Выделение целиком: длина уже подошла, надо только сдвинуть момент.
  await check(crop, 'crop.html', 'выделение двигается целиком, не меняя длины', `
    (async () => {
      const range = document.getElementById('range')
      const timeline = document.getElementById('timeline')
      const bounds = timeline.getBoundingClientRect()
      const before = editor.getTrim()

      range.setPointerCapture = () => {}
      const from = bounds.left + bounds.width * 0.35
      range.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: from, clientY: bounds.top + 5, pointerId: 4 }))
      range.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: from + bounds.width * 0.15, clientY: bounds.top + 5, pointerId: 4 }))
      range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: from + bounds.width * 0.15, clientY: bounds.top + 5, pointerId: 4 }))
      await new Promise((r) => setTimeout(r, 150))

      const after = editor.getTrim()
      const duration = document.getElementById('video').duration
      return {
        movedBy: after.trimStart - before.trimStart,
        lengthBefore: duration - before.trimStart - before.trimEnd,
        lengthAfter: duration - after.trimStart - after.trimEnd
      }
    })()
  `, (v) => v && v.movedBy > 0.3 && Math.abs(v.lengthAfter - v.lengthBefore) < 0.3)

  // Щелчок по выделению — всё-таки перемотка: выделение по умолчанию занимает
  // всю дорожку и иначе перекрыло бы её целиком.
  await check(crop, 'crop.html', 'щелчок по выделению перематывает, а не двигает его', `
    (async () => {
      const video = document.getElementById('video')
      const range = document.getElementById('range')
      const timeline = document.getElementById('timeline')
      document.getElementById('trim-reset').click()
      await new Promise((r) => setTimeout(r, 150))

      const bounds = timeline.getBoundingClientRect()
      const x = bounds.left + bounds.width * 0.5
      const before = editor.getTrim()
      range.setPointerCapture = () => {}
      range.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: bounds.top + 5, pointerId: 5 }))
      range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: bounds.top + 5, pointerId: 5 }))
      await new Promise((r) => setTimeout(r, 200))
      return { at: video.currentTime, expected: video.duration * 0.5, trim: editor.getTrim(), before }
    })()
  `, (v) => v && Math.abs(v.at - v.expected) < 0.4 && v.trim.trimStart === v.before.trimStart)

  await check(crop, 'crop.html', 'повтор по кругу не останавливает клип в конце выделения', `
    (async () => {
      const video = document.getElementById('video')
      const loop = document.getElementById('loop')
      document.getElementById('trim-reset').click()
      await new Promise((r) => setTimeout(r, 150))

      loop.click()
      const pressed = loop.getAttribute('aria-pressed')
      video.currentTime = Math.max(0, video.duration - 0.4)
      const started = video.play()
      if (started && started.catch) started.catch(() => {})
      await new Promise((r) => setTimeout(r, 900))
      const stillPlaying = !video.paused
      const at = video.currentTime
      video.pause()
      loop.click()
      return { pressed, stillPlaying, at, duration: video.duration }
    })()
  `, (v) => v && v.pressed === 'true' && v.stillPlaying === true && v.at < v.duration - 0.2)

  await check(crop, 'crop.html', 'пробел запускает и останавливает воспроизведение', `
    (async () => {
      const video = document.getElementById('video')
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
      await new Promise((r) => setTimeout(r, 250))
      const playing = !video.paused
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
      await new Promise((r) => setTimeout(r, 150))
      return { playing, stopped: video.paused }
    })()
  `, (v) => v && v.playing === true && v.stopped === true)

  await check(crop, 'crop.html', 'текущее время видно рядом с дорожкой',
    'document.getElementById("time").textContent',
    // Без регулярного выражения намеренно: слэш внутри него — ровно то, на чём
    // этот файл уже один раз перестал разбираться.
    (v) => typeof v === 'string' && v.includes(' / ') && v.split(' / ').every((part) => /^\d+:\d\d?\.\d$/.test(part.trim())))

  await check(crop, 'crop.html', 'числовых полей обрезки больше нет',
    '!document.getElementById("trim-start") && !document.getElementById("trim-end")', (v) => v === true)

  // Кадр должен звучать: раньше видео стояло с атрибутом muted, и звук при
  // проигрывании не шёл вовсе.
  await check(crop, 'crop.html', 'звук включён и выключается кнопкой', `
    (() => {
      const video = document.getElementById('video')
      const button = document.getElementById('sound')
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

  // Рамка идёт последней: она отменяет выбор области кнопкой, и проверять
  // после неё выбор кнопками было бы уже не на чем.
  await check(crop, 'crop.html', 'рамка тянется мышью и пересчитывается в пиксели кадра', `
    (() => {
      const box = document.getElementById('box')
      const handle = box.querySelector('[data-handle="e"]')
      const before = box.style.width
      const bounds = box.getBoundingClientRect()
      handle.setPointerCapture = () => {}
      handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: bounds.right, clientY: bounds.top + 10, bubbles: true, pointerId: 1 }))
      handle.dispatchEvent(new PointerEvent('pointermove', { clientX: bounds.right - 60, clientY: bounds.top + 10, bubbles: true, pointerId: 1 }))
      handle.dispatchEvent(new PointerEvent('pointerup', { clientX: bounds.right - 60, clientY: bounds.top + 10, bubbles: true, pointerId: 1 }))
      return {
        before,
        after: box.style.width,
        size: document.getElementById('size').textContent,
        rect: editor.getRect(),
        pressed: [...document.querySelectorAll("[data-role=stakan] .option")].filter(b => b.getAttribute('aria-pressed') === 'true').length
      }
    })()
  `, (v) => v && v.before !== v.after && v.size.includes(' из 320x240')
       && v.rect.sourceWidth === 320 && v.pressed === 0)

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
