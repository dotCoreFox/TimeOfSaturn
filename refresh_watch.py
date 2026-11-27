"""Refresh independent source snapshots for the discovery feed."""
import hashlib
import json
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

from refresh import PRAGUE, value

SITE = Path(__file__).parent / "site"
FILE = SITE / "watch.json"
NUMERIC = re.compile(r"(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})")
CLOCK = re.compile(r"\b([01]?\d|2[0-3])[:.]([0-5]\d)\b")
CZECH_MONTHS = r"leden|ledna|únor|února|březen|března|duben|dubna|květen|května|červen|června|červenec|července|srpen|srpna|září|říjen|října|listopad|listopadu|prosinec|prosince"
MONTHS_EN = "January February March April May June July August September October November December".split()
MONTH_NUMBER = {name: i + 1 for i, name in enumerate(MONTHS_EN)}
MONTH_NUMBER.update({name: i for i, names in enumerate((
    "leden ledna", "únor února", "březen března", "duben dubna", "květen května", "červen června",
    "červenec července", "srpen srpna", "září", "říjen října", "listopad listopadu", "prosinec prosince",
), 1) for name in names.split()})


def fetch(url, timeout=15):
    request = Request(url, headers={"User-Agent": "TimeOfSaturn/0.2 public events", "Accept-Language": "cs,en;q=0.8"})
    with urlopen(request, timeout=timeout) as response:
        return BeautifulSoup(response.read(), "html.parser")


def absolute(base, href):
    parsed = urlsplit(urljoin(base, href or ""))
    return urlunsplit(parsed._replace(fragment="")) if parsed.scheme == "https" else ""


def normalized(text):
    return "".join(c for c in unicodedata.normalize("NFKD", text.casefold()) if not unicodedata.combining(c))


def readable(text, limit=180):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def dates(text):
    return [date(int(year), int(month), int(day)) for day, month, year in NUMERIC.findall(text)]


def clock(text):
    match = CLOCK.search(text)
    return f"{int(match[1]):02}:{match[2]}" if match else ""


def event(source, title, span, url, *, time="", venue="", city="", description="", topics=(), price=""):
    start, end = span[0], span[-1]
    city = city or source.get("city", "Brno")
    key = hashlib.sha256(f"{source['id']}|{url.rstrip('/')}|{start}|{time}|{city}".encode()).hexdigest()[:18]
    row = dict(id=f"{source['id']}-{key}", sourceId=source["id"], title=title,
               date=start.isoformat(), time=time, city=city, venue=venue,
               country=source.get("country", "CZ"), scope=source.get("scope", "cz"),
               type=source.get("type", "Ostatní"), topics=list(topics or source.get("topics", [])),
               url=url, description=description)
    if source.get("starred"):
        row["starred"] = True
    if end > start:
        row["endDate"] = end.isoformat()
    if price:
        row["price"] = price
    return row


def local_cards(source, page):
    if source["adapter"] == "jic":
        cards = page.select("a.article-item-link:has(.datetimeplace-box)")
        for card in cards:
            fields = [value(item) for item in card.select(".datetimeplace-box > span")]
            if len(fields) < 3:
                continue
            venue = fields[2]
            city = next((name for pattern, name in ((r"\bbrn[oaě]\b", "Brno"), (r"\bprah[aey]\b", "Praha"))
                         if re.search(pattern, venue, re.I)), None)
            if not city:
                continue
            yield (value(card.select_one(".article-item-title")), dates(fields[0]), clock(fields[1]), city, venue,
                   value(card.select_one(".article-item-perex")), card["href"])
    else:
        cards = page.select("a.event-item:has(.event-item-date)")
        for card in cards:
            when = card.select_one(".event-item-date")
            tags = " ".join(value(node) for node in card.select(".event-label"))
            yield (value(card.select_one(".event-item-name")), dates(value(card.select_one(".event-item-title-date"))),
                   clock(value(when).rsplit("|", 1)[-1]), "Brno", "KUMST",
                   " · ".join(filter(None, [value(card.select_one(".event-item-perex")), tags])), card["href"])
    if not cards:
        raise ValueError("Program nemá rozpoznatelné položky")


