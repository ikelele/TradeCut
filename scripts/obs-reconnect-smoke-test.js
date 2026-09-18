// Ручная проверка src/obsClient.js: подключение + автопереподключение.
// Запустить: node scripts/obs-reconnect-smoke-test.js
// Пока скрипт работает — выключи/включи WebSocket Server в OBS (Tools ->
// WebSocket Server Settings) или сам OBS, и посмотри, что client сам
// восстановит соединение без падения процесса.

const { loadConfig } = require('../src/config')
const { createObsClient } = require('../src/obsClient')

const config = loadConfig()

const client = createObsClient({
  url: config.obs.url,
  password: config.obs.password,
  onStatus: (msg) => console.log(`[status] ${msg}`),
  onStatusChange: (state) => console.log(`[state] -> ${state}`)
})

client.connect().catch((err) => console.log(`[initial connect failed, ожидаем автопереподключение] ${err.message}`))

process.on('SIGINT', async () => {
  console.log('Остановка...')
  await client.disconnect()
  process.exit(0)
})
