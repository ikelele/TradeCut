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

module.exports = { grabFrameRgba }
