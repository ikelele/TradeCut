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
// И третье, без чего первый признак опасен. Он смотрит в нижнюю полосу
// ОБЛАСТИ, молча считая, что низ области — это низ панели. У Vataga так и
// есть. А у стороннего пользователя внизу экрана отдельный ряд графиков, и
// области, размеченные во всю высоту кадра, кончаются на нём. Нижней полосой
// там оказались свечи, и самый цветной график выиграл уверенно: «Стакан 4,
// 5.0%» при нуле у остальных — то есть программа бодро вырезала не тот
// стакан. Молчание было бы лучше.
//
// Отличить маркер от мебели можно, ничего не зная про раскладку: **маркер
// ЗАГОРАЕТСЯ**. В начале клипа позиция ещё не открыта — там запас до входа, —
// значит всё, что там уже горит, к сделке отношения не имеет. Поэтому из
// оценки каждой области вычитается её же оценка в начале клипа.
//
// Замерено: у Vataga нужная область прибавляет 13-14%, у стороннего
// пользователя лучшая прибавка 0.0% и 0.9% — то есть не прибавляет никто, и
// ответа честно нет.
//
// Второй признак ЗАПАСНОЙ, а не равный. На 28 записях Vataga, где первый
// уверен, второй спорил с ним в семи случаях — если дать им равные голоса,
// проверенные ответы превратятся в ничью. Поэтому порядок такой: отвечает
// первый; второй подключается, только когда первый промолчал. И ответу
// второго программа не доверяет до конца: вырезает, но полный клип не удаляет.

// Высота полосы, в которой ищем цвет. Доля от высоты области, а не пиксели:
// при записи в 1080p весь интерфейс терминала мельче ровно во столько же раз.
const BOTTOM_STRIP_RATIO = 0.042
const MIN_STRIP_PX = 24

// Насколько должно прибавиться цветного в полосе, чтобы считать, что плашка
// загорелась.
const MIN_SCORE = 0.05

// Высота пробной полосы для второго признака, в долях высоты кадра
const BAND_RATIO = 0.04
// Заголовок панели пропускаем. Там подсвечена ВКЛАДКА, по которой последний
// раз щёлкнули мышью: она почти всегда совпадает с торгуемой панелью, и
// соблазн велик — но это признак про мышь, а не про сделку. Щёлкнул после
// выхода в соседнюю панель, и он соврёт.
const SKIP_TOP_RATIO = 0.03
// Чтобы деление на почти ноль не давало бесконечный отрыв
const SHARE_FLOOR = 0.002
// Насколько должно ПРИБАВИТЬСЯ цветного в полосе, чтобы считать это маркером
const MIN_BAND_DELTA = 0.01

// Как плашку искать во времени.
//
// Раньше смотрели три кадра — на 30, 50 и 70% клипа. На секундной сделке это
// почти всегда мимо: запас до входа 5 секунд, после выхода 2, и все три кадра
// ложатся до входа. Так 1 октября сделка по US на 1.2 секунды молча ушла в
// запасной признак, а тот выбрал соседний стакан, где просто двигалась цена.
//
// Теперь нижняя полоса читается десять раз в секунду, и ищется то место, где
// плашка ЗАГОРЕЛАСЬ около входа и горела примерно столько, сколько шла сделка.
const SCAN_FPS = 10
// Насколько реальный вход в клипе расходится с ожидаемым. Время сделки — из
// журнала терминала по часам биржи, запись — по часам компьютера, а конец
// буфера OBS программа узнаёт по времени файла, которое на полторы секунды
// позже последнего кадра. На записях автора за две недели плашка загоралась
// от 2.7 секунды раньше ожидаемого до 1.7 секунды позже, и это плавало изо
// дня в день вместе с часами компьютера.
const ENTRY_SLACK_SEC = 3.5
// Начало клипа, где позиции ещё точно нет, — по нему считается, что в полосе
// горит всегда. Самый первый кадр не берём: у записи с рабочего стола он часто
// ещё не отрисован.
const BASELINE_FROM_SEC = 0.4
const MIN_BASELINE_SEC = 0.3
// Длинную сделку целиком не смотрим: плашка горит до выхода, и дюжины секунд
// хватает, чтобы её увидеть. Целиком — это минуты работы ради того же ответа.
const MAX_LIT_SCAN_SEC = 12
// Меньше двух кадров — моргание интерфейса, а не позиция
const MIN_LIT_FRAMES = 2
// Столько кадров подряд плашка может «мигнуть», не прерывая горения
const MAX_GAP_FRAMES = 2
// Одна и та же позиция бывает открыта в нескольких панелях — например, монета
// стоит в двух стаканах. Тогда плашки загораются и гаснут разом, и это не
// «две позиции, выбрать нельзя», а одна — годится любая из панелей.
const SAME_POSITION_SEC = 0.3
// Если загорелось в разных местах в разное время, побеждает то, что горело
// ближе всего к длительности сделки, — с запасом хотя бы в полсекунды.
const DURATION_MARGIN_SEC = 0.5

