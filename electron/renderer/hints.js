// Значок «?» рядом с подсказкой: короткое остаётся на виду, подробное
// открывается по нему.
//
// Зачем. В настройках было 32 подсказки на 5185 символов — около восьмисот
// слов пояснительного текста на 22 поля, и поле за полем шла сплошная стена,
// которую никто не читает. Короткая строка отвечает на вопрос «что сюда
// вводить», всё остальное — «почему так» и «что будет, если иначе» — нужно
// изредка и по запросу.
//
// Разметка: внутри <p class="field-hint"> длинная часть заворачивается в
// <span class="more">...</span>. Этот скрипт вынимает её и вешает вместо неё
// значок. Текст остаётся в разметке рядом со своим полем, а не уезжает в
// отдельный файл подписей, где его правят отдельно от поля и забывают.
//
// Почему не атрибут title: у него секундная задержка, его нельзя оформить, из
// него нельзя скопировать путь или название пункта меню, и он не открывается с
// клавиатуры.

// Сколько ждать, прежде чем спрятать: иначе панелька исчезает, едва поведёшь
// курсор в её сторону, и прочитать длинный текст мышью невозможно.
const HIDE_DELAY_MS = 180
// Отступ от края окна, ближе которого панельку показывать нельзя
const EDGE_GAP_PX = 12

function createHintMarks(root = document) {
  let openPanel = null
  let hideTimer = null

  function closePanel() {
    if (!openPanel) return
    openPanel.panel.hidden = true
    openPanel.mark.setAttribute('aria-expanded', 'false')
    openPanel = null
  }

  function place(panel) {
    // Панелька висит под значком; двигаем её влево, только если она не
    // помещается по ширине окна. Считать можно лишь после показа: у скрытого
    // элемента размеров нет.
    panel.style.left = '0px'
    const box = panel.getBoundingClientRect()
    const overflow = box.right - (window.innerWidth - EDGE_GAP_PX)
    if (overflow > 0) panel.style.left = `${-Math.round(overflow)}px`
  }

  function openFor(mark, panel) {
    if (openPanel && openPanel.panel !== panel) closePanel()
    clearTimeout(hideTimer)
    panel.hidden = false
    mark.setAttribute('aria-expanded', 'true')
    openPanel = { mark, panel }
    place(panel)
  }

  function scheduleHide() {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(closePanel, HIDE_DELAY_MS)
  }

  for (const more of [...root.querySelectorAll('.field-hint .more')]) {
    const hint = more.parentElement

    const holder = document.createElement('span')
    holder.className = 'hint-mark-holder'

    const mark = document.createElement('button')
    mark.type = 'button'
    mark.className = 'hint-mark'
    mark.textContent = '?'
    mark.setAttribute('aria-expanded', 'false')
    mark.setAttribute('aria-label', 'Подробнее')

    const panel = document.createElement('span')
    panel.className = 'hint-panel'
    panel.hidden = true
    // innerHTML, а не textContent: в подсказках встречается <b> — например,
    // на названиях пунктов меню OBS.
    panel.innerHTML = more.innerHTML

    holder.appendChild(mark)
    holder.appendChild(panel)

    // Сначала убираем длинную часть, потом дописываем значок в конец. Если
    // сделать наоборот и подчистить хвост через textContent, тот снесёт уже
    // вставленный значок вместе со всей разметкой абзаца.
    more.remove()
    const last = hint.lastChild
    if (last && last.nodeType === Node.TEXT_NODE) {
      last.textContent = last.textContent.replace(/\s+$/, '')
    }
    if (hint.textContent.trim()) hint.appendChild(document.createTextNode(' '))
    hint.appendChild(holder)

    // Наведение — чтобы прочесть мимоходом; щелчок — чтобы закрепить и
    // скопировать. Фокус с клавиатуры открывает так же, как наведение.
    mark.addEventListener('pointerenter', () => openFor(mark, panel))
    mark.addEventListener('focus', () => openFor(mark, panel))
    mark.addEventListener('pointerleave', scheduleHide)
    mark.addEventListener('blur', scheduleHide)
    panel.addEventListener('pointerenter', () => clearTimeout(hideTimer))
    panel.addEventListener('pointerleave', scheduleHide)
    mark.addEventListener('click', (event) => {
      // Значок может стоять внутри подписи поля — без этого щелчок по нему
      // переключал бы саму галку.
      event.preventDefault()
      event.stopPropagation()
      if (openPanel && openPanel.panel === panel) closePanel()
      else openFor(mark, panel)
    })
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel()
  })
  // Щелчок мимо закрывает закреплённую панельку
  document.addEventListener('pointerdown', (event) => {
    if (!openPanel) return
    if (event.target.closest && event.target.closest('.hint-mark-holder')) return
    closePanel()
  })
}

createHintMarks()
