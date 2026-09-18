const path = require('path')
const fsp = require('fs').promises
const { createTerminalLogWatcher } = require('./terminalLog')
const { createObsClient } = require('./obsClient')
const { createClipFromReplay, createEntryCheckpoint, createMergedClipFromReplay, createManualReplayClip, probeDurationSeconds, checkFfmpegToolsAvailable } = require('./clipper')
const { createTradeBatcher } = require('./tradeBatcher')
const { cropClipToStakan } = require('./stakanCrop')
const { resolveMediaPath, getUserDataDir } = require('./appPaths')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Удаляет исходный файл реплея OBS (весь буфер, из которого уже вырезан
// нужный клип) — он свою задачу выполнил, хранить его дальше незачем. Не
// бросает исключение при неудаче (например, файл ещё чем-то занят) — это не
// должно ронять уже успешно завершённую обработку сделки.
async function deleteSourceReplayIfEnabled(replayPath, config, log) {
  if (!config.clip.deleteSourceReplays) return
  try {
    await fsp.unlink(replayPath)
    log(`Исходный реплей удалён: ${replayPath}`)
  } catch (error) {
    log(`Не удалось удалить исходный реплей ${replayPath}: ${error.message}`)
  }
}

// Подпись в истории трея и в окне "Все сделки". Длительность на конце нужна,
// чтобы сразу видеть, стоит ли ускорять клип при обрезке по стакану; в имя
// самого файла она не идёт. Для объединённого клипа это длина всей серии
// (вход в первую сделку -> выход из последней).
function buildHistoryLabel(trade) {
  const date = new Date(trade.exitTimeMs)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`

  const durationMs = trade.exitTimeMs - trade.entryTimeMs
  const duration = Number.isFinite(durationMs) && durationMs > 0
    ? ` ${Math.round(durationMs / 1000)}s`
    : ''

  return `${trade.symbol} ${trade.side} ${stamp}${duration}`
}

// Что делать с отдельными клипами сделок, вошедших в общий (комбо) клип.
//
// По умолчанию они УДАЛЯЮТСЯ: серия из пяти сделок иначе оставляет в папке
// дня шесть файлов об одном и том же, а смотреть обычно нужно общий.
// Галка "Оставлять отдельные клипы серии" в настройках это отключает — тогда
// они не удаляются, а переезжают в подпапку (clip.mergedPartsSubdir), чтобы
// в папке дня всё равно лежал один файл на серию.
//
// Всё здесь — уже после того, как общий клип готов, поэтому любая ошибка
// только логируется: терять готовый клип из-за неудачной уборки нельзя.
async function handleMergedParts({ batch, mergedClipPath, config, log, recentClips, onHistoryChanged }) {
  const keepParts = Boolean(config.clip.keepMergedParts)

  // Ссылки на удалённый/переехавший файл надо убрать из истории трея и окна,
  // иначе "вырезать область" из этой сделки потом не найдёт файл.
  const forgetClip = (clipPath) => {
    for (let i = recentClips.length - 1; i >= 0; i--) {
      if (recentClips[i].clipPath === clipPath) recentClips.splice(i, 1)
    }
  }
  const repointClip = (from, to) => {
    for (const entry of recentClips) {
      if (entry.clipPath === from) entry.clipPath = to
    }
  }

  if (!keepParts) {
    let removed = 0
    for (const trade of batch.trades) {
      if (!trade.clipPath) continue
      try {
        await fsp.unlink(trade.clipPath)
        forgetClip(trade.clipPath)
        trade.clipPath = null
        removed++
      } catch (error) {
        log(`Не удалось удалить отдельный клип ${trade.clipPath}: ${error.message}`)
      }
    }
    if (removed > 0) log(`Отдельные клипы серии удалены (${removed} шт.) — остался общий клип`)
    if (removed > 0 && onHistoryChanged) onHistoryChanged(recentClips.slice())
    return
  }

  const subdirName = config.clip.mergedPartsSubdir
  if (!subdirName) return // оставляем как есть, вперемешку с общим клипом

  const partsDir = path.join(path.dirname(mergedClipPath), subdirName)
  try {
    await fsp.mkdir(partsDir, { recursive: true })
  } catch (error) {
    log(`Не удалось создать папку ${partsDir}: ${error.message}`)
    return
  }

  let moved = 0
  for (const trade of batch.trades) {
    if (!trade.clipPath) continue
    const target = path.join(partsDir, path.basename(trade.clipPath))
    try {
      await fsp.rename(trade.clipPath, target)
      repointClip(trade.clipPath, target)
      trade.clipPath = target
      moved++
    } catch (error) {
      log(`Не удалось перенести ${trade.clipPath} в ${subdirName}: ${error.message}`)
    }
  }

  if (moved > 0) log(`Отдельные клипы (${moved} шт.) перенесены в подпапку "${subdirName}"`)
}

// createApp({config, log, onStatusChange, onClipReady, onStakanReady, onIssue, onReplayBufferStatusChange}) -> { start(), stop(), cropRecentClip() }
// onStatusChange(state): 'connecting' | 'connected' | 'disconnected' (см. obsClient.js)
// onClipReady(trade, clipPath, recentClips) — клип СДЕЛКИ нарезан; recentClips —
// вся история клипов сессии ({trade, clipPath, label}), новые в начале
// onStakanReady(outputPath, area) — ручная обрезка области готова
// onHistoryChanged(recentClips) — история изменилась не из-за новой сделки
// (например, отдельные клипы серии удалены и ссылаться на них больше нельзя)
// onReplayBufferStatusChange(isActive) — периодическая проверка (см. start())
// onIssue(message) — значимая ошибка
function createApp({ config, log, onStatusChange, onClipReady, onHistoryChanged, onStakanReady, onManualReplayReady, onIssue, onReplayBufferStatusChange }) {
  let obsClient = null
  let watcher = null
  let processingChain = Promise.resolve()
  let obsConnected = false
  let replayBufferCheckTimer = null
  const recentClips = []
  // positionId -> { timer, checkpointClipPath }. Таймер ставится при открытии
  // позиции и срабатывает через longTradeThresholdSec, если сделка всё ещё
  // не закрылась — см. onTradeOpened ниже и комментарий в handleCheckpoint.
  const pendingCheckpoints = new Map()
  const checkpointTmpDir = path.join(getUserDataDir(), 'tmp')

  // Группировка сделок по тикеру в "пачки" для общего клипа — вся логика
  // (окно между сделками, ожидание открытой позиции, лимит по буферу OBS)
  // живёт в tradeBatcher.js, здесь только то, что делать с готовой пачкой.
  const batcher = createTradeBatcher({
    config,
    log,
    onBatchClosed: (symbol, batch, { fromTimer }) => {
      if (!fromTimer) return finalizeBatch(symbol, batch)
      // Пачка закрылась по таймеру, вне очереди обработки — заводим её в ту же
      // очередь, что и остальные операции с OBS/ffmpeg.
      enqueue(
        () => finalizeBatch(symbol, batch),
        (error) => log(`Ошибка объединения сделок по ${symbol}: ${error.message}`)
      )
      return undefined
    },
    onReplaySuperseded: (replayPath) => deleteSourceReplayIfEnabled(replayPath, config, log)
  })

  // История клипов за сессию хранится целиком — её показывает окно "Все
  // сделки". Урезается только то, что показывает меню трея (нативное меню
  // Windows не прокручивается), и этим занимается уже сам трей.
  function addToHistory(entry) {
    recentClips.unshift({ ...entry, id: `${Date.now()}-${recentClips.length}` })
  }

  // Все SaveReplayBuffer-вызовы (и чекпоинты, и закрытия сделок) идут через
  // одну и ту же очередь, чтобы они не пересекались друг с другом.
  function enqueue(taskFn, onError) {
    processingChain = processingChain
      .then(taskFn)
      .catch((error) => onError(error))
  }

  function onTradeOpened(trade) {
    // Важно: это делается ДО проверки флага чекпоинта — от неё объединение
    // сделок не зависит, а раньше ранний return при выключенном чекпоинте
    // отрубал бы и ожидание новой сделки в пачке.
    batcher.positionOpened(trade)

    if (!config.clip.longTradeCheckpointEnabled) return
    const thresholdMs = config.clip.longTradeThresholdSec * 1000
    const timer = setTimeout(() => {
      const entry = pendingCheckpoints.get(trade.positionId)
      if (!entry) return // сделка уже закрылась раньше порога
      enqueue(
        () => handleCheckpoint(trade, entry),
        (error) => log(`Ошибка чекпоинта входа для ${trade.symbol}: ${error.message}`)
      )
    }, thresholdMs)
    pendingCheckpoints.set(trade.positionId, { timer, checkpointClipPath: null })
  }

  async function handleCheckpoint(trade, entry) {
    log(
      `Сделка ${trade.symbol} ${trade.side} открыта дольше ${config.clip.longTradeThresholdSec}с — ` +
      'делаю подстраховочный чекпоинт входа'
    )
    const replayPath = await obsClient.saveReplayBufferAndWaitForPath()
    const checkpointPath = await createEntryCheckpoint({
      replayPath,
      trade,
      paddingBeforeSec: config.clip.paddingBeforeSec,
      checkpointEntrySnippetSec: config.clip.checkpointEntrySnippetSec,
      tmpDir: checkpointTmpDir
    })
    entry.checkpointClipPath = checkpointPath
    log(`Чекпоинт входа сохранён: ${checkpointPath}`)

    await deleteSourceReplayIfEnabled(replayPath, config, log)
  }

  function enqueueTrade(trade) {
    // Снимаем позицию с учёта сразу по факту закрытия, а не после того, как
    // дорежется клип: иначе отсчёт "пачка больше не растёт" не стартовал бы
    // никогда — на момент постановки таймера позиция ещё числилась открытой.
    batcher.positionClosed(trade.symbol)

    const entry = pendingCheckpoints.get(trade.positionId)
    if (entry) {
      clearTimeout(entry.timer)
      pendingCheckpoints.delete(trade.positionId)
    }
    enqueue(
      // entry.checkpointClipPath читается в момент выполнения задачи, а не
      // постановки в очередь — к этому моменту задача чекпоинта (если была
      // поставлена раньше) уже успевает отработать, т.к. очередь одна.
      () => handleClosedTrade(trade, entry ? entry.checkpointClipPath : null),
      (error) => {
        const message = `Ошибка обработки сделки ${trade.symbol}: ${error.message}`
        log(message)
        if (onIssue) onIssue(message)
      }
    )
  }

  async function handleClosedTrade(trade, entryCheckpointClipPath) {
    const durationSec = ((trade.exitTimeMs - trade.entryTimeMs) / 1000).toFixed(1)
    log(`Сделка закрыта: ${trade.symbol} ${trade.side}, длительность ${durationSec}с`)

    // Ждём, пока реально пройдёт нужный "хвост" после выхода — иначе просим OBS
    // сохранить видео, которое ещё физически не записано.
    const paddingAfterMs = config.clip.paddingAfterSec * 1000
    const marginMs = 500 // небольшой запас на задержку самого OBS при сохранении
    const targetMs = trade.exitTimeMs + paddingAfterMs + marginMs
    const waitMs = targetMs - Date.now()
    if (waitMs > 0) {
      log(`Жду ${(waitMs / 1000).toFixed(1)}с, чтобы "хвост" после выхода успел записаться`)
      await sleep(waitMs)
    }

    const replayPath = await obsClient.saveReplayBufferAndWaitForPath()
    log(`OBS сохранил replay: ${replayPath}`)

    const clipPath = await createClipFromReplay({
      replayPath,
      trade,
      paddingBeforeSec: config.clip.paddingBeforeSec,
      paddingAfterSec: config.clip.paddingAfterSec,
      outputDir: resolveMediaPath(config.clip.outputDir),
      entryCheckpointClipPath,
      checkpointExitSnippetSec: config.clip.checkpointExitSnippetSec
    })

    log(`Клип готов: ${clipPath}`)

    if (config.clip.mergeTradesEnabled) {
      // Длина буфера нужна, чтобы вовремя закрыть серию сделок, пока она ещё
      // помещается в него целиком. Не смогли определить — не блокируем
      // объединение, просто не сможем закрыть серию заранее.
      const bufferDurationSec = await probeDurationSeconds(replayPath).catch((error) => {
        log(`Не удалось определить длину буфера OBS: ${error.message}`)
        return 0
      })
      // Решение, удалять ли исходный реплей прямо сейчас или подержать его
      // для возможного объединения с соседними сделками, принимается внутри.
      // clipPath кладём в сделку: если она попадёт в общий клип, её отдельный
      // клип потом переедет в подпапку (см. finalizeBatch).
      await batcher.addTrade({ ...trade, clipPath }, replayPath, bufferDurationSec)
    } else {
      await deleteSourceReplayIfEnabled(replayPath, config, log)
    }

    addToHistory({ trade, clipPath, label: buildHistoryLabel(trade) })

    if (onClipReady) onClipReady(trade, clipPath, recentClips.slice())
  }


  // Закрывает пачку: если в ней меньше 2 сделок — объединять нечего, просто
  // подчищаем придержанный реплей. Если 2 и больше — собираем один клип от
  // входа в первую сделку до выхода из последней (см. clipper.js).
  async function finalizeBatch(symbol, batch) {
    if (batch.trades.length < 2) {
      await deleteSourceReplayIfEnabled(batch.lastReplayPath, config, log)
      return
    }

    log(`Объединяю ${batch.trades.length} сделок подряд по ${symbol} в один клип`)
    const mergedClipPath = await createMergedClipFromReplay({
      replayPath: batch.lastReplayPath,
      trades: batch.trades,
      paddingBeforeSec: config.clip.paddingBeforeSec,
      paddingAfterSec: config.clip.paddingAfterSec,
      outputDir: resolveMediaPath(config.clip.outputDir)
    })

    await deleteSourceReplayIfEnabled(batch.lastReplayPath, config, log)

    if (!mergedClipPath) {
      log(`Объединённый диапазон по ${symbol} не поместился в буфер OBS целиком — общий клип не создан`)
      return
    }

    log(`Объединённый клип готов: ${mergedClipPath}`)

    await handleMergedParts({ batch, mergedClipPath, config, log, recentClips, onHistoryChanged })

    const lastTrade = batch.trades[batch.trades.length - 1]
    // Синтетическая "сделка" только для истории трея/имени в меню — реальной
    // сделкой не является, но buildHistoryLabel использует ровно эти поля.
    // entryTimeMs берём от первой сделки серии, чтобы в подписи показывалась
    // длительность всего объединённого клипа, а не пусто.
    const pseudoTrade = {
      symbol,
      side: 'COMBO',
      entryTimeMs: batch.trades[0].entryTimeMs,
      exitTimeMs: lastTrade.exitTimeMs
    }
    addToHistory({ trade: pseudoTrade, clipPath: mergedClipPath, label: buildHistoryLabel(pseudoTrade) })

    if (onClipReady) onClipReady(pseudoTrade, mergedClipPath, recentClips.slice())
  }

  // Ручное "сохранить последние N" из меню трея. Идёт через ту же очередь, что
  // и остальные обращения к OBS, чтобы не пересечься с сохранением по сделке.
  //
  // Возвращает { clipPath, error } и НИКОГДА не отклоняется: из трея результат
  // никому не нужен (там своё уведомление), а помощник первой настройки ждёт
  // путь к файлу, чтобы открыть его для разметки областей. Отклоняйся оно —
  // вызов из трея стал бы необработанным отказом промиса.
  function saveManualReplay(durationSec) {
    let settle
    const result = new Promise((resolve) => { settle = resolve })

    enqueue(
      async () => {
        log(`Сохраняю повтор последних ${durationSec}с по команде из трея`)
        const replayPath = await obsClient.saveReplayBufferAndWaitForPath()
        const clipPath = await createManualReplayClip({
          replayPath,
          durationSec,
          outputDir: resolveMediaPath(config.clip.manualReplayOutputDir)
        })
        log(`Повтор сохранён: ${clipPath}`)
        await deleteSourceReplayIfEnabled(replayPath, config, log)
        if (onManualReplayReady) onManualReplayReady(clipPath, durationSec)
        settle({ clipPath, error: null })
      },
      (error) => {
        const message = `Не удалось сохранить повтор: ${error.message}`
        log(message)
        if (onIssue) onIssue(message)
        settle({ clipPath: null, error: error.message })
      }
    )

    return result
  }

  // Ручная обрезка по ширине ("стакану") уже готового клипа — вызывается из
  // трея, не часть автоматического пайплайна и не завязана на очередь
  // SaveReplayBuffer (это чисто локальная ffmpeg-операция, OBS не трогает).
  async function cropRecentClip(clipPath, stakanIndex, options = {}) {
    const speedFactor = options.speedFactor
    const speedLabel = speedFactor ? ` с ускорением x${speedFactor}` : ''
    // Резать можно и по номеру стакана, и по сохранённой рамке — в сообщениях
    // называем то, что пользователь реально выбрал в меню.
    const areaLabel = options.cropRect
      ? `область «${options.cropPresetName || 'своя рамка'}»`
      : `стакан ${stakanIndex}`
    log(`Вырезаю ${areaLabel}${speedLabel} из ${clipPath}`)
    try {
      const stakanOutputDir = resolveMediaPath(config.clip.stakanOutputDir)
      // Быстрая обрезка из трея берёт звук из настройки: выбирать его на
      // каждый клип там негде — меню и так из трёх уровней.
      const outputPath = await cropClipToStakan(clipPath, stakanIndex, stakanOutputDir, {
        mute: Boolean(config.clip.trayCropMuted),
        ...options
      })
      log(`Готово (${areaLabel}${speedLabel}): ${outputPath}`)
      // Передаём готовую подпись, а не сырой индекс: у ручной рамки имени нет,
      // и в уведомление раньше могло попасть "null".
      if (onStakanReady) onStakanReady(outputPath, areaLabel, speedFactor)
    } catch (error) {
      const message = `Не удалось вырезать ${areaLabel}${speedLabel}: ${error.message}`
      log(message)
      if (onIssue) onIssue(message)
    }
  }

  // Оборачиваем колбэк от obsClient, чтобы знать, подключены ли мы сейчас —
  // от этого зависит, имеет ли смысл дёргать периодическую проверку Replay
  // Buffer (нет смысла проверять, пока даже соединения с OBS нет).
  function handleObsStatusChange(state) {
    obsConnected = state === 'connected'
    if (onStatusChange) onStatusChange(state)
    if (obsConnected) void checkReplayBufferStatus()
  }

  // Лёгкая периодическая проверка (см. config.obs.replayBufferCheckIntervalSec) —
  // один запрос статуса, без переподключений и прочей побочной активности.
  // Нужна, чтобы узнать о выключенном Replay Buffer сразу, а не постфактум,
  // когда уже не удалось сохранить клип закрытой сделки.
  async function checkReplayBufferStatus() {
    if (!obsConnected || !obsClient) return
    try {
      const active = await obsClient.isReplayBufferActive()
      if (onReplayBufferStatusChange) onReplayBufferStatusChange(active)
    } catch (error) {
      // Не страшно — это лишь диагностика, следующая попытка будет по таймеру
      log(`Не удалось проверить статус Replay Buffer: ${error.message}`)
    }
  }

  async function start() {
    const missingTools = await checkFfmpegToolsAvailable()
    if (missingTools.length > 0) {
      // ffmpeg и ffprobe едут внутри сборки, поэтому "поставь их сам" — уже не
      // тот совет: если их нет, значит повреждена или неполна сама установка.
      const { describeTools } = require('./ffmpegTools')
      const paths = describeTools()
      const message = `Не запускаются: ${missingTools.join(', ')}. Они входят в состав программы, так что, скорее всего, установка повреждена — переустанови её. ` +
        `Искали здесь: ${paths.ffmpeg}, ${paths.ffprobe}. Без них нарезка клипов работать не будет.`
      log(message)
      if (onIssue) onIssue(message)
    }

    // Чистим временные чекпоинты от прошлой сессии — новые positionId с ними
    // всё равно уже не связать.
    await fsp.rm(checkpointTmpDir, { recursive: true, force: true }).catch(() => {})
    await fsp.mkdir(checkpointTmpDir, { recursive: true })

    obsClient = createObsClient({
      url: config.obs.url,
      password: config.obs.password,
      onStatus: log,
      onStatusChange: handleObsStatusChange
    })

    try {
      await obsClient.connect()
    } catch (error) {
      log(`Не удалось подключиться к OBS: ${error.message}`)
      log('Проверь: OBS запущен, сервер WebSocket включён (Сервис → Настройки сервера WebSocket), пароль в config.json верный.')
      // Дальше не бросаем и не завершаем процесс — obsClient сам продолжит
      // попытки переподключения в фоне, статус в трее отразит это состояние.
    }

    const checkIntervalMs = config.obs.replayBufferCheckIntervalSec * 1000
    replayBufferCheckTimer = setInterval(() => { void checkReplayBufferStatus() }, checkIntervalMs)

    watcher = createTerminalLogWatcher({
      terminalType: config.terminal.type,
      logsDirOverride: config.terminal.logsDirOverride,
      pollIntervalMs: config.polling.logPollIntervalMs,
      onTradeClosed: enqueueTrade,
      onTradeOpened,
      onStatus: log
    })

    log(`Слежу за логами ${watcher.getTerminalName()}: ${watcher.getLogsDir()}`)
    watcher.start()

  }

  async function stop() {
    for (const { timer } of pendingCheckpoints.values()) clearTimeout(timer)
    pendingCheckpoints.clear()

    // Незавершённые "пачки" на объединение просто бросаем (без попытки
    // собрать итоговый клип из недособранной пачки) — но придержанный ради
    // них реплей всё равно подчищаем, чтобы не оставлять файл на диске.
    for (const batch of batcher.drain()) {
      await deleteSourceReplayIfEnabled(batch.lastReplayPath, config, log)
    }

    if (replayBufferCheckTimer) {
      clearInterval(replayBufferCheckTimer)
      replayBufferCheckTimer = null
    }
    obsConnected = false

    if (watcher) {
      watcher.stop()
      watcher = null
    }
    if (obsClient) {
      await obsClient.disconnect()
      obsClient = null
    }
    processingChain = Promise.resolve()
  }

  return { start, stop, cropRecentClip, saveManualReplay, getRecentClips: () => recentClips.slice() }
}

module.exports = { createApp, deleteSourceReplayIfEnabled, handleMergedParts, buildHistoryLabel }
