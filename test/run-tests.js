const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { parsePositionChangedLine, normalizeSymbolTitle } = require('../src/vatagaLog')
const { normalizeSymbol } = require('../src/symbol')
const { parseTigerTradePositionLine } = require('../src/tigerTradeLog')
const { getAdapter, listTerminalTypes } = require('../src/terminalLog')
const { createClipFromReplay, buildOutputFileName, buildDailyOutputDir, createEntryCheckpoint, createMergedClipFromReplay } = require('../src/clipper')
const { getStakanBounds, cropClipToStakan, buildAtempoFilter, sanitizeOutputFileName } = require('../src/stakanCrop')
const { resolveCropRect, sanitizePresetName } = require('../src/cropRect')
const { detectPanelGuides } = require('../src/panelDetect')
const { deleteSourceReplayIfEnabled, handleMergedParts, buildHistoryLabel } = require('../src/app')
// Разбор строки ленты скринера живёт в скрипте Tampermonkey: в браузере он
// работает с DOM, а сюда отдаёт только чистую функцию разбора (см. конец файла).

function testParser() {
  const sample = fs.readFileSync(path.join(__dirname, '..', 'test-sample.clef'), 'utf8')
    .split(/\r?\n/).filter(Boolean)

  const events = sample.map(parsePositionChangedLine).filter(Boolean)
  assert.strictEqual(events.length, 5, 'ожидалось 5 событий Position changed в тестовом файле')

  const closedEvents = events.filter((e) => e.isClosed)
  assert.strictEqual(closedEvents.length, 2, 'ожидалось 2 закрытых события')

  const firstClose = closedEvents[0]
  assert.strictEqual(firstClose.symbol, 'MANAUSDT')
  assert.strictEqual(firstClose.tradeTimeMs, Date.parse('2026-07-03T12:11:43.072Z'))

  console.log('[OK] testParser')
}

// Биржа в имени файла сделки: терминалы пишут её по-разному, а в имени должна
// быть в читаемом виде ("DEEPUSDT SHORT Binance 2026-08-08 12-38-23.mp4").
function testExchangeInFileNames() {
  const { normalizeExchange } = require('../src/exchange')

  // Vataga приклеивает своё имя к бирже
  assert.strictEqual(normalizeExchange('BinanceVataga'), 'Binance')
  // TigerTrade — счёт и название источника строки
  assert.strictEqual(normalizeExchange('BINANCE FUTURES'), 'Binance')
  assert.strictEqual(normalizeExchange('Binance via TIGER.COM Broker Spot'), 'Binance')
  assert.strictEqual(normalizeExchange('BYBIT'), 'Bybit')
  assert.strictEqual(normalizeExchange('okx'), 'OKX', 'аббревиатуры не должны становиться Okx')
  assert.strictEqual(normalizeExchange('GateIo'), 'GateIo')
  assert.strictEqual(normalizeExchange(''), '', 'пусто остаётся пустым')
  assert.strictEqual(normalizeExchange(null, 'Binance'), 'Binance', 'запасное значение')

  const at = new Date(2026, 7, 8, 12, 38, 23).getTime()
  assert.strictEqual(
    buildOutputFileName({ symbol: 'DEEPUSDT', side: 'SHORT', exchange: 'Binance', entryTimeMs: at }),
    'DEEPUSDT SHORT Binance 2026-08-08 12-38-23.mp4'
  )
  // У старых записей биржи нет — имя должно остаться без лишнего пробела
  assert.strictEqual(
    buildOutputFileName({ symbol: 'DEEPUSDT', side: 'SHORT', entryTimeMs: at }),
    'DEEPUSDT SHORT 2026-08-08 12-38-23.mp4'
  )

  // Сквозь разбор строк обоих терминалов
  const vatagaLine = JSON.stringify({
    '@t': '2026-08-08T12:38:23.000Z', '@mt': 'Position changed.', PositionID: 'x',
    SymbolTitle: 'BinanceVataga/DEEPUSDT', ExchangeType: 'BinanceVataga',
    IsClosed: false, PositionQuantity: -5, Type: 'Trading'
  })
  assert.strictEqual(parsePositionChangedLine(vatagaLine).exchange, 'Binance')

  const tigerLine = '11.06.2026 10:07:45.162 Binance via TIGER.COM Broker Spot: EnqueueUserPosition: Symbol=ETHUSDT;Account=BINANCE FUTURES;Price=1;Size=2;Comission=0;Executions=1'
  assert.strictEqual(parseTigerTradePositionLine(tigerLine).exchange, 'Binance')

  console.log('[OK] testExchangeInFileNames')
}

// Ручное "сохранить последние N" из меню трея.
function testManualReplayFileName() {
  const { buildManualReplayFileName, formatDurationLabel } = require('../src/clipper')
  const at = new Date(2026, 7, 8, 12, 38, 23).getTime()

  assert.strictEqual(formatDurationLabel(15), '15сек')
  assert.strictEqual(formatDurationLabel(30), '30сек')
  assert.strictEqual(formatDurationLabel(60), '1мин')
  assert.strictEqual(formatDurationLabel(300), '5мин')

  assert.strictEqual(buildManualReplayFileName(15, at), 'Повтор 15сек 12-38-23.mp4')
  assert.strictEqual(buildManualReplayFileName(300, at), 'Повтор 5мин 12-38-23.mp4')

  console.log('[OK] testManualReplayFileName')
}

// Тикеры бывают не только латиницей: на Binance есть, например, 龙虾USDT.
// Раньше всё, кроме A-Z0-9, вырезалось, и такой тикер превращался в голый
// "USDT" — клип сохранялся под чужим именем, а позиции по разным монетам
// могли схлопнуться в одну.
function testNonLatinSymbols() {
  assert.strictEqual(normalizeSymbol('龙虾USDT'), '龙虾USDT', 'нелатинские буквы должны сохраняться')
  assert.strictEqual(normalizeSymbol('龙虾/USDT'), '龙虾USDT', 'разделитель убирается и здесь')
  assert.strictEqual(normalizeSymbol('EVAAUSDT'), 'EVAAUSDT')
  assert.strictEqual(normalizeSymbol('USDC/USDT'), 'USDCUSDT', 'старое поведение для латиницы не изменилось')
  assert.strictEqual(normalizeSymbol('usdc-usdt'), 'USDCUSDT')
  assert.strictEqual(normalizeSymbol(''), '')
  assert.strictEqual(normalizeSymbol(null), '')

  // Vataga отдаёт символ вместе с биржей
  assert.strictEqual(normalizeSymbolTitle('BinanceVataga/龙虾USDT'), '龙虾USDT')
  assert.strictEqual(normalizeSymbolTitle('BinanceVataga/MANAUSDT'), 'MANAUSDT')
  // Пара может быть разделена слэшем — раньше бралось всё после ПОСЛЕДНЕГО
  // слэша, и от такого символа оставалось только "USDT"
  assert.strictEqual(normalizeSymbolTitle('GateIo/UB/USDT'), 'UBUSDT')
  assert.strictEqual(normalizeSymbolTitle('MANAUSDT'), 'MANAUSDT', 'без биржи тоже должно работать')

  // Сквозь разбор торговой строки Vataga
  const line = JSON.stringify({
    '@t': '2026-08-07T00:11:44.000Z',
    '@mt': 'Position changed.',
    PositionID: 'abc',
    SymbolTitle: 'BinanceVataga/龙虾USDT',
    IsClosed: false,
    PositionQuantity: 10,
    Type: 'Trading'
  })
  assert.strictEqual(parsePositionChangedLine(line).symbol, '龙虾USDT', 'тикер сделки не должен терять иероглифы')

  // И в имени файла клипа
  const trade = {
    symbol: '龙虾USDT', side: 'LONG', exchange: 'Binance',
    entryTimeMs: new Date(2026, 7, 7, 0, 11, 44).getTime(),
    exitTimeMs: new Date(2026, 7, 7, 0, 12, 0).getTime()
  }
  assert.ok(buildOutputFileName(trade).startsWith('龙虾USDT LONG'), 'иероглифы должны доживать до имени файла')

  console.log('[OK] testNonLatinSymbols')
}

// Строки взяты из формата реальных логов TigerTrade (WorkLog_*.log).
function testTigerTradeParser() {
  const open = parseTigerTradePositionLine(
    '11.06.2026 10:07:45.162 Binance via TIGER.COM Broker Spot: EnqueueUserPosition: Symbol=USDC/USDT;Account=BINANCE SPOT;Price=9995;Size=-22;Comission=0;PriceMode=[Unified] Open Only;Executions=1'
  )
  assert.ok(open, 'строка открытия позиции должна разбираться')
  assert.strictEqual(open.positionId, 'BINANCE SPOT:USDCUSDT')
  assert.strictEqual(open.symbol, 'USDCUSDT')
  assert.strictEqual(open.side, 'SHORT', 'отрицательный Size = SHORT')
  assert.strictEqual(open.isClosed, false)
  // Время в логе TigerTrade локальное, а не UTC (в отличие от Vataga)
  assert.strictEqual(open.tradeTimeMs, new Date(2026, 5, 11, 10, 7, 45, 162).getTime())

  const closed = parseTigerTradePositionLine(
    '11.06.2026 10:08:45.162 Binance via TIGER.COM Broker Spot: EnqueueUserPosition: Symbol=ETHUSDT;Account=BINANCE FUTURES;Price=0;Size=0;Comission=0;Executions=2'
  )
  assert.strictEqual(closed.isClosed, true, 'Size=0 означает закрытие позиции')
  assert.strictEqual(closed.positionId, 'BINANCE FUTURES:ETHUSDT')

  // Открытие и закрытие одной сделки должны получить один positionId, даже
  // если в одной строке символ со слэшем, а в другой — без.
  const openSlash = parseTigerTradePositionLine(
    '11.06.2026 10:07:45.162 Binance via TIGER.COM Broker Spot: EnqueueUserPosition: Symbol=USDC/USDT;Account=BINANCE SPOT;Price=0.9995;Size=22;Comission=0;Executions=1'
  )
  const closeNoSlash = parseTigerTradePositionLine(
    '11.06.2026 10:08:45.162 Binance via TIGER.COM Broker Spot: EnqueueUserPosition: Symbol=USDCUSDT;Account=BINANCE SPOT;Price=1.0000;Size=0;Comission=0;Executions=2'
  )
  assert.strictEqual(openSlash.positionId, closeNoSlash.positionId, 'символ со слэшем и без должны давать один positionId')
  assert.strictEqual(openSlash.side, 'LONG', 'положительный Size = LONG')

  // Снимок позиции без исполнений — это не сделка
  assert.strictEqual(parseTigerTradePositionLine(
    '11.06.2026 10:07:45.162 Binance via TIGER.COM Broker Spot: EnqueueUserPosition: Symbol=ETHUSDT;Account=BINANCE FUTURES;Price=0;Size=2;Comission=0;Executions=0'
  ), undefined, 'снимок с Executions=0 должен игнорироваться')

  // Симулятор — не настоящая торговля
  assert.strictEqual(parseTigerTradePositionLine(
    '11.06.2026 10:07:45.162 Simulator: EnqueueUserPosition: Symbol=CAMPUSDT;Account=SIM1;Price=8632;Size=-4600;Comission=0;Executions=1'
  ), undefined, 'сделки симулятора должны игнорироваться')

  // Десятичная запятая в числах (европейский формат в логе)
  const commaDecimal = parseTigerTradePositionLine(
    '15.06.2026 10:00:20.000 Binance via TIGER.COM Broker Futures: EnqueueUserPosition: Symbol=SKYAIUSDT;Account=BINANCE FUTURES;Price=27103;Size=36;Comission=0,00487854;PriceMode=[Unified] Open Only;Executions=1'
  )
  assert.strictEqual(commaDecimal.side, 'LONG')
  assert.strictEqual(commaDecimal.quantity, 36)

  // Посторонние строки лога не должны ничего порождать
  assert.strictEqual(parseTigerTradePositionLine('11.06.2026 10:07:45.162 Something else happened'), undefined)
  assert.strictEqual(parseTigerTradePositionLine(''), undefined)

  console.log('[OK] testTigerTradeParser')
}

