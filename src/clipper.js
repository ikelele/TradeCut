const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { normalizeSymbol } = require('./symbol')
const { getFfmpegPath, getFfprobePath } = require('./ffmpegTools')

const execFileAsync = promisify(execFile)

// Предупреждения этого модуля должны попадать в журнал приложения: у трей-
// приложения консоли нет, и console.warn просто пропадает. А именно здесь
// рождается самое важное для пользователя сообщение — "клип обрезан, потому
// что сделка не поместилась в буфер OBS".
let log = (message) => process.stdout.write(message + String.fromCharCode(10))
function setClipperLogger(logger) {
  log = logger || ((message) => process.stdout.write(message + String.fromCharCode(10)))
}

// Ждём, пока размер файла перестанет расти между двумя проверками подряд.
// Это и есть защита от гонки "OBS сказал что сохранил, но ещё дописывает файл",
// из-за которой ffprobe мог упасть или занизить длительность.
async function waitForStableFile(filePath, { checkIntervalMs = 300, maxChecks = 20 } = {}) {
  let previousSize = -1
  for (let i = 0; i < maxChecks; i++) {
    let stat
    try {
      stat = await fsp.stat(filePath)
    } catch {
      // Файл ещё может не существовать в файловой системе долю секунды после события — ждём
      await sleep(checkIntervalMs)
      continue
    }
    if (stat.size > 0 && stat.size === previousSize) {
      return stat.size
    }
    previousSize = stat.size
    await sleep(checkIntervalMs)
  }
  throw new Error(`Файл ${filePath} не стабилизировался за отведённое время (возможно, всё ещё пишется)`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function probeDurationSeconds(filePath) {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ])
  const duration = parseFloat(stdout.trim())
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe не смог определить длительность файла: ${filePath}`)
  }
  return duration
}

async function probeAudioStreamCount(filePath) {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    filePath
  ])
  return stdout.trim().split(/\r?\n/).filter(line => line.length > 0).length
}

// Размер кадра нужен визуальной обрезке: рамку, выделенную мышью, надо
// прижать к реальным границам этого файла (см. cropRect.js).
async function probeVideoSize(filePath) {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    filePath
  ])
  const [width, height] = stdout.trim().split(',').map(Number)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`ffprobe не смог определить размер кадра: ${filePath}`)
  }
  return { width, height }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// Видео + обе аудиодорожки (если они есть в источнике — знак "?" делает
// маппинг необязательным, чтобы не падать на файлах с одной дорожкой или
// вовсе без звука). Дорожка 1 в OBS (раб. стол + микрофон) должна быть
// настроена первой в Replay Buffer, поэтому она же остаётся первой (и значит
// проигрывается по умолчанию большинством плееров) и в вырезанном клипе.
// Дорожка 2 (только раб. стол, без микрофона) сохраняется тоже — она нужна
// для последующей ручной обрезки по стакану (см. stakanCrop.js), которая
// явно выбирает именно её.
const MAP_VIDEO_AND_BOTH_AUDIO_TRACKS = ['-map', '0:v:0', '-map', '0:a:0?', '-map', '0:a:1?']

// Проверяет, что ffmpeg и ffprobe доступны в PATH. Без этого обрезка клипа
// упадёт только в момент первой сделки — лучше предупредить об этом сразу
// при старте, а не постфактум.
async function checkFfmpegToolsAvailable() {
  const missing = []
  for (const [name, tool] of [['ffmpeg', getFfmpegPath()], ['ffprobe', getFfprobePath()]]) {
    try {
      await execFileAsync(tool, ['-version'])
    } catch {
      missing.push(name)
    }
  }
  return missing
}

// Клипы раскладываются по папкам-дням
// ГГГГ-ММ-ДД, по локальной дате закрытия сделки (exitTimeMs).
function buildDailyOutputDir(baseOutputDir, exitTimeMs) {
  const date = new Date(exitTimeMs)
  const pad = (n) => String(n).padStart(2, '0')
  const folderName = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return path.join(baseOutputDir, folderName)
}

// Вырезает короткий "чекпоинт" вокруг входа в сделку — подстраховка на случай,
// если сделка окажется длиннее буфера OBS и к моменту закрытия момент входа
// уже физически вытеснится из кольцевого буфера. Вызывается отдельным
// SaveReplayBuffer, пока позиция ещё открыта (см. app.js).
async function createEntryCheckpoint({ replayPath, trade, paddingBeforeSec, checkpointEntrySnippetSec, tmpDir }) {
  await waitForStableFile(replayPath)
  const durationSec = await probeDurationSeconds(replayPath)

  const fileStat = await fsp.stat(replayPath)
  const bufferEndMs = fileStat.mtimeMs
  const bufferStartMs = bufferEndMs - durationSec * 1000

  const desiredStartMs = trade.entryTimeMs - paddingBeforeSec * 1000
  const desiredEndMs = trade.entryTimeMs + checkpointEntrySnippetSec * 1000

  const trimStartSec = clamp((desiredStartMs - bufferStartMs) / 1000, 0, durationSec)
  const trimEndSec = clamp((desiredEndMs - bufferStartMs) / 1000, 0, durationSec)
  const trimDurationSec = Math.max(trimEndSec - trimStartSec, 0.5)

  await fsp.mkdir(tmpDir, { recursive: true })
  const outputPath = path.join(tmpDir, `checkpoint-${trade.positionId}-${Date.now()}.mp4`)

  await execFileAsync(getFfmpegPath(), [
    '-y',
    '-ss', trimStartSec.toFixed(2),
    '-i', replayPath,
    '-t', trimDurationSec.toFixed(2),
    ...MAP_VIDEO_AND_BOTH_AUDIO_TRACKS,
    '-c', 'copy',
    outputPath
  ])

  return outputPath
}

// Склеивает несколько клипов подряд через ffmpeg concat demuxer (стрим-копия,
// без перекодирования — годится, только если у клипов совпадают кодек/параметры,
// что гарантировано, если оба вырезаны из одного и того же OBS Replay Buffer).
async function concatClips(clipPaths, outputPath) {
  const listPath = `${outputPath}.concat-list.txt`
  const listContent = clipPaths
    .map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`)
    .join('\n')
  await fsp.writeFile(listPath, listContent, 'utf8')
  try {
    await execFileAsync(getFfmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath])
  } finally {
    await fsp.unlink(listPath).catch(() => {})
  }
}

