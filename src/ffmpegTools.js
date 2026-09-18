const fs = require('fs')

// Где брать ffmpeg и ffprobe.
//
// Раньше они звались просто по имени, то есть должны были лежать в PATH. У
// того, кто просто скачал программу, их там нет: всё запускается, значок
// зеленеет, а при первой сделке клип не режется — и понять, почему, неоткуда.
// Поэтому теперь они кладутся в саму сборку (см. extraResources в package.json),
// а этот модуль решает, каким путём их звать.
//
// Порядок поиска:
//   1. то, что явно указал электронный слой при старте (файлы из сборки);
//   2. пакеты ffmpeg-static/ffprobe-static — это путь для разработки и тестов,
//      чтобы они гоняли ровно те двоичные файлы, которые уедут пользователю;
//   3. просто "ffmpeg"/"ffprobe" — расчёт на PATH, как было раньше.
// Третий вариант оставлен намеренно: он спасает, если файл в сборке повреждён
// или заблокирован антивирусом, а в системе ffmpeg всё-таки есть.

let resolved = null

function fileExists(filePath) {
  try {
    return Boolean(filePath) && fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

// Пути из пакетов для разработки. В собранном приложении node_modules нет,
// поэтому обращение обёрнуто и его неудача ничего не ломает.
function fromNodeModules() {
  const tools = {}
  try {
    const ffmpeg = require('ffmpeg-static')
    if (fileExists(ffmpeg)) tools.ffmpeg = ffmpeg
  } catch {
    // пакета нет — не беда, ниже есть запасные варианты
  }
  try {
    // Именно @ffprobe-installer, а не ffprobe-static: последний до сих пор
    // отдаёт сборку 2018 года, а эта — та же линейка, что и у ffmpeg рядом.
    const ffprobe = require('@ffprobe-installer/ffprobe').path
    if (fileExists(ffprobe)) tools.ffprobe = ffprobe
  } catch {
    // то же самое
  }
  return tools
}

// Вызывается электронным слоем при старте: там известно, где лежат файлы
// сборки. Несуществующие пути молча игнорируются — сработает следующий вариант.
function setFfmpegTools({ ffmpeg, ffprobe } = {}) {
  resolved = {
    ffmpeg: fileExists(ffmpeg) ? ffmpeg : undefined,
    ffprobe: fileExists(ffprobe) ? ffprobe : undefined
  }
}

function resolveTool(name) {
  if (resolved && resolved[name]) return resolved[name]
  const fallback = fromNodeModules()
  if (fallback[name]) return fallback[name]
  return name // последняя надежда — PATH
}

const getFfmpegPath = () => resolveTool('ffmpeg')
const getFfprobePath = () => resolveTool('ffprobe')

// Для сообщения пользователю: откуда именно взялись инструменты.
function describeTools() {
  return { ffmpeg: getFfmpegPath(), ffprobe: getFfprobePath() }
}

module.exports = { setFfmpegTools, getFfmpegPath, getFfprobePath, describeTools }