// Оба терминала должны быть доступны через общий реестр адаптеров, а
// неизвестное имя — безопасно откатываться на Vataga.
function testTerminalAdapters() {
  const types = listTerminalTypes().map((t) => t.id)
  assert.deepStrictEqual(types.sort(), ['tigertrade', 'vataga'])

  assert.strictEqual(getAdapter('vataga').displayName, 'Vataga')
  assert.strictEqual(getAdapter('tigertrade').displayName, 'TigerTrade')
  assert.strictEqual(getAdapter('чего-то-нет').id, 'vataga', 'неизвестный терминал должен откатываться на Vataga')

  // Каждый адаптер обязан уметь всё, что от него ждёт terminalLog.js
  for (const adapter of [getAdapter('vataga'), getAdapter('tigertrade')]) {
    for (const method of ['resolveLogsDir', 'listLogFiles', 'parseLine']) {
      assert.strictEqual(typeof adapter[method], 'function', `${adapter.id}: нет метода ${method}`)
    }
  }

  console.log('[OK] testTerminalAdapters')
}

// Запуск не должен ждать подключения к OBS.
//
// Пока неудача приходила мгновенно, ожидание было незаметным. Но OBS умеет
// принять соединение и замолчать — тогда попытка упирается в срок ожидания, и
// всё это время приложение выглядит незапустившимся: окно помощника настройки,
// например, открывается только после того, как startTrayApp договорит.
async function testStartDoesNotWaitForObs() {
  const net = require('net')
  const os = require('os')
  const { createApp } = require('../src/app')
  const { DEFAULT_CONFIG } = require('../src/config')

  const sockets = []
  const server = net.createServer((socket) => sockets.push(socket))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  // Свою временную папку приложение при старте чистит — подсовываем ему
  // отдельную, чтобы тест не трогал файлы работающей копии.
  const previousLocalAppData = process.env.LOCALAPPDATA
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-start-'))
  process.env.LOCALAPPDATA = tmpHome

  try {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
    config.obs.url = `ws://127.0.0.1:${port}`
    config.obs.password = 'неважно какой'
    config.terminal.logsDirOverride = path.join(tmpHome, 'журнала-тут-нет')

    const appCore = createApp({ config, log: () => {} })

    const startedAt = Date.now()
    await appCore.start()
    const elapsed = Date.now() - startedAt
    await appCore.stop()

    assert.ok(elapsed < 5000,
      `start() обязан вернуться, не дожидаясь OBS, а занял ${elapsed}мс ` +
      '(срок ожидания подключения — 10с, значит его снова ждут)')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    process.env.LOCALAPPDATA = previousLocalAppData
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }

  console.log('[OK] testStartDoesNotWaitForObs')
}

// Молчащий OBS не должен вешать приложение.
//
// Так это и выглядело вживую: OBS принимал соединение и замолкал (он так
// отбивается от частых попыток с неверным паролем), obs-websocket-js ждал
// рукопожатия без всякого срока, вместе с ним навсегда вставал start(), а с
// ним — и окно, которое ждало ответа на сохранение настроек.
async function testObsConnectTimesOut() {
  const net = require('net')
  const { createObsClient } = require('../src/obsClient')

  // Принимаем соединение и не говорим ни слова — ровно то поведение.
  // Сокеты держим сами: server.close() ждёт закрытия всех соединений, а наше
  // как раз повисло — иначе тест не завершился бы.
  const sockets = []
  const server = net.createServer((socket) => sockets.push(socket))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  const statuses = []
  const client = createObsClient({
    url: `ws://127.0.0.1:${port}`,
    password: 'всё равно какой',
    onStatus: (message) => statuses.push(message),
    connectTimeoutMs: 300,
    reconnectDelayMs: 100
  })

  const startedAt = Date.now()
  await assert.rejects(
    () => client.connect(),
    /не ответил/,
    'подключение к молчащему OBS обязано завершиться отказом, а не ждать вечно'
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 3000, `отказ должен прийти по сроку ожидания, а пришёл через ${elapsed}мс`)
  assert.ok(statuses.some((message) => /Не удалось подключиться/.test(message)), 'о неудаче должно быть сказано')

  await client.disconnect()
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => server.close(resolve))
  console.log('[OK] testObsConnectTimesOut')
}

// Причина неудачи повторяется каждые несколько секунд часами — полным текстом
// её надо писать при смене, иначе в журнале не останется ничего другого.
function testObsFailuresAreNotRepeatedInLog() {
  const { createObsClient } = require('../src/obsClient')
  const statuses = []
  // Нам нужен только разбор повторов, поэтому дёргаем его через сам клиент:
  // адрес заведомо нерабочий, подключений не будет.
  const client = createObsClient({
    url: 'ws://127.0.0.1:1',
    onStatus: (message) => statuses.push(message),
    connectTimeoutMs: 50,
    reconnectDelayMs: 100000 // не даём переподключаться во время проверки
  })

  return (async () => {
    for (let i = 0; i < 3; i++) {
      await client.connect().catch(() => {})
    }
    const failures = statuses.filter((message) => /Не удалось подключиться/.test(message))
    assert.strictEqual(failures.length, 1,
      `одинаковая причина должна писаться один раз, а написана ${failures.length}: ${failures.join(' | ')}`)

    await client.disconnect()
    console.log('[OK] testObsFailuresAreNotRepeatedInLog')
  })()
}

// Проверка журнала из помощника первой настройки. Она должна отвечать честно
// в обе стороны: нашла — сколько файлов и когда была последняя запись, не
// нашла — какую именно папку смотрела. Молчаливое "ничего не найдено" здесь
// хуже всего: именно из-за него "сделки закрываются, а клипов нет".
async function testCheckTerminalLogs() {
  const { checkTerminalLogs } = require('../src/terminalLog')

  const logsDir = path.join(__dirname, '..', 'test-assets', 'setup-check', 'Data', 'Logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const logPath = path.join(logsDir, 'WorkLog_20260918.log')
  fs.writeFileSync(logPath, 'проверочная строка\n', 'utf8')

  const found = await checkTerminalLogs('tigertrade', path.join(__dirname, '..', 'test-assets', 'setup-check'))
  assert.strictEqual(found.terminalName, 'TigerTrade')
  assert.ok(found.files.length >= 1, 'журнал в указанной папке должен найтись')
  assert.ok(found.files.some((file) => file.endsWith('WorkLog_20260918.log')), 'должен найтись именно наш файл')
  assert.ok(Number.isFinite(found.lastWriteMs), 'должно вернуться время последней записи')

  // Папки нет вовсе — это не исключение, а обычный ответ "не нашлось", и в нём
  // обязательно должен быть путь: иначе человеку нечего проверять глазами.
  const missing = await checkTerminalLogs('tigertrade', path.join(__dirname, '..', 'test-assets', 'setup-check-nope'))
  assert.deepStrictEqual(missing.files, [], 'в несуществующей папке файлов быть не должно')
  assert.ok(missing.logsDir.includes('setup-check-nope'), 'ответ должен называть папку, в которую смотрели')

  fs.rmSync(path.join(__dirname, '..', 'test-assets', 'setup-check'), { recursive: true, force: true })
  console.log('[OK] testCheckTerminalLogs')
}

// Общая машина состояний watcher'а на примере TigerTrade: открытие -> закрытие,
// и отдельно разворот позиции (лонг сразу в шорт, без прохода через ноль).
async function testTerminalWatcherStateMachine() {
  const { createTerminalLogWatcher } = require('../src/terminalLog')
  const logsDir = path.join(__dirname, '..', 'test-assets', 'tiger-logs', 'Data', 'Logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const logPath = path.join(logsDir, 'WorkLog_test.log')
  fs.writeFileSync(logPath, '', 'utf8')

  const opened = []
  const closed = []
  const watcher = createTerminalLogWatcher({
    terminalType: 'tigertrade',
    logsDirOverride: path.join(__dirname, '..', 'test-assets', 'tiger-logs'),
    pollIntervalMs: 50,
    onTradeOpened: (trade) => opened.push(trade),
    onTradeClosed: (trade) => closed.push(trade),
    onStatus: () => {}
  })

  assert.strictEqual(watcher.getTerminalName(), 'TigerTrade')
  watcher.start()

  const waitFor = (predicate, description) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 4000
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error(`Не дождались: ${description}`))
      setTimeout(tick, 40)
    }
    tick()
  })

  // Даём watcher'у встать в конец пустого файла, иначе он посчитает наши
  // строки "историей" и пропустит их.
  await waitFor(() => true, 'старт')
  await new Promise((resolve) => setTimeout(resolve, 200))

  const append = (line) => fs.appendFileSync(logPath, `${line}\n`, 'utf8')

  append('15.06.2026 10:00:00.000 Binance via TIGER.COM Broker Futures: EnqueueUserPosition: Symbol=BTCUSDT;Account=BINANCE FUTURES;Price=65000;Size=1;Comission=0;Executions=1')
  await waitFor(() => opened.length === 1, 'открытие позиции')
  assert.strictEqual(opened[0].symbol, 'BTCUSDT')
  assert.strictEqual(opened[0].side, 'LONG')

  append('15.06.2026 10:02:00.000 Binance via TIGER.COM Broker Futures: EnqueueUserPosition: Symbol=BTCUSDT;Account=BINANCE FUTURES;Price=65200;Size=0;Comission=0;Executions=4')
  await waitFor(() => closed.length === 1, 'закрытие позиции')
  assert.strictEqual(closed[0].entryTimeMs, new Date(2026, 5, 15, 10, 0, 0, 0).getTime())
  assert.strictEqual(closed[0].exitTimeMs, new Date(2026, 5, 15, 10, 2, 0, 0).getTime())

  // Разворот: лонг сразу переходит в шорт одной строкой. Это должно закрыть
  // старую сделку и открыть новую, иначе вход "залипнет" на лонге.
  append('15.06.2026 10:05:00.000 Binance via TIGER.COM Broker Futures: EnqueueUserPosition: Symbol=ETHUSDT;Account=BINANCE FUTURES;Price=3000;Size=5;Comission=0;Executions=1')
  await waitFor(() => opened.length === 2, 'открытие лонга перед разворотом')

  append('15.06.2026 10:06:00.000 Binance via TIGER.COM Broker Futures: EnqueueUserPosition: Symbol=ETHUSDT;Account=BINANCE FUTURES;Price=3010;Size=-3;Comission=0;Executions=2')
  await waitFor(() => closed.length === 2 && opened.length === 3, 'разворот позиции')
  assert.strictEqual(closed[1].side, 'LONG', 'при развороте закрывается прежняя длинная позиция')
  assert.strictEqual(opened[2].side, 'SHORT', 'при развороте открывается новая короткая позиция')

  watcher.stop()
  console.log('[OK] testTerminalWatcherStateMachine')
}