def nicom(source, page):
    cards = page.select(".radek_druh_kurzu:has(.druh_kurzu_datum)")
    if not cards:
        raise ValueError("Tabulka termínů kurzu nebyla nalezena")
    for card in cards:
        city = value(card.select_one(".druh_kurzu_misto"))
        span = dates(value(card.select_one(".druh_kurzu_datum")))
        if city not in {"Brno", "Praha"} or not span:
            continue
        price = value(card.select_one(".druh_kurzu_cena > div:last-child"))
        length = value(card.select_one(".druh_kurzu_delka"))
        yield event(source, value(page.select_one("h1.h1_clanek_text")), span, source["url"],
                    time=clock(value(card.select_one(".druh_kurzu_hodina")).split("-")[0]),
                    city=city, venue="NICOM", description=length,
                    price=f"{price} bez DPH" if price else "")


def czech_span(text):
    text = " ".join(text.split())
    pattern = rf"(?:(\d{{1,2}})\.\s*(?:({CZECH_MONTHS})\s*)?[–—-]\s*)?(\d{{1,2}})\.\s*({CZECH_MONTHS})\s+(\d{{4}})"
    rows = []
    for first, first_month, last, month, year in re.findall(pattern, text):
        end = date(int(year), MONTH_NUMBER[month], int(last))
        if first:
            rows.append(date(int(year), MONTH_NUMBER[first_month or month], int(first)))
        rows.append(end)
    return rows


def brno_detail(source, row):
    try:
        page = fetch(row["url"])
        organizer = page.select_one(".b-card__row a.btn[href]")
        if organizer and value(organizer) == "Zjistěte více":
            row["organizerUrl"] = absolute(row["url"], organizer["href"])
        for script in page.select('script[type="application/ld+json"]'):
            data = json.loads(script.string or "{}")
            if not isinstance(data, dict) or data.get("@type") != "Event":
                continue
            venue = page.select_one(".b-card__row .font-bold")
            row["venue"] = (next(venue.stripped_strings, "") if venue else "") or data.get("location", {}).get("name", "")
            row["description"] = readable(data.get("description", ""))
            row["cancelled"] = data.get("eventStatus", "").endswith("EventCancelled")
            start = data.get("startDate", "")
            if start[:10] == row["date"] and start[11:16] not in {"00:00", ""}:
                row["time"] = start[11:16]
            break
        date_card = page.select_one(".b-card:has(.icon-svg--clock) .b-card__row.font-family-a")
        timings = []
        if date_card:
            for entry in date_card.select("strong"):
                span = czech_span(value(entry))
                if not span:
                    continue
                suffix = []
                for sibling in entry.next_siblings:
                    if getattr(sibling, "name", None) in {"br", "strong"}:
                        break
                    suffix.append(str(sibling))
                timings.append((span, clock(" ".join(suffix))))
        if timings and any(time for _, time in timings):
            updates = []
            base = {key: val for key, val in row.items() if key != "endDate"}
            for span, time in timings:
                occurrence = event(source, row["title"], span, row["url"], time=time)
                timing_fields = {key: occurrence[key] for key in ("id", "date", "time", "endDate") if key in occurrence}
                updates.append(dict(base, **timing_fields))
            return updates
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return [row]


def brno_cards(source, page):
    seen = set()
    for _ in range(8):
        cards = page.select("a.b-image:has(.b-image__desc)")
        if not cards and not seen:
            raise ValueError("Výpis Go To Brno nebyl nalezen")
        for card in cards:
            url = absolute(source["url"], card["href"])
            if url in seen or urlsplit(url).hostname != "www.gotobrno.cz":
                continue
            seen.add(url)
            span = czech_span(value(card.select_one(".b-image__desc")))
            if span:
                yield event(source, value(card.select_one(".b-image__title")), span, url)
        more = page.select_one("#more-actions-grid[href]")
        if not more:
            break
        next_url = absolute(source["url"], more["href"])
        if urlsplit(next_url).hostname != "www.gotobrno.cz":
            break
        page = fetch(next_url)


def sono(source, page):
    cards = page.select(".event-item:has(.date)")
    if not cards:
        raise ValueError("Program Sono nebyl nalezen")
    for card in cards:
        title = value(card.select_one("h2"))
        span = dates(value(card.select_one(".date")))
        link = card.select_one("a.link[href]")
        if title and span and link:
            yield event(source, title, span, absolute(source["url"], link["href"]), venue="Sono Centrum")


