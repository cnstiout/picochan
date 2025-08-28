# app.py — Pico-Chan VPS (parité Pico, dédoublonnage + couleur par auteur)
# FastAPI + SSE, messages: {id, ts, text, hash, color}
# Diff vs version précédente:
#  - /stream: SUPPRIME l’envoi d’historique (plus de doublons avec /poll)
#  - Ajoute un champ "color" déterministe par hash
#  - /poll et SSE renvoient toujours la même forme de message

import os, time, asyncio, hashlib, math, json as _json
from collections import deque
from typing import Deque, Dict, Any, List

from fastapi import FastAPI, Request, HTTPException, Form
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# --------------------------
# Réglages
# --------------------------
TITLE = "Pico-chan"
MAX_MSGS = int(os.getenv("PICOCHAN_MAX_MSGS", "512"))
MAX_TEXT = 240
POLL_BATCH = 64
POST_COOLDOWN = float(os.getenv("PICOCHAN_POST_COOLDOWN", "1.0"))
CLIENT_ACTIVE_S = 10

SECRET_SALT = os.getenv("PICOCHAN_SECRET_SALT", "pc/sel-🌊-2025")
HASH_ROTATE_DAILY = os.getenv("PICOCHAN_HASH_ROTATE_DAILY", "1") not in ("0","false","False","FALSE")

# --------------------------
# État serveur
# --------------------------
_messages: Deque[Dict[str, Any]] = deque(maxlen=MAX_MSGS)
_next_id = 1
_last_post: Dict[str, float] = {}   # ip -> last ts
_clients: Dict[str, float] = {}     # ip -> last ts
_subscribers: List[asyncio.Queue] = []

def now_s() -> int:
    return int(time.time())

def client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"

def anon_hash_for_ip(ip: str, t: int) -> str:
    day_bucket = (t // 86400) if HASH_ROTATE_DAILY else 0
    payload = f"{ip}|{SECRET_SALT}|{day_bucket}".encode()
    hx = hashlib.sha1(payload).hexdigest()[:6].upper()
    return hx  # 6 hex chars

# ---- Couleur déterministe depuis le hash (HSL -> HEX) ----
def hsl_to_rgb(h, s, l):
    # h=0..360, s,l = 0..1 ; retourne tuple (r,g,b) 0..255
    c = (1 - abs(2*l - 1)) * s
    hp = (h / 60.0) % 6
    x = c * (1 - abs(hp % 2 - 1))
    r1=g1=b1=0
    if   0 <= hp < 1: r1,g1,b1 = c,x,0
    elif 1 <= hp < 2: r1,g1,b1 = x,c,0
    elif 2 <= hp < 3: r1,g1,b1 = 0,c,x
    elif 3 <= hp < 4: r1,g1,b1 = 0,x,c
    elif 4 <= hp < 5: r1,g1,b1 = x,0,c
    elif 5 <= hp < 6: r1,g1,b1 = c,0,x
    m = l - c/2
    r = int((r1 + m) * 255 + 0.5)
    g = int((g1 + m) * 255 + 0.5)
    b = int((b1 + m) * 255 + 0.5)
    return r,g,b

def color_from_hash(hx6: str) -> str:
    """
    Couleur stable par "personne": on tire la teinte depuis le hash,
    saturation/lumière fixes pour rester lisible (pastel-ish).
    """
    try:
        n = int(hx6, 16)  # 0..0xFFFFFF
    except Exception:
        n = 0x123456
    hue = (n % 360)                  # 0..359
    sat = 0.58                       # 58% (bonne lisibilité)
    lig = 0.58                       # 58%
    r,g,b = hsl_to_rgb(hue, sat, lig)
    return f"#{r:02X}{g:02X}{b:02X}"

def active_clients_count() -> int:
    t = now_s()
    dead = [ip for ip, ts in list(_clients.items()) if (t - ts) > CLIENT_ACTIVE_S]
    for ip in dead:
        _clients.pop(ip, None)
    return len(_clients)

def push_message(text: str, h: str):
    global _next_id
    msg = {"id": _next_id, "ts": now_s(), "text": text, "hash": h, "color": color_from_hash(h)}
    _next_id += 1
    _messages.append(msg)
    # fanout SSE (live uniquement, pas d’historique)
    for q in list(_subscribers):
        try:
            q.put_nowait(msg)
        except Exception:
            pass

def get_since(last_id: int) -> List[Dict[str, Any]]:
    if last_id < 0: last_id = 0
    out: List[Dict[str, Any]] = []
    for m in _messages:
        if m["id"] > last_id:
            out.append(m)
            if len(out) >= POLL_BATCH:
                break
    return out

def jdump(o): return _json.dumps(o, separators=(",",":"))

# --------------------------
# App / routes
# --------------------------
app = FastAPI(title="Pico-Chan VPS")

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "title": TITLE,
        "maxlen": MAX_TEXT,
        "maxmsgs": MAX_MSGS,
    })

@app.get("/healthz")
async def healthz():
    return {
        "ok": True,
        "clients_active": active_clients_count(),
        "msgs": len(_messages),
        "hash_rotate_daily": HASH_ROTATE_DAILY
    }

@app.get("/poll")
async def poll(request: Request, last_id: int = 0):
    ip = client_ip(request)
    _clients[ip] = now_s()
    return get_since(last_id)

@app.post("/msg")
async def post_msg(request: Request, text: str = Form(...)):
    ip = client_ip(request)
    tnow = time.time()
    _clients[ip] = now_s()

    last = _last_post.get(ip, 0.0)
    if (tnow - last) < POST_COOLDOWN:
        raise HTTPException(status_code=429, detail="slow down")
    _last_post[ip] = tnow

    text = (text or "").strip().replace("\r\n", "\n")
    if not text:
        raise HTTPException(status_code=400, detail="empty")
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT]

    h = anon_hash_for_ip(ip, int(tnow))
    push_message(text, h)
    return JSONResponse(status_code=204, content=None)  # No Content

@app.get("/stream")
async def stream(request: Request):
    # IMPORTANT: pas d'historique ici -> évite doublons avec initial poll
    ip = client_ip(request)
    _clients[ip] = now_s()

    queue: asyncio.Queue = asyncio.Queue()
    _subscribers.append(queue)

    async def event_generator():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield ("data: " + jdump(msg) + "\n\n")
                except asyncio.TimeoutError:
                    yield "event: ping\ndata: {}\n\n"
        finally:
            if queue in _subscribers:
                _subscribers.remove(queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")
