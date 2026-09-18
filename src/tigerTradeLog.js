const fsp = require('fs').promises
const path = require('path')
const { normalizeSymbol } = require('./symbol')
const { normalizeExchange } = require('./exchange')

// Разбор логов терминала TigerTrade (файлы WorkLog_*.log).
// Формат строки, из которой видно позицию:
//   11.06.2026 10:07:45.162 Binance via TIGER.COM Broker Spot: EnqueueUserPosition: Symbol=USDC/USDT;Account=BINANCE SPOT;Price=9995;Size=-22;Comission=0;Executions=1
//
// Отличия от Vataga, из-за которых это отдельный модуль:
// - время ЛОКАЛЬНОЕ (у Vataga в логе UTC);
// - позиция определяется парой аккаунт+символ, отдельного PositionID нет;
// - знак Size задаёт сторону, Size=0 означает закрытие;
// - числа могут быть с десятичной запятой (0,00487854).

const LOG_FILE_PATTERN = /^WorkLog_.+\.log$/i
const POSITION_LINE_RE = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s+(.+?):\s+EnqueueUserPosition:\s+(.+)$/
// Старые логи держать смысла нет: следим только за тем, что писалось недавно.
const MAX_LOG_AGE_MS = 2 * 24 * 60 * 60 * 1000
const ZERO_TOLERANCE = 1e-12

function resolveTigerTradeLogsDir(override) {
  if (override && override.trim()) return override.trim()
  const appData = process.env.APPDATA
  return appData ? path.join(appData, 'TigerTrade') : ''
}

// key=value;key=value;... — значения могут содержать пробелы и даже '=',
// поэтому режем только по первому '=' в каждом куске.
function parseKeyValuePairs(text) {
  const result = {}
  for (const part of text.split(';')) {
    const separatorIndex = part.indexOf('=')
    if (separatorIndex <= 0) continue
    const key = part.slice(0, separatorIndex).trim()
    if (key) result[key] = part.slice(separatorIndex + 1).trim()
  }
  return result
}

function parseNumericValue(value) {
  const text = String(value ?? '').trim().replace(',', '.')
  if (!text) return Number.NaN
  return Number(text)
}

function isNearlyZero(value) {
  return Number.isFinite(value) && Math.abs(value) <= ZERO_TOLERANCE
}

// TigerTrade пишет один и тот же инструмент то как "USDC/USDT", то как
// "USDCUSDT" — поэтому символ в идентификаторе позиции нормализуется, иначе
// открытие и закрытие одной сделки не сматчатся между собой.
function buildPositionId(account, symbol) {
  return `${account}:${normalizeSymbol(symbol)}`.toUpperCase()
}

function parseLocalDateTime(day, month, year, hour, minute, second, millisecond = '0') {
  const ms = new Date(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
    Number(String(millisecond).padEnd(3, '0').slice(0, 3))
  ).getTime()
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

// Возвращает событие изменения позиции или undefined, если строка нерелевантна.
function parseTigerTradePositionLine(line) {
  if (!line.includes('EnqueueUserPosition:')) return undefined

  const match = POSITION_LINE_RE.exec(line.trim())
  if (!match) return undefined

  const sourceName = String(match[8] || '').trim()
  const fields = parseKeyValuePairs(match[9])
  const symbol = String(fields.Symbol || '').trim()
  const account = String(fields.Account || '').trim()
  const size = parseNumericValue(fields.Size)
  if (!symbol || !account || !Number.isFinite(size)) return undefined

  // Симулятор — не настоящая торговля, клипы по нему не нужны.
  if (/^simulator$/i.test(sourceName) || /^sim\d*$/i.test(account)) return undefined

  const isClosed = isNearlyZero(size)
  // Снимок позиции без исполнений — это не сделка, а просто состояние
  // (TigerTrade пишет такие строки, например, при подключении к счёту).
  // Для закрытия проверку не делаем: там Executions может быть любым.
  const executions = parseNumericValue(fields.Executions)
  if (!isClosed && Number.isFinite(executions) && executions <= 0) return undefined

  const tradeTimeMs = parseLocalDateTime(match[1], match[2], match[3], match[4], match[5], match[6], match[7] ?? '0')
  if (!tradeTimeMs) return undefined

  return {
    positionId: buildPositionId(account, symbol),
    symbol: normalizeSymbol(symbol),
    // В счёте биржа указана явно ("BINANCE FUTURES"); если счёт назван
    // как-то иначе, берём её из источника строки ("Binance via TIGER.COM...").
    exchange: normalizeExchange(account, normalizeExchange(sourceName)),
    side: isClosed ? 'TRADE' : (size > 0 ? 'LONG' : 'SHORT'),
    isClosed,
    quantity: size,
    tradeTimeMs
  }
}

// Логи лежат либо прямо в <TigerTrade>\Data\Logs, либо в подпапках профилей:
// <TigerTrade>\<профиль>\Data\Logs. Смотрим оба варианта.
async function listTigerTradeLogFiles(rootDir) {
  if (!rootDir) return []

  const candidateDirs = [path.join(rootDir, 'Data', 'Logs')]
  try {
    const entries = await fsp.readdir(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) candidateDirs.push(path.join(rootDir, entry.name, 'Data', 'Logs'))
    }
  } catch {
    // Корневой папки нет — ниже вернём пустой список
  }
  // Если пользователь указал путь вручную, он мог сразу дать папку с логами.
  candidateDirs.push(rootDir)

  const found = new Map() // путь -> mtimeMs, Map заодно убирает дубли
  for (const dir of candidateDirs) {
    let names
    try {
      names = await fsp.readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!LOG_FILE_PATTERN.test(name)) continue
      const filePath = path.join(dir, name)
      try {
        const stat = await fsp.stat(filePath)
        found.set(filePath, stat.mtimeMs)
      } catch {
        // файл исчез между readdir и stat — не страшно
      }
    }
  }

  const cutoffMs = Date.now() - MAX_LOG_AGE_MS
  const fresh = [...found.entries()].filter(([, mtimeMs]) => mtimeMs >= cutoffMs)
  // Если свежих нет вовсе (терминал давно не запускали) — берём самый новый,
  // чтобы watcher всё же встал на файл и поймал сделки, когда торговля начнётся.
  const chosen = fresh.length > 0
    ? fresh
    : [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1)

  return chosen.map(([filePath]) => filePath).sort()
}

const tigerTradeAdapter = {
  id: 'tigertrade',
  displayName: 'TigerTrade',
  resolveLogsDir: resolveTigerTradeLogsDir,
  listLogFiles: listTigerTradeLogFiles,
  parseLine: parseTigerTradePositionLine
}

module.exports = {
  tigerTradeAdapter,
  parseTigerTradePositionLine,
  resolveTigerTradeLogsDir,
  listTigerTradeLogFiles,
  buildPositionId
}
