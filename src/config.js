const fs = require('fs')
const path = require('path')
const { getAppBaseDir } = require('./appPaths')

const CONFIG_PATH = path.join(getAppBaseDir(), 'config.json')

const { sanitizePresetName } = require('./cropRect')

const SUPPORTED_TERMINALS = ['vataga', 'tigertrade']
const MAX_CROP_PRESETS = 12
const MAX_LIST_PRESETS = 10

// Списки пресетов (длительности повтора, множители скорости) приходят из окна
// настройки строкой вида "15, 30, 60". Всё, что не похоже на положительное
// число, молча отбрасываем: до меню такие значения дойти не должны, а падать
// из-за одной опечатки в списке — перебор. Если не осталось ничего осмысленного,
// возвращаем значения по умолчанию: меню без единого пункта хуже, чем меню с
// привычными.
function normalizeNumberList(value, fallback, { min, max, round }) {
  // Из строки достаём именно числа, а не режем её по разделителям: тогда
  // "15, 30", "15 30" и "15,30," разбираются одинаково, а лишние запятые и
  // пробелы никого не смущают. Точка — десятичный разделитель (для скорости
  // вроде 1.5), запятая всегда разделяет значения.
  const source = Array.isArray(value)
    ? value
    // Минус захватываем намеренно, чтобы отрицательное значение честно
    // отбросила проверка ниже, а не превратило в положительное.
    : (String(value ?? '').match(/-?\d+(?:\.\d+)?/g) || [])

  const numbers = []
  for (const item of source) {
    const parsed = Number(item)
    if (!Number.isFinite(parsed)) continue
    // Значения вне разумных пределов ОТБРАСЫВАЕМ, а не подгоняем: подгонка
    // превратила бы опечатку в тихо работающее чужое значение (например, -5
    // стало бы 5), и человек бы не понял, почему в меню не то, что он ввёл.
    if (parsed < min || parsed > max) continue
    const final = round ? Math.round(parsed) : Math.round(parsed * 100) / 100
    if (final < min || numbers.includes(final)) continue
    numbers.push(final)
    if (numbers.length >= MAX_LIST_PRESETS) break
  }

  // Пустой список означал бы меню без единого пункта — это хуже, чем меню с
  // привычными значениями, поэтому возвращаем умолчание.
  return numbers.length > 0 ? numbers.sort((a, b) => a - b) : [...fallback]
}

// Пресеты приходят из окна, поэтому в файл пускаем только то, что осмысленно:
// имя и четыре положительных числа. Кривые записи молча отбрасываем — иначе
// они дойдут до ffmpeg и обрезка упадёт уже во время работы.
function normalizeCropPresets(value) {
  if (!Array.isArray(value)) return []
  const presets = []
  for (const raw of value) {
    if (!raw) continue
    const name = sanitizePresetName(raw.name)
    const numbers = ['x', 'y', 'width', 'height', 'sourceWidth', 'sourceHeight']
      .map((key) => Math.round(Number(raw[key])))
    const [x, y, width, height, sourceWidth, sourceHeight] = numbers
    if (!name) continue
    if (![x, y, width, height, sourceWidth, sourceHeight].every(Number.isFinite)) continue
    if (width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) continue
    if (x < 0 || y < 0) continue
    presets.push({ name, x, y, width, height, sourceWidth, sourceHeight })
    if (presets.length >= MAX_CROP_PRESETS) break
  }
  return presets
}

