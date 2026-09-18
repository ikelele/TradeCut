const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const { setAppBaseDir, setMediaDir } = require('../src/appPaths')
const { setFfmpegTools } = require('../src/ffmpegTools')

// Программа существует в трёх видах, и файлы в них живут по-разному.
//
//   переносимая — всё рядом с exe: скопировал папку на другую машину и унёс
//                 настройки с собой, в этом её смысл;
//   установленная — настройки в профиле, видео в "Видео". Папку установки
//                 перезаписывает обновление, поэтому держать там настройки
//                 нельзя: они пропадали бы при каждой новой версии;
//   разработка  — корень проекта, чтобы ничего не разбредалось по системе.
function getInstallKind() {
  if (!app.isPackaged) return 'dev'
  // Эту переменную выставляет сама переносимая сборка. Ориентироваться на
  // process.execPath нельзя: она распаковывает себя во временную папку, и путь
  // указывал бы туда, а не на файл, который пользователь реально запустил.
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'portable'
  return 'installed'
}

function resolveAppBaseDir() {
  switch (getInstallKind()) {
    case 'dev': return process.cwd()
    case 'portable': return process.env.PORTABLE_EXECUTABLE_DIR
    default: return app.getPath('userData')
  }
}

function resolveMediaDir() {
  switch (getInstallKind()) {
    case 'dev': return process.cwd()
    case 'portable': return process.env.PORTABLE_EXECUTABLE_DIR
    // Видео — не настройки: гигабайты клипов в профиле пользователя не место.
    default: return path.join(app.getPath('videos'), 'TradeCut')
  }
}

// Настройки из папки рядом с exe подхватываются и установленной версией, если
// своих ещё нет. Это путь для тех, кто переходит с переносимой версии: положил
// рядом с установленной программой старый config.json — и все настройки,
// включая области кадра, остались.
function adoptConfigFromExeFolder(baseDir, log) {
  const target = path.join(baseDir, 'config.json')
  if (fs.existsSync(target)) return

  const nearExe = path.join(path.dirname(app.getPath('exe')), 'config.json')
  if (!fs.existsSync(nearExe)) return

  try {
    fs.mkdirSync(baseDir, { recursive: true })
    fs.copyFileSync(nearExe, target)
    log(`Настройки перенесены из папки программы: ${nearExe}`)
  } catch (error) {
    log(`Не удалось перенести настройки из ${nearExe}: ${error.message}`)
  }
}

function initAppPaths(log = () => {}) {
  const baseDir = resolveAppBaseDir()
  if (getInstallKind() === 'installed') adoptConfigFromExeFolder(baseDir, log)

  setAppBaseDir(baseDir)
  setMediaDir(resolveMediaDir())
  initFfmpegTools()
  return baseDir
}

// ffmpeg и ffprobe едут вместе с программой (см. extraResources в
// package.json) — чтобы после скачивания ничего не приходилось доустанавливать.
// В режиме разработки файлов сборки нет, и модуль сам возьмёт их из
// node_modules: так тесты гоняют ровно то, что уедет пользователю.
function initFfmpegTools() {
  if (!app.isPackaged) return
  const toolsDir = path.join(process.resourcesPath, 'tools')
  setFfmpegTools({
    ffmpeg: path.join(toolsDir, 'ffmpeg.exe'),
    ffprobe: path.join(toolsDir, 'ffprobe.exe')
  })
}

// Иконки и прочие ассеты. В собранном приложении папка assets кладётся в
// resources (см. extraResources в package.json), в dev — лежит в проекте.
function getAssetPath(fileName) {
  if (app.isPackaged) return path.join(process.resourcesPath, 'assets', fileName)
  return path.join(__dirname, '..', 'assets', fileName)
}

module.exports = { initAppPaths, resolveAppBaseDir, getInstallKind, getAssetPath }
