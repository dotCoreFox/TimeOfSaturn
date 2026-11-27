const get = id => document.getElementById(id)
const zone = 'Europe/Prague'
const locale = 'cs-CZ'
const todayParts = new Intl.DateTimeFormat('en', {
  year:'numeric', month:'2-digit', day:'2-digit', timeZone:zone
}).formatToParts(new Date())
const today = ['year', 'month', 'day'].map(part => todayParts.find(item => item.type === part).value).join('-')
const [year, month] = today.split('-').map(Number)
let displayed = new Date(Date.UTC(year, month - 1, 1))
let weekStart = mondayOf(today)
let snapshot = {}
let events = new Map()
let programmeEvents = []
let watch = {}
let config
let currentView = 'calendar'
let newsLimit = 24
const sourceNames = new Map([
  ['ndb', 'Národní divadlo Brno'], ['kino-art', 'Kino Art'],
  ['gothic-brno', 'Gothic akce Brno'], ['exhibitions', 'Ruční výběr výstav']
])
const regionDays = {brno:7, praha:30, olomouc:30, cz:30, near:365, world:365}
const regionCities = {brno:'Brno', praha:'Praha', olomouc:'Olomouc'}
const matchesRegion = (event, region) => regionCities[region] ? event.city === regionCities[region] : event.scope === region
const regionNames = {cz:'Česko', near:'Okolní země', world:'Svět'}
let theatre = []
let kino = {}
let discoveries = {}
let exhibitions = []
let detailTrigger
let selectedDay
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
  hudba:'Hudba', hoste:'Výrazní hosté', kino:'Kino', svetlo:'Světlo a folklor', vystavy:'Výstavy', divadlo:'Divadlo', kink:'Kink a shibari', ocr:'Překážkové a trailové závody', strelnice:'Střelnice', sport:'Sport'
}
const typeTopics = Object.fromEntries(Object.entries(topicNames).map(([key, name]) => [name, key]))

const categoryGroups = {
  uceni:{label:'Učení a dovednosti', short:'Učení', icon:'mozek', tags:['kurzy', 'prakticke'], days:90},
  debaty:{label:'Debaty a setkání', short:'Debaty', icon:'debaty', tags:['projekty', 'debaty']},
  hudba:{label:'Hudba', short:'Hudba', icon:'hudba', tags:['hudba', 'hoste']},
  scena:{label:'Kino a divadlo', short:'Kino a scéna', icon:'divadlo', tags:['kino', 'divadlo']},
  vystavy:{label:'Výstavy a světlo', short:'Výstavy', icon:'vystavy', tags:['vystavy', 'svetlo']},
  kink:{label:'Kink a shibari', short:'Shibari', icon:'kink', tags:['kink'], days:30},
  sport:{label:'Sport a závody', short:'Sport', icon:'ocr', tags:['ocr', 'sport'], days:365},
  strelnice:{label:'Střelnice', short:'Střelnice', icon:'strelnice', tags:['strelnice']}
}
const groupForTopic = Object.fromEntries(Object.entries(categoryGroups).flatMap(([key, group]) =>
  group.tags.map(tag => [tag, key])))
const selectedTopics = new Set()
const brainTags = new Set(categoryGroups.uceni.tags)

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'category-icon')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const shape = document.createElementNS(svg.namespaceURI, 'use')
  shape.setAttribute('href', 'icons.svg#' + name)
  svg.append(shape)
  return svg
}

const eventCategory = event => typeTopics[event.type] || event.topics.find(topic => topicNames[topic]) || 'all'
const eventIcon = event => {
  const type = eventCategory(event)
  return icon(brainTags.has(type) ? 'mozek' : type === 'projekty' ? 'debaty' : type === 'sport' ? 'ocr' : type)
}

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
  const source = filters.get('source')
  if (!matchesRegion(event, region)) return false
  if (selectedTopics.size && !event.topics.some(topic => selectedTopics.has(groupForTopic[topic]))) return false
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

