# Pico-Chan VPS (parité Pico)

Implémentation FastAPI reproduisant les sémantiques du `main.py` MicroPython :
- Messages `{id, ts, text, hash}` (hash anonyme par IP + sel, rotation journalière optionnelle)
- Endpoints `/`, `/msg` (POST), `/poll`, `/stream` (SSE), `/healthz`
- Rate limit par IP (`POST_COOLDOWN`)
- Compteur de clients actifs sur 10s

## Variables d'environnement
- `PICOCHAN_SECRET_SALT` (défaut: `pc/sel-🌊-2025`)
- `PICOCHAN_HASH_ROTATE_DAILY` = `1`/`0`
- `PICOCHAN_POST_COOLDOWN` (float, secondes) — défaut 1.0
- `PICOCHAN_MAX_MSGS` — défaut 512

## Dév local
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export PICOCHAN_SECRET_SALT="change-moi"
uvicorn app:app --reload --port 8080
```

## Prod (Gunicorn + Nginx)
- Voir l'exemple de config dans la version précédente — identique.
- Assure-toi de passer `X-Forwarded-For` pour que le hash/anti-spam soient corrects.