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

  const settings = await openPage('settings.html')
  await check(settings, 'settings.html', 'preload отдал window.api', 'typeof window.api', (v) => v === 'object')
  await check(settings, 'settings.html', 'поле адреса OBS заполнено из конфига',
    'document.getElementById("obs-url").value', (v) => typeof v === 'string' && v.length > 0)
  await check(settings, 'settings.html', 'чекбокс объединения сделок отражает конфиг',
    'document.getElementById("merge-enabled").checked', (v) => v === Boolean(config.clip.mergeTradesEnabled))
  // Ноль тут значит "не делить кадр", и поле должно быть ПУСТЫМ: ноль в графе
  // "на сколько частей" выглядит как поломка, а не как осознанная настройка.
  await check(settings, 'settings.html', 'количество частей кадра: ноль показывается пустым полем', `
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
  await check(settings, 'settings.html', 'галка "резать из трея без звука" отражает конфиг',
    'document.getElementById("tray-crop-muted").checked', (v) => v === Boolean(config.clip.trayCropMuted))
  await check(settings, 'settings.html', 'галка "оставлять отдельные клипы серии" отражает конфиг',
    'document.getElementById("keep-parts").checked', (v) => v === Boolean(config.clip.keepMergedParts))
  await check(settings, 'settings.html', 'из настроек можно открыть справку',
    'typeof window.api.openHelp === "function" && !!document.getElementById("open-help")', (v) => v === true)
  await check(settings, 'settings.html', 'списки пресетов показываются строкой через запятую', `
    (() => {
      const replay = document.getElementById('replay-presets')
      const speed = document.getElementById('speed-presets')
      return { replay: replay.value, speed: speed.value }
    })()
  `, (v) => v && v.replay === config.clip.replayPresetsSec.join(', ')
       && v.speed === config.clip.speedPresets.join(', '))
  await check(settings, 'settings.html', 'список своих областей кадра есть',
    '!!document.querySelector("[data-role=preset-list]")', (v) => v === true)
  await check(settings, 'settings.html', 'из настроек можно открыть окно настройки областей',
    'typeof window.api.openCropWindow === "function" && !!document.getElementById("open-crop")', (v) => v === true)
  await check(settings, 'settings.html', 'сохранение из настроек не теряет настроенные области', `
    (() => {
      const collected = collectForm()
      return Array.isArray(collected.clip.cropPresets)
    })()
  `, (v) => v === true)
  await check(settings, 'settings.html', 'папка клипов заполнена',
    'document.getElementById("output-dir").value', (v) => typeof v === 'string' && v.length > 0)
  await check(settings, 'settings.html', 'папка для повторов из трея заполнена',
    'document.getElementById("manual-replay-dir").value', (v) => v === config.clip.manualReplayOutputDir)
  await check(settings, 'settings.html', 'есть переключатель терминалов Vataga/TigerTrade',
    '[...document.querySelectorAll("[data-role=terminal] .option")].map(b => b.textContent)',
    (v) => Array.isArray(v) && v.includes('Vataga') && v.includes('TigerTrade'))
  await check(settings, 'settings.html', 'выбран терминал из конфига',
    'document.querySelector("[data-role=terminal] .option[aria-pressed=true]").textContent',
    (v) => v === (config.terminal.type === 'tigertrade' ? 'TigerTrade' : 'Vataga'))
  await check(settings, 'settings.html', 'переключение терминала меняет подсказку про путь', `
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

  const trades = await openPage('trades.html')
  await check(trades, 'trades.html', 'список сделок отрисован',
    'document.querySelectorAll(".trade-item").length', (v) => v === 1)
  await check(trades, 'trades.html', 'кнопка "Вырезать" заблокирована до выбора сделки',
    'document.getElementById("run").disabled', (v) => v === true)
  await check(trades, 'trades.html', 'выбор сделки разблокирует кнопку',
    'document.querySelector(".trade-item").click(); document.getElementById("run").disabled', (v) => v === false)

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
