// Группировка подряд идущих сделок по одному тикеру в "пачку", из которой
// потом режется один общий клип (см. clipper.js/createMergedClipFromReplay).
//
// Правило одно: сделки попадают в одну пачку, если промежуток от ВЫХОДА
// предыдущей до ВХОДА в следующую не больше clip.mergeGapSec. Длительность
// самих сделок значения не имеет — пачка ждёт закрытия уже открытой позиции
// сколько угодно долго.
//
// Логика вынесена из app.js отдельным модулем именно ради тестируемости:
// она завязана на таймеры, и такие ошибки не видны при чтении кода
// (см. testBatcherWaitsForOpenPosition в тестах — реальный случай, когда
// пачка умирала посреди следующей сделки).

// Небольшой запас при проверке "влезает ли серия сделок в буфер OBS": границы
// буфера считаются по времени изменения файла, которое может слегка плавать,
// а промахнуться мимо буфера дороже, чем закрыть серию чуть раньше.
const BUFFER_FIT_SAFETY_FACTOR = 0.95

// createTradeBatcher({ config, log, onBatchClosed, onReplaySuperseded, timers, now })
// onBatchClosed(symbol, batch, { fromTimer }) — пачка закрыта, пора резать общий клип.
//   batch = { trades: [...], lastReplayPath, lastExitTimeMs }
// onReplaySuperseded(replayPath) — этот реплей пачке больше не нужен.
function createTradeBatcher({
  config,
  log = () => {},
  onBatchClosed,
  onReplaySuperseded = async () => {},
  timers = { setTimeout, clearTimeout },
  now = () => Date.now()
}) {
  // symbol -> { trades, lastReplayPath, lastExitTimeMs, finalizeTimer }
  const batches = new Map()
  // symbol -> сколько позиций по нему сейчас открыто. Именно счётчик, а не
  // флаг: по одному тикеру может висеть несколько позиций (в TigerTrade,
  // например, по разным счетам).
  const openPositionCounts = new Map()

  const gapMs = () => config.clip.mergeGapSec * 1000

  function hasOpenPosition(symbol) {
    return (openPositionCounts.get(symbol) || 0) > 0
  }

  // Таймер "пачка больше не растёт". Пока по символу есть открытая позиция,
  // таймер не ставится вообще — сделка уже идёт и, скорее всего, вольётся в
  // пачку. Отсчёт идёт от фактического ВЫХОДА из сделки, а не от момента
  // вызова: клип режется ещё несколько секунд, и иначе настройка "40с" на
  // деле означала бы секунд 45.
  function scheduleFinalize(symbol, batch) {
    if (hasOpenPosition(symbol)) return null

    const delayMs = Math.max(0, gapMs() - (now() - batch.lastExitTimeMs))
    return timers.setTimeout(() => {
      if (batches.get(symbol) !== batch) return // пачку уже закрыли другим путём
      batches.delete(symbol)
      onBatchClosed(symbol, batch, { fromTimer: true })
    }, delayMs)
  }

  function makeBatch(trade, replayPath) {
    const batch = {
      trades: [trade],
      lastReplayPath: replayPath,
      lastExitTimeMs: trade.exitTimeMs,
      finalizeTimer: null
    }
    batch.finalizeTimer = scheduleFinalize(trade.symbol, batch)
    batches.set(trade.symbol, batch)
    return batch
  }

  function clearFinalizeTimer(batch) {
    if (batch.finalizeTimer) timers.clearTimeout(batch.finalizeTimer)
    batch.finalizeTimer = null
  }

  // Влезет ли пачка целиком в буфер OBS, если добавить в неё эту сделку.
  // Общий клип режется из самого свежего реплея, поэтому "вход первой ->
  // выход последней" плюс отступы обязаны укладываться в длину буфера.
  function stillFitsBuffer(batch, trade, bufferDurationSec) {
    if (!Number.isFinite(bufferDurationSec) || bufferDurationSec <= 0) return true
    const requiredSpanMs =
      (trade.exitTimeMs + config.clip.paddingAfterSec * 1000) -
      (batch.trades[0].entryTimeMs - config.clip.paddingBeforeSec * 1000)
    return requiredSpanMs <= bufferDurationSec * 1000 * BUFFER_FIT_SAFETY_FACTOR
  }

  return {
    // Открылась позиция. Если по этому тикеру ждёт пачка и вход попал в окно —
    // снимаем с неё таймер: теперь она ждёт закрытия этой сделки, сколько бы
    // та ни длилась. Без этого сделка попадала в окно по времени входа, но
    // закрывалась позже mergeGapSec, и пачки к тому моменту уже не было.
    positionOpened(trade) {
      openPositionCounts.set(trade.symbol, (openPositionCounts.get(trade.symbol) || 0) + 1)

      const batch = batches.get(trade.symbol)
      if (!batch || !batch.finalizeTimer) return
      if (trade.entryTimeMs - batch.lastExitTimeMs > gapMs()) return // вход вне окна — пусть закрывается по таймеру
      clearFinalizeTimer(batch)
    },

    // Позиция закрылась. Вызывается сразу по факту закрытия, до нарезки клипа:
    // иначе на момент постановки таймера позиция всё ещё числилась бы открытой
    // и отсчёт не стартовал бы никогда.
    positionClosed(symbol) {
      const left = (openPositionCounts.get(symbol) || 0) - 1
      if (left > 0) openPositionCounts.set(symbol, left)
      else openPositionCounts.delete(symbol)
    },

    // Клип по сделке готов — решаем, продолжает ли она пачку или начинает новую.
    async addTrade(trade, replayPath, bufferDurationSec) {
      const existing = batches.get(trade.symbol)
      if (!existing) {
        makeBatch(trade, replayPath)
        return
      }

      const closeAndStartNew = async (reason) => {
        clearFinalizeTimer(existing)
        batches.delete(trade.symbol)
        if (reason) log(reason)
        await onBatchClosed(trade.symbol, existing, { fromTimer: false })
        makeBatch(trade, replayPath)
      }

      if (trade.entryTimeMs - existing.lastExitTimeMs > gapMs()) {
        await closeAndStartNew(null)
        return
      }

      // Сделка в окно попадает, но пачка уже не помещается в буфер OBS. Вместо
      // того чтобы молча не выдать ничего (общий клип просто не создастся),
      // закрываем пачку тем, что влезло, и начинаем новую.
      if (!stillFitsBuffer(existing, trade, bufferDurationSec)) {
        await closeAndStartNew(
          `Серия сделок по ${trade.symbol} упёрлась в длину буфера OBS — закрываю общий клип ` +
          `на ${existing.trades.length} сделк(ах) и начинаю новый`
        )
        return
      }

      clearFinalizeTimer(existing)
      const supersededReplayPath = existing.lastReplayPath
      existing.trades.push(trade)
      existing.lastReplayPath = replayPath
      existing.lastExitTimeMs = trade.exitTimeMs
      existing.finalizeTimer = scheduleFinalize(trade.symbol, existing)
      // Для объединения используется только самый свежий реплей — предыдущий
      // держать больше незачем.
      await onReplaySuperseded(supersededReplayPath)
    },

    // Останов слежения: недособранные пачки бросаем, но их реплеи возвращаем
    // наружу, чтобы вызывающий код мог их подчистить.
    drain() {
      const pending = []
      for (const batch of batches.values()) {
        clearFinalizeTimer(batch)
        pending.push(batch)
      }
      batches.clear()
      openPositionCounts.clear()
      return pending
    }
  }
}

module.exports = { createTradeBatcher, BUFFER_FIT_SAFETY_FACTOR }