const DEFAULT_CONFIG = {
  obs: {
    url: 'ws://127.0.0.1:4455',
    password: '',
    // Как часто (в секундах) проверять, активен ли Replay Buffer, пока OBS
    // подключён — лёгкий запрос статуса, без переподключений. Если буфер
    // выключен, иконка в трее становится красной (см. tray.js).
    replayBufferCheckIntervalSec: 60
  },
  terminal: {
    // За логами какого терминала следить: 'vataga' или 'tigertrade'.
    // Переключается в окне настроек (трей -> "Настройки...").
    type: 'tigertrade',
    // Оставь пустым, чтобы использовать стандартный путь для выбранного
    // терминала:
    //   vataga     -> %APPDATA%\Vataga\Vataga.terminal\Logs
    //   tigertrade -> %APPDATA%\TigerTrade (внутри — Data\Logs\WorkLog_*.log,
    //                 в том числе в подпапках профилей)
    logsDirOverride: ''
  },
  clip: {
    // Сколько секунд захватить ДО входа в сделку и ПОСЛЕ выхода. До входа
    // запас больше: там обычно видно, почему в сделку вошли.
    paddingBeforeSec: 5,
    paddingAfterSec: 2,
    outputDir: './clips',
    // Куда складывать клипы, обрезанные по ширине под стакан (см. stakanCrop.js) —
    // отдельно от обычных клипов. Внутри так же создаются подпапки по дате:
    // stakanOutputDir/ГГГГ-ММ-ДД/
    stakanOutputDir: './clips-stakan',
    // Куда складывать повторы, сохранённые вручную из меню трея
    // ("Сохранить повтор" -> 15 сек / 30 сек / 1 мин / ...). Отдельно от
    // клипов сделок: это не сделка, а просто кусок буфера по требованию.
    manualReplayOutputDir: './replays',
    // Если позиция открыта дольше этого порога и всё ещё не закрыта — на
    // всякий случай делаем дополнительный SaveReplayBuffer и вырезаем короткий
    // чекпоинт вокруг входа (см. clipper.js/createEntryCheckpoint). Пригождается,
    // только если сделка реально окажется длиннее буфера OBS.
    longTradeThresholdSec: 120,
    // Длина чекпоинта вокруг входа и куска вокруг выхода при склейке длинной
    // сделки — настраиваются отдельно
    checkpointEntrySnippetSec: 20,
    checkpointExitSnippetSec: 20,
    // Удалять ли исходный файл реплея OBS (весь буфер целиком, из которого
    // вырезается клип) сразу после успешной нарезки — он больше не нужен, а
    // без удаления копится на диске с каждой сделкой. Не трогает файлы,
    // сохранённые вручную через сам OBS — только те, что запросило это
    // приложение.
    deleteSourceReplays: true,
    // Объединение нескольких сделок подряд по одному символу в один
    // дополнительный клип (от входа в первую сделку "пачки" до выхода из
    // последней) — см. clipper.js/createMergedClipFromReplay и app.js.
    // 1 включено, 0 выключено. Обычные отдельные клипы всё равно создаются
    // как раньше — это ДОПОЛНИТЕЛЬНЫЙ клип поверх них, а не замена.
    mergeTradesEnabled: 1,
    // Максимальный промежуток (в секундах) между выходом одной сделки и
    // входом следующей по тому же символу, чтобы считать их одной "пачкой"
    // для объединения. LONG/SHORT не имеет значения — важен только символ.
    mergeGapSec: 60,
    // Оставлять ли отдельные клипы сделок, вошедших в общий (комбо) клип.
    // По умолчанию ВЫКЛЮЧЕНО: серия из пяти сделок иначе оставляет в папке дня
    // шесть файлов об одном и том же, а смотреть обычно нужен общий клип.
    // Включённая галка ничего не удаляет — отдельные клипы переезжают в
    // подпапку mergedPartsSubdir, чтобы в папке дня всё равно был один файл
    // на серию.
    keepMergedParts: 0,
    // Имя той самой подпапки. Работает только при keepMergedParts = 1.
    // Пустая строка = не перекладывать, всё лежит вперемешку с общим клипом.
    mergedPartsSubdir: 'parts',
    // 1 включено, 0 выключено — подстраховка чекпоинтом для сделок длиннее
    // буфера OBS (см. longTradeThresholdSec/checkpointEntrySnippetSec/
    // checkpointExitSnippetSec выше). При 0 эта механика не срабатывает
    // вообще: ни лишнего SaveReplayBuffer, ни склейки чекпоинта с концом сделки.
    longTradeCheckpointEnabled: 0,
    // На сколько равных частей делить кадр — запасной вариант, когда свои
    // области ещё не настроены (кнопки "Стакан 1..N"). Размер частей считается
    // от РАЗМЕРА ЗАПИСИ, а не от какого-то зашитого разрешения: мониторы у всех
    // разные. 0 (в окне настроек — пустое поле) означает "не делить вовсе" и
    // стоит по умолчанию: раскладку чужого терминала не угадать, а делить экран
    // на произвольное число частей бессмысленно. Точные границы даёт кнопка
    // "Найти границы" в окне обрезки.
    stakanCount: 0,
    // Рамки обрезки, выделенные мышью в редакторе клипа и сохранённые под именем
    // (см. cropRect.js). Каждая: { name, x, y, width, height, sourceWidth,
    // sourceHeight } — координаты в пикселях той записи, на которой рамку
    // сняли; к записи другого размера она применяется пропорционально.
    // Пока список пуст, в меню трея предлагается деление на stakanCount
    // равных частей (а если и оно не задано — только ручная обрезка). Как
    // только появилась своя область, расчётное деление исчезает: измеренные
    // границы всегда точнее.
    cropPresets: [],
    // Какие длительности предлагать в пункте трея "Сохранить повтор" (сек).
    // Это просто список кнопок — ставь те значения, которыми реально
    // пользуешься.
    replayPresetsSec: [15, 30, 60, 180, 300],
    // Какие множители скорости предлагать при обрезке (и в трее, и в окне).
    // 1 стоит первым не случайно: у пункта с подменю сам заголовок некликабелен,
    // поэтому "обычная скорость" обязана быть отдельным пунктом списка.
    speedPresets: [1, 2, 3, 5, 10],
    // Резать ли без звука при быстрой обрезке из меню трея. В окне обрезки
    // есть своя галка на каждый раз, а тут — решение "мне звук в таких клипах
    // не нужен вообще", принятое один раз. На сами клипы сделок не влияет:
    // там звук сохраняется всегда.
    trayCropMuted: 0,
    // Имя области, которая вырезается из клипа СРАЗУ, без участия человека.
    // Пусто — не вырезать, клип остаётся на весь кадр (так по умолчанию).
    // Смысл настройки в том, что стакан на разборе нужен почти всегда один и
    // тот же, а резать его руками после каждой сделки — лишний ритуал.
    autoCropArea: '',
    // Определять область по самому кадру, а не брать заданную заранее. Из
    // журнала терминала этого не узнать (там нет ничего про экран), зато видно
    // в записи: у панели с открытой позицией внизу горит цветная полоса.
    // Подробности — в tradeAreaDetect.js. Если определить не вышло, режется
    // область из autoCropArea, а если и её нет — не режется ничего.
    autoCropDetect: 0,
    // Удалять ли клип на весь кадр после того, как область из него вырезана.
    // По умолчанию НЕТ: область можно настроить неудачно, и запись, которой
    // уже нет, обратно не вернуть. Включать это стоит, когда область проверена
    // — полный клип на каждую сделку весит около сотни мегабайт.
    autoCropDeleteFull: 0,
    // Сколько последних клипов показывать В МЕНЮ ТРЕЯ. Сама история за сессию
    // хранится целиком и доступна в окне "Все сделки" — здесь ограничивается
    // только меню: нативное меню Windows не прокручивается, и слишком длинный
    // список просто вылезет за край экрана.
    recentTradesHistorySize: 10
  },
  polling: {
    logPollIntervalMs: 1000
  }
}

