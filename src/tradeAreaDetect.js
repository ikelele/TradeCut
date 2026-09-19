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
//
// Но это признак ОДНОГО терминала. У TigerTrade внизу панели ничего такого
// нет: на светлой теме там 0.0-0.7% цветного, на тёмной — 10-11%, но сразу у
// всех панелей, потому что внизу у каждой свой мини-график. Замерено на
// четырёх записях: ноль верных ответов из четырёх.
//
// Маркер у TigerTrade всё-таки есть — плашка PnL и подсветка позиции в ленте,
// — только он НЕ на дне панели, а на уровне цены, и ездит по вертикали вместе
// с ней. Искать его «где-то в панели» бесполезно: у графика внутри панели
// цветного всегда больше. Зато на одной высоте у всех панелей нарисовано одно
// и то же — те же строки ленты, тот же кусок графика, — и панель с позицией на
// своём уровне отрывается от соседей в десятки раз. Это второй признак.
//
// Второй признак ЗАПАСНОЙ, а не равный. На 28 записях Vataga, где первый
// уверен, второй спорил с ним в семи случаях — если дать им равные голоса,
// проверенные ответы превратятся в ничью. Поэтому порядок такой: отвечает
// первый; второй подключается, только когда первый промолчал.

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

// Высота пробной полосы для второго признака, в долях высоты кадра
const BAND_RATIO = 0.04
// Заголовок панели пропускаем. Там подсвечена ВКЛАДКА, по которой последний
// раз щёлкнули мышью: она почти всегда совпадает с торгуемой панелью, и
// соблазн велик — но это признак про мышь, а не про сделку. Щёлкнул после
// выхода в соседнюю панель, и он соврёт.
const SKIP_TOP_RATIO = 0.03
// Чтобы деление на почти ноль не давало бесконечный отрыв
const SHARE_FLOOR = 0.002
// Полосу бледнее этого за маркер не считаем
const MIN_BAND_SHARE = 0.01
// Во сколько раз лидер должен опережать вторую панель, чтобы второй признак
// вообще подал голос. Замерено: у ошибочного ответа отрыв был в 1.05 раза, у
// верных — от 1.4 до 5.4.
const STANDOUT_GATE = 1.3

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

// Доля насыщенно-цветных пикселей в прямоугольнике
function shareIn(frame, fromX, toX, fromY, toY) {
  const x0 = Math.max(0, Math.min(frame.width, fromX))
  const x1 = Math.max(0, Math.min(frame.width, toX))
  const y0 = Math.max(0, Math.min(frame.height, fromY))
  const y1 = Math.max(0, Math.min(frame.height, toY))
  const pixels = (y1 - y0) * (x1 - x0)
  if (pixels <= 0) return 0

  let vivid = 0
  for (let y = y0; y < y1; y++) {
    const row = y * frame.width
    for (let x = x0; x < x1; x++) {
      const i = (row + x) * 4
      if (isVivid(frame.data[i], frame.data[i + 1], frame.data[i + 2])) vivid++
    }
  }
  return vivid / pixels
}

