// Поиск границ панелей терминала прямо по кадру видео.
//
// Зачем: границы стаканов раньше приходилось либо угадывать арифметикой
// ("экран делится на 6 равных частей"), либо обводить мышью на глаз. А в кадре
// они есть буквально — это линии, которыми терминал разделяет свои панели.
//
// Как ищем. Разделитель — это столбец, где перепад яркости держится почти по
// всей высоте некоторой полосы. Если брать полосу во всю высоту экрана, в
// находки попадают и внутренние линии стакана (ось цены, столбцы таблицы).
// Поэтому полосу подбираем: перебираем узкие полосы по высоте и смотрим, где
// линии выстраиваются в осмысленный набор — идут через всю полосу и не режут
// панели на неправдоподобно узкие куски. Лучше всего это получается в полосе
// ЗАГОЛОВКОВ панелей: там нет таблиц, и вертикальный перепад означает именно
// границу.
//
// Единственный верный ответ здесь не гарантирован: в полосе графиков находится
// свой, более дробный набор линий, и какой из вариантов нужен — знает только
// человек, который смотрит на кадр. Поэтому наружу отдаётся НЕСКОЛЬКО
// вариантов, а в окне они показываются направляющими, к которым прилипает
// рамка. Так ошибка детектора стоит одно движение мышью, а не испорченный клип.
//
// Работает с любым терминалом: читаются пиксели, а не логи и не настройки.

// Одного порога перепада на все терминалы не существует, и это выяснилось на
// живых скриншотах. На тёмной теме с чёткими рамками порог 12 даёт правильные
// восемь колонок, а порог 6 — семнадцать: в находки лезет внутренняя разметка
// стакана. На светлой теме ровно наоборот: разделители бледные, при пороге 12
// не находится вообще ничего, а при 6 — те самые восемь.
//
// Поэтому пробуем по очереди, от строгой настройки к мягкой, и берём первую,
// которая дала правдоподобный набор. Порядок важен: строгая идёт первой, и
// всё, что работало раньше, продолжает работать ровно так же — до мягких
// попыток дело просто не доходит.
const EDGE_ATTEMPTS = [
  { threshold: 12, coverage: 0.85 }, // тёмная тема, рамки в полный контраст
  { threshold: 8, coverage: 0.85 },
  { threshold: 6, coverage: 0.95 }, // светлая тема: перепад бледный, зато сплошной
  { threshold: 6, coverage: 0.85 },
  { threshold: 4, coverage: 0.95 }
]
// Высота пробной полосы. Заголовок панели обычно 20-30 пикселей.
const BAND_HEIGHT = 22
// Шаг перебора полос по высоте
const BAND_STEP = 4
// Панель уже этого — почти наверняка не панель, а внутренняя линия таблицы.
// В долях ширины кадра, чтобы не зависеть от разрешения записи.
const MIN_PANEL_RATIO = 0.025
// Сколько вариантов отдавать наружу
const MAX_VARIANTS = 4
// Ближе этого линии считаются одной и той же
const CLUSTER_GAP = 4
// Во сколько раз неровность промежутков снижает оценку набора. Подобрано по
// живым снимкам: при меньшем значении наборы внутренних линий стакана иногда
// обходили настоящую сетку панелей.
const UNEVENNESS_PENALTY = 3
// Насколько промежуток может отличаться от кратного шагу сетки, чтобы считать
// его слипшимися панелями, а не панелью другого размера.
const GRID_TOLERANCE = 0.25

// Кадр приходит из canvas окна (RGBA) либо из ffmpeg в тестах. Яркость берём
// упрощённо: точные коэффициенты тут ничего не меняют, важен только перепад.
function toGrayscale({ data, width, height }) {
  const gray = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
  }
  return gray
}

function clusterPositions(positions) {
  const clusters = []
  for (const value of positions) {
    const last = clusters[clusters.length - 1]
    if (last && value - last[last.length - 1] <= CLUSTER_GAP) last.push(value)
    else clusters.push([value])
  }
  return clusters.map((cluster) => Math.round(cluster.reduce((a, b) => a + b, 0) / cluster.length))
}

// Вертикальные линии, проходящие через полосу [bandTop, bandTop + bandHeight)
function verticalLinesInBand(gray, width, bandTop, bandHeight, threshold, coverage) {
  const hits = new Int32Array(width - 1)
  for (let y = bandTop; y < bandTop + bandHeight; y++) {
    const row = y * width
    for (let x = 0; x < width - 1; x++) {
      if (Math.abs(gray[row + x + 1] - gray[row + x]) >= threshold) hits[x]++
    }
  }
  const needed = bandHeight * coverage
  const found = []
  for (let x = 0; x < width - 1; x++) if (hits[x] >= needed) found.push(x)
  return clusterPositions(found)
}

// Горизонтальные линии во всю ширину кадра: верх рабочей области, стык рядов
// панелей, верх панели задач. Полосу тут подбирать не нужно — такие линии и
// так проходят через весь кадр.
function horizontalLines(gray, width, height, threshold, coverage) {
  const found = []
  for (let y = 0; y < height - 1; y++) {
    let hits = 0
    const row = y * width
    const next = (y + 1) * width
    for (let x = 0; x < width; x++) {
      if (Math.abs(gray[next + x] - gray[row + x]) >= threshold) hits++
    }
    if (hits / width >= coverage) found.push(y + 1)
  }
  return clusterPositions(found)
}

// Набор границ считается пригодным, если линий хотя бы три (две панели) и ни
// одна панель не вышла подозрительно узкой.
function isPlausible(lines, width) {
  if (lines.length < 3) return false
  const minPanel = width * MIN_PANEL_RATIO
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] - lines[i - 1] < minPanel) return false
  }
  return true
}

