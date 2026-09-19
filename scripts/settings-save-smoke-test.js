// Проверка сквозного пути "окно настроек -> config.json -> применение":
// имитируем IPC-сохранение так же, как это делает main.js, включая
// переключение терминала. Работает во временной папке — рабочий config.json
// пользователя не трогается.
// Запуск: node scripts/settings-save-smoke-test.js
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-settings-'))

const { setAppBaseDir } = require('../src/appPaths')
setAppBaseDir(tmpDir)

// Старый конфиг: секция vataga, никакого terminal — как у тех, кто обновился
fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
  obs: { url: 'ws://10.0.0.5:4455', password: 'secret' },
  vataga: { logsDirOverride: 'D:\\CustomVatagaLogs' },
  clip: { outputDir: './clips' }
}, null, 2), 'utf8')

const { loadConfig, saveConfig, keepCropPresets, wasConfigJustCreated } = require('../src/config')

const config = loadConfig()
// Обратная сторона первого запуска: config.json уже лежал на диске, значит
// помощник настройки открываться не должен. Тем, кто обновляется со старой
// версии, он не покажется именно поэтому.
assert.strictEqual(wasConfigJustCreated(), false, 'готовый config.json не должен считаться первым запуском')
// Терминал по умолчанию — TigerTrade, но у этого конфига есть старая секция
// vataga: значит человек торговал на Vataga, и обновление не должно молча
// переключать его на другой терминал.
assert.strictEqual(config.terminal.type, 'vataga', 'старый конфиг с секцией vataga должен остаться на Vataga')
assert.strictEqual(config.terminal.logsDirOverride, 'D:\\CustomVatagaLogs', 'старый путь должен мигрировать в terminal')
assert.strictEqual(config.vataga, undefined, 'старая секция vataga больше не должна возвращаться')
console.log('[OK] миграция старого config.json')

// Ровно то, что делает main.js в обработчике config:save
const incoming = JSON.parse(JSON.stringify(config))
incoming.terminal = { type: 'tigertrade', logsDirOverride: '' }
incoming.clip.recentTradesHistorySize = 15
incoming.clip.stakanCount = 8
incoming.clip.keepMergedParts = true

const saved = saveConfig(incoming)
Object.assign(config.obs, saved.obs)
Object.assign(config.terminal, saved.terminal)
Object.assign(config.clip, saved.clip)
Object.assign(config.polling, saved.polling)

assert.strictEqual(config.terminal.type, 'tigertrade', 'переключение терминала должно попасть в живой конфиг')
assert.strictEqual(config.clip.recentTradesHistorySize, 15)
assert.strictEqual(config.clip.stakanCount, 8, 'количество частей кадра должно применяться')
assert.strictEqual(config.clip.keepMergedParts, 1, 'галка "оставлять отдельные клипы серии" должна применяться')
assert.strictEqual(config.obs.password, 'secret', 'пароль не должен потеряться при сохранении')
console.log('[OK] сохранение настроек и применение к живому объекту конфига')

// Живой объект — тот же, что читает createApp: проверяем, что watcher увидит tigertrade
const { getAdapter } = require('../src/terminalLog')
assert.strictEqual(getAdapter(config.terminal.type).displayName, 'TigerTrade')
console.log('[OK] watcher получит адаптер TigerTrade')

// Пресеты обрезки сохраняются не из окна настроек, а из разметки областей — но через тот
// же saveConfig, поэтому проверяем, что они переживают запись и что мусорные
// записи до файла не доходят.
const withPresets = saveConfig({
  ...config,
  clip: {
    ...config.clip,
    cropPresets: [
      { name: 'Левый стакан', x: 0, y: 0, width: 1146, height: 1440, sourceWidth: 3440, sourceHeight: 1440 },
      { name: 'Плохой', x: 0, y: 0, width: 0, height: 100, sourceWidth: 3440, sourceHeight: 1440 },
      { name: '', x: 0, y: 0, width: 100, height: 100, sourceWidth: 3440, sourceHeight: 1440 }
    ]
  }
})
assert.strictEqual(withPresets.clip.cropPresets.length, 1, 'пресеты без имени и с нулевым размером сохраняться не должны')
assert.deepStrictEqual(withPresets.clip.cropPresets[0], {
  name: 'Левый стакан', x: 0, y: 0, width: 1146, height: 1440, sourceWidth: 3440, sourceHeight: 1440
})
assert.deepStrictEqual(loadConfig().clip.cropPresets, withPresets.clip.cropPresets, 'пресеты должны читаться обратно как есть')
console.log('[OK] пресеты обрезки сохраняются и читаются')

// Окно настроек про области кадра не знает и присылает конфиг без них. Раньше
// это молча стирало всю настройку границ — проверяем, что переживают.
const afterPlainSave = saveConfig({
  ...withPresets,
  clip: Object.fromEntries(Object.entries(withPresets.clip).filter(([key]) => key !== 'cropPresets'))
})
assert.strictEqual(afterPlainSave.clip.cropPresets.length, 1, 'сохранение без списка областей не должно их стирать')
assert.strictEqual(afterPlainSave.clip.cropPresets[0].name, 'Левый стакан')

// А явный пустой список — это осознанное "удалить всё"
const afterClear = saveConfig({ ...afterPlainSave, clip: { ...afterPlainSave.clip, cropPresets: [] } })
assert.deepStrictEqual(afterClear.clip.cropPresets, [], 'явный пустой список должен очищать области')
console.log('[OK] области кадра переживают сохранение настроек')

// А вот это и подвело стороннего пользователя. Явный пустой список выше —
// законное "удалить всё", и на своём уровне saveConfig прав. Беда была этажом
// выше: окно настроек присылало такой список из копии, снятой ДО разметки
// областей. Двенадцать областей пропали через семь секунд после сохранения.
// Теперь присланный список не принимается вовсе.
const stale = { ...withPresets, clip: { ...withPresets.clip, cropPresets: [] } }
const live = [
  { name: 'Стакан 1', x: 0, y: 0, width: 286, height: 1440, sourceWidth: 3440, sourceHeight: 1440 },
  { name: 'Стакан 2', x: 286, y: 0, width: 286, height: 1440, sourceWidth: 3440, sourceHeight: 1440 }
]
const guarded = keepCropPresets(stale, live)
assert.strictEqual(guarded.clip.cropPresets.length, 2,
  'устаревшая копия из окна не должна стирать области')
assert.strictEqual(guarded.clip.stakanCount, withPresets.clip.stakanCount,
  'остальные настройки из окна должны доходить как есть')
const savedGuarded = saveConfig(guarded)
assert.strictEqual(savedGuarded.clip.cropPresets.length, 2)
console.log('[OK] окно настроек не может стереть области кадра')

const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'))
assert.strictEqual(onDisk.terminal.type, 'tigertrade')
assert.strictEqual(onDisk.vataga, undefined, 'в файл не должна возвращаться устаревшая секция')
console.log('[OK] config.json на диске содержит новую секцию terminal')

fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('\nСохранение настроек работает.')
