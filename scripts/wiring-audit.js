// Сверка "проводки" приложения — того, что никаким запуском окна не
// проверяется, но ломается молча.
//
// Окна общаются с основным процессом через preload, и любое расхождение здесь
// выглядит как "кнопка не работает": в консоли рендерера будет ошибка, которую
// никто не увидит. Так же молча ломается обращение к элементу, которого нет в
// разметке, и настройка, которую окно шлёт, а config.js не знает.
//
// Запуск: node scripts/wiring-audit.js

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const RENDERER = path.join(ROOT, 'electron', 'renderer')

const problems = []
const notes = []

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
const rendererFiles = fs.readdirSync(RENDERER)
const rendererJs = rendererFiles.filter((f) => f.endsWith('.js'))
const rendererHtml = rendererFiles.filter((f) => f.endsWith('.html'))

const matchAll = (text, re) => [...text.matchAll(re)].map((m) => m[1])
const unique = (list) => [...new Set(list)]

// ── 1. window.api.* из окон должен существовать в preload ──────────────────
const preload = read('electron', 'preload.js')
const exposed = new Set(matchAll(preload, /^\s{2}([\w]+):/gm))

for (const file of rendererJs) {
  const source = read('electron', 'renderer', file)
  for (const used of unique(matchAll(source, /window\.api\.(\w+)/g))) {
    if (!exposed.has(used)) problems.push(`[preload] ${file} зовёт window.api.${used}, которого нет в preload.js`)
  }
}
notes.push(`preload отдаёт ${exposed.size} вызовов, все используемые окнами на месте`)

// ── 2. Каналы из preload должны иметь обработчик в main ────────────────────
const main = read('electron', 'main.js')
const handled = new Set([
  ...matchAll(main, /ipcMain\.handle\('([\w:-]+)'/g),
  ...matchAll(main, /ipcMain\.on\('([\w:-]+)'/g)
])
const requested = unique([
  ...matchAll(preload, /ipcRenderer\.invoke\('([\w:-]+)'/g),
  ...matchAll(preload, /ipcRenderer\.send\('([\w:-]+)'/g)
])

for (const channel of requested) {
  if (!handled.has(channel)) problems.push(`[ipc] канал "${channel}" запрашивается из preload, но в main.js не обработан`)
}
// Обратная сторона: обработчик есть, а звать его некому — мёртвый код
const listened = unique([...matchAll(preload, /ipcRenderer\.on\('([\w:-]+)'/g)])
for (const channel of handled) {
  if (!requested.includes(channel) && !listened.includes(channel)) {
    problems.push(`[ipc] в main.js обработан канал "${channel}", который никто не зовёт`)
  }
}
notes.push(`каналов IPC: ${requested.length}, все обработаны`)

// ── 3. getElementById из окна должен существовать в его разметке ───────────
const pageOfScript = { 'settings.js': 'settings.html', 'crop.js': 'crop.html', 'trades.js': 'trades.html', 'help.js': 'help.html' }
for (const [script, page] of Object.entries(pageOfScript)) {
  if (!rendererJs.includes(script) || !rendererHtml.includes(page)) continue
  const source = read('electron', 'renderer', script)
  const html = read('electron', 'renderer', page)
  // Общая панель обрезки строит свою разметку сама — её id ищем и в ней
  const extra = page === 'crop.html' || page === 'trades.html'
    ? read('electron', 'renderer', 'cropForm.js') + read('electron', 'renderer', 'cropPreview.js')
    : ''
  const available = new Set([...matchAll(html + extra, /id="([\w-]+)"/g)])
  for (const id of unique(matchAll(source, /getElementById\('([\w-]+)'\)/g))) {
    if (!available.has(id)) problems.push(`[разметка] ${script} ищет #${id}, которого нет в ${page}`)
  }
}

// Поля настроек из FIELDS — там id перечислены отдельным списком
const settingsJs = read('electron', 'renderer', 'settings.js')
const settingsHtml = read('electron', 'renderer', 'settings.html')
const settingsIds = new Set([...matchAll(settingsHtml, /id="([\w-]+)"/g)])
const fieldIds = unique(matchAll(settingsJs, /\{ id: '([\w-]+)'/g))
for (const id of fieldIds) {
  if (!settingsIds.has(id)) problems.push(`[настройки] поле #${id} есть в FIELDS, но не в разметке`)
}
notes.push(`полей в окне настроек: ${fieldIds.length}, все есть в разметке`)

// ── 4. Каждый ключ конфига должен нормализоваться при сохранении ───────────
const { DEFAULT_CONFIG } = require(path.join(ROOT, 'src', 'config.js'))
const configSource = read('src', 'config.js')
const normalizedBlock = configSource.slice(configSource.indexOf('const normalized = {'))

for (const [section, values] of Object.entries(DEFAULT_CONFIG)) {
  for (const key of Object.keys(values)) {
    if (!new RegExp('\\b' + key + '\\s*:').test(normalizedBlock)) {
      problems.push(`[конфиг] ключ ${section}.${key} есть в умолчаниях, но не нормализуется в saveConfig — при сохранении настроек он потеряется`)
    }
  }
}

// И каждый ключ должен быть либо в окне настроек, либо осознанно не быть
const NOT_IN_SETTINGS = new Set(['cropPresets']) // правится в окне обрезки
const settingsPaths = new Set(matchAll(settingsJs, /path: \['clip', '(\w+)'\]/g))
for (const key of Object.keys(DEFAULT_CONFIG.clip)) {
  if (!settingsPaths.has(key) && !NOT_IN_SETTINGS.has(key)) {
    problems.push(`[конфиг] clip.${key} нельзя изменить из окна настроек`)
  }
}

// ── 5. Ссылок на удалённые модули быть не должно ───────────────────────────
const sourceFiles = []
for (const dir of ['src', 'electron', 'electron/renderer', 'scripts', 'test']) {
  const full = path.join(ROOT, dir)
  for (const file of fs.readdirSync(full)) {
    if (file.endsWith('.js')) sourceFiles.push(path.join(full, file))
  }
}
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8')
  for (const required of unique(matchAll(source, /require\('(\.[^']+)'\)/g))) {
    const target = path.resolve(path.dirname(file), required)
    if (!fs.existsSync(target) && !fs.existsSync(target + '.js')) {
      problems.push(`[модули] ${path.relative(ROOT, file)} подключает ${required}, которого нет`)
    }
  }
}
notes.push(`проверено файлов: ${sourceFiles.length}, все подключения на месте`)

// ── 6. Скрипты, подключённые в разметке, должны существовать ───────────────
for (const page of rendererHtml) {
  const html = read('electron', 'renderer', page)
  for (const src of matchAll(html, /<script src="([\w.-]+)"><\/script>/g)) {
    if (!rendererFiles.includes(src)) problems.push(`[разметка] ${page} подключает ${src}, которого нет`)
  }
}

for (const note of notes) console.log('OK: ' + note)
if (problems.length > 0) {
  console.log('\nНАЙДЕНО:')
  for (const problem of problems) console.log('  - ' + problem)
  process.exit(1)
}
console.log('\nПроводка приложения в порядке.')
