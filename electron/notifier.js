const { Notification } = require('electron')

// Раньше уведомления шли через node-notifier/SnoreToast, которому нужен был
// внешний .exe рядом со сборкой (pkg не умел встраивать его внутрь). В
// Electron нативные уведомления Windows есть из коробки — вендорный бинарник
// и вся возня с его распаковкой больше не нужны.
function createNotifier({ log }) {
  const supported = Notification.isSupported()
  if (!supported) log('Уведомления Windows недоступны в этой системе — сообщения будут только в логе')

  function safeNotify(title, body) {
    if (!supported) return
    try {
      new Notification({ title, body }).show()
    } catch (error) {
      // Уведомления — не критичный путь: ошибка здесь не должна ронять пайплайн клипов.
      log(`Не удалось показать уведомление: ${error.message}`)
    }
  }

  return {
    notifyIssue(message) {
      safeNotify('TradeCut', message)
    },
    // Ответ на повторный щелчок по ярлыку. Без него это выглядит как "программа
    // не запускается": окна у неё нет, а значок в трее легко не заметить —
    // особенно если Windows спрятала его под стрелку.
    notifyAlreadyRunning() {
      safeNotify('TradeCut уже работает', 'Значок — в области уведомлений, рядом с часами. Правый щелчок по нему открывает меню.')
    },
    notifyManualReplayReady(clipPath, durationSec) {
      const label = durationSec % 60 === 0 && durationSec >= 60
        ? `${durationSec / 60} мин`
        : `${durationSec} сек`
      safeNotify('Повтор сохранён', `Последние ${label}`)
    },
    // area — либо номер стакана, либо имя сохранённого пресета: с приходом
    // визуальной обрезки резать можно и по своей рамке, а "Стакан Левый
    // стакан" в уведомлении выглядело бы нелепо.
    notifyStakanReady(area, speedFactor) {
      const speedNote = speedFactor && speedFactor !== 1 ? ` (x${speedFactor})` : ''
      const areaLabel = typeof area === 'number' ? `Стакан ${area}` : String(area)
      safeNotify('Область вырезана', `${areaLabel}${speedNote} готова`)
    }
  }
}

module.exports = { createNotifier }
