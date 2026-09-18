const { OBSWebSocket } = require('obs-websocket-js')

// Важно: мы НЕ перезапускаем Replay Buffer автоматически,
// если он вдруг неактивен. Именно тихий авто-рестарт был причиной части багов,
// которые мы разбирали — свежий буфер после рестарта пустой, и любая сделка
// в первые N секунд после него "не помещается в окно".
// Здесь при неактивном буфере мы честно кидаем ошибку и просишь запустить его вручную.

// state: 'connecting' | 'connected' | 'disconnected' — используется треем для
// выбора иконки (зелёная/жёлтая), отдельно от текстового лога onStatus.
function createObsClient({ url, password, onStatus, onStatusChange }) {
  const obs = new OBSWebSocket()
  let connected = false
  let connectPromise = null
  let reconnectTimer = null
  let stopped = false
  const RECONNECT_DELAY_MS = 5000

  const emitStatus = (message) => {
    if (onStatus) onStatus(message)
  }

  const emitStateChange = (state) => {
    if (onStatusChange) onStatusChange(state)
  }

  // Не перезапускаем сам Replay Buffer (см. комментарий выше — это другая,
  // осознанно не автоматизируемая вещь), но соединение WebSocket с OBS
  // переустанавливаем сами: без этого фоновое трей-приложение просто умирало
  // бы при недоступном OBS вместо того, чтобы тихо ждать/переподключаться.
  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    emitStateChange('disconnected')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopped || connected) return
      connect().catch(() => {
        // сама connect() уже залогировала причину и перепланировала попытку
      })
    }, RECONNECT_DELAY_MS)
  }

  obs.on('ConnectionClosed', () => {
    if (!connected || stopped) return
    connected = false
    emitStatus('Соединение с OBS потеряно, будет переподключение')
    scheduleReconnect()
  })

  async function connect() {
    if (connected) return
    if (connectPromise) return connectPromise

    emitStateChange('connecting')
    connectPromise = obs.connect(url, password || undefined)
      .then(() => {
        connected = true
        emitStatus(`Подключено к OBS WebSocket: ${url}`)
        emitStateChange('connected')
      })
      .catch((error) => {
        emitStatus(`Не удалось подключиться к OBS: ${error.message}`)
        scheduleReconnect()
        throw error
      })
      .finally(() => {
        connectPromise = null
      })
    return connectPromise
  }

  async function ensureConnected() {
    if (!connected) await connect()
  }

  async function isReplayBufferActive() {
    await ensureConnected()
    const status = await obs.call('GetReplayBufferStatus')
    return Boolean(status.outputActive)
  }

  // Сохраняет Replay Buffer и дожидается события ReplayBufferSaved от самого OBS,
  // забирая путь к файлу прямо из события — без сканирования папки на "самый новый файл".
  // Это устраняет путаницу файлов: иначе легко схватить не тот файл.
  async function saveReplayBufferAndWaitForPath(timeoutMs = 15000) {
    await ensureConnected()

    const active = await isReplayBufferActive()
    if (!active) {
      throw new Error(
        'Replay Buffer в OBS не активен. Запусти его вручную (Start Replay Buffer) — ' +
        'автоматически он здесь не перезапускается специально, чтобы не создавать пустой буфер.'
      )
    }

    const savedPathPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        obs.off('ReplayBufferSaved', onSaved)
        reject(new Error(`OBS не прислал событие ReplayBufferSaved за ${timeoutMs}мс`))
      }, timeoutMs)

      function onSaved(data) {
        clearTimeout(timer)
        obs.off('ReplayBufferSaved', onSaved)
        resolve(data.savedReplayPath)
      }

      obs.on('ReplayBufferSaved', onSaved)
    })

    await obs.call('SaveReplayBuffer')
    const savedReplayPath = await savedPathPromise
    return savedReplayPath
  }

  return {
    connect,
    isReplayBufferActive,
    saveReplayBufferAndWaitForPath,
    disconnect: async () => {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (connected) await obs.disconnect()
      connected = false
    }
  }
}

module.exports = { createObsClient }