// Второй признак: какая область отрывается от соседей НА ОДНОЙ С НИМИ ВЫСОТЕ.
// Возвращает { name, margin, runnerUp, confident } либо null.
function detectAreaByStandOut(frame, areas) {
  if (!Array.isArray(areas) || areas.length < 2) return null

  const rects = []
  for (const area of areas) {
    const rect = resolveCropRect(area, frame.width, frame.height)
    if (rect) rects.push({ name: area.name, rect })
  }
  if (rects.length < 2) return null

  const step = Math.max(1, Math.round(frame.height * BAND_RATIO))
  const from = Math.round(frame.height * SKIP_TOP_RATIO)
  // Лучший отрыв каждой области по всем высотам
  const best = new Map()

  for (let top = from; top + step <= frame.height; top += step) {
    const shares = rects
      .map((item) => ({
        name: item.name,
        value: shareIn(frame, item.rect.x, item.rect.x + item.rect.width, top, top + step)
      }))
      .sort((a, b) => b.value - a.value)

    if (shares[0].value < MIN_BAND_SHARE) continue
    const margin = shares[0].value / Math.max(shares[1].value, SHARE_FLOOR)
    const known = best.get(shares[0].name)
    if (known === undefined || margin > known) best.set(shares[0].name, margin)
  }

  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return null
  const runnerUp = ranked.length > 1 ? ranked[1][1] : 0
  return {
    name: ranked[0][0],
    margin: ranked[0][1],
    runnerUp,
    confident: ranked.length < 2 || ranked[0][1] >= runnerUp * STANDOUT_GATE
  }
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

// Чаще брать кадры пробовали — стало хуже: 1 верный ответ из 4 вместо 2.
// Маркер позиции горит не весь клип, а пока позиция открыта, и лишние кадры
// попадают туда, где её уже нет. Их голоса перевешивают верные.
//
// Правильный ход не «чаще», а «в нужном окне»: время входа и выхода есть в
// журнале терминала, размер запаса по краям — в настройках. Пока эти границы
// сюда не переданы, частить бессмысленно.

// Разбор целого клипа. Возвращает имя области либо null — "определить не
// удалось", и это нормальный ответ, а не сбой.
async function detectTradeArea(clipPath, areas, log = () => {}) {
  // Молчать тут нельзя. У стороннего пользователя области стёрло сохранением
  // настроек, и в журнале осталась только строка «область не определена» —
  // выглядело как отказ распознавания, хотя распознавать было нечего.
  if (!Array.isArray(areas) || areas.length < 2) {
    log(`Область сделки не ищем: настроенных областей ${Array.isArray(areas) ? areas.length : 0},`
      + ' а нужно хотя бы две. Размести области в окне разметки.')
    return null
  }

  const { probeVideoSize, probeDurationSeconds } = require('./clipper')
  const { grabFrameRgba } = require('./videoFrame')

  const size = await probeVideoSize(clipPath)
  const duration = await probeDurationSeconds(clipPath)

  const results = []
  const backup = []
  for (const at of SAMPLE_POINTS) {
    const timeSec = duration * at
    try {
      const frame = await grabFrameRgba(clipPath, timeSec, size)
      results.push(detectAreaInFrame(frame, areas))
      backup.push(detectAreaByStandOut(frame, areas))
    } catch (error) {
      log(`Кадр на ${Math.round(timeSec)}с не разобрался: ${error.message}`)
      results.push(null)
      backup.push(null)
    }
  }

  const summary = results
    .map((r) => (r ? `${r.name} ${(r.score * 100).toFixed(1)}%${r.confident ? '' : ' (неуверенно)'}` : 'нет ответа'))
    .join(', ')

  const picked = pickAreaByVotes(results)
  if (picked) {
    log(`Область сделки определена как «${picked}». По кадрам: ${summary}`)
    return picked
  }

  // Первый признак промолчал — спрашиваем запасной. Порядок именно такой:
  // равным голосом запасной ломает то, что первый определяет верно.
  const fallback = pickAreaByVotes(backup)
  const backupSummary = backup
    .map((r) => (r ? `${r.name} отрыв ${r.margin.toFixed(1)}x${r.confident ? '' : ' (неуверенно)'}` : 'нет ответа'))
    .join(', ')

  if (fallback) {
    log(`Область сделки определена по отрыву на своей высоте как «${fallback}».`
      + ` Полоса внизу ничего не дала (${summary}), по отрыву: ${backupSummary}`)
    return fallback
  }

  log(`Определить область сделки не удалось. По полосе внизу: ${summary}. По отрыву: ${backupSummary}`)
  return null
}

module.exports = {
  detectTradeArea,
  detectAreaInFrame,
  detectAreaByStandOut,
  pickAreaByVotes,
  scoreArea,
  MIN_SCORE,
  MIN_MARGIN
}
