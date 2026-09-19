const path = require('path')
const fsp = require('fs').promises
const { execFile } = require('child_process')
const { promisify } = require('util')
const { buildDailyOutputDir, probeDurationSeconds, probeAudioStreamCount, probeVideoSize } = require('./clipper')
const { resolveCropRect, sanitizePresetName } = require('./cropRect')
const { resolveMediaPath } = require('./appPaths')
const { getFfmpegPath, getFfprobePath } = require('./ffmpegTools')

const execFileAsync = promisify(execFile)

// Сколько равных частей по умолчанию, если пользователь ещё не настроил свои
// области. Размер экрана здесь НЕ задаётся намеренно: он берётся из самой
// записи. Раньше тут стояли 3440x1440 — разрешение монитора автора, — и на
// записи другого размера обрезка по номеру стакана резала мимо кадра.
const DEFAULT_STAKAN_COUNT = 6

// Имя файла может прийти из окна, поэтому убираем всё, чем Windows подавится,
// и всё, чем можно уехать из папки назначения (разделители пути, "..").
// Расширение добавляем сами: пользователь про него думать не обязан.
function sanitizeOutputFileName(value) {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  if (!cleaned) return ''
  return /\.mp4$/i.test(cleaned) ? cleaned : `${cleaned}.mp4`
}

// Готовый файл не перезаписываем молча: раньше имя составлялось само и совпадения
// были маловероятны, а теперь его задаёт пользователь — и повтор имени означал бы
// потерю прошлой нарезки без единого предупреждения.
async function ensureUniquePath(dir, fileName) {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  for (let attempt = 1; attempt < 100; attempt++) {
    const candidate = path.join(dir, attempt === 1 ? fileName : `${base} (${attempt})${ext}`)
    try {
      await fsp.access(candidate)
    } catch {
      return candidate // файла нет — имя свободно
    }
  }
  // Сотня однофамильцев — что-то не так; пусть лучше упадёт, чем затрёт
  throw new Error(`Не удалось подобрать свободное имя для ${fileName}`)
}

// stakanIndex — 1..stakanCount. Ширина кадра делится поровну (округление вниз
// до целого), последний стакан забирает остаток, чтобы в сумме покрыть кадр.
// screenWidth/screenHeight — размер КАДРА ЗАПИСИ, обязательны: угадывать их
// нельзя, у каждого свой монитор.
function getStakanBounds(stakanIndex, { screenWidth, screenHeight, stakanCount = DEFAULT_STAKAN_COUNT } = {}) {
  if (!(screenWidth > 0 && screenHeight > 0)) {
    throw new Error('Для деления на стаканы нужен размер кадра записи')
  }
  const baseWidth = Math.round(screenWidth / stakanCount)
  const x = baseWidth * (stakanIndex - 1)
  const isLast = stakanIndex === stakanCount
  const width = isLast ? screenWidth - baseWidth * (stakanCount - 1) : baseWidth
  return { x, width, height: screenHeight }
}

// Формирует цепочку фильтров atempo для FFmpeg (каждый atempo ограничен диапазоном 0.5..2.0)
function buildAtempoFilter(speedFactor) {
  const filters = []
  let temp = speedFactor
  while (temp > 2.0) {
    filters.push('atempo=2.0')
    temp /= 2.0
  }
  while (temp < 0.5) {
    filters.push('atempo=0.5')
    temp /= 0.5
  }
  const last = Math.round(temp * 10000) / 10000
  if (Math.abs(last - 1.0) > 0.0001 || filters.length === 0) {
    filters.push(`atempo=${last}`)
  }
  return filters.join(',')
}