def sono_detail(row):
    try:
        page = fetch(row["url"], timeout=8)
    except OSError:
        return row
    headings = page.select(".detail-info p")
    for item in headings:
        if value(item.select_one("b")).rstrip(":").casefold() in {"start", "začátek"}:
            row["time"] = clock(value(item))
            break
    paragraphs = [value(item) for item in page.select("article.article > p") if value(item)]
    is_tribute = re.search(r"\b(tribute|pocta|filmova hudba|filmove hudby)\b", normalized(row["title"]))
    for paragraph in paragraphs[:3] if not is_tribute else []:
        text = normalized(paragraph)
        foreign = re.search(r"\b(zahranicn|japonsk|britsk|londynsk|americk|kanadsk|francouzsk|nemeck|svedsk|polsk|australsk)\w*", text)
        notable = re.search(r"\b(vehlasn|svetove znam|svetove proslul|mezinarodne uznavan|nejvyraznejs|grammy|headliner)\w*", text)
        if foreign and notable:
            row["topics"].append("hoste")
            row["description"] = readable(paragraph)
            break
    if paragraphs and not row["description"]:
        row["description"] = readable(paragraphs[0])
    return row


def festival(source, page, start):
    adapter = source["adapter"]
    url = source["url"]
    span = []
    if adapter == "amsterdam":
        for paragraph in page.select("p"):
            if not re.search(r"edition .* takes place", value(paragraph), re.I):
                continue
            for day, month, year in re.findall(r"(\d{1,2}) ([A-Z][a-z]+) (\d{4})", value(paragraph)):
                if month in MONTH_NUMBER:
                    span.append(date(int(year), MONTH_NUMBER[month], int(day)))
            break
    elif adapter == "lodz":
        match = re.search(r"([A-Z][a-z]+) (\d{1,2})\s*[–-]\s*(\d{1,2}),? (\d{4})", value(page.select_one("p.subtitle")))
        if match and match[1] in MONTH_NUMBER:
            span = [date(int(match[4]), MONTH_NUMBER[match[1]], int(day)) for day in match.group(2, 3)]
    elif adapter == "lerwick":
        editions = [(int(match[1]), a["href"]) for a in page.select("a[href]")
                    if (match := re.fullmatch(r"/up-helly-aa-(\d{4})/?", a["href"]))]
        if editions:
            url = absolute(url, max(editions)[1])
            heading = fetch(url).select_one("#content")
            match = re.search(r"(\d{1,2})(?:th|st|nd|rd)? January (\d{4})", value(heading))
            if match:
                span = [date(int(match[2]), 1, int(match[1]))]
    elif adapter == "wianki":
        editions = [(int(match[1]), a["href"]) for a in page.select("a[href]")
                    if (match := re.fullmatch(r"/wianki_nad_wisla/(\d{4})/?", urlsplit(a["href"]).path))]
        if editions:
            year, href = max(editions)
            url = absolute(url, href)
            for heading in fetch(url).select("h1, h2"):
                match = re.match(r"(\d{1,2}) czerwca\b", value(heading))
                if match:
                    span = [date(year, 6, int(match[1]))]
                    break
    elif adapter == "edinburgh":
        for link in page.select("a[href]"):
            if value(link) != "Torchlight Procession":
                continue
            context = value(link.find_parent("p"))
            day = re.search(r"(\d{1,2}) December", context)
            edition = re.search(r"\d{1,2} December (\d{4}) to", value(page))
            if day and edition:
                span = [date(int(edition[1]), 12, int(day[1]))]
                url = absolute(url, link["href"])
                break
    if span and span[-1] >= start:
        yield event(source, source["name"], span, url, description=source["description"])


def fablab(source, page, start, end):
    pages = {(start.year, start.month): page}
    for offset in range((end.year - start.year) * 12 + end.month - start.month + 1):
        month, year = (start.month - 1 + offset) % 12 + 1, start.year + (start.month - 1 + offset) // 12
        if (year, month) not in pages:
            pages[year, month] = fetch(urljoin(source["url"], f"{month}-{year}/"))
    for current in pages.values():
        entries = current.select("#action-list .event-times")
        if not entries and not current.select_one("#action-list"):
            raise ValueError("Výpis FabLab nebyl nalezen")
        for group in entries:
            title = value(group.parent.select_one("h3.title"))
            practical = not re.search(r"\btour\b|den otevrenych dveri", normalized(title))
            topics = ["kurzy", "prakticke"] if practical else ["projekty"]
            for link in group.select("a.event-date-time[href]"):
                url = absolute(source["url"], link["href"])
                when = re.search(r"/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})/?$", urlsplit(url).path)
                if when:
                    row = event(source, title, [date.fromisoformat(when[1])], url,
                                time=f"{when[2]}:{when[3]}", venue="FabLab Brno", topics=topics)
                    if not practical:
                        row["type"] = "Projekty a komunita"
                    yield row