// Управляемое время + таймеры: логика склейки завязана на них, а без
// подмены пришлось бы реально ждать десятки секунд.
function createFakeClock(startMs) {
  let nowMs = startMs
  let nextId = 1
  const scheduled = new Map() // id -> { atMs, fn }
  return {
    now: () => nowMs,
    timers: {
      setTimeout: (fn, delayMs) => {
        const id = nextId++
        scheduled.set(id, { atMs: nowMs + delayMs, fn })
        return id
      },
      clearTimeout: (id) => { scheduled.delete(id) }
    },
    // Двигает время вперёд, выполняя сработавшие таймеры по порядку
    async advance(ms) {
      const targetMs = nowMs + ms
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.atMs <= targetMs)
          .sort((a, b) => a[1].atMs - b[1].atMs)[0]
        if (!due) break
        const [id, timer] = due
        scheduled.delete(id)
        nowMs = timer.atMs
        await timer.fn()
      }
      nowMs = targetMs
    },
    pendingCount: () => scheduled.size
  }
}

function makeBatcherHarness({ mergeGapSec = 40, paddingBeforeSec = 2, paddingAfterSec = 2, startMs = Date.parse('2026-08-04T10:00:00Z') } = {}) {
  const clock = createFakeClock(startMs)
  const closedBatches = []
  const supersededReplays = []
  const { createTradeBatcher } = require('../src/tradeBatcher')
  const batcher = createTradeBatcher({
    config: { clip: { mergeGapSec, paddingBeforeSec, paddingAfterSec } },
    log: () => {},
    onBatchClosed: (symbol, batch) => { closedBatches.push({ symbol, trades: batch.trades.slice() }) },
    onReplaySuperseded: async (replayPath) => { supersededReplays.push(replayPath) },
    timers: clock.timers,
    now: clock.now
  })
  return { clock, batcher, closedBatches, supersededReplays }
}

function tradeAt(symbol, entryOffsetSec, exitOffsetSec, startMs) {
  return {
    symbol,
    side: 'SHORT',
    entryTimeMs: startMs + entryOffsetSec * 1000,
    exitTimeMs: startMs + exitOffsetSec * 1000
  }
}

// Проигрывает сделку так, как это происходит в жизни: часы доводятся до входа,
// затем до выхода, и только потом (через паузу на нарезку клипа) сделка
// отдаётся батчеру. Без движения часов таймеры считались бы от неверного
// момента, и тест проверял бы не то.
const CLIP_CUT_DELAY_MS = 5000
async function playTrade(clock, batcher, trade, { replayPath = 'r.mkv', bufferSec = 600 } = {}) {
  await clock.advance(Math.max(0, trade.entryTimeMs - clock.now()))
  batcher.positionOpened(trade)
  await clock.advance(Math.max(0, trade.exitTimeMs - clock.now()))
  batcher.positionClosed(trade.symbol)
  await clock.advance(CLIP_CUT_DELAY_MS)
  await batcher.addTrade({ ...trade, clipPath: `${trade.symbol}-${trade.entryTimeMs}.mp4` }, replayPath, bufferSec)
}

// Регрессия на реальный случай из лога: сделка 1 закрылась в 13:27:00,
// сделка 2 ОТКРЫЛАСЬ в 13:27:26 (в окне 40с), но закрылась только в 13:27:56 —
// то есть позже, чем истекал бы таймер. Раньше пачка умирала в 13:27:46,
// посреди второй сделки, и склейки не было.
async function testBatcherWaitsForOpenPosition() {
  const startMs = Date.parse('2026-08-04T11:26:53Z')
  const { clock, batcher, closedBatches } = makeBatcherHarness({ mergeGapSec: 40, startMs })

  const first = tradeAt('BEATUSDT', 0, 7, startMs)   // вход 13:26:53, выход 13:27:00
  const second = tradeAt('BEATUSDT', 33, 63, startMs) // вход 13:27:26, выход 13:27:56

  batcher.positionOpened(first)
  await clock.advance(7000)
  batcher.positionClosed(first.symbol)
  await clock.advance(6000) // ~6с на нарезку клипа, как в реальном логе
  await batcher.addTrade({ ...first, clipPath: 'C:\\clips\\first.mp4' }, 'C:\\replays\\1.mkv', 600)

  // Вторая позиция открывается через 26с после выхода первой — в окне
  await clock.advance(20000)
  batcher.positionOpened(second)

  // Тот самый момент, когда раньше срабатывал таймер (40с от нарезки клипа)
  await clock.advance(25000)
  assert.strictEqual(closedBatches.length, 0, 'пачка не должна закрываться, пока по тикеру открыта позиция')

  batcher.positionClosed(second.symbol)
  await clock.advance(5000)
  await batcher.addTrade({ ...second, clipPath: 'C:\\clips\\second.mp4' }, 'C:\\replays\\2.mkv', 600)

  await clock.advance(41000) // теперь окно действительно истекает
  assert.strictEqual(closedBatches.length, 1, 'после паузы пачка должна закрыться ровно один раз')
  assert.strictEqual(closedBatches[0].trades.length, 2, 'обе сделки должны попасть в один общий клип')

  console.log('[OK] testBatcherWaitsForOpenPosition')
}

// Промежуток больше окна — сделки НЕ должны объединяться.
async function testBatcherSplitsOnLongGap() {
  const startMs = Date.parse('2026-08-04T12:00:00Z')
  const { clock, batcher, closedBatches } = makeBatcherHarness({ mergeGapSec: 40, startMs })

  const first = tradeAt('AAAUSDT', 0, 10, startMs)
  const second = tradeAt('AAAUSDT', 100, 110, startMs) // вход через 90с после выхода первой

  await playTrade(clock, batcher, first)
  await clock.advance(41000)
  assert.strictEqual(closedBatches.length, 1, 'первая пачка закрывается по истечении окна')
  assert.strictEqual(closedBatches[0].trades.length, 1, 'в ней одна сделка — объединять нечего')

  await playTrade(clock, batcher, second)
  await clock.advance(41000)

  assert.strictEqual(closedBatches.length, 2)
  assert.strictEqual(closedBatches[1].trades.length, 1, 'вторая сделка должна остаться отдельной')

  console.log('[OK] testBatcherSplitsOnLongGap')
}

// Сделки по разным тикерам не должны смешиваться в одну пачку.
async function testBatcherKeepsSymbolsSeparate() {
  const startMs = Date.parse('2026-08-04T13:00:00Z')
  const { clock, batcher, closedBatches } = makeBatcherHarness({ mergeGapSec: 40, startMs })

  // Сделки двух тикеров идут вперемешку по времени — так и проверяется, что
  // пачки не смешиваются.
  const interleaved = [
    tradeAt('AAAUSDT', 0, 5, startMs),
    tradeAt('BBBUSDT', 6, 11, startMs),
    tradeAt('AAAUSDT', 15, 20, startMs),
    tradeAt('BBBUSDT', 22, 27, startMs)
  ]
  for (const trade of interleaved) await playTrade(clock, batcher, trade)

  await clock.advance(41000)
  assert.strictEqual(closedBatches.length, 2, 'должно быть по одной пачке на тикер')
  assert.deepStrictEqual(closedBatches.map((b) => b.symbol).sort(), ['AAAUSDT', 'BBBUSDT'])
  for (const batch of closedBatches) {
    assert.strictEqual(batch.trades.length, 2, `${batch.symbol}: обе сделки тикера в своей пачке`)
    assert.ok(batch.trades.every((t) => t.symbol === batch.symbol), 'в пачке не должно быть чужого тикера')
  }

  console.log('[OK] testBatcherKeepsSymbolsSeparate')
}

