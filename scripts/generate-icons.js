// Генерирует маленькие .ico-иконки статуса трея (цветная точка на прозрачном
// фоне) без внешних зависимостей — вручную собирает валидный ICO-файл
// (ICONDIR + BITMAPINFOHEADER, 32bpp BGRA, bottom-up).
// Запускать при смене дизайна: node scripts/generate-icons.js
//
// Размеров в файле несколько НАМЕРЕННО. Когда в .ico лежал один-единственный
// вариант 32x32, Electron отдавал в трей изображение 256x256 (растянутое из
// него в 8 раз), и уменьшать его до реальных ~16px приходилось уже Windows.
// С готовыми мелкими размерами система берёт подходящий как есть.

const fs = require('fs')
const path = require('path')

// Размеры значка в области уведомлений при разных масштабах экрана
// (100% — 16px, 125% — 20px, 150% — 24px, 200% — 32px; 40 и 48 — с запасом).
const SIZES = [16, 20, 24, 32, 40, 48]
const OUTPUT_DIR = path.join(__dirname, '..', 'assets')

const ICONS = [
  { name: 'tray-ok.ico', color: [22, 163, 74] },     // зелёный: слежение активно, OBS подключён
  { name: 'tray-warn.ico', color: [234, 179, 8] },   // жёлтый: OBS не подключён / переподключение
  { name: 'tray-error.ico', color: [220, 38, 38] },  // красный: ошибка
  { name: 'tray-paused.ico', color: [120, 120, 120] }, // серый: на паузе (вручную остановлено)
  { name: 'tray-flash.ico', color: [37, 99, 235] }     // синий: кратковременное мигание при готовом клипе
]

function buildCirclePixels(size, [r, g, b]) {
  // BGRA, bottom-up (последняя строка изображения идёт первой в файле)
  const pixels = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const radius = size * 0.42

  for (let row = 0; row < size; row++) {
    // bottom-up: row 0 в буфере — это самая нижняя строка картинки
    const y = size - 1 - row
    for (let x = 0; x < size; x++) {
      const dx = x - center
      const dy = y - center
      const dist = Math.sqrt(dx * dx + dy * dy)
      const offset = (row * size + x) * 4
      if (dist <= radius) {
        pixels[offset] = b
        pixels[offset + 1] = g
        pixels[offset + 2] = r
        pixels[offset + 3] = 255
      } else {
        pixels[offset] = 0
        pixels[offset + 1] = 0
        pixels[offset + 2] = 0
        pixels[offset + 3] = 0
      }
    }
  }
  return pixels
}

// Один вариант размера внутри ICO: BITMAPINFOHEADER + пиксели + AND-маска.
function buildIconImage(size, colorRgb) {
  const pixels = buildCirclePixels(size, colorRgb)

  const bmpHeaderSize = 40
  const andMaskRowBytes = Math.ceil(size / 32) * 4 // 1bpp, dword-aligned
  const andMaskSize = andMaskRowBytes * size

  const bmpHeader = Buffer.alloc(bmpHeaderSize)
  bmpHeader.writeUInt32LE(bmpHeaderSize, 0) // biSize
  bmpHeader.writeInt32LE(size, 4) // biWidth
  bmpHeader.writeInt32LE(size * 2, 8) // biHeight (XOR+AND, как того требует ICO)
  bmpHeader.writeUInt16LE(1, 12) // biPlanes
  bmpHeader.writeUInt16LE(32, 14) // biBitCount
  bmpHeader.writeUInt32LE(0, 16) // biCompression = BI_RGB
  bmpHeader.writeUInt32LE(pixels.length, 20) // biSizeImage
  bmpHeader.writeInt32LE(0, 24) // biXPelsPerMeter
  bmpHeader.writeInt32LE(0, 28) // biYPelsPerMeter
  bmpHeader.writeUInt32LE(0, 32) // biClrUsed
  bmpHeader.writeUInt32LE(0, 36) // biClrImportant

  // Все пиксели "непрозрачны" по маске — реальную прозрачность даёт альфа-канал
  const andMask = Buffer.alloc(andMaskSize, 0)

  return Buffer.concat([bmpHeader, pixels, andMask])
}

function buildIco(sizes, colorRgb) {
  const images = sizes.map((size) => ({ size, data: buildIconImage(size, colorRgb) }))

  const iconDir = Buffer.alloc(6)
  iconDir.writeUInt16LE(0, 0) // reserved
  iconDir.writeUInt16LE(1, 2) // type = icon
  iconDir.writeUInt16LE(images.length, 4) // count

  // Данные всех вариантов идут подряд после каталога, поэтому смещение
  // накапливаем по мере обхода.
  let offset = iconDir.length + images.length * 16
  const dirEntries = []
  for (const image of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0) // width
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1) // height
    entry.writeUInt8(0, 2) // color count
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bit count
    entry.writeUInt32LE(image.data.length, 8) // bytes in resource
    entry.writeUInt32LE(offset, 12) // image offset
    dirEntries.push(entry)
    offset += image.data.length
  }

  return Buffer.concat([iconDir, ...dirEntries, ...images.map((image) => image.data)])
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true })

for (const icon of ICONS) {
  const buffer = buildIco(SIZES, icon.color)
  const outPath = path.join(OUTPUT_DIR, icon.name)
  fs.writeFileSync(outPath, buffer)
  console.log(`Создан ${outPath} (размеры: ${SIZES.join(', ')})`)
}
