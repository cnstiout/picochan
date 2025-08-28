
# app.py — Pico-Chan VPS (parité Pico)
# FastAPI + SSE. Schéma message: {id, ts, text, hash}
# Env:
#   PICOCHAN_SECRET_SALT="pc/sel-🌊-2025"
#   PICOCHAN_HASH_ROTATE_DAILY="1" (ou "0")
#   PICOCHAN_POST_COOLDOWN="1.0"
#   PICOCHAN_MAX_MSGS="512"
# Run dev: uvicorn app:app --reload --port 8080

import os, time, asyncio, hashlib
from collections import deque
from typing import Deque, Dict, Any, List, Optional

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
    # X-Forwarded-For (trust your reverse proxy)
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"

def anon_hash_for_ip(ip: str, t: int) -> str:
    day_bucket = (t // 86400) if HASH_ROTATE_DAILY else 0
    payload = f"{ip}|{SECRET_SALT}|{day_bucket}".encode()
    hx = hashlib.sha1(payload).hexdigest()[:6].upper()
    return hx

def active_clients_count() -> int:
    t = now_s()
    dead = [ip for ip, ts in list(_clients.items()) if (t - ts) > CLIENT_ACTIVE_S]
    for ip in dead:
        _clients.pop(ip, None)
    return len(_clients)

def push_message(text: str, h: str):
    global _next_id
    msg = {"id": _next_id, "ts": now_s(), "text": text, "hash": h}
    _next_id += 1
    _messages.append(msg)
    # fanout SSE
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
    # mark active
    _clients[ip] = now_s()

    # rate limit
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
    # 204 No Content (no body)
    return JSONResponse(status_code=204, content=None)

@app.get("/stream")
async def stream(request: Request):
    ip = client_ip(request)
    _clients[ip] = now_s()

    queue: asyncio.Queue = asyncio.Queue()
    _subscribers.append(queue)

    async def event_generator():
        try:
            # history
            for m in list(_messages)[-20:]:
                yield ("data: " + json_dump(m) + "\n\n")
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield ("data: " + json_dump(msg) + "\n\n")
                except asyncio.TimeoutError:
                    yield "event: ping\ndata: {}\n\n"
        finally:
            if queue in _subscribers:
                _subscribers.remove(queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# Tiny JSON (stdlib is fine, keep it compact)
import json as _json
def json_dump(obj) -> str:
    return _json.dumps(obj, separators=(",",":"))
