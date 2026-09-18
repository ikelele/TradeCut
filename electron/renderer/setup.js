// Помощник первой настройки.
//
// Сознательно НЕ пересказывает окно настроек: в нём три шага, без которых
// программа просто не работает, и каждый заканчивается настоящей проверкой.
// Всё остальное прекрасно живёт со значениями по умолчанию.
//
// Настройки он пишет через тот же saveConfig, что и окно настроек, и всегда
// целиком: saveConfig накладывает присланное на умолчания, а не на то, что
// лежит на диске, — частичное сохранение сбросило бы всё, чего тут нет.

const STEPS = ['step-obs', 'step-terminal', 'step-areas']

const TERMINALS = [
  { id: 'vataga', label: 'Vataga' },
  { id: 'tigertrade', label: 'TigerTrade' }
]

const stepCounterEl = document.getElementById('step-counter')
const nextButton = document.getElementById('next')
const backButton = document.getElementById('back')
const skipButton = document.getElementById('skip')

const obsUrlEl = document.getElementById('obs-url')
const obsPasswordEl = document.getElementById('obs-password')
const obsStatusEl = document.getElementById('obs-status')
const terminalStatusEl = document.getElementById('terminal-status')
const areasStatusEl = document.getElementById('areas-status')

let config = null
let stepIndex = 0
let terminalType = TERMINALS[0].id

function setStatus(element, text, kind) {
  element.className = kind ? `status ${kind}` : 'status'
  element.textContent = text
  // Ответ проверки — единственное, ради чего эта кнопка нажата, и он обязан
  // попасть на глаза. Текст появляется под кнопкой, то есть у нижнего края
  // прокручиваемой области, и без этого запросто оказывается за ней.
  if (text) element.scrollIntoView({ block: 'nearest' })
}

// ── Шаги ──────────────────────────────────────────────────────────────────

function showStep(index) {
  stepIndex = Math.max(0, Math.min(index, STEPS.length - 1))
  STEPS.forEach((id, k) => {
    document.getElementById(id).hidden = k !== stepIndex
  })

  stepCounterEl.textContent = `Шаг ${stepIndex + 1} из ${STEPS.length}`
  backButton.hidden = stepIndex === 0
  // На последнем шаге "Дальше" вести уже некуда, а закрыть окно нужно тем же
  // движением — иначе единственным выходом остаётся "Пропустить", что после
  // честно пройденной настройки читается неправильно.
  const lastStep = stepIndex === STEPS.length - 1
  nextButton.textContent = lastStep ? 'Готово' : 'Дальше'
  skipButton.hidden = lastStep
  // И перестаёт быть главной кнопкой: на последнем шаге главное действие —
  // "Сохранить повтор и разметить области", а два синих акцента рядом просто
  // спорят друг с другом.
  nextButton.className = lastStep ? 'secondary' : 'primary'
}

// Сохраняем по ходу, на каждом переходе, а не одной кнопкой в конце: человек
// может закрыть окно на втором шаге, и введённый пароль от OBS терять при
// этом незачем — он уже проверен и работает.
async function persistCurrentStep() {
  if (!config) return

  if (stepIndex === 0) {
    config.obs.url = obsUrlEl.value.trim()
    config.obs.password = obsPasswordEl.value
  }
  if (stepIndex === 1) {
    config.terminal.type = terminalType
  }

  config = await window.api.saveConfig(config)
}

// Статус текущего шага — чтобы сообщать об ошибке сохранения там, где человек
// сейчас смотрит, а не в консоли, которой у трей-приложения всё равно нет.
const STEP_STATUS = [obsStatusEl, terminalStatusEl, areasStatusEl]

nextButton.addEventListener('click', async () => {
  nextButton.disabled = true
  try {
    await persistCurrentStep()
    if (stepIndex === STEPS.length - 1) {
      window.api.closeWindow()
      return
    }
    showStep(stepIndex + 1)
  } catch (error) {
    setStatus(STEP_STATUS[stepIndex], `Не удалось сохранить настройки: ${error.message}`, 'error')
  } finally {
    nextButton.disabled = false
  }
})

backButton.addEventListener('click', () => showStep(stepIndex - 1))

skipButton.addEventListener('click', async () => {
  // Пропуск — не отмена: то, что уже введено на этом шаге, сохраняем. Иначе
  // "проверил пароль, всё зелёное, пропустил остальное" теряло бы пароль.
  // Закрываемся в любом случае: не дать выйти из-за неудачного сохранения —
  // худшее, что может сделать окно, которое человек уже решил закрыть.
  try {
    await persistCurrentStep()
  } catch {
    // сохранить не вышло — настройки останутся прежними, это не повод держать окно
  }
  window.api.closeWindow()
})

// ── Шаг 1: OBS ────────────────────────────────────────────────────────────

