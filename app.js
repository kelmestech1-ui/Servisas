/* Serviso programėlė (PWA): priėmėjas, mechanikas, vadovas. Veikia ir be interneto. */
(() => {
'use strict';

const CFG = window.APP_CONFIG || {};
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => (n < 10 ? '0' : '') + n;
const stamp = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
const today = () => stamp(new Date()).slice(0, 10);
const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignoruojame */ } };

/* ---------- IndexedDB ---------- */
let _db;
const db = () => _db || (_db = new Promise((res, rej) => {
  const r = indexedDB.open('servisas', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('kv');
    d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
const run = (store, mode, fn) => db().then(d => new Promise((res, rej) => {
  const t = d.transaction(store, mode);
  const req = fn(t.objectStore(store));
  t.oncomplete = () => res(req ? req.result : undefined);
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error);
}));
const kvGet = k => run('kv', 'readonly', s => s.get(k));
const kvSet = (k, v) => run('kv', 'readwrite', s => s.put(v, k));
const obAll = () => run('outbox', 'readonly', s => s.getAll());
const obAdd = op => run('outbox', 'readwrite', s => s.add(op));
const obPut = op => run('outbox', 'readwrite', s => s.put(op));
const obDel = id => run('outbox', 'readwrite', s => s.delete(id));

/* ---------- Būsena ---------- */
const S = { auth: null, data: null, view: 'login', cur: null, pending: [], syncing: false, err: '', q: '', filter: '', tmpmap: {}, tiv: null, finArmed: false };

/* ---------- Pagalbinės ---------- */
function sc(st) {
  const n = norm(st);
  if (n.indexOf('atiduot') >= 0) return 'h';
  if (n.indexOf('atliekam') >= 0) return 'w';
  if (n.indexOf('dali') >= 0) return 'p';
  if (n.indexOf('atlikt') >= 0) return 'd';
  return 'q';
}
const chip = st => '<span class="chip c-' + sc(st) + '">' + esc(st) + '</span>';

function say(t, cls) {
  const m = $('#msg');
  m.textContent = t || '';
  m.className = t ? (cls || 'info') : '';
}
let toastT;
function toast(t, cls) {
  const el = $('#toast');
  el.textContent = t;
  el.className = 'show' + (cls ? ' ' + cls : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.className = ''; }, 3200);
}

function netErr(m) { const e = new Error(m); e.net = true; return e; }

/* ---------- API ---------- */
async function post(body) {
  if (!CFG.API_URL) throw netErr('Nenurodytas API_URL (failas config.js).');
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 90000);
  let r;
  try {
    r = await fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'follow'
    });
  } catch (e) {
    throw netErr('Nėra ryšio su serveriu.');
  } finally {
    clearTimeout(to);
  }
  try {
    return await r.json();
  } catch (e) {
    throw netErr('Serveris grąžino netikėtą atsakymą. Patikrinkite „Apps Script“ diegimą (prieiga: Visi).');
  }
}

async function refreshData() {
  const j = await post({ pin: S.auth.pin, action: 'bootstrap' });
  if (!j.ok) {
    if (j.auth) { const e = new Error(j.error || 'Neteisingas PIN.'); e.auth = true; throw e; }
    throw new Error(j.error || 'Klaida');
  }
  j.ts = Date.now();
  S.data = j;
  await kvSet('data', j);
  return j;
}

/* ---------- Prisijungimas ---------- */
async function login(pin) {
  pin = String(pin || '').trim();
  if (!pin) return;
  say('Jungiamasi...');
  try {
    const j = await post({ pin, action: 'bootstrap' });
    if (!j.ok) { say(j.error || 'Klaida', 'err'); return; }
    j.ts = Date.now();
    S.auth = { pin, role: j.role };
    S.data = j;
    await kvSet('auth', S.auth);
    await kvSet('data', j);
    say('');
    go('list');
    loadPending().then(sync);
  } catch (e) {
    const cached = await kvGet('auth');
    const data = await kvGet('data');
    if (e.net && cached && cached.pin === pin && data) {
      S.auth = cached; S.data = data; say(''); go('list'); loadPending();
    } else {
      say(e.net ? 'Nėra ryšio. Pirmą kartą prisijungti reikia interneto. (' + e.message + ')' : e.message, 'err');
    }
  }
}

