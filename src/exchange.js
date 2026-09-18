// Приведение названия биржи к читаемому виду для имени файла.
//
// Терминалы пишут биржу по-разному:
//   Vataga      — ExchangeType "BinanceVataga" (к названию биржи приклеено имя
//                 самого терминала) или префикс в SymbolTitle "BinanceVataga/MANAUSDT"
//   TigerTrade  — счёт "BINANCE FUTURES" либо источник строки
//                 "Binance via TIGER.COM Broker Spot"
// Во всех случаях значимо только первое слово, а регистр приходит какой попало.

// Точные написания для бирж, где Title Case выглядел бы неряшливо
// (OKX, MEXC, KuCoin). Всё остальное приводится к Title Case автоматически.
const KNOWN_EXCHANGE_NAMES = {
  BINANCE: 'Binance',
  BINANCEALPHA: 'BinanceAlpha',
  BYBIT: 'Bybit',
  OKX: 'OKX',
  GATE: 'GateIo',
  GATEIO: 'GateIo',
  MEXC: 'MEXC',
  BITGET: 'Bitget',
  KUCOIN: 'KuCoin',
  HYPERLIQUID: 'Hyperliquid',
  ASTER: 'Aster',
  LIGHTER: 'Lighter'
}

function toTitleCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
}

// normalizeExchange('BinanceVataga')                     -> 'Binance'
// normalizeExchange('BINANCE FUTURES')                   -> 'Binance'
// normalizeExchange('Binance via TIGER.COM Broker Spot') -> 'Binance'
// normalizeExchange('GateIo')                            -> 'GateIo'
function normalizeExchange(rawValue, fallback = '') {
  const text = String(rawValue ?? '').trim()
  if (!text) return fallback

  // Значимо только первое слово: "BINANCE FUTURES" и "Binance via TIGER.COM
  // Broker Spot" — это одна и та же биржа.
  const firstChunk = text.split(/[\s:|/\\-]+/).find(Boolean) || text

  let key = firstChunk.toUpperCase().replace(/[^A-Z0-9]+/g, '')
  // Vataga приклеивает своё имя к названию биржи: BinanceVataga -> Binance
  const withoutTerminalSuffix = key.replace(/VATAGA$/, '')
  if (withoutTerminalSuffix) key = withoutTerminalSuffix

  if (!key) return fallback
  return KNOWN_EXCHANGE_NAMES[key] || toTitleCase(key)
}

module.exports = { normalizeExchange }