// Серия длиннее буфера OBS: пачка должна закрыться тем, что влезло, а не
// разрастись до состояния "общий клип не создался вообще".
async function testBatcherClosesBatchBeforeBufferOverflow() {
  const startMs = Date.parse('2026-08-04T14:00:00Z')
  const { clock, batcher, closedBatches } = makeBatcherHarness({ mergeGapSec: 40, startMs })
  const bufferSec = 60 // короткий буфер OBS

  // Четыре сделки подряд по 10с с паузами 10с: суммарно вылезают за 60с
  for (let i = 0; i < 4; i++) {
    const trade = tradeAt('CCCUSDT', i * 20, i * 20 + 10, startMs)
    await playTrade(clock, batcher, trade, { bufferSec })
  }
  assert.ok(closedBatches.length >= 1, 'пачка должна была закрыться, не дожидаясь переполнения буфера')

  await clock.advance(41000)
  const totalTrades = closedBatches.reduce((sum, b) => sum + b.trades.length, 0)
  assert.strictEqual(totalTrades, 4, 'ни одна сделка не должна потеряться при разбиении')

  for (const batch of closedBatches) {
    const spanSec = (batch.trades.at(-1).exitTimeMs + 2000 - (batch.trades[0].entryTimeMs - 2000)) / 1000
    assert.ok(spanSec <= bufferSec, `пачка должна влезать в буфер, получилось ${spanSec}с`)
  }

  console.log('[OK] testBatcherClosesBatchBeforeBufferOverflow')
}

// Ждёт predicate() на реальных таймерах — переиспользуется тестами watcher'ов,
// которые следят за настоящими файлами через setInterval.
function waitForCondition(predicate, description, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error(`Не дождались: ${description}`))
      setTimeout(tick, 30)
    }
    tick()
  })
}

// Подпись в истории трея/окна: в конце длительность в секундах, чтобы сразу
// понимать, стоит ли ускорять клип при обрезке по стакану.
function testBuildHistoryLabel() {
  const entryTimeMs = new Date(2026, 7, 5, 12, 0, 0).getTime()

  assert.strictEqual(
    buildHistoryLabel({ symbol: 'BEATUSDT', side: 'SHORT', entryTimeMs, exitTimeMs: entryTimeMs + 25000 }),
    'BEATUSDT SHORT 08-05 12:00 25s'
  )
  assert.strictEqual(
    buildHistoryLabel({ symbol: 'UBUSDT', side: 'LONG', entryTimeMs, exitTimeMs: entryTimeMs + 90000 }),
    'UBUSDT LONG 08-05 12:01 90s',
    'секунды не переводятся в минуты — 90s остаётся 90s'
  )

  // Объединённый клип: длительность всей серии, а не последней сделки
  assert.strictEqual(
    buildHistoryLabel({ symbol: 'UBUSDT', side: 'COMBO', entryTimeMs, exitTimeMs: entryTimeMs + 174000 }),
    'UBUSDT COMBO 08-05 12:02 174s'
  )

  // Без времени входа длительность просто не показывается
  assert.strictEqual(
    buildHistoryLabel({ symbol: 'XXXUSDT', side: 'LONG', exitTimeMs: entryTimeMs }),
    'XXXUSDT LONG 08-05 12:00'
  )

  console.log('[OK] testBuildHistoryLabel')
}

async function testClipperWithinBounds() {
  const replayPath = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')
  const nowMs = Date.now()
  fs.utimesSync(replayPath, new Date(nowMs), new Date(nowMs))

  const trade = { symbol: 'TESTUSDT', side: 'LONG', entryTimeMs: nowMs - 7000, exitTimeMs: nowMs - 2000 }
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-ci')
  const outputPath = await createClipFromReplay({
    replayPath, trade, paddingBeforeSec: 1, paddingAfterSec: 1, outputDir
  })
  assert.ok(fs.existsSync(outputPath), 'клип должен быть создан')

  const durationStr = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', outputPath
  ]).toString().trim()
  const duration = parseFloat(durationStr)
  assert.ok(duration > 6 && duration < 8, `длительность клипа должна быть ~7с, получено ${duration}`)

  console.log('[OK] testClipperWithinBounds')
}

async function testClipperOutOfBoundsClamps() {
  const replayPath = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')
  const nowMs = Date.now()
  fs.utimesSync(replayPath, new Date(nowMs), new Date(nowMs))

  const trade = { symbol: 'EDGEUSDT', side: 'SHORT', entryTimeMs: nowMs - 50000, exitTimeMs: nowMs - 1000 }
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-ci')

  const outputPath = await createClipFromReplay({
    replayPath, trade, paddingBeforeSec: 2, paddingAfterSec: 2, outputDir
  })
  assert.ok(fs.existsSync(outputPath), 'клип должен быть создан даже при выходе за границы буфера (не должно быть исключения)')

  console.log('[OK] testClipperOutOfBoundsClamps (не упало, обрезало по границам)')
}

function testBuildDailyOutputDir() {
  const exitTimeMs = new Date(2026, 6, 3, 23, 59, 0).getTime() // локальная дата: 2026-07-03
  const dir = buildDailyOutputDir(path.join('base', 'clips'), exitTimeMs)
  assert.strictEqual(dir, path.join('base', 'clips', '2026-07-03'))

  console.log('[OK] testBuildDailyOutputDir')
}

async function testClipperCreatesDatedSubfolder() {
  const replayPath = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')
  const nowMs = Date.now()
  fs.utimesSync(replayPath, new Date(nowMs), new Date(nowMs))

  const trade = { symbol: 'DAYUSDT', side: 'LONG', entryTimeMs: nowMs - 7000, exitTimeMs: nowMs - 2000 }
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-ci')
  const outputPath = await createClipFromReplay({
    replayPath, trade, paddingBeforeSec: 1, paddingAfterSec: 1, outputDir
  })

  const expectedDir = buildDailyOutputDir(outputDir, trade.exitTimeMs)
  assert.strictEqual(path.dirname(outputPath), expectedDir, 'клип должен лежать в подпапке outputDir/ГГГГ-ММ-ДД')
  assert.ok(fs.existsSync(outputPath), 'клип должен существовать в подпапке дня')

  console.log('[OK] testClipperCreatesDatedSubfolder')
}

// Длинная сделка (400с), для которой к моменту закрытия вход уже вытеснен из
// буфера. Проверяем, что при наличии чекпоинта входа итоговый клип реально
// содержит и вход, и выход (склеенные), а не просто клэмп по границам буфера.
async function testClipperStitchesWithCheckpoint() {
  const assetsDir = path.join(__dirname, '..', 'test-assets')
  const nowMs = Date.now()

  const trade = { positionId: 'stitch-1', symbol: 'LONGUSDT', side: 'LONG', entryTimeMs: nowMs - 400000, exitTimeMs: nowMs - 1000 }

  // "Ранний" буфер — снят вскоре после входа, покрывает только окрестность входа
  const checkpointReplayPath = path.join(assetsDir, 'checkpoint-source.mkv')
  fs.copyFileSync(path.join(assetsDir, 'fake-replay.mkv'), checkpointReplayPath)
  const checkpointBufferEndMs = trade.entryTimeMs + 5000
  fs.utimesSync(checkpointReplayPath, new Date(checkpointBufferEndMs), new Date(checkpointBufferEndMs))

  const tmpDir = path.join(assetsDir, 'checkpoints-ci')
  const checkpointClipPath = await createEntryCheckpoint({
    replayPath: checkpointReplayPath,
    trade,
    paddingBeforeSec: 1,
    checkpointEntrySnippetSec: 3,
    tmpDir
  })
  assert.ok(fs.existsSync(checkpointClipPath), 'чекпоинт входа должен быть создан')

  // "Поздний" буфер — снят в момент закрытия, вход уже давно вытеснен из него
  const exitReplayPath = path.join(assetsDir, 'exit-source.mkv')
  fs.copyFileSync(path.join(assetsDir, 'fake-replay.mkv'), exitReplayPath)
  fs.utimesSync(exitReplayPath, new Date(nowMs), new Date(nowMs))

  const outputDir = path.join(assetsDir, 'clips-ci')
  const outputPath = await createClipFromReplay({
    replayPath: exitReplayPath,
    trade,
    paddingBeforeSec: 1,
    paddingAfterSec: 1,
    outputDir,
    entryCheckpointClipPath: checkpointClipPath,
    checkpointExitSnippetSec: 3
  })

  assert.ok(fs.existsSync(outputPath), 'склеенный клип должен быть создан')
  assert.ok(!fs.existsSync(checkpointClipPath), 'использованный чекпоинт должен быть удалён после склейки')

  const durationStr = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', outputPath
  ]).toString().trim()
  const duration = parseFloat(durationStr)
  // ~4с чекпоинта + ~4с конца сделки — заметно больше, чем 10с (весь буфер) или
  // просто клэмп по границам буфера при 400-секундной сделке
  assert.ok(duration > 6.5 && duration < 9.5, `длительность склеенного клипа должна быть ~8с, получено ${duration}`)

  console.log('[OK] testClipperStitchesWithCheckpoint')
}

// Чекпоинт был сделан на всякий случай (сработал таймер), но сделка всё же
// уложилась в буфер — чекпоинт должен быть тихо отброшен, поведение как обычно.
async function testClipperDiscardsUnneededCheckpoint() {
  const assetsDir = path.join(__dirname, '..', 'test-assets')
  const replayPath = path.join(assetsDir, 'fake-replay.mkv')
  const nowMs = Date.now()
  fs.utimesSync(replayPath, new Date(nowMs), new Date(nowMs))

  const unusedCheckpointPath = path.join(assetsDir, 'clips-ci', 'unused-checkpoint.mp4')
  fs.mkdirSync(path.dirname(unusedCheckpointPath), { recursive: true })
  fs.writeFileSync(unusedCheckpointPath, 'не настоящее видео, просто маркер файла')

  const trade = { symbol: 'SHORTUSDT', side: 'SHORT', entryTimeMs: nowMs - 7000, exitTimeMs: nowMs - 2000 }
  const outputDir = path.join(assetsDir, 'clips-ci')
  const outputPath = await createClipFromReplay({
    replayPath,
    trade,
    paddingBeforeSec: 1,
    paddingAfterSec: 1,
    outputDir,
    entryCheckpointClipPath: unusedCheckpointPath,
    checkpointExitSnippetSec: 3
  })

  assert.ok(fs.existsSync(outputPath), 'клип должен быть создан как обычно')
  assert.ok(!fs.existsSync(unusedCheckpointPath), 'ненужный чекпоинт должен быть удалён')

  const durationStr = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', outputPath
  ]).toString().trim()
  const duration = parseFloat(durationStr)
  assert.ok(duration > 6 && duration < 8, `длительность клипа должна быть ~7с как обычно, получено ${duration}`)

  console.log('[OK] testClipperDiscardsUnneededCheckpoint')
}

