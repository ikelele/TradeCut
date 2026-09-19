const { Tray, Menu, nativeImage, screen } = require('electron')
const { getAssetPath } = require('./paths')

const STATUS_LABELS = {
  ok: 'Слежение активно, OBS подключён',
  warn: 'OBS не подключён / переподключение',
  error: 'Ошибка',
  paused: 'На паузе',
  bufferOff: 'OBS подключён, но Replay Buffer не активен'
}

const ICON_FILES = {
  ok: 'tray-ok.ico',
  warn: 'tray-warn.ico',
  error: 'tray-error.ico',
  paused: 'tray-paused.ico',
  flash: 'tray-flash.ico'
}
// Отдельного значка не заводим — переиспользуем ту же красную иконку, что и
// для error, просто с другим текстом статуса.
ICON_FILES.bufferOff = ICON_FILES.error

// Сколько равных частей предлагать, пока пользователь не настроил свои области
// через "Найти границы". Реальное значение приходит из настроек.
const DEFAULT_STAKAN_COUNT = 0
// Запасные списки на случай, если настройки ещё не дошли. Реальные значения
// задаются в окне настроек и приходят через createTray/setPresets.
// Единица среди скоростей обязана быть явным пунктом: как только у области
// появляется подменю, сам её заголовок перестаёт быть кликабельным, и
// "обычную скорость" иначе было бы не выбрать.
const DEFAULT_SPEED_PRESETS = [1, 2, 3, 5, 10]
const DEFAULT_REPLAY_PRESETS_SEC = [15, 30, 60, 180, 300]

// 90 -> "90 сек", 180 -> "3 мин". Минуты показываем только когда деление
// ровное: "2.5 мин" читается хуже, чем "150 сек".
function formatReplayLabel(seconds) {
  return seconds >= 60 && seconds % 60 === 0 ? (seconds / 60) + ' мин' : seconds + ' сек'
}

// В отличие от systray2 меню Electron пересобирается целиком на каждое
// обновление, поэтому никаких заранее созданных пустых "слотов" под будущие
// сделки не нужно — в меню ровно столько пунктов, сколько реально есть сделок.
// Ограничение остаётся одно, чисто визуальное: нативное меню Windows не
// прокручивается, поэтому в трее показываем только последние
// trayHistoryLimit сделок, а полный список — в отдельном окне ("Все сделки").

// Когда приложение стартует вместе с Windows, значок в трее оказывается
// пустым: место в области уведомлений занято, меню работает, а картинки нет.
// По логам видно, что файл иконки при этом читается нормально — значит дело
// не в чтении, а в самом значке. Две причины, обе закрыты ниже.
//
// 1. РАЗМЕР. Windows берёт для области уведомлений маленький значок (16px при
//    масштабе 100%, 24px при 150%). Electron же читает .ico ВСЕГДА как
//    256x256 — сколько бы размеров ни лежало внутри файла (проверено: и с
//    одним вариантом 32x32, и с шестью от 16 до 48 на выходе одно и то же).
//    Ужимать такой значок приходится самой Windows, и на холодном старте она
//    справляется не всегда. Поэтому уменьшаем изображение сами.
//
// 2. СЛОТ В ОБЛАСТИ УВЕДОМЛЕНИЙ. Если оболочка не завела значок как надо,
//    заменой картинки (setImage) это уже не лечится — нужен повторный
//    "добавить значок", а он делается только новым объектом Tray. Поэтому при
//    старте вместе с системой значок пересоздаётся целиком.
const ICON_RETRY_DELAYS_MS = [2000, 5000, 15000]
// Пересоздание значка делается ВСЕГДА, а не только при старте вместе с
// системой. Отличить одно от другого нечем: os.uptime() на Windows с
// включённым быстрым запуском (а он включён по умолчанию) не обнуляется при
// выключении — система рапортует аптайм в сотни часов, хотя её только что
// включили. Проверка "поднялись вместе с Windows" на такой машине не сработает
// ни разу, поэтому лучше два лишних холостых пересоздания на запуск, чем
// невидимый значок.
const TRAY_REBUILD_DELAYS_MS = [20000, 60000]

// Базовый размер значка в трее при масштабе экрана 100%.
const BASE_TRAY_ICON_PX = 16

function getTrayIconSizePx() {
  try {
    const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1
    return Math.max(BASE_TRAY_ICON_PX, Math.round(BASE_TRAY_ICON_PX * scaleFactor))
  } catch {
    // Экранов может не быть (например, при запуске из смоук-теста)
    return BASE_TRAY_ICON_PX
  }
}

// Читает иконку статуса и приводит её к размеру, который реально нужен трею.
// Вынесено из createTray, чтобы смоук-тест проверял ровно тот же путь.
function loadTrayIcon(fileName) {
  const image = nativeImage.createFromPath(getAssetPath(fileName))
  if (image.isEmpty()) return image
  const size = getTrayIconSizePx()
  return image.resize({ width: size, height: size, quality: 'best' })
}

