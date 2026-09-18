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
// Проверок две, и ведут они себя по-разному. Та, что при запуске, молчит,
// если новой версии нет: окно "у вас последняя версия" при каждом старте —
// раздражение без пользы. Та, что по кнопке в настройках, отвечает всегда:
// человек нажал и ждёт ответа, и молчание тут читается как поломка.

const RELEASES_URL = 'https://github.com/ikelele/TradeCut/releases/latest'
// Даём приложению спокойно подняться: подключиться к OBS, встать в трей.
// Обновление никуда не убежит, а дёргать сеть в первую секунду ни к чему.
const CHECK_DELAY_MS = 8000
// В системном окне простыня всё равно не поместится.
const MAX_NOTES_LENGTH = 700

function createUpdater({ installKind, log, onEvent }) {
  let timer = null
  let updater = null
  let checking = false

  // Ход загрузки уходит наружу событиями: окно настроек показывает их у себя,
  // если открыто. Скачать надо больше ста мегабайт, и молчание всё это время
  // неотличимо от «нажал, и ничего не произошло».
  const emit = (event) => {
    if (onEvent) onEvent(event)
  }

  // Настройки и подписки ставим ОДИН раз на всё время работы.
  //
  // Раньше это делалось внутри каждой проверки, и пока проверка была одна —
  // при запуске — разницы не было. С кнопкой в настройках её жмут сколько
  // угодно раз, и каждый повесил бы ещё один обработчик на то же событие:
  // одно скачанное обновление — три одинаковых окна подряд.
  function getUpdater() {
    if (updater) return updater

    updater = require('electron-updater').autoUpdater
    updater.autoDownload = false // сначала спрашиваем, потом качаем
    updater.autoInstallOnAppQuit = true
    updater.logger = { info: log, warn: log, error: log, debug: () => {} }
    updater.on('update-downloaded', onUpdateDownloaded)
    updater.on('download-progress', (progress) => {
      emit({
        stage: 'downloading',
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total
      })
    })
    return updater
  }

  async function onUpdateDownloaded(info) {
    log(`Версия ${info.version} загружена`)
    emit({ stage: 'downloaded', version: info.version })
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: 'Обновление готово',
      message: `TradeCut ${info.version} загружен`,
      detail: 'Обновление установится при следующем запуске. Перезапустить сейчас?',
      buttons: ['Перезапустить', 'Позже'],
      defaultId: 0,
      cancelId: 1
    })
    if (answer.response === 0) updater.quitAndInstall()
  }

  // Описание выпуска приходит либо строкой, либо списком — приводим к тексту.
  function releaseNotesText(updateInfo) {
    const notes = updateInfo && updateInfo.releaseNotes
    if (!notes) return ''
    const text = Array.isArray(notes)
      ? notes.map((item) => (item && item.note) || '').join('\n')
      : String(notes)
    const plain = text.replace(/<[^>]+>/g, '').trim()
    return plain.length > MAX_NOTES_LENGTH ? plain.slice(0, MAX_NOTES_LENGTH) + '...' : plain
  }

  // Переносимой версии обновлять себя нечем: подменить работающий exe нельзя.
  // Зато можно вовремя сказать, что вышло новое.
  async function offerPortable(updateInfo, version) {
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: 'Вышла новая версия',
      message: `TradeCut ${version}`,
      detail: releaseNotesText(updateInfo)
        || 'Доступна новая версия. Переносимая версия не обновляется сама — скачай новый файл и замени им текущий.',
      buttons: ['Открыть страницу загрузки', 'Позже'],
      defaultId: 0,
      cancelId: 1
    })
    if (answer.response === 0) shell.openExternal(RELEASES_URL)
  }

  // Установленная версия умеет всё сама: скачали в фоне, поставили при выходе.
  async function offerInstalled(updateInfo, version) {
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: 'Вышла новая версия',
      message: `TradeCut ${version}`,
      detail: releaseNotesText(updateInfo) || 'Скачать и установить обновление?',
      buttons: ['Обновить', 'Позже'],
      defaultId: 0,
      cancelId: 1
    })
    if (answer.response !== 0) return 'declined'

    log(`Скачиваю обновление ${version}...`)
    emit({ stage: 'downloading', percent: 0, transferred: 0, total: 0 })
    // Загрузку НЕ ждём. Это больше ста мегабайт и минуты времени, а вызов
    // пришёл из окна настроек: дождись мы её здесь — кнопка «Проверить
    // обновления» всё это время оставалась бы нажатой и мёртвой. Ход загрузки
    // видно по событиям, а конец покажет своё окно.
    getUpdater().downloadUpdate().catch((error) => {
      log(`Не удалось скачать обновление: ${error.message}`)
      emit({ stage: 'error', message: error.message })
    })
    return 'downloading'
  }

  // Возвращает то, что можно показать человеку: одна из причин, по которой
  // проверка закончилась. Само по себе ничего не рисует — окна с предложением
  // обновиться показываются по ходу, а окно настроек пишет итог у себя.
  async function check() {
    const current = app.getVersion()

    // В разработке проверять нечего: версия из package.json, выпусков нет.
    if (installKind === 'dev') return { state: 'dev', current }
    if (checking) return { state: 'busy', current }

    checking = true
    try {
      const result = await getUpdater().checkForUpdates()
      const version = result && result.updateInfo && result.updateInfo.version

      if (!version || version === current) {
        log(`Обновлений нет, текущая версия ${current}`)
        return { state: 'none', current }
      }

      log(`Вышла версия ${version} (сейчас ${current})`)
      if (installKind === 'portable') {
        await offerPortable(result.updateInfo, version)
        return { state: 'available', current, version, download: 'portable' }
      }
      const download = await offerInstalled(result.updateInfo, version)
      return { state: 'available', current, version, download }
    } catch (error) {
      log(`Не удалось проверить обновления: ${error.message}`)
      return { state: 'error', current, error: error.message }
    } finally {
      checking = false
    }
  }

  return {
    check,

    start() {
      if (installKind === 'dev') return

      timer = setTimeout(() => {
        // Проверка при запуске молчит обо всём, кроме найденного обновления:
        // его окно покажет сама check(). Нет сети, нет выпусков, GitHub
        // недоступен — это не повод беспокоить человека при каждом старте.
        check().catch((error) => log(`Проверка обновлений сорвалась: ${error.message}`))
      }, CHECK_DELAY_MS)
    },

    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

module.exports = { createUpdater, RELEASES_URL }