// Признак того, что config.json создан прямо сейчас, а не прочитан готовый.
// По нему открывается помощник первой настройки — отдельного ключа в конфиге
// для этого заводить не надо: файл появляется ровно один раз за установку, и
// тем, кто обновляется со старой версии, помощник не покажется.
let configCreatedOnThisRun = false

function ensureConfigExists() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')
    configCreatedOnThisRun = true
    console.log(`[config] Создан config.json со значениями по умолчанию: ${CONFIG_PATH}`)
    console.log('[config] Открой его и укажи пароль OBS WebSocket (Сервис → Настройки сервера WebSocket).')
  }
}

function wasConfigJustCreated() {
  return configCreatedOnThisRun
}

// Раньше секция называлась "vataga" (других терминалов не было). Чтобы у тех,
// у кого уже лежит старый config.json, не потерялся заданный путь к логам,
// переносим его в новую секцию terminal.
function migrateLegacyTerminalSection(parsed) {
  const terminal = { ...DEFAULT_CONFIG.terminal, ...parsed.terminal }

  // Наличие старой секции означает, что человек торговал на Vataga. Терминал
  // по умолчанию с тех пор сменился на TigerTrade, и без этой проверки
  // обновление молча переключило бы его на чужой терминал — сделки перестали
  // бы находиться вообще. Явно выбранный терминал при этом не трогаем.
  if (parsed.vataga && !(parsed.terminal && parsed.terminal.type)) {
    terminal.type = 'vataga'
  }

  const legacyLogsDir = parsed.vataga && String(parsed.vataga.logsDirOverride || '').trim()
  if (legacyLogsDir && !String(terminal.logsDirOverride || '').trim()) {
    terminal.logsDirOverride = legacyLogsDir
  }
  return terminal
}

