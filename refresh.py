"""Refresh the public event snapshot from the official NdB programme."""
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

SOURCE = "https://www.ndbrno.cz/program/"
FILE = Path(__file__).parent / "site" / "events.json"
PRAGUE = ZoneInfo("Europe/Prague")
CANCELLED = re.compile(r"^(?:představení\s+|akce\s+)?zrušen[oaé]?\b", re.I)


def fetch(url):
    if urlsplit(url).hostname != "www.ndbrno.cz":
        raise ValueError("Unexpected programme hostname")
    request = Request(url, headers={"User-Agent": "TimeOfSaturn/0.1 (+public event calendar)"})
    with urlopen(request, timeout=25) as response:
        return BeautifulSoup(response.read(), "html.parser")


def value(node):
    return node.get_text(" ", strip=True) if node else ""


def programme(start, end):
    events = {}
    for year, month in sorted({(day.year, day.month) for day in (start, end)}):
        page = fetch(f"{SOURCE}?month={month}&years={year}")
        if not page.select_one(f'.datechanger a.active[data-month="{month}"][data-year="{year}"]'):
            raise ValueError("The source did not return the requested month")
        groups = page.select("div.container-row:has(> .news.plan)")
        if not groups:
            raise ValueError("No programme sections found")
        for group in groups:
            match = re.search(r"(\d{1,2}\.\d{1,2}\.\d{4})", value(group.select_one("h2")))
            if not match:
                raise ValueError("Programme section has no date")
            date = datetime.strptime(match[0], "%d.%m.%Y").date()
            if not start <= date <= end:
                continue
            for card in group.select(".news.plan > .cl-k"):
                link = card.select_one("a.screen[href]")
                title = value(card.select_one("h3"))
                if not link or not title:
                    raise ValueError("Incomplete programme card")
                url = link["href"].rstrip("/") + "/"
                clock = re.search(r"\b\d{1,2}:\d{2}\b", " ".join(value(item) for item in card.select(":scope > ul > li")))
                time = clock[0].zfill(5) if clock else ""
                venue = value(card.select_one(':scope > span a[href*="/budova/"]'))
                if not venue:
                    venue = value(card.select_one(":scope > h3 + span > strong"))
                category = value(card.select_one(":scope > span:first-of-type a:last-child"))
                cancelled = any(CANCELLED.match(value(node)) for node in card.select(":scope > span, button, h3"))
                ticket = card.select_one('input[name="eventid"]')
                key = hashlib.sha256(f"{date}|{time}|{title.casefold()}|{venue.casefold()}".encode()).hexdigest()[:20]
                events[key] = dict(id=key, date=date.isoformat(), time=time, title=title,
                                   venue=venue, category=category, url=url, cancelled=cancelled,
                                   ticket=ticket["value"] if ticket else "")
    if not events:
        raise ValueError("The source returned no events in the 14-day window")
    return events


def describe(url):
    page = fetch(url)
    candidates = [value(p) for p in page.select("main p, section p") if not p.find_parent(["footer", "nav"])]
    paragraphs = [p for p in candidates if len(p.split()) >= 18 and not p.startswith(("Autorem", "Předplatné", "Přihlaste", "Vstupenky", "Tento web"))]
    words = paragraphs[0].split() if paragraphs else []
    excerpt = " ".join(words[:18]) + ("…" if len(words) > 18 else "")
    return excerpt


def refresh(state, now):
    start = now.date()
    end = start + timedelta(days=13)
    incoming = programme(start, end)
    existing = {row["id"]: row for row in state.get("events", [])}
    descriptions = state.setdefault("descriptions", {})
    sources = {}
    for event in incoming.values():
        show = re.sub(r"\s+", " ", event["title"].casefold())
        event["show"] = show
        sources.setdefault(show, event["url"])
    pending = {show: url for show, url in sources.items() if show not in descriptions}
    with ThreadPoolExecutor(max_workers=4) as pool:
        descriptions.update(zip(pending, pool.map(describe, pending.values()), strict=True))
    changes = []
    first = not state.get("lastSuccess")
    stamp = now.isoformat(timespec="seconds")
    for key, event in incoming.items():
        old = existing.get(key)
        if old and old["cancelled"] != event["cancelled"]:
            changes.append(dict(kind="cancelled" if event["cancelled"] else "restored", event=key, at=stamp))
        elif not old:
            changes.append(dict(kind="cancelled" if event["cancelled"] else "new", event=key, at=stamp))
        event["missing"] = False
        existing[key] = event
    for key, old in existing.items():
        if start.isoformat() <= old["date"] <= end.isoformat() and key not in incoming and not old["cancelled"] and not old.get("missing"):
            old["missing"] = True
            changes.append(dict(kind="missing", event=key, at=stamp))
    if state.get("error"):
        changes.insert(0, dict(kind="recovered", at=stamp))
    state.update(events=sorted(existing.values(), key=lambda row: (row["date"], row["time"], row["title"])),
                 feed=changes + state.get("feed", []), lastSuccess=stamp, lastAttempt=stamp,
                 error=False, fromDate=start.isoformat(), throughDate=end.isoformat())
    print(f"{'Initial import' if first else 'Refresh'}: {len(incoming)} occurrences")


def main():
    state = json.loads(FILE.read_text()) if FILE.exists() else {}
    now = datetime.now(PRAGUE)
    try:
        refresh(state, now)
    except Exception as error:
        print(f"Programme refresh failed: {error}")
        stamp = now.isoformat(timespec="seconds")
        if not state.get("error"):
            state.setdefault("feed", []).insert(0, dict(kind="error", at=stamp))
        state.update(lastAttempt=stamp, error=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(FILE)


if __name__ == "__main__":
    main()