// trade = { symbol, side, entryTimeMs, exitTimeMs }
// entryCheckpointClipPath — опционально, путь к клипу от createEntryCheckpoint
// (см. выше): если вход не помещается в буфер, склеивается с ним; если
// помещается — просто удаляется как ненужный. Возвращает путь к готовому клипу.
async function createClipFromReplay({
  replayPath, trade, paddingBeforeSec, paddingAfterSec, outputDir,
  entryCheckpointClipPath, checkpointExitSnippetSec
}) {
  await waitForStableFile(replayPath)
  const durationSec = await probeDurationSeconds(replayPath)

  const fileStat = await fsp.stat(replayPath)
  const bufferEndMs = fileStat.mtimeMs
  const bufferStartMs = bufferEndMs - durationSec * 1000

  const desiredStartMs = trade.entryTimeMs - paddingBeforeSec * 1000
  const desiredEndMs = trade.exitTimeMs + paddingAfterSec * 1000
  const entryMissing = desiredStartMs < bufferStartMs
  const exitMissing = desiredEndMs > bufferEndMs

  const dailyOutputDir = buildDailyOutputDir(outputDir, trade.exitTimeMs)
  await fsp.mkdir(dailyOutputDir, { recursive: true })
  const fileName = buildOutputFileName(trade)
  const outputPath = path.join(dailyOutputDir, fileName)

  if (entryMissing && entryCheckpointClipPath) {
    // Сделка реально длиннее буфера, и у нас есть чекпоинт входа — вместо
    // клэмпа по границам буфера склеиваем чекпоинт с коротким куском вокруг выхода.
    const exitPartStartMs = Math.max(bufferStartMs, trade.exitTimeMs - checkpointExitSnippetSec * 1000)
    const trimStartSec = clamp((exitPartStartMs - bufferStartMs) / 1000, 0, durationSec)
    const trimEndSec = clamp((desiredEndMs - bufferStartMs) / 1000, 0, durationSec)
    const trimDurationSec = Math.max(trimEndSec - trimStartSec, 0.5)

    const tmpExitPartPath = `${outputPath}.exit-part.mp4`
    await execFileAsync(getFfmpegPath(), [
      '-y',
      '-ss', trimStartSec.toFixed(2),
      '-i', replayPath,
      '-t', trimDurationSec.toFixed(2),
      ...MAP_VIDEO_AND_BOTH_AUDIO_TRACKS,
      '-c', 'copy',
      tmpExitPartPath
    ])

    try {
      await concatClips([entryCheckpointClipPath, tmpExitPartPath], outputPath)
      log(`Сделка длиннее буфера — склеен чекпоинт входа с концом сделки: ${outputPath}`)
    } finally {
      await fsp.unlink(tmpExitPartPath).catch(() => {})
      await fsp.unlink(entryCheckpointClipPath).catch(() => {})
    }

    return outputPath
  }

  if (entryMissing || exitMissing) {
    // Не падаем намертво — вместо этого обрезаем
    // по границам того, что реально есть в буфере, и явно предупреждаем.
    const missingBeforeSec = Math.max(0, (bufferStartMs - desiredStartMs) / 1000)
    const missingAfterSec = Math.max(0, (desiredEndMs - bufferEndMs) / 1000)
    log(
      'Внимание: сделка выходит за пределы сохранённого буфера OBS. ' +
      `Не хватило ${missingBeforeSec.toFixed(2)}с в начале и ${missingAfterSec.toFixed(2)}с в конце — ` +
      'клип обрезан по доступным границам. Увеличь длину буфера повтора в OBS.'
    )
  }

  const trimStartSec = clamp((desiredStartMs - bufferStartMs) / 1000, 0, durationSec)
  const trimEndSec = clamp((desiredEndMs - bufferStartMs) / 1000, 0, durationSec)
  const trimDurationSec = Math.max(trimEndSec - trimStartSec, 0.5)

  await execFileAsync(getFfmpegPath(), [
    '-y',
    '-ss', trimStartSec.toFixed(2),
    '-i', replayPath,
    '-t', trimDurationSec.toFixed(2),
    ...MAP_VIDEO_AND_BOTH_AUDIO_TRACKS,
    '-c', 'copy',
    outputPath
  ])

  if (entryCheckpointClipPath) {
    // Чекпоинт был сделан на всякий случай, но сделка уложилась в буфер — не нужен
    await fsp.unlink(entryCheckpointClipPath).catch(() => {})
  }

  return outputPath
}