// Неудачи подключения бывают трёх разных сортов, и валить их в один совет
// «проверь, запущен ли OBS, включён ли сервер и тот ли пароль» — значит
// заставлять перепроверять две заведомо исправные вещи. Если OBS ответил
// «пароль не тот», значит он запущен и сервер в нём включён.
function explainConnectFailure(error) {
  const text = String(error || '')
  // Точку в конце своего сообщения OBS ставит сам — второй подряд не нужно.
  const reason = text.replace(/\.\s*$/, '')

  if (/authentication/i.test(text)) {
    return 'Пароль не подошёл. Возьми его копированием, а не глазами: в OBS ' +
      '«Сервис → Настройки сервера WebSocket» → «Показать сведения о подключении» → ' +
      'строка «Пароль сервера», кнопка «Копировать». И проверь, что в OBS нажато «Применить».'
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(text)) {
    return `На этот адрес никто не отвечает (${reason}). Проверь, запущен ли OBS и стоит ли ` +
      'в нём галка «Включить сервер WebSocket», а в адресе — тот же порт, что и в настройках OBS.'
  }
  return `Не подключилось: ${reason}.`
}

document.getElementById('check-obs').addEventListener('click', async () => {
  const button = document.getElementById('check-obs')
  button.disabled = true
  setStatus(obsStatusEl, 'Подключаюсь к OBS...', 'busy')

  try {
    const result = await window.api.checkObs(obsUrlEl.value.trim(), obsPasswordEl.value)

    if (!result.connected) {
      setStatus(obsStatusEl, explainConnectFailure(result.error), 'error')
      return
    }
    if (!result.replayBufferActive) {
      // Подключение и буфер — разные вещи, и путать их нельзя: пароль тут уже
      // правильный, осталось включить буфер в самом OBS.
      setStatus(obsStatusEl,
        'OBS подключён, пароль подходит. Но буфер повтора в нём выключен — включи его: Настройки → Вывод → «Включить буфер повтора».',
        'warn')
      return
    }
    setStatus(obsStatusEl, 'OBS подключён, буфер повтора включён. Этот шаг готов.', 'ok')
  } catch (error) {
    setStatus(obsStatusEl, `Не удалось проверить: ${error.message}`, 'error')
  } finally {
    button.disabled = false
  }
})

// ── Шаг 2: терминал ───────────────────────────────────────────────────────

const terminalButtons = new Map()

function selectTerminal(id) {
  terminalType = TERMINALS.some((item) => item.id === id) ? id : TERMINALS[0].id
  for (const [candidate, button] of terminalButtons) {
    button.setAttribute('aria-pressed', String(candidate === terminalType))
  }
  setStatus(terminalStatusEl, '')
}

const terminalContainer = document.querySelector('[data-role="terminal"]')
for (const terminal of TERMINALS) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'option'
  button.setAttribute('aria-pressed', 'false')
  button.textContent = terminal.label
  button.addEventListener('click', () => selectTerminal(terminal.id))
  terminalButtons.set(terminal.id, button)
  terminalContainer.appendChild(button)
}

function formatLastWrite(lastWriteMs) {
  if (!lastWriteMs) return ''
  const date = new Date(lastWriteMs)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

document.getElementById('check-terminal').addEventListener('click', async () => {
  const button = document.getElementById('check-terminal')
  button.disabled = true
  setStatus(terminalStatusEl, 'Ищу журнал...', 'busy')

  try {
    const result = await window.api.checkTerminal(terminalType)

    if (result.files.length === 0) {
      setStatus(terminalStatusEl,
        `Журнал ${result.terminalName} не найден в папке: ${result.logsDir}. Возможно, выбран не тот терминал, либо он ещё ни разу не запускался.`,
        'error')
      return
    }

    const when = formatLastWrite(result.lastWriteMs)
    setStatus(terminalStatusEl,
      `Журнал ${result.terminalName} найден: файлов ${result.files.length}` +
      `${when ? `, последняя запись ${when}` : ''}. Папка: ${result.logsDir}`,
      'ok')
  } catch (error) {
    setStatus(terminalStatusEl, `Не удалось проверить: ${error.message}`, 'error')
  } finally {
    button.disabled = false
  }
})

// ── Шаг 3: области кадра ──────────────────────────────────────────────────

document.getElementById('save-replay').addEventListener('click', async () => {
  const button = document.getElementById('save-replay')
  button.disabled = true
  setStatus(areasStatusEl, 'Прошу у OBS последние секунды записи...', 'busy')

  try {
    const result = await window.api.saveSetupReplay()

    if (result.error) {
      setStatus(areasStatusEl, `${result.error}. Вернись на первый шаг и проверь подключение к OBS.`, 'error')
      return
    }

    setStatus(areasStatusEl,
      'Повтор сохранён, окно разметки открыто — дальше подсказка в нём. Это окно можно закрывать.',
      'ok')
  } catch (error) {
    setStatus(areasStatusEl, `Не получилось: ${error.message}`, 'error')
  } finally {
    button.disabled = false
  }
})

// ── Старт ─────────────────────────────────────────────────────────────────

window.api.getConfig().then((loaded) => {
  config = loaded
  obsUrlEl.value = config.obs.url || ''
  obsPasswordEl.value = config.obs.password || ''
  selectTerminal(config.terminal.type)
  showStep(0)
})
