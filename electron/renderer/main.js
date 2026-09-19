// Главное окно: "Сейчас" и "Клипы".
//
// До него у программы окна не было вовсе — только значок в трее и меню в нём.
// На вопрос "работает ли она" отвечал цвет значка: три состояния, которые надо
// знать наизусть, и которые легко не заметить. Вкладка "Сейчас" отвечает на
// этот вопрос словами и сразу говорит, что делать, если не работает.

// ── Вкладки ───────────────────────────────────────────────────────────────

const panels = new Map()
for (const panel of document.querySelectorAll('[data-panel]')) {
  panels.set(panel.dataset.panel, panel)
}

function showTab(name) {
  for (const [key, panel] of panels) panel.hidden = key !== name
  for (const button of document.querySelectorAll('.tab')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name))
  }
}

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => showTab(button.dataset.tab))
}

// Окно могли открыть сразу на нужной вкладке — например, из меню трея.
window.api.getInitialTab().then((tab) => { if (tab) showTab(tab) })
window.api.onShowTab((tab) => { if (tab) showTab(tab) })

// ── Вкладка "Сейчас" ──────────────────────────────────────────────────────

const dotEl = document.getElementById('status-dot')
const titleEl = document.getElementById('status-title')
const detailEl = document.getElementById('status-detail')
const factsEl = document.getElementById('facts')
const nowStatusEl = document.getElementById('now-status')

const TERMINAL_NAMES = { vataga: 'Vataga', tigertrade: 'TigerTrade' }

// Словами состояние описывается здесь, а не в основном процессе: в трее нужна
// короткая строка, в окне — человеческая, и это одно и то же состояние.
function describeStatus(status) {
  switch (status.state) {
    case 'ok':
      return {
        title: 'Всё работает',
        detail: 'OBS подключён, буфер повтора включён. Клипы нарезаются сами по мере закрытия сделок.'
      }
    case 'bufferOff':
      return {
        title: 'Буфер повтора выключен',
        detail: 'OBS подключён, но сохранять нечего. Включи буфер в самом OBS: Настройки → Вывод → «Включить буфер повтора».'
      }
    case 'warn':
      return {
        title: 'Нет связи с OBS',
        detail: status.obsPasswordSet
          ? 'Проверь, запущен ли OBS и включён ли в нём сервер WebSocket. Пароль можно перепроверить в настройках.'
          : 'Пароль от OBS не задан — без него программа не сможет ничего записать. Пройди первую настройку.'
      }
    case 'paused':
      return { title: 'На паузе', detail: 'Слежение за сделками остановлено. Возобновить можно из меню в трее.' }
    case 'error':
      return { title: 'Ошибка', detail: status.text || 'Подробности в журнале программы.' }
    default:
      return { title: 'Состояние неизвестно', detail: '' }
  }
}

function addFact(term, value) {
  const dt = document.createElement('dt')
  dt.textContent = term
  const dd = document.createElement('dd')
  dd.textContent = value
  factsEl.appendChild(dt)
  factsEl.appendChild(dd)
}

function describeAutoCrop(status) {
  if (status.autoCropDetect) return 'находить область сделки самой'
  if (status.autoCropArea) return `всегда «${status.autoCropArea}»`
  return 'не вырезать (только вручную)'
}

function renderStatus(status) {
  const { title, detail } = describeStatus(status)
  dotEl.className = `status-dot status-dot-${status.state}`
  titleEl.textContent = title
  detailEl.textContent = detail

  factsEl.innerHTML = ''
  addFact('Терминал', TERMINAL_NAMES[status.terminal] || status.terminal || 'не выбран')
  addFact('Клипы', status.clipsDir || '—')
  addFact('Областей кадра настроено', String(status.areasCount))
  addFact('Обрезка по области', describeAutoCrop(status))
  addFact('Версия', status.version)
}

// Кнопки длительностей берём из настроек: там человек уже перечислил те, что
// ему нужны, и второй список в другом месте разошёлся бы с первым.
function renderReplayButtons(seconds) {
  const container = document.querySelector('[data-role="replay"]')
  container.innerHTML = ''
  for (const value of seconds) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'option'
    button.textContent = value % 60 === 0 && value >= 60 ? `${value / 60} мин` : `${value} сек`
    button.addEventListener('click', async () => {
      button.disabled = true
      nowStatusEl.className = 'status busy'
      nowStatusEl.textContent = `Прошу у OBS последние ${button.textContent}...`
      try {
        const result = await window.api.saveReplay(value)
        if (result.error) {
          nowStatusEl.className = 'status error'
          nowStatusEl.textContent = result.error
        } else {
          nowStatusEl.className = 'status ok'
          nowStatusEl.textContent = `Повтор сохранён: ${result.clipPath}`
        }
      } catch (error) {
        nowStatusEl.className = 'status error'
        nowStatusEl.textContent = `Не получилось: ${error.message || error}`
      } finally {
        button.disabled = false
      }
    })
    container.appendChild(button)
  }
}

let clipsDir = null

window.api.getStatus().then((status) => {
  clipsDir = status.clipsDir
  renderStatus(status)
})
window.api.onStatusChanged((status) => {
  clipsDir = status.clipsDir
  renderStatus(status)
})
window.api.getConfig().then((config) => renderReplayButtons(config.clip.replayPresetsSec))

document.getElementById('open-clips-dir').addEventListener('click', () => {
  if (clipsDir) window.api.openFolderPath(clipsDir)
})
document.getElementById('open-crop').addEventListener('click', () => window.api.openCropWindow())
document.getElementById('open-settings').addEventListener('click', () => showTab('settings'))
document.getElementById('open-setup').addEventListener('click', () => window.api.openSetup())
document.getElementById('open-help').addEventListener('click', () => window.api.openHelp())

// Перезапуск переехал сюда из трея: это действие на случай «что-то заклинило»,
// и ему место рядом с тем, что показывает состояние.
document.getElementById('restart').addEventListener('click', async () => {
  const button = document.getElementById('restart')
  button.disabled = true
  nowStatusEl.className = 'status busy'
  nowStatusEl.textContent = 'Останавливаю и подключаюсь заново...'
  try {
    const result = await window.api.restartWatching()
    nowStatusEl.className = result.error ? 'status error' : 'status ok'
    nowStatusEl.textContent = result.error || 'Слежение перезапущено.'
  } catch (error) {
    nowStatusEl.className = 'status error'
    nowStatusEl.textContent = `Не получилось: ${error.message || error}`
  } finally {
    button.disabled = false
  }
})

// ── Вкладка "Клипы" ───────────────────────────────────────────────────────

const listEl = document.getElementById('trade-list')
const clipsStatusEl = document.getElementById('clips-status')
const runButton = document.getElementById('run')
const cropForm = createCropForm(document.getElementById('crop-form'))

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
      cropForm.setClipPath(selectedClipPath)
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

// Файл не из списка сделок обрабатывается отдельным окном обрезки — так эта
// вкладка остаётся именно списком сделок сессии.
setupFileDrop(document.getElementById('dropzone'), (filePath) => {
  if (filePath) window.api.openCropWindowFor(filePath)
})

runButton.addEventListener('click', () => {
  if (!selectedClipPath) return
  runCrop({ clipPath: selectedClipPath, options: cropForm.getOptions(), button: runButton, statusEl: clipsStatusEl, form: cropForm })
})