async function logout(msg) {
  S.auth = null; S.data = null;
  await kvSet('auth', null);
  await kvSet('data', null);
  go('login');
  if (msg) say(msg, 'err');
}

/* ---------- Navigacija ir piešimas ---------- */
function go(view, cur) {
  clearInterval(S.tiv); S.tiv = null; S.finArmed = false;
  S.view = view; S.cur = cur || null;
  say('');
  render();
  window.scrollTo(0, 0);
}

function paintHeader() {
  const online = navigator.onLine;
  const n = S.pending.filter(o => !o.failed).length;
  const f = S.pending.filter(o => o.failed).length;
  let dot = online ? '' : ' off';
  let txt = online ? 'Prisijungta' : 'Be interneto';
  if (S.err || f) { dot = ' err'; }
  let h = '<span class="dot' + dot + '"></span>' + txt;
  if (S.syncing) h += '<br>Siunčiama...';
  else if (n) h += '<br>Neišsiųsta: ' + n;
  else if (f) h += '<br>Klaidų: ' + f;
  $('#badge').innerHTML = S.auth ? h : '';
}

function paintNav() {
  const nav = $('#nav');
  if (!S.auth) { nav.className = 'hidden'; return; }
  nav.className = '';
  const n = S.pending.length;
  const b = (v, label, extra) => '<button data-act="nav" data-v="' + v + '" class="' + (S.view === v || (v === 'list' && S.view === 'detail') ? 'on' : '') + '">' + label + (extra || '') + '</button>';
  nav.innerHTML = b('list', 'Sąrašas') +
    (S.data && S.data.intake ? b('new', 'Nauja') : '') +
    b('queue', 'Siuntimas', n ? '<span class="n">' + n + '</span>' : '');
}

function render() {
  paintHeader();
  paintNav();
  if (!S.auth && S.view !== 'login') S.view = 'login';
  if (S.view === 'login') return renderLogin();
  if (S.view === 'list') return renderListView();
  if (S.view === 'detail') return renderDetail();
  if (S.view === 'new') return renderNew();
  if (S.view === 'queue') return renderQueue();
}

function refreshUi() {
  paintHeader();
  paintNav();
  if (S.view === 'list') { renderList(); }
  if (S.view === 'queue') renderQueue();
}

function renderLogin() {
  $('#app').innerHTML = '<div class="card"><label>PIN kodas</label>' +
    '<input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="Įveskite PIN">' +
    '<button data-act="login">Prisijungti</button></div>';
  const p = $('#pin');
  p.addEventListener('keydown', e => { if (e.key === 'Enter') login(p.value); });
}

/* ---------- Sąrašas ---------- */
function visible() {
  const role = S.auth.role;
  return S.data.items.filter(it => {
    const n = norm(it.statusas);
    if (n.indexOf('atiduot') >= 0) return false;
    if (role === 'mechanic' && n.indexOf('atlikt') >= 0) return false;
    return true;
  });
}

function renderListView() {
  const chips = [['', 'Visi'], ['q', 'Eilėje'], ['w', 'Atliekama'], ['p', 'Dalių'], ['d', 'Atlikta']];
  $('#app').innerHTML =
    '<div class="searchwrap"><input id="q" type="search" placeholder="Ieškoti: Nr., klientas, įrenginys, serija..." value="' + esc(S.q) + '"></div>' +
    '<div class="chips">' + chips.map(c => '<button class="fchip' + (S.filter === c[0] ? ' on' : '') + '" data-act="filter" data-f="' + c[0] + '">' + c[1] + '</button>').join('') + '</div>' +
    '<div id="count"></div><div id="list"></div>' +
    '<button class="sec" data-act="sync">Atnaujinti sąrašą</button>';
  renderList();
}

