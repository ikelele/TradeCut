const fs = require('fs')
const path = require('path')
const { getUserDataDir } = require('./appPaths')

const MAX_LOG_AGE_DAYS = 14

function pad(n) {
  return String(n).padStart(2, '0')
}

function dateStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function timestamp() {
  return new Date().toISOString()
}

function createLogger() {
  const logDir = path.join(getUserDataDir(), 'logs')
  fs.mkdirSync(logDir, { recursive: true })

  function currentLogFilePath() {
    return path.join(logDir, `app-${dateStamp(new Date())}.log`)
  }

  function cleanupOldLogs() {
    const cutoffMs = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000
    let entries
    try {
      entries = fs.readdirSync(logDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
      const filePath = path.join(logDir, name)
      try {
        const stat = fs.statSync(filePath)
        if (stat.mtimeMs < cutoffMs) fs.unlinkSync(filePath)
      } catch {
        // игнорируем — не критично, попробуем в другой раз
      }
    }
  }

  cleanupOldLogs()

  function write(level, message) {
    const line = `[${timestamp()}] [${level}] ${message}`
    if (process.stdout && process.stdout.isTTY) {
      // eslint-disable-next-line no-console
      console.log(line)
    }
    try {
      fs.appendFileSync(currentLogFilePath(), line + '\n', 'utf8')
    } catch {
      // если запись в файл не удалась — не роняем приложение из-за логирования
    }
  }

  return {
    log: (message) => write('INFO', message),
    error: (message) => write('ERROR', message),
    getLogDir: () => logDir
  }
}

module.exports = { createLogger }