// Биржа в имени файла. Известна не всегда (в старых записях её нет) — тогда
// имя остаётся прежним, без лишнего пробела.
function formatExchangePart(exchange) {
  const text = String(exchange ?? '').trim()
  return text ? ` ${text}` : ''
}

function buildOutputFileName(trade) {
  const date = new Date(trade.entryTimeMs)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  const safeSymbol = normalizeSymbol(trade.symbol)
  return `${safeSymbol} ${trade.side}${formatExchangePart(trade.exchange)} ${stamp}.mp4`
}

function buildMergedOutputFileName(trades) {
  const firstTrade = trades[0]
  const date = new Date(firstTrade.entryTimeMs)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  const safeSymbol = normalizeSymbol(firstTrade.symbol)
  return `${safeSymbol} COMBOx${trades.length}${formatExchangePart(firstTrade.exchange)} ${stamp}.mp4`
}

// Объединяет несколько подряд идущих сделок по одному символу в один клип —
// от входа в первую сделку "пачки" до выхода из последней (см. app.js —
// решение, какие сделки считать пачкой, принимается там). Использует тот же
// replay-файл, что уже был сохранён ради последней сделки пачки: пока весь
// диапазон "пачки" по длительности заметно меньше длины буфера OBS, этот
// файл и так покрывает его целиком, поэтому отдельный SaveReplayBuffer для
// объединения не нужен.
// Если диапазон не помещается в буфер целиком — в отличие от обычного
// createClipFromReplay здесь НЕ обрезаем по границам буфера, а просто
// возвращаем null: обрезанный "огрызок" пачки вводил бы в заблуждение больше,
// чем его отсутствие (в отдельных клипах по каждой сделке информация и так
// не потеряна).
async function createMergedClipFromReplay({ replayPath, trades, paddingBeforeSec, paddingAfterSec, outputDir }) {
  await waitForStableFile(replayPath)
  const durationSec = await probeDurationSeconds(replayPath)

  const fileStat = await fsp.stat(replayPath)
  const bufferEndMs = fileStat.mtimeMs
  const bufferStartMs = bufferEndMs - durationSec * 1000

  const firstTrade = trades[0]
  const lastTrade = trades[trades.length - 1]
  const desiredStartMs = firstTrade.entryTimeMs - paddingBeforeSec * 1000
  const desiredEndMs = lastTrade.exitTimeMs + paddingAfterSec * 1000

  if (desiredStartMs < bufferStartMs || desiredEndMs > bufferEndMs) {
    return null
  }

  const dailyOutputDir = buildDailyOutputDir(outputDir, lastTrade.exitTimeMs)
  await fsp.mkdir(dailyOutputDir, { recursive: true })
  const outputPath = path.join(dailyOutputDir, buildMergedOutputFileName(trades))

  const trimStartSec = clamp((desiredStartMs - bufferStartMs) / 1000, 0, durationSec)
  const trimEndSec = clamp((desiredEndMs - bufferStartMs) / 1000, 0, durationSec)
  const trimDurationSec = Math.max(trimEndSec - trimStartSec, 0.5)

  await execFileAsync(getFfmpegPath(), [
    '-y',
    '-ss', trimStartSec.toFixed(2),
    '-i', replayPath,
    '-t', trimDurationSec.toFixed(2),
    ...MAP_VIDEO_AND_BOTH_AUDIO_TRACKS,
    '-c', 'copy',
    outputPath
  ])

  return outputPath
}

