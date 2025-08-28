(function(){
  const log = document.getElementById('log');

  // Onglets / canaux
  const tabBtns = document.querySelectorAll('.tab');
  const paneDiscussion = document.getElementById('f-discussion');
  const paneDessin = document.getElementById('dessin-pane');

  // Discussion widgets
  const formDis = document.getElementById('f-discussion');
  const inputText = document.getElementById('txt');

  // Dessin widgets
  const gridEl = document.getElementById('grid');
  const brushEl = document.getElementById('brush');
  const eraserBtn = document.getElementById('eraser');
  const clearBtn  = document.getElementById('clear');
  const publishBtn = document.getElementById('publish');
  const paletteEl = document.getElementById('palette');

  // État app
  let currentChan = 'discussion';
  let last_id = 0;
  let seen = new Set();     // dédoublonnage des messages (ids)
  let es = null;            // SSE pour messages (par channel)
  let esDessin = null;      // SSE pour canvas 24×8

  // Modèle Dessin
  let G = { w:24, h:8, lines:Array(8).fill(' '.repeat(24)) };

  // Pointeurs & outils
  let painting = false;
  let activePointerId = null;
  let eraserOn = false;
  let keyBrush = null;      // si une touche est maintenue, override du pinceau

  // Utils
  function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
  function firstCodePoint(s){
    const arr = Array.from(String(s||'').trim());
    return arr.length ? arr[0] : '';
  }
  function isPrintableKey(e){
    // ignore control/meta keys; accepte une seule "char" visible
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key && e.key.length === 1) return true;
    return false;
  }
  function brushChar(){
    if (eraserOn) return ' ';
    if (keyBrush) return keyBrush;
    const ch = firstCodePoint(brushEl.value);
    return ch || '#';
  }
  function setEraser(on){
    eraserOn = !!on;
    eraserBtn.textContent = 'Gomme : ' + (eraserOn ? 'ON' : 'OFF');
    eraserBtn.classList.toggle('secondary', !eraserOn);
    eraserBtn.classList.toggle('on', eraserOn);
    if (eraserOn) { keyBrush = null; } // la gomme prime
  }

  // ----- UI: switch channel -----
  function setChan(chan){
    if (chan === currentChan) return;

    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.chan === chan));
    paneDiscussion.classList.toggle('on', chan === 'discussion');
    paneDessin.classList.toggle('on', chan === 'dessin');

    currentChan = chan;
    last_id = 0;
    seen = new Set();
    log.innerHTML = '';

    if (es) { try{ es.close(); }catch(_){ } es = null; }
    initialPoll().then(connectSSE);

    if (chan === 'dessin') connectDessinSSE();
    else if (esDessin) { try{ esDessin.close(); }catch(_){ } esDessin = null; }
  }
  tabBtns.forEach(b => b.addEventListener('click', () => setChan(b.dataset.chan)));

  // ----- Rendu message -----
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

    const atBottom = Math.abs(log.scrollHeight - (log.scrollTop + log.clientHeight)) < 60;
    log.appendChild(el);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  // ----- Poll + SSE pour le fil (channel) -----
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
    es.onerror = ()=>{ setTimeout(()=>{ try{es.close();}catch(_){ } connectSSE(); }, 1200); };
  }

  // ====================== DESSIN 24×8 ======================

  // Palette de caractères utiles
  const PALETTE = ["█","▓","▒","░","#","*",".","o","+","-","|","/","\\","_"];
  function renderPalette(){
    paletteEl.innerHTML = '';
    PALETTE.forEach(ch=>{
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.textContent = ch;
      b.addEventListener('click', ()=>{
        setEraser(false);
        brushEl.value = ch;
        updatePaletteActive();
      });
      paletteEl.appendChild(b);
    });
    updatePaletteActive();
  }
  function updatePaletteActive(){
    const cur = firstCodePoint(brushEl.value) || '#';
    [...paletteEl.children].forEach(c=>{
      c.classList.toggle('active', c.textContent === cur);
    });
  }

  function buildGrid(){
    gridEl.innerHTML = '';
    gridEl.style.gridTemplateColumns = `repeat(${G.w}, 1fr)`;
    for(let y=0;y<G.h;y++){
      for(let x=0;x<G.w;x++){
        const d = document.createElement('div');
        d.className = 'cell';
        d.dataset.x = x; d.dataset.y = y;
        d.textContent = G.lines[y][x];
        gridEl.appendChild(d);
      }
    }
  }

  function updateCell(x,y,ch){
    const idx = y*G.w + x;
    const d = gridEl.children[idx];
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

  // pointer events (souris + tactile + stylet)
  gridEl.addEventListener('pointerdown', (e)=>{
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

  gridEl.addEventListener('pointermove', (e)=>{
    if (!painting || e.pointerId !== activePointerId) return;
    e.preventDefault();
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
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
      try { gridEl.releasePointerCapture(activePointerId); } catch(_){}
    }
    painting = false;
    activePointerId = null;
  }
  gridEl.addEventListener('pointerup', endPaint);
  gridEl.addEventListener('pointercancel', endPaint);
  gridEl.addEventListener('pointerleave', endPaint);

  // clic droit = gomme sur une cellule
  gridEl.addEventListener('contextmenu', (e)=>{
    const t = e.target.closest('.cell'); if (!t) return;
    e.preventDefault();
    const x = +t.dataset.x, y = +t.dataset.y;
    const ch = ' ';
    if (G.lines[y][x] !== ch){
      updateCell(x,y,ch);
      sendDiff([{x,y,ch}]);
    }
  });

  // Gomme ON/OFF
  eraserBtn.addEventListener('click', ()=> setEraser(!eraserOn));

  // Effacer tout (batch)
  clearBtn.addEventListener('click', async ()=>{
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
    for (let i=0;i<gridEl.children.length;i++){
      gridEl.children[i].textContent = ' ';
    }
    await sendDiff(pixels);
  });

  // Publier le snapshot dans le fil
  publishBtn?.addEventListener('click', async ()=>{
    try{
      const r = await fetch('/dessin/publish', { method:'POST' });
      if (!r.ok && navigator.vibrate) navigator.vibrate(80);
    }catch(_){}
  });

  // Saisie du caractère : toujours 1 seul graphe (code point)
  brushEl.addEventListener('input', ()=>{
    if (eraserOn) return;  // si gomme active, on ne touche pas
    const first = firstCodePoint(brushEl.value) || '#';
    brushEl.value = first; // force à 1 caractère
    updatePaletteActive();
  });
  brushEl.addEventListener('focus', ()=> setEraser(false));
  brushEl.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter') e.preventDefault();
  });

  // Maintien d’une touche = pinceau temporaire
  document.addEventListener('keydown', (e)=>{
    if (!isPrintableKey(e)) return;
    keyBrush = firstCodePoint(e.key);
  });
  document.addEventListener('keyup', (e)=>{
    // on ne peut pas savoir si c'était la même touche, on lève l’override
    keyBrush = null;
  });

  // SSE dessin (full + diffs)
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

  // ----- Discussion: submit -----
  formDis.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    const text = (inputText.value || '').trim();
    if (!text) return;
    try{
      const fd = new FormData();
      fd.set('chan','discussion');
      fd.set('text', text);
      const r = await fetch('/msg', { method:'POST', body: fd });
      if (r.status === 429 && navigator.vibrate) navigator.vibrate(60);
      inputText.value = '';
    }catch(_){}
    inputText.focus();
  });

  // ----- Poll + SSE feed -----
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
    es.onmessage = (ev)=>{ try { addMsg(JSON.parse(ev.data)); } catch(_){} };
    es.onerror = ()=>{ setTimeout(()=>{ try{es.close();}catch(_){ } connectSSE(); }, 1200); };
  }

  // ====================== BOOT ======================
  renderPalette();
  initialPoll().then(connectSSE);
})();
