// Редактор клипа: кадр во всё окно, под ним дорожка с выделением.
//
// Раньше это жило внутри формы обрезки как «превью»: кадр появлялся абзацем
// посреди прокручиваемой страницы, над ним стояли заголовок, подсказка и зона
// перетаскивания, под ним — скорость, имя файла и кнопка «Вырезать». Замеры на
// пяти типовых экранах: кадру доставалось 24–26% высоты окна на ноутбуке и 56%
// на большом мониторе, а кнопка «Вырезать» не была видна ни на одном — до неё
// каждый раз надо было прокручивать.
//
// Здесь у окна одна задача, и кадр забирает всё, что остаётся от тонких полос
// сверху и снизу.
//
// Координаты. Рамка хранится в пикселях ИСХОДНОГО кадра, а не экранных: иначе
// изменение размера окна сдвигало бы уже выставленную рамку. Наружу (в ffmpeg)
// уходят те же исходные пиксели. Приводить к чётным числам и прижимать к краям
// кадра здесь НЕ нужно: этим занимается src/cropRect.js, у которого есть
// настоящий размер файла от ffprobe.

const MIN_BOX_PX = 12 // меньше просто не ухватить мышью
// Короче этого обрезать нечего: ручки на дорожке просто слиплись бы.
const MIN_KEPT_SEC = 0.5
// Насколько можно дёрнуть мышь, чтобы это всё ещё считалось щелчком, а не
// перетаскиванием. Нужно, потому что выделение по умолчанию занимает всю
// дорожку и иначе перекрыло бы перемотку щелчком.
const CLICK_SLOP_PX = 3
const STEP_SEC = 0.1
const BIG_STEP_SEC = 1

// 74.5 -> "1:14.5"; секунды с десятой долей, потому что обрезка обычно
// измеряется секундами, а не минутами.
function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
}

