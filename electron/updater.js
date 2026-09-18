const { app, dialog, shell } = require('electron')

// Обновления.
//
// Программа существует в двух видах, и обновляются они по-разному:
//
//   установленная — умеет обновиться сама: скачивает новую версию в фоне и
//                   ставит её при выходе. Для этого и нужен установщик;
//   переносимая   — заменить работающий exe сама по себе не может, поэтому
//                   просто сообщает о новой версии и открывает страницу
//                   загрузки. Тихо подменять файл, который человек положил
//                   куда-то сам, было бы неправильно.
//
// Проверка идёт один раз при запуске и молчит, если новой версии нет: окно
// "у вас последняя версия" при каждом старте — это раздражение без пользы.

const RELEASES_URL = 'https://github.com/ikelele/TradeCut/releases/latest'
// Даём приложению спокойно подняться: подключиться к OBS, встать в трей.
// Обновление никуда не убежит, а дёргать сеть в первую секунду ни к чему.
const CHECK_DELAY_MS = 8000

function createUpdater({ installKind, log, onIssue }) {
  let timer = null

  // Переносимой версии обновлять себя нечем: подменить работающий exe нельзя.
  // Зато можно вовремя сказать, что вышло новое.
  async function checkPortable() {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = false
    autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} }

    const result = await autoUpdater.checkForUpdates()
    const version = result && result.updateInfo && result.updateInfo.version
    if (!version || version === app.getVersion()) {
      log(`Обновлений нет, текущая версия ${app.getVersion()}`)
      return
    }

    log(`Вышла версия ${version} (сейчас ${app.getVersion()})`)
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: 'Вышла новая версия',
      message: `TradeCut ${version}`,
      detail: releaseNotesText(result.updateInfo)
        || 'Доступна новая версия. Переносимая версия не обновляется сама — скачай новый файл и замени им текущий.',
      buttons: ['Открыть страницу загрузки', 'Позже'],
      defaultId: 0,
      cancelId: 1
    })
    if (answer.response === 0) shell.openExternal(RELEASES_URL)
  }

  // Установленная версия умеет всё сама: скачали в фоне, поставили при выходе.
  async function checkInstalled() {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = false // сначала спрашиваем, потом качаем
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} }

    autoUpdater.on('update-downloaded', async (info) => {
      log(`Версия ${info.version} загружена`)
      const answer = await dialog.showMessageBox({
        type: 'info',
        title: 'Обновление готово',
        message: `TradeCut ${info.version} загружен`,
        detail: 'Обновление установится при следующем запуске. Перезапустить сейчас?',
        buttons: ['Перезапустить', 'Позже'],
        defaultId: 0,
        cancelId: 1
      })
      if (answer.response === 0) autoUpdater.quitAndInstall()
    })

    const result = await autoUpdater.checkForUpdates()
    const version = result && result.updateInfo && result.updateInfo.version
    if (!version || version === app.getVersion()) {
      log(`Обновлений нет, текущая версия ${app.getVersion()}`)
      return
    }

    log(`Вышла версия ${version} (сейчас ${app.getVersion()})`)
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: 'Вышла новая версия',
      message: `TradeCut ${version}`,
      detail: releaseNotesText(result.updateInfo) || 'Скачать и установить обновление?',
      buttons: ['Обновить', 'Позже'],
      defaultId: 0,
      cancelId: 1
    })
    if (answer.response === 0) {
      log('Скачиваю обновление...')
      await autoUpdater.downloadUpdate()
    }
  }

  // Описание релиза приходит либо строкой, либо списком — приводим к тексту и
  // подрезаем: в системном окне простыня всё равно не поместится.
  function releaseNotesText(updateInfo) {
    const notes = updateInfo && updateInfo.releaseNotes
    if (!notes) return ''
    const text = Array.isArray(notes)
      ? notes.map((item) => (item && item.note) || '').join('\n')
      : String(notes)
    const plain = text.replace(/<[^>]+>/g, '').trim()
    return plain.length > 700 ? plain.slice(0, 700) + '...' : plain
  }

  return {
    start() {
      // В разработке проверять нечего: версия из package.json, релизов нет.
      if (installKind === 'dev') return

      timer = setTimeout(() => {
        const check = installKind === 'portable' ? checkPortable : checkInstalled
        check().catch((error) => {
          // Нет сети, нет релизов, GitHub недоступен — это не повод беспокоить
          // человека всплывающим окном. Пишем в журнал и живём дальше.
          log(`Не удалось проверить обновления: ${error.message}`)
          if (onIssue && /ENOTFOUND|ETIMEDOUT/.test(String(error.message))) return
        })
      }, CHECK_DELAY_MS)
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

module.exports = { createUpdater, RELEASES_URL }
