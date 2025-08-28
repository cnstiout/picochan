# app.py — Pico-Chan VPS (channels + canvas 24x8 + dédoublonnage + couleur par hash)
# FastAPI + SSE. Messages:
#   discussion: {id, ts, chan:"discussion", text, hash, color}
#   dessin    : {id, ts, chan:"dessin",     art,  hash, color}
#
# Endpoints principaux:
#   GET  /                  -> UI (Jinja)
#   GET  /channels          -> ["discussion","dessin"]
#   GET  /poll?last_id&chan -> liste des messages du channel
#   GET  /stream?chan       -> SSE live (sans historique) pour le channel
#   POST /msg               -> post texte (chan=discussion)
#   GET  /dessin/canvas     -> état actuel du canvas 24x8
#   GET  /dessin/stream     -> SSE du canvas (full initial + diffs)
#   POST /dessin/diff       -> appliquer un ou plusieurs pixels
#   POST /dessin/publish    -> publier un snapshot du canvas dans le fil "dessin"
#   GET  /healthz           -> état serveur
#
# Réglages via env:
#   PICOCHAN_SECRET_SALT            (def: "pc/sel-🌊-2025")
#   PICOCHAN_HASH_ROTATE_DAILY=1/0  (def: 1)
#   PICOCHAN_POST_COOLDOWN=float s  (def: 1.0)
#   PICOCHAN_MAX_MSGS=int           (def: 512)

import os, time, asyncio, hashlib, json as _json
from collections import deque
from typing import Deque, Dict, Any, List

from fastapi import FastAPI, Request, HTTPException, Form, Response
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

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

# Channels
CHANNELS = ("discussion", "dessin")

# Canvas 24x8
CANVAS_W, CANVAS_H = 24, 8
_canvas_lock = asyncio.Lock()
_canvas: List[List[str]] = [[ " " for _ in range(CANVAS_W) ] for __ in range(CANVAS_H)]
_canvas_subs: List[asyncio.Queue] = []  # SSE abonnés du canvas

# --------------------------
# État messages
# --------------------------
_messages: Deque[Dict[str, Any]] = deque(maxlen=MAX_MSGS)
_next_id = 1
_last_post: Dict[str, float] = {}   # ip -> last ts (rate limit)
_clients: Dict[str, float] = {}     # ip -> last ts (clients actifs)
_subscribers: List[asyncio.Queue] = []  # SSE abonnés des messages

# --------------------------
# Utils
# --------------------------
def now_s() -> int:
    return int(time.time())

def client_ip(request: Request) -> str:
    # récupère l'IP réelle si derrière Nginx
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"

