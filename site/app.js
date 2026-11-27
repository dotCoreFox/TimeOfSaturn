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
let programmeEvents = []
let watch = {}
let config
let currentView = 'agenda'
let newsLimit = 24
const sourceNames = new Map([
  ['ndb', 'Národní divadlo Brno'], ['kino-art', 'Kino Art'],
  ['gothic-brno', 'Gothic akce Brno'], ['exhibitions', 'Ruční výběr výstav']
])
const regionDays = {brno:7, cz:30, near:365, world:365}
const regionNames = {cz:'Česko', near:'Okolní země', world:'Svět'}
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

const fold = text => (text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
const matchKey = text => fold(text).replace(/[^a-z0-9]+/g, ' ').trim()
const venueKey = venue => matchKey(venue?.split(/,|\s[–—-]\s/)[0])
const topicNames = {
  kurzy:'Kurzy a dovednosti', prakticke:'Praktické dovednosti', projekty:'Projekty a komunita', debaty:'Debaty a přednášky',
  hudba:'Hudba', hoste:'Výrazní hosté', kino:'Kino', svetlo:'Světlo a folklor', vystavy:'Výstavy', divadlo:'Divadlo', kink:'Kink a shibari', ocr:'Překážkové a trailové závody'
}
const typeTopics = Object.fromEntries(Object.entries(topicNames).map(([key, name]) => [name, key]))

function enrich(event) {
  const text = fold([event.title, event.description].filter(Boolean).join(' '))
  const label = typeTopics[event.type]
  const topics = new Set(event.topics || [])
  if (label) topics.add(label)
  if (/\b(power\s*bi|power query|excel|datov[a-z]* vizualizace)\b/.test(text) ||
      /\b(kurz|skoleni|workshop)\b/.test(fold(event.title))) topics.add('kurzy')
  if (/\b(power\s*bi|power query|3d tisk|cnc frezovani|obrazov[a-z]* editac[ei]|prvni pomoc)\b/.test(text) ||
      /\b(praktick[a-z]* (?:kurz|workshop)|prakticky si vyzkous|naucis se|naucite se|hands-on)\b/.test(text)) topics.add('prakticke')
  if (/\b(meetup|networking|hackathon|pitch day|open hours|mastermind)\b/.test(text) ||
      /\b(komunitni setkani|produktovy design|vyvoj aplikaci)\b/.test(text)) topics.add('projekty')
  if (/\b(debat[a-z]*|prednask[a-z]*|diskuz[a-z]*|diskus[a-z]*)\b/.test(text)) topics.add('debaty')
  if (/\b(videomapping|video mapping|pochodn[a-z]*|folklor[a-z]*|legend[a-z]*|kupaly|sveteln[a-z]* (show|instalac[a-z]*|festival[a-z]*)|festival svetla)\b/.test(text)) topics.add('svetlo')
  if (/\b(koncert[a-z]*|recital|darkwave|post punk|post-punk)\b/.test(fold(event.title))) topics.add('hudba')
  if (/\b(vernisaz|vystava)\b/.test(fold(event.title))) topics.add('vystavy')
  const type = event.type === 'Ostatní' ? topicNames[[...topics][0]] || event.type : event.type
  const scope = event.scope || 'cz'
  const relevantFilm = topics.has('kino') && /\b(debat[a-z]*|retrospektiv[a-z]*|ziv[a-z]* hudb[a-z]*|sci[ -]?fi|animovan[a-z]*|kultovn[a-z]*)\b/.test(text)
  const relevantMusic = topics.has('hudba') && (event.sourceId === 'gothic-brno' ||
    /\b(darkwave|post[ -]punk|gothic|mezinarodni host|svetove znam[a-z]*)\b/.test(text))
  const featured = event.starred || topics.has('svetlo') || topics.has('ocr') || (scope === 'cz' && (
    topics.has('kurzy') || topics.has('prakticke') || topics.has('kink') || topics.has('projekty') || topics.has('hoste') || relevantFilm || relevantMusic ||
    (topics.has('debaty') && !topics.has('kino'))
  ))
  return {...event, type, topics:[...topics], scope, featured}
}

const normalizedUrl = value => {
  if (!value) return ''
  try {
    const url = new URL(value)
    return url.origin + url.pathname.replace(/\/$/, '') + url.search
  } catch {
    return ''
  }
}

function groupOccurrences(rows) {
  const unique = []
  const aliases = new Map()
  const buckets = new Map()
  for (const event of rows) {
    const key = [matchKey(event.city), event.date, event.endDate || event.date].join('|')
    const bucket = buckets.get(key) || []
    buckets.set(key, bucket)
    const duplicate = bucket.find(row => {
      if (row.sourceIds.includes(event.sourceId) || (row.time && event.time && row.time !== event.time)) return false
      const urls = [event.url, event.organizerUrl].map(normalizedUrl).filter(Boolean)
      if (urls.some(url => new URL(url).pathname !== '/' && row.links.some(link => normalizedUrl(link.url) === url))) {
        if (event.time && row.time) return true
        return matchKey(event.title) === matchKey(row.title) &&
          bucket.filter(item => item.links.some(link => urls.includes(normalizedUrl(link.url)))).length === 1
      }
      const venue = venueKey(event.venue)
      return Boolean(venue && venue === venueKey(row.venue) &&
        event.time === row.time && matchKey(event.title) === matchKey(row.title))
    })
    if (duplicate) {
      duplicate.sourceIds.push(event.sourceId)
      if (!duplicate.links.some(link => link.url === event.url)) duplicate.links.push({id:event.sourceId, url:event.url})
      duplicate.topics = [...new Set([...duplicate.topics, ...event.topics])]
      if (!duplicate.venue) duplicate.venue = event.venue
      if (!duplicate.time) duplicate.time = event.time
      if (!duplicate.price) duplicate.price = event.price
      duplicate.featured ||= event.featured
      duplicate.starred ||= event.starred
      aliases.set(event.id, duplicate)
    } else {
      const row = {...event, sourceIds:[event.sourceId], links:[{id:event.sourceId, url:event.url}]}
      if (event.organizerUrl && event.organizerUrl !== event.url) row.links.unshift({id:'organizer', url:event.organizerUrl})
      bucket.push(row)
      unique.push(row)
      aliases.set(event.id, row)
    }
  }
  return {unique, aliases}
}

function matchesFilters(event, filters) {
  const region = filters.get('region')
  const topic = filters.get('topic')
  const source = filters.get('source')
  if (region === 'brno' ? event.city !== 'Brno' : event.scope !== region) return false
  if (topic && !event.topics.includes(topic)) return false
  if (filters.has('profile') && !event.featured) return false
  if (filters.has('starred') && !event.starred) return false
  if (source && !(event.sourceIds || [event.sourceId]).includes(source)) return false
  const text = fold([event.title, event.description, event.venue, event.city, event.type,
    ...event.topics.map(key => topicNames[key]), ...(event.sourceIds || [event.sourceId]).map(id => sourceNames.get(id))].join(' '))
  return fold(filters.get('search')).trim().split(/\s+/).every(word => text.includes(word))
}

function addDays(day, days) {
  const result = new Date(day + 'T12:00:00Z')
  result.setUTCDate(result.getUTCDate() + days)
  return result.toISOString().slice(0, 10)
}

function titledEvent(node, event) {
  if (event.starred) {
    const star = element('span', '★', 'event-star')
    star.setAttribute('aria-label', 'S hvězdičkou')
    node.append(star)
  }
  node.append(document.createTextNode(event.title))
  return node
}

function drawAgenda() {
  const filters = new FormData(get('filters'))
  const last = addDays(today, Number(get('period').value) - 1)
  const group = new Map()
  const eligible = event => event.date <= last && (event.endDate || event.date) >= today && matchesFilters(event, filters)
  const visible = [...programmeEvents, ...exhibitions.filter(event => event.date > today)].filter(eligible)
  for (const event of visible) {
    const day = event.date < today ? today : event.date
    if (!group.has(day)) group.set(day, [])
    group.get(day).push(event)
  }
  const list = get('agenda-list')
  list.replaceChildren()
  const headingDate = new Intl.DateTimeFormat(locale, {weekday:'long', day:'numeric', month:'long', timeZone:zone})
  for (const [day, rows] of [...group.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const section = element('section', '', 'agenda-day')
    section.append(element('h3', (day === today ? 'Dnes · ' : '') + headingDate.format(new Date(day + 'T12:00:00Z')),
      day === today ? 'today-heading' : ''))
    for (const event of rows.sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || a.title.localeCompare(b.title, locale))) {
      const button = element('button', '', 'agenda-row')
      button.type = 'button'
      const time = event.date < today && event.endDate ? 'do ' + dayLabel(event.endDate) : event.time || (event.endDate ? 'Vícedenní' : 'Bez času')
      const label = element('span')
      label.append(titledEvent(element('strong', '', 'agenda-title'), event),
        element('span', [...new Set([event.type, event.city, event.venue].filter(Boolean))].join(' · '), 'agenda-meta'))
      if (event.cancelled || event.missing) label.append(element('span', event.cancelled ? kind.cancelled : kind.missing, 'agenda-status'))
      button.append(element('span', time, 'agenda-time'), label,
        element('span', sourceNames.get(event.sourceId) || '', 'agenda-source'))
      button.onclick = () => details(event, button)
      section.append(button)
    }
    list.append(section)
  }
  const ongoing = exhibitions.filter(event => event.date <= today && eligible(event))
  get('agenda-exhibitions').replaceChildren(...ongoing.map(exhibitionButton))
  get('agenda-ongoing').hidden = !ongoing.length
  if (!visible.length && !ongoing.length && loaded) list.append(element('p', 'V tomto období nejsou pro zvolené filtry žádné akce.', 'muted'))
  get('result-count').textContent = loaded ? `Akce: ${visible.length + ongoing.length}` : ''
}

function details(event, trigger) {
  detailTrigger?.removeAttribute('aria-current')
  detailTrigger = trigger
  trigger.setAttribute('aria-current', 'true')
  const metaDate = event.endDate ? dayLabel(event.date) + ' – ' + dayLabel(event.endDate) : dayLabel(event.date)
  const title = get('event-title')
  title.replaceChildren()
  titledEvent(title, event)
  get('event-type').textContent = [event.type, event.city].filter(Boolean).join(' · ')
  get('event-meta').textContent = [metaDate, event.time, event.venue, event.price,
    event.cancelled ? kind.cancelled : event.missing ? kind.missing : ''].filter(Boolean).join(' · ')
  get('event-description').textContent = event.description || snapshot.descriptions?.[event.show]
    || 'Popis je dostupný v detailu u pořadatele.'
  const links = (event.links || [{id:event.sourceId, url:event.url}]).filter(link => link.url).map(link => {
    const item = element('li')
    const anchor = element('a', sourceNames.get(link.id) || 'Detail u pořadatele')
    anchor.href = link.url
    item.append(anchor)
    return item
  })
  get('event-links').replaceChildren(...links)
  get('details').hidden = false
  title.focus({preventScroll:true})
  get('details').scrollIntoView({block:'nearest'})
}

function closeDetails(restoreFocus = false) {
  get('details').hidden = true
  detailTrigger?.removeAttribute('aria-current')
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
  return {...event, city:city || 'Brno', type, sourceId:'ndb'}
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
  const visibleShows = programmeEvents.filter(event =>
    (event.endDate || event.date) >= monthStart && event.date <= monthEnd && matchesFilters(event, filters))
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
    const dayEvents = visibleShows.filter(event => (event.date < monthStart ? monthStart : event.date) === date).sort((a, b) => a.time.localeCompare(b.time))
    const overflow = element('details', '', 'day-overflow')
    for (const [index, event] of dayEvents.entries()) {
      const button = element('button', '', 'event')
      if (event.cancelled) button.classList.add('cancelled')
      if (event.missing) button.classList.add('missing')
      button.setAttribute('aria-label', [event.title, event.starred ? 'S hvězdičkou' : '', dayLabel(date), event.time,
        event.cancelled ? kind.cancelled : event.missing ? kind.missing : ''].filter(Boolean).join(', '))
      if (event.time) button.append(element('time', event.time))
      titledEvent(button, event)
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

const watchEvents = () => Object.values(watch).flatMap(source => source.events || [])

function updateEvents() {
  const direct = watchEvents().filter(event => event.sourceId !== 'go-to-brno')
  const cityCalendar = watch['go-to-brno']?.events || []
  const all = [...theatre, ...(kino.events || []), ...(discoveries.events || []), ...direct, ...cityCalendar]
  const overrides = new Set((discoveries.cancellations || []).map(row => row.event))
  const grouped = groupOccurrences(all.map(event => enrich(overrides.has(event.id) ? {...event, cancelled:true, missing:false} : event)))
  programmeEvents = grouped.unique
  events = grouped.aliases
  drawSources()
  renderView()
}

function externalFeed() {
  const rows = []
  for (const event of [...(kino.events || []), ...(discoveries.events || []), ...watchEvents()]) {
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
  for (const [id, source] of Object.entries(watch)) {
    if (source.error && source.lastAttempt) rows.push({kind:'error', at:source.lastAttempt, message:`Obnova zdroje ${sourceNames.get(id) || id} selhala.`})
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
  const seen = new Set()
  const rows = [...(snapshot.feed || []), ...externalFeed()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).filter(row => {
    const event = events.get(row.event)
    if (!event) return !row.event
    if (!matchesFilters(event, filters)) return false
    const key = [event.id, row.kind, row.kind === 'new' ? '' : row.at].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!snapshot.error && snapshot.lastAttempt && Date.now() - Date.parse(snapshot.lastAttempt) > 27 * 3600000) {
    news.append(element('li', 'Denní aktualizace programu má zpoždění. Zobrazuji poslední dostupná data.', 'alert'))
  }
  for (const row of rows.slice(0, newsLimit)) {
    const event = events.get(row.event)
    const item = element('li', '', row.kind === 'error' ? 'alert' : '')
    const time = element('time', timestamp.format(new Date(row.at)))
    time.dateTime = row.at
    item.append(time, document.createTextNode(row.message || kind[row.kind]))
    if (event) {
      const button = titledEvent(element('button'), event)
      button.onclick = () => details(event, button)
      item.append(document.createTextNode(' · '), button, document.createTextNode(' · ' + dayLabel(event.date) + (event.time ? ' · ' + event.time : '')))
    }
    news.append(item)
  }
  get('more-news').hidden = rows.length <= newsLimit
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

function renderView() {
  if (currentView === 'agenda') drawAgenda()
  else if (currentView === 'calendar') drawCalendar()
  else drawFeed()
}

function setView(view) {
  closeDetails()
  currentView = view
  get('agenda').hidden = view !== 'agenda'
  get('period-label').hidden = view !== 'agenda'
  get('month-view').hidden = view !== 'calendar'
  get('updates').hidden = view !== 'news'
  document.querySelectorAll('[data-view]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.view === view))
  })
  renderView()
}

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
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !get('details').hidden) closeDetails(true)
})
document.querySelectorAll('[data-view]').forEach(button => {
  button.onclick = () => setView(button.dataset.view)
})
get('period').onchange = () => {
  closeDetails()
  drawAgenda()
}
get('more-news').onclick = () => {
  newsLimit += 24
  drawFeed()
}
const form = get('filters')
function filterChanged() {
  closeDetails()
  newsLimit = 24
  renderView()
}
form.addEventListener('input', event => {
  if (event.target.name === 'region') {
    get('period').value = regionDays[event.target.value]
    get('source-filter').value = ''
    drawSourceOptions()
  }
  const period = get('period')
  const minimum = {ocr:365, prakticke:90, kink:30}[form.elements.topic.value]
    || (form.elements.starred.checked ? 30 : 0)
  if (['region', 'topic', 'starred'].includes(event.target.name) && Number(period.value) < minimum) {
    period.value = String(minimum)
  }
  filterChanged()
})
form.onsubmit = event => event.preventDefault()
get('clear-filters').onclick = () => {
  form.elements.search.value = ''
  form.elements.topic.value = ''
  form.elements.source.value = ''
  form.elements.profile.checked = false
  form.elements.starred.checked = false
  filterChanged()
}

function drawSourceOptions() {
  const filter = get('source-filter')
  const region = new FormData(form).get('region')
  const matching = [...programmeEvents, ...exhibitions].filter(event => region === 'brno' ? event.city === 'Brno' : event.scope === region)
  const ids = new Set(matching.flatMap(event => event.sourceIds || [event.sourceId]))
  const selected = filter.value
  const options = [...ids].filter(id => sourceNames.has(id)).sort((a, b) => sourceNames.get(a).localeCompare(sourceNames.get(b), locale))
  filter.replaceChildren(new Option('Všechny zdroje', ''), ...options.map(id => new Option(sourceNames.get(id), id)))
  filter.value = ids.has(selected) ? selected : ''
}

function drawSources() {
  drawSourceOptions()
  if (!config) return
  const current = {ndb:snapshot, 'kino-art':kino, ...watch}
  const automatic = []
  const references = []
  for (const source of config.links) {
    const imported = source.adapter || ['ndb', 'kino-art'].includes(source.id)
    const item = element('li')
    const link = element('a', source.name)
    link.href = source.url
    item.append(link, element('p', source.description, 'muted'))
    const state = current[source.id]
    const scope = regionNames[source.scope || 'cz']
    if (!imported) {
      item.append(element('p', scope, 'muted'))
      references.push(item)
      continue
    }
    let status = 'Čeká na první import'
    if (state?.error) {
      status = 'Chyba importu'
      if (state.lastSuccess) status += ' · poslední úspěch ' + timestamp.format(new Date(state.lastSuccess))
      else if (source.initialEvents && state.events?.length) status += ' · zobrazuji ověřené termíny z pozvánek'
    } else if (state?.lastSuccess) {
      status = 'Aktualizováno ' + timestamp.format(new Date(state.lastSuccess))
      if (source.adapter && !state.events?.length) status += ' · žádný zveřejněný termín ve výhledu'
    }
    item.append(element('p', [scope, `Výhled ${source.days || config.windowDays} dní`, status].join(' · '), state?.error ? 'alert' : 'muted'))
    automatic.push(item)
  }
  get('source-links').replaceChildren(...automatic)
  get('source-references').replaceChildren(...references)
}

function readJson(path) {
  return fetch(path, {cache:'no-cache'}).then(response => {
    if (!response.ok) throw new Error(path)
    return response.json()
  })
}

const requests = [
  readJson('events.json').then(data => {
    snapshot = data
    theatre = (data.events || []).map(theatreEvent)
  }).catch(() => { snapshot = {error:true, feed:[{kind:'error', at:new Date().toISOString()}]} }),
  readJson('kino.json').then(data => { kino = data }).catch(() => {
    kino = {error:true, errorSince:new Date().toISOString()}
  }),
  readJson('discoveries.json').then(data => { discoveries = data }).catch(() => {
    discoveries = {failures:[{at:new Date().toISOString(), message:'Ručně vybrané akce se nepodařilo načíst.'}]}
  }),
  readJson('watch.json').then(data => { watch = data.sources || {} }).catch(() => {
    watch = {import:{error:true, lastAttempt:new Date().toISOString()}}
  }),
  readJson('exhibitions.json').then(data => {
    exhibitions = data.map(event => enrich({...event, type:'Výstavy', sourceId:'exhibitions'}))
    const items = exhibitions.map(event => {
      const item = element('li')
      const link = element('a', event.title)
      link.href = event.url
      item.append(link, document.createTextNode(' · ' + event.city))
      return item
    })
    get('exhibition-sources').replaceChildren(...items)
  }).catch(() => {
    get('exhibition-sources').replaceChildren(element('li', 'Výstavy se nepodařilo načíst.', 'alert'))
  }),
  readJson('sources.json').then(data => {
    config = data
    for (const source of data.links) sourceNames.set(source.id, source.name)
    const queries = data.queries.map(source => {
      const item = element('li')
      item.append(element('strong', source.query + ' · ' + source.city))
      if (source.variants?.length) item.append(element('p', source.variants.join(' · '), 'muted'))
      return item
    })
    get('source-queries').replaceChildren(...queries)
  }).catch(() => {
    get('source-links').replaceChildren(element('li', 'Seznam zdrojů se nepodařilo načíst.', 'alert'))
  })
]
Promise.all(requests).then(() => {
  loaded = true
  const states = [snapshot, kino, ...Object.values(watch)]
  const count = states.filter(state => state.error).length
  const latest = states.map(state => state.lastSuccess).filter(Boolean).sort().at(-1)
  get('status').textContent = latest ? 'Poslední úspěšný import ' + timestamp.format(new Date(latest))
    + (count ? ` · Zdroje s chybou: ${count}` : '') : 'Aktuální stav importu není dostupný.'
  updateEvents()
})