// Разбивка кадра на равные части: 3440/6 не делится ровно, последний стакан
// должен забрать остаток.
function testGetStakanBounds() {
  const wide = { screenWidth: 3440, screenHeight: 1440, stakanCount: 6 }
  assert.deepStrictEqual(getStakanBounds(1, wide), { x: 0, width: 573, height: 1440 })
  assert.deepStrictEqual(getStakanBounds(6, wide), { x: 2865, width: 575, height: 1440 })

  // Размер экрана больше нигде не зашит: на записи другого монитора части
  // должны считаться от её собственного кадра. Раньше тут стояли 3440x1440 по
  // умолчанию, и на записи 1920x1080 обрезка уходила за пределы кадра.
  const full = { screenWidth: 1920, screenHeight: 1080, stakanCount: 3 }
  assert.deepStrictEqual(getStakanBounds(1, full), { x: 0, width: 640, height: 1080 })
  assert.deepStrictEqual(getStakanBounds(3, full), { x: 1280, width: 640, height: 1080 })

  // Без размера кадра делить нечего — это ошибка, а не повод что-то выдумать
  assert.throws(() => getStakanBounds(1, { stakanCount: 6 }), /размер кадра/)
  assert.throws(() => getStakanBounds(1), /размер кадра/)

  console.log('[OK] testGetStakanBounds')
}

// Реальная обрезка по ширине через ffmpeg — переиспользуем fake-replay.mkv
// (320x240) с "экраном" 320x240/4 стакана (делится ровно, чистые числа).
// Проверяем и что клип попадает в отдельную папку outputBaseDir/ГГГГ-ММ-ДД
// (день берётся из mtime исходного файла).
async function testCropClipToStakan() {
  const replayPath = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')
  const nowMs = Date.now()
  fs.utimesSync(replayPath, new Date(nowMs), new Date(nowMs))

  const outputBaseDir = path.join(__dirname, '..', 'test-assets', 'clips-stakan-ci')
  const options = { screenWidth: 320, screenHeight: 240, stakanCount: 4 }

  const outputPath = await cropClipToStakan(replayPath, 2, outputBaseDir, options)
  assert.ok(outputPath.includes('stakan2'), 'имя файла должно содержать пометку stakan2')
  assert.ok(fs.existsSync(outputPath), 'обрезанный по ширине клип должен быть создан')

  const expectedDir = buildDailyOutputDir(outputBaseDir, nowMs)
  assert.strictEqual(path.dirname(outputPath), expectedDir, 'клип по стакану должен лежать в outputBaseDir/ГГГГ-ММ-ДД')

  const dimsStr = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', outputPath
  ]).toString().trim()
  assert.strictEqual(dimsStr, '80x240', `размеры обрезанного клипа должны быть 80x240 (стакан 2 из 4), получено ${dimsStr}`)

  fs.unlinkSync(outputPath)
  console.log('[OK] testCropClipToStakan')
}

// Синтетический источник с двумя аудиодорожками разного числа каналов —
// дорожка 1 (индекс 0) стерео, дорожка 2 (индекс 1) моно. Число каналов
// переживает stream copy в mp4 (в отличие от тегов title, которые mp4-мьюксер
// не сохраняет), поэтому по нему и проверяем, какая дорожка куда попала.
function ensureDualAudioFixture() {
  const assetsDir = path.join(__dirname, '..', 'test-assets')
  const fixturePath = path.join(assetsDir, 'fake-replay-dual-audio.mkv')
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=10:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=10',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac:a:0', '2', '-ac:a:1', '1',
    '-shortest',
    fixturePath
  ])
  return fixturePath
}

function getAudioChannelCounts(filePath) {
  const csv = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=channels', '-of', 'csv=p=0',
    filePath
  ]).toString().trim()
  return csv.split(/\r?\n/).filter(Boolean).map(Number)
}

// Основной клип должен сохранять ОБЕ дорожки (дорожка 1 — раб. стол+микрофон,
// дорожка 2 — только раб. стол), причём дорожка 1 первой (проигрывается по
// умолчанию), чтобы дорожка 2 была доступна позже для обрезки по стакану.
async function testClipperKeepsBothAudioTracks() {
  const replayPath = ensureDualAudioFixture()
  const nowMs = Date.now()
  fs.utimesSync(replayPath, new Date(nowMs), new Date(nowMs))

  const trade = { symbol: 'AUDIOUSDT', side: 'LONG', entryTimeMs: nowMs - 7000, exitTimeMs: nowMs - 2000 }
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-ci')
  const outputPath = await createClipFromReplay({
    replayPath, trade, paddingBeforeSec: 1, paddingAfterSec: 1, outputDir
  })

  const channels = getAudioChannelCounts(outputPath)
  assert.deepStrictEqual(channels, [2, 1], `клип должен сохранять обе дорожки в порядке [стерео, моно], получено ${channels}`)

  console.log('[OK] testClipperKeepsBothAudioTracks')
}

// Обрезка по стакану должна брать именно дорожку 2 (моно, только раб. стол),
// а не дорожку 1 (стерео, раб. стол + микрофон).
async function testCropClipToStakanSelectsTrack2() {
  const replayPath = ensureDualAudioFixture()
  const nowMs = Date.now()
  fs.utimesSync(replayPath, new Date(nowMs), new Date(nowMs))

  const trade = { symbol: 'AUDIOUSDT2', side: 'SHORT', entryTimeMs: nowMs - 7000, exitTimeMs: nowMs - 2000 }
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-ci')
  const clipPath = await createClipFromReplay({
    replayPath, trade, paddingBeforeSec: 1, paddingAfterSec: 1, outputDir
  })

  const stakanOutputDir = path.join(__dirname, '..', 'test-assets', 'clips-stakan-ci')
  const croppedPath = await cropClipToStakan(clipPath, 2, stakanOutputDir, { screenWidth: 320, screenHeight: 240, stakanCount: 4 })
  const channels = getAudioChannelCounts(croppedPath)
  assert.deepStrictEqual(channels, [1], `клип по стакану должен содержать только дорожку 2 (моно), получено ${channels}`)

  fs.unlinkSync(croppedPath)
  console.log('[OK] testCropClipToStakanSelectsTrack2')
}

// Пересчёт рамки, выделенной мышью, под реальный кадр файла.
// Единственное место в программе, которое удаляет уже готовые файлы, — поэтому
// проверяем оба режима на настоящих файлах, а не на заглушках.
function makeMergedPartsFixture(name) {
  const dir = path.join(__dirname, '..', 'test-assets', name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const clips = ['a.mp4', 'b.mp4', 'c.mp4'].map((file) => {
    const full = path.join(dir, file)
    fs.writeFileSync(full, 'x')
    return full
  })
  const mergedClipPath = path.join(dir, 'COMBO.mp4')
  fs.writeFileSync(mergedClipPath, 'x')

  return {
    dir,
    mergedClipPath,
    batch: { trades: clips.map((clipPath) => ({ symbol: 'TESTUSDT', clipPath })) },
    // История ссылается на те же файлы плюс на сам общий клип
    recentClips: [
      { clipPath: mergedClipPath, label: 'COMBO' },
      ...clips.map((clipPath) => ({ clipPath, label: path.basename(clipPath) }))
    ]
  }
}

// По умолчанию отдельные клипы серии удаляются: иначе серия из пяти сделок
// оставляет шесть файлов об одном и том же.
async function testMergedPartsDeletedByDefault() {
  const fixture = makeMergedPartsFixture('merged-parts-delete')
  let notified = null

  await handleMergedParts({
    batch: fixture.batch,
    mergedClipPath: fixture.mergedClipPath,
    config: { clip: { keepMergedParts: 0, mergedPartsSubdir: 'parts' } },
    log: () => {},
    recentClips: fixture.recentClips,
    onHistoryChanged: (clips) => { notified = clips }
  })

  const left = fs.readdirSync(fixture.dir)
  assert.deepStrictEqual(left, ['COMBO.mp4'], `в папке должен остаться только общий клип, осталось ${left}`)

  // Ссылки на удалённые файлы обязаны уйти из истории: иначе обрезка из этой
  // сделки потом искала бы то, чего нет.
  assert.strictEqual(fixture.recentClips.length, 1, 'в истории должен остаться только общий клип')
  assert.strictEqual(fixture.recentClips[0].clipPath, fixture.mergedClipPath)
  assert.ok(notified, 'об изменении истории надо сообщить наружу')
  assert.strictEqual(notified.length, 1)

  fs.rmSync(fixture.dir, { recursive: true, force: true })
  console.log('[OK] testMergedPartsDeletedByDefault')
}

// Определение области, в которой шла сделка.
//
// Кадр рисуем сами: серый интерфейс во всю площадь и цветная полоса внизу
// одной из колонок — ровно так выглядит панель с открытой позицией.
function makeFrame(width, height, vividColumns) {
  const data = new Uint8Array(width * height * 4)
  // Серый фон: каналы близки друг к другу, насыщенным такое не считается
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 60
    data[i * 4 + 1] = 62
    data[i * 4 + 2] = 66
    data[i * 4 + 3] = 255
  }

  const columnWidth = Math.floor(width / 6)
  for (const { index, fromRatio } of vividColumns) {
    const stripTop = Math.round(height * fromRatio)
    for (let y = stripTop; y < height; y++) {
      for (let x = index * columnWidth; x < (index + 1) * columnWidth; x++) {
        const i = (y * width + x) * 4
        data[i] = 200 // насыщенно-красная плашка
        data[i + 1] = 50
        data[i + 2] = 50
      }
    }
  }
  return { width, height, data }
}

function makeAreas(width, height) {
  const columnWidth = Math.floor(width / 6)
  return Array.from({ length: 6 }, (_, k) => ({
    name: `Стакан ${k + 1}`,
    x: k * columnWidth,
    y: 0,
    width: columnWidth,
    height,
    sourceWidth: width,
    sourceHeight: height
  }))
}

