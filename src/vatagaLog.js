const fsp = require('fs').promises
const path = require('path')
const os = require('os')
const { normalizeSymbol } = require('./symbol')
const { normalizeExchange } = require('./exchange')

// Разбор логов терминала Vataga (файлы log-ГГГГММДД.clef, формат CLEF —
// по одному JSON-объекту на строку). Общая часть слежения за файлами живёт в
// terminalLog.js, здесь только специфика Vataga.

const LOG_FILE_PATTERN = /^log-\d{8}\.clef$/i

function resolveVatagaLogsDir(override) {
  if (override && override.trim()) return override.trim()
  const appData = process.env.APPDATA
  if (appData) return path.join(appData, 'Vataga', 'Vataga.terminal', 'Logs')
  // Резервный вариант для macOS, на случай если понадобится
  const home = os.homedir()
  return path.join(home, 'Library', 'Application Support', 'Vataga', 'Vataga.terminal', 'Logs')
}

async function listRecentLogFiles(logsDir) {
  let entries
  try {
    entries = await fsp.readdir(logsDir)
  } catch {
    return []
  }
  const matching = entries.filter((name) => LOG_FILE_PATTERN.test(name)).sort()
  // Берём последние 2 файла — на случай, если сделка происходит на стыке полуночи
  return matching.slice(-2).map((name) => path.join(logsDir, name))
}

// Парсит одну строку CLEF-лога Vataga.
// Возвращает событие изменения позиции или undefined, если строка нерелевантна.
function parsePositionChangedLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return undefined

  let payload
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return undefined
  }

  if (payload.Type !== 'Trading') return undefined
  const messageTemplate = typeof payload['@mt'] === 'string' ? payload['@mt'] : ''
  if (!messageTemplate.startsWith('Position changed')) return undefined

  const positionId = String(payload.PositionID || '').trim()
  if (!positionId) return undefined

  const tradeTimeMs = parseVatagaTimestamp(payload.TradeTime) || parseVatagaTimestamp(payload['@t'])
  if (!tradeTimeMs) return undefined

  const symbolTitle = String(payload.SymbolTitle || '')
  const symbol = normalizeSymbolTitle(symbolTitle)
  // ExchangeType — основной источник; если его нет, биржа стоит префиксом в
  // самом SymbolTitle ("BinanceVataga/MANAUSDT").
  const exchange = normalizeExchange(payload.ExchangeType || symbolTitle.split('/')[0])

  const quantity = Number(String(payload.PositionQuantity ?? '').replace(',', '.'))
  const side = Number.isFinite(quantity) && quantity !== 0
    ? (quantity > 0 ? 'LONG' : 'SHORT')
    : 'TRADE'

  return {
    positionId,
    symbol,
    exchange,
    side,
    isClosed: payload.IsClosed === true,
    quantity: Number.isFinite(quantity) ? quantity : undefined,
    tradeTimeMs
  }
}

// SymbolTitle приходит с биржей впереди: "BinanceVataga/MANAUSDT". Иногда пара
// внутри тоже разделена слэшем ("GateIo/UB/USDT"), поэтому отбрасываем ровно
// первый сегмент (биржу), а остальное склеиваем — раньше бралось всё после
// ПОСЛЕДНЕГО слэша, и такой символ превращался бы в "USDT".
function normalizeSymbolTitle(symbolTitle) {
  const parts = String(symbolTitle ?? '').split('/')
  const withoutExchange = parts.length > 1 ? parts.slice(1).join('') : parts[0]
  return normalizeSymbol(withoutExchange)
}

// Время в логе Vataga без явного смещения зоны — это UTC.
// Если смещение/Z уже указаны, оставляем как есть.
function parseVatagaTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return 0
  const text = value.trim()
  const hasExplicitZone = /(?:z|[+-]\d\d:?\d\d)$/i.test(text)
  const normalized = hasExplicitZone ? text : `${text}Z`
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

const vatagaAdapter = {
  id: 'vataga',
  displayName: 'Vataga',
  resolveLogsDir: resolveVatagaLogsDir,
  listLogFiles: listRecentLogFiles,
  parseLine: parsePositionChangedLine
}

module.exports = {
  vatagaAdapter,
  parsePositionChangedLine,
  resolveVatagaLogsDir,
  listRecentLogFiles,
  normalizeSymbolTitle,
  parseVatagaTimestamp
}
