const { execFile, spawn } = require('child_process')
const { getFfmpegPath, getFfprobePath, lowerPriority } = require('./ffmpegTools')

// Достаёт один кадр видео сырыми пикселями (RGBA), без промежуточного файла.
//
// Зачем не через <video> и canvas в окне: кадр записи 3440x1440 — это без
// малого 20 МБ пикселей, и гонять их из окна в основной процесс через IPC
// ради поиска границ панелей незачем. Здесь же кадр сразу оказывается там,
// где он нужен, а наружу уходит только короткий список линий.

const MAX_FRAME_BYTES = 64 * 1024 * 1024

// background — кадр нужен не человеку, а разбору сделки, который идёт сам.
// Тогда запись читает видеокарта и с пониженным приоритетом: на записи двух
// мониторов (HEVC 6880x1440) это 1.5 секунды процессора на кадр вместо 4.8, а
// кадров на сделку четыре. Зато видеокарта на полсекунды медленнее, поэтому
// там, где человек ждёт ответа («Найти границы»), читает процессор.
function grabFrameRgba(filePath, timeSec, { width, height, background = false }) {
  const expectedBytes = width * height * 4
  if (!(expectedBytes > 0) || expectedBytes > MAX_FRAME_BYTES) {
    return Promise.reject(new Error(`Неподходящий размер кадра: ${width}x${height}`))
  }

  return new Promise((resolve, reject) => {
    // -ss ДО -i: перемотка по ключевым кадрам, иначе на длинном клипе ffmpeg
    // будет декодировать всё с начала.
    const child = execFile(getFfmpegPath(), [
      '-v', 'error',
      ...(background ? ['-hwaccel', 'auto'] : []),
      '-ss', String(Math.max(0, timeSec || 0)),
      '-i', filePath,
      '-frames:v', '1',
      // Видеокарта отдаёт кадр в NV12, а цвет из него пересчитывается иначе,
      // чем из yuv420p, который даёт процессор: 40% байт кадра расходились до
      // 48 уровней. Пороги разбора сделки подобраны на кадрах процессора,
      // поэтому сперва приводим к yuv420p — тогда кадр совпадает до байта.
      ...(background ? ['-vf', 'format=yuv420p'] : []),
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
    if (background) lowerPriority(child)
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

// Полоса строк кадра во всю ширину — много раз подряд, одним проходом ffmpeg.
//
// Разбору сделки нужен только низ панелей, зато часто: плашка позиции у
// секундной сделки горит секунду, и три кадра на клип её пропускали. Отдельный
// ffmpeg на каждый кадр стоил бы секунду с лишним, а целый кадр двух мониторов
// весит 40 МБ. Здесь запись читается один раз, а наружу идут только нужные
// строки: у стаканов во всю высоту это 58 строк, 1.6 МБ на кадр.
//
// Кадры отдаются по одному в onFrame и не копятся — на длинном отрезке их
// сотни. Буфер кадра переиспользуется: onFrame должен разобрать его сразу.
// y и height — чётные: цвет в yuv420p хранится на пару строк, и только так
// полоса совпадает до байта с тем же местом целого кадра из grabFrameRgba.
// Вырезаем ДО пересчёта цвета: пересчитывать весь кадр двух мониторов ради
// полусотни строк — это почти вся работа впустую, а кадров тут до тридцати
// в секунду.
function scanBand(filePath, { toSec, fps, y, height, width, background = false }, onFrame) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error']
    if (background) args.push('-hwaccel', 'auto')
    args.push('-i', filePath)
    if (toSec > 0) args.push('-t', String(toSec))
    args.push(
      '-map', '0:v:0',
      '-vf', `fps=${fps},crop=${width}:${height}:0:${y},format=yuv420p`,
      '-pix_fmt', 'rgba',
      '-f', 'rawvideo',
      'pipe:1'
    )

    const child = spawn(getFfmpegPath(), args)
    if (background) lowerPriority(child)

    const frameBytes = width * height * 4
    const frame = Buffer.allocUnsafe(frameBytes)
    let filled = 0
    let index = 0
    let stderr = ''
    let failed = null

    child.stdout.on('data', (chunk) => {
      let offset = 0
      while (offset < chunk.length && !failed) {
        const take = Math.min(frameBytes - filled, chunk.length - offset)
        chunk.copy(frame, filled, offset, offset + take)
        filled += take
        offset += take
        if (filled === frameBytes) {
          try {
            onFrame({ timeSec: index / fps, width, height, data: frame })
          } catch (error) {
            // Ошибка разбора не должна уйти мимо: здесь обработчик потока, и
            // необработанное исключение уронило бы всю программу.
            failed = error
            child.kill()
          }
          index++
          filled = 0
        }
      }
    })
    child.stderr.on('data', (data) => {
      if (stderr.length < 4000) stderr += data
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (failed) return reject(failed)
      if (code !== 0) return reject(new Error(`Не удалось прочитать полосу кадра: ${stderr.trim() || `код ${code}`}`))
      resolve(index)
    })
  })
}

module.exports = { grabFrameRgba, grabFrameJpeg, scanBand }
