// Общая для двух окон панель параметров обрезки: что вырезать из кадра, с
// какой скоростью, со звуком или без и под каким именем сохранить.
//
// Кадра и дорожки здесь больше нет — за них отвечает редактор (cropEditor.js)
// в своём окне. Панель знает только про настройки: так она одинаково уместна
// и строкой под кадром в редакторе, и блоком во вкладке «Клипы».
//
// Работает только через window.api (см. preload.js) — прямого доступа к
// node-модулям у окон нет.

// На сколько равных частей делить кадр, пока пользователь не настроил свои
// области. Приходит из настроек: мониторы у всех разные, зашивать нельзя.
const DEFAULT_STAKAN_COUNT = 0
// Остановки ползунка скорости. Неравномерные намеренно: между «обычной» и
// тройной разница заметна на глаз и выбирается точно, а выше десятой доли
// секунды всё равно не разглядеть — там шаг крупнее.
//
// Список здесь, а не в настройках: в настройках задаются скорости для меню
// трея, где их перечисляют строкой и где каждая — отдельный пункт. Ползунку
// нужны частые остановки, иначе он не ползунок.
const SPEED_STOPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
// Стакан выбирать необязательно: бывает нужно просто ускорить клип или
// отрезать секунды с краёв, оставив кадр целиком. null = не резать по ширине,
// это же значение понимает cropClipToStakan.
const NO_STAKAN = null

function buildOptionGroup(container, values, formatLabel, initialValue, onChange) {
  const buttons = new Map()
  const select = (value) => {
    for (const [candidate, button] of buttons) {
      button.setAttribute('aria-pressed', String(candidate === value))
    }
    onChange(value)
  }
  for (const value of values) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'option'
    button.textContent = formatLabel(value)
    button.addEventListener('click', () => select(value))
    buttons.set(value, button)
    container.appendChild(button)
  }
  select(initialValue)
  return { select }
}

// Собирает панель в переданный контейнер.
function createCropForm(root, { onAreaChosen = () => {} } = {}) {
  root.innerHTML = `
    <div class="field">
      <label class="field-label">Что вырезать из кадра</label>
      <div class="options" data-role="stakan"></div>
    </div>
    <div class="field">
      <label class="field-label" for="speed">Скорость</label>
      <div class="speed-row">
        <input type="range" id="speed" min="0" max="${SPEED_STOPS.length - 1}" step="1" value="0">
        <span class="speed-value" data-role="speed-value"></span>
      </div>
    </div>
    <div class="field">
      <label class="checkbox">
        <input type="checkbox" id="mute">
        <span>Без звука</span>
      </label>
    </div>
    <div class="field">
      <label class="field-label" for="output-name">Имя файла</label>
      <input type="text" id="output-name" placeholder="составится из имени исходника" maxlength="120">
    </div>
  `

  let stakanIndex = NO_STAKAN
  let stakanCount = DEFAULT_STAKAN_COUNT
  let speedFactor = 1
  // Рамка, нарисованная мышью в редакторе. Пока она есть — режем по ней, а не
  // по стакану или пресету: это самое свежее и самое осознанное решение.
  let manualRect = null
  // Выбранный сохранённый пресет (объект из config.clip.cropPresets)
  let selectedPreset = null

  const stakanContainer = root.querySelector('[data-role="stakan"]')
  const speedInput = root.querySelector('#speed')
  const speedValueEl = root.querySelector('[data-role="speed-value"]')
  const muteInput = root.querySelector('#mute')
  const outputNameInput = root.querySelector('#output-name')

  // Область, выбранная кнопкой, в пикселях кадра. Сохранённый пресет уже
  // содержит координаты; расчётный «Стакан N» — это доля кадра, поэтому его
  // можно посчитать только зная размер записи.
  function areaRect(frameSize) {
    if (selectedPreset) return { ...selectedPreset }
    if (stakanIndex == null || !frameSize || !stakanCount) return null
    const baseWidth = Math.round(frameSize.width / stakanCount)
    const isLast = stakanIndex === stakanCount
    return {
      x: baseWidth * (stakanIndex - 1),
      y: 0,
      width: isLast ? frameSize.width - baseWidth * (stakanCount - 1) : baseWidth,
      height: frameSize.height
    }
  }

  // Кнопки выбора области: «Весь кадр», затем сохранённые пресеты (если есть),
  // затем расчётные стаканы. Пресеты идут раньше стаканов намеренно — они
  // точнее, стаканы остаются как запасной вариант.
  function buildAreaOptions(presets) {
    stakanContainer.innerHTML = ''
    // Расчётные «Стакан 1..N» показываем только пока нет своих областей: когда
    // пользователь настроил границы по кадру, равное деление ему уже не нужно
    // и только загромождает выбор.
    const fallback = presets.length > 0
      ? []
      : Array.from({ length: stakanCount }, (_, i) => ({ key: i + 1, label: `Стакан ${i + 1}` }))
    const values = [
      { key: NO_STAKAN, label: 'Весь кадр' },
      ...presets.map((preset) => ({ key: `preset:${preset.name}`, label: preset.name, preset })),
      ...fallback
    ]
    buildOptionGroup(
      stakanContainer,
      values.map((item) => item.key),
      (key) => values.find((item) => item.key === key).label,
      // По умолчанию ничего не режем: обрезка кадра — осознанный выбор, а не
      // то, что должно случиться само, если про кнопки забыли.
      NO_STAKAN,
      (key) => {
        const chosen = values.find((item) => item.key === key)
        selectedPreset = chosen.preset || null
        stakanIndex = typeof key === 'number' ? key : NO_STAKAN
        // Выбор готовой области отменяет рамку, нарисованную вручную —
        // иначе непонятно, что из двух победит.
        manualRect = null
        onAreaChosen(areaRect)
      }
    )
  }

  buildAreaOptions([])
  if (window.api.getConfig) {
    window.api.getConfig().then((config) => {
      // Именно проверкой на число, а не через ||: ноль здесь законное
      // значение («не делить кадр»), и || молча заменил бы его умолчанием.
      const configured = Number(config && config.clip && config.clip.stakanCount)
      stakanCount = Number.isFinite(configured) ? Math.max(0, configured) : DEFAULT_STAKAN_COUNT
      return window.api.getCropPresets ? window.api.getCropPresets() : []
    }).then((presets) => buildAreaOptions(presets || []))
  }

  function showSpeed() {
    speedFactor = SPEED_STOPS[Number(speedInput.value)] || 1
    speedValueEl.textContent = speedFactor === 1 ? 'Обычная' : `x${speedFactor}`
  }

  speedInput.addEventListener('input', showSpeed)
  showSpeed()

  return {
    // Окно сообщает панели, что взяли другой файл: прежняя рамка снималась с
    // другого кадра и к новому отношения не имеет.
    setClipPath() {
      manualRect = null
    },
    // Редактор сообщает, что рамку подвинули мышью. Кнопки при этом гаснут:
    // иначе казалось бы, что выбрано и то, и другое.
    setManualRect(rect) {
      manualRect = rect
      if (!rect) return
      for (const button of stakanContainer.querySelectorAll('.option')) {
        button.setAttribute('aria-pressed', 'false')
      }
      selectedPreset = null
      stakanIndex = NO_STAKAN
    },
    // Чтобы редактор мог показать на кадре ту область, что выбрана кнопкой
    getAreaRect: areaRect,
    getOptions() {
      const cropRect = manualRect || (selectedPreset ? { ...selectedPreset } : null)
      return {
        stakanIndex,
        stakanCount,
        cropRect,
        cropPresetName: selectedPreset && !manualRect ? selectedPreset.name : '',
        speedFactor,
        mute: muteInput.checked,
        outputFileName: outputNameInput.value.trim()
      }
    },
    afterRun() {}
  }
}

