const get = id => document.getElementById(id)
const zone = 'Europe/Prague'
const locale = 'cs-CZ'
const todayParts = new Intl.DateTimeFormat('en', {
  year:'numeric', month:'2-digit', day:'2-digit', timeZone:zone
}).formatToParts(new Date())
const today = ['year', 'month', 'day'].map(part => todayParts.find(item => item.type === part).value).join('-')
const [year, month] = today.split('-').map(Number)
let displayed = new Date(Date.UTC(year, month - 1, 1))
let snapshot = {}
let events = new Map()
let theatre = []
let kino = {}
let discoveries = {}
let exhibitions = []
let detailTrigger
let loaded = false
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

function matchesFilters(event, filters) {
  return (!filters.get('type') || event.type === filters.get('type'))
    && (!filters.get('city') || event.city === filters.get('city'))
}

function details(event, trigger) {
  detailTrigger = trigger
  const metaDate = event.endDate ? dayLabel(event.date) + ' – ' + dayLabel(event.endDate) : dayLabel(event.date)
  const title = get('event-title')
  title.textContent = event.title
  get('event-type').textContent = [event.type, event.city].filter(Boolean).join(' · ')
  get('event-meta').textContent = [metaDate, event.time, event.venue,
    event.cancelled ? kind.cancelled : event.missing ? kind.missing : ''].filter(Boolean).join(' · ')
  get('event-description').textContent = event.description || snapshot.descriptions?.[event.show]
    || 'Popis je dostupný v detailu u pořadatele.'
  get('event-source').href = event.url
  get('details').hidden = false
  title.focus({preventScroll:true})
  get('details').scrollIntoView({block:'nearest'})
}

function closeDetails(restoreFocus = false) {
  get('details').hidden = true
  if (restoreFocus && detailTrigger?.isConnected) detailTrigger.focus()
  detailTrigger = null
}

function exhibitionButton(event) {
  const button = element('button', event.title, 'exhibition')
  button.type = 'button'
  button.append(element('span', event.city + ' · do ' + dayLabel(event.endDate)))
  button.onclick = () => details(event, button)
  return button
}

function theatreEvent(event) {
  const venue = event.venue || ''
  const city = /pra(?:ha|ze)|dejvické/i.test(venue) ? 'Praha'
    : /janáčkovo|mahenovo|reduta/i.test(venue) ? 'Brno' : ''
  const type = /koncert|opera/i.test(event.category || '') || /galakoncert|filharmoni/i.test(event.title) ? 'Hudba' : 'Divadlo'
  return {...event, city, type}
}

function drawCalendar() {
  const calendar = get('calendar')
  calendar.replaceChildren()
  get('month').textContent = displayed.toLocaleDateString(locale, {month:'long', year:'numeric', timeZone:'UTC'})
  const leading = (displayed.getUTCDay() + 6) % 7
  const numDays = new Date(Date.UTC(displayed.getUTCFullYear(), displayed.getUTCMonth() + 1, 0)).getUTCDate()
  const first = displayed.toISOString().slice(0, 8)
  const monthStart = first + '01'
  const monthEnd = first + String(numDays)
  const filters = new FormData(get('filters'))
  const visibleShows = [...events.values()].filter(event =>
    event.date >= monthStart && event.date <= monthEnd && matchesFilters(event, filters))
  const visibleExhibitions = exhibitions.filter(event =>
    event.date <= monthEnd && event.endDate >= monthStart && matchesFilters(event, filters))
  get('exhibition-list').replaceChildren(...visibleExhibitions.map(exhibitionButton))
  get('ongoing').hidden = !visibleExhibitions.length
  get('empty-calendar').hidden = !loaded || visibleShows.length > 0 || visibleExhibitions.length > 0
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
    const dayEvents = visibleShows.filter(event => event.date === date).sort((a, b) => a.time.localeCompare(b.time))
    const overflow = element('details', '', 'day-overflow')
    for (const [index, event] of dayEvents.entries()) {
      const button = element('button', '', 'event')
      if (event.cancelled) button.classList.add('cancelled')
      if (event.missing) button.classList.add('missing')
      button.setAttribute('aria-label', [event.title, dayLabel(date), event.time,
        event.cancelled ? kind.cancelled : event.missing ? kind.missing : ''].filter(Boolean).join(', '))
      if (event.time) button.append(element('time', event.time))
      button.append(document.createTextNode(event.title))
      button.onclick = () => details(event, button)
      if (index < 4) cell.append(button)
      else overflow.append(button)
    }
    if (overflow.childElementCount) {
      overflow.prepend(element('summary', '+' + overflow.childElementCount + ' další'))
      cell.append(overflow)
    }
    calendar.append(cell)
  }
}

function updateEvents() {
  const all = [...theatre, ...(kino.events || []), ...(discoveries.events || [])]
  const overrides = new Map((discoveries.cancellations || []).map(row => [row.event, row]))
  events = new Map(all.map(event => {
    const confirmed = overrides.get(event.id)
    return [event.id, confirmed ? {...event, cancelled:true, missing:false} : event]
  }))
  drawCalendar()
  drawFeed()
}

