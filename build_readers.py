"""Publish small reading payloads alongside the calendar snapshots."""
import json
import re
from pathlib import Path
from shutil import copytree

NOTES = Path(__file__).with_name("reading_notes.json")
SITE = Path(__file__).with_name("site")


def write_readers(site, states):
    notes = json.loads(NOTES.read_text(encoding="utf-8"))
    discoveries = json.loads((site / "discoveries.json").read_text(encoding="utf-8"))
    watch = (event for state in states.values() for event in state.get("events", []))
    folder = site / "reading"
    folder.mkdir(exist_ok=True)
    published = set()
    for event in [*watch, *discoveries.get("events", [])]:
        key = event.get("id", "")
        if not re.fullmatch(r"[a-z0-9-]+", key):
            continue
        checked = event.get("detailCheckedAt")
        facts = event.get("readingFacts")
        links = event.get("readingLinks")
        if not (facts or links or event.get("detailText") or event.get("admission") or (checked and event.get("description"))):
            continue
        fields = {name: event[name] for name in ("description", "detailText", "admission", "endTime") if event.get(name)}
        if facts:
            fields["facts"] = facts
        if links:
            fields["links"] = links
        if checked:
            fields["checkedAt"] = checked
        fields.update(notes.get(key, {}))
        path = folder / f"{key}.json"
        path.write_text(json.dumps(fields, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        published.add(path)
    for path in folder.glob("*.json"):
        if path not in published:
            path.unlink()
    print(f"Režim čtení: {len(published)} pozvánek")


def prepare_site(site, public):
    copytree(site, public, dirs_exist_ok=True)
    path = public / "watch.json"
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    states = snapshot.get("sources", {})
    write_readers(public, states)
    for state in states.values():
        for event in state.get("events", []):
            facts = event.pop("readingFacts", None)
            links = event.pop("readingLinks", None)
            if facts or links:
                event["hasReadingExtras"] = True
    path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    prepare_site(SITE, SITE.with_name("public"))
