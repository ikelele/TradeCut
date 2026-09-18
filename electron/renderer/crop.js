const dropzone = document.getElementById('dropzone')
const fileNameEl = document.getElementById('file-name')
const statusEl = document.getElementById('status')
const runButton = document.getElementById('run')
const closeButton = document.getElementById('close')
const pickButton = document.getElementById('pick')

const form = createCropForm(document.getElementById('crop-form'))

let clipPath = null

function setClipPath(filePath) {
  if (!filePath) return
  clipPath = filePath
  form.setClipPath(filePath)
  fileNameEl.textContent = filePath
  fileNameEl.className = 'picked'
  runButton.disabled = false
  statusEl.className = 'status'
  statusEl.textContent = ''
}

// Файл мог быть передан аргументом (перетащили на сам .exe) — тогда он уже
// известен основному процессу и окно просто забирает его при открытии.
window.api.getDroppedFile().then(setClipPath)

// Окно открыл помощник первой настройки — значит человек здесь впервые и
// пришёл именно за областями. Показываем порядок действий, чтобы не искать
// нужные кнопки среди всех остальных.
window.api.isGuidedCrop().then((guided) => {
  if (guided) document.getElementById('guided-banner').hidden = false
})

setupFileDrop(dropzone, setClipPath)

pickButton.addEventListener('click', async () => {
  setClipPath(await window.api.pickVideoFile())
})

runButton.addEventListener('click', () => {
  if (!clipPath) return
  runCrop({ clipPath, options: form.getOptions(), button: runButton, statusEl, form })
})

closeButton.addEventListener('click', () => window.api.closeWindow())