function externalFeed() {
  const rows = []
  for (const event of [...(kino.events || []), ...(discoveries.events || [])]) {
    if (event.addedAt) rows.push({kind:'new', event:event.id, at:event.addedAt})
    if (event.cancelled && event.cancelledAt) {
      rows.push({kind:'cancelled', event:event.id, at:event.cancelledAt})
    }
  }
  for (const cancellation of discoveries.cancellations || []) {
    const event = events.get(cancellation.event)
    if (event && !(snapshot.feed || []).some(row => row.kind === 'cancelled' && row.event === event.id)
        && !rows.some(row => row.kind === 'cancelled' && row.event === event.id)) {
      rows.push({kind:'cancelled', event:event.id, at:cancellation.at})
    }
  }
  if (kino.error && kino.errorSince) {
    rows.push({kind:'error', at:kino.errorSince, message:'Program Kino Art se nepodařilo aktualizovat. Zobrazuji poslední dostupná data.'})
  }
  for (const failure of discoveries.failures || []) {
    rows.push({kind:'error', at:failure.at, message:failure.message})
  }
  return rows
}

function drawFeed() {
  const news = get('news')
  news.replaceChildren()
  const filters = new FormData(get('filters'))
  const rows = [...(snapshot.feed || []), ...externalFeed()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).filter(row => {
    const event = events.get(row.event)
    return !event || matchesFilters(event, filters)
  })
  if (!snapshot.error && snapshot.lastAttempt && Date.now() - Date.parse(snapshot.lastAttempt) > 27 * 3600000) {
    news.append(element('li', 'Denní aktualizace programu má zpoždění. Zobrazuji poslední dostupná data.', 'alert'))
  }
  for (const row of rows) {
    const event = events.get(row.event)
    const item = element('li', '', row.kind === 'error' ? 'alert' : '')
    const time = element('time', timestamp.format(new Date(row.at)))
    time.dateTime = row.at
    item.append(time, document.createTextNode(row.message || kind[row.kind]))
    if (event) {
      const button = element('button', event.title)
      button.onclick = () => details(event, button)
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
  get('filters').hidden = sources
  document.querySelectorAll('nav a').forEach(link => {
    if ((link.hash === '#sources') === sources) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
}
window.addEventListener('hashchange', navigate)
navigate()
function shift(amount) {
  closeDetails()
  displayed.setUTCMonth(displayed.getUTCMonth() + amount)
  drawCalendar()
}
get('previous').onclick = () => shift(-1)
get('next').onclick = () => shift(1)
get('today').onclick = () => {
  closeDetails()
  displayed = new Date(Date.UTC(year, month - 1, 1))
  drawCalendar()
}
get('close-details').onclick = () => closeDetails(true)
get('filters').onchange = () => {
  closeDetails()
  drawCalendar()
  drawFeed()
}
drawCalendar()

fetch('events.json', {cache:'no-cache'}).then(response => {
  if (!response.ok) throw new Error('Missing snapshot')
  return response.json()
}).then(data => {
  snapshot = data
  theatre = (data.events || []).map(theatreEvent)
  loaded = true
  get('status').textContent = data.lastSuccess
    ? 'Program do ' + dayLabel(data.throughDate) + ' · Poslední aktualizace ' + timestamp.format(new Date(data.lastSuccess))
    : 'První načtení programu se zatím nepodařilo.'
  updateEvents()
}).catch(() => {
  get('status').textContent = 'Data programu se nepodařilo načíst.'
  snapshot.feed = [{kind:'error', at:new Date().toISOString()}]
  drawFeed()
})

fetch('exhibitions.json', {cache:'no-cache'}).then(response => {
  if (!response.ok) throw new Error('Missing exhibitions')
  return response.json()
}).then(data => {
  exhibitions = data.map(event => ({...event, type:'Výstavy'}))
  const items = exhibitions.map(event => {
    const item = element('li')
    const link = element('a', event.title)
    link.href = event.url
    item.append(link, document.createTextNode(' · ' + event.city))
    return item
  })
  get('exhibition-sources').replaceChildren(...items)
  drawCalendar()
}).catch(() => {
  get('exhibition-sources').replaceChildren(element('li', 'Výstavy se nepodařilo načíst.', 'alert'))
})

function readJson(path) {
  return fetch(path, {cache:'no-cache'}).then(response => {
    if (!response.ok) throw new Error(path)
    return response.json()
  })
}

readJson('kino.json').then(data => {
  kino = data
  updateEvents()
}).catch(() => {
  kino = {error:true, errorSince:new Date().toISOString()}
  drawFeed()
})

readJson('discoveries.json').then(data => {
  discoveries = data
  updateEvents()
}).catch(() => {
  discoveries = {failures:[{at:new Date().toISOString(), message:'Výsledky hledání podle klíčových slov se nepodařilo načíst.'}]}
  drawFeed()
})

readJson('sources.json').then(config => {
  const links = config.links.map(source => {
    const item = element('li')
    const link = element('a', source.name)
    link.href = source.url
    item.append(link, element('p', source.description, 'muted'))
    return item
  })
  const queries = config.queries.map(source => {
    const item = element('li')
    item.append(element('strong', source.query))
    if (source.variants?.length) item.append(element('p', source.variants.join(' · '), 'muted'))
    return item
  })
  get('source-links').replaceChildren(...links)
  get('source-queries').replaceChildren(...queries)
}).catch(() => {
  get('source-links').replaceChildren(element('li', 'Seznam zdrojů se nepodařilo načíst.', 'alert'))
})