function renderList() {
  const box = $('#list');
  if (!box || !S.data) return;
  const words = norm(S.q).split(' ').filter(Boolean);
  const items = visible();
  let out = '', n = 0;
  items.forEach(it => {
    const c = sc(it.statusas);
    if (S.filter && S.filter !== c) return;
    const hay = norm([it.nr, it.klientas, it.irenginys, it.serija, it.telefonas, it.statusas, it.aprasymas].join(' '));
    for (const w of words) { if (hay.indexOf(w) < 0) return; }
    n++;
    out += '<div class="card tap s-' + c + (it.tmp ? ' tmp' : '') + '" data-act="open" data-k="' + esc(it.tmpId || it.nr) + '">' +
      '<div class="top"><div class="nr">' + esc(it.tmp ? '⏳ Nauja' : it.nr) + ' · ' + esc(it.klientas) + '</div>' +
      '<div class="chipset">' + runChip(it) + chip(it.statusas) + '</div></div>' +
      '<div class="dev">' + esc(it.irenginys) + '</div>' +
      (it.serija ? '<div class="muted">' + esc(it.serija) + '</div>' : '') + '</div>';
  });
  const ts = S.data.ts ? ' · atnaujinta ' + pad(new Date(S.data.ts).getHours()) + ':' + pad(new Date(S.data.ts).getMinutes()) : '';
  $('#count').textContent = 'Rasta: ' + n + ' iš ' + items.length + ts;
  box.innerHTML = out || '<p class="muted">Nieko nerasta.</p>';
}

/* ---------- Detalė ---------- */
const findItem = k => S.data.items.find(it => it.nr === k || it.tmpId === k);
const opNr = it => (it.tmp ? it.tmpId : it.nr);