def gopas(source, page):
    data = page.select_one("script#termsData")
    if not data or not data.string:
        raise ValueError("Tabulka termínů GOPAS nebyla nalezena")
    for item in json.loads(data.string):
        city = item["Locality"]
        span = dates(item["StartDayText"])
        if not span or city not in {"Brno", "Praha"} or item.get("IsDistanceTerm"):
            continue
        span.append(span[0] + timedelta(days=max(1, int(item["DaysCount"])) - 1))
        yield event(source, item["Name"], span, source["url"], city=city,
                    venue=(item.get("LocalityName") or "GOPAS").strip(),
                    description=item.get("DaysCountText") or "")


def naucmese(source, page):
    skill = re.compile(
        r"fotograf|sviceni|nataceni|impro|rozhovor|komunikac|recnictv|prezentac|herectv|zpev|hlas|"
        r"siti|hackov|pleten|tkan|drev|nabytek|nabytku|keramik|mozaik|slamena dilna|betonovani|"
        r"kreslen|malb|namaluj|psani|kaligraf|typograf|burlesk|3d modelov|excel|power bi|programov",
        re.I,
    )
    for index in range(5):
        cards = page.select(".course")
        if not cards and not index:
            raise ValueError("Výpis Naučmese nebyl nalezen")
        for card in cards:
            link = card.select_one(".perex h2 a[href]")
            title = value(link)
            city = value(card.select_one("address"))
            span = dates(value(card.select_one(".bottom_info time")))
            if not link or not span or city not in {"Brno", "Praha"} or not skill.search(normalized(title)):
                continue
            url = absolute(source["url"], link["href"])
            yield event(source, title, span, url, city=city,
                        description=readable(value(card.select_one(".perex p"))))
        next_page = page.select_one('a.js-course-load-button[href*="loadNextPage"][data-history-url]')
        if index == 4 or not next_page:
            break
        page = fetch(absolute(source["url"], next_page["data-history-url"]))


def predator(source, page):
    listing = page.select_one("#futureraceslistboxes")
    if not listing:
        raise ValueError("Program Predator Race nebyl nalezen")
    for card in listing.select(".race"):
        title = value(card.select_one(".race-info h2"))
        city = value(card.select_one(".single-race-info .place"))
        link = card.select_one('.race-info a[href*="/race/detail/"]')
        span = czech_span(value(card.select_one(".single-race-info")))
        if city and link and span:
            yield event(source, title, span, absolute(source["url"], link["href"]), city=city)


def spartan(source, page):
    cards = page.select('a.result[href*="/race/detail/"]')
    if not cards:
        raise ValueError("Program Spartan nebyl nalezen")
    for card in cards:
        title = value(card.select_one(".title"))
        location = [part.strip() for part in value(card.select_one(".location")).split(",")]
        when = value(card.select_one(".date"))
        formats = value(card.select_one(".events"))
        match = re.fullmatch(r"([A-Za-z]+)\s+(\d{1,2})(?:\s*[-–]\s*(?:([A-Za-z]+)\s+)?(\d{1,2}))?,\s*(\d{4})", when)
        if not match or not location or location[-1] != source["country"]:
            continue
        month, first, other_month, last, year = match.groups()
        month_index = next((i for i, name in enumerate(MONTHS_EN, 1) if name.startswith(month)), None)
        if not month_index:
            continue
        span = [date(int(year), month_index, int(first))]
        if last:
            end_month = next((i for i, name in enumerate(MONTHS_EN, 1) if name.startswith(other_month or month)), month_index)
            span.append(date(int(year) + (end_month < month_index), end_month, int(last)))
        city = next((part for part in location[:-1] if part != source["countryName"] and part != source["country"]), "")
        if not city:
            city = re.split(r"\s+(?:Spartan |EXPO |TRAIL|Race|Super|Sprint)", title, maxsplit=1, flags=re.I)[0]
        url = absolute(source["url"], card["href"])
        if not title.casefold().startswith("spartan"):
            title = "Spartan · " + title
        yield event(source, title, span, url, city=city, description=formats)


