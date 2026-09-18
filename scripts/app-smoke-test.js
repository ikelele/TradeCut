// Ручная проверка src/app.js: старт, статус-коллбеки, потом стоп+рестарт.
// Запустить: node scripts/app-smoke-test.js

const { loadConfig } = require('../src/config')
const { createApp } = require('../src/app')

const config = loadConfig()

const app = createApp({
  config,
  log: (msg) => console.log(`[log] ${msg}`),
  onStatusChange: (state) => console.log(`[state] -> ${state}`),
  onClipReady: (trade, clipPath) => console.log(`[clip] ${trade.symbol} ${trade.side} -> ${clipPath}`),
  onIssue: (message) => console.log(`[issue] ${message}`)
})

async function main() {
  console.log('--- start() ---')
  await app.start()

  setTimeout(async () => {
    console.log('--- stop() ---')
    await app.stop()
    console.log('--- start() again (restart) ---')
    await app.start()

    setTimeout(async () => {
      console.log('--- final stop() ---')
      await app.stop()
      process.exit(0)
    }, 4000)
  }, 4000)
}

main()
