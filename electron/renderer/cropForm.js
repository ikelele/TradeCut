// Общая для обоих окон панель параметров обрезки: выбор стакана, скорости и
// обрезки краёв + запуск самой обрезки. Работает только через window.api
// (см. preload.js) — прямого доступа к node-модулям у окон нет.

// На сколько равных частей делить кадр, пока пользователь не настроил свои
// области. Приходит из настроек: мониторы у всех разные, зашивать нельзя.
const DEFAULT_STAKAN_COUNT = 0
// Запасной список на случай, если настройки ещё не прочитаны
const DEFAULT_SPEED_PRESETS = [1, 2, 3, 5, 10]
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

// Собирает панель в переданный контейнер и возвращает { getOptions, setBusy }.
function createCropForm(root) {
  root.innerHTML = `
    <div class="field">
      <label class="field-label">Что вырезать из кадра — необязательно</label>
      <div class="options" data-role="stakan"></div>
      <button type="button" class="secondary" data-role="pick-visually">Показать кадр</button>
      <p class="field-hint" data-role="trim-summary" hidden></p>
      <div class="crop-preview" data-role="preview" hidden></div>
    </div>
    <div class="field">
      <label class="field-label">Скорость</label>
      <div class="options" data-role="speed"></div>
    </div>
    <div class="field">
      <label class="checkbox">
        <input type="checkbox" id="mute">
        <span>Без звука</span>
      </label>
    </div>
    <div class="field">
      <label class="field-label" for="output-name">Имя файла — необязательно</label>
      <input type="text" id="output-name" placeholder="оставь пустым — составится из имени исходника" maxlength="120">
    </div>
  `

  let stakanIndex = 1
  let stakanCount = DEFAULT_STAKAN_COUNT
  let speedPresets = DEFAULT_SPEED_PRESETS
  let speedFactor = 1
  let clipPath = null
  // Рамка, выбранная мышью прямо сейчас. Пока она есть — режем по ней, а не
  // по стакану или пресету: это самое свежее и самое осознанное решение.
  let visualRect = null
  let visualName = ''
  // Выбранный сохранённый пресет (объект из config.clip.cropPresets)
  let selectedPreset = null

  const stakanContainer = root.querySelector('[data-role="stakan"]')
  const previewRoot = root.querySelector('[data-role="preview"]')
  const pickButton = root.querySelector('[data-role="pick-visually"]')
  const muteInput = root.querySelector('#mute')
  const outputNameInput = root.querySelector('#output-name')
  const trimSummaryEl = root.querySelector('[data-role="trim-summary"]')

  // Обрезка по времени задаётся только ручками на дорожке в превью. Числовых
  // полей больше нет, поэтому значение живёт здесь — и обязательно
  // показывается строкой ниже: закрыв превью, про заданную обрезку иначе
  // легко забыть, а «Вырезать» её всё равно применит.
  let trim = { trimStart: 0, trimEnd: 0 }

  function currentTrim() {
    return { ...trim }
  }

  function setTrim(next) {
    trim = { trimStart: next.trimStart || 0, trimEnd: next.trimEnd || 0 }
    const parts = []
    if (trim.trimStart > 0) parts.push(`${trim.trimStart} с начала`)
    if (trim.trimEnd > 0) parts.push(`${trim.trimEnd} с конца`)
    trimSummaryEl.hidden = parts.length === 0
    trimSummaryEl.textContent = parts.length > 0 ? `Обрезка по времени: ${parts.join(', ')} (сек)` : ''
  }

  // Кнопки выбора области: "Весь кадр", затем сохранённые пресеты (если есть),
  // затем расчётные стаканы. Пресеты идут раньше стаканов намеренно — они
  // точнее, стаканы остаются как запасной вариант.
  function buildAreaOptions(presets) {
    stakanContainer.innerHTML = ''
    // Расчётные "Стакан 1..N" показываем только пока нет своих областей: когда
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
        visualRect = null
        visualName = ''
        showChosenArea()
      }
    )
  }

  buildAreaOptions([])
  if (window.api.getConfig) {
    window.api.getConfig().then((config) => {
      // Именно проверкой на число, а не через ||: ноль здесь законное
      // значение ("не делить кадр"), и || молча заменил бы его умолчанием.
      const configured = Number(config && config.clip && config.clip.stakanCount)
      stakanCount = Number.isFinite(configured) ? Math.max(0, configured) : DEFAULT_STAKAN_COUNT

      const speeds = config && config.clip && config.clip.speedPresets
      if (Array.isArray(speeds) && speeds.length > 0) {
        speedPresets = speeds
        buildSpeedOptions()
      }
      return window.api.getCropPresets ? window.api.getCropPresets() : []
    }).then((presets) => buildAreaOptions(presets || []))
  }

  const preview = createCropPreview(previewRoot, {
    // Дорожка в превью и числовые поля — это одно и то же значение в двух
    // видах. Источником правды остаются поля: их читает getOptions, и менять
    // это ради превью не стоит.
    onTrimChange: setTrim,
    onChange: (rect) => {
      visualRect = rect
      if (rect) {
        // Ручная рамка перебивает кнопки: снимаем с них отметку, чтобы не
        // казалось, будто выбрано и то, и другое.
        for (const button of stakanContainer.querySelectorAll('.option')) {
          button.setAttribute('aria-pressed', 'false')
        }
        selectedPreset = null
        stakanIndex = NO_STAKAN
      }
    }
  })

  // Область, выбранная кнопкой, в пикселях кадра. Сохранённый пресет уже
  // содержит координаты; расчётный "Стакан N" — это доля кадра, поэтому его
  // можно посчитать только зная размер записи.
  function chosenAreaRect(frameSize) {
    if (selectedPreset) return { ...selectedPreset }
    if (stakanIndex == null || !frameSize) return null
    const baseWidth = Math.round(frameSize.width / stakanCount)
    const isLast = stakanIndex === stakanCount
    return {
      x: baseWidth * (stakanIndex - 1),
      y: 0,
      width: isLast ? frameSize.width - baseWidth * (stakanCount - 1) : baseWidth,
      height: frameSize.height
    }
  }

  // Показывает на кадре ту область, которая выбрана кнопкой, — чтобы было
  // видно, что именно вырежется, а не гадать по названию.
  // Само превью при этом НЕ открывается: разворачивать окно во весь экран из-за
  // нажатия на "Стакан 2" — слишком резко, если человек просто выбирает, что
  // резать. Кадр открывается только кнопкой "Показать кадр".
  function showChosenArea() {
    if (!clipPath || !preview.isOpen()) return
    preview.showArea(chosenAreaRect)
  }

  function closePreview() {
    preview.close()
    pickButton.textContent = 'Показать кадр'
    if (window.api.setPreviewMode) window.api.setPreviewMode(false)
    // После нарезки страница прокручена вниз, к пути готового файла. Если её
    // не вернуть, окно обрезки открывается где-то на середине формы — вместо
    // привычного вида с выбором файла сверху.
    window.scrollTo({ top: 0 })
  }

  pickButton.addEventListener('click', () => {
    if (preview.isOpen()) {
      closePreview()
      return
    }
    if (!clipPath) {
      preview.setStatus('Сначала выбери файл.')
      return
    }
    // Окно под форму узкое, разглядывать в нём кадр невозможно — на время
    // превью разворачиваем его почти во весь экран.
    // Уже выбранную кнопкой область покажем сразу, как только загрузится кадр.
    preview.showAreaWhenReady(chosenAreaRect)
    if (window.api.setPreviewMode) window.api.setPreviewMode(true)
    preview.open(clipPath, currentTrim())
    pickButton.textContent = 'Скрыть кадр'
  })

  // Крестик окна при открытом превью и клавиша Esc возвращают к обычному виду
  // окна обрезки, а не закрывают всё разом.
  if (window.api.onPreviewDismiss) {
    window.api.onPreviewDismiss(() => {
      if (preview.isOpen()) closePreview()
      else window.api.closeWindow()
    })
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && preview.isOpen()) closePreview()
  })

  // Разовая настройка под свой монитор: обвёл рамкой нужную высоту, нажал
  // "Найти границы", нажал это — и все стаканы сохранены с настоящими
  // границами. Дальше они доступны и здесь, и в меню трея по сделке.

  function buildSpeedOptions() {
    const container = root.querySelector('[data-role="speed"]')
    container.innerHTML = ''
    // Единица должна быть в списке всегда: без неё нельзя выбрать "как есть",
    // а в настройках её легко случайно убрать.
    const values = speedPresets.includes(1) ? speedPresets : [1, ...speedPresets]
    buildOptionGroup(
      container,
      values,
      (value) => (value === 1 ? 'Обычная' : `x${value}`),
      1,
      (value) => { speedFactor = value }
    )
  }

  buildSpeedOptions()

  return {
    // Окно сообщает панели, с каким файлом сейчас работаем: без этого нечего
    // показывать в превью.
    setClipPath(filePath) {
      clipPath = filePath || null
      if (preview.isOpen()) closePreview()
      // Обрезка снималась по длительности прежнего файла — к новому она
      // отношения не имеет, и молча применять её было бы неправильно.
      setTrim({ trimStart: 0, trimEnd: 0 })
    },
    getOptions() {
      const cropRect = visualRect || (selectedPreset ? { ...selectedPreset } : null)
      return {
        stakanIndex,
        stakanCount,
        cropRect,
        cropPresetName: visualRect ? visualName : (selectedPreset ? selectedPreset.name : ''),
        speedFactor,
        ...currentTrim(),
        mute: muteInput.checked,
        outputFileName: outputNameInput.value.trim()
      }
    },
    // Вызывается после успешной нарезки. Превью намеренно НЕ закрываем и окно
    // не ужимаем: раньше оно схлопывалось ровно в тот момент, когда глаз ищет
    // путь к готовому файлу, и это выглядело рывком. Размер вернётся, когда
    // пользователь сам нажмёт "Скрыть кадр" или возьмёт другой файл.
    // Побочная польза: из того же клипа сразу можно вырезать вторую область,
    // не открывая превью заново и не перематывая.
    afterRun() {}
  }
}

// Без этого брошенный мимо зоны файл заставит окно "перейти" на него, как
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

// Общий обработчик "нажали Вырезать": блокирует кнопку, показывает статус,
// печатает путь к результату и даёт открыть его в Проводнике.
async function runCrop({ clipPath, options, button, statusEl, form }) {
  if (!hasWorkToDo(options)) {
    statusEl.className = 'status error'
    statusEl.textContent = 'Нечего делать: выбери стакан, скорость или обрезку краёв.'
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

    // При открытом превью окно высокое, и результат оказывается ниже кадра —
    // подводим его к глазам сами, иначе кажется, что ничего не произошло.
    statusEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  } catch (error) {
    statusEl.className = 'status error'
    statusEl.textContent = `Ошибка: ${error.message || error}`
  } finally {
    button.disabled = false
  }
}