function testDetectAreaInFrame() {
  const { detectAreaInFrame, pickAreaByVotes } = require('../src/tradeAreaDetect')
  const width = 1200
  const height = 600
  const areas = makeAreas(width, height)

  // Полоса в четвёртой колонке — её и должно найти, уверенно.
  const one = detectAreaInFrame(makeFrame(width, height, [{ index: 3, fromRatio: 0.96 }]), areas)
  assert.strictEqual(one.name, 'Стакан 4')
  assert.strictEqual(one.confident, true, `должно быть уверенно, а вышло ${JSON.stringify(one)}`)

  // Две открытые позиции — две полосы. Выбирать между ними нельзя: тикер мы не
  // читаем, а вырезать чужую монету под видом своей хуже, чем не вырезать.
  const two = detectAreaInFrame(
    makeFrame(width, height, [{ index: 1, fromRatio: 0.96 }, { index: 4, fromRatio: 0.96 }]),
    areas
  )
  assert.strictEqual(two.confident, false, 'при двух одинаковых полосах уверенности быть не должно')

  // Полос нет вовсе — тоже честное "не знаю", а не случайная колонка.
  const none = detectAreaInFrame(makeFrame(width, height, []), areas)
  assert.strictEqual(none.confident, false, 'без цветных полос уверенности быть не должно')

  // Одна область — сравнивать не с чем, и "определение" было бы самообманом
  assert.strictEqual(detectAreaInFrame(makeFrame(width, height, []), areas.slice(0, 1)), null)

  console.log('[OK] testDetectAreaInFrame')
}

// Голосование по нескольким кадрам: один кадр мог попасть на моргание.
function testPickAreaByVotes() {
  const { pickAreaByVotes } = require('../src/tradeAreaDetect')

  const sure = (name) => ({ name, confident: true, score: 0.2, runnerUp: 0.01 })
  const unsure = (name) => ({ name, confident: false, score: 0.01, runnerUp: 0.01 })

  assert.strictEqual(pickAreaByVotes([sure('Стакан 2'), sure('Стакан 2'), unsure('Стакан 5')]), 'Стакан 2',
    'два уверенных голоса из трёх — этого достаточно')
  assert.strictEqual(pickAreaByVotes([unsure('Стакан 1'), null, unsure('Стакан 3')]), null,
    'без единого уверенного голоса ответа быть не должно')
  assert.strictEqual(pickAreaByVotes([sure('Стакан 1'), sure('Стакан 4')]), null,
    'ничья между разными областями — это тот самый случай, когда угадывать нельзя')
  assert.strictEqual(pickAreaByVotes([]), null)

  console.log('[OK] testPickAreaByVotes')
}

// Область, вырезанная автоматически, не должна пережить свой клип.
//
// Иначе от серии из трёх сделок остаётся один общий клип — и три области от
// каждой сделки по отдельности, то есть ровно та каша, ради избавления от
// которой сделки и объединяются.
async function testAutoCropsDieWithTheirClips() {
  const fixture = makeMergedPartsFixture('merged-parts-autocrop')

  // К каждому отдельному клипу — своя автоматически вырезанная область,
  // и отдельно область общего клипа: она уцелеть обязана.
  const cropOf = new Map()
  for (const entry of fixture.recentClips) {
    const cropPath = entry.clipPath.replace(/\.mp4$/, '-область.mp4')
    fs.writeFileSync(cropPath, 'x')
    entry.autoCropPath = cropPath
    cropOf.set(entry.clipPath, cropPath)
  }

  await handleMergedParts({
    batch: fixture.batch,
    mergedClipPath: fixture.mergedClipPath,
    config: { clip: { keepMergedParts: 0, mergedPartsSubdir: 'parts' } },
    log: () => {},
    recentClips: fixture.recentClips,
    onHistoryChanged: () => {}
  })

  const left = fs.readdirSync(fixture.dir).sort()
  assert.deepStrictEqual(left, ['COMBO-область.mp4', 'COMBO.mp4'],
    `должны остаться только общий клип и его область, осталось ${left}`)
  assert.strictEqual(fixture.recentClips.length, 1, 'в истории должен остаться только общий клип')
  assert.strictEqual(fixture.recentClips[0].autoCropPath, cropOf.get(fixture.mergedClipPath),
    'область общего клипа обязана уцелеть')

  fs.rmSync(fixture.dir, { recursive: true, force: true })
  console.log('[OK] testAutoCropsDieWithTheirClips')
}

// Полный клип могли удалить сразу после автоматической обрезки — тогда при
// объединении серии удалять уже нечего, и жаловаться на это не на что.
async function testMergedPartsSurviveAlreadyDeletedClips() {
  const fixture = makeMergedPartsFixture('merged-parts-gone')
  const complaints = []

  // Так выглядит включённое "удалять полный клип после обрезки": файлов уже нет
  for (const trade of fixture.batch.trades) fs.unlinkSync(trade.clipPath)

  await handleMergedParts({
    batch: fixture.batch,
    mergedClipPath: fixture.mergedClipPath,
    config: { clip: { keepMergedParts: 0, mergedPartsSubdir: 'parts' } },
    log: (message) => { if (/Не удалось/.test(message)) complaints.push(message) },
    recentClips: fixture.recentClips,
    onHistoryChanged: () => {}
  })

  assert.deepStrictEqual(complaints, [], `жалоб быть не должно, а они есть: ${complaints.join(' | ')}`)
  assert.strictEqual(fixture.recentClips.length, 1, 'история всё равно должна забыть удалённые клипы')

  fs.rmSync(fixture.dir, { recursive: true, force: true })
  console.log('[OK] testMergedPartsSurviveAlreadyDeletedClips')
}

// С включённой галкой ничего не удаляется — клипы переезжают в подпапку, а
// история начинает ссылаться на новое место.
async function testMergedPartsMovedWhenKept() {
  const fixture = makeMergedPartsFixture('merged-parts-keep')

  await handleMergedParts({
    batch: fixture.batch,
    mergedClipPath: fixture.mergedClipPath,
    config: { clip: { keepMergedParts: 1, mergedPartsSubdir: 'parts' } },
    log: () => {},
    recentClips: fixture.recentClips,
    onHistoryChanged: () => {}
  })

  assert.deepStrictEqual(fs.readdirSync(fixture.dir).sort(), ['COMBO.mp4', 'parts'])
  assert.deepStrictEqual(fs.readdirSync(path.join(fixture.dir, 'parts')).sort(), ['a.mp4', 'b.mp4', 'c.mp4'])

  assert.strictEqual(fixture.recentClips.length, 4, 'история не должна терять записи')
  for (const entry of fixture.recentClips.slice(1)) {
    assert.ok(entry.clipPath.includes('parts'), `история должна указывать на новое место: ${entry.clipPath}`)
    assert.ok(fs.existsSync(entry.clipPath), 'файл по новому пути обязан существовать')
  }

  fs.rmSync(fixture.dir, { recursive: true, force: true })
  console.log('[OK] testMergedPartsMovedWhenKept')
}

// Пустое имя подпапки при включённой галке — "оставить рядом с общим клипом".
// Ничего не удаляем и не двигаем.
async function testMergedPartsKeptInPlace() {
  const fixture = makeMergedPartsFixture('merged-parts-inplace')

  await handleMergedParts({
    batch: fixture.batch,
    mergedClipPath: fixture.mergedClipPath,
    config: { clip: { keepMergedParts: 1, mergedPartsSubdir: '' } },
    log: () => {},
    recentClips: fixture.recentClips,
    onHistoryChanged: () => {}
  })

  assert.deepStrictEqual(fs.readdirSync(fixture.dir).sort(), ['COMBO.mp4', 'a.mp4', 'b.mp4', 'c.mp4'])
  assert.strictEqual(fixture.recentClips.length, 4)

  fs.rmSync(fixture.dir, { recursive: true, force: true })
  console.log('[OK] testMergedPartsKeptInPlace')
}

function testResolveCropRect() {
  // Обычный случай: рамка снята на этом же размере и уже чётная
  assert.deepStrictEqual(
    resolveCropRect({ x: 100, y: 50, width: 400, height: 300, sourceWidth: 1920, sourceHeight: 1080 }, 1920, 1080),
    { x: 100, y: 50, width: 400, height: 300 }
  )

  // Нечётные числа H.264 не примет — округляем вниз, чтобы не вылезти за кадр
  assert.deepStrictEqual(
    resolveCropRect({ x: 101, y: 51, width: 401, height: 301, sourceWidth: 1920, sourceHeight: 1080 }, 1920, 1080),
    { x: 100, y: 50, width: 400, height: 300 }
  )

  // Пресет снят на 3440x1440, применяем к 1720x720 — ровно половина
  assert.deepStrictEqual(
    resolveCropRect({ x: 400, y: 200, width: 600, height: 400, sourceWidth: 3440, sourceHeight: 1440 }, 1720, 720),
    { x: 200, y: 100, width: 300, height: 200 }
  )

  // Рамка шире кадра — прижимаем к границе, а не отдаём ffmpeg заведомо
  // невыполнимый crop (он на этом падает, а не обрезает молча)
  assert.deepStrictEqual(
    resolveCropRect({ x: 1800, y: 1000, width: 999, height: 999, sourceWidth: 1920, sourceHeight: 1080 }, 1920, 1080),
    { x: 1800, y: 1000, width: 120, height: 80 }
  )

  // Рамка целиком за кадром — это рамка не от этого файла. Прижимать её к
  // краю нельзя: вышла бы полоска в пару пикселей вместо понятного отказа.
  assert.strictEqual(resolveCropRect({ x: 5000, y: 0, width: 100, height: 100, sourceWidth: 1920, sourceHeight: 1080 }, 1920, 1080), undefined)
  // Остаток от края меньше разумного минимума — тоже отказ
  assert.strictEqual(resolveCropRect({ x: 1915, y: 0, width: 100, height: 100, sourceWidth: 1920, sourceHeight: 1080 }, 1920, 1080), undefined)
  assert.strictEqual(resolveCropRect({ x: 0, y: 0, width: 0, height: 100 }, 1920, 1080), undefined)
  assert.strictEqual(resolveCropRect(null, 1920, 1080), undefined)

  // Без размера исходной записи считаем, что рамка уже в нужных пикселях
  assert.deepStrictEqual(
    resolveCropRect({ x: 10, y: 10, width: 100, height: 100 }, 1920, 1080),
    { x: 10, y: 10, width: 100, height: 100 }
  )

  // Имя пресета попадает в имя файла — чистим от запрещённого в Windows
  assert.strictEqual(sanitizePresetName('Левый стакан'), 'Левый стакан')
  assert.strictEqual(sanitizePresetName('a/b:c*?"<>|'), 'abc')
  assert.strictEqual(sanitizePresetName('   '), '')

  console.log('[OK] testResolveCropRect')
}

