// Приведение выделенной мышью рамки к тому, что реально примет ffmpeg.
//
// Рамка приходит из окна превью в пикселях ИСХОДНОГО кадра (не экранных: в
// окне видео показано уменьшенным, пересчёт делает сама страница). Но между
// выделением и нарезкой может пройти сколько угодно времени, и применяться
// рамка может к другому файлу — поэтому здесь она приводится к размеру
// конкретного видео.
//
// Три вещи, без которых ffmpeg откажется резать или отдаст мусор:
// 1. Чётность. H.264 с обычной цветовой субдискретизацией (yuv420p) не умеет
//    нечётные размеры и смещения — 401 пиксель шириной вырезать нельзя.
// 2. Границы. Рамка не должна вылезать за кадр: crop за пределами кадра — это
//    ошибка ffmpeg, а не молчаливое обрезание.
// 3. Масштаб. Пресет, снятый на записи 3440x1440, к записи 1920x1080 надо
//    применять пропорционально, иначе выделение уедет.

// Вниз, а не к ближайшему: округление вверх могло бы вытолкнуть рамку за край.
function floorToEven(value) {
  const rounded = Math.floor(value)
  return rounded - (rounded % 2)
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0
}

// Меньше этого по стороне — заведомо промах, а не намерение: на записи
// шириной в тысячи пикселей полоска в десяток никому не нужна. Лучше честно
// отказаться, чем молча отдать огрызок кадра.
const MIN_CROP_SIDE = 16

// rect: { x, y, width, height, sourceWidth?, sourceHeight? }
// Возвращает { x, y, width, height } под размер videoWidth x videoHeight
// либо undefined, если рамка бессмысленна (нулевая, не число, вся за кадром).
function resolveCropRect(rect, videoWidth, videoHeight) {
  if (!rect) return undefined
  if (!isPositiveNumber(videoWidth) || !isPositiveNumber(videoHeight)) return undefined

  const width = Number(rect.width)
  const height = Number(rect.height)
  if (!isPositiveNumber(width) || !isPositiveNumber(height)) return undefined

  // Масштабируем, только если известен размер записи, на которой рамку сняли,
  // и он отличается от текущей. Иначе считаем, что рамка уже в нужных пикселях.
  const sourceWidth = Number(rect.sourceWidth)
  const sourceHeight = Number(rect.sourceHeight)
  const scaleX = isPositiveNumber(sourceWidth) ? videoWidth / sourceWidth : 1
  const scaleY = isPositiveNumber(sourceHeight) ? videoHeight / sourceHeight : 1

  const rawX = Math.max(0, Math.round(Number(rect.x) || 0) * scaleX)
  const rawY = Math.max(0, Math.round(Number(rect.y) || 0) * scaleY)

  // Начало рамки вне кадра — это не "чуть промахнулись", а рамка не от этого
  // файла. Прижимать её к краю нельзя: получилась бы полоска в пару пикселей,
  // и человек ломал бы голову, почему клип пустой.
  if (rawX >= videoWidth || rawY >= videoHeight) return undefined

  // Смещение сначала: от него зависит, сколько места остаётся под размер.
  const x = floorToEven(rawX)
  const y = floorToEven(rawY)

  const finalWidth = floorToEven(Math.min(width * scaleX, videoWidth - x))
  const finalHeight = floorToEven(Math.min(height * scaleY, videoHeight - y))
  if (finalWidth < MIN_CROP_SIDE || finalHeight < MIN_CROP_SIDE) return undefined

  return { x, y, width: finalWidth, height: finalHeight }
}

// Рамка на весь кадр — ею же описывается "ничего не резать".
function isFullFrame(rect, videoWidth, videoHeight) {
  const resolved = resolveCropRect(rect, videoWidth, videoHeight)
  if (!resolved) return false
  return resolved.x === 0 && resolved.y === 0
    && resolved.width >= floorToEven(videoWidth)
    && resolved.height >= floorToEven(videoHeight)
}

// Имя пресета попадает в имя файла, поэтому чистим от того, что Windows в
// именах не разрешает. Пустое имя — не ошибка: подставится общее "crop".
function sanitizePresetName(name) {
  return String(name ?? '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)
}

module.exports = { resolveCropRect, isFullFrame, sanitizePresetName, floorToEven }