function mondayOf(day) {
  const weekday = new Date(day + 'T12:00:00Z').getUTCDay()
  return addDays(day, -((weekday + 6) % 7))
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
  const upcoming = [...programmeEvents, ...exhibitions].filter(eligible)
  const visible = upcoming.filter(event => !isLongEvent(event))
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
      const name = element('strong', '', 'agenda-title')
      name.append(eventIcon(event))
      label.append(titledEvent(name, event),
        element('span', [...new Set([event.type, event.city, event.venue].filter(Boolean))].join(' · '), 'agenda-meta'))
      if (event.cancelled || event.missing) label.append(element('span', event.cancelled ? kind.cancelled : kind.missing, 'agenda-status'))
      button.append(element('span', time, 'agenda-time'), label,
        element('span', sourceNames.get(event.sourceId) || '', 'agenda-source'))
      button.onclick = () => details(event, button)
      section.append(button)
    }
    list.append(section)
  }
  const ongoing = upcoming.filter(isLongEvent).sort(compareLongEvents)
  get('agenda-exhibitions').replaceChildren(...ongoing.map(event => longEventButton(event)))
  get('agenda-ongoing').hidden = !ongoing.length
  if (!visible.length && !ongoing.length && loaded) list.append(element('p', 'V tomto období nejsou pro zvolené filtry žádné akce.', 'muted'))
  get('result-count').textContent = loaded ? `Akce: ${visible.length + ongoing.length}` : ''
}

function showInspection(view) {
  get('panel-empty').hidden = Boolean(view)
  get('day-panel').hidden = !selectedDay
  get('details').hidden = view !== 'details'
  document.querySelector('.inspection').classList.toggle('has-selection', Boolean(view))
}

function focusInspection(heading) {
  heading.focus({preventScroll:true})
  if (!matchMedia('(min-width: 62rem)').matches) {
    heading.scrollIntoView({block:'nearest'})
  }
}

function details(event, trigger) {
  if (!get('day-panel-list').contains(trigger)) {
    selectedDay?.trigger.removeAttribute('aria-current')
    selectedDay = null
  }
  detailTrigger?.removeAttribute('aria-current')
  detailTrigger = trigger
  trigger.setAttribute('aria-current', 'true')
  const metaDate = event.endDate ? dayLabel(event.date) + ' – ' + dayLabel(event.endDate) : dayLabel(event.date)
  const title = get('event-title')
  title.replaceChildren()
  titledEvent(title, event)
  get('event-type').replaceChildren(eventIcon(event),
    document.createTextNode([event.type, event.city].filter(Boolean).join(' · ')))
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
  showInspection('details')
  focusInspection(title)
}

function closeDetails(restoreFocus = false) {
  const trigger = selectedDay?.trigger || detailTrigger
  detailTrigger?.removeAttribute('aria-current')
  selectedDay?.trigger.removeAttribute('aria-current')
  detailTrigger = null
  selectedDay = null
  showInspection()
  if (restoreFocus && trigger?.isConnected) trigger.focus()
}

function backToDay() {
  if (!selectedDay) {
    closeDetails(true)
    return
  }
  const trigger = detailTrigger
  detailTrigger?.removeAttribute('aria-current')
  detailTrigger = null
  showInspection('day-panel')
  if (trigger?.isConnected) trigger.focus()
  else focusInspection(get('day-panel-title'))
}

const isLongEvent = event => event.endDate &&
  (event.type === 'Výstavy' || event.endDate >= addDays(event.date, 6))
const compareLongEvents = (a, b) => a.endDate.localeCompare(b.endDate) || a.title.localeCompare(b.title, locale)
const overlaps = (event, start, end) => event.date <= end && (event.endDate || event.date) >= start