def anon_hash_for_ip(ip: str, t: int) -> str:
    day_bucket = (t // 86400) if HASH_ROTATE_DAILY else 0
    payload = f"{ip}|{SECRET_SALT}|{day_bucket}".encode()
    hx = hashlib.sha1(payload).hexdigest()[:6].upper()  # 6 hex
    return hx

# Couleur stable depuis le hash (HSL pastel -> HEX)
def hsl_to_rgb(h, s, l):
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
    try:
        n = int(hx6, 16)
    except Exception:
        n = 0x123456
    hue = (n % 360)         # 0..359
    sat = 0.58              # lisible, assez saturé
    lig = 0.58
    r,g,b = hsl_to_rgb(hue, sat, lig)
    return f"#{r:02X}{g:02X}{b:02X}"

def active_clients_count() -> int:
    t = now_s()
    dead = [ip for ip, ts in list(_clients.items()) if (t - ts) > CLIENT_ACTIVE_S]
    for ip in dead:
        _clients.pop(ip, None)
    return len(_clients)

def jdump(o) -> str:
    return _json.dumps(o, separators=(",",":"))

# Canvas helpers
def canvas_as_lines() -> List[str]:
    return ["".join(row) for row in _canvas]

def canvas_as_text() -> str:
    return "\n".join(canvas_as_lines())

async def canvas_set_cell(x: int, y: int, ch: str):
    if not (0 <= x < CANVAS_W and 0 <= y < CANVAS_H): return
    if not ch or len(ch) != 1: return
    _canvas[y][x] = ch

async def canvas_broadcast(msg: dict):
    for q in list(_canvas_subs):
        try:
            q.put_nowait(msg)
        except Exception:
            pass

# --------------------------
# Messages push & query
# --------------------------
def push_message_discussion(text: str, h: str):
    global _next_id
    msg = {"id": _next_id, "ts": now_s(), "chan":"discussion",
           "text": text, "hash": h, "color": color_from_hash(h)}
    _next_id += 1
    _messages.append(msg)
    for q in list(_subscribers):
        try: q.put_nowait(msg)
        except: pass

def push_message_dessin(art: str, h: str):
    global _next_id
    msg = {"id": _next_id, "ts": now_s(), "chan":"dessin",
           "art": art, "hash": h, "color": color_from_hash(h)}
    _next_id += 1
    _messages.append(msg)
    for q in list(_subscribers):
        try: q.put_nowait(msg)
        except: pass

def get_since(last_id: int, chan: str) -> List[Dict[str,Any]]:
    if last_id < 0: last_id = 0
    if chan not in CHANNELS: return []
    out: List[Dict[str,Any]] = []
    for m in _messages:
        if m.get("chan") == chan and m["id"] > last_id:
            out.append(m)
            if len(out) >= POLL_BATCH: break
    return out

# --------------------------
# FastAPI app
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

@app.get("/channels")
async def channels():
    return list(CHANNELS)

# -------- Fil de messages (channels) --------
@app.get("/poll")
async def poll(request: Request, last_id: int = 0, chan: str = "discussion"):
    ip = client_ip(request); _clients[ip] = now_s()
    return get_since(last_id, chan)

@app.get("/stream")
async def stream(request: Request, chan: str = "discussion"):
    if chan not in CHANNELS:
        raise HTTPException(status_code=400, detail="unknown channel")
    ip = client_ip(request); _clients[ip] = now_s()

    queue: asyncio.Queue = asyncio.Queue()
    _subscribers.append(queue)

    async def event_generator():
        try:
            # PAS d'historique ici -> évite les doublons avec /poll
            while True:
                if await request.is_disconnected(): break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                    if msg.get("chan") == chan:
                        yield ("data: " + jdump(msg) + "\n\n")
                except asyncio.TimeoutError:
                    yield "event: ping\ndata: {}\n\n"
        finally:
            if queue in _subscribers:
                _subscribers.remove(queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.post("/msg")
async def post_msg(request: Request, text: str = Form(...), chan: str = Form("discussion")):
    if chan != "discussion":
        raise HTTPException(status_code=400, detail="use /dessin/* for canvas")
    ip = client_ip(request); tnow = time.time(); _clients[ip] = now_s()

    # rate limit
    last = _last_post.get(ip, 0.0)
    if (tnow - last) < POST_COOLDOWN:
        raise HTTPException(status_code=429, detail="slow down")
    _last_post[ip] = tnow

    # sanitize
    text = (text or "").strip().replace("\r\n", "\n")
    if not text:
        raise HTTPException(status_code=400, detail="empty")
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT]

    h = anon_hash_for_ip(ip, int(tnow))
    push_message_discussion(text, h)
    return Response(status_code=204)  # No Content (aucun corps)

# -------- Canvas 24x8 (dessin) --------
class Pix(BaseModel):
    x: int
    y: int
    ch: str = Field(min_length=1, max_length=1)

class DiffReq(BaseModel):
    pixels: List[Pix]

@app.get("/dessin/canvas")
async def dessin_canvas():
    # état actuel (8 lignes de 24 colonnes)
    return {"w": CANVAS_W, "h": CANVAS_H, "lines": canvas_as_lines()}

@app.get("/dessin/stream")
async def dessin_stream(request: Request):
    ip = client_ip(request); _clients[ip] = now_s()
    queue: asyncio.Queue = asyncio.Queue()
    _canvas_subs.append(queue)

    async def gen():
        try:
            # full state initial
            await queue.put({"full": {"w": CANVAS_W, "h": CANVAS_H, "lines": canvas_as_lines()}})
            while True:
                if await request.is_disconnected(): break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield "data: " + jdump(msg) + "\n\n"
                except asyncio.TimeoutError:
                    yield "event: ping\ndata: {}\n\n"
        finally:
            if queue in _canvas_subs:
                _canvas_subs.remove(queue)

    return StreamingResponse(gen(), media_type="text/event-stream")

@app.post("/dessin/diff")
async def dessin_diff(req: DiffReq, request: Request):
    ip = client_ip(request); tnow = time.time(); _clients[ip] = now_s()
    if len(req.pixels) > 256:
        raise HTTPException(status_code=400, detail="too many pixels")
    async with _canvas_lock:
        for p in req.pixels:
            await canvas_set_cell(p.x, p.y, p.ch)
    # broadcast par pixel
    for p in req.pixels:
        await canvas_broadcast({"x": p.x, "y": p.y, "ch": p.ch})
    return {"ok": True, "n": len(req.pixels)}

@app.post("/dessin/publish")
async def dessin_publish(request: Request):
    ip = client_ip(request); tnow = time.time(); _clients[ip] = now_s()

    # Reuse du rate-limit "post"
    last = _last_post.get(ip, 0.0)
    if (tnow - last) < POST_COOLDOWN:
        raise HTTPException(status_code=429, detail="slow down")
    _last_post[ip] = tnow

    h = anon_hash_for_ip(ip, int(tnow))
    async with _canvas_lock:
        art = canvas_as_text()  # 8 lignes * 24 colonnes
    push_message_dessin(art, h)
    return {"ok": True}