// Обрезка по произвольной рамке: кадр должен получиться ровно заданного
// размера, а не по арифметике стаканов.
async function testCropClipByRect() {
  const replayPath = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-stakan-ci')

  // Исходник 320x240; берём кусок со смещением, заодно с нечётными числами
  const outputPath = await cropClipToStakan(replayPath, null, outputDir, {
    cropRect: { x: 31, y: 21, width: 161, height: 101, sourceWidth: 320, sourceHeight: 240 },
    cropPresetName: 'Левый стакан'
  })

  assert.ok(path.basename(outputPath).includes('Левый стакан'), 'имя пресета должно попадать в имя файла')

  const size = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', outputPath
  ]).toString().trim()
  assert.strictEqual(size, '160,100', `рамка должна округлиться до чётных, получено ${size}`)

  fs.unlinkSync(outputPath)
  console.log('[OK] testCropClipByRect')
}

// Рисует кадр, похожий по устройству на экран терминала: полоса заголовков
// сверху, под ней "таблицы" с внутренними вертикальными линиями. Настоящий
// торговый экран в репозиторий класть незачем — важна именно структура.
function drawFakeTerminalFrame({ width, height, panelBoundaries, headerTop, headerHeight }) {
  const data = new Uint8Array(width * height * 4)
  const setPixel = (x, y, value) => {
    const offset = (y * width + x) * 4
    data[offset] = value; data[offset + 1] = value; data[offset + 2] = value; data[offset + 3] = 255
  }

  for (let y = 0; y < height; y++) {
    const inHeader = y >= headerTop && y < headerTop + headerHeight
    for (let x = 0; x < width; x++) setPixel(x, y, inHeader ? 60 : 30)
  }

  // Границы панелей идут через ВСЮ высоту, как в настоящем терминале
  for (const boundary of panelBoundaries) {
    for (let y = 0; y < height; y++) setPixel(boundary, y, 200)
  }

  // Внутренние линии таблиц: они есть только НИЖЕ заголовка. Именно из-за них
  // поиск по всей высоте кадра даёт лишние линии, а по полосе заголовков — нет.
  for (const boundary of panelBoundaries) {
    const inner = boundary + 40
    if (inner >= width) continue
    for (let y = headerTop + headerHeight; y < height; y++) setPixel(inner, y, 190)
  }

  return { data, width, height }
}

// Поиск границ панелей по кадру: внутренние линии таблиц не должны попадать
// в лучший вариант, иначе рамка липла бы к середине стакана.
function testDetectPanelGuides() {
  const panelBoundaries = [0, 300, 600, 900, 1200, 1500]
  const frame = drawFakeTerminalFrame({
    width: 1800, height: 900, panelBoundaries, headerTop: 100, headerHeight: 30
  })

  const guides = detectPanelGuides(frame)

  assert.ok(guides.variants.length > 0, 'варианты границ должны найтись')
  // Линия рисуется в столбце boundary, перепад виден на boundary-1
  const expected = panelBoundaries.filter((x) => x > 0).map((x) => x - 1)
  const best = guides.vertical
  for (const boundary of expected) {
    assert.ok(best.some((line) => Math.abs(line - boundary) <= 2),
      `граница ${boundary} должна попасть в лучший вариант, найдено ${JSON.stringify(best)}`)
  }
  // Внутренние линии таблиц в лучшем варианте появляться не должны
  for (const boundary of panelBoundaries) {
    assert.ok(!best.some((line) => Math.abs(line - (boundary + 40)) <= 2),
      `внутренняя линия ${boundary + 40} не должна считаться границей панели`)
  }

  // Слишком узкие "панели" отсекаются: набор из одних внутренних линий
  // неправдоподобен и в варианты не попадает
  for (const variant of guides.variants) {
    const gaps = variant.slice(1).map((x, index) => x - variant[index])
    assert.ok(gaps.every((gap) => gap >= frame.width * 0.025),
      `в варианте ${JSON.stringify(variant)} есть подозрительно узкая панель`)
  }

  // Горизонтальные линии тоже нужны — по ним прилипают верх и низ рамки
  assert.ok(guides.horizontal.some((y) => Math.abs(y - 100) <= 2), 'верх полосы заголовков должен найтись')

  console.log('[OK] testDetectPanelGuides')
}

// Кадр без единой линии не должен давать выдуманных границ.
// Бледные разделители — светлая тема терминала.
//
// Так выглядела настоящая поломка у стороннего пользователя: на его светлой
// теме перепад между панелью и разделителем всего несколько единиц яркости,
// строгий порог его не замечал, и границы не находились вообще. Причём просто
// опустить порог нельзя — на тёмной теме тогда в находки лезет разметка внутри
// стакана. Поэтому попытки идут лесенкой, и проверяем мы именно это: что
// мягкая попытка подхватывает то, на чём строгая молчит.
function testDetectPanelGuidesOnPaleTheme() {
  const width = 1200
  const height = 400
  const BACKGROUND = 210
  const SEPARATOR = 203 // всего на 7 темнее фона: строгий порог 12 это пропускает
  const columns = [0, 300, 600, 900, 1199]

  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = columns.includes(x) ? SEPARATOR : BACKGROUND
      const i = (y * width + x) * 4
      data[i] = value
      data[i + 1] = value
      data[i + 2] = value
      data[i + 3] = 255
    }
  }

  const guides = detectPanelGuides({ width, height, data })
  assert.ok(guides.vertical.length >= 4,
    `бледные разделители должны находиться, а найдено линий: ${guides.vertical.length}`)

  // Линии обязаны лечь на сами разделители, а не куда-то рядом
  for (const expected of [300, 600, 900]) {
    const hit = guides.vertical.some((line) => Math.abs(line - expected) <= 3)
    assert.ok(hit, `разделитель на ${expected} не найден: ${guides.vertical.join(', ')}`)
  }

  console.log('[OK] testDetectPanelGuidesOnPaleTheme')
}

function testDetectPanelGuidesOnBlankFrame() {
  const width = 400
  const height = 300
  const data = new Uint8Array(width * height * 4).fill(40)
  for (let i = 3; i < data.length; i += 4) data[i] = 255

  const guides = detectPanelGuides({ data, width, height })
  assert.deepStrictEqual(guides.vertical, [], 'на пустом кадре границ быть не должно')
  assert.deepStrictEqual(guides.variants, [])

  console.log('[OK] testDetectPanelGuidesOnBlankFrame')
}

// Разметка TigerTrade: у панели рамка нарисована двумя линиями подряд, а
// внутри панели своя вертикальная линия — между графиком и лестницей заявок.
// Она идёт во всю высоту, то есть от настоящей границы неотличима ничем, кроме
// шага сетки.
//
// Так выглядела вторая поломка у стороннего пользователя. На четырёх записях
// автора детектор выдавал 2, 6 и 18 колонок там, где их 12: каждая рамка
// считалась за две границы, а внутренние линии подмешивались к настоящим.
function testDetectPanelGuidesWithInnerDividers() {
  const width = 1440
  const height = 600
  const PITCH = 120
  const BACKGROUND = 60
  const LINE = 20

  const columns = new Set()
  let panel = 0
  for (let x = 0; x <= width - PITCH; x += PITCH) {
    columns.add(x)
    columns.add(x + 6) // вторая линия рамки
    // Внутренняя линия есть не у каждой панели: у одних стакан открыт на
    // графике, у других нет. На живой записи TigerTrade таких оказалось шесть
    // из двенадцати — столько же берём и здесь.
    if (panel % 2 === 0) columns.add(x + 70)
    panel++
  }

  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const value = columns.has(x) ? LINE : BACKGROUND
      data[i] = value
      data[i + 1] = value
      data[i + 2] = value
      data[i + 3] = 255
    }
  }

  const guides = detectPanelGuides({ data, width, height })
  const gaps = guides.vertical.slice(1).map((x, index) => x - guides.vertical[index])

  assert.ok(gaps.length >= 10,
    `должна найтись сетка из дюжины панелей, а найдено промежутков: ${gaps.length} (${guides.vertical.join(', ')})`)
  for (const gap of gaps) {
    assert.ok(Math.abs(gap - PITCH) <= 8,
      `промежуток ${gap} не похож на шаг сетки ${PITCH}: ${guides.vertical.join(', ')}`)
  }
  // Ни одна внутренняя линия не должна попасть в ответ
  for (let x = 70; x < width; x += PITCH) {
    assert.ok(!guides.vertical.some((line) => Math.abs(line - x) <= 3),
      `внутренняя линия ${x} не должна считаться границей панели: ${guides.vertical.join(', ')}`)
  }

  console.log('[OK] testDetectPanelGuidesWithInnerDividers')
}

// Имя файла, заданное в окне. Приходит от пользователя, поэтому проверяем
// именно то, чем можно навредить: разделители пути и запрещённые символы.
function testSanitizeOutputFileName() {
  assert.strictEqual(sanitizeOutputFileName('Мой клип'), 'Мой клип.mp4')
  assert.strictEqual(sanitizeOutputFileName('Мой клип.mp4'), 'Мой клип.mp4')
  assert.strictEqual(sanitizeOutputFileName('клип.MP4'), 'клип.MP4', 'своё расширение не дублируем')
  // Разделителями пути можно было бы уехать из папки назначения
  assert.strictEqual(sanitizeOutputFileName('..\\..\\система\\клип'), 'системаклип.mp4')
  assert.strictEqual(sanitizeOutputFileName('a:b*c?d"e<f>g|h'), 'abcdefgh.mp4')
  assert.strictEqual(sanitizeOutputFileName('   '), '', 'пустое имя — значит составить самим')
  assert.strictEqual(sanitizeOutputFileName(undefined), '')

  console.log('[OK] testSanitizeOutputFileName')
}

// Заданное имя должно попадать в файл, а повтор имени — не затирать прошлую
// нарезку молча.
async function testCropClipUsesGivenNameAndKeepsPrevious() {
  const replayPath = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-stakan-ci')

  const first = await cropClipToStakan(replayPath, null, outputDir, {
    speedFactor: 2, outputFileName: 'Разбор сделки'
  })
  assert.strictEqual(path.basename(first), 'Разбор сделки.mp4')

  const second = await cropClipToStakan(replayPath, null, outputDir, {
    speedFactor: 2, outputFileName: 'Разбор сделки'
  })
  assert.strictEqual(path.basename(second), 'Разбор сделки (2).mp4', 'второй файл не должен затирать первый')
  assert.ok(fs.existsSync(first), 'первый файл обязан остаться на месте')

  fs.unlinkSync(first)
  fs.unlinkSync(second)
  console.log('[OK] testCropClipUsesGivenNameAndKeepsPrevious')
}

