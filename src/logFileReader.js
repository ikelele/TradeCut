const fsp = require('fs').promises

// Дочитывает новые строки из растущего текстового лог-файла с позиции
// курсора. Общее для всех, кто следит за логами построчно: сделки терминала
// (terminalLog.js) — читает
// один и тот же вид файлов, просто ищут в них разное.
// cursor = { offset, remainder } — мутируется на месте, хранится у вызывающего.
async function readNewLinesFromCursor(filePath, cursor) {
  const stat = await fsp.stat(filePath)
  if (stat.size < cursor.offset) {
    // Файл был пересоздан/обрезан (например, началась новая дата) — читаем с начала
    cursor.offset = 0
    cursor.remainder = ''
  }
  if (stat.size === cursor.offset) return []

  const fd = await fsp.open(filePath, 'r')
  try {
    const length = stat.size - cursor.offset
    const buffer = Buffer.alloc(length)
    await fd.read(buffer, 0, length, cursor.offset)
    cursor.offset = stat.size
    const chunkText = cursor.remainder + buffer.toString('utf8')
    const lines = chunkText.split(/\r?\n/)
    cursor.remainder = lines.pop() ?? ''
    return lines
  } finally {
    await fd.close()
  }
}

module.exports = { readNewLinesFromCursor }
