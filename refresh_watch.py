"""Refresh independent source snapshots for the discovery feed."""
import hashlib
import json
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
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
    elif adapter == "sono":
        rows = sono(source, page)
    else:
        rows = festival(source, page, start)
    return [row for row in rows if row["url"] and row["title"]
            and row["date"] <= end.isoformat() and row.get("endDate", row["date"]) >= start.isoformat()]


def update_source(source, old, now):
    stamp = now.isoformat(timespec="seconds")
    try:
        rows = programme(source, now.date())
    except Exception as error:
        print(f"{source['name']}: {error}")
        return dict(old, lastAttempt=stamp, error=True)
    previous = {row["id"]: row for row in old.get("events", [])}
    if source["adapter"] == "sono":
        with ThreadPoolExecutor(max_workers=4) as pool:
            rows = list(pool.map(sono_detail, rows))
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