function loadConfig() {
  ensureConfigExists()
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  // Мелкий merge с дефолтами на случай, если в файле чего-то не хватает
  return {
    obs: { ...DEFAULT_CONFIG.obs, ...parsed.obs },
    terminal: migrateLegacyTerminalSection(parsed),
    clip: { ...DEFAULT_CONFIG.clip, ...parsed.clip, cropPresets: normalizeCropPresets(parsed.clip && parsed.clip.cropPresets) },
    polling: { ...DEFAULT_CONFIG.polling, ...parsed.polling }
  }
}

// Сохраняет конфиг обратно в config.json (окно настроек). Приводит значения к
// нужным типам и отбрасывает всё лишнее: в файл попадают только известные
// ключи, а не то, что прислало окно.
function saveConfig(incoming) {
  // Что уже лежит на диске — нужно для ключей, которые окно настроек не
  // присылает (см. cropPresets ниже).
  let existingCropPresets = []
  try {
    existingCropPresets = loadConfig().clip.cropPresets
  } catch {
    // Файла ещё нет или он битый — значит и сохранять нечего
  }

  const merged = {
    obs: { ...DEFAULT_CONFIG.obs, ...(incoming.obs || {}) },
    terminal: { ...DEFAULT_CONFIG.terminal, ...(incoming.terminal || {}) },
    clip: { ...DEFAULT_CONFIG.clip, ...(incoming.clip || {}) },
    polling: { ...DEFAULT_CONFIG.polling, ...(incoming.polling || {}) }
  }

  const num = (value, fallback) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  const flag = (value) => (value ? 1 : 0)

  const normalized = {
    obs: {
      url: String(merged.obs.url || '').trim(),
      password: String(merged.obs.password ?? ''),
      replayBufferCheckIntervalSec: num(merged.obs.replayBufferCheckIntervalSec, DEFAULT_CONFIG.obs.replayBufferCheckIntervalSec)
    },
    terminal: {
      // Неизвестное значение молча не принимаем — иначе слежение встало бы
      // за несуществующим терминалом и просто ничего не ловило.
      type: SUPPORTED_TERMINALS.includes(merged.terminal.type) ? merged.terminal.type : DEFAULT_CONFIG.terminal.type,
      logsDirOverride: String(merged.terminal.logsDirOverride || '').trim()
    },
    clip: {
      paddingBeforeSec: num(merged.clip.paddingBeforeSec, DEFAULT_CONFIG.clip.paddingBeforeSec),
      paddingAfterSec: num(merged.clip.paddingAfterSec, DEFAULT_CONFIG.clip.paddingAfterSec),
      outputDir: String(merged.clip.outputDir || DEFAULT_CONFIG.clip.outputDir).trim(),
      stakanOutputDir: String(merged.clip.stakanOutputDir || DEFAULT_CONFIG.clip.stakanOutputDir).trim(),
      manualReplayOutputDir: String(merged.clip.manualReplayOutputDir || DEFAULT_CONFIG.clip.manualReplayOutputDir).trim(),
      longTradeThresholdSec: num(merged.clip.longTradeThresholdSec, DEFAULT_CONFIG.clip.longTradeThresholdSec),
      checkpointEntrySnippetSec: num(merged.clip.checkpointEntrySnippetSec, DEFAULT_CONFIG.clip.checkpointEntrySnippetSec),
      checkpointExitSnippetSec: num(merged.clip.checkpointExitSnippetSec, DEFAULT_CONFIG.clip.checkpointExitSnippetSec),
      longTradeCheckpointEnabled: flag(merged.clip.longTradeCheckpointEnabled),
      deleteSourceReplays: Boolean(merged.clip.deleteSourceReplays),
      mergeTradesEnabled: flag(merged.clip.mergeTradesEnabled),
      mergeGapSec: num(merged.clip.mergeGapSec, DEFAULT_CONFIG.clip.mergeGapSec),
      keepMergedParts: flag(merged.clip.keepMergedParts),
      // Имя подпапки, а не путь: чистим от разделителей, чтобы клипы не
      // уехали куда-то мимо папки дня.
      mergedPartsSubdir: String(merged.clip.mergedPartsSubdir ?? '').replace(/[\\/:*?"<>|]/g, '').trim(),
      recentTradesHistorySize: Math.max(1, Math.round(num(merged.clip.recentTradesHistorySize, DEFAULT_CONFIG.clip.recentTradesHistorySize))),
      replayPresetsSec: normalizeNumberList(merged.clip.replayPresetsSec, DEFAULT_CONFIG.clip.replayPresetsSec, { min: 1, max: 3600, round: true }),
      speedPresets: normalizeNumberList(merged.clip.speedPresets, DEFAULT_CONFIG.clip.speedPresets, { min: 0.25, max: 20, round: false }),
      trayCropMuted: flag(merged.clip.trayCropMuted),
      autoCropArea: String(merged.clip.autoCropArea || '').trim(),
      autoCropDetect: flag(merged.clip.autoCropDetect),
      autoCropDeleteFull: flag(merged.clip.autoCropDeleteFull),
      stakanCount: Math.max(0, Math.min(24, Math.round(num(merged.clip.stakanCount, DEFAULT_CONFIG.clip.stakanCount)))),
      // Настроенные области переживают сохранение из окна настроек, даже если
      // оно про них не знает: окно шлёт только свои поля, и без этой проверки
      // нажатие "Сохранить" молча стирало бы всю настройку границ. Пустой
      // массив — это осознанное "удалить всё", он приходит явно.
      cropPresets: normalizeCropPresets(
        incoming.clip && incoming.clip.cropPresets !== undefined
          ? incoming.clip.cropPresets
          : existingCropPresets
      )
    },
    polling: {
      logPollIntervalMs: num(merged.polling.logPollIntervalMs, DEFAULT_CONFIG.polling.logPollIntervalMs)
    },
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf8')
  return normalized
}

module.exports = { loadConfig, saveConfig, wasConfigJustCreated, CONFIG_PATH, DEFAULT_CONFIG }
