const { OBSWebSocket } = require('obs-websocket-js')

// Важно: мы НЕ перезапускаем Replay Buffer автоматически,
// если он вдруг неактивен. Именно тихий авто-рестарт был причиной части багов,
// которые мы разбирали — свежий буфер после рестарта пустой, и любая сделка
// в первые N секунд после него "не помещается в окно".
// Здесь при неактивном буфере мы честно кидаем ошибку и просишь запустить его вручную.

// state: 'connecting' | 'connected' | 'disconnected' — используется треем для
// выбора иконки (зелёная/жёлтая), отдельно от текстового лога onStatus.
// Разовая проверка подключения — для помощника первой настройки.
//
// Отдельно от createObsClient специально: тому нужны переподключения, очередь
// и состояние, а здесь нужен один честный ответ по значениям, которые человек
// только что напечатал в поле и ещё никуда не сохранил. Ошибку не кидаем:
// "не подключилось" — это нормальный ответ проверки, а не сбой.
async function checkObsConnection({ url, password, timeoutMs = 8000 }) {
  const obs = new OBSWebSocket()
  const timeout = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`OBS не ответил за ${Math.round(timeoutMs / 1000)}с`)), timeoutMs)
  })

  try {
    await Promise.race([obs.connect(url, password || undefined), timeout])
  } catch (error) {
    return { connected: false, replayBufferActive: false, error: error.message }
  }

  try {
    const status = await Promise.race([obs.call('GetReplayBufferStatus'), timeout])
    return { connected: true, replayBufferActive: Boolean(status.outputActive) }
  } catch (error) {
    // Подключились, но про буфер спросить не смогли — это уже другой разговор,
    // и путать его с неудачным подключением нельзя.
    return { connected: true, replayBufferActive: false, error: error.message }
  } finally {
    try {
      await obs.disconnect()
    } catch {
      // соединение уже закрыто — проверке это безразлично
    }
  }
}

function createObsClient({ url, password, onStatus, onStatusChange, connectTimeoutMs, reconnectDelayMs }) {
  const obs = new OBSWebSocket()
  let connected = false
  let connectPromise = null
  let reconnectTimer = null
  let stopped = false
  let lastFailureMessage = null
  let repeatedFailures = 0
  let consecutiveFailures = 0
  // Сроки задаются параметрами только ради тестов — в приложении используются
  // значения по умолчанию.
  const RECONNECT_DELAY_MS = reconnectDelayMs || 5000
  // Неверный пароль сам собой не исправится, а попытки каждые пять секунд не
  // безобидны: OBS начинает отбиваться от них и рвать соединение, после чего
  // очередная попытка подвисает на рукопожатии. Ждём заметно дольше.
  const AUTH_RETRY_DELAY_MS = RECONNECT_DELAY_MS * 6
  // Верхняя граница растущей паузы. Молчащий OBS от частых попыток не
  // оживает — зато на его стороне копятся недозакрытые соединения.
  const MAX_RECONNECT_DELAY_MS = RECONNECT_DELAY_MS * 6
  // У obs-websocket-js своего срока ожидания нет: он ждёт от OBS приветствие
  // и подтверждение личности сколько угодно. Если OBS принял соединение и
  // замолчал, промис не завершится никогда — а вместе с ним встаёт всё, что
  // ждёт start(), вплоть до наглухо зависшего окна настроек.
  const CONNECT_TIMEOUT_MS = connectTimeoutMs || 10000

  const emitStatus = (message) => {
    if (onStatus) onStatus(message)
  }

  // Причина неудачи обычно одна и та же и повторяется каждые несколько секунд
  // часами. Полный текст пишем при смене причины, дальше — только счёт, иначе
  // в журнале не найти ничего, кроме неё.
  function reportFailure(message) {
    if (message === lastFailureMessage) {
      repeatedFailures++
      if (repeatedFailures % 10 === 0) {
        emitStatus(`Не удалось подключиться к OBS (повторяется, попыток подряд: ${repeatedFailures})`)
      }
      return
    }
    lastFailureMessage = message
    repeatedFailures = 1
    emitStatus(`Не удалось подключиться к OBS: ${message}`)
  }

  // Пустой или неверный пароль OBS сообщает по-разному: кодом закрытия 4009
  // либо словами про отсутствующую строку authentication.
  function isAuthFailure(error) {
    if (error && error.code === 4009) return true
    return /authentication/i.test(String((error && error.message) || ''))
  }

  // Пауза до следующей попытки. Неверный пароль сам не исправится — ждём
  // заметно дольше. В остальных случаях пауза растёт с каждой неудачей подряд:
  // если OBS не отвечает, частые попытки ничего не ускоряют, а недозакрытые
  // соединения на его стороне копятся.
  function reconnectDelayFor(error) {
    if (isAuthFailure(error)) return AUTH_RETRY_DELAY_MS
    return Math.min(RECONNECT_DELAY_MS * consecutiveFailures, MAX_RECONNECT_DELAY_MS)
  }

  const emitStateChange = (state) => {
    if (onStatusChange) onStatusChange(state)
  }

  // Не перезапускаем сам Replay Buffer (см. комментарий выше — это другая,
  // осознанно не автоматизируемая вещь), но соединение WebSocket с OBS
  // переустанавливаем сами: без этого фоновое трей-приложение просто умирало
  // бы при недоступном OBS вместо того, чтобы тихо ждать/переподключаться.
  function scheduleReconnect(delayMs = RECONNECT_DELAY_MS) {
    if (stopped || reconnectTimer) return
    emitStateChange('disconnected')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopped || connected) return
      connect().catch(() => {
        // сама connect() уже залогировала причину и перепланировала попытку
      })
    }, delayMs)
  }

  obs.on('ConnectionClosed', () => {
    if (!connected || stopped) return
    connected = false
    emitStatus('Соединение с OBS потеряно, будет переподключение')
    scheduleReconnect()
  })

  // Одна попытка подключения, но со сроком ожидания. Наполовину открытое
  // соединение по истечении срока закрываем явно: иначе такие сокеты копятся
  // с каждой попыткой, и OBS начинает отбиваться уже от их количества.
  async function connectOnce() {
    const attempt = obs.connect(url, password || undefined)
    // Если раньше сработает таймаут, гонку выиграет он, а отказ этого промиса
    // останется без обработчика — гасим его заранее.
    attempt.catch(() => {})

    let timer = null
    const timeout = new Promise((_resolve, reject) => {
      const waited = CONNECT_TIMEOUT_MS >= 1000
        ? `${Math.round(CONNECT_TIMEOUT_MS / 1000)}с`
        : `${CONNECT_TIMEOUT_MS}мс`
      timer = setTimeout(() => reject(new Error(`OBS не ответил за ${waited}`)), CONNECT_TIMEOUT_MS)
    })

    try {
      await Promise.race([attempt, timeout])
    } catch (error) {
      try {
        await obs.disconnect()
      } catch {
        // закрывать было нечего — это нормально
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function connect() {
    if (connected) return
    if (connectPromise) return connectPromise

    emitStateChange('connecting')
    connectPromise = connectOnce()
      .then(() => {
        connected = true
        lastFailureMessage = null
        repeatedFailures = 0
        consecutiveFailures = 0
        emitStatus(`Подключено к OBS WebSocket: ${url}`)
        emitStateChange('connected')
      })
      .catch((error) => {
        consecutiveFailures++
        reportFailure(error.message)
        scheduleReconnect(reconnectDelayFor(error))
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

module.exports = { createObsClient, checkObsConnection }
