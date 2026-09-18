const statusEl = document.getElementById('status')
const saveButton = document.getElementById('save')
const closeButton = document.getElementById('close')

// Соответствие "id поля в форме" -> "путь в config.json". Один список задаёт и
// заполнение формы, и сборку конфига обратно — иначе легко забыть поле в одном
// из двух мест.
const FIELDS = [
  { id: 'obs-url', path: ['obs', 'url'], type: 'text' },
  { id: 'obs-password', path: ['obs', 'password'], type: 'text' },
  { id: 'obs-check', path: ['obs', 'replayBufferCheckIntervalSec'], type: 'number' },

  { id: 'terminal-dir', path: ['terminal', 'logsDirOverride'], type: 'text' },
  { id: 'poll-interval', path: ['polling', 'logPollIntervalMs'], type: 'number' },

  { id: 'padding-before', path: ['clip', 'paddingBeforeSec'], type: 'number' },
  { id: 'padding-after', path: ['clip', 'paddingAfterSec'], type: 'number' },
  { id: 'output-dir', path: ['clip', 'outputDir'], type: 'text' },
  { id: 'stakan-dir', path: ['clip', 'stakanOutputDir'], type: 'text' },
  { id: 'manual-replay-dir', path: ['clip', 'manualReplayOutputDir'], type: 'text' },
  { id: 'delete-replays', path: ['clip', 'deleteSourceReplays'], type: 'checkbox' },
  { id: 'tray-crop-muted', path: ['clip', 'trayCropMuted'], type: 'checkbox' },
  // Выпадающий список ведёт себя как обычное поле: и читается, и пишется
  // через .value, поэтому отдельный тип ему не нужен.
  { id: 'auto-crop-area', path: ['clip', 'autoCropArea'], type: 'text' },
  { id: 'auto-crop-delete-full', path: ['clip', 'autoCropDeleteFull'], type: 'checkbox' },
  // Пустое поле здесь осмысленно: "не делить кадр вовсе". Обычный number
  // показал бы 0, а ноль в графе "на сколько частей" выглядит как поломка.
  { id: 'stakan-count', path: ['clip', 'stakanCount'], type: 'number', zeroIsEmpty: true },
  // Списки показываем строкой "15, 30, 60" — в отдельных полях на каждое
  // значение смысла нет, а править строку привычнее.
  { id: 'replay-presets', path: ['clip', 'replayPresetsSec'], type: 'numberList' },
  { id: 'speed-presets', path: ['clip', 'speedPresets'], type: 'numberList' },
  { id: 'tray-history', path: ['clip', 'recentTradesHistorySize'], type: 'number' },

  { id: 'merge-enabled', path: ['clip', 'mergeTradesEnabled'], type: 'checkbox' },
  { id: 'merge-gap', path: ['clip', 'mergeGapSec'], type: 'number' },
  { id: 'keep-parts', path: ['clip', 'keepMergedParts'], type: 'checkbox' },
  { id: 'merged-parts-subdir', path: ['clip', 'mergedPartsSubdir'], type: 'text' },

  { id: 'checkpoint-enabled', path: ['clip', 'longTradeCheckpointEnabled'], type: 'checkbox' },
  { id: 'long-threshold', path: ['clip', 'longTradeThresholdSec'], type: 'number' },
  { id: 'snippet-entry', path: ['clip', 'checkpointEntrySnippetSec'], type: 'number' },
  { id: 'snippet-exit', path: ['clip', 'checkpointExitSnippetSec'], type: 'number' }
]

// Переключатель терминала — отдельно от FIELDS, потому что это не поле ввода,
// а группа кнопок; заодно от него зависит подсказка про путь к логам.
const TERMINALS = [
  {
    id: 'vataga',
    label: 'Vataga',
    dirHint: 'Пусто = %APPDATA%\\Vataga\\Vataga.terminal\\Logs'
  },
  {
    id: 'tigertrade',
    label: 'TigerTrade',
    dirHint: 'Пусто = %APPDATA%\\TigerTrade (файлы Data\\Logs\\WorkLog_*.log, включая подпапки профилей)'
  }
]

let terminalType = TERMINALS[0].id
const terminalButtons = new Map()
const terminalDirHintEl = document.getElementById('terminal-dir-hint')

function selectTerminal(id) {
  terminalType = TERMINALS.some((t) => t.id === id) ? id : TERMINALS[0].id
  for (const [candidate, button] of terminalButtons) {
    button.setAttribute('aria-pressed', String(candidate === terminalType))
  }
  terminalDirHintEl.textContent = TERMINALS.find((t) => t.id === terminalType).dirHint
}

