// Вписать кадр в отведённое ему место, сохранив пропорции.
//
// Почему не в CSS. «Вписать прямоугольник с заданными пропорциями в другой
// прямоугольник» в CSS выражается только для картинок и видео — через
// object-fit. Но тогда коробка элемента остаётся во всё доступное место, а
// картинка ложится внутрь с полями, и совпадение коробки с картинкой теряется.
// А на нём держится весь пересчёт координат: и рамка обрезки, и границы
// областей задаются относительно коробки.
//
// Считаем сами: берём настоящий размер свободного места и меньший из двух
// масштабов. Прежние попытки задавали только предел по высоте и вычитали
// снизу запас числом — запас не совпадал с настоящим, а ширина не учитывалась
// вовсе. Из-за этого на 3440x1440 кадр вылезал за нижний край окна, а на
// ноутбуке сжимался до минимума, хотя место было.
function fitFrameInto(stage, frame, natural) {
  if (!stage || !frame || !natural || !natural.width || !natural.height) return
  // clientWidth/Height, а не getBoundingClientRect: рамка нарисована с
  // бордюром, и он в доступное место не входит.
  const available = { width: frame.clientWidth, height: frame.clientHeight }
  if (!(available.width > 0) || !(available.height > 0)) return

  const scale = Math.min(available.width / natural.width, available.height / natural.height)
  // Через свойства style, а не атрибут: атрибут style запрещён политикой
  // безопасности страниц (style-src 'self'), присваивание свойств — нет.
  stage.style.width = `${Math.floor(natural.width * scale)}px`
  stage.style.height = `${Math.floor(natural.height * scale)}px`
}
