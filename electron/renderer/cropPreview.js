// Превью клипа с рамкой обрезки, которую тянут мышью.
//
// Зачем: "Стакан 1..6" — это арифметика (ширина экрана делится поровну), и
// границы там угаданные. Здесь рамка снимается с настоящего кадра, поэтому
// попадает точно и работает с любой раскладкой окон, а не только с той, под
// которую подбирали числа.
//
// Координаты. Видео показано уменьшенным, поэтому всё, что видно на странице,
// хранится в CSS-пикселях, а наружу (в ffmpeg) отдаётся в пикселях исходного
// кадра — пересчёт в pageToVideo(). Приводить к чётным числам и прижимать к
// границам кадра здесь НЕ нужно: этим занимается src/cropRect.js, у которого
// есть настоящий размер файла от ffprobe.

const MIN_BOX_PX = 12 // меньше просто не ухватить мышью
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
// Сколько места под кадром надо оставить на дорожку обрезки, подпись и кнопки.
// Раньше вместо этого бралась доля высоты окна — и она не учитывала того, что
// НАД кадром (заголовок, выбор файла, кнопки областей). В итоге при открытом
// превью дорожка и кнопка "Вырезать" уезжали за нижний край окна.
const CONTROLS_BELOW_STAGE_PX = 210
// На совсем маленьком окне кадру всё равно надо оставить хоть сколько-то
const MIN_STAGE_HEIGHT_PX = 160
// Насколько близко надо подвести край рамки к направляющей, чтобы он к ней
// прилип. В экранных пикселях: зависит от точности мыши, а не от записи.
const SNAP_TOLERANCE_PX = 7

// Короче этого обрезать нечего: ручки просто слиплись бы.
const MIN_KEPT_SEC = 0.5

// 74.5 -> "1:14.5"; секунды с десятой долей, потому что обрезка обычно
// измеряется секундами, а не минутами.
function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
}