function createTray({
  autostartAvailable,
  autostartChecked,
  trayHistoryLimit,
  cropPresets: initialCropPresets = [],
  stakanCount: initialStakanCount = DEFAULT_STAKAN_COUNT,
  speedPresets: initialSpeedPresets = DEFAULT_SPEED_PRESETS,
  replayPresetsSec: initialReplayPresets = DEFAULT_REPLAY_PRESETS_SEC,
  log = () => {},
  onToggleAutostart,
  onRestart,
  onExit,
  onPickStakan,
  onTogglePause,
  onOpenTradesWindow,
  onOpenCropWindow,
  onOpenCropFor,
  onOpenSettingsWindow,
  onSaveManualReplay
}) {
  let historyLimit = trayHistoryLimit
  let cropPresets = Array.isArray(initialCropPresets) ? initialCropPresets : []
  let stakanCount = initialStakanCount
  let speedPresets = initialSpeedPresets
  let replayPresetsSec = initialReplayPresets
  const iconCache = new Map()
  const getIcon = (state) => {
    const file = ICON_FILES[state] || ICON_FILES.warn
    const cached = iconCache.get(file)
    if (cached) return cached

    const image = loadTrayIcon(file)
    // Пустое изображение в кэш не кладём: следующая попытка должна прочитать
    // файл заново, иначе один неудачный старт делает иконку невидимой навсегда.
    if (!image.isEmpty()) iconCache.set(file, image)
    return image
  }

  let tray = new Tray(getIcon('warn'))

  let statusText = STATUS_LABELS.warn
  let currentRealIcon = 'warn'
  let paused = false
  let autostartOn = Boolean(autostartChecked)
  let recentClips = []
  let flashTimer = null
  const iconRetryTimers = []

  // Лёгкая попытка: заново прочитать файл (пустое изображение в кэш не попало)
  // и перерисовать значок. Когда всё в порядке — просто холостой вызов.
  function scheduleIconRefresh() {
    let reported = false
    for (const delayMs of ICON_RETRY_DELAYS_MS) {
      iconRetryTimers.push(setTimeout(() => {
        if (flashTimer) return // мигание само вернёт актуальную иконку
        const image = getIcon(currentRealIcon)
        if (image.isEmpty()) {
          if (!reported) {
            reported = true
            log('Иконка трея не прочиталась — пробую ещё раз (место в трее занято, но значка не видно)')
          }
          return
        }
        tray.setImage(image)
      }, delayMs))
    }
  }

  // Тяжёлая попытка: пересоздать значок целиком. Нужна там, где замены
  // картинки недостаточно — если область уведомлений вообще не завела значок
  // как надо, помогает только повторное добавление, то есть новый Tray.
  function rebuildTray() {
    if (flashTimer) {
      clearTimeout(flashTimer)
      flashTimer = null
    }
    try {
      const previous = tray
      // Кэш чистим заодно: масштаб экрана к этому моменту мог уже стать
      // настоящим (на старте системы он бывает временным).
      iconCache.clear()
      // Сначала новый значок, потом убираем старый — чтобы трей не оставался
      // пустым в промежутке.
      tray = new Tray(getIcon(currentRealIcon))
      previous.destroy()
      refreshMenu()
      log('Значок в трее пересоздан (страховка от пустого места в области уведомлений)')
    } catch (error) {
      log(`Не удалось пересоздать значок в трее: ${error.message}`)
    }
  }

  if (getIcon('warn').isEmpty()) {
    log('Иконка трея при запуске оказалась пустой — включаю повторные попытки')
  }
  scheduleIconRefresh()
  for (const delayMs of TRAY_REBUILD_DELAYS_MS) {
    iconRetryTimers.push(setTimeout(rebuildTray, delayMs))
  }

  // Области обрезки для сделки. Порядок предпочтения такой:
  //   1. свои области, настроенные по кадру, — они точные;
  //   2. деление на stakanCount равных частей, если оно задано;
  //   3. ничего — тогда подменю сделки предлагает ручную обрезку.
  // Третий случай штатный: у нового пользователя не настроено ни то, ни другое,
  // и предлагать ему деление на выдуманное число частей бессмысленно.
  function buildAreaEntries() {
    if (cropPresets.length > 0) {
      return cropPresets.map((preset) => ({
        label: preset.name,
        options: { cropRect: preset, cropPresetName: preset.name }
      }))
    }
    return Array.from({ length: stakanCount }, (_, k) => ({
      label: `Стакан ${k + 1}`,
      stakanIndex: k + 1,
      options: { stakanCount }
    }))
  }

  function buildTradeSubmenu(entry) {
    const areas = buildAreaEntries()
    // Ни своих областей, ни деления на части — резать нечего. Вместо пустого
    // подменю (оно выглядело бы как поломка) отправляем в окно обрезки, где
    // область и настраивается.
    if (areas.length === 0) {
      return [{
        label: 'Обрезать вручную...',
        toolTip: 'Области кадра ещё не настроены — их задают в окне обрезки',
        click: () => onOpenCropFor(entry.clipPath)
      }]
    }

    return areas.map((area) => ({
      label: area.label,
      submenu: speedPresets.map((speedFactor) => ({
        label: speedFactor === 1 ? 'Обычная скорость' : `Ускорение x${speedFactor}`,
        click: () => onPickStakan(entry.clipPath, area.stakanIndex ?? null, { ...area.options, speedFactor })
      }))
    }))
  }

  function buildMenuTemplate() {
    const template = [
      { label: statusText, enabled: false },
      { type: 'separator' },
      {
        label: paused ? 'Возобновить' : 'Приостановить',
        toolTip: 'Остановить слежение и отключиться от OBS, пока не торгуешь',
        click: () => onTogglePause()
      }
    ]

    // Доступно всегда, независимо от того, были ли сегодня сделки: это просто
    // "забрать последние N секунд из буфера прямо сейчас".
    template.push({
      label: 'Сохранить повтор',
      toolTip: 'Забрать последние N секунд из буфера OBS прямо сейчас',
      submenu: replayPresetsSec.map((seconds) => ({
        label: formatReplayLabel(seconds),
        click: () => onSaveManualReplay(seconds)
      }))
    })

    const shown = recentClips.slice(0, historyLimit)
    if (shown.length > 0) {
      template.push({
        label: 'Последние сделки',
        submenu: shown.map((entry) => ({
          label: entry.label,
          toolTip: entry.clipPath,
          submenu: buildTradeSubmenu(entry)
        }))
      })
    } else {
      template.push({ label: 'Сделок пока нет', enabled: false })
    }

    template.push(
      { label: `Открыть TradeCut (сделок: ${recentClips.length})`, click: () => onOpenTradesWindow() },
      { label: 'Обрезать произвольный файл...', click: () => onOpenCropWindow() },
      { type: 'separator' },
      { label: 'Настройки...', click: () => onOpenSettingsWindow() },
      {
        label: 'Запускать при старте Windows',
        type: 'checkbox',
        checked: autostartOn,
        enabled: Boolean(autostartAvailable),
        toolTip: autostartAvailable ? '' : 'Доступно только в собранном приложении',
        click: () => onToggleAutostart()
      },
      {
        label: 'Перезапустить',
        toolTip: 'Остановить и заново подключиться к OBS/логам',
        click: () => onRestart()
      },
      { type: 'separator' },
      { label: 'Выход', click: () => onExit() }
    )

    return template
  }

  function refreshMenu() {
    tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()))
    tray.setToolTip(`TradeCut — ${statusText}`)
  }

  refreshMenu()

  function setStatus(state, customText) {
    statusText = customText || STATUS_LABELS[state] || state
    currentRealIcon = ICON_FILES[state] ? state : 'warn'
    // Во время мигания иконку не трогаем — её вернёт таймер мигания, уже к
    // новому актуальному статусу.
    if (!flashTimer) tray.setImage(getIcon(currentRealIcon))
    refreshMenu()
  }

  // Кратковременно мигает иконкой (например, при готовом клипе) и возвращает
  // её обратно к текущему настоящему статусу — вместо toast-уведомления на
  // каждую сделку, которое быстро надоедает при стабильной работе.
  function flashIcon(durationMs = 500) {
    if (flashTimer) clearTimeout(flashTimer)
    tray.setImage(getIcon('flash'))
    flashTimer = setTimeout(() => {
      flashTimer = null
      tray.setImage(getIcon(currentRealIcon))
    }, durationMs)
  }

  return {
    setStatus,
    flashIcon,
    setAutostartChecked: (checked) => {
      autostartOn = Boolean(checked)
      refreshMenu()
    },
    setPauseState: (isPaused) => {
      paused = Boolean(isPaused)
      refreshMenu()
    },
    updateRecentClips: (clips) => {
      recentClips = clips
      refreshMenu()
    },
    setTrayHistoryLimit: (limit) => {
      historyLimit = limit
      refreshMenu()
    },
    setCropPresets: (presets) => {
      cropPresets = Array.isArray(presets) ? presets : []
      refreshMenu()
    },
    setPresets: ({ speedPresets: speeds, replayPresetsSec: replays }) => {
      if (Array.isArray(speeds) && speeds.length > 0) speedPresets = speeds
      if (Array.isArray(replays) && replays.length > 0) replayPresetsSec = replays
      refreshMenu()
    },
    setStakanCount: (count) => {
      // Ноль — законное значение ("не делить кадр"), поэтому проверяем на
      // число, а не на "больше нуля".
      const parsed = Number(count)
      stakanCount = Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_STAKAN_COUNT
      refreshMenu()
    },
    destroy: () => {
      if (flashTimer) clearTimeout(flashTimer)
      for (const timer of iconRetryTimers) clearTimeout(timer)
      tray.destroy()
    }
  }
}

module.exports = { createTray, loadTrayIcon, getTrayIconSizePx, formatReplayLabel, STATUS_LABELS, DEFAULT_SPEED_PRESETS, DEFAULT_STAKAN_COUNT }