function optList(list, sel, emptyLabel) {
  let o = emptyLabel != null ? '<option value="">' + esc(emptyLabel) + '</option>' : '';
  (list || []).forEach(v => { o += '<option' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>'; });
  return o;
}

function renderDetail() {
  const it = findItem(S.cur);
  if (!it) return go('list');
  const role = S.auth.role;
  const names = (S.data.lists.mechs && S.data.lists.mechs.length) ? S.data.lists.mechs : S.data.lists.workers;
  $('#app').innerHTML =
    '<div class="card s-' + sc(it.statusas) + '">' +
      '<div class="top"><div class="nr">' + esc(it.tmp ? '⏳ Nauja (laukia sinchronizacijos)' : it.nr) + ' · ' + esc(it.klientas) + '</div>' + chip(it.statusas) + '</div>' +
      '<div class="dev">' + esc(it.irenginys) + '</div>' +
      (it.serija ? '<div class="muted">Serija / IMEI: ' + esc(it.serija) + '</div>' : '') +
      (it.telefonas ? '<div class="muted">Tel.: <a href="tel:' + esc(it.telefonas.replace(/[^\d+]/g, '')) + '">' + esc(it.telefonas) + '</a></div>' : '') +
      (it.data ? '<div class="muted">Priimta: ' + esc(it.data) + (it.garantinis ? ' · ' + (it.garantinis === 'Taip' ? 'Garantinis' : 'Negarantinis') : '') + '</div>' : '') +
      (it.aprasymas ? '<div class="pre"><b>Gedimas:</b> ' + esc(it.aprasymas) + '</div>' : '') +
      (it.komentarai ? '<div class="pre"><b>Komentarai:</b>\n' + esc(it.komentarai) + '</div>' : '') +
    '</div>' +
    '<label>Kas rašo</label><select id="mech">' + optList(names, lsGet('mech')) + '</select>' +
    (S.data.timer && !it.tmp ? timerBox() : '') +
    '<label>Komentaras</label><textarea id="c" placeholder="Ką atlikta / kas rasta..."></textarea>' +
    '<label>Naujas statusas</label><select id="st">' + optList(S.data.statuses, '', 'Nekeisti') + '</select>' +
    '<label>Nuotraukos (nebūtina)</label><input id="ph" type="file" accept="image/*" multiple>' +
    '<div id="phi" class="muted"></div>' +
    '<button data-act="save">Išsaugoti</button>' +
    '<button class="sec" data-act="nav" data-v="list">Atgal į sąrašą</button>';

  if (S.data.timer && !it.tmp) {
    tPaint(it.timer);
    if (navigator.onLine) {
      const nr = it.nr;
      post({ pin: S.auth.pin, action: 'timerState', nr })
        .then(j => { if (j.ok && S.view === 'detail' && S.cur === nr) { it.timer = j.timer; tPaint(j.timer); } })
        .catch(() => {});
    }
  }
}

/* ---------- Darbo laikmatis ---------- */
const runChip = it => (it.timer && it.timer.running)
  ? '<span class="chip c-run">⏱ ' + esc(it.timer.running.mech) + '</span>' : '';

function timerBox() {
  const reasons = (S.data.pauseReasons || []);
  return '<div id="tbox" class="card timer">' +
    '<div class="top"><div class="nr">Darbo laikas</div><span id="tst" class="chip c-off">Nepradėta</span></div>' +
    '<div id="tclk" class="clock">0:00:00</div>' +
    '<div id="tinf" class="muted"></div>' +
    '<button id="tgo" data-act="tstart">▶ Pradėti darbą</button>' +
    '<div id="trun" class="row2 hidden">' +
      '<button class="pause" data-act="tpause">⏸ Sustabdyti</button>' +
      '<button id="tfin" class="finish" data-act="tfinish">✔ Baigti darbą</button>' +
    '</div>' +
    '<div id="tpz" class="hidden">' +
      '<label>Kodėl stabdote? <span class="req">*</span></label>' +
      '<select id="trs">' + optList(reasons, '', '— pasirinkite —') + '</select>' +
      '<input id="tot" class="hidden" placeholder="Įrašykite priežastį" style="margin-top:8px">' +
      '<button class="pause" data-act="tpauseok">Patvirtinti sustabdymą</button>' +
      '<button class="sec" data-act="tpausecancel">Atšaukti</button>' +
    '</div>' +
  '</div>';
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 3600) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
}
function fmtMin(min) { return Math.floor(min / 60) + ' val. ' + Math.round(min % 60) + ' min.'; }

function tPaint(st) {
  if (!$('#tbox')) return;
  st = st || { totalMin: 0, running: null, lastReason: '' };
  clearInterval(S.tiv); S.tiv = null;
  S.finArmed = false;
  const run = !!st.running;
  $('#tfin').textContent = '✔ Baigti darbą';
  $('#tpz').classList.add('hidden');
  $('#tgo').classList.toggle('hidden', run);
  $('#tgo').textContent = st.totalMin ? '▶ Tęsti darbą' : '▶ Pradėti darbą';
  $('#trun').classList.toggle('hidden', !run);
  const tst = $('#tst');
  tst.className = 'chip ' + (run ? 'c-run' : 'c-off');
  tst.textContent = run ? 'Dirbama · ' + st.running.mech : (st.totalMin ? 'Sustabdyta' : 'Nepradėta');
  $('#tinf').textContent = (!run && st.lastReason) ? 'Paskutinė pauzė: ' + st.lastReason : '';
  const base = (st.totalMin || 0) * 60000;
  const tick = () => { const c = $('#tclk'); if (c) c.textContent = fmtDur(base + (run ? Date.now() - st.running.start : 0)); };
  tick();
  if (run) S.tiv = setInterval(tick, 1000);
}

function tBusy(b) { $$('#tbox button').forEach(x => { x.disabled = b; }); }

/** Laikmačio užklausa – reikia interneto (laikas fiksuojamas serveryje). */
async function tCall(body) {
  if (!navigator.onLine) throw new Error('Laikmačiui reikia interneto ryšio.');
  const j = await post(Object.assign({ pin: S.auth.pin, opId: uid() }, body));
  if (!j.ok) {
    if (j.auth) { await logout('PIN nebegalioja. Prisijunkite iš naujo.'); throw new Error(j.error || 'Neteisingas PIN.'); }
    throw new Error(j.error || 'Klaida');
  }
  return j;
}

function setStatus(it, idx) {
  const all = S.data.allStatuses || [];
  if (all[idx]) it.statusas = all[idx];
}

/**
 * Greitas atsakas: ekranas atnaujinamas iš karto, o užklausa siunčiama fone.
 * Užklausos siunčiamos eilės tvarka; nepavykus – grąžinama ankstesnė būsena.
 */
function tSend(it, body, prevTimer, prevStatus, okMsg) {
  const nr = it.nr;
  S.tq = (S.tq || Promise.resolve()).then(async () => {
    try {
      const j = await tCall(body);
      it.timer = j.timer;
      await kvSet('data', S.data);
      if (S.view === 'detail' && S.cur === nr) tPaint(j.timer);
      if (S.view === 'list') renderList();
      if (okMsg) toast(okMsg);
    } catch (e) {
      it.timer = prevTimer;
      it.statusas = prevStatus;
      await kvSet('data', S.data);
      if (S.view === 'detail' && S.cur === nr) renderDetail();
      if (S.view === 'list') renderList();
      toast('Neišsaugota: ' + (e.message || String(e)), 'err');
    }
  });
  return S.tq;
}

function tStart() {
  const it = findItem(S.cur);
  if (!it) return;
  if (!navigator.onLine) { toast('Laikmačiui reikia interneto ryšio.', 'err'); return; }
  const mech = $('#mech').value;
  if (!mech) { toast('Pasirinkite, kas dirba.', 'err'); return; }
  lsSet('mech', mech);
  const prevTimer = it.timer, prevStatus = it.statusas;
  const total = (prevTimer && prevTimer.totalMin) || 0;
  it.timer = { nr: it.nr, running: { mech, start: Date.now() }, totalMin: total, lastReason: '' };
  setStatus(it, 1); // Darbas atliekamas
  renderDetail();
  toast('Darbas pradėtas: ' + it.nr);
  tSend(it, { action: 'timerStart', nr: it.nr, mech }, prevTimer, prevStatus, '');
}

function tPauseAsk() {
  $('#trs').value = '';
  $('#tot').value = '';
  $('#tot').classList.add('hidden');
  $('#trun').classList.add('hidden');
  $('#tpz').classList.remove('hidden');
}

function tPauseCancel() {
  $('#tpz').classList.add('hidden');
  $('#trun').classList.remove('hidden');
}

/** Vietinis laiko priskaičiavimas, kol atsakys serveris. */
function localStop(t, reason) {
  const run = t && t.running;
  const add = run ? Math.max(0, Math.round((Date.now() - run.start) / 60000)) : 0;
  return { nr: t ? t.nr : '', running: null, totalMin: ((t && t.totalMin) || 0) + add, lastReason: reason || '' };
}

function tPause() {
  const it = findItem(S.cur);
  if (!it) return;
  let r = $('#trs').value;
  if (!r) { toast('Pasirinkite sustabdymo priežastį.', 'err'); return; }
  if (/^kita/i.test(r)) {
    const o = $('#tot').value.trim();
    if (!o) { toast('Įrašykite, kodėl stabdote.', 'err'); return; }
    r = 'Kita: ' + o;
  }
  if (!navigator.onLine) { toast('Laikmačiui reikia interneto ryšio.', 'err'); return; }
  const prevTimer = it.timer, prevStatus = it.statusas;
  it.timer = localStop(prevTimer, r);
  if (/^laukia dali/i.test(r)) setStatus(it, 2); // Laukia dalių
  renderDetail();
  toast('Sustabdyta: ' + r);
  tSend(it, { action: 'timerStop', nr: it.nr, finish: false, reason: r }, prevTimer, prevStatus, '');
}

function tFinish() {
  const it = findItem(S.cur);
  if (!it) return;
  if (!S.finArmed) {
    S.finArmed = true;
    $('#tfin').textContent = 'Spauskite dar kartą';
    setTimeout(() => { S.finArmed = false; const b = $('#tfin'); if (b) b.textContent = '✔ Baigti darbą'; }, 4000);
    return;
  }
  if (!navigator.onLine) { toast('Laikmačiui reikia interneto ryšio.', 'err'); return; }
  const prevTimer = it.timer, prevStatus = it.statusas;
  it.timer = localStop(prevTimer, '');
  setStatus(it, 3); // Darbas atliktas
  toast('Darbas baigtas: ' + it.nr + ' (' + fmtMin(it.timer.totalMin) + ')');
  go('list');
  tSend(it, { action: 'timerStop', nr: it.nr, finish: true }, prevTimer, prevStatus, '')
    .then(() => refreshData()).then(() => refreshUi()).catch(() => {});
}

function shrink(file) {
  return new Promise((ok, bad) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); bad(new Error('Nepavyko apdoroti nuotraukos.')); };
    img.src = url;
  });
}

