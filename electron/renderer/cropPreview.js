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
      <span class="preview-time" data-role="time"></span>
      <span class="preview-size" data-role="size"></span>
    </div>
    <div class="preview-trim-actions">
      <button type="button" class="secondary" data-role="mark-start" title="Начать отсюда (клавиша [)">[ Начало здесь</button>
      <button type="button" class="secondary" data-role="mark-end" title="Закончить здесь (клавиша ])">Конец здесь ]</button>
      <button type="button" class="secondary" data-role="trim-reset">Весь клип</button>
    </div>
    <p class="field-hint" data-role="trim-label"></p>
    <div class="preview-actions">
      <button type="button" class="secondary" data-role="reset">Вся картинка</button>
    </div>
    <p class="field-hint" data-role="status"></p>
  `

  const stage = root.querySelector('[data-role="stage"]')
  const video = root.querySelector('[data-role="video"]')
  const box = root.querySelector('[data-role="box"]')
  const timeline = root.querySelector('[data-role="timeline"]')
  const rangeEl = root.querySelector('[data-role="range"]')
  const playheadEl = root.querySelector('[data-role="playhead"]')
  const playButton = root.querySelector('[data-role="play"]')
  const soundButton = root.querySelector('[data-role="sound"]')
  const trimLabelEl = root.querySelector('[data-role="trim-label"]')
  const sizeEl = root.querySelector('[data-role="size"]')
  const timeEl = root.querySelector('[data-role="time"]')
  const statusEl = root.querySelector('[data-role="status"]')

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
  // Менялся ли диапазон с прошлого воспроизведения — см. setKeepRange
  let rangeChanged = false
  // Найденные границы панелей в пикселях ИСХОДНОГО кадра
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
        boxRect = clampBox(moved)
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
      boxRect = clampBox(boxRect)
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

    timeEl.textContent = total ? `${formatTime(video.currentTime || 0)} / ${formatTime(total)}` : ''

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
    const before = `${keepFrom},${keepTo}`
    keepFrom = Math.max(0, Math.min(from, total - MIN_KEPT_SEC))
    keepTo = Math.min(total, Math.max(to, keepFrom + MIN_KEPT_SEC))
    // Диапазон изменился — значит следующий «плей» показывает его целиком, с
    // начала. Иначе получалось непредсказуемо: иногда с начала выделения,
    // иногда с середины, смотря где до этого стоял курсор.
    if (`${keepFrom},${keepTo}` !== before) rangeChanged = true
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
  function togglePlay() {
    if (!duration()) return
    if (!video.paused) return video.pause()

    // С начала выделения — всегда после его правки, и всегда когда курсор
    // оказался снаружи. Внутри диапазона курсор бывает только если человек
    // сам туда щёлкнул, и тогда продолжаем с того места: он именно это место
    // и хотел посмотреть.
    if (rangeChanged || video.currentTime < keepFrom || video.currentTime >= keepTo - 0.05) {
      video.currentTime = keepFrom
    }
    rangeChanged = false
    // play() отвечает обещанием, и если нажать паузу раньше, чем оно
    // выполнится, оно отклоняется. Это не ошибка — просто передумали, — но
    // без обработчика отказ всплывает в консоль необработанным.
    const started = video.play()
    if (started && typeof started.catch === 'function') started.catch(() => {})
  }

  playButton.addEventListener('click', togglePlay)

  // Отметить границы прямо по тому кадру, который сейчас виден, — самый
  // быстрый способ обрезать: смотришь и режешь, не целясь ручкой в дорожку.
  root.querySelector('[data-role="mark-start"]').addEventListener('click', () => {
    setKeepRange(video.currentTime, keepTo)
  })
  root.querySelector('[data-role="mark-end"]').addEventListener('click', () => {
    setKeepRange(keepFrom, video.currentTime)
  })
  root.querySelector('[data-role="trim-reset"]').addEventListener('click', () => {
    setKeepRange(0, duration(), { seekTo: 0 })
  })

  // Клавиши работают, только когда кадр открыт и фокус не в поле ввода —
  // иначе пробел не дал бы напечатать имя файла.
  window.addEventListener('keydown', (event) => {
    if (root.hidden || !duration()) return
    const tag = document.activeElement && document.activeElement.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    if (event.code === 'Space') { event.preventDefault(); togglePlay() }
    else if (event.key === '[') setKeepRange(video.currentTime, keepTo)
    else if (event.key === ']') setKeepRange(keepFrom, video.currentTime)
    else if (event.key === 'ArrowLeft') { event.preventDefault(); video.currentTime = Math.max(0, video.currentTime - (event.shiftKey ? 1 : 0.1)) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); video.currentTime = Math.min(duration(), video.currentTime + (event.shiftKey ? 1 : 0.1)) }
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
  video.addEventListener('loadedmetadata', () => {
    naturalSize = { width: video.videoWidth, height: video.videoHeight }
    applyStageLimit()
    lastShownWidth = displaySize().width
    setFullFrame()
    statusEl.textContent = 'Потяни рамку за края. Пробел — воспроизведение, [ и ] — отрезать по текущему кадру, стрелки — шаг на 0,1 с (с Shift — на секунду).'

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
      statusEl.textContent = 'Загружаю видео...'
      video.src = `file:///${String(clipPath).replace(/\\/g, '/')}`
      video.load()
    },
    close() {
      root.hidden = true
      currentClipPath = null
      pendingArea = null
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
    setStatus: (text) => { statusEl.textContent = text }
  }

  return api
}
