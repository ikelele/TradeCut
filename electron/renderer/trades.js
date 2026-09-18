const listEl = document.getElementById('trade-list')
const statusEl = document.getElementById('status')
const runButton = document.getElementById('run')
const closeButton = document.getElementById('close')

const form = createCropForm(document.getElementById('crop-form'))

let trades = []
let selectedClipPath = null

function renderList() {
  listEl.innerHTML = ''

  if (trades.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'Сделок пока нет'
    listEl.appendChild(empty)
    runButton.disabled = true
    return
  }

  // Если ранее выбранная сделка всё ещё в списке — сохраняем выбор, чтобы
  // приход новой сделки не сбрасывал то, что пользователь уже отметил.
  if (!trades.some((entry) => entry.clipPath === selectedClipPath)) selectedClipPath = null

  for (const entry of trades) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'trade-item'
    item.setAttribute('aria-pressed', String(entry.clipPath === selectedClipPath))

    const title = document.createElement('span')
    title.textContent = entry.label
    item.appendChild(title)

    const pathEl = document.createElement('span')
    pathEl.className = 'path'
    pathEl.textContent = entry.clipPath
    item.appendChild(pathEl)

    item.addEventListener('click', () => {
      selectedClipPath = entry.clipPath
      form.setClipPath(selectedClipPath)
      renderList()
    })

    listEl.appendChild(item)
  }

  runButton.disabled = selectedClipPath === null
}

function setTrades(next) {
  trades = Array.isArray(next) ? next : []
  renderList()
}

window.api.getTrades().then(setTrades)
window.api.onTradesUpdated(setTrades)

// Файл не из списка сделок обрабатывается отдельным окном обрезки — так это
// окно остаётся именно списком сделок сессии.
setupFileDrop(document.getElementById('dropzone'), (filePath) => {
  if (filePath) window.api.openCropWindowFor(filePath)
})

runButton.addEventListener('click', () => {
  if (!selectedClipPath) return
  runCrop({ clipPath: selectedClipPath, options: form.getOptions(), button: runButton, statusEl, form })
})

closeButton.addEventListener('click', () => window.api.closeWindow())