async function saveDetail(btn) {
  const it = findItem(S.cur);
  if (!it) return;
  const comment = $('#c').value.trim();
  const status = $('#st').value;
  const mech = $('#mech').value;
  const files = Array.from($('#ph').files || []);
  if (!comment && !status && !files.length) { toast('Įrašykite komentarą, pasirinkite statusą arba nuotrauką.', 'err'); return; }
  if (files.length > 10) { toast('Vienu metu galima pridėti iki 10 nuotraukų.', 'err'); return; }

  btn.disabled = true;
  try {
    const nr = opNr(it);
    const now = Date.now();
    if (mech) lsSet('mech', mech);

    const photos = [];
    for (let i = 0; i < files.length; i++) {
      btn.textContent = 'Apdorojama nuotrauka ' + (i + 1) + ' iš ' + files.length + '...';
      photos.push(await shrink(files[i]));
    }

    let text = comment;
    if (files.length) text += (text ? ' ' : '') + '[nuotraukų: ' + files.length + ']';
    if (text || status) {
      await obAdd({ type: 'comment', opId: uid(), nr, mech, comment: text, status, ts: now });
      if (text) {
        const line = stamp(new Date(now)) + (mech ? ' ' + mech : '') + ': ' + text;
        it.komentarai = (it.komentarai ? it.komentarai + '\n' : '') + line;
      }
      if (status) it.statusas = status;
    }
    for (const b64 of photos) {
      await obAdd({ type: 'photo', opId: uid(), nr, mech, kind: S.auth.role === 'mechanic' ? 'mech' : 'intake', b64, ts: now });
    }
    await kvSet('data', S.data);
    toast(navigator.onLine ? 'Išsaugota, siunčiama...' : 'Išsaugota telefone. Bus išsiųsta atsiradus internetui.');
    await loadPending();
    go('list');
    sync();
  } catch (e) {
    toast(e.message || String(e), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Išsaugoti';
  }
}

/* ---------- Naujas priėmimas ---------- */
function renderNew() {
  const L = S.data.lists;
  const req = ' <span class="req">*</span>';
  const inp = (title, type, r, ph) => '<label>' + esc(title) + (r ? req : '') + '</label><input data-f="' + esc(title) + '" type="' + (type || 'text') + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + ' autocomplete="off">';
  const sel = (title, list, r, emptyLabel) => '<label>' + esc(title) + (r ? req : '') + '</label><select data-f="' + esc(title) + '">' + optList(list, '', emptyLabel || 'Pasirinkite...') + '</select>';
  const prev = lsGet('mech');
  $('#app').innerHTML =
    '<div class="card"><div class="nr">Naujas priėmimas</div><div class="muted">Veikia ir be interneto – numeris suteikiamas išsiuntus.</div></div>' +
    '<label>Priėmė' + req + '</label><select data-f="Priėmė">' + optList(L.workers, prev, 'Pasirinkite...') + '</select>' +
    inp('Klientas', 'text', true) +
    inp('Telefonas', 'tel', true) +
    inp('El. paštas', 'email', false) +
    inp('Kliento adresas', 'text', false) +
    sel('Įrenginio tipas', L.types, true) +
    sel('Gamintojas', L.makers, true) +
    inp('Modelis', 'text', false) +
    inp('Serijos Nr. / IMEI', 'text', false) +
    sel('Komplektacija', L.kits, false, '— nėra —') +
    inp('Išvaizda / būklė', 'text', false) +
    sel('Gedimo tipas', L.faults, true) +
    '<label>Gedimo aprašymas (kliento žodžiais)' + req + '</label><textarea data-f="Gedimo aprašymas (kliento žodžiais)"></textarea>' +
    '<label>Garantinis?' + req + '</label><div class="radios"><label><input type="radio" name="w" value="Taip">Taip</label><label><input type="radio" name="w" value="Ne">Ne</label></div>' +
    '<label>Nuotraukos (nebūtina)</label><input id="ph" type="file" accept="image/*" multiple><div id="phi" class="muted"></div>' +
    '<button data-act="submitnew">Išsaugoti priėmimą</button>';
}

async function submitNew(btn) {
  const fields = {};
  $$('[data-f]').forEach(el => { fields[el.getAttribute('data-f')] = (el.value || '').trim(); });
  const w = $('input[name="w"]:checked');
  fields['Garantinis?'] = w ? w.value : '';
  const need = ['Priėmė', 'Klientas', 'Telefonas', 'Įrenginio tipas', 'Gamintojas', 'Gedimo tipas', 'Gedimo aprašymas (kliento žodžiais)', 'Garantinis?'];
  const miss = need.filter(k => !fields[k]);
  if (miss.length) { toast('Užpildykite: ' + miss.join(', '), 'err'); return; }
  const files = Array.from($('#ph').files || []);
  if (files.length > 10) { toast('Vienu metu galima pridėti iki 10 nuotraukų.', 'err'); return; }

  btn.disabled = true;
  try {
    const photos = [];
    for (let i = 0; i < files.length; i++) {
      btn.textContent = 'Apdorojama nuotrauka ' + (i + 1) + ' iš ' + files.length + '...';
      photos.push(await shrink(files[i]));
    }
    lsSet('mech', fields['Priėmė']);
    const ts = Date.now();
    const tmpId = 'tmp:' + uid();
    await obAdd({ type: 'intake', opId: uid(), tmpId, fields, ts });
    for (const b64 of photos) {
      await obAdd({ type: 'photo', opId: uid(), nr: tmpId, mech: fields['Priėmė'], kind: 'intake', b64, ts });
    }
    S.data.items.unshift({
      nr: 'Nauja', tmp: true, tmpId,
      klientas: fields['Klientas'], telefonas: fields['Telefonas'],
      irenginys: [fields['Įrenginio tipas'], fields['Gamintojas'], fields['Modelis']].filter(Boolean).join(' '),
      serija: fields['Serijos Nr. / IMEI'] || '',
      statusas: (S.data.allStatuses && S.data.allStatuses[0]) || 'Laukia eilėje',
      aprasymas: fields['Gedimo aprašymas (kliento žodžiais)'],
      komentarai: '', data: today(), garantinis: fields['Garantinis?']
    });
    await kvSet('data', S.data);
    toast(navigator.onLine ? 'Priėmimas išsaugotas, siunčiama...' : 'Priėmimas išsaugotas telefone. Bus išsiųstas atsiradus internetui.');
    await loadPending();
    go('list');
    sync();
  } catch (e) {
    toast(e.message || String(e), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Išsaugoti priėmimą';
  }
}

/* ---------- Siuntimo eilė ---------- */
function opLabel(o) {
  if (o.type === 'intake') return 'Naujas priėmimas: ' + esc((o.fields && o.fields['Klientas']) || '');
  if (o.type === 'photo') return 'Nuotrauka (' + esc(String(o.nr).indexOf('tmp:') === 0 ? 'naujam priėmimui' : o.nr) + ')';
  return 'Komentaras / statusas (' + esc(String(o.nr).indexOf('tmp:') === 0 ? 'naujam priėmimui' : o.nr) + ')';
}

function renderQueue() {
  const ops = S.pending;
  let h = '<div class="card"><div class="nr">Siuntimo eilė</div>' +
    '<div class="muted">' + (ops.length ? 'Laukia išsiuntimo: ' + ops.length : 'Viskas išsiųsta.') + '</div>' +
    (S.err ? '<div class="err-t">' + esc(S.err) + '</div>' : '') +
    '<button data-act="sync">Sinchronizuoti dabar</button></div>';
  ops.forEach(o => {
    h += '<div class="card op' + (o.failed ? ' failed' : '') + '"><div class="nr">' + opLabel(o) + '</div>' +
      '<div class="muted">' + esc(stamp(new Date(o.ts || Date.now()))) + '</div>' +
      (o.failed ? '<div class="err-t">' + esc(o.error || 'Klaida') + '</div>' : '') +
      (o.failed ? '<button class="small" data-act="retry" data-id="' + o.id + '">Bandyti dar kartą</button>' : '') +
      '<button class="small danger" data-act="rm" data-id="' + o.id + '">Pašalinti</button></div>';
  });
  h += '<button class="sec" data-act="logout">Atsijungti</button>';
  $('#app').innerHTML = h;
}

/* ---------- Sinchronizacija ---------- */
async function loadPending() {
  S.pending = await obAll();
  paintHeader();
  paintNav();
}

async function sendOp(op) {
  let nr = op.nr;
  if (nr && String(nr).indexOf('tmp:') === 0) {
    nr = S.tmpmap[nr];
    if (!nr) return { ok: false, error: 'Susijęs naujas priėmimas dar neišsiųstas arba nepavyko.' };
  }
  return post({
    pin: S.auth.pin, action: op.type, opId: op.opId,
    nr, mech: op.mech, comment: op.comment, status: op.status,
    kind: op.kind, b64: op.b64, fields: op.fields, ts: op.ts
  });
}

async function onDone(op, j, ops) {
  if (op.type !== 'intake') return;
  S.tmpmap[op.tmpId] = j.nr;
  await kvSet('tmpmap', S.tmpmap);
  const it = S.data && S.data.items.find(x => x.tmpId === op.tmpId);
  if (it) { it.nr = j.nr; it.tmp = false; await kvSet('data', S.data); }
  for (const o of ops) {
    if (o.nr === op.tmpId) { o.nr = j.nr; await obPut(o); }
  }
}

async function sync() {
  if (S.syncing || !S.auth) return;
  if (!navigator.onLine) { paintHeader(); return; }
  S.syncing = true;
  paintHeader();
  try {
    const ops = await obAll();
    for (const op of ops) {
      if (op.failed) continue;
      const j = await sendOp(op);
      if (j.ok) {
        await onDone(op, j, ops);
        await obDel(op.id);
      } else if (j.auth) {
        const e = new Error(j.error || 'Neteisingas PIN.'); e.auth = true; throw e;
      } else {
        op.failed = true;
        op.error = j.error || 'Klaida';
        await obPut(op);
      }
      await loadPending();
      refreshUi();
    }
    const left = (await obAll()).filter(o => !o.failed);
    if (!left.length) await refreshData();
    S.err = '';
  } catch (e) {
    if (e.auth) { S.syncing = false; await logout('PIN nebegalioja. Prisijunkite iš naujo.'); return; }
    S.err = e.message || String(e);
  }
  S.syncing = false;
  await loadPending();
  refreshUi();
}

/* ---------- Įvykiai ---------- */
document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.getAttribute('data-act');
  if (act === 'login') return login($('#pin').value);
  if (act === 'nav') return go(el.getAttribute('data-v'));
  if (act === 'open') return go('detail', el.getAttribute('data-k'));
  if (act === 'filter') { S.filter = el.getAttribute('data-f'); $$('.fchip').forEach(c => c.classList.toggle('on', c.getAttribute('data-f') === S.filter)); return renderList(); }
  if (act === 'save') return saveDetail(el);
  if (act === 'submitnew') return submitNew(el);
  if (act === 'tstart') return tStart();
  if (act === 'tpause') return tPauseAsk();
  if (act === 'tpauseok') return tPause();
  if (act === 'tpausecancel') return tPauseCancel();
  if (act === 'tfinish') return tFinish();
  if (act === 'sync') { S.err = ''; await sync(); if (!S.err) toast('Sinchronizuota.'); else toast(S.err, 'err'); return; }
  if (act === 'rm') {
    if (!confirm('Pašalinti šį neišsiųstą įrašą? Jo duomenys bus prarasti.')) return;
    await obDel(Number(el.getAttribute('data-id')));
    await loadPending(); return refreshUi();
  }
  if (act === 'retry') {
    const ops = await obAll();
    const o = ops.find(x => x.id === Number(el.getAttribute('data-id')));
    if (o) { delete o.failed; delete o.error; await obPut(o); }
    await loadPending(); refreshUi(); return sync();
  }
  if (act === 'logout') {
    if (S.pending.length && !confirm('Yra neišsiųstų įrašų. Atsijungus jie liks telefone ir bus išsiųsti prisijungus. Atsijungti?')) return;
    return logout();
  }
});

