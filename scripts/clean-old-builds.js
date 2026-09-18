// Уборка в dist: файлы прошлых версий занимают по 139 МБ каждый и копятся с
// каждой сборкой. Оставляем только текущую версию.
//
// Удаляем ТОЛЬКО то, что сборка сама и создала, и только с чужим номером
// версии. Рядом в этой же папке живут настройки переносимой версии и клипы —
// их трогать нельзя, поэтому список файлов строится по точному шаблону имени,
// а не «всё, кроме нужного».
//
// Запуск: node scripts/clean-old-builds.js [--dry]

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const VERSION = require(path.join(ROOT, 'package.json')).version
const dryRun = process.argv.includes('--dry')

// Ровно те имена, которые выдаёт electron-builder (см. artifactName в
// package.json). Версия — группа: по ней и решаем, своё это или прошлое.
const BUILD_ARTIFACTS = [
  /^TradeCut-Setup-(\d+\.\d+\.\d+)\.exe$/,
  /^TradeCut-Setup-(\d+\.\d+\.\d+)\.exe\.blockmap$/,
  /^TradeCut-(\d+\.\d+\.\d+)-portable\.exe$/,
  /^TradeCut-(\d+\.\d+\.\d+)-portable\.exe\.blockmap$/
]

function versionOf(fileName) {
  for (const pattern of BUILD_ARTIFACTS) {
    const match = pattern.exec(fileName)
    if (match) return match[1]
  }
  return null // не файл сборки — значит не наше дело
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.log('Папки dist нет — убирать нечего')
    return
  }

  const stale = []
  for (const name of fs.readdirSync(DIST)) {
    const version = versionOf(name)
    if (!version || version === VERSION) continue
    stale.push({ name, size: fs.statSync(path.join(DIST, name)).size })
  }

  if (stale.length === 0) {
    console.log(`В dist только текущая версия (${VERSION}) — убирать нечего`)
    return
  }

  let freed = 0
  for (const { name, size } of stale) {
    if (!dryRun) fs.unlinkSync(path.join(DIST, name))
    freed += size
    console.log(`  ${dryRun ? 'удалить' : 'удалён'}: ${name} (${mb(size)})`)
  }

  console.log(`${dryRun ? 'Освободится' : 'Освобождено'}: ${mb(freed)}. Оставлена версия ${VERSION}.`)
}

main()
