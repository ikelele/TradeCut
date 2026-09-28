const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')

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
  nvencCheck = null // другой ffmpeg — ответ про видеокарту надо узнать заново
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

// Фоновой работе ffmpeg — приоритет ниже обычного.
//
// Обрезка и разбор кадров идут сами, пока человек торгует: рядом открыт
// терминал и пишет OBS. С обычным приоритетом ffmpeg делил с ними процессор на
// равных — обрезка длинной сделки держала его наполовину занятым больше минуты,
// и пользователь снял её руками. С пониженным он берёт только то, что остальным
// не нужно: терминал и запись идут первыми.
//
// То, чего человек ждёт глазами (кадр в редакторе, «Найти границы»), сюда не
// относится — там важнее скорость.
function lowerPriority(child) {
  if (!child || !child.pid) return
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // Процесс мог уже завершиться — тогда и понижать нечего. Любая другая
    // причина тоже не повод ронять работу: отработает с обычным приоритетом.
  }
}

// Может ли эта машина кодировать H.264 видеокартой NVIDIA (NVENC).
//
// Кодировщик в сборке ffmpeg есть всегда, а работает только при видеокарте
// NVIDIA с драйвером. Узнать это можно одним способом — попробовать: кодируем
// пару кадров чёрного экрана. «Да» помнится до конца работы программы.
//
// «Нет» — только несколько минут. Программа стартует вместе с Windows, и
// драйвер видеокарты в этот момент бывает ещё не готов; запомни мы такой ответ
// навсегда, процессор кодировал бы весь день — ровно то, от чего уходили.
const NVENC_RECHECK_MS = 5 * 60 * 1000
let nvencCheck = null

function hasNvenc() {
  if (!nvencCheck) {
    const check = new Promise((resolve) => {
      execFile(getFfmpegPath(), [
        '-v', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2',
        '-c:v', 'h264_nvenc',
        '-f', 'null', '-'
      ], { timeout: 15000 }, (error) => resolve(!error))
    })
    check.then((ok) => {
      if (ok) return
      setTimeout(() => {
        if (nvencCheck === check) nvencCheck = null
      }, NVENC_RECHECK_MS).unref()
    })
    nvencCheck = check
  }
  return nvencCheck
}

module.exports = { setFfmpegTools, getFfmpegPath, getFfprobePath, describeTools, lowerPriority, hasNvenc }