const terminalContainer = document.querySelector('[data-role="terminal"]')
for (const terminal of TERMINALS) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'option'
  button.textContent = terminal.label
  button.addEventListener('click', () => selectTerminal(terminal.id))
  terminalButtons.set(terminal.id, button)
  terminalContainer.appendChild(button)
}
selectTerminal(terminalType)

// Пути в FIELDS бывают и вложенными (clip.cropPresets), поэтому идём по
// ним по шагам, а не обращаемся к двум уровням напрямую.
function readByPath(source, pathParts) {
  return pathParts.reduce((value, key) => (value == null ? undefined : value[key]), source)
}

function writeByPath(target, pathParts, value) {
  let node = target
  for (const key of pathParts.slice(0, -1)) {
    if (!node[key]) node[key] = {}
    node = node[key]
  }
  node[pathParts.at(-1)] = value
}

// Список сохранённых областей кадра. Правятся они в окне обрезки (там видно
// картинку), здесь только показываются и удаляются — вписывать координаты
// руками бессмысленно.
const presetListEl = document.querySelector('[data-role="preset-list"]')

// Держим их отдельно, чтобы вернуть в конфиг при сохранении: в FIELDS их нет,
// а без этого "Сохранить" затёрло бы всю настройку границ.
let loadedPresets = []

// Выбор «что вырезать сразу» строится из тех же сохранённых областей —
// выбирать тут больше не из чего.
function renderAutoCropChoices() {
  const select = document.getElementById('auto-crop-area')
  const previous = select.value
  select.innerHTML = ''

  const none = document.createElement('option')
  none.value = ''
  none.textContent = 'Не вырезать'
  select.appendChild(none)

  for (const preset of loadedPresets) {
    const option = document.createElement('option')
    option.value = preset.name
    option.textContent = preset.name
    select.appendChild(option)
  }

  // Выбранную область могли только что удалить — возвращаться не к чему.
  select.value = loadedPresets.some((item) => item.name === previous) ? previous : ''
}

function renderPresets(presets) {
  loadedPresets = Array.isArray(presets) ? presets : []
  renderAutoCropChoices()
  presetListEl.innerHTML = ''
  if (loadedPresets.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'Пока не настроено — нажми «Настроить области...»'
    presetListEl.appendChild(empty)
    return
  }

  for (const preset of loadedPresets) {
    const row = document.createElement('div')
    row.className = 'preset-row'

    const title = document.createElement('span')
    title.textContent = preset.name
    row.appendChild(title)

    const size = document.createElement('span')
    size.className = 'preset-size'
    size.textContent = `${preset.width}x${preset.height} из ${preset.sourceWidth}x${preset.sourceHeight}`
    row.appendChild(size)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'secondary'
    remove.textContent = 'Удалить'
    remove.addEventListener('click', async () => {
      remove.disabled = true
      try {
        renderPresets(await window.api.deleteCropPreset(preset.name))
      } catch (error) {
        remove.disabled = false
        statusEl.className = 'status error'
        statusEl.textContent = `Не удалось удалить: ${error.message || error}`
      }
    })
    row.appendChild(remove)

    presetListEl.appendChild(row)
  }
}

document.getElementById('open-crop').addEventListener('click', () => window.api.openCropWindow())
document.getElementById('open-help').addEventListener('click', () => window.api.openHelp())

function fillForm(config) {
  renderPresets(config.clip && config.clip.cropPresets)
  for (const field of FIELDS) {
    const el = document.getElementById(field.id)
    const value = readByPath(config, field.path)
    if (field.type === 'checkbox') el.checked = Boolean(value)
    else if (field.type === 'numberList') el.value = Array.isArray(value) ? value.join(', ') : ''
    else if (field.zeroIsEmpty) el.value = Number(value) > 0 ? value : ''
    else el.value = value ?? ''
  }
  selectTerminal(config.terminal?.type)
}

function collectForm() {
  const config = { obs: {}, terminal: { type: terminalType }, clip: {}, polling: {} }
  for (const field of FIELDS) {
    const el = document.getElementById(field.id)
    let value
    if (field.type === 'checkbox') value = el.checked
    else if (field.type === 'number') value = Number(el.value)
    // Строку со списком отдаём как есть: разбирает и чистит её config.js,
    // чтобы правила были в одном месте, а не продублированы в окне.
    else value = el.value
    writeByPath(config, field.path, value)
  }
  // Области кадра окно настроек не редактирует, но обязано вернуть их как есть
  config.clip.cropPresets = loadedPresets
  return config
}

