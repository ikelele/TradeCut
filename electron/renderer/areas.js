// Разметка областей кадра — отдельным окном.
//
// Раньше это жило вперемешку с обрезкой клипа, и кадру — единственному, ради
// чего тут нужно место — доставались остатки: в окне 900x700 он получал 215
// пикселей ширины, потому что сверху и снизу стояло всё остальное.
//
// Здесь у окна одна задача, и кадр забирает всё, что есть. Размер ему считает
// не скрипт от фиксированного запаса в пикселях, а браузер по пропорциям — так
// он верно ложится на любой монитор, а не только на тот, под который подбирали
// числа.

const MIN_CELL_RATIO = 0.02 // уже этого ячейку не ухватить мышью

const countInput = document.getElementById('count')
const detectButton = document.getElementById('detect')
const variantButton = document.getElementById('variant')
const pickButton = document.getElementById('pick')
const saveButton = document.getElementById('save')
const frameEl = document.getElementById('frame')
const stage = document.getElementById('stage')
const picture = document.getElementById('picture')
const gridLayer = document.getElementById('grid')
const emptyEl = document.getElementById('empty')
const statusEl = document.getElementById('status')

let clipPath = null
let natural = null // { width, height } исходного кадра
// На каком моменте записи снят показанный кадр — по нему же ищутся границы
let frameTimeSec = 0
// Номер последнего запроса кадра: пока он достаётся, могут выбрать другой файл
let frameRequest = 0
// Сетка в пикселях ИСХОДНОГО кадра, а не экранных: иначе изменение размера
// окна сдвигало бы уже расставленные границы, а это главное, что человек
// здесь делает руками.
let grid = null // { dividers: number[], top: number, bottom: number }
let variants = []
let variantIndex = 0

function setStatus(text, kind) {
  statusEl.className = kind ? `status ${kind}` : 'status'
  statusEl.textContent = text
}

// ── Перевод между пикселями кадра и экранными ─────────────────────────────

function shown() {
  return { width: picture.clientWidth, height: picture.clientHeight }
}

function toScreen(value, axis) {
  const size = shown()
  const side = axis === 'x' ? size.width : size.height
  const naturalSide = axis === 'x' ? natural.width : natural.height
  return naturalSide ? value * (side / naturalSide) : 0
}

function toFrame(value, axis) {
  const size = shown()
  const side = axis === 'x' ? size.width : size.height
  const naturalSide = axis === 'x' ? natural.width : natural.height
  return side ? Math.round(value * (naturalSide / side)) : 0
}

// ── Сетка ─────────────────────────────────────────────────────────────────

function buildEvenGrid(count) {
  if (!natural || count < 2) return null
  const dividers = []
  for (let k = 1; k < count; k++) dividers.push(Math.round((natural.width * k) / count))
  return { dividers, top: 0, bottom: natural.height }
}

function edges() {
  return [0, ...grid.dividers, natural.width]
}

function dragLine(event, kind, index) {
  event.preventDefault()
  const bounds = stage.getBoundingClientRect()

  const move = (moveEvent) => {
    if (kind === 'divider') {
      const value = toFrame(moveEvent.clientX - bounds.left, 'x')
      const all = edges()
      const gap = natural.width * MIN_CELL_RATIO
      grid.dividers[index] = Math.round(
        Math.max(all[index] + gap, Math.min(value, all[index + 2] - gap))
      )
    } else {
      const value = toFrame(moveEvent.clientY - bounds.top, 'y')
      const gap = natural.height * MIN_CELL_RATIO
      if (kind === 'top') grid.top = Math.round(Math.max(0, Math.min(value, grid.bottom - gap)))
      else grid.bottom = Math.round(Math.min(natural.height, Math.max(value, grid.top + gap)))
    }
    render()
  }

  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}

function addLine(kind, index, position, horizontal) {
  const line = document.createElement('div')
  line.className = horizontal ? 'grid-edge grid-edge-horizontal' : 'grid-edge grid-edge-vertical'
  if (horizontal) line.style.top = `${position}px`
  else line.style.left = `${position}px`
  line.addEventListener('pointerdown', (event) => dragLine(event, kind, index))
  gridLayer.appendChild(line)
}

function render() {
  gridLayer.innerHTML = ''
  saveButton.disabled = !grid

  if (!grid || !natural) {
    setStatus('')
    return
  }

  const top = toScreen(grid.top, 'y')
  const height = toScreen(grid.bottom - grid.top, 'y')
  const all = edges()

  for (let index = 1; index < all.length; index++) {
    const cell = document.createElement('div')
    cell.className = 'grid-cell'
    cell.style.left = `${toScreen(all[index - 1], 'x')}px`
    cell.style.top = `${top}px`
    cell.style.width = `${toScreen(all[index] - all[index - 1], 'x')}px`
    cell.style.height = `${height}px`

    const label = document.createElement('span')
    label.className = 'grid-number'
    label.textContent = String(index)
    cell.appendChild(label)
    gridLayer.appendChild(cell)
  }

  for (let index = 0; index < grid.dividers.length; index++) {
    addLine('divider', index, toScreen(grid.dividers[index], 'x'), false)
  }
  addLine('top', 0, top, true)
  addLine('bottom', 0, top + height, true)

  const width = Math.round((natural.width - 0) / (all.length - 1))
  setStatus(`${all.length - 1} областей примерно по ${width}x${grid.bottom - grid.top} пикселей`)
}

