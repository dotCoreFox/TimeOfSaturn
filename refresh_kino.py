"""Read screening times from the Cinema Art programme and retain recent changes."""
import hashlib
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

from refresh import PRAGUE, value

SITE = Path(__file__).parent / "site"
FILE = SITE / "kino.json"
STAMP = re.compile(r"/(\d{4})/(\d{2})/(\d{2})/(\d{2})(\d{2})/?$")
CANCELLED = re.compile(r"^(?:projekce\s+)?zrušen[aoáé]?\b", re.I)


def programme(source, start, end):
    request = Request(source, headers={"User-Agent": "TimeOfSaturn/0.1 (+public event calendar)"})
    with urlopen(request, timeout=25) as response:
        page = BeautifulSoup(response.read(), "html.parser")
    events = {}
    for card in page.select(".events-calendar__event"):
        link = card.select_one(".events-calendar__event-title h3 a[href]")
        if not link:
            continue
        url = link["href"]
        parsed = urlsplit(url)
        match = STAMP.search(parsed.path)
        if not match or parsed.hostname != "www.kinoart.cz" or parsed.scheme != "https":
            continue
        year, month, day, hour, minute = match.groups()
        screening = date(int(year), int(month), int(day))
        if not start <= screening <= end:
            continue
        event_id = "kino-" + hashlib.sha256(parsed.path.rstrip("/").encode()).hexdigest()[:20]
        venue = value(card.select_one(".events-calendar__event-time a"))
        runtime = value(card.select_one(".credits__runtime, .credits__duration"))
        credits = {
            value(row.select_one("h3, h4, strong")).rstrip(":"): value(row.select_one("ul"))
            for row in card.select(".credits__movie-role-people")
        }
        language = value(card.select_one(".credits__event-movie-languages"))
        tags = [value(tag) for tag in card.select(".events-calendar__event-tags a")]
        notes = [runtime, language, ", ".join(tags)]
        if credits.get("Režie"):
            notes.insert(0, "Režie " + credits["Režie"])
        description = ". ".join(note for note in notes if note)
        cancelled = any(CANCELLED.match(value(item)) for item in card.select("h3, button, .events-calendar__event-tags a"))
        events[event_id] = dict(id=event_id, sourceId="kino-art", title=value(link), date=screening.isoformat(),
                                time=f"{hour}:{minute}", city="Brno", venue=f"Kino Art · {venue}" if venue else "Kino Art",
                                type="Kino", description=description, url=url, cancelled=cancelled)
    if not events:
        raise ValueError("No dated screening cards in the requested window")
    return events


def main():
    config = json.loads((SITE / "sources.json").read_text())
    source = next(row["url"] for row in config["links"] if row["id"] == "kino-art")
    last = json.loads(FILE.read_text()) if FILE.exists() else {}
    now = datetime.now(PRAGUE)
    stamp = now.isoformat(timespec="seconds")
    state = dict(last, lastAttempt=stamp)
    try:
        start = now.date()
        end = start + timedelta(days=config["windowDays"] - 1)
        incoming = programme(source, start, end)
        previous = {event["id"]: event for event in state.get("events", [])}
        for key, event in incoming.items():
            old = previous.get(key, {})
            event["addedAt"] = old.get("addedAt", stamp)
            if event["cancelled"]:
                event["cancelledAt"] = old.get("cancelledAt", stamp)
            previous[key] = event
        state.update(events=sorted(previous.values(), key=lambda row: (row["date"], row["time"], row["title"])),
                     lastSuccess=stamp, error=False)
        print(f"Kino Art: {len(incoming)} screenings")
    except Exception as error:
        print(f"Kino Art update failed: {error}")
        state.update(error=True, errorSince=last.get("errorSince", stamp) if last.get("error") else stamp)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    tmp.replace(FILE)


if __name__ == "__main__":
    main()