for (const button of document.querySelectorAll('[data-pick-folder]')) {
  button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.pickFolder)
    const picked = await window.api.pickFolder(input.value)
    if (picked) input.value = picked
  })
}

window.api.getConfig().then(fillForm)

saveButton.addEventListener('click', async () => {
  saveButton.disabled = true
  statusEl.className = 'status busy'
  statusEl.textContent = 'Сохраняю и применяю...'
  try {
    const saved = await window.api.saveConfig(collectForm())
    fillForm(saved) // показываем то, что реально записалось после нормализации
    statusEl.className = 'status ok'
    statusEl.textContent = 'Сохранено, настройки применены.'
  } catch (error) {
    statusEl.className = 'status error'
    statusEl.textContent = `Не удалось сохранить: ${error.message || error}`
  } finally {
    saveButton.disabled = false
  }
})

closeButton.addEventListener('click', () => window.api.closeWindow())

// ── Версия и обновления ───────────────────────────────────────────────────

const INSTALL_KIND_LABEL = {
  installed: 'установленная',
  portable: 'переносимая',
  dev: 'сборка для разработки'
}

const versionEl = document.getElementById('app-version')
const updateStatusEl = document.getElementById('update-status')
const checkUpdatesButton = document.getElementById('check-updates')

window.api.getAppVersion().then(({ version, installKind }) => {
  const kind = INSTALL_KIND_LABEL[installKind] || installKind
  versionEl.textContent = `Установлена версия ${version} (${kind})`
})

function setUpdateStatus(text, kind) {
  updateStatusEl.className = kind ? `field-hint ${kind}` : 'field-hint'
  updateStatusEl.textContent = text
}

// Ответ на нажатую кнопку нужен всегда — в том числе "всё в порядке, у тебя
// последняя". Проверка при запуске в этом случае молчит, и это правильно, но
// здесь молчание читалось бы как поломка.
function describeUpdateResult(result) {
  switch (result.state) {
    case 'none':
      return { text: `У тебя последняя версия — ${result.current}.`, kind: 'ok' }
    case 'available':
      if (result.download === 'downloading') return { text: `Скачиваю версию ${result.version}...`, kind: '' }
      if (result.download === 'declined') return { text: `Вышла версия ${result.version}. Обновиться можно в любой момент этой же кнопкой.`, kind: 'ok' }
      return { text: `Вышла версия ${result.version}. Что делать дальше — в открывшемся окне.`, kind: 'ok' }
    case 'dev':
      return { text: 'Это сборка для разработки: обновляться ей не из чего.', kind: '' }
    case 'busy':
      return { text: 'Проверка уже идёт.', kind: '' }
    case 'error':
      // Отдельно про "выпусков нет вовсе": по английскому тексту от GitHub
      // непонятно, что это не поломка, а просто пустая страница выпусков.
      if (/No published versions/i.test(result.error || '')) {
        return { text: 'На GitHub пока нет ни одного выпуска — сравнивать не с чем.', kind: '' }
      }
      return { text: `Не удалось проверить: ${result.error}`, kind: 'error' }
    default:
      return { text: `Непонятный ответ проверки: ${result.state}`, kind: 'error' }
  }
}

// Пока идёт загрузка, итог проверки перебивается ходом загрузки: скачать надо
// больше ста мегабайт, и это единственное, что сейчас происходит.
window.api.onUpdateProgress((progress) => {
  if (progress.stage === 'downloading') {
    const total = progress.total || 0
    const done = progress.transferred || 0
    const size = total ? ` — ${(done / 1024 / 1024).toFixed(0)} из ${(total / 1024 / 1024).toFixed(0)} МБ` : ''
    setUpdateStatus(`Скачиваю обновление: ${progress.percent || 0}%${size}`, '')
    return
  }
  if (progress.stage === 'downloaded') {
    setUpdateStatus(`Версия ${progress.version} загружена — установится при перезапуске программы.`, 'ok')
    return
  }
  if (progress.stage === 'error') {
    setUpdateStatus(`Не удалось скачать обновление: ${progress.message}`, 'error')
  }
})

checkUpdatesButton.addEventListener('click', async () => {
  checkUpdatesButton.disabled = true
  setUpdateStatus('Спрашиваю GitHub...', '')
  try {
    const result = await window.api.checkUpdates()
    const { text, kind } = describeUpdateResult(result)
    setUpdateStatus(text, kind)
  } catch (error) {
    setUpdateStatus(`Не удалось проверить: ${error.message || error}`, 'error')
  } finally {
    checkUpdatesButton.disabled = false
  }
})