// "15 сек" / "5 мин" — для имени файла и пункта меню.
function formatDurationLabel(durationSec) {
  if (durationSec % 60 === 0 && durationSec >= 60) return `${durationSec / 60}мин`
  return `${durationSec}сек`
}

function buildManualReplayFileName(durationSec, endTimeMs) {
  const date = new Date(endTimeMs)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  return `Повтор ${formatDurationLabel(durationSec)} ${stamp}.mp4`
}

// Ручное "сохранить последние N" из меню трея. В отличие от клипов по сделкам
// и алертам тут нет привязки ко времени события — просто берём ХВОСТ уже
// сохранённого буфера. Если буфер короче запрошенного, отдаём сколько есть.
async function createManualReplayClip({ replayPath, durationSec, outputDir }) {
  await waitForStableFile(replayPath)
  const bufferDurationSec = await probeDurationSeconds(replayPath)

  const fileStat = await fsp.stat(replayPath)
  const bufferEndMs = fileStat.mtimeMs

  const takeSec = Math.min(durationSec, bufferDurationSec)
  const trimStartSec = Math.max(0, bufferDurationSec - takeSec)

  const dailyOutputDir = buildDailyOutputDir(outputDir, bufferEndMs)
  await fsp.mkdir(dailyOutputDir, { recursive: true })
  const outputPath = path.join(dailyOutputDir, buildManualReplayFileName(durationSec, bufferEndMs))

  await execFileAsync(getFfmpegPath(), [
    '-y',
    '-ss', trimStartSec.toFixed(2),
    '-i', replayPath,
    '-t', Math.max(takeSec, 0.5).toFixed(2),
    ...MAP_VIDEO_AND_BOTH_AUDIO_TRACKS,
    '-c', 'copy',
    outputPath
  ])

  return outputPath
}

module.exports = {
  setClipperLogger,
  createClipFromReplay,
  createManualReplayClip,
  buildManualReplayFileName,
  formatDurationLabel,
  createEntryCheckpoint,
  createMergedClipFromReplay,
  concatClips,
  waitForStableFile,
  probeDurationSeconds,
  probeAudioStreamCount,
  probeVideoSize,
  buildOutputFileName,
  buildMergedOutputFileName,
  buildDailyOutputDir,
  checkFfmpegToolsAvailable
}