def pisklata(source, page):
    city = ""
    parsed = 0
    published = {(item["url"], item["date"]): item for item in source.get("initialEvents", [])}
    for node in page.select("h2, h3, h4"):
        title = value(node)
        if title in {"PRAHA", "BRNO"}:
            city = title.title()
        if normalized(title).startswith("udalosti uplynule"):
            break
        link = node.select_one("a[href]")
        card = node.find_parent("article") or node.find_parent(class_="fusion-post-content-wrapper")
        if not title or not link or not card or not city:
            continue
        url = absolute(source["url"], link["href"])
        if urlsplit(url).hostname not in {"pisklata.cz", "www.pisklata.cz"}:
            continue
        date_box = card.select_one(".fusion-date-box")
        numeric = re.search(r"\b(\d{1,2})\s+(\d{1,2}),?\s+(\d{4})\b", value(date_box))
        if numeric:
            day, month, year = map(int, numeric.groups())
            day = date(year, month, day)
        else:
            spelled = re.search(rf"\b(\d{{1,2}})\.?\s+({CZECH_MONTHS}),?\s+(\d{{4}})\b", value(card))
            if not spelled:
                continue
            day = date(int(spelled[3]), MONTH_NUMBER[spelled[2]], int(spelled[1]))
        parsed += 1
        prior = published.get((url, day.isoformat()), {})
        yield event(source, title, [day], url, city=city, time=prior.get("time", ""),
                    description=prior.get("description", "Komunitní akce Písklat."))
    if not parsed:
        raise ValueError("Ve veřejném programu Písklat se nepodařilo rozpoznat termíny")


def shibari_days(text, start):
    full = dates(text)
    if full:
        return full
    result = []
    for day, month in re.findall(r"\b(\d{1,2})\.\s*(\d{1,2})\.", text):
        for year in (start.year, start.year + 1):
            candidate = date(year, int(month), int(day))
            if candidate >= (result[-1] if result else start - timedelta(days=7)):
                result.append(candidate)
                break
    return result


def shibari(source, page, start):
    cards = page.select('a.event-card-item[href*="/akce/info/"]')
    if not cards:
        raise ValueError("Výpis Bad Reputation nebyl nalezen")
    for card in cards:
        title = value(card.select_one(".hover-content .card-title"))
        title = re.sub(r"\s+:", ":", title)
        label = value(card.select_one(".event-date"))
        span = shibari_days(label, start)
        url = absolute(source["url"], card["href"])
        if not title or not span:
            continue
        workshop = normalized(title).startswith("workshop")
        topics = ["kink", "kurzy", "prakticke"] if workshop else ["kink"]
        yield event(source, title, span, url, venue="Bad Reputation",
                    description="Workshop studia Bad Reputation." if workshop else "Komunitní akce studia Bad Reputation.",
                    topics=topics)


def shibari_detail(row):
    try:
        page = fetch(row["url"], timeout=6)
        label = value(page.select_one(".primary-content .d-lg-none p"))
        if match := re.search(r"\b\d{1,2}:[0-5]\d\b", label):
            row["time"] = clock(match[0])
    except OSError:
        pass
    return row


def olomouc_cards(source, page):
    body = page.select_one("body[data-page-id]")
    if not body:
        raise ValueError("Kalendář města Olomouc nebyl nalezen")
    url = urljoin(source["url"], "/wp-admin/admin-ajax.php")
    payload = urlencode({
        "action": "load_more", "currentPagination": 40,
        "pageID": body["data-page-id"], "taxID": body.get("data-tax-id", ""),
        "taxTitle": body.get("data-tax-title", ""), "selectedDate": "", "selectedTop": "",
    }).encode()
    request = Request(url, data=payload, headers={"User-Agent": "TimeOfSaturn/0.2 public events"})
    with urlopen(request, timeout=20) as response:
        listing = json.load(response)
    if listing.get("result") != "success":
        raise ValueError("Kalendář města Olomouc nevrátil seznam akcí")
    cards = BeautifulSoup(listing["data"], "html.parser").select("a.gen-action-item-inner[href]")
    if not cards:
        raise ValueError("Ve výpisu akcí nebyly nalezeny žádné položky")
    types = {
        "Koncerty, kluby": "Hudba", "Kino / film": "Kino", "Divadlo, balet": "Divadlo",
        "Výstavy, galerie": "Výstavy", "Sport": "Sport", "Bruslení": "Sport",
        "Vzdělávání": "Kurzy a dovednosti", "Besedy": "Debaty a přednášky",
        "Přednášky, školení": "Debaty a přednášky",
    }
    for card in cards:
        title = value(card.select_one("h4"))
        when = value(card.select_one(".gen-date p"))
        span = dates(when)
        url = absolute(source["url"], card["href"])
        if not title or not span or urlsplit(url).hostname != "tourism.olomouc.eu":
            continue
        if re.search(r"\b(strelba|strelnice|streleck\w*|palne zbrane)\b", normalized(title)):
            continue
        category = value(card.select_one(".gen-categories-list"))
        row = event(source, title, span, url, time=clock(when.split(" - ", 1)[0]),
                    description=f"Program města Olomouc · {category}" if category else "")
        row["type"] = types.get(category, "Ostatní")
        yield row


