// Окно обрезки: редактор кадра сверху, настройки строкой снизу.

const fileNameEl = document.getElementById('file-name')
const statusEl = document.getElementById('status')
const runButton = document.getElementById('run')
const pickButton = document.getElementById('pick')
const frameEl = document.getElementById('frame')

let clipPath = null

// Редактор создаётся раньше панели: панель сразу при сборке отмечает «Весь
// кадр» и через onAreaChosen зовёт редактор показать эту область.
const editor = createCropEditor({
  onRectChange: (rect) => form.setManualRect(rect),
  // Кадр загрузился — показываем на нём ту область, что уже выбрана кнопкой.
  // Иначе выбранный до открытия файла «Стакан 2» молча превращался бы в
  // «весь кадр».
  onReady: () => editor.showArea(form.getAreaRect)
})

const form = createCropForm(document.getElementById('crop-form'), {
  onAreaChosen: (getRect) => { if (editor.hasFrame()) editor.showArea(getRect) }
})

function setClipPath(filePath) {
  if (!filePath) return
  clipPath = filePath
  form.setClipPath(filePath)
  fileNameEl.textContent = filePath
  fileNameEl.title = filePath
  runButton.disabled = false
  statusEl.className = 'status'
  statusEl.textContent = ''
  editor.open(filePath)
}

// Файл мог быть передан аргументом (перетащили на сам .exe) — тогда он уже
// известен основному процессу и окно просто забирает его при открытии.
window.api.getDroppedFile().then(setClipPath)

// Бросать файл можно прямо на кадр — на то место, где он и появится.
setupFileDrop(frameEl, setClipPath)

pickButton.addEventListener('click', async () => {
  setClipPath(await window.api.pickVideoFile())
})

runButton.addEventListener('click', () => {
  if (!clipPath) return
  // Обрезка по времени живёт в редакторе, остальное — в панели настроек.
  const options = { ...form.getOptions(), ...editor.getTrim() }
  runCrop({ clipPath, options, button: runButton, statusEl, form })
})