function longEventButton(event, range) {
  const button = element('button', '', 'long-event')
  button.type = 'button'
  const title = titledEvent(element('strong', '', 'long-title'), event)
  title.prepend(eventIcon(event))
  const location = element('span', [event.city, event.venue].filter(Boolean).join(' · '), 'long-location')
  button.append(title, location)
  const duration = dayLabel(event.date) + ' – ' + dayLabel(event.endDate)
  const rangeLabel = range && event.date <= range.start && event.endDate >= range.end ? 'Celý měsíc' : duration
  button.append(element('span', rangeLabel, 'long-date'))
  button.title = duration
  if (range) {
    const first = event.date <= range.start ? 0 : Number(event.date.slice(-2)) - 1
    const last = event.endDate >= range.end ? range.days : Number(event.endDate.slice(-2))
    const track = element('span', '', 'long-track')
    const bar = element('span', '', 'long-bar')
    track.setAttribute('aria-hidden', 'true')
    bar.style.insetInlineStart = (100 * first / range.days) + '%'
    bar.style.width = (100 * (last - first) / range.days) + '%'
    track.append(bar)
    button.append(track)
  }
  button.onclick = () => details(event, button)
  return button
}

const compareTimes = (a, b) => (a.time || '99').localeCompare(b.time || '99') || a.title.localeCompare(b.title, locale)

function dayEventButton(event, compact = false, time = event.time) {
  const button = element('button', '', compact ? 'event' : 'day-panel-event')
  button.type = 'button'
  const status = event.cancelled ? kind.cancelled : event.missing ? kind.missing : ''
  if (event.cancelled) button.classList.add('cancelled')
  if (event.missing) button.classList.add('missing')
  button.setAttribute('aria-label', [event.title, event.type, event.starred ? 'S hvězdičkou' : '',
    time, status].filter(Boolean).join(', '))
  button.title = [time, event.title, status].filter(Boolean).join(' · ')
  const name = titledEvent(element('span', '', 'calendar-event-title'), event)
  button.append(eventIcon(event), element(time ? 'time' : 'span', time || '–', 'event-time'), name)
  button.onclick = () => details(event, button)
  return button
}

function dayPanel(date, rows, trigger) {
  closeDetails()
  selectedDay = {trigger, date}
  trigger.setAttribute('aria-current', 'true')
  const title = get('day-panel-title')
  title.textContent = dayLabel(date)
  const groups = new Map()
  for (const event of rows) {
    const category = groupForTopic[eventCategory(event)] || 'all'
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category).push(event)
  }
  const sections = [...groups].map(([category, events]) => {
    const section = element('section', '', 'day-group')
    const heading = element('h3')
    const group = categoryGroups[category]
    heading.append(icon(group?.icon || 'all'), document.createTextNode(group?.label || 'Ostatní'))
    section.append(heading, ...events.map(event => dayEventButton(event)))
    return section
  })
  get('day-panel-list').replaceChildren(...(sections.length ? sections
    : [element('p', 'Pro tento den nejsou žádné akce ve zvolených filtrech.', 'muted')]))
  showInspection('day-panel')
  focusInspection(title)
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
  const matching = [...programmeEvents, ...exhibitions].filter(event =>
    overlaps(event, monthStart, monthEnd) && matchesFilters(event, filters))
  const longEvents = matching.filter(isLongEvent).sort(compareLongEvents)
  const range = {start:monthStart, end:monthEnd, days:numDays}
  get('exhibition-list').replaceChildren(...longEvents.map(event => longEventButton(event, range)))
  get('ongoing').hidden = !longEvents.length
  get('empty-calendar').hidden = !loaded || Boolean(matching.length)
  const byDay = new Map()
  for (const event of matching.filter(event => !isLongEvent(event))) {
    const day = event.date < monthStart ? monthStart : event.date
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(event)
  }
  const weeks = Math.ceil((leading + numDays) / 7)
  const busyWeeks = new Set([...byDay.keys()].map(date => Math.floor((leading + Number(date.slice(-2)) - 1) / 7)))
  calendar.style.gridTemplateRows = Array.from({length:weeks}, (_, week) =>
    busyWeeks.has(week) ? 'var(--week-busy)' : 'var(--week-quiet)').join(' ')
  for (let i = 0; i < weeks * 7; i++) {
    const day = i - leading + 1
    if (day < 1 || day > numDays) {
      calendar.append(element('div', '', 'day empty'))
      continue
    }
    const date = first + String(day).padStart(2, '0')
    const cell = element('div', '', date === today ? 'day today' : 'day')
    const dayEvents = (byDay.get(date) || []).sort(compareTimes)
    const number = element('button', String(day), 'date')
    number.type = 'button'
    number.setAttribute('aria-label', dayLabel(date) + ', počet akcí: ' + dayEvents.length)
    number.onclick = () => dayPanel(date, dayEvents, number)
    cell.append(number)
    for (const event of dayEvents.slice(0, 2)) cell.append(dayEventButton(event, true))
    if (dayEvents.length > 2) {
      const more = element('button', '+' + (dayEvents.length - 2), 'day-more')
      more.type = 'button'
      more.setAttribute('aria-label', 'Všechny akce · ' + dayLabel(date))
      more.onclick = () => dayPanel(date, dayEvents, more)
      cell.append(more)
    }
    calendar.append(cell)
  }
}