def programme(source, start):
    page = fetch(source["url"])
    end = start + timedelta(days=source["days"] - 1)
    adapter = source["adapter"]
    if adapter in {"jic", "kumst"}:
        rows = [event(source, title, span, absolute(source["url"], href), time=time,
                      city=city, venue=venue, description=readable(description))
                for title, span, time, city, venue, description, href in local_cards(source, page)
                if title and span and (span[-1] - span[0]).days <= 14]
    elif adapter == "brno":
        rows = (row for row in brno_cards(source, page) if row["date"] <= end.isoformat()
                and row.get("endDate", row["date"]) >= start.isoformat())
        with ThreadPoolExecutor(max_workers=4) as pool:
            rows = [item for result in pool.map(lambda row: brno_detail(source, row), rows) for item in result]
    elif adapter == "nicom":
        rows = nicom(source, page)
    elif adapter == "olomouc":
        rows = olomouc_cards(source, page)
    elif adapter == "sono":
        rows = sono(source, page)
    elif adapter == "shibari":
        rows = shibari(source, page, start)
    elif adapter == "fablab":
        rows = fablab(source, page, start, end)
    elif adapter in {"gopas", "naucmese", "predator", "spartan", "pisklata"}:
        rows = dict(gopas=gopas, naucmese=naucmese, predator=predator, spartan=spartan, pisklata=pisklata)[adapter](source, page)
    else:
        rows = festival(source, page, start)
    return [row for row in rows if row["url"] and row["title"]
            and row["date"] <= end.isoformat() and row.get("endDate", row["date"]) >= start.isoformat()]


def update_source(source, old, now):
    stamp = now.isoformat(timespec="seconds")
    if "events" not in old and source.get("initialEvents"):
        initial = [event(source, item["title"], [date.fromisoformat(item["date"])], item["url"],
                         time=item.get("time", ""), city=item["city"], description=item.get("description", ""))
                   for item in source["initialEvents"]]
        old = dict(old, events=[row for row in initial if row["date"] >= now.date().isoformat()])
    try:
        rows = programme(source, now.date())
    except Exception as error:
        print(f"{source['name']}: {error}")
        return dict(old, lastAttempt=stamp, error=True)
    previous = {row["id"]: row for row in old.get("events", [])}
    detail = {"sono":sono_detail, "shibari":shibari_detail}.get(source["adapter"])
    if detail:
        with ThreadPoolExecutor(max_workers=4) as pool:
            rows = list(pool.map(detail, rows))
    for row in rows:
        row["addedAt"] = previous.get(row["id"], {}).get("addedAt", stamp)
    print(f"{source['name']}: {len(rows)} akcí")
    return dict(events=sorted({row["id"]: row for row in rows}.values(), key=lambda row: (row["date"], row["time"], row["title"])),
                lastSuccess=stamp, lastAttempt=stamp, error=False)


def main():
    config = json.loads((SITE / "sources.json").read_text())
    previous = json.loads(FILE.read_text()).get("sources", {}) if FILE.exists() else {}
    now = datetime.now(PRAGUE)
    active = [source for source in config["links"] if source.get("adapter")]
    with ThreadPoolExecutor(max_workers=5) as pool:
        rows = pool.map(lambda source: update_source(source, previous.get(source["id"], {}), now), active)
        states = {source["id"]: state for source, state in zip(active, rows, strict=True)}
    temporary = FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps({"sources": states}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(FILE)


if __name__ == "__main__":
    main()
