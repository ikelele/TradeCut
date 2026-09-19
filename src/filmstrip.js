const { execFile } = require('child_process')
const { getFfmpegPath } = require('./ffmpegTools')

// Полоска кадров для дорожки обрезки: по ней видно, где в клипе что, не
// проигрывая его. Это первое, чего не хватало нашей дорожке по сравнению с
// обычными видеорезалками — там серая линия, здесь сама запись.
//
// Почему отдельными перемотками, а не одним проходом ffmpeg. Один проход
// (fps=N/длительность + tile) декодирует запись целиком: на клипе 3440x1440
// это 1.1 с за 20-секундный клип и 2.8 с за 60-секундный, то есть дальше
// растёт вместе с длиной. Повтор из трея бывает и на пять минут. Отдельные
// перемотки стоят одинаково при любой длине, потому что каждая прыгает по
// ключевым кадрам и декодирует ровно один кадр.
//
// Пробовал и третий способ — декодировать только ключевые кадры (-skip_frame
// nokey). Он быстрее всех, но их число зависит от настроек записи: у
// 60-секундного клипа OBS их оказалось 8, у 20-секундного — 3, и полоска
// добиралась чёрными клетками.

const DEFAULT_COUNT = 12
const THUMB_HEIGHT = 44
// Сколько перемоток делать одновременно. На скорость это почти не влияет —
// замерено 3.6 с при четырёх и 3.0 с при всех двенадцати сразу, — так что
// ограничение здесь не ради неё: рядом пишет OBS, и запускать десяток ffmpeg
// разом ради картинки на дорожке было бы невежливо к записи.
const AT_ONCE = 4
const MAX_THUMB_BYTES = 2 * 1024 * 1024

function grabThumb(filePath, timeSec, height) {
  return new Promise((resolve) => {
    // -ss ДО -i: перемотка по ключевым кадрам. Иначе ffmpeg декодирует всё с
    // начала, и смысл отдельных перемоток пропадает.
    const child = execFile(getFfmpegPath(), [
      '-v', 'error',
      '-ss', String(Math.max(0, timeSec)),
      '-i', filePath,
      '-frames:v', '1',
      '-an', '-sn',
      '-vf', `scale=-2:${height}`,
      '-q:v', '6',
      '-f', 'mjpeg',
      'pipe:1'
    ], { encoding: 'buffer', maxBuffer: MAX_THUMB_BYTES }, (error, stdout) => {
      // Пропущенная миниатюра — не беда: в полоске будет пробел, а дорожка
      // работает и без неё. Ронять из-за картинки обрезку незачем.
      if (error || !stdout || stdout.length === 0) return resolve(null)
      resolve(`data:image/jpeg;base64,${stdout.toString('base64')}`)
    })
    child.on('error', () => resolve(null))
  })
}

async function buildFilmstrip(filePath, durationSec, { count = DEFAULT_COUNT, height = THUMB_HEIGHT } = {}) {
  const total = Number(durationSec)
  if (!filePath || !(total > 0)) return []

  const times = []
  for (let index = 0; index < count; index++) {
    // Середина доли, а не её начало: у самого начала записи кадр часто ещё
    // пустой, а последняя доля начиналась бы ровно на конце файла.
    times.push(((index + 0.5) / count) * total)
  }

  const thumbs = []
  for (let from = 0; from < times.length; from += AT_ONCE) {
    const batch = times.slice(from, from + AT_ONCE)
    const grabbed = await Promise.all(batch.map((time) => grabThumb(filePath, time, height)))
    grabbed.forEach((dataUri, index) => {
      if (dataUri) thumbs.push({ time: batch[index], dataUri })
    })
  }
  return thumbs
}

module.exports = { buildFilmstrip, DEFAULT_COUNT, THUMB_HEIGHT }
