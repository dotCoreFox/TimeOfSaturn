const get = id => document.getElementById(id)
const zone = 'Europe/Prague'
const locale = 'cs-CZ'
const today = new Intl.DateTimeFormat('en-CA', {dateStyle:'short', timeZone:zone}).format(new Date())
const [year, month] = today.split('-').map(Number)
let displayed = new Date(Date.UTC(year, month - 1, 1))
let snapshot = {}
let events = new Map()
const dateLabel = new Intl.DateTimeFormat(locale, {dateStyle:'medium', timeZone:zone})
const timestamp = new Intl.DateTimeFormat(locale, {dateStyle:'medium', timeStyle:'short', timeZone:zone})
const dayLabel = date => dateLabel.format(new Date(date + 'T12:00:00Z'))
const kind = {
  new:'Nový termín', cancelled:'Zrušeno', restored:'Termín potvrzen',
  missing:'Termín zmizel z programu · stav nepotvrzen',
  error:'Program NdB se nepodařilo aktualizovat. Zobrazuji poslední dostupná data.',
  recovered:'Aktualizace programu NdB opět funguje.'
}

function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  if (className) node.className = className
  return node
}

function details(event) {
  const description = snapshot.descriptions?.[event.show]
  get('event-title').textContent = event.title
  get('event-meta').textContent = [dayLabel(event.date), event.time, event.venue, event.category,
    event.cancelled ? kind.cancelled : event.missing ? kind.missing : ''].filter(Boolean).join(' · ')
  get('event-description').textContent = description || 'Popis je dostupný v detailu na webu NdB.'
  get('event-source').href = event.url
  get('details').showModal()
}

function drawCalendar() {
  const calendar = get('calendar')
  calendar.replaceChildren()
  get('month').textContent = displayed.toLocaleDateString(locale, {month:'long', year:'numeric', timeZone:'UTC'})
  const leading = (displayed.getUTCDay() + 6) % 7
  const numDays = new Date(Date.UTC(displayed.getUTCFullYear(), displayed.getUTCMonth() + 1, 0)).getUTCDate()
  const first = displayed.toISOString().slice(0, 8)
  for (let i = 0; i < Math.ceil((leading + numDays) / 7) * 7; i++) {
    const day = i - leading + 1
    if (day < 1 || day > numDays) {
      calendar.append(element('div', '', 'day empty'))
      continue
    }
    const date = first + String(day).padStart(2, '0')
    const cell = element('div', '', date === today ? 'day today' : 'day')
    const number = element('time', String(day), 'date')
    number.dateTime = date
    cell.append(number)
    for (const event of events.values()) {
      if (event.date !== date) continue
      const button = element('button', '', 'event')
      if (event.cancelled) button.classList.add('cancelled')
      if (event.missing) button.classList.add('missing')
      button.setAttribute('aria-label', [event.title, dayLabel(date), event.time,
        event.cancelled ? kind.cancelled : event.missing ? kind.missing : ''].filter(Boolean).join(', '))
      if (event.time) button.append(element('time', event.time))
      button.append(document.createTextNode(event.title))
      button.onclick = () => details(event)
      cell.append(button)
    }
    calendar.append(cell)
  }
}

function drawFeed() {
  const news = get('news')
  news.replaceChildren()
  const rows = [...(snapshot.feed || [])]
  if (!snapshot.error && snapshot.lastAttempt && Date.now() - Date.parse(snapshot.lastAttempt) > 27 * 3600000) {
    news.append(element('li', 'Denní aktualizace programu má zpoždění. Zobrazuji poslední dostupná data.', 'alert'))
  }
  for (const row of rows) {
    const event = events.get(row.event)
    const item = element('li', '', row.kind === 'error' ? 'alert' : '')
    const time = element('time', timestamp.format(new Date(row.at)))
    time.dateTime = row.at
    item.append(time, document.createTextNode(kind[row.kind]))
    if (event) {
      const button = element('button', event.title)
      button.onclick = () => details(event)
      item.append(document.createTextNode(' · '), button, document.createTextNode(' · ' + dayLabel(event.date) + (event.time ? ' · ' + event.time : '')))
    }
    news.append(item)
  }
  if (!news.children.length) news.append(element('li', 'Zatím žádné aktuality.'))
}

function navigate() {
  const sources = location.hash === '#sources'
  get('sources').hidden = !sources
  get('feed').hidden = sources
  document.querySelectorAll('nav a').forEach(link => {
    if ((link.hash === '#sources') === sources) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
}
window.addEventListener('hashchange', navigate)
navigate()
function shift(amount) {
  displayed.setUTCMonth(displayed.getUTCMonth() + amount)
  drawCalendar()
}
get('previous').onclick = () => shift(-1)
get('next').onclick = () => shift(1)
get('today').onclick = () => { displayed = new Date(Date.UTC(year, month - 1, 1)); drawCalendar() }
drawCalendar()

fetch('events.json', {cache:'no-cache'}).then(response => {
  if (!response.ok) throw new Error('Missing snapshot')
  return response.json()
}).then(data => {
  snapshot = data
  events = new Map((data.events || []).map(event => [event.id, event]))
  get('status').textContent = data.lastSuccess
    ? 'Program do ' + dayLabel(data.throughDate) + ' · Poslední aktualizace ' + timestamp.format(new Date(data.lastSuccess))
    : 'První načtení programu se zatím nepodařilo.'
  drawCalendar()
  drawFeed()
}).catch(() => {
  get('status').textContent = 'Data programu se nepodařilo načíst.'
  get('news').replaceChildren(element('li', 'Data programu se nepodařilo načíst.', 'alert'))
})