const weekdayLabel = new Intl.DateTimeFormat(locale, {weekday:'long', timeZone:zone})
function drawWeek() {
  const weekEnd = addDays(weekStart, 6)
  get('week-title').textContent = dayLabel(weekStart) + ' – ' + dayLabel(weekEnd)
  const filters = new FormData(get('filters'))
  const matching = [...programmeEvents, ...exhibitions].filter(event =>
    overlaps(event, weekStart, weekEnd) && matchesFilters(event, filters))
  const singleDays = matching.filter(event => !isLongEvent(event))
  const days = Array.from({length:7}, (_, offset) => {
    const date = addDays(weekStart, offset)
    const day = element('section', '', 'week-day' + (date === today ? ' week-today' : ''))
    const heading = element('h3')
    const label = weekdayLabel.format(new Date(date + 'T12:00:00Z'))
    const jump = element('button', label + ' ' + Number(date.slice(-2)) + '.' + Number(date.slice(5, 7)) + '.', 'week-date')
    const startsToday = event => event.date === date && event.time
    const events = singleDays.filter(event => overlaps(event, date, date)).sort((a, b) =>
      (startsToday(a) || '99').localeCompare(startsToday(b) || '99') || a.title.localeCompare(b.title, locale))
    jump.type = 'button'
    jump.onclick = () => dayPanel(date, events, jump)
    heading.append(jump, element('span', String(events.length), 'week-count'))
    day.append(heading)
    if (!events.length) day.append(element('p', 'Bez akcí', 'week-empty'))
    for (const event of events) {
      const button = dayEventButton(event, false, startsToday(event) || '')
      if (event.venue || event.city) button.append(element('span', event.venue || event.city, 'week-venue'))
      day.append(button)
    }
    return day
  })
  get('week-days').replaceChildren(...days)
  const ongoing = matching.filter(isLongEvent).sort(compareLongEvents)
  get('week-long-events').replaceChildren(...ongoing.map(event => longEventButton(event)))
  get('week-ongoing').hidden = !ongoing.length
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
  showNextStarredPeriod()
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
    if (!event) return !row.event && !filters.has('starred')
    if (!matchesFilters(event, filters)) return false
    const key = [event.id, row.kind, row.kind === 'new' ? '' : row.at].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!filters.has('starred') && !snapshot.error && snapshot.lastAttempt && Date.now() - Date.parse(snapshot.lastAttempt) > 27 * 3600000) {
    news.append(element('li', 'Denní aktualizace programu má zpoždění. Zobrazuji poslední dostupná data.', 'alert'))
  }
  for (const row of rows.slice(0, newsLimit)) {
    const event = events.get(row.event)
    const item = element('li', '', row.kind === 'error' ? 'alert' : '')
    const time = element('time', timestamp.format(new Date(row.at)))
    time.dateTime = row.at
    item.append(time, document.createTextNode(row.message || kind[row.kind]))
    if (event) {
      const button = element('button')
      button.append(eventIcon(event))
      titledEvent(button, event)
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
  else if (currentView === 'week') drawWeek()
  else drawFeed()
}

function setView(view) {
  if (view === 'week' && currentView === 'calendar') {
    const monthStart = displayed.toISOString().slice(0, 10)
    weekStart = mondayOf(selectedDay?.date || (monthStart.slice(0, 7) === today.slice(0, 7) ? today : monthStart))
  }
  if (view === 'calendar' && currentView === 'week') {
    const date = selectedDay?.date || addDays(weekStart, 3)
    displayed = new Date(date.slice(0, 7) + '-01T00:00:00Z')
  }
  closeDetails()
  currentView = view
  showNextStarredPeriod()
  get('agenda').hidden = view !== 'agenda'
  get('period-label').hidden = view !== 'agenda'
  get('month-view').hidden = view !== 'calendar'
  get('week-view').hidden = view !== 'week'
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
function setWeek(date) {
  closeDetails()
  weekStart = mondayOf(date)
  drawWeek()
}
get('week-previous').onclick = () => setWeek(addDays(weekStart, -7))
get('week-next').onclick = () => setWeek(addDays(weekStart, 7))
get('week-today').onclick = () => setWeek(today)
get('close-details').onclick = backToDay
get('close-day').onclick = () => closeDetails(true)
get('panel-empty').prepend(icon('inspect'))
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  if (!get('details').hidden) backToDay()
  else if (selectedDay) closeDetails(true)
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
const topicButtons = Object.entries(categoryGroups).map(([key, category]) => {
  const button = element('button', '', 'topic-button')
  button.type = 'button'
  button.dataset.topic = key
  button.setAttribute('aria-label', category.label)
  button.title = category.label
  const symbol = element('span', '', 'topic-symbol')
  symbol.append(icon(category.icon))
  const shortLabel = element('span', category.short, 'topic-label-short')
  shortLabel.setAttribute('aria-hidden', 'true')
  button.append(symbol, element('span', category.label, 'topic-label'), shortLabel)
  button.onclick = () => {
    if (selectedTopics.has(key)) selectedTopics.delete(key)
    else selectedTopics.add(key)
    get('source-filter').value = ''
    updateFilterPeriod()
    showNextStarredPeriod()
    filterChanged()
  }
  return button
})
get('topic-buttons').replaceChildren(...topicButtons)
for (const label of get('regions').querySelectorAll('label')) {
  const region = label.querySelector('input').value
  label.prepend(icon(regionCities[region] ? 'pin' : region))
}

function syncTopicButtons() {
  for (const button of topicButtons) {
    button.setAttribute('aria-pressed', String(selectedTopics.has(button.dataset.topic)))
  }
  get('clear-topics').disabled = !selectedTopics.size
}
syncTopicButtons()
get('clear-topics').onclick = () => {
  selectedTopics.clear()
  showNextStarredPeriod()
  filterChanged()
  topicButtons[0].focus()
}
function updateFilterPeriod() {
  const period = get('period')
  const minimum = Math.max(form.elements.starred.checked ? 30 : 0,
    ...[...selectedTopics].map(key => categoryGroups[key].days || 0))
  if (Number(period.value) < minimum) period.value = String(minimum)
}
function filterChanged() {
  syncTopicButtons()
  closeDetails()
  newsLimit = 24
  renderView()
}
function showNextStarredPeriod() {
  if (!form.elements.starred.checked || !['calendar', 'week'].includes(currentView)) return
  const filters = new FormData(form)
  const matches = [...programmeEvents, ...exhibitions].filter(event =>
    (event.endDate || event.date) >= today && matchesFilters(event, filters))
  const week = currentView === 'week'
  const first = week ? weekStart : displayed.toISOString().slice(0, 10)
  const last = week ? addDays(weekStart, 6) :
    new Date(Date.UTC(displayed.getUTCFullYear(), displayed.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
  if (matches.some(event => overlaps(event, first, last))) return
  const next = matches.map(event => event.date < today ? today : event.date).sort()[0]
  if (!next) return
  if (week) weekStart = mondayOf(next)
  else displayed = new Date(next.slice(0, 7) + '-01T00:00:00Z')
}

form.addEventListener('input', event => {
  if (event.target.name === 'region') {
    get('period').value = regionDays[event.target.value]
    get('source-filter').value = ''
    drawSourceOptions()
  }
  if (['region', 'starred'].includes(event.target.name)) {
    updateFilterPeriod()
    showNextStarredPeriod()
  }
  filterChanged()
})
form.onsubmit = event => event.preventDefault()
get('clear-filters').onclick = () => {
  form.elements.search.value = ''
  selectedTopics.clear()
  form.elements.source.value = ''
  form.elements.profile.checked = false
  form.elements.starred.checked = false
  filterChanged()
}

function drawSourceOptions() {
  const filter = get('source-filter')
  const region = new FormData(form).get('region')
  const matching = [...programmeEvents, ...exhibitions].filter(event => matchesRegion(event, region))
  const ids = new Set(matching.flatMap(event => event.sourceIds || [event.sourceId]))
  const selected = filter.value
  const options = [...ids].filter(id => sourceNames.has(id)).sort((a, b) => sourceNames.get(a).localeCompare(sourceNames.get(b), locale))
  filter.replaceChildren(new Option('Všechny zdroje', ''), ...options.map(id => new Option(sourceNames.get(id), id)))
  filter.value = ids.has(selected) ? selected : ''
}

function tableRow(heading, cells) {
  const row = element('tr')
  const name = element('th')
  name.scope = 'row'
  name.append(heading)
  row.append(name)
  for (const content of cells) {
    const cell = element('td')
    cell.append(content)
    row.append(cell)
  }
  return row
}

function sourceLink(name, url) {
  const link = element('a', name, 'source-link')
  link.href = url
  return link
}

function tableMessage(tbody, message, columns) {
  const row = element('tr')
  const cell = element('td', message, 'alert')
  cell.colSpan = columns
  row.append(cell)
  get(tbody).replaceChildren(row)
}

function drawSources() {
  drawSourceOptions()
  if (!config) return
  const current = {ndb:snapshot, 'kino-art':kino, ...watch}
  const automatic = []
  const references = []
  for (const source of config.links) {
    const imported = source.adapter || ['ndb', 'kino-art'].includes(source.id)
    const scope = regionNames[source.scope || 'cz']
    const link = sourceLink(source.name, source.url)
    if (!imported) {
      references.push(tableRow(link, [source.description, scope]))
      continue
    }
    const state = current[source.id]
    let status = 'Čeká na první import'
    if (state?.error) {
      status = 'Chyba importu'
      if (state.lastSuccess) status += ' · poslední úspěch ' + timestamp.format(new Date(state.lastSuccess))
      else if (source.initialEvents && state.events?.length) status += ' · zobrazuji ověřené termíny z pozvánek'
    } else if (state?.lastSuccess) {
      status = 'Aktualizováno ' + timestamp.format(new Date(state.lastSuccess))
      if (source.adapter && !state.events?.length) status += ' · žádný zveřejněný termín ve výhledu'
    }
    const statusCell = element('div')
    statusCell.append(element('span', status, state?.error ? 'alert' : ''), element('small',
      `Výhled ${source.days || config.windowDays} dní`, 'muted'))
    automatic.push(tableRow(link, [source.description, scope, statusCell]))
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
    const items = exhibitions.map(event => tableRow(sourceLink(event.title, event.url), [
      [event.city, event.venue].filter(Boolean).join(' · '), dayLabel(event.endDate)
    ]))
    get('exhibition-sources').replaceChildren(...items)
  }).catch(() => {
    tableMessage('exhibition-sources', 'Výstavy se nepodařilo načíst.', 3)
  }),
  readJson('sources.json').then(data => {
    config = data
    for (const source of data.links) sourceNames.set(source.id, source.name)
    const queries = data.queries.map(source => {
      const variants = element('ul', '', 'keyword-list')
      for (const term of source.variants || []) variants.append(element('li', term))
      return tableRow(source.query, [source.city || '', variants])
    })
    get('source-queries').replaceChildren(...queries)
  }).catch(() => {
    tableMessage('source-links', 'Seznam zdrojů se nepodařilo načíst.', 4)
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
