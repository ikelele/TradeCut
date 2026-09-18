// Признак первого запуска, по которому открывается помощник настройки.
//
// Проверять его нужно в отдельном процессе: CONFIG_PATH вычисляется один раз
// при загрузке src/config.js, поэтому setAppBaseDir обязан быть вызван ДО
// require этого модуля. Обратный случай (конфиг уже есть -> помощник не
// открывается) проверяется в settings-save-smoke-test.js, где файл создаётся
// заранее.
// Запуск: node scripts/first-run-smoke-test.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-first-run-'))

const { setAppBaseDir } = require('../src/appPaths')
setAppBaseDir(tmpDir)

const { loadConfig, wasConfigJustCreated, CONFIG_PATH } = require('../src/config')

assert.ok(CONFIG_PATH.startsWith(tmpDir), 'тест обязан работать во временной папке, а не в проекте')
assert.strictEqual(wasConfigJustCreated(), false, 'до загрузки конфига признак первого запуска взяться неоткуда')

const config = loadConfig()
assert.strictEqual(wasConfigJustCreated(), true, 'config.json создан этим запуском — помощник должен открыться')
assert.ok(fs.existsSync(CONFIG_PATH), 'config.json должен появиться на диске')
assert.strictEqual(config.obs.password, '', 'на первом запуске пароль OBS пустой — за ним и идёт человек в помощника')
console.log('[OK] первый запуск: config.json создан, помощник настройки откроется')

// Повторная загрузка в том же процессе ничего не меняет: признак относится к
// запуску целиком, а не к отдельному вызову loadConfig.
loadConfig()
assert.strictEqual(wasConfigJustCreated(), true, 'признак не должен сбрасываться повторной загрузкой')
console.log('[OK] повторная загрузка конфига признак не сбрасывает')

fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('\nПризнак первого запуска работает.')
