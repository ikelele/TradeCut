const { execFile } = require('child_process')
const { getFfmpegPath, getFfprobePath } = require('./ffmpegTools')

// Достаёт один кадр видео сырыми пикселями (RGBA), без промежуточного файла.
//
// Зачем не через <video> и canvas в окне: кадр записи 3440x1440 — это без
// малого 20 МБ пикселей, и гонять их из окна в основной процесс через IPC
// ради поиска границ панелей незачем. Здесь же кадр сразу оказывается там,
// где он нужен, а наружу уходит только короткий список линий.

const MAX_FRAME_BYTES = 64 * 1024 * 1024

function grabFrameRgba(filePath, timeSec, { width, height }) {
  const expectedBytes = width * height * 4
  if (!(expectedBytes > 0) || expectedBytes > MAX_FRAME_BYTES) {
    return Promise.reject(new Error(`Неподходящий размер кадра: ${width}x${height}`))
  }

  return new Promise((resolve, reject) => {
    // -ss ДО -i: перемотка по ключевым кадрам, иначе на длинном клипе ffmpeg
    // будет декодировать всё с начала.
    const child = execFile(getFfmpegPath(), [
      '-v', 'error',
      '-ss', String(Math.max(0, timeSec || 0)),
      '-i', filePath,
      '-frames:v', '1',
      '-pix_fmt', 'rgba',
      '-f', 'rawvideo',
      'pipe:1'
    ], { encoding: 'buffer', maxBuffer: MAX_FRAME_BYTES }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`Не удалось получить кадр: ${String(stderr || error.message).trim()}`))
      if (stdout.length < expectedBytes) {
        return reject(new Error(`Кадр получился неполным: ${stdout.length} байт вместо ${expectedBytes}`))
      }
      resolve({ data: stdout, width, height })
    })
    child.on('error', reject)
  })
}

// Один кадр картинкой (JPEG) — чтобы показать его в окне.
//
// Не через <video> окна: программа запускается с отключённой видеокартой (см.
// electron/main.js), а HEVC встроенный браузер умеет раскодировать ТОЛЬКО
// видеокартой — своего декодера для него нет. Запись в HEVC, без которого не
// обойтись на кадре шириной в два монитора, показывалась чёрным
// прямоугольником. ffmpeg программы читает любой кодек сам.
//
// Ширину ограничиваем: окно всё равно не шире монитора, а кадр в 6880 пикселей
// без нужды раздул бы картинку и её пересылку в окно.
const MAX_PREVIEW_WIDTH = 3440
const MAX_JPEG_BYTES = 32 * 1024 * 1024

function grabFrameJpeg(filePath, timeSec, maxWidth = MAX_PREVIEW_WIDTH) {
  return new Promise((resolve, reject) => {
    const child = execFile(getFfmpegPath(), [
      '-v', 'error',
      '-ss', String(Math.max(0, timeSec || 0)),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', `scale=w='min(iw,${maxWidth})':h=-2`,
      '-q:v', '3',
      '-f', 'mjpeg',
      'pipe:1'
    ], { encoding: 'buffer', maxBuffer: MAX_JPEG_BYTES }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`Не удалось достать кадр: ${String(stderr || error.message).trim()}`))
      if (!stdout || stdout.length === 0) return reject(new Error('Кадр получился пустым'))
      resolve(stdout)
    })
    child.on('error', reject)
  })
}

module.exports = { grabFrameRgba, grabFrameJpeg }