// Вырезает по ширине один "стакан" из уже готового клипа. В отличие от
// обычной нарезки по времени (clipper.js) требует перекодирования — crop
// меняет размеры кадра, стрим-копия для этого не годится.
// stakanIndex = null — кадр не режется по ширине (нужно, когда клип надо
// только ускорить или подрезать по краям).
// Опции: speedFactor (видео через setpts, звук через atempo), trimStart/
// trimEnd (сколько секунд отрезать с краёв), mute (выкинуть звук совсем) и
// cropRect — произвольная рамка, выделенная мышью в редакторе клипа либо взятая
// из сохранённого пресета. Рамка важнее stakanIndex: номер стакана считается
// делением ширины экрана поровну, а рамка снята с настоящего кадра.
// outputFileName — имя, заданное пользователем; пустое означает "составить
// само из имени исходника и выбранных параметров".
async function cropClipToStakan(clipPath, stakanIndex, outputBaseDir, options = {}) {
  if (typeof outputBaseDir === 'object' && outputBaseDir !== null) {
    options = outputBaseDir
    outputBaseDir = undefined
  }
  if (!outputBaseDir || typeof outputBaseDir !== 'string') {
    outputBaseDir = resolveMediaPath('./clips-stakan')
  }

  const speedFactor = Number(options.speedFactor) > 0 ? Number(options.speedFactor) : 1
  const trimStart = Number(options.trimStart) > 0 ? Number(options.trimStart) : 0
  const trimEnd = Number(options.trimEnd) > 0 ? Number(options.trimEnd) : 0
  const mute = Boolean(options.mute)

  // И сохранённый пресет, и номер стакана приводятся к рамке по РЕАЛЬНОМУ
  // размеру кадра этой записи. Размер экрана нигде не зашит: у каждого свой
  // монитор, и деление "на шесть равных частей от 3440" на чужой записи резало
  // бы мимо кадра.
  let cropRect
  if (options.cropRect || stakanIndex != null) {
    const { width: videoWidth, height: videoHeight } = await probeVideoSize(clipPath)
    const requested = options.cropRect || getStakanBounds(stakanIndex, {
      screenWidth: videoWidth,
      screenHeight: videoHeight,
      stakanCount: Number(options.stakanCount) > 0 ? Number(options.stakanCount) : DEFAULT_STAKAN_COUNT
    })
    cropRect = resolveCropRect(requested, videoWidth, videoHeight)
    if (!cropRect) {
      throw new Error('Рамка обрезки не помещается в кадр этого файла')
    }
  }

  const stat = await fsp.stat(clipPath)
  const dailyDir = buildDailyOutputDir(outputBaseDir, stat.mtimeMs)
  await fsp.mkdir(dailyDir, { recursive: true })

  const originalExt = path.extname(clipPath)
  const base = path.basename(clipPath, originalExt)
  
  const parts = []
  // Смотрим на то, что ЗАПРОСИЛИ, а не на посчитанную рамку: номер стакана
  // теперь тоже превращается в рамку, но в имени файла должен остаться номером.
  if (options.cropRect) parts.push(sanitizePresetName(options.cropPresetName) || 'crop')
  else if (stakanIndex != null) parts.push(`stakan${stakanIndex}`)
  if (speedFactor !== 1) parts.push(`x${speedFactor}`)
  if (trimStart > 0) parts.push(`-${trimStart}s`)
  if (trimEnd > 0) parts.push(`+${trimEnd}s`)
  if (mute) parts.push('mute')
  if (parts.length === 0) parts.push(`processed`)
  
  const suffix = parts.join(' ')
  const chosenName = sanitizeOutputFileName(options.outputFileName) || `${base} ${suffix}.mp4`
  const outputPath = await ensureUniquePath(dailyDir, chosenName)

  const ffmpegArgs = ['-y']

  let durationSec = 0
  if (trimEnd > 0) {
    durationSec = await probeDurationSeconds(clipPath)
  }

  if (trimStart > 0) {
    ffmpegArgs.push('-ss', trimStart.toString())
  }

  ffmpegArgs.push('-i', clipPath)

  if (trimEnd > 0 && durationSec > 0) {
    const endSec = durationSec - trimEnd
    const trimDuration = Math.max(0.1, endSec - trimStart)
    ffmpegArgs.push('-t', trimDuration.toString())
  }

  ffmpegArgs.push('-map', '0:v:0')
  if (mute) {
    // Дорожки не выбираем вообще — тогда не нужен ни ffprobe, ни atempo, ни
    // перекодирование звука.
    ffmpegArgs.push('-an')
  } else {
    const audioCount = await probeAudioStreamCount(clipPath)
    if (audioCount > 1) {
      ffmpegArgs.push('-map', '0:a:1')
    } else if (audioCount === 1) {
      ffmpegArgs.push('-map', '0:a:0')
    }
  }

  const vfParts = []
  if (cropRect) {
    vfParts.push(`crop=${cropRect.width}:${cropRect.height}:${cropRect.x}:${cropRect.y}`)
  }

  if (speedFactor !== 1) {
    vfParts.push(`setpts=PTS/${speedFactor}`)
  }

  if (vfParts.length > 0) {
    ffmpegArgs.push('-vf', vfParts.join(','))
  }

  if (speedFactor !== 1 && !mute) {
    const af = buildAtempoFilter(speedFactor)
    ffmpegArgs.push('-af', af)
  }

  ffmpegArgs.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18'
  )

  // Всегда перекодируем аудио в aac, потому что при использовании -ss перед -i
  // и стрим-копировании (-c:a copy) часто ломаются таймстемпы и пропадает звук.
  if (!mute) ffmpegArgs.push('-c:a', 'aac')

  ffmpegArgs.push(outputPath)

  await execFileAsync(getFfmpegPath(), ffmpegArgs)

  return outputPath
}

module.exports = { getStakanBounds, cropClipToStakan, buildAtempoFilter, sanitizeOutputFileName }