// Кнопка "Без звука": в результате не должно остаться ни одной аудиодорожки.
// Проверяем вместе с ускорением — при mute цепочка atempo не нужна и не должна
// ломать вызов ffmpeg.
async function testCropClipMuteDropsAudio() {
  const replayPath = ensureDualAudioFixture()
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-stakan-ci')

  const outputPath = await cropClipToStakan(replayPath, null, outputDir, { speedFactor: 2, mute: true })

  assert.ok(path.basename(outputPath).includes('mute'), 'в имени должна быть пометка mute')
  assert.deepStrictEqual(getAudioChannelCounts(outputPath), [], 'аудиодорожек остаться не должно')

  fs.unlinkSync(outputPath)
  console.log('[OK] testCropClipMuteDropsAudio')
}

// Стакан выбирать необязательно: бывает нужно просто ускорить клип, оставив
// кадр целиком. stakanIndex = null — кадр не режется по ширине, но скорость и
// обрезка краёв работают как обычно.
async function testCropClipWithoutStakanKeepsFullFrame() {
  const replayPath = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-stakan-ci')

  const outputPath = await cropClipToStakan(replayPath, null, outputDir, { speedFactor: 2 })

  assert.ok(!path.basename(outputPath).includes('stakan'), 'в имени не должно быть пометки стакана')
  assert.ok(path.basename(outputPath).includes('x2'), 'в имени должна остаться пометка скорости')

  const size = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', outputPath
  ]).toString().trim()
  assert.strictEqual(size, '320,240', `кадр должен остаться целым, получено ${size}`)

  const durationSec = Number(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', outputPath
  ]).toString().trim())
  assert.ok(Math.abs(durationSec - 5) < 0.6, `ускорение x2 должно дать ~5с из 10с, получено ${durationSec}`)

  fs.unlinkSync(outputPath)
  console.log('[OK] testCropClipWithoutStakanKeepsFullFrame')
}

// Три "сделки" подряд по одному символу, весь диапазон (вход первой — выход
// последней) укладывается в 10-секундный буфер fake-replay.mkv — объединённый
// клип должен быть создан и покрывать весь диапазон.
async function testCreateMergedClipFromReplayWithinBounds() {
  const replayPath = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')
  const nowMs = Date.now()
  fs.utimesSync(replayPath, new Date(nowMs), new Date(nowMs))

  const trades = [
    { symbol: 'COMBOUSDT', side: 'LONG', entryTimeMs: nowMs - 9000, exitTimeMs: nowMs - 7000 },
    { symbol: 'COMBOUSDT', side: 'LONG', entryTimeMs: nowMs - 6000, exitTimeMs: nowMs - 5000 },
    { symbol: 'COMBOUSDT', side: 'SHORT', entryTimeMs: nowMs - 4000, exitTimeMs: nowMs - 2000 }
  ]
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-ci')

  const outputPath = await createMergedClipFromReplay({
    replayPath, trades, paddingBeforeSec: 1, paddingAfterSec: 1, outputDir
  })
  assert.ok(outputPath, 'объединённый клип должен быть создан, если весь диапазон помещается в буфер')
  assert.ok(outputPath.includes('COMBOx3'), 'имя файла должно содержать пометку COMBOx3')
  assert.ok(fs.existsSync(outputPath), 'файл объединённого клипа должен существовать')

  const durationStr = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', outputPath
  ]).toString().trim()
  const duration = parseFloat(durationStr)
  // От (вход1 - 1с паддинга) до (выход3 + 1с паддинга) = 9с - 0с = 9с
  assert.ok(duration > 8 && duration < 10, `длительность объединённого клипа должна быть ~9с, получено ${duration}`)

  console.log('[OK] testCreateMergedClipFromReplayWithinBounds')
}

// Диапазон между первой и последней сделкой пачки не помещается в буфер целиком —
// в отличие от одиночных сделок здесь НЕ клэмпаем, а просто не создаём клип.
async function testCreateMergedClipFromReplayOutOfBoundsSkips() {
  const replayPath = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')
  const nowMs = Date.now()
  fs.utimesSync(replayPath, new Date(nowMs), new Date(nowMs))

  const trades = [
    { symbol: 'TOOBIGUSDT', side: 'LONG', entryTimeMs: nowMs - 50000, exitTimeMs: nowMs - 40000 },
    { symbol: 'TOOBIGUSDT', side: 'LONG', entryTimeMs: nowMs - 4000, exitTimeMs: nowMs - 1000 }
  ]
  const outputDir = path.join(__dirname, '..', 'test-assets', 'clips-ci')

  const outputPath = await createMergedClipFromReplay({
    replayPath, trades, paddingBeforeSec: 1, paddingAfterSec: 1, outputDir
  })
  assert.strictEqual(outputPath, null, 'если диапазон не помещается в буфер, объединённый клип не должен создаваться')

  console.log('[OK] testCreateMergedClipFromReplayOutOfBoundsSkips')
}

// Проверяет, что исходный файл реплея OBS удаляется только когда включена
// опция clip.deleteSourceReplays, и что удаление несуществующего файла не
// бросает исключение (не должно ронять уже успешно обработанную сделку).
async function testDeleteSourceReplayIfEnabled() {
  const tmpPath = path.join(__dirname, '..', 'test-assets', 'fake-source-replay.tmp')
  const noop = () => {}

  fs.writeFileSync(tmpPath, 'фиктивный реплей')
  await deleteSourceReplayIfEnabled(tmpPath, { clip: { deleteSourceReplays: true } }, noop)
  assert.ok(!fs.existsSync(tmpPath), 'при deleteSourceReplays=true исходный реплей должен быть удалён')

  fs.writeFileSync(tmpPath, 'фиктивный реплей')
  await deleteSourceReplayIfEnabled(tmpPath, { clip: { deleteSourceReplays: false } }, noop)
  assert.ok(fs.existsSync(tmpPath), 'при deleteSourceReplays=false исходный реплей должен остаться нетронутым')
  fs.unlinkSync(tmpPath)

  // Несуществующий файл — не должно бросать исключение, ошибка просто логируется
  await deleteSourceReplayIfEnabled(
    path.join(__dirname, '..', 'test-assets', 'no-such-replay.tmp'),
    { clip: { deleteSourceReplays: true } },
    noop
  )

  console.log('[OK] testDeleteSourceReplayIfEnabled')
}

function testBuildAtempoFilter() {
  assert.strictEqual(buildAtempoFilter(1.5), 'atempo=1.5')
  assert.strictEqual(buildAtempoFilter(2), 'atempo=2')
  assert.strictEqual(buildAtempoFilter(3), 'atempo=2.0,atempo=1.5')
  assert.strictEqual(buildAtempoFilter(4), 'atempo=2.0,atempo=2')

  console.log('[OK] testBuildAtempoFilter')
}

async function testCropClipToStakanWithSpeed() {
  const replayPath = path.join(__dirname, '..', 'test-assets', 'fake-replay.mkv')
  const nowMs = Date.now()
  fs.utimesSync(replayPath, new Date(nowMs), new Date(nowMs))

  const outputBaseDir = path.join(__dirname, '..', 'test-assets', 'clips-stakan-ci')
  const options = { screenWidth: 320, screenHeight: 240, stakanCount: 4, speedFactor: 2 }

  const outputPath = await cropClipToStakan(replayPath, 2, outputBaseDir, options)
  assert.ok(outputPath.includes('stakan2 x2'), 'имя файла должно содержать пометку stakan2 x2')
  assert.ok(fs.existsSync(outputPath), 'ускоренный клип по стакану должен быть создан')

  const durationStr = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', outputPath
  ]).toString().trim()
  const duration = parseFloat(durationStr)
  assert.ok(duration > 4 && duration < 6, `длительность ускоренного клипа должна быть ~5с, получено ${duration}`)

  fs.unlinkSync(outputPath)
  console.log('[OK] testCropClipToStakanWithSpeed')
}

async function main() {
  testParser()
  testExchangeInFileNames()
  testManualReplayFileName()
  testNonLatinSymbols()
  testTigerTradeParser()
  testTerminalAdapters()
  testBuildHistoryLabel()
  testBuildDailyOutputDir()
  testGetStakanBounds()
  testBuildAtempoFilter()
  await testStartDoesNotWaitForObs()
  await testObsConnectTimesOut()
  await testObsFailuresAreNotRepeatedInLog()
  await testCheckTerminalLogs()
  await testTerminalWatcherStateMachine()
  await testBatcherWaitsForOpenPosition()
  await testBatcherSplitsOnLongGap()
  await testBatcherKeepsSymbolsSeparate()
  await testBatcherClosesBatchBeforeBufferOverflow()
  await testClipperWithinBounds()
  await testClipperOutOfBoundsClamps()
  await testClipperCreatesDatedSubfolder()
  await testClipperStitchesWithCheckpoint()
  await testClipperDiscardsUnneededCheckpoint()
  await testCropClipToStakan()
  await testCropClipToStakanWithSpeed()
  await testClipperKeepsBothAudioTracks()
  await testCropClipToStakanSelectsTrack2()
  await testCropClipWithoutStakanKeepsFullFrame()
  await testCropClipMuteDropsAudio()
  await testMergedPartsDeletedByDefault()
  testDetectAreaInFrame()
  testPickAreaByVotes()
  await testAutoCropsDieWithTheirClips()
  await testMergedPartsSurviveAlreadyDeletedClips()
  await testMergedPartsMovedWhenKept()
  await testMergedPartsKeptInPlace()
  testResolveCropRect()
  await testCropClipByRect()
  testDetectPanelGuides()
  testDetectPanelGuidesOnPaleTheme()
  testDetectPanelGuidesOnBlankFrame()
  testDetectPanelGuidesWithInnerDividers()
  testSanitizeOutputFileName()
  await testCropClipUsesGivenNameAndKeepsPrevious()
  await testCreateMergedClipFromReplayWithinBounds()
  await testCreateMergedClipFromReplayOutOfBoundsSkips()
  await testDeleteSourceReplayIfEnabled()
  console.log('\nВсе тесты прошли успешно.')
}

main().catch((error) => {
  console.error('ТЕСТ ПРОВАЛЕН:', error)
  process.exit(1)
})

