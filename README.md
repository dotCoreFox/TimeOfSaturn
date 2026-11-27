# TimeOfSaturn

Veřejný měsíční kalendář a Feed změn programu Národního divadla Brno. Snapshot je v `site/events.json`. Workflow `program.yml` obnovuje program denně ve 02:00 v časovém pásmu Europe/Prague a nasazuje GitHub Pages.

Pro místní použití spusť `python -m http.server --directory site` a otevři server v prohlížeči. Import spustíš pomocí `pip install -r requirements.txt` a `python refresh.py`.
