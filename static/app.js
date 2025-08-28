
(function(){
  const log = document.getElementById('log');
  const form = document.getElementById('f');
  const input = document.getElementById('txt');
  let last_id = 0, posting = false;

  function esc(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
  function addMsg(m){
    const el = document.createElement('div');
    el.className = 'msg';
    const dt = new Date(m.ts*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const hh = m.hash ? ('<span class="hash">['+esc(m.hash)+']</span>') : 'anon';
    el.innerHTML = '<div class="meta">'+dt+' · '+hh+'</div><div>'+esc(m.text)+'</div>';
    const atBottom = Math.abs(log.scrollHeight - (log.scrollTop + log.clientHeight)) < 60;
    log.appendChild(el);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  async function initialPoll(){
    try{
      const r = await fetch('/poll?last_id='+last_id, {cache:'no-store'});
      if (!r.ok) return;
      const arr = await r.json();
      for (const m of arr){ addMsg(m); last_id = Math.max(last_id, m.id); }
    }catch(_){}
  }

  function connectSSE(){
    const es = new EventSource('/stream');
    es.onmessage = (ev)=>{
      try { const m = JSON.parse(ev.data); addMsg(m); last_id = Math.max(last_id, m.id); }catch(_){}
    };
    es.onerror = ()=>{
      setTimeout(()=>{ try{ es.close(); }catch(_){ } connectSSE(); }, 1200);
    };
  }

  form.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    if (posting) return;
    const text = input.value.trim();
    if (!text) return;
    posting = true;
    try{
      const fd = new FormData();
      fd.set('text', text);
      const r = await fetch('/msg', { method:'POST', body: fd });
      if (r.status === 429 && navigator.vibrate) navigator.vibrate(60);
      input.value = '';
    }catch(_){}
    posting = false; input.focus();
  });

  input.addEventListener('keydown',(e)=>{
    if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); form.requestSubmit(); }
  });

  initialPoll().then(connectSSE);
})();