function setCount(count) {
  grid = buildEvenGrid(count)
  render()
}

countInput.addEventListener('input', () => {
  const count = Number(countInput.value)
  setCount(Number.isFinite(count) ? count : 0)
})

// Окно меняет размер — кадр вписываем заново, а за ним и сетку: она
// нарисована в экранных пикселях и должна поехать следом.
window.addEventListener('resize', () => {
  if (!natural) return
  fitFrameInto(stage, frameEl, natural)
  if (grid) render()
})

// ── Кадр ──────────────────────────────────────────────────────────────────
//
// Кадр достаёт ffmpeg программы и присылает картинкой. Раньше здесь было
// видео, и запись в HEVC показывалась чёрным прямоугольником: окнам
// видеокарта отключена, а HEVC встроенный браузер без неё не раскодирует.
// Окну и не нужно видео — ему нужен один кадр.

async function openClip(filePath) {
  if (!filePath) return
  clipPath = filePath
  const request = ++frameRequest
  emptyEl.hidden = true
  stage.hidden = false
  setStatus('Загружаю кадр...')

  let frame
  try {
    frame = await window.api.getAreasFrame(filePath)
  } catch (error) {
    if (request !== frameRequest) return
    setStatus(`Не удалось достать кадр из этого файла: ${error.message || error}`, 'error')
    return
  }
  if (request !== frameRequest) return // за это время выбрали другой файл

  natural = { width: frame.width, height: frame.height }
  frameTimeSec = frame.timeSec || 0
  picture.src = frame.dataUri
  // Размер кадра считаем сами — см. fitFrame.js. Попытка отдать это браузеру
  // (ширина 100% + пропорции) на 3440x1440 давала кадр выше, чем окно, и его
  // низ вместе с нижней границей уезжал под подсказку.
  fitFrameInto(stage, frameEl, natural)
  detectButton.disabled = false
  const count = Number(countInput.value)
  if (Number.isFinite(count) && count >= 2) setCount(count)
  else setStatus(`Кадр ${natural.width}x${natural.height}. Впиши, сколько стаканов на экране.`)
}

pickButton.addEventListener('click', async () => {
  openClip(await window.api.pickVideoFile())
})

// ── Поиск границ ──────────────────────────────────────────────────────────

function applyVariant() {
  const variant = variants[variantIndex]
  if (!variant || !natural) return

  const inner = variant.filter((x) => x > 0 && x < natural.width)
  grid = { dividers: inner, top: grid ? grid.top : 0, bottom: grid ? grid.bottom : natural.height }
  countInput.value = String(inner.length + 1)

  variantButton.hidden = variants.length < 2
  variantButton.textContent = `Другой вариант (${variantIndex + 1}/${variants.length})`
  render()
}

detectButton.addEventListener('click', async () => {
  if (!clipPath || !natural) return
  detectButton.disabled = true
  setStatus('Ищу границы панелей на этом кадре...')
  try {
    const found = await window.api.detectPanels(clipPath, frameTimeSec)
    variants = found.variants && found.variants.length > 0 ? found.variants : [found.vertical || []]
    variantIndex = 0
    if (variants[0].length < 2) {
      setStatus('Границы найти не удалось. Впиши число стаканов и расставь их руками.', 'error')
      return
    }
    applyVariant()
  } catch (error) {
    setStatus(`Не получилось: ${error.message || error}`, 'error')
  } finally {
    detectButton.disabled = false
  }
})

variantButton.addEventListener('click', () => {
  variantIndex = (variantIndex + 1) % variants.length
  applyVariant()
})

// ── Сохранение ────────────────────────────────────────────────────────────

saveButton.addEventListener('click', async () => {
  if (!grid || !natural) return
  const all = edges()
  const presets = []
  for (let index = 1; index < all.length; index++) {
    presets.push({
      name: `Стакан ${index}`,
      x: all[index - 1],
      y: grid.top,
      width: all[index] - all[index - 1],
      height: grid.bottom - grid.top,
      sourceWidth: natural.width,
      sourceHeight: natural.height
    })
  }

  saveButton.disabled = true
  try {
    await window.api.saveCropPreset(presets)
    setStatus(`Готово: сохранено областей — ${presets.length}. Они появились в меню трея по каждой сделке.`, 'ok')
  } catch (error) {
    setStatus(`Не удалось сохранить: ${error.message || error}`, 'error')
  } finally {
    saveButton.disabled = false
  }
})

// ── Старт ─────────────────────────────────────────────────────────────────

stage.hidden = true
detectButton.disabled = true

// Файл мог быть передан окну при открытии — например, помощником настройки,
// который только что сохранил повтор ради кадра.
window.api.getAreasClip().then((filePath) => {
  if (filePath) openClip(filePath)
})