// Серый интерфейс терминала никогда так не выглядит, а красная и зелёная
// плашки — всегда.
function isVivid(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max > 90 && max - min > 60
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

// Нижняя полоса каждой области в пикселях кадра данного размера.
function bottomStrips(areas, width, height) {
  const strips = []
  for (const area of areas) {
    const rect = resolveCropRect(area, width, height)
    if (!rect) continue // область не ложится на этот кадр — пропускаем
    const stripHeight = Math.max(MIN_STRIP_PX, Math.round(rect.height * BOTTOM_STRIP_RATIO))
    strips.push({
      name: area.name,
      x0: rect.x,
      x1: rect.x + rect.width,
      y0: Math.max(0, rect.y + rect.height - stripHeight),
      y1: Math.min(height, rect.y + rect.height)
    })
  }
  return strips
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// Отрезки времени, когда в полосе области горело заметно больше обычного.
function findLitRuns(samples, names, afterSec, baseline) {
  const runs = []
  names.forEach((name, index) => {
    let run = null
    let misses = 0
    for (const sample of samples) {
      if (sample.timeSec <= afterSec) continue
      const growth = sample.scores[index] - baseline[index]
      if (growth >= MIN_SCORE) {
        if (!run) run = { name, index, start: sample.timeSec, end: sample.timeSec, frames: 0, growth: 0 }
        run.end = sample.timeSec
        run.frames++
        run.growth += growth
        misses = 0
      } else if (run && ++misses > MAX_GAP_FRAMES) {
        runs.push(run)
        run = null
        misses = 0
      }
    }
    if (run) runs.push(run)
  })
  return runs
}

// Где в клипе загорелась плашка этой сделки.
//
// samples — [{ timeSec, scores }]: доля цветного в нижней полосе каждой
// области (в порядке names) на каждом прочитанном кадре. hint — где в клипе
// ожидается вход (entrySec), сколько шла сделка (tradeSec) и докуда клип
// прочитан (scanEndSec).
//
// Возвращает { winner, groups }: groups — все места, где плашка загоралась
// около входа (одновременные панели собраны вместе), winner — то из них, что
// подходит к сделке, либо null, если выбрать нельзя.
function pickAreaFromScan(samples, names, { entrySec, tradeSec, scanEndSec }) {
  if (!Array.isArray(names) || names.length < 2) return { winner: null, groups: [] }

  const baselineUntil = Math.max(BASELINE_FROM_SEC + MIN_BASELINE_SEC, entrySec - ENTRY_SLACK_SEC)
  const before = samples.filter((sample) => sample.timeSec >= BASELINE_FROM_SEC && sample.timeSec <= baselineUntil)
  if (before.length === 0) return { winner: null, groups: [] }
  // Медиана, а не один кадр: мигнувшая в начале клипа строка не должна
  // сдвигать «обычное» для всей области.
  const baseline = names.map((_, index) => median(before.map((sample) => sample.scores[index])))

  const frameSec = 1 / SCAN_FPS
  const runs = findLitRuns(samples, names, baselineUntil, baseline)
    .filter((run) => run.frames >= MIN_LIT_FRAMES && Math.abs(run.start - entrySec) <= ENTRY_SLACK_SEC)
    .sort((a, b) => a.start - b.start)

  const groups = []
  for (const run of runs) {
    const same = groups.find((group) => Math.abs(group.start - run.start) <= SAME_POSITION_SEC
      && Math.abs(group.end - run.end) <= SAME_POSITION_SEC)
    if (same) same.runs.push(run)
    else groups.push({ start: run.start, end: run.end, runs: [run] })
  }

  for (const group of groups) {
    group.seconds = group.end - group.start + frameSec
    // Горело до самого конца прочитанного — значит, может гореть и дальше:
    // длинную сделку целиком не читаем. Короче сделки это не ошибка.
    const cut = group.end >= scanEndSec - 2 * frameSec
    group.mismatch = cut ? Math.max(0, group.seconds - tradeSec) : Math.abs(group.seconds - tradeSec)
    // Из одновременных панелей — первую по порядку областей: годится любая,
    // но пусть одна и та же монета режется всегда в одну и ту же панель
    group.best = group.runs.reduce((a, b) => (b.index < a.index ? b : a))
  }
  groups.sort((a, b) => a.mismatch - b.mismatch)

  const [first, second] = groups
  const winner = first && (!second || first.mismatch + DURATION_MARGIN_SEC < second.mismatch) ? first : null
  return { winner, groups }
}

function describeGroup(group) {
  const names = group.runs.map((run) => `«${run.name}»`).join(' и ')
  return `${names} ${group.seconds.toFixed(1)}с с ${group.start.toFixed(1)}с`
}

// Второй признак: в какой области ЧТО-ТО ПОЯВИЛОСЬ на своей высоте.
//
// Сравниваем каждую полосу с её же видом в начале клипа, до входа. Сравнение
// идёт на одной высоте и внутри одного кадра, поэтому не зависит ни от темы,
// ни от того, что именно рисует терминал: у всех панелей на этом уровне
// нарисовано одно и то же, и постоянная мебель вычитается сама.
//
// Без кадра «до» этот признак не работает: он брал самую цветную полосу и на
// записях стороннего пользователя показывал то 10-й стакан, то 4-й, то 6-й —
// просто по тому, где ярче свечи. С вычитанием обе его записи определяются
// единогласно и верно.
//
// Возвращает { name, delta, runnerUp, confident } либо null.
function detectAreaByStandOut(frame, areas, before) {
  if (!Array.isArray(areas) || areas.length < 2) return null
  if (!before || before.width !== frame.width || before.height !== frame.height) return null

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
    const deltas = rects
      .map((item) => ({
        name: item.name,
        value: shareIn(frame, item.rect.x, item.rect.x + item.rect.width, top, top + step)
          - shareIn(before, item.rect.x, item.rect.x + item.rect.width, top, top + step)
      }))
      .sort((a, b) => b.value - a.value)

    if (deltas[0].value < MIN_BAND_DELTA) continue
    // Отрыв считаем разностью, а не отношением: доли тут близки к нулю, и
    // отношение от такого взрывается на пустом месте.
    const margin = deltas[0].value - Math.max(0, deltas[1].value)
    const known = best.get(deltas[0].name)
    if (known === undefined || margin > known) best.set(deltas[0].name, margin)
  }

  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return null
  return {
    name: ranked[0][0],
    delta: ranked[0][1],
    runnerUp: ranked.length > 1 ? ranked[1][1] : 0,
    // Решает не порог, а голосование по кадрам: разошлись кадры — ответа нет.
    confident: true
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

// Короче этого клип целиком помещается в запас по краям, и «начала до входа»
// в нём может не быть вовсе — тогда второму признаку сравнивать не с чем.
const MIN_BASELINE_CLIP_SEC = 2

// Кадры для второго признака. Он смотрит целые кадры — 40 МБ каждый на двух
// мониторах, — поэтому их мало. Чаще брать пробовали — стало хуже: 1 верный
// ответ из 4 вместо 2. Лишние кадры попадают туда, где позиции уже нет, а
// голос этот признак отдаёт всегда.
const SAMPLE_POINTS = [0.3, 0.5, 0.7]

// Первый признак: полоса внизу по всему отрезку около входа.
async function scanBottomStrips(clipPath, areas, size, toSec) {
  const { scanBand } = require('./videoFrame')
  const strips = bottomStrips(areas, size.width, size.height)
  if (strips.length < 2) return null

  // Одна полоса строк, в которую попадают низы всех областей. Края — чётные
  // (см. scanBand).
  const top = Math.floor(Math.min(...strips.map((strip) => strip.y0)) / 2) * 2
  const bottom = Math.min(size.height, Math.ceil(Math.max(...strips.map((strip) => strip.y1)) / 2) * 2)

  const samples = []
  await scanBand(clipPath, { toSec, fps: SCAN_FPS, y: top, height: bottom - top, width: size.width, background: true }, (band) => {
    samples.push({
      timeSec: band.timeSec,
      scores: strips.map((strip) => shareIn(band, strip.x0, strip.x1, strip.y0 - top, strip.y1 - top))
    })
  })
  return { names: strips.map((strip) => strip.name), samples }
}

async function detectByStandOut(clipPath, areas, size, duration, log) {
  const { grabFrameRgba } = require('./videoFrame')
  if (duration < MIN_BASELINE_CLIP_SEC) return null
  // Разбор идёт сам, никто его не ждёт — кадры читаются в фоне (см. grabFrameRgba)
  const frameOptions = { ...size, background: true }

  let before
  try {
    before = await grabFrameRgba(clipPath, BASELINE_FROM_SEC, frameOptions)
  } catch (error) {
    log(`Кадр до входа не достался: ${error.message}`)
    return null
  }

  const results = []
  for (const at of SAMPLE_POINTS) {
    const timeSec = duration * at
    try {
      const frame = await grabFrameRgba(clipPath, timeSec, frameOptions)
      results.push(detectAreaByStandOut(frame, areas, before))
    } catch (error) {
      log(`Кадр на ${Math.round(timeSec)}с не разобрался: ${error.message}`)
      results.push(null)
    }
  }

  const summary = results
    .map((result) => (result ? `${result.name} +${(result.delta * 100).toFixed(1)}%` : 'нет ответа'))
    .join(', ')
  return { name: pickAreaByVotes(results), summary }
}

// Разбор целого клипа.
//
// hint — где в клипе ожидается вход (entrySec: запас до входа из настроек) и
// сколько шла сделка (tradeSec). Без него вход считается в начале клипа.
//
// Возвращает { name, sure } либо null — "определить не удалось", и это
// нормальный ответ, а не сбой. sure = false, когда решил запасной признак:
// тогда полный клип удалять нельзя — ответ может быть чужим стаканом.
async function detectTradeArea(clipPath, areas, log = () => {}, hint = {}) {
  // Молчать тут нельзя. У стороннего пользователя области стёрло сохранением
  // настроек, и в журнале осталась только строка «область не определена» —
  // выглядело как отказ распознавания, хотя распознавать было нечего.
  if (!Array.isArray(areas) || areas.length < 2) {
    log(`Область сделки не ищем: настроенных областей ${Array.isArray(areas) ? areas.length : 0},`
      + ' а нужно хотя бы две. Размести области в окне разметки.')
    return null
  }

  const { probeVideoSize, probeDurationSeconds } = require('./clipper')
  const size = await probeVideoSize(clipPath)
  const duration = await probeDurationSeconds(clipPath)

  const entrySec = Math.min(Math.max(0, Number(hint.entrySec) || 0), duration)
  const tradeSec = Number.isFinite(Number(hint.tradeSec)) && Number(hint.tradeSec) >= 0
    ? Number(hint.tradeSec)
    : Math.max(0, duration - entrySec)
  const scanEndSec = Math.min(duration, entrySec + Math.min(tradeSec, MAX_LIT_SCAN_SEC) + ENTRY_SLACK_SEC)

  let plateSummary = 'не читалась'
  try {
    const scan = await scanBottomStrips(clipPath, areas, size, scanEndSec)
    if (scan) {
      const { winner, groups } = pickAreaFromScan(scan.samples, scan.names, { entrySec, tradeSec, scanEndSec })
      if (winner) {
        const others = winner.runs.filter((run) => run !== winner.best).map((run) => `«${run.name}»`)
        log(`Область сделки определена как «${winner.best.name}»: плашка горела ${winner.seconds.toFixed(1)}с,`
          + ` с ${winner.start.toFixed(1)}с клипа (вход ожидали на ${entrySec.toFixed(1)}с, сделка ${tradeSec.toFixed(1)}с)`
          + (others.length ? `. Та же плашка разом горела и в ${others.join(', ')} — одна позиция в нескольких панелях` : ''))
        return { name: winner.best.name, sure: true }
      }
      plateSummary = groups.length === 0
        ? 'плашка около входа не загоралась'
        : `загоралась по-разному, какая из них эта сделка — не ясно: ${groups.map(describeGroup).join('; ')}`
    }
  } catch (error) {
    plateSummary = `не прочиталась: ${error.message}`
  }

  // Первый признак промолчал — спрашиваем запасной. Порядок именно такой:
  // равным голосом запасной ломает то, что первый определяет верно.
  const fallback = await detectByStandOut(clipPath, areas, size, duration, log)
  if (fallback && fallback.name) {
    log(`Область сделки определена по тому, что в ней появилось, как «${fallback.name}» — без полной уверенности.`
      + ` Полоса внизу: ${plateSummary}. По отрыву: ${fallback.summary}`)
    return { name: fallback.name, sure: false }
  }

  log(`Определить область сделки не удалось. Полоса внизу: ${plateSummary}.`
    + (fallback ? ` По изменениям: ${fallback.summary}` : ''))
  return null
}

module.exports = {
  detectTradeArea,
  pickAreaFromScan,
  detectAreaByStandOut,
  pickAreaByVotes,
  bottomStrips,
  shareIn,
  MIN_SCORE,
  SCAN_FPS
}
