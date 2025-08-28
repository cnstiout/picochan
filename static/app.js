// static/app.js — Responsive mobile: palette → grille → publier (collé), feed en haut
(function(){
  // ===== DOM refs =====
  const log            = document.getElementById('log');

  // Tabs / panes
  const tabBtns        = document.querySelectorAll('.tab');
  const paneDiscussion = document.getElementById('f-discussion');
  const paneDessin     = document.getElementById('dessin-pane');

  // Discussion
  const formDis        = document.getElementById('f-discussion');
  const inputText      = document.getElementById('txt');

  // Dessin
  const gridEl         = document.getElementById('grid');
  const brushEl        = document.getElementById('brush');
  const eraserBtn      = document.getElementById('eraser');
  const clearBtn       = document.getElementById('clear');
  const publishBtn     = document.getElementById('publish');
  const paletteEl      = document.getElementById('palette');

  // ===== App state =====
  let currentChan = 'discussion';
  let last_id     = 0;
  let seen        = new Set();   // de-dup ids
  let es          = null;        // SSE messages
  let esDessin    = null;        // SSE canvas

  // Canvas (24x8)
  let G = { w:24, h:8, lines:Array(8).fill(' '.repeat(24)) };

  // Tools
  let painting        = false;
  let activePointerId = null;
  let eraserOn        = false;
  let keyBrush        = null;    // pressed key overrides brush

  // ===== Utils =====
  function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
  function firstCodePoint(s){
    const arr = Array.from(String(s||'').trim());
    return arr.length ? arr[0] : '';
  }
  function isPrintableKey(e){
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    return e.key && e.key.length === 1;
  }
  function brushChar(){
    if (eraserOn) return ' ';
    if (keyBrush) return keyBrush;
    const ch = firstCodePoint(brushEl?.value);
    return ch || '#';
  }
  function setEraser(on){
    eraserOn = !!on;
    if (eraserBtn){
      eraserBtn.textContent = 'Gomme : ' + (eraserOn ? 'ON' : 'OFF');
      eraserBtn.classList.toggle('secondary', !eraserOn);
      eraserBtn.classList.toggle('on', eraserOn);
    }
    if (eraserOn) keyBrush = null;
  }
  function applyCellSize(px){
    const clamped = Math.max(12, Math.min((px|0) || 26, 48));
    document.documentElement.style.setProperty('--cell', clamped + 'px');
  }

  // Fit grid to screen (no gap, no padding) → pixel-art collé
  function fitGridAuto(){
    if (!gridEl || !paneDessin) return;

    const cols = G.w, rows = G.h;

    // Width constraint = width of pane
    const wrapW = paneDessin.clientWidth || document.documentElement.clientWidth;
    const byW = Math.floor(wrapW / cols);

    // Height constraint = viewport from grid top to bottom minus publish row
    const rect = gridEl.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const publishH = (publishBtn && publishBtn.parentElement)
      ? publishBtn.parentElement.getBoundingClientRect().height
      : 40;
    const margin = 20;
    const availH = Math.max(120, viewportH - rect.top - publishH - margin);
    const byH = Math.floor(availH / rows);

    // Final cell size (leave a small room to avoid clipping of glyph)
    let cell = Math.min(byW, byH);
    cell = Math.max(12, Math.min(cell, 48));
    applyCellSize(cell);
  }

  // ===== Tabs / channel switching =====
  function setChan(chan){
    if (chan === currentChan) return;

    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.chan === chan));
    if (paneDiscussion) paneDiscussion.classList.toggle('on', chan === 'discussion');
    if (paneDessin)     paneDessin.classList.toggle('on', chan === 'dessin');

    currentChan = chan;
    last_id = 0;
    seen = new Set();
    if (log) log.innerHTML = '';

    if (es) { try{ es.close(); }catch(_){ } es = null; }
    initialPoll().then(connectSSE);

    if (chan === 'dessin') { connectDessinSSE(); setTimeout(fitGridAuto, 50); }
    else if (esDessin) { try{ esDessin.close(); }catch(_){ } esDessin = null; }
  }
  tabBtns.forEach(b => b.addEventListener('click', () => setChan(b.dataset.chan)));

  // ===== Feed rendering =====
  function addMsg(m){
    if (!m || seen.has(m.id)) return;
    if (m.chan !== currentChan) return;
    seen.add(m.id);
    last_id = Math.max(last_id, m.id);

    const el = document.createElement('div');
    el.className = 'msg';

    const dt = new Date(m.ts*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const color = m.color || '#6ee7ff';
    const hh = m.hash ? ('<span class="hash" style="border-color:'+esc(color)+';color:'+esc(color)+'">['+esc(m.hash)+']</span>') : 'anon';

    let body = '';
    if (m.chan === 'discussion') {
      body = '<div>'+esc(m.text || '')+'</div>';
    } else {
      const art = String(m.art || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      body = '<pre class="pre-art">'+art+'</pre>';
    }

    el.innerHTML = '<div class="meta">'+dt+' · '+hh+'</div>'+body;

    if (log){
      const atBottom = Math.abs(log.scrollHeight - (log.scrollTop + log.clientHeight)) < 60;
      log.appendChild(el);
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
  }

  // ===== Feed networking (poll + SSE) =====
  async function initialPoll(){
    try{
      const r = await fetch('/poll?last_id='+last_id+'&chan='+encodeURIComponent(currentChan), {cache:'no-store'});
      if (!r.ok) return;
      const arr = await r.json();
      for (const m of arr){ addMsg(m); }
    }catch(_){}
  }
  function connectSSE(){
    es = new EventSource('/stream?chan='+encodeURIComponent(currentChan));
    es.onmessage = (ev)=>{ try { addMsg(JSON.parse(ev.data)); } catch(_){ } };
    es.onerror   = ()=>{ setTimeout(()=>{ try{es.close();}catch(_){ } connectSSE(); }, 1200); };
  }

  // ====================== DESSIN 24×8 ======================
  const PALETTE = ["█","▓","▒","░","#","*",".","o","+","-","|","/","\\","_"];
  function renderPalette(){
    if (!paletteEl) return;
    paletteEl.innerHTML = '';
    PALETTE.forEach(ch=>{
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.textContent = ch;
      b.addEventListener('click', ()=>{
        setEraser(false);
        if (brushEl) brushEl.value = ch;
      });
      paletteEl.appendChild(b);
    });
  }

  function buildGrid(){
    if (!gridEl) return;
    gridEl.innerHTML = '';
    for(let y=0;y<G.h;y++){
      for(let x=0;x<G.w;x++){
        const d = document.createElement('div');
        d.className = 'cell';
        d.dataset.x = x; d.dataset.y = y;
        d.textContent = G.lines[y][x];
        gridEl.appendChild(d);
      }
    }
    fitGridAuto();
  }

  function updateCell(x,y,ch){
    const idx = y*G.w + x;
    const d = gridEl?.children[idx];
    if (d && d.textContent !== ch) d.textContent = ch;
    const row = G.lines[y];
    if (row[x] !== ch) G.lines[y] = row.substring(0,x) + ch + row.substring(x+1);
  }

  async function sendDiff(pixels){
    try{
      await fetch('/dessin/diff', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ pixels })
      });
    }catch(_){}
  }

  // Pointer events (mouse/touch/stylus)
  gridEl?.addEventListener('pointerdown', (e)=>{
    const t = e.target.closest('.cell'); if (!t) return;
    e.preventDefault();
    gridEl.setPointerCapture(e.pointerId);
    activePointerId = e.pointerId;
    painting = true;
    const x = +t.dataset.x, y = +t.dataset.y;
    const ch = brushChar();
    if (G.lines[y][x] !== ch){
      updateCell(x,y,ch);
      sendDiff([{x,y,ch}]);
    }
  });
  gridEl?.addEventListener('pointermove', (e)=>{
    if (!painting || e.pointerId !== activePointerId) return;
    e.preventDefault();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const t = el && el.closest ? el.closest('.cell') : null;
    if (!t || !gridEl.contains(t)) return;
    const x = +t.dataset.x, y = +t.dataset.y;
    const ch = brushChar();
    if (G.lines[y][x] !== ch){
      updateCell(x,y,ch);
      sendDiff([{x,y,ch}]);
    }
  });
  function endPaint(e){
    if (e && activePointerId !== null) {
      try { gridEl?.releasePointerCapture(activePointerId); } catch(_){}
    }
    painting = false;
    activePointerId = null;
  }
  gridEl?.addEventListener('pointerup', endPaint);
  gridEl?.addEventListener('pointercancel', endPaint);
  gridEl?.addEventListener('pointerleave', endPaint);

  // Right-click = gomme 1 cellule
  gridEl?.addEventListener('contextmenu', (e)=>{
    const t = e.target.closest('.cell'); if (!t) return;
    e.preventDefault();
    const x = +t.dataset.x, y = +t.dataset.y;
    const ch = ' ';
    if (G.lines[y][x] !== ch){
      updateCell(x,y,ch);
      sendDiff([{x,y,ch}]);
    }
  });

  // Tools
  eraserBtn?.addEventListener('click', ()=> setEraser(!eraserOn));
  clearBtn?.addEventListener('click', async ()=>{
    if (!confirm('Effacer tout le canvas ?')) return;
    const pixels = [];
    for (let y=0;y<G.h;y++){
      for (let x=0;x<G.w;x++){
        if (G.lines[y][x] !== ' '){
          pixels.push({x,y,ch:' '});
          G.lines[y] = G.lines[y].substring(0,x) + ' ' + G.lines[y].substring(x+1);
        }
      }
    }
    // clear visible instantly
    for (let i=0;i<(gridEl?.children.length||0);i++){
      gridEl.children[i].textContent = ' ';
    }
    await sendDiff(pixels);
  });
  publishBtn?.addEventListener('click', async ()=>{
    try{
      const r = await fetch('/dessin/publish', { method:'POST' });
      if (!r.ok && navigator.vibrate) navigator.vibrate(80);
    }catch(_){}
  });

  // Brush input: keep exactly 1 grapheme
  brushEl?.addEventListener('input', ()=>{
    if (eraserOn) return;
    const first = firstCodePoint(brushEl.value) || '#';
    brushEl.value = first;
  });
  brushEl?.addEventListener('focus', ()=> setEraser(false));
  brushEl?.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') e.preventDefault(); });

  // Hold printable key = temporary brush
  document.addEventListener('keydown', (e)=>{
    if (!isPrintableKey(e)) return;
    keyBrush = firstCodePoint(e.key);
  });
  document.addEventListener('keyup', ()=>{ keyBrush = null; });

  // Auto-fit on resize/orientation & when pane width changes
  window.addEventListener('resize', fitGridAuto);
  window.addEventListener('orientationchange', ()=> setTimeout(fitGridAuto, 120));
  // React to container width changes too (mobile UI shifts)
  if ('ResizeObserver' in window && paneDessin){
    const ro = new ResizeObserver(()=> fitGridAuto());
    ro.observe(paneDessin);
  }

  // SSE canvas
  function connectDessinSSE(){
    if (esDessin) { try{ esDessin.close(); }catch(_){ } }
    esDessin = new EventSource('/dessin/stream');
    esDessin.onmessage = (ev)=>{
      try{
        const m = JSON.parse(ev.data);
        if (m.full){
          G.w = m.full.w; G.h = m.full.h; G.lines = m.full.lines;
          buildGrid();
        } else if (typeof m.x === 'number'){
          updateCell(m.x, m.y, m.ch);
        }
      }catch(_){}
    };
    esDessin.onerror = ()=>{ setTimeout(connectDessinSSE, 1200); };
  }

  // Discussion submit
  formDis?.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    const text = (inputText?.value || '').trim();
    if (!text) return;
    try{
      const fd = new FormData();
      fd.set('chan','discussion');
      fd.set('text', text);
      const r = await fetch('/msg', { method:'POST', body: fd });
      if (r.status === 429 && navigator.vibrate) navigator.vibrate(60);
      if (inputText) inputText.value = '';
    }catch(_){}
    inputText?.focus();
  });

  // Feed boot
  renderPalette();
  initialPoll().then(connectSSE);
})();
