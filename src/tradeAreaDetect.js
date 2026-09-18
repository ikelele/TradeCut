const { resolveCropRect } = require('./cropRect')

// В какой из настроенных областей кадра шла сделка.
//
// Из журнала терминала этого не узнать: там есть символ, сторона и время, но
// нет ничего про экран — терминал понятия не имеет, что его снимает OBS и в
// какой части монитора он нарисован. Значит единственный источник правды — сам
// кадр.
//
// Читать тикер в шапке панели пришлось бы распознаванием текста: это десятки
// мегабайт библиотеки внутрь сборки и постоянная путаница 0 с O на мелком
// шрифте. Но оказалось, что есть признак куда проще: у панели с открытой
// позицией внизу горит цветная полоса с ценой и результатом, а у соседних там
// ровный серый интерфейс. Достаточно посчитать насыщенно-цветные пиксели.
//
// На восемнадцати настоящих сделках из записей автора уверенный ответ совпал с
// торгуемой монетой во всех восемнадцати случаях.

// Высота полосы, в которой ищем цвет. Доля от высоты области, а не пиксели:
// при записи в 1080p весь интерфейс терминала мельче ровно во столько же раз.
const BOTTOM_STRIP_RATIO = 0.042
const MIN_STRIP_PX = 24

// Ниже этой доли цветного считаем, что полосы нет вовсе.
const MIN_SCORE = 0.05
// Во сколько раз лидер должен опережать вторую область. Две открытые позиции
// разом дают две полосы, и тогда выбирать между ними нельзя: без чтения тикера
// программа не знает, какая из них та самая. Лучше честно ответить "не знаю",
// чем молча вырезать чужую монету.
const MIN_MARGIN = 4

// Серый интерфейс терминала никогда так не выглядит, а красная и зелёная
// плашки — всегда.
function isVivid(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max > 90 && max - min > 60
}

// Доля насыщенно-цветных пикселей в нижней полосе одной области.
function scoreArea(frame, rect) {
  const stripHeight = Math.max(MIN_STRIP_PX, Math.round(rect.height * BOTTOM_STRIP_RATIO))
  const fromY = Math.max(0, Math.min(frame.height, rect.y + rect.height - stripHeight))
  const toY = Math.max(0, Math.min(frame.height, rect.y + rect.height))
  const fromX = Math.max(0, Math.min(frame.width, rect.x))
  const toX = Math.max(0, Math.min(frame.width, rect.x + rect.width))

  const pixels = (toY - fromY) * (toX - fromX)
  if (pixels <= 0) return 0

  let vivid = 0
  for (let y = fromY; y < toY; y++) {
    const row = y * frame.width
    for (let x = fromX; x < toX; x++) {
      const i = (row + x) * 4
      if (isVivid(frame.data[i], frame.data[i + 1], frame.data[i + 2])) vivid++
    }
  }
  return vivid / pixels
}

// Разбор одного кадра: какая область "горит" и насколько уверенно.
// Возвращает { name, score, runnerUp, confident } либо null, если сравнивать не с чем.
function detectAreaInFrame(frame, areas) {
  // Одна область — выбирать не из чего, и "определение" было бы самообманом.
  if (!Array.isArray(areas) || areas.length < 2) return null

  const scored = []
  for (const area of areas) {
    const rect = resolveCropRect(area, frame.width, frame.height)
    if (!rect) continue // область не ложится на этот кадр — пропускаем
    scored.push({ name: area.name, score: scoreArea(frame, rect) })
  }
  if (scored.length < 2) return null

  scored.sort((a, b) => b.score - a.score)
  const [best, second] = scored

  return {
    name: best.name,
    score: best.score,
    runnerUp: second.score,
    confident: best.score >= MIN_SCORE && best.score >= second.score * MIN_MARGIN
  }
}

// Итог по нескольким кадрам: побеждает область, набравшая больше уверенных
// голосов. Один кадр мог попасть на моргание интерфейса или на миг, когда
// позиция уже закрыта, — по трём кадрам такое не проходит.
function pickAreaByVotes(results) {
  const votes = new Map()
  for (const result of results) {
    if (!result || !result.confident) continue
    votes.set(result.name, (votes.get(result.name) || 0) + 1)
  }
  if (votes.size === 0) return null

  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1])
  // Ничья между разными областями — это ровно тот случай, когда угадывать
  // нельзя: две позиции одновременно выглядят именно так.
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null
  return ranked[0][0]
}

// Моменты, по которым смотрим клип. Не у самых краёв: в начале позиция ещё не
// открыта, в конце уже закрыта, и полосы там может не быть.
const SAMPLE_POINTS = [0.3, 0.5, 0.7]

// Разбор целого клипа. Возвращает имя области либо null — "определить не
// удалось", и это нормальный ответ, а не сбой.
async function detectTradeArea(clipPath, areas, log = () => {}) {
  if (!Array.isArray(areas) || areas.length < 2) return null

  const { probeVideoSize, probeDurationSeconds } = require('./clipper')
  const { grabFrameRgba } = require('./videoFrame')

  const size = await probeVideoSize(clipPath)
  const duration = await probeDurationSeconds(clipPath)

  const results = []
  for (const at of SAMPLE_POINTS) {
    const timeSec = duration * at
    try {
      const frame = await grabFrameRgba(clipPath, timeSec, size)
      results.push(detectAreaInFrame(frame, areas))
    } catch (error) {
      log(`Кадр на ${Math.round(timeSec)}с не разобрался: ${error.message}`)
      results.push(null)
    }
  }

  const picked = pickAreaByVotes(results)
  const summary = results
    .map((r) => (r ? `${r.name} ${(r.score * 100).toFixed(1)}%${r.confident ? '' : ' (неуверенно)'}` : 'нет ответа'))
    .join(', ')

  if (picked) log(`Область сделки определена как «${picked}». По кадрам: ${summary}`)
  else log(`Определить область сделки не удалось. По кадрам: ${summary}`)

  return picked
}

module.exports = {
  detectTradeArea,
  detectAreaInFrame,
  pickAreaByVotes,
  scoreArea,
  MIN_SCORE,
  MIN_MARGIN
}