document.addEventListener('input', ev => {
  if (ev.target.id === 'q') { S.q = ev.target.value; renderList(); }
});
document.addEventListener('change', ev => {
  if (ev.target.id === 'trs') {
    $('#tot').classList.toggle('hidden', !/^kita/i.test(ev.target.value));
    return;
  }
  if (ev.target.id === 'ph') {
    const n = ev.target.files ? ev.target.files.length : 0;
    $('#phi').textContent = n ? 'Pasirinkta nuotraukų: ' + n : '';
  }
});

window.addEventListener('online', () => { paintHeader(); sync(); });
window.addEventListener('offline', () => paintHeader());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });

/* ---------- Paleidimas ---------- */
async function init() {
  if (CFG.COLOR) {
    document.documentElement.style.setProperty('--hdr', CFG.COLOR);
    document.documentElement.style.setProperty('--acc', CFG.COLOR);
  }
  if (CFG.TITLE) { $('#title').textContent = CFG.TITLE; document.title = CFG.TITLE; }
  if (CFG.LOGO) { const l = $('#logo'); l.src = CFG.LOGO; l.classList.remove('hidden'); }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  try {
    S.tmpmap = (await kvGet('tmpmap')) || {};
    const a = await kvGet('auth');
    const d = await kvGet('data');
    await loadPending();
    if (a && d) { S.auth = a; S.data = d; go('list'); sync(); } else go('login');
  } catch (e) {
    go('login');
    say('Nepavyko atidaryti vietinės saugyklos: ' + (e.message || e), 'err');
  }
  setInterval(sync, 30000);
}

init();
})();
