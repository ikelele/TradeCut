const fsp = require('fs').promises
const path = require('path')
const { vatagaAdapter } = require('./vatagaLog')
const { tigerTradeAdapter } = require('./tigerTradeLog')
const { readNewLinesFromCursor } = require('./logFileReader')

// Слежение за логами торгового терминала. Сам разбор строк и то, где искать
// файлы, вынесены в адаптеры (см. vatagaLog.js / tigerTradeLog.js) — здесь
// только общая часть: дочитывание файлов с позиции курсора и состояние
// "какие позиции сейчас открыты".

const ADAPTERS = {
  vataga: vatagaAdapter,
  tigertrade: tigerTradeAdapter
}

const DEFAULT_TERMINAL = 'vataga'

function getAdapter(terminalType) {
  return ADAPTERS[terminalType] || ADAPTERS[DEFAULT_TERMINAL]
}

function listTerminalTypes() {
  return Object.values(ADAPTERS).map(({ id, displayName }) => ({ id, displayName }))
}

// Событие от адаптера: { positionId, symbol, side, isClosed, quantity, tradeTimeMs }
// createTerminalLogWatcher(...) -> { start(), stop(), getLogsDir(), getTerminalName() }
// trade (открытие) = { positionId, symbol, side, entryTimeMs }
// trade (закрытие) = { positionId, symbol, side, entryTimeMs, exitTimeMs }
function createTerminalLogWatcher({
  terminalType,
  logsDirOverride,
  pollIntervalMs = 1000,
  onTradeClosed,
  onTradeOpened,
  onStatus
}) {
  const adapter = getAdapter(terminalType)
  const logsDir = adapter.resolveLogsDir(logsDirOverride)
  const cursors = new Map() // filePath -> { offset, remainder }
  const openPositions = new Map() // positionId -> { symbol, side, entryTimeMs, quantity }
  let timer = null
  let polling = false
  let initialized = false

  const emitStatus = (message) => {
    if (onStatus) onStatus(message)
  }

  function openPosition(event) {
    openPositions.set(event.positionId, {
      symbol: event.symbol,
      exchange: event.exchange,
      side: event.side,
      entryTimeMs: event.tradeTimeMs,
      quantity: event.quantity
    })
    emitStatus(`Открыта позиция ${event.symbol} ${event.side}`)
    if (onTradeOpened) {
      onTradeOpened({
        positionId: event.positionId,
        symbol: event.symbol,
        exchange: event.exchange,
        side: event.side,
        entryTimeMs: event.tradeTimeMs
      })
    }
  }

  function closePosition(positionId, existing, exitTimeMs) {
    openPositions.delete(positionId)
    onTradeClosed({
      positionId,
      symbol: existing.symbol,
      exchange: existing.exchange,
      side: existing.side,
      entryTimeMs: existing.entryTimeMs,
      exitTimeMs
    })
  }

  // Разворот позиции без прохода через ноль (был лонг, стал шорт по тому же
  // инструменту). В логе это одна строка, но по смыслу это закрытие старой
  // сделки и открытие новой — иначе вход первой сделки "залипнет" и клип
  // получится от входа в лонг до выхода из шорта.
  function isReversal(previousQuantity, nextQuantity) {
    if (!Number.isFinite(previousQuantity) || !Number.isFinite(nextQuantity)) return false
    if (previousQuantity === 0 || nextQuantity === 0) return false
    return Math.sign(previousQuantity) !== Math.sign(nextQuantity)
  }

  function handlePositionEvent(event) {
    const existing = openPositions.get(event.positionId)

    if (!event.isClosed) {
      if (!existing) {
        openPosition(event)
        return
      }
      if (isReversal(existing.quantity, event.quantity)) {
        emitStatus(`Разворот позиции ${event.symbol}: ${existing.side} -> ${event.side}`)
        closePosition(event.positionId, existing, event.tradeTimeMs)
        openPosition(event)
      }
      return
    }

    if (existing) {
      closePosition(event.positionId, existing, event.tradeTimeMs)
    } else {
      // Закрытие без замеченного открытия (например, стартовали в процессе сделки) — пропускаем
      emitStatus(`Закрытие позиции ${event.positionId} без известного входа — пропущено`)
    }
  }

  async function poll() {
    if (polling) return
    polling = true
    try {
      const files = await adapter.listLogFiles(logsDir)
      if (files.length === 0) {
        emitStatus(`Лог-файлы ${adapter.displayName} не найдены в ${logsDir}`)
        return
      }

      if (!initialized) {
        // При первом запуске не перечитываем всю историю — встаём в конец текущих файлов
        await Promise.all(files.map(async (filePath) => {
          const stat = await fsp.stat(filePath)
          cursors.set(filePath, { offset: stat.size, remainder: '' })
        }))
        initialized = true
        emitStatus(`Слежение начато (${adapter.displayName}). Файлы: ${files.map((f) => path.basename(f)).join(', ')}`)
        return
      }

      for (const filePath of files) {
        let cursor = cursors.get(filePath)
        if (!cursor) {
          // Файл появился уже после старта (новый день/новый профиль) — читаем
          // его с начала, иначе потеряли бы сделки из него.
          cursor = { offset: 0, remainder: '' }
          cursors.set(filePath, cursor)
        }
        const lines = await readNewLinesFromCursor(filePath, cursor)
        for (const line of lines) {
          const event = adapter.parseLine(line)
          if (event) handlePositionEvent(event)
        }
      }
    } catch (error) {
      emitStatus(`Ошибка чтения логов ${adapter.displayName}: ${error.message}`)
    } finally {
      polling = false
    }
  }

  return {
    start() {
      if (timer) return
      void poll()
      timer = setInterval(() => void poll(), pollIntervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    getLogsDir() {
      return logsDir
    },
    getTerminalName() {
      return adapter.displayName
    }
  }
}

// Проверка "а видит ли программа журнал этого терминала" — для помощника
// первой настройки.
//
// Это самая тихая из возможных поломок: терминал выбран не тот (или лежит не
// там, где ожидается), сделки закрываются, а клипов нет — и узнать почему
// неоткуда. Здесь мы честно показываем папку, в которую смотрим, и что в ней
// нашлось.
async function checkTerminalLogs(terminalType, logsDirOverride) {
  const adapter = getAdapter(terminalType)
  const logsDir = adapter.resolveLogsDir(logsDirOverride)

  let files = []
  try {
    files = await adapter.listLogFiles(logsDir)
  } catch (error) {
    return { terminalName: adapter.displayName, logsDir, files: [], error: error.message }
  }

  // Дата последней записи важнее самого факта наличия файлов: файл может
  // остаться с прошлого года, и тогда "журнал найден" вводило бы в заблуждение.
  let lastWriteMs = null
  for (const file of files) {
    try {
      const stat = await fsp.stat(file)
      if (lastWriteMs === null || stat.mtimeMs > lastWriteMs) lastWriteMs = stat.mtimeMs
    } catch {
      // файл исчез между листингом и stat — на ответ проверки это не влияет
    }
  }

  return { terminalName: adapter.displayName, logsDir, files, lastWriteMs }
}

module.exports = { createTerminalLogWatcher, getAdapter, listTerminalTypes, checkTerminalLogs, DEFAULT_TERMINAL }
