"""Publish small reading payloads alongside the calendar snapshots."""
import json
import re
from pathlib import Path

NOTES = Path(__file__).with_name("reading_notes.json")


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
        if not (event.get("detailText") or event.get("admission") or (checked and event.get("description"))):
            continue
        fields = {name: event[name] for name in ("description", "detailText", "admission", "endTime") if event.get(name)}
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
