const path = require('path')

// Куда программа кладёт свои файлы.
//
// Мест три, и они намеренно разные:
//
//   базовая папка   — где лежит config.json. У переносимой версии это папка
//                     рядом с exe (в этом её смысл: скопировал папку — унёс
//                     настройки с собой). У установленной — папка профиля:
//                     папка установки перезаписывается при обновлении, и
//                     настройки из неё пропали бы.
//   папка для видео — куда по умолчанию складываются клипы. У установленной
//                     версии это "Видео", а не папка настроек: складывать
//                     гигабайты видео в профиль нельзя.
//   папка данных    — журнал и временные файлы. Всегда в локальном профиле,
//                     независимо от способа установки: при автозапуске из
//                     реестра текущая папка непредсказуема.
//
// Значения выставляет электронный слой при старте — только он знает, как
// запущено приложение. Сам модуль остаётся чистым Node: его используют и
// тесты, и фоновые модули.

let appBaseDirOverride = null
let mediaDirOverride = null

function setAppBaseDir(dir) {
  appBaseDirOverride = dir || null
}

function getAppBaseDir() {
  if (appBaseDirOverride) return appBaseDirOverride
  return process.cwd()
}

function setMediaDir(dir) {
  mediaDirOverride = dir || null
}

// От неё считаются относительные пути из настроек ("./clips").
function getMediaDir() {
  return mediaDirOverride || getAppBaseDir()
}

// Превращает настройку в настоящий путь. Абсолютный путь остаётся как есть —
// пользователь мог указать свою папку хоть на другом диске.
function resolveMediaPath(configuredPath) {
  return path.resolve(getMediaDir(), String(configuredPath || '.'))
}

function getUserDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local')
  return path.join(base, 'tradecut')
}

module.exports = {
  getAppBaseDir,
  setAppBaseDir,
  setMediaDir,
  getMediaDir,
  resolveMediaPath,
  getUserDataDir
}