// Одинаковые наборы из соседних полос схлопываем в один вариант.
function variantKey(lines) {
  return lines.join(',')
}

// Наборы, отличающиеся на пару пикселей, — это один и тот же вариант, снятый с
// чуть разной высоты. Показывать их как разные было бы издевательством:
// пользователь переключал бы варианты и не видел разницы.
function isSameVariant(a, b) {
  if (a.length !== b.length) return false
  return a.every((value, index) => Math.abs(value - b[index]) <= CLUSTER_GAP)
}

// Насколько набор линий похож на сетку панелей.
//
// Просто "линии нашлись" ничего не значит: внутри стакана своих вертикальных
// линий больше, чем границ панелей, и на части снимков детектор радостно
// возвращал восемнадцать линий там, где панелей шесть. Отличить одно от
// другого можно по тому, как терминал раскладывает панели — плиткой:
//
//   промежутки между настоящими границами почти одинаковые;
//   сами границы покрывают кадр от края до края.
//
// У случайного набора внутренних линий таблицы не выполняется ни то, ни другое.
function gridScore(lines, width) {
  if (lines.length < 3) return 0

  const gaps = []
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1])
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  if (mean <= 0) return 0

  // Коэффициент вариации: 0 — промежутки идеально ровные.
  const spread = Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length) / mean
  const span = (lines[lines.length - 1] - lines[0]) / width

  return span / (1 + spread * UNEVENNESS_PENALTY)
}

// Достраивание пропущенных границ.
//
// Панели разложены плиткой, поэтому промежутки между границами почти
// одинаковые. Если один промежуток оказался ровно вдвое (втрое) шире
// остальных — там почти наверняка потерялась граница: разделитель мог быть
// бледнее соседних или его перекрыло что-то в той полосе, по которой шёл
// поиск. Достраиваем её по шагу сетки.
//
// Кратность проверяется строго: промежуток в полтора раза шире — это не
// пропущенная граница, а просто панель другого размера, и выдумывать там
// линию нельзя.
function fillMissingLines(lines) {
  if (lines.length < 3) return lines

  const gaps = []
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1])
  const sorted = [...gaps].sort((a, b) => a - b)
  const step = sorted[Math.floor(sorted.length / 2)] // медиана устойчивее среднего
  if (step <= 0) return lines

  const filled = [lines[0]]
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i] - lines[i - 1]
    const parts = Math.round(gap / step)
    if (parts >= 2 && Math.abs(gap - parts * step) <= step * GRID_TOLERANCE) {
      for (let k = 1; k < parts; k++) filled.push(Math.round(lines[i - 1] + step * k))
    }
    filled.push(lines[i])
  }
  return filled
}

// Перебор полос по высоте при одной настройке порога.
function scanBands(gray, width, height, { threshold, coverage }) {
  const seen = new Map() // набор линий -> сколько полос его дали
  for (let top = 0; top + BAND_HEIGHT < height; top += BAND_STEP) {
    const lines = verticalLinesInBand(gray, width, top, BAND_HEIGHT, threshold, coverage)
    if (!isPlausible(lines, width)) continue
    const key = variantKey(lines)
    const existing = seen.get(key)
    if (existing) existing.bands++
    else seen.set(key, { lines, bands: 1, top })
  }

  // Чем больше полос подряд дали один и тот же набор, тем он устойчивее: у
  // заголовка панели высота в несколько десятков пикселей, а случайное
  // совпадение держится одну-две полосы.
  const ordered = [...seen.values()].sort((a, b) => b.bands - a.bands || a.top - b.top)
  const variants = []
  for (const item of ordered) {
    if (variants.some((existing) => isSameVariant(existing, item.lines))) continue
    variants.push(item.lines)
    if (variants.length >= MAX_VARIANTS) break
  }
  return variants
}

// detectPanelGuides({ data, width, height }) ->
//   { vertical: number[], horizontal: number[], variants: number[][] }
// vertical — линии лучшего варианта, variants — все найденные (для переключения
// в окне), horizontal — линии во всю ширину.
function detectPanelGuides(frame) {
  const { width, height } = frame
  if (!(width > 8 && height > BAND_HEIGHT * 2)) return { vertical: [], horizontal: [], variants: [] }

  const gray = frame.gray || toGrayscale(frame)

  // Собираем находки со ВСЕХ настроек и выбираем не по тому, какая сработала
  // первой, а по тому, какая больше похожа на сетку панелей. Порог перепада
  // сам по себе ничего не говорит о правильности: на одном терминале верный
  // ответ даёт строгая настройка, на другом — мягкая.
  const found = []
  let used = EDGE_ATTEMPTS[0]

  for (const attempt of EDGE_ATTEMPTS) {
    for (const lines of scanBands(gray, width, height, attempt)) {
      const complete = fillMissingLines(lines)
      if (found.some((item) => isSameVariant(item.lines, complete))) continue
      found.push({ lines: complete, attempt, score: gridScore(complete, width) })
    }
  }

  found.sort((a, b) => b.score - a.score)
  if (found.length > 0) used = found[0].attempt

  const variants = found.slice(0, MAX_VARIANTS).map((item) => item.lines)

  return {
    vertical: variants[0] || [],
    horizontal: horizontalLines(gray, width, height, used.threshold, used.coverage),
    variants
  }
}

// Ближайшая направляющая к позиции, если она в пределах допуска. Иначе
// undefined — значит прилипать не к чему и берём то, что натянул пользователь.
function snapToGuide(value, guides, tolerance) {
  let best
  let bestDistance = tolerance
  for (const guide of guides) {
    const distance = Math.abs(guide - value)
    if (distance <= bestDistance) {
      bestDistance = distance
      best = guide
    }
  }
  return best
}

module.exports = { detectPanelGuides, snapToGuide, toGrayscale }