function createCropEditor({ onRectChange = () => {}, onReady = () => {} } = {}) {
  const frameEl = document.getElementById('frame')
  const stage = document.getElementById('stage')
  const video = document.getElementById('video')
  const box = document.getElementById('box')
  const emptyEl = document.getElementById('empty')
  const timeline = document.getElementById('timeline')
  const rangeEl = document.getElementById('range')
  const playheadEl = document.getElementById('playhead')
  const playButton = document.getElementById('play')
  const loopButton = document.getElementById('loop')
  const soundButton = document.getElementById('sound')
  const timeEl = document.getElementById('time')
  const trimLabelEl = document.getElementById('trim-label')
  const sizeEl = document.getElementById('size')
  const statusEl = document.getElementById('status')

  let natural = null // { width, height } исходного кадра
  let boxRect = null // { x, y, width, height } в пикселях исходного кадра
  // Границы того, что оставляем, в секундах от начала файла
  let keepFrom = 0
  let keepTo = 0
  // Менялся ли диапазон с прошлого воспроизведения — см. togglePlay
  let rangeChanged = false
  let looping = false

  function setStatus(text, kind) {
    statusEl.className = kind ? `status ${kind}` : 'status'
    statusEl.textContent = text || ''
  }

  // ── Перевод между пикселями кадра и экранными ───────────────────────────

  function scale() {
    return natural && natural.width ? stage.clientWidth / natural.width : 0
  }

  function toScreen(value) {
    return value * scale()
  }

  function toFrame(value) {
    const factor = scale()
    return factor ? value / factor : 0
  }

  function minBoxFrame() {
    return Math.max(1, Math.round(toFrame(MIN_BOX_PX)))
  }

  function currentRect() {
    if (!boxRect || !natural) return null
    return {
      x: boxRect.x,
      y: boxRect.y,
      width: boxRect.width,
      height: boxRect.height,
      sourceWidth: natural.width,
      sourceHeight: natural.height
    }
  }

  // ── Рамка обрезки ───────────────────────────────────────────────────────

  function drawBox() {
    if (!boxRect || !natural) {
      box.hidden = true
      sizeEl.textContent = natural ? `${natural.width}x${natural.height} целиком` : ''
      return
    }
    box.hidden = false
    // Через свойства style, а не атрибут: атрибут style запрещён политикой
    // безопасности страницы (style-src 'self'), а присваивание свойств — нет.
    box.style.left = `${toScreen(boxRect.x)}px`
    box.style.top = `${toScreen(boxRect.y)}px`
    box.style.width = `${toScreen(boxRect.width)}px`
    box.style.height = `${toScreen(boxRect.height)}px`
    // «Целиком» вместо «3440x1440 из 3440x1440»: одно и то же число дважды
    // ничего не сообщает, а место в строке занимает.
    const whole = boxRect.width === natural.width && boxRect.height === natural.height
    sizeEl.textContent = whole
      ? `${natural.width}x${natural.height} целиком`
      : `${boxRect.width}x${boxRect.height} из ${natural.width}x${natural.height}`
  }

  function clampBox(next) {
    const least = minBoxFrame()
    const width = Math.round(Math.max(least, Math.min(next.width, natural.width)))
    const height = Math.round(Math.max(least, Math.min(next.height, natural.height)))
    return {
      x: Math.round(Math.max(0, Math.min(next.x, natural.width - width))),
      y: Math.round(Math.max(0, Math.min(next.y, natural.height - height))),
      width,
      height
    }
  }

  function wholeFrame() {
    if (!natural) return
    boxRect = { x: 0, y: 0, width: natural.width, height: natural.height }
    drawBox()
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
      const dx = toFrame(moveEvent.clientX - startX)
      const dy = toFrame(moveEvent.clientY - startY)
      const least = minBoxFrame()

      if (!handle) {
        boxRect = clampBox({ ...start, x: start.x + dx, y: start.y + dy })
      } else {
        let { x, y, width, height } = start
        if (handle.includes('w')) { x = start.x + dx; width = start.width - dx }
        if (handle.includes('e')) { width = start.width + dx }
        if (handle.includes('n')) { y = start.y + dy; height = start.height - dy }
        if (handle.includes('s')) { height = start.height + dy }
        // Потянули дальше противоположного края — не даём рамке вывернуться
        if (width < least) { x = start.x + start.width - least; width = least }
        if (height < least) { y = start.y + start.height - least; height = least }
        boxRect = clampBox({ x, y, width, height })
      }
      drawBox()
      // Наружу сообщаем только о том, что человек нарисовал сам. Рамка,
      // поставленная кнопкой области, сюда не попадает — иначе выбор кнопки
      // тут же отменял бы сам себя.
      onRectChange(currentRect())
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

  // ── Размер кадра ────────────────────────────────────────────────────────

  function fit() {
    if (!natural) return
    fitFrameInto(stage, frameEl, natural)
    drawBox()
  }

  window.addEventListener('resize', fit)

  // ── Дорожка: две ручки задают, что оставить ─────────────────────────────

  function duration() {
    return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
  }

  function percentOf(seconds) {
    const total = duration()
    return total ? (seconds / total) * 100 : 0
  }

  function drawTimeline() {
    const total = duration()
    const startPercent = percentOf(keepFrom)
    const endPercent = percentOf(keepTo)
    rangeEl.style.left = `${startPercent}%`
    rangeEl.style.width = `${Math.max(0, endPercent - startPercent)}%`
    timeline.querySelector('[data-trim="start"]').style.left = `${startPercent}%`
    timeline.querySelector('[data-trim="end"]').style.left = `${endPercent}%`
    playheadEl.style.left = `${percentOf(video.currentTime || 0)}%`

    timeEl.textContent = total ? `${formatTime(video.currentTime || 0)} / ${formatTime(total)}` : ''

    const kept = Math.max(0, keepTo - keepFrom)
    // Подпись нужна, только когда что-то действительно отрезано: иначе она
    // просто сообщала бы «останется всё».
    trimLabelEl.textContent = total && kept < total - 0.05
      ? `Останется ${formatTime(kept)} из ${formatTime(total)}`
      : ''
  }

  function setKeepRange(from, to, { seekTo } = {}) {
    const total = duration()
    if (!total) return
    const before = `${keepFrom},${keepTo}`
    keepFrom = Math.max(0, Math.min(from, total - MIN_KEPT_SEC))
    keepTo = Math.min(total, Math.max(to, keepFrom + MIN_KEPT_SEC))
    // Диапазон изменился — значит следующий «плей» показывает его целиком, с
    // начала. Иначе получалось непредсказуемо: то с начала выделения, то с
    // середины, смотря где до этого стоял курсор.
    if (`${keepFrom},${keepTo}` !== before) rangeChanged = true
    if (seekTo != null) video.currentTime = Math.max(0, Math.min(seekTo, total))
    drawTimeline()
  }

  function timeAtClientX(clientX) {
    const bounds = timeline.getBoundingClientRect()
    if (!bounds.width) return 0
    const ratio = (clientX - bounds.left) / bounds.width
    return Math.max(0, Math.min(1, ratio)) * duration()
  }

  // Щелчок по дорожке — перемотка. Ручки и выделение обрабатывают себя сами.
  timeline.addEventListener('pointerdown', (event) => {
    if (event.target.dataset.trim || event.target === rangeEl) return
    if (!duration()) return
    video.currentTime = timeAtClientX(event.clientX)
    drawTimeline()
  })

  // Выделение целиком: тянешь его — оно едет, не меняя длины. Так подбирают
  // момент, когда длина куска уже подошла.
  rangeEl.addEventListener('pointerdown', (event) => {
    if (!duration()) return
    event.preventDefault()
    const startX = event.clientX
    const length = keepTo - keepFrom
    const startFrom = keepFrom
    let moved = false
    rangeEl.setPointerCapture(event.pointerId)

    const onMove = (moveEvent) => {
      const shift = moveEvent.clientX - startX
      if (Math.abs(shift) > CLICK_SLOP_PX) moved = true
      if (!moved) return
      const delta = timeAtClientX(startX + shift) - timeAtClientX(startX)
      const from = Math.max(0, Math.min(startFrom + delta, duration() - length))
      setKeepRange(from, from + length, { seekTo: from })
    }
    const onUp = (upEvent) => {
      rangeEl.removeEventListener('pointermove', onMove)
      rangeEl.removeEventListener('pointerup', onUp)
      // Не сдвинули — значит это был щелчок, и человек хотел перемотку.
      // Без этого выделение, занимающее всю дорожку, перекрыло бы её.
      if (!moved) {
        video.currentTime = timeAtClientX(upEvent.clientX)
        drawTimeline()
      }
    }
    rangeEl.addEventListener('pointermove', onMove)
    rangeEl.addEventListener('pointerup', onUp)
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

  // ── Воспроизведение ─────────────────────────────────────────────────────

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

  loopButton.addEventListener('click', () => {
    looping = !looping
    loopButton.setAttribute('aria-pressed', String(looping))
  })

  soundButton.addEventListener('click', () => {
    video.muted = !video.muted
    soundButton.textContent = video.muted ? '🔇' : '🔊'
  })

  video.addEventListener('play', () => { playButton.textContent = '||' })
  video.addEventListener('pause', () => { playButton.textContent = '▶' })
  video.addEventListener('timeupdate', () => {
    if (!video.paused && video.currentTime >= keepTo) {
      if (looping) video.currentTime = keepFrom
      else { video.pause(); video.currentTime = keepTo }
    }
    drawTimeline()
  })

  // Отдельно — конец файла. Когда выделен клип целиком, до проверки в
  // timeupdate дело не доходит: видео кончается само и встаёт на паузу, и
  // повтор по кругу молча не работал бы ровно в том случае, когда он нужен
  // чаще всего — «прокрути мне это ещё раз».
  video.addEventListener('ended', () => {
    if (!looping) return
    video.currentTime = keepFrom
    const again = video.play()
    if (again && typeof again.catch === 'function') again.catch(() => {})
  })

  // ── Кнопки под дорожкой ─────────────────────────────────────────────────

  document.getElementById('mark-start').addEventListener('click', () => {
    setKeepRange(video.currentTime, keepTo)
  })
  document.getElementById('mark-end').addEventListener('click', () => {
    setKeepRange(keepFrom, video.currentTime)
  })
  document.getElementById('trim-reset').addEventListener('click', () => {
    setKeepRange(0, duration(), { seekTo: 0 })
  })
  document.getElementById('reset-box').addEventListener('click', () => {
    wholeFrame()
    onRectChange(currentRect())
  })

  // Клавиши работают, только когда кадр открыт и фокус не в поле ввода —
  // иначе пробел не дал бы напечатать имя файла.
  window.addEventListener('keydown', (event) => {
    if (!duration()) return
    const tag = document.activeElement && document.activeElement.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const step = event.shiftKey ? BIG_STEP_SEC : STEP_SEC
    if (event.code === 'Space') { event.preventDefault(); togglePlay() }
    else if (event.key === '[') setKeepRange(video.currentTime, keepTo)
    else if (event.key === ']') setKeepRange(keepFrom, video.currentTime)
    else if (event.key === 'ArrowLeft') { event.preventDefault(); video.currentTime = Math.max(0, video.currentTime - step) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); video.currentTime = Math.min(duration(), video.currentTime + step) }
  })

  // ── Открытие файла ──────────────────────────────────────────────────────

  video.addEventListener('loadedmetadata', () => {
    natural = { width: video.videoWidth, height: video.videoHeight }
    stage.hidden = false
    emptyEl.hidden = true
    fit()
    wholeFrame()
    keepFrom = 0
    keepTo = duration()
    rangeChanged = false
    drawTimeline()
    setStatus('Потяни рамку за края. Пробел — воспроизведение, [ и ] — отрезать по текущему кадру, стрелки — шаг на 0,1 с (с Shift — на секунду).')

    // Не первый кадр: у записи с рабочего стола он часто ещё пустой
    video.currentTime = duration() > 2 ? 1 : 0

    onReady()
  })

  video.addEventListener('error', () => {
    natural = null
    boxRect = null
    stage.hidden = true
    emptyEl.hidden = false
    emptyEl.textContent = 'Это видео не показывается в окне. Обрезать его всё равно можно — выбери область кнопкой ниже.'
    setStatus('Кадр не показывается: файл открылся, но проигрывать его окно не умеет.', 'error')
  })

  return {
    open(clipPath) {
      setStatus('Загружаю видео...')
      video.src = `file:///${String(clipPath).replace(/\\/g, '/')}`
      video.load()
    },
    // Показать область, выбранную кнопкой в форме. getRect(frameSize) вернёт
    // её в пикселях кадра либо null для «всей картинки».
    //
    // Наружу об этом НЕ сообщаем: рамку задала кнопка, а не мышь, и отменять
    // из-за неё выбор той же кнопки было бы неправильно.
    showArea(getRect) {
      if (!natural) return false
      const rect = getRect(natural)
      if (!rect) { wholeFrame(); return true }
      boxRect = clampBox({
        x: Number(rect.x) || 0,
        y: Number(rect.y) || 0,
        width: Number(rect.width),
        height: Number(rect.height)
      })
      drawBox()
      return true
    },
    hasFrame: () => natural !== null,
    getRect: currentRect,
    getTrim() {
      const total = duration()
      if (!total) return { trimStart: 0, trimEnd: 0 }
      // Округляем до десятых: ffmpeg принимает и дробные, а точнее десятой
      // доли секунды дорожкой всё равно не попасть.
      return {
        trimStart: Math.round(keepFrom * 10) / 10,
        trimEnd: Math.round((total - keepTo) * 10) / 10
      }
    },
    setStatus
  }
}
