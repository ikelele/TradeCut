const { app } = require('electron')

// Electron сам пишет в тот же HKCU\...\Run, что раньше делали вручную через
// reg.exe — но корректно разбирается с кавычками, поэтому внешний процесс
// здесь больше не нужен.
//
// ВАЖНО про portable-сборку: она распаковывает себя во ВРЕМЕННУЮ папку и
// запускает уже оттуда, поэтому process.execPath (который Electron берёт по
// умолчанию) указывает на копию в %TEMP%, а не на тот .exe, который запустил
// пользователь. Такая запись в автозапуске либо перестанет работать после
// очистки temp, либо будет поднимать устаревшую копию рядом с текущей — а
// два экземпляра приложения дают лишнее окно вместо тихого старта в трее.
// Настоящий путь к запущенному файлу electron-builder кладёт в
// PORTABLE_EXECUTABLE_FILE — его и прописываем.
function getLauncherPath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
}

// В dev-режиме (npm start) включать автозапуск бессмысленно: в реестр попал бы
// путь к electron.exe из node_modules, а не к приложению.
function isAvailable() {
  return app.isPackaged
}

function isEnabled() {
  return app.getLoginItemSettings({ path: getLauncherPath() }).openAtLogin
}

// Запись автозапуска в реестре называется по идентификатору приложения, а он
// сменился вместе с именем программы. Старая запись указывает на файл со
// старым именем — то есть молча поднимала бы прежнюю сборку при каждом входе
// в систему. Переносим её один раз: если она была, включаем автозапуск под
// новым именем и убираем прежнюю.
const LEGACY_RUN_NAMES = ['com.tradetools.lite']
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

function migrateLegacyAutostart(log = () => {}) {
  if (process.platform !== 'win32') return
  const { execFileSync } = require('child_process')

  for (const name of LEGACY_RUN_NAMES) {
    let existed = false
    try {
      execFileSync('reg', ['query', RUN_KEY, '/v', name], { stdio: 'ignore' })
      existed = true
    } catch {
      continue // записи нет — переносить нечего
    }

    try {
      execFileSync('reg', ['delete', RUN_KEY, '/v', name, '/f'], { stdio: 'ignore' })
      if (existed && isAvailable()) setEnabled(true)
      log(`Автозапуск перенесён со старого имени "${name}" на новое`)
    } catch (error) {
      log(`Не удалось перенести автозапуск со старого имени "${name}": ${error.message}`)
    }
  }
}

// Переезд с переносимой версии на установленную.
//
// Запись автозапуска называется одинаково у обеих, но путь в ней — до того
// .exe, который её включил. После установки она продолжает указывать на старый
// переносимый файл: Windows поднимает прежнюю сборку, а когда её папку удалят
// — тихо перестаёт поднимать что-либо вообще. Заметить это можно только на
// следующем входе в систему, поэтому чиним сами.
//
// Трогаем только запись с нашим именем и только когда она уже есть: включать
// автозапуск за человека, который его не включал, мы не собираемся.
function repointAutostartIfMoved(runName, log = () => {}) {
  if (process.platform !== 'win32' || !isAvailable()) return
  // Путь совпадает с текущим — Electron ответит true, и делать нечего.
  if (isEnabled()) return

  const { execFileSync } = require('child_process')
  try {
    execFileSync('reg', ['query', RUN_KEY, '/v', runName], { stdio: 'ignore' })
  } catch {
    return // автозапуск не включён вовсе — так и оставляем
  }

  try {
    setEnabled(true)
    log(`Автозапуск указывал на другой файл программы — переписан на ${getLauncherPath()}`)
  } catch (error) {
    log(`Не удалось обновить путь в автозапуске: ${error.message}`)
  }
}

function setEnabled(enabled) {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: getLauncherPath(),
    // Без аргументов: приложение и так стартует прямо в трей, окон не открывает.
    args: []
  })
}

module.exports = { migrateLegacyAutostart, repointAutostartIfMoved, isAvailable, isEnabled, setEnabled, getLauncherPath }