function createCropPreview(root, { onChange = () => {}, onTrimChange = () => {} } = {}) {
  root.innerHTML = `
    <div class="preview-stage" data-role="stage">
      <video data-role="video" preload="metadata"></video>
      <div class="crop-box" data-role="box" hidden>
        ${HANDLES.map((h) => `<div class="crop-handle crop-handle-${h}" data-handle="${h}"></div>`).join('')}
      </div>
      <!-- Направляющие рисуются ПОСЛЕ рамки: иначе затемнение вокруг неё
           (большая тень) перекрыло бы линии за пределами выделения. -->
      <div class="guides" data-role="guides"></div>
      <div class="grid-layer" data-role="grid" hidden></div>
    </div>
    <div class="preview-bar">
      <button type="button" class="secondary play-button" data-role="play">▶</button>
      <button type="button" class="secondary play-button" data-role="sound" title="Звук в превью (на результат не влияет)">🔊</button>
      <div class="timeline" data-role="timeline">
        <div class="timeline-range" data-role="range"></div>
        <div class="timeline-playhead" data-role="playhead"></div>
        <div class="timeline-handle timeline-handle-start" data-trim="start"></div>
        <div class="timeline-handle timeline-handle-end" data-trim="end"></div>
      </div>
      <span class="preview-size" data-role="size"></span>
    </div>
    <p class="field-hint" data-role="trim-label"></p>
    <div class="preview-actions">
      <label class="grid-count">Разбить на
        <input type="number" data-role="grid-count" min="0" max="24" step="1" placeholder="6">
        частей</label>
      <button type="button" class="secondary" data-role="detect">Найти границы</button>
      <button type="button" class="secondary" data-role="variant" hidden>Другой вариант</button>
      <button type="button" class="secondary" data-role="reset">Вся картинка</button>
      <input type="text" data-role="preset-name" placeholder="Имя области, например «Левый стакан»" maxlength="40">
      <button type="button" class="secondary" data-role="save">Сохранить область</button>
      <button type="button" class="secondary" data-role="save-all" hidden>Сохранить все области</button>
    </div>
    <p class="field-hint" data-role="status"></p>
  `

  const stage = root.querySelector('[data-role="stage"]')
  const video = root.querySelector('[data-role="video"]')
  const box = root.querySelector('[data-role="box"]')
  const guidesEl = root.querySelector('[data-role="guides"]')
  const detectButton = root.querySelector('[data-role="detect"]')
  const variantButton = root.querySelector('[data-role="variant"]')
  const saveAllButton = root.querySelector('[data-role="save-all"]')
  const timeline = root.querySelector('[data-role="timeline"]')
  const rangeEl = root.querySelector('[data-role="range"]')
  const playheadEl = root.querySelector('[data-role="playhead"]')
  const playButton = root.querySelector('[data-role="play"]')
  const soundButton = root.querySelector('[data-role="sound"]')
  const trimLabelEl = root.querySelector('[data-role="trim-label"]')
  const sizeEl = root.querySelector('[data-role="size"]')
  const statusEl = root.querySelector('[data-role="status"]')
  const nameInput = root.querySelector('[data-role="preset-name"]')
  const gridLayer = root.querySelector('[data-role="grid"]')
  const gridCountInput = root.querySelector('[data-role="grid-count"]')

  // Рамка в CSS-пикселях относительно левого верхнего угла видео
  let boxRect = null
  let naturalSize = null // { width, height } исходного кадра
  // Границы того, что оставляем, в секундах от начала файла. Наружу отдаём
  // привычные "сколько отрезать с начала" и "сколько с конца", потому что
  // именно этими числами оперирует ffmpeg и числовые поля формы.
  let keepFrom = 0
  let keepTo = 0
  // Форма может задать обрезку до того, как станет известна длительность
  let pendingTrim = null
  // И область — до того, как станет известен размер кадра (см. showAreaWhenReady)
  let pendingArea = null
  // Найденные границы панелей в пикселях ИСХОДНОГО кадра
  let guides = { vertical: [], horizontal: [], variants: [] }
  let variantIndex = 0
  let currentClipPath = null
  // Сетка областей: границы в пикселях ИСХОДНОГО кадра. Не в экранных, как
  // рамка, — иначе изменение размера окна сдвигало бы уже расставленные
  // границы, а это главное, что человек здесь делает руками.
  let grid = null // { dividers: number[], top: number, bottom: number }

  function displaySize() {
    return { width: video.clientWidth, height: video.clientHeight }
  }

  // Кадр должен растягиваться на всю ширину окна, но не быть выше отведённой
  // доли экрана. В CSS это не выразить: предел зависит от пропорций конкретной
  // записи. Поэтому ставим сцене максимальную ширину, посчитанную из них —
  // тогда высота сама упрётся в нужное значение, а коробка сцены по-прежнему
  // совпадает с картинкой (это важно для координат рамки).
  function applyStageLimit() {
    if (!naturalSize) return
    const aspect = naturalSize.width / naturalSize.height
    // Меряем, сколько места реально осталось: от верха кадра до низа окна
    // минус то, что должно уместиться под ним. Так предел подстраивается и
    // под длинный заголовок, и под список сделок в соседнем окне.
    const stageTop = stage.getBoundingClientRect().top
    const available = window.innerHeight - stageTop - CONTROLS_BELOW_STAGE_PX
    const maxHeight = Math.max(MIN_STAGE_HEIGHT_PX, available)
    stage.style.maxWidth = `${Math.round(maxHeight * aspect)}px`
  }

  // ── Направляющие по границам панелей терминала ──────────────────────────

  // Линии приходят в пикселях исходного кадра, а рисуются и прилипают в
  // экранных — поэтому переводим их один раз при отрисовке.
  function guidesOnScreen(axis) {
    if (!naturalSize) return []
    const shown = displaySize()
    const scale = axis === 'x'
      ? shown.width / naturalSize.width
      : shown.height / naturalSize.height
    const source = axis === 'x' ? guides.vertical : guides.horizontal
    return source.map((value) => value * scale)
  }

  function renderGuides() {
    guidesEl.innerHTML = ''
    if (!naturalSize) return
    for (const axis of ['x', 'y']) {
      for (const position of guidesOnScreen(axis)) {
        const line = document.createElement('div')
        line.className = axis === 'x' ? 'guide guide-vertical' : 'guide guide-horizontal'
        if (axis === 'x') line.style.left = `${position}px`
        else line.style.top = `${position}px`
        guidesEl.appendChild(line)
      }
    }
  }

  // Прилипание края рамки к ближайшей направляющей. Без него попасть мышью
  // ровно в границу панели невозможно — промах в пиксель-другой виден на
  // готовом клипе полоской чужой панели по краю.
  function snap(value, axis) {
    let best = value
    let bestDistance = SNAP_TOLERANCE_PX
    for (const position of guidesOnScreen(axis)) {
      const distance = Math.abs(position - value)
      if (distance <= bestDistance) {
        bestDistance = distance
        best = position
      }
    }
    return best
  }

  function snapBox(rect) {
    const right = snap(rect.x + rect.width, 'x')
    const bottom = snap(rect.y + rect.height, 'y')
    const x = snap(rect.x, 'x')
    const y = snap(rect.y, 'y')
    return { x, y, width: Math.max(MIN_BOX_PX, right - x), height: Math.max(MIN_BOX_PX, bottom - y) }
  }

  function pageToVideo(value, axis) {
    const shown = displaySize()
    const shownSide = axis === 'x' ? shown.width : shown.height
    const naturalSide = axis === 'x' ? naturalSize.width : naturalSize.height
    if (!shownSide) return 0
    return Math.round(value * (naturalSide / shownSide))
  }

  function videoToPage(value, axis) {
    const shown = displaySize()
    const shownSide = axis === 'x' ? shown.width : shown.height
    const naturalSide = axis === 'x' ? naturalSize.width : naturalSize.height
    if (!naturalSide) return 0
    return value * (shownSide / naturalSide)
  }

  function applyBoxToDom() {
    if (!boxRect) {
      box.hidden = true
      return
    }
    box.hidden = false
    // Через свойства style, а не атрибут: атрибут style запрещён политикой
    // безопасности страницы (style-src 'self'), а присваивание свойств — нет.
    box.style.left = `${boxRect.x}px`
    box.style.top = `${boxRect.y}px`
    box.style.width = `${boxRect.width}px`
    box.style.height = `${boxRect.height}px`
  }

  function currentRect() {
    if (!boxRect || !naturalSize) return null
    return {
      x: pageToVideo(boxRect.x, 'x'),
      y: pageToVideo(boxRect.y, 'y'),
      width: pageToVideo(boxRect.width, 'x'),
      height: pageToVideo(boxRect.height, 'y'),
      sourceWidth: naturalSize.width,
      sourceHeight: naturalSize.height
    }
  }

  function refresh() {
    applyBoxToDom()
    const rect = currentRect()
    sizeEl.textContent = rect
      ? `${rect.width}x${rect.height} из ${naturalSize.width}x${naturalSize.height}`
      : (naturalSize ? `${naturalSize.width}x${naturalSize.height} целиком` : '')
    onChange(rect)
  }

  function setFullFrame() {
    const shown = displaySize()
    boxRect = { x: 0, y: 0, width: shown.width, height: shown.height }
    refresh()
  }

  function clampBox(next) {
    const shown = displaySize()
    const width = Math.max(MIN_BOX_PX, Math.min(next.width, shown.width))
    const height = Math.max(MIN_BOX_PX, Math.min(next.height, shown.height))
    return {
      x: Math.max(0, Math.min(next.x, shown.width - width)),
      y: Math.max(0, Math.min(next.y, shown.height - height)),
      width,
      height
    }
  }

  // Тянуть можно и саму рамку (перенос), и любой из восьми маркеров (размер).
  function startDrag(event, handle) {
    if (!boxRect) return
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const start = { ...boxRect }
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY

      if (!handle) {
        // При переносе прилипает только левый верхний угол: если тянуть к
        // направляющим оба края сразу, рамка на ходу меняла бы размер.
        const moved = clampBox({ ...start, x: start.x + dx, y: start.y + dy })
        boxRect = clampBox({ ...moved, x: snap(moved.x, 'x'), y: snap(moved.y, 'y') })
        refresh()
        return
      } else {
        let { x, y, width, height } = start
        if (handle.includes('w')) { x = start.x + dx; width = start.width - dx }
        if (handle.includes('e')) { width = start.width + dx }
        if (handle.includes('n')) { y = start.y + dy; height = start.height - dy }
        if (handle.includes('s')) { height = start.height + dy }
        // Потянули дальше противоположного края — не даём рамке вывернуться
        if (width < MIN_BOX_PX) { x = start.x + start.width - MIN_BOX_PX; width = MIN_BOX_PX }
        if (height < MIN_BOX_PX) { y = start.y + start.height - MIN_BOX_PX; height = MIN_BOX_PX }
        boxRect = clampBox({ x, y, width, height })
      }
      boxRect = clampBox(snapBox(boxRect))
      refresh()
    }

    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
    }

    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
  }

  box.addEventListener('pointerdown', (event) => {
    if (event.target.dataset.handle) return // маркер обработает себя сам
    startDrag(event, null)
  })
  for (const handle of box.querySelectorAll('[data-handle]')) {
    handle.addEventListener('pointerdown', (event) => {
      event.stopPropagation()
      startDrag(event, handle.dataset.handle)
    })
  }

  // Рамка живёт в CSS-пикселях, поэтому при изменении размера окна её надо
  // пересчитать — иначе она "уедет" относительно картинки.
  let lastShownWidth = 0
  window.addEventListener('resize', () => {
    // Пересчитать предел надо в любом случае: окно разворачивается на время
    // превью, и без этого кадр остался бы прежнего размера.
    applyStageLimit()
    renderGuides() // линии заданы в экранных пикселях — после изменения размера их надо пересчитать
    if (!boxRect || !lastShownWidth) return
    const shown = displaySize()
    if (!shown.width || shown.width === lastShownWidth) return
    const ratio = shown.width / lastShownWidth
    lastShownWidth = shown.width
    boxRect = clampBox({
      x: boxRect.x * ratio, y: boxRect.y * ratio,
      width: boxRect.width * ratio, height: boxRect.height * ratio
    })
    refresh()
  })

  // ── Таймлайн: две ручки задают, что оставить ────────────────────────────

  function duration() {
    return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
  }

  function timeToPercent(seconds) {
    const total = duration()
    return total ? (seconds / total) * 100 : 0
  }

  function refreshTimeline() {
    const total = duration()
    const startPercent = timeToPercent(keepFrom)
    const endPercent = timeToPercent(keepTo)
    rangeEl.style.left = `${startPercent}%`
    rangeEl.style.width = `${Math.max(0, endPercent - startPercent)}%`
    timeline.querySelector('[data-trim="start"]').style.left = `${startPercent}%`
    timeline.querySelector('[data-trim="end"]').style.left = `${endPercent}%`
    playheadEl.style.left = `${timeToPercent(video.currentTime || 0)}%`

    const kept = Math.max(0, keepTo - keepFrom)
    trimLabelEl.textContent = total
      ? `Останется ${formatTime(kept)} из ${formatTime(total)} — отрезаем ${formatTime(keepFrom)} с начала и ${formatTime(total - keepTo)} с конца`
      : ''
  }

  function emitTrim() {
    const total = duration()
    if (!total) return
    // Округляем до десятых: ffmpeg принимает и дробные, а рисовать в полях
    // шесть знаков после запятой бессмысленно.
    onTrimChange({
      trimStart: Math.round(keepFrom * 10) / 10,
      trimEnd: Math.round((total - keepTo) * 10) / 10
    })
  }

  function setKeepRange(from, to, { seekTo } = {}) {
    const total = duration()
    if (!total) return
    keepFrom = Math.max(0, Math.min(from, total - MIN_KEPT_SEC))
    keepTo = Math.min(total, Math.max(to, keepFrom + MIN_KEPT_SEC))
    if (seekTo != null) video.currentTime = Math.max(0, Math.min(seekTo, total))
    refreshTimeline()
    emitTrim()
  }

  function timeAtClientX(clientX) {
    const bounds = timeline.getBoundingClientRect()
    if (!bounds.width) return 0
    const ratio = (clientX - bounds.left) / bounds.width
    return Math.max(0, Math.min(1, ratio)) * duration()
  }

  // Клик по дорожке — перемотка. Ручки обрабатывают себя сами и сюда не
  // доходят, иначе перетаскивание ручки заодно прыгало бы курсором.
  timeline.addEventListener('pointerdown', (event) => {
    if (event.target.dataset.trim) return
    if (!duration()) return
    video.currentTime = timeAtClientX(event.clientX)
    refreshTimeline()
  })

  for (const handle of timeline.querySelectorAll('[data-trim]')) {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!duration()) return
      const which = handle.dataset.trim
      handle.setPointerCapture(event.pointerId)

      // Перемотка вслед за ручкой: без неё непонятно, по какому кадру режем.
      const onMove = (moveEvent) => {
        const time = timeAtClientX(moveEvent.clientX)
        if (which === 'start') setKeepRange(time, keepTo, { seekTo: time })
        else setKeepRange(keepFrom, time, { seekTo: time })
      }
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
    })
  }

  // Воспроизведение — только выбранного куска: так видно, что реально
  // останется после обрезки, а не весь исходник.
  playButton.addEventListener('click', () => {
    if (!duration()) return
    if (video.paused) {
      if (video.currentTime < keepFrom || video.currentTime >= keepTo) video.currentTime = keepFrom
      video.play()
    } else {
      video.pause()
    }
  })

  // Звук в превью — только для прослушивания при обрезке; на результат он не
  // влияет, за это отвечает отдельная галка "Без звука" в форме. Выключить
  // бывает нужно, когда рядом пишет OBS и лишний звук не к месту.
  soundButton.addEventListener('click', () => {
    video.muted = !video.muted
    soundButton.textContent = video.muted ? '🔇' : '🔊'
  })

  video.addEventListener('play', () => { playButton.textContent = '||' })
  video.addEventListener('pause', () => { playButton.textContent = '▶' })
  video.addEventListener('timeupdate', () => {
    if (!video.paused && video.currentTime >= keepTo) {
      video.pause()
      video.currentTime = keepTo
    }
    refreshTimeline()
  })

  root.querySelector('[data-role="reset"]').addEventListener('click', setFullFrame)

  // Все области текущего варианта разом: колонки берутся между найденными
  // линиями, а высота — у рамки, которую пользователь уже выставил. Так
  // настройка делается один раз: обвёл по высоте, нажал — и все стаканы
  // сохранены с настоящими границами.
  // ── Сетка областей ──────────────────────────────────────────────────────
  //
  // Ручная настройка раньше шла по одной области за раз: обведи мышью,
  // придумай имя, сохрани, повтори шесть раз. На шести стаканах этим никто не
  // станет заниматься, а это единственный путь для тех, у кого автоматический
  // поиск границ не сработал.
  //
  // Здесь человек говорит, на сколько частей делить, и сразу видит их на
  // кадре с номерами — как выбор мониторов в Windows. Дальше двигает границы,
  // если разбивка не совпала, и сохраняет все разом.

  const MIN_CELL_RATIO = 0.02 // уже этого ячейку не ухватить мышью

  function buildEvenGrid(count) {
    if (!naturalSize || count < 2) return null
    const dividers = []
    for (let k = 1; k < count; k++) dividers.push(Math.round((naturalSize.width * k) / count))
    // Если рамка уже стояла, наследуем её вертикальные границы: человек мог
    // отрезать заголовок окна и не должен делать это второй раз.
    const top = boxRect ? pageToVideo(boxRect.y, 'y') : 0
    const bottom = boxRect ? top + pageToVideo(boxRect.height, 'y') : naturalSize.height
    return { dividers, top, bottom }
  }

  function gridEdges() {
    return [0, ...grid.dividers, naturalSize.width]
  }

  // Перетаскивание одной границы: вертикальной между ячейками либо
  // горизонтальной сверху/снизу.
  function dragGridLine(event, kind, index) {
    event.preventDefault()
    const bounds = stage.getBoundingClientRect()

    const move = (moveEvent) => {
      if (kind === 'divider') {
        const value = pageToVideo(moveEvent.clientX - bounds.left, 'x')
        const edges = gridEdges()
        const gap = naturalSize.width * MIN_CELL_RATIO
        const low = edges[index] + gap
        const high = edges[index + 2] - gap
        grid.dividers[index] = Math.round(Math.max(low, Math.min(value, high)))
      } else {
        const value = pageToVideo(moveEvent.clientY - bounds.top, 'y')
        const gap = naturalSize.height * MIN_CELL_RATIO
        if (kind === 'top') grid.top = Math.round(Math.max(0, Math.min(value, grid.bottom - gap)))
        else grid.bottom = Math.round(Math.min(naturalSize.height, Math.max(value, grid.top + gap)))
      }
      renderGrid()
    }

    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  function addGridLine(kind, index, position, horizontal) {
    const line = document.createElement('div')
    line.className = horizontal ? 'grid-edge grid-edge-horizontal' : 'grid-edge grid-edge-vertical'
    if (horizontal) line.style.top = `${position}px`
    else line.style.left = `${position}px`
    line.addEventListener('pointerdown', (event) => dragGridLine(event, kind, index))
    gridLayer.appendChild(line)
  }

  function renderGrid() {
    gridLayer.innerHTML = ''
    gridLayer.hidden = !grid
    if (!grid || !naturalSize) return

    const top = videoToPage(grid.top, 'y')
    const height = videoToPage(grid.bottom - grid.top, 'y')
    const edges = gridEdges()

    // Сами ячейки с номерами. Номер крупный и по центру — по нему человек
    // сверяется с тем, что потом выберет в меню трея.
    for (let index = 1; index < edges.length; index++) {
      const left = videoToPage(edges[index - 1], 'x')
      const width = videoToPage(edges[index] - edges[index - 1], 'x')

      const cell = document.createElement('div')
      cell.className = 'grid-cell'
      cell.style.left = `${left}px`
      cell.style.top = `${top}px`
      cell.style.width = `${width}px`
      cell.style.height = `${height}px`

      const label = document.createElement('span')
      label.className = 'grid-number'
      label.textContent = String(index)
      cell.appendChild(label)
      gridLayer.appendChild(cell)
    }

    for (let index = 0; index < grid.dividers.length; index++) {
      addGridLine('divider', index, videoToPage(grid.dividers[index], 'x'), false)
    }
    addGridLine('top', 0, top, true)
    addGridLine('bottom', 0, top + height, true)

    sizeEl.textContent = `${edges.length - 1} областей из ${naturalSize.width}x${naturalSize.height}`
  }

  function setGridCount(count) {
    grid = buildEvenGrid(count)
    // Рамка и сетка — два разных ответа на один вопрос, показывать оба разом
    // незачем: человек перестаёт понимать, что именно вырежется.
    if (grid) {
      boxRect = null
      applyBoxToDom()
      guidesEl.innerHTML = ''
    }
    saveAllButton.hidden = !grid && guides.vertical.length === 0
    renderGrid()
    if (!grid) refresh()
  }

  gridCountInput.addEventListener('input', () => {
    const count = Number(gridCountInput.value)
    setGridCount(Number.isFinite(count) ? count : 0)
  })

  function allRegionsFromGuides() {
    // Сетка, если она задана, — ответ человека, а найденные границы лишь
    // подсказка. Поэтому она главнее.
    if (grid && naturalSize) {
      const edges = gridEdges()
      const regions = []
      for (let index = 1; index < edges.length; index++) {
        regions.push({
          x: edges[index - 1],
          y: grid.top,
          width: edges[index] - edges[index - 1],
          height: grid.bottom - grid.top,
          sourceWidth: naturalSize.width,
          sourceHeight: naturalSize.height
        })
      }
      return regions
    }

    if (!naturalSize || !boxRect) return []
    const edges = [...new Set([0, ...guides.vertical, naturalSize.width])].sort((a, b) => a - b)
    const top = pageToVideo(boxRect.y, 'y')
    const height = pageToVideo(boxRect.height, 'y')
    const regions = []
    for (let index = 1; index < edges.length; index++) {
      const x = edges[index - 1]
      const width = edges[index] - x
      if (width < naturalSize.width * 0.02) continue // слишком узкая — это не панель
      regions.push({ x, y: top, width, height, sourceWidth: naturalSize.width, sourceHeight: naturalSize.height })
    }
    return regions
  }

  function applyVariant() {
    const variant = guides.variants[variantIndex]
    if (variant) guides = { ...guides, vertical: variant }

    // Если человек уже задал число частей, поиск границ не рисует отдельные
    // линии, а расставляет границы его сетки: так он сразу видит результат
    // теми же номерованными областями и может поправить любую мышью.
    if (grid && variant && variant.length >= 2) {
      const inner = variant.filter((x) => x > 0 && x < naturalSize.width)
      grid = { ...grid, dividers: inner }
      gridCountInput.value = String(inner.length + 1)
      renderGrid()
      variantButton.hidden = guides.variants.length < 2
      variantButton.textContent = guides.variants.length > 1
        ? `Другой вариант (${variantIndex + 1}/${guides.variants.length})`
        : 'Другой вариант'
      return
    }
    saveAllButton.hidden = guides.vertical.length === 0
    variantButton.hidden = guides.variants.length < 2
    variantButton.textContent = guides.variants.length > 1
      ? `Другой вариант (${variantIndex + 1}/${guides.variants.length})`
      : 'Другой вариант'
    renderGuides()
  }

  detectButton.addEventListener('click', async () => {
    if (!currentClipPath || !naturalSize) return
    detectButton.disabled = true
    statusEl.textContent = 'Ищу границы панелей на этом кадре...'
    try {
      const found = await window.api.detectPanels(currentClipPath, video.currentTime || 0)
      guides = { vertical: found.vertical || [], horizontal: found.horizontal || [], variants: found.variants || [] }
      variantIndex = 0
      applyVariant()
      statusEl.textContent = guides.vertical.length > 0
        ? `Найдено ${guides.vertical.length} границ. Двойной щелчок по панели выделит её целиком, а края рамки теперь прилипают к линиям.`
        : 'Границы найти не удалось — обведи область мышью.'
    } catch (error) {
      statusEl.textContent = `Не удалось разобрать кадр: ${error.message || error}`
    } finally {
      detectButton.disabled = false
    }
  })

  variantButton.addEventListener('click', () => {
    if (guides.variants.length < 2) return
    variantIndex = (variantIndex + 1) % guides.variants.length
    applyVariant()
    statusEl.textContent = `Вариант ${variantIndex + 1} из ${guides.variants.length}: ${guides.variants[variantIndex].length} границ.`
  })

  // Двойной щелчок по панели выделяет её целиком — от направляющей до
  // направляющей. Одиночный оставлен перетаскиванию рамки.
  box.addEventListener('dblclick', (event) => {
    if (!boxRect || !naturalSize) return
    const stageBounds = stage.getBoundingClientRect()
    const pointX = event.clientX - stageBounds.left
    const pointY = event.clientY - stageBounds.top
    const shown = displaySize()

    const spanFor = (point, axis, limit) => {
      const positions = [0, ...guidesOnScreen(axis), limit].sort((a, b) => a - b)
      let from = 0
      let to = limit
      for (const position of positions) {
        if (position <= point) from = position
        else { to = position; break }
      }
      return { from, to }
    }

    const horizontalSpan = spanFor(pointX, 'x', shown.width)
    const verticalSpan = spanFor(pointY, 'y', shown.height)
    boxRect = clampBox({
      x: horizontalSpan.from,
      y: verticalSpan.from,
      width: horizontalSpan.to - horizontalSpan.from,
      height: verticalSpan.to - verticalSpan.from
    })
    refresh()
  })

  video.addEventListener('loadedmetadata', () => {
    naturalSize = { width: video.videoWidth, height: video.videoHeight }
    applyStageLimit()
    lastShownWidth = displaySize().width
    setFullFrame()
    statusEl.textContent = 'Потяни рамку за края, а ручками на дорожке отрежь лишнее с начала и с конца.'

    // Обрезка, заданная в полях формы до открытия превью, переносится на
    // дорожку — иначе ручки показывали бы не то, что реально произойдёт.
    const total = duration()
    keepFrom = Math.max(0, (pendingTrim && pendingTrim.trimStart) || 0)
    keepTo = total - Math.max(0, (pendingTrim && pendingTrim.trimEnd) || 0)
    if (!(keepTo > keepFrom)) { keepFrom = 0; keepTo = total }
    pendingTrim = null
    refreshTimeline()

    // Область, выбранная кнопкой ещё до загрузки кадра
    if (pendingArea) {
      const getRect = pendingArea
      pendingArea = null
      api.showArea(getRect)
    }

    // Не первый кадр: у записи с рабочего стола он часто ещё пустой
    video.currentTime = total > 1 ? keepFrom + Math.min(1, (keepTo - keepFrom) / 2) : 0
  })

  video.addEventListener('error', () => {
    naturalSize = null
    boxRect = null
    refresh()
    statusEl.textContent = 'Это видео не показывается в окне — обрезать можно, но рамку придётся выбирать вслепую. Попробуй пресет или стакан.'
  })

  const api = {
    // trim — то, что уже стоит в числовых полях формы: { trimStart, trimEnd }
    open(clipPath, trim) {
      root.hidden = false
      pendingTrim = trim || null
      currentClipPath = clipPath
      // Границы относятся к прежнему файлу — к новому они отношения не имеют
      guides = { vertical: [], horizontal: [], variants: [] }
      variantIndex = 0
      variantButton.hidden = true
      saveAllButton.hidden = true
      guidesEl.innerHTML = ''
      statusEl.textContent = 'Загружаю видео...'
      video.src = `file:///${String(clipPath).replace(/\\/g, '/')}`
      video.load()
    },
    close() {
      root.hidden = true
      currentClipPath = null
      pendingArea = null
      guides = { vertical: [], horizontal: [], variants: [] }
      guidesEl.innerHTML = ''
      video.pause()
      video.removeAttribute('src')
      video.load()
      boxRect = null
      naturalSize = null
      keepFrom = 0
      keepTo = 0
      onChange(null)
    },
    // Показать готовую область (пресет или "стакан N") прямо на кадре, чтобы
    // было видно, что именно вырежется. Наружу об этом НЕ сообщаем: рамку
    // выбрал не пользователь мышью, а кнопка, и сбрасывать из-за неё выбор
    // кнопки было бы неправильно.
    showRect(rect) {
      if (!naturalSize || !rect) return false
      const shown = displaySize()
      const scaleX = shown.width / naturalSize.width
      const scaleY = shown.height / naturalSize.height
      boxRect = clampBox({
        x: (Number(rect.x) || 0) * scaleX,
        y: (Number(rect.y) || 0) * scaleY,
        width: Number(rect.width) * scaleX,
        height: Number(rect.height) * scaleY
      })
      applyBoxToDom()
      const resolved = currentRect()
      sizeEl.textContent = resolved
        ? `${resolved.width}x${resolved.height} из ${naturalSize.width}x${naturalSize.height}`
        : ''
      return true
    },

    // Показать область, выбранную кнопкой в форме. getRect(frameSize) вернёт
    // её в пикселях кадра либо null для "всей картинки".
    //
    // Наружу об этом НЕ сообщаем (onChange не дёргаем): рамку задала кнопка, а
    // не мышь пользователя, и сбрасывать из-за неё выбор той же кнопки было бы
    // неправильно.
    showArea(getRect) {
      if (!naturalSize) return false
      const rect = getRect(naturalSize)
      if (!rect) { setFullFrame(); return true }

      const shown = displaySize()
      const scaleX = shown.width / naturalSize.width
      const scaleY = shown.height / naturalSize.height
      boxRect = clampBox({
        x: (Number(rect.x) || 0) * scaleX,
        y: (Number(rect.y) || 0) * scaleY,
        width: Number(rect.width) * scaleX,
        height: Number(rect.height) * scaleY
      })
      applyBoxToDom()
      const resolved = currentRect()
      sizeEl.textContent = resolved
        ? `${resolved.width}x${resolved.height} из ${naturalSize.width}x${naturalSize.height}`
        : ''
      return true
    },

    // То же, но кадр ещё не загружен — применим, когда станет известен размер
    showAreaWhenReady(getRect) {
      pendingArea = getRect
    },

    // Числовые поля правят руками — дорожка должна это отражать
    setTrim({ trimStart, trimEnd }) {
      const total = duration()
      if (!total) { pendingTrim = { trimStart, trimEnd }; return }
      keepFrom = Math.max(0, Math.min(trimStart || 0, total - MIN_KEPT_SEC))
      keepTo = Math.min(total, Math.max(total - (trimEnd || 0), keepFrom + MIN_KEPT_SEC))
      refreshTimeline()
    },
    isOpen: () => !root.hidden,
    getRect: currentRect,
    getPresetName: () => nameInput.value,
    clearPresetName: () => { nameInput.value = '' },
    setStatus: (text) => { statusEl.textContent = text },
    getAllRegions: allRegionsFromGuides,
    onSaveClick: (handler) => root.querySelector('[data-role="save"]').addEventListener('click', handler),
    onSaveAllClick: (handler) => saveAllButton.addEventListener('click', handler)
  }

  return api
}