// Без этого брошенный мимо зоны файл заставит окно «перейти» на него, как
// браузер — то есть приложение просто исчезнет, показав видео во весь экран.
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

// Подписывает элемент на приём перетащенного файла. Путь достаётся через
// window.api.getPathForFile (webUtils) — у File в современных Electron
// свойства .path больше нет.
function setupFileDrop(element, onFile) {
  const setDragging = (isDragging) => element.classList.toggle('dragover', isDragging)

  element.addEventListener('dragover', (event) => {
    event.preventDefault()
    setDragging(true)
  })
  element.addEventListener('dragleave', () => setDragging(false))
  element.addEventListener('drop', (event) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    onFile(window.api.getPathForFile(file))
  })
}

// Со снятым стаканом можно не выбрать вообще ничего — тогда ffmpeg просто
// перекодировал бы файл сам в себя: минуты работы ради копии оригинала.
function hasWorkToDo(options) {
  return options.stakanIndex != null
    || options.cropRect
    || options.speedFactor !== 1
    || options.trimStart > 0
    || options.trimEnd > 0
    || options.mute
}

// Общий обработчик «нажали Вырезать»: блокирует кнопку, показывает статус,
// печатает путь к результату и даёт открыть его в Проводнике.
async function runCrop({ clipPath, options, button, statusEl, form }) {
  if (!hasWorkToDo(options)) {
    statusEl.className = 'status error'
    statusEl.textContent = 'Нечего делать: выбери область кадра, скорость или обрезку по времени.'
    return
  }

  button.disabled = true
  statusEl.className = 'status busy'
  statusEl.textContent = 'Режу... это может занять несколько секунд (перекодирование).'
  try {
    const outputPath = await window.api.cropClip(clipPath, options)
    if (form && form.afterRun) form.afterRun()
    statusEl.className = 'status ok'
    statusEl.textContent = ''

    const doneEl = document.createElement('div')
    doneEl.textContent = 'Готово.'
    statusEl.appendChild(doneEl)

    const pathEl = document.createElement('span')
    pathEl.className = 'status-path'
    pathEl.textContent = outputPath
    statusEl.appendChild(pathEl)

    // Кнопкой, а не ссылкой: после долгой обрезки это первое, что нужно нажать,
    // и мелкая ссылка в тексте статуса терялась.
    const revealButton = document.createElement('button')
    revealButton.type = 'button'
    revealButton.className = 'secondary reveal-button'
    revealButton.textContent = 'Открыть папку'
    revealButton.addEventListener('click', () => window.api.openFolder(outputPath))
    statusEl.appendChild(revealButton)
  } catch (error) {
    statusEl.className = 'status error'
    statusEl.textContent = `Ошибка: ${error.message || error}`
  } finally {
    button.disabled = false
  }
}
