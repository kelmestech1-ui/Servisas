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
const homeView = role => (role === 'manager' ? 'dash' : role === 'warranty' ? 'wlist' : role === 'driver' ? 'new' : 'list');
const S = { auth: null, data: null, view: 'login', cur: null, pending: [], syncing: false, err: '', q: '', filter: '', tmpmap: {} };

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
    go(homeView(j.role));
    if (j.role === 'manager') loadDash(true);
    loadPending().then(sync);
  } catch (e) {
    const cached = await kvGet('auth');
    const data = await kvGet('data');
    if (e.net && cached && cached.pin === pin && data) {
      S.auth = cached; S.data = data; say(''); go(homeView(cached.role)); loadPending();
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
  if (S.auth.role === 'warranty') {
    nav.innerHTML = '<button data-act="nav" data-v="wlist" class="' + (S.view === 'wlist' || S.view === 'detail' || S.view === 'wnew' ? 'on' : '') + '">Garantija</button>' +
      b('queue', 'Siuntimas', n ? '<span class="n">' + n + '</span>' : '');
    return;
  }
  if (S.auth.role === 'driver') {
    nav.innerHTML = b('new', 'Paimti') + b('list', 'Mano paėmimai') + b('queue', 'Siuntimas', n ? '<span class="n">' + n + '</span>' : '');
    return;
  }
  nav.innerHTML = (S.auth.role === 'manager' ? b('dash', 'Suvestinė') : '') +
    b('list', 'Sąrašas') +
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
  if (S.view === 'dash') return renderDash();
  if (S.view === 'wlist') return renderWList();
  if (S.view === 'wnew') return renderWNew();
}

function refreshUi() {
  paintHeader();
  paintNav();
  if (S.view === 'list') { renderList(); }
  if (S.view === 'wlist') renderWList();
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
const scope = () => lsGet('scope') || 'mine';

function visible() {
  const role = S.auth.role;
  return S.data.items.filter(it => {
    const n = norm(it.statusas);
    if (n.indexOf('atiduot') >= 0) return false;
    if (role === 'mechanic' && n.indexOf('atlikt') >= 0) return false;
    if (role === 'mechanic' && S.data.me && scope() === 'mine' && it.meistras && it.meistras !== S.data.me) return false;
    return true;
  });
}

function renderListView() {
  const chips = [['', 'Visi'], ['q', 'Eilėje'], ['w', 'Atliekama'], ['p', 'Dalių'], ['d', 'Atlikta']];
  $('#app').innerHTML =
    '<div class="searchwrap"><input id="q" type="search" placeholder="Ieškoti: Nr., klientas, įrenginys, serija..." value="' + esc(S.q) + '"></div>' +
    (S.auth.role === 'mechanic' && S.data.me ? '<div class="chips scope">' +
      '<button class="fchip' + (scope() === 'mine' ? ' on' : '') + '" data-act="scope" data-s="mine">Mano ir nepriskirti</button>' +
      '<button class="fchip' + (scope() === 'all' ? ' on' : '') + '" data-act="scope" data-s="all">Visų meistrų</button></div>' : '') +
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
      chip(it.statusas) + '</div>' +
      '<div class="dev">' + esc(it.irenginys) + '</div>' +
      (it.serija ? '<div class="muted">' + esc(it.serija) + '</div>' : '') +
      '<div class="muted">' + (it.meistras ? 'Meistras: ' + esc(it.meistras) : 'Nepriskirta') + '</div></div>';
  });
  const ts = S.data.ts ? ' · atnaujinta ' + pad(new Date(S.data.ts).getHours()) + ':' + pad(new Date(S.data.ts).getMinutes()) : '';
  $('#count').textContent = 'Rasta: ' + n + ' iš ' + items.length + ts;
  box.innerHTML = out || '<p class="muted">Nieko nerasta.</p>';
}

/* ---------- Detalė ---------- */
const money = v => (v === '' || v == null ? '' : String(v).replace('.', ','));
const moneyNum = v => { const t = String(v || '').replace(/[€\s]/g, '').replace(',', '.'); return t === '' ? null : Number(t); };
const findItem = k => S.data.items.find(it => it.nr === k || it.tmpId === k);
const opNr = it => (it.tmp ? it.tmpId : it.nr);

function optList(list, sel, emptyLabel) {
  let o = emptyLabel != null ? '<option value="">' + esc(emptyLabel) + '</option>' : '';
  (list || []).forEach(v => { o += '<option' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>'; });
  return o;
}

function renderDetail() {
  const it = findItem(S.cur);
  if (!it) return go(homeView(S.auth.role));
  if (S.auth.role === 'warranty') return renderWDetail(it);
  if (S.auth.role === 'driver') {
    $('#app').innerHTML = '<div class="card s-' + sc(it.statusas) + '">' +
      '<div class="top"><div class="nr">' + esc(it.tmp ? '⏳ Nauja (laukia išsiuntimo)' : it.nr) + ' · ' + esc(it.klientas) + '</div>' + chip(it.statusas) + '</div>' +
      '<div class="dev">' + esc(it.irenginys) + '</div>' +
      (it.serija ? '<div class="muted">Serija: ' + esc(it.serija) + '</div>' : '') +
      (it.telefonas ? '<div class="muted">Tel.: ' + esc(it.telefonas) + '</div>' : '') +
      '<div class="muted">Paimta ' + esc(it.data || '') + (it.meistras ? ' · meistras ' + esc(it.meistras) : '') + '</div>' +
      (it.aprasymas ? '<div class="pre"><b>Gedimas:</b> ' + esc(it.aprasymas) + '</div>' : '') +
      '</div><button class="sec" data-act="nav" data-v="list">Atgal</button>';
    return;
  }
  const role = S.auth.role;
  const names = (S.data.lists.mechs && S.data.lists.mechs.length) ? S.data.lists.mechs : S.data.lists.workers;
  $('#app').innerHTML =
    '<div class="card s-' + sc(it.statusas) + '">' +
      '<div class="top"><div class="nr">' + esc(it.tmp ? '⏳ Nauja (laukia sinchronizacijos)' : it.nr) + ' · ' + esc(it.klientas) + '</div>' + chip(it.statusas) + '</div>' +
      '<div class="dev">' + esc(it.irenginys) + '</div>' +
      (it.serija ? '<div class="muted">Serija / IMEI: ' + esc(it.serija) + '</div>' : '') +
      (it.telefonas ? '<div class="muted">Tel.: <a href="tel:' + esc(it.telefonas.replace(/[^\d+]/g, '')) + '">' + esc(it.telefonas) + '</a></div>' : '') +
      (it.data ? '<div class="muted">Priimta: ' + esc(it.data) + (it.garantinis ? ' · Garantija galioja: ' + esc(it.garantinis) : '') + '</div>' : '') +
      '<div class="muted">' + (it.meistras ? 'Meistras: ' + esc(it.meistras) : 'Meistras nepriskirtas') + '</div>' +
      (it.aprasymas ? '<div class="pre"><b>Gedimas:</b> ' + esc(it.aprasymas) + '</div>' : '') +
      (it.komentarai ? '<div class="pre"><b>Komentarai:</b>\n' + esc(it.komentarai) + '</div>' : '') +
    '</div>' +
    (S.data.me
      ? '<div class="muted">Rašo: <b>' + esc(S.data.me) + '</b></div><input id="mech" type="hidden" value="' + esc(S.data.me) + '">'
      : '<label>Kas rašo</label><select id="mech">' + optList(names, lsGet('mech')) + '</select>') +
    '<div class="row2">' +
      '<div><label>Darbai, €</label><input id="pr" type="text" inputmode="decimal" autocomplete="off" placeholder="35" value="' + esc(money(it.kaina)) + '"></div>' +
      (role !== 'mechanic' ? '<div><label>Dalys, €</label><input id="dp" type="text" inputmode="decimal" autocomplete="off" placeholder="20" value="' + esc(money(it.dalys)) + '"></div>' : '') +
      '<div><label>Transportas, €</label><input id="tr" type="text" inputmode="decimal" autocomplete="off" placeholder="15" value="' + esc(money(it.transportas)) + '"></div>' +
    '</div>' +
    '<div class="muted">Kainos nurodomos su PVM.</div>' +
    '<label>Suremontuota garantiškai</label><select id="rw">' + optList(['Taip', 'Ne'], it.remontoGarantija || '', 'Nenurodyta') + '</select>' +
    '<label>Komentaras</label><textarea id="c" placeholder="Ką atlikta / kas rasta..."></textarea>' +
    '<label>Naujas statusas</label><select id="st">' + optList(S.data.statuses, '', 'Nekeisti') + '</select>' +
    '<div id="opbox"' + (/dali/i.test(it.statusas) || it.uzsakytos ? '' : ' class="hidden"') + '>' +
      '<label>Užsakytos dalys (pavadinimas, kodas)</label>' +
      '<textarea id="op" class="short" placeholder="Pvz.: Karbiuratorius 545081857; tarpinė 503 45 02-01">' + esc(it.uzsakytos || '') + '</textarea>' +
      (it.daliuData ? '<div class="muted">Užsakyta ' + esc(it.daliuData) + (daysSince(it.daliuData) != null ? ' · prieš ' + daysSince(it.daliuData) + ' d.' : '') + '</div>' : '') +
    '</div>' +
    '<label>Nuotraukos (nebūtina)</label><input id="ph" type="file" accept="image/*" multiple>' +
    '<div id="phi" class="muted"></div>' +
    '<button data-act="save">Išsaugoti</button>' +
    '<button class="sec" data-act="nav" data-v="list">Atgal į sąrašą</button>';

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
  const rwEl = $('#rw');
  const rw = rwEl && rwEl.value !== (it.remontoGarantija || '') ? rwEl.value : '';
  const files = Array.from($('#ph').files || []);
  const prNew = $('#pr').value.trim(), trNew = $('#tr').value.trim(), dpNew = $('#dp') ? $('#dp').value.trim() : '';
  for (const v of [prNew, trNew, dpNew]) {
    const n = moneyNum(v);
    if (n !== null && (!isFinite(n) || n < 0)) { toast('Neteisinga suma: ' + v, 'err'); return; }
  }
  const pr = moneyNum(prNew) !== moneyNum(it.kaina) && prNew !== '' ? prNew : '';
  const tr = moneyNum(trNew) !== moneyNum(it.transportas) && trNew !== '' ? trNew : '';
  const dp = moneyNum(dpNew) !== moneyNum(it.dalys) && dpNew !== '' ? dpNew : '';
  const opEl = $('#op');
  const opNew = opEl ? opEl.value.trim() : '';
  const opv = opNew !== (it.uzsakytos || '').trim() ? opNew : null;   // null – nekeista
  if (/dali/i.test(status) && !opNew) { toast('Įrašykite užsakytas dalis ir jų kodus.', 'err'); if (opEl) opEl.focus(); return; }
  if (!comment && !status && !rw && !pr && !tr && !dp && opv === null && !files.length) { toast('Įrašykite komentarą, kainą, pasirinkite statusą, garantiją arba nuotrauką.', 'err'); return; }
  if (/atlikt/i.test(status) && !rw && !it.remontoGarantija) { toast('Pasirinkite, ar suremontuota garantiškai.', 'err'); if (rwEl) rwEl.focus(); return; }
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
    if (text || status || rw || pr || tr || dp || opv !== null) {
      await obAdd({ type: 'comment', opId: uid(), nr, mech, comment: text, status, warranty: rw, price: pr, partsPrice: dp, transport: tr, orderedParts: opv, ts: now });
      if (opv !== null) it.uzsakytos = opv;
      if (/dali/i.test(status) && !it.daliuData) it.daliuData = today();
      if (rw) it.remontoGarantija = rw;
      if (pr) it.kaina = String(moneyNum(pr));
      if (tr) it.transportas = String(moneyNum(tr));
      if (dp) it.dalys = String(moneyNum(dp));
      if (text) {
        const line = (mech ? mech + ': ' : '') + text;
        it.komentarai = (it.komentarai ? it.komentarai + '\n' : '') + line;
      }
      if (status) it.statusas = status;
      if (status && /atliekam/i.test(status) && !it.meistras && S.data.me) it.meistras = S.data.me;
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
/* ---------- Esamo kliento paieška ---------- */
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.indexOf('00') === 0) d = d.substring(2);
  if (d.length === 9 && d.charAt(0) === '8') d = '370' + d.substring(1);
  else if (d.length === 8 && d.charAt(0) === '6') d = '370' + d;
  return d;
}

/** Užpildo kliento laukus, jei rastas klientas (pagal telefoną arba tikslų vardą). */
function clientLookup(by) {
  const list = S.data.clients || [];
  if (!list.length) return;
  const f = k => $('[data-f="' + k + '"]');
  let c = null;
  if (by === 'tel') {
    const p = normPhone(f('Telefonas').value);
    if (p.length < 8) return;
    c = list.find(x => normPhone(x[1]) === p);
  } else {
    const n = norm(f('Klientas').value.trim());
    if (!n) return;
    const hits = list.filter(x => norm(x[0]) === n);
    if (hits.length === 1) c = hits[0];
  }
  if (!c) { if (by === 'tel') $('#clhint').textContent = ''; return; }
  const set = (k, v) => { const el = f(k); if (el && v && !el.value.trim()) el.value = v; };
  set('Klientas', c[0]); set('Telefonas', c[1]); set('El. paštas', c[2]); set('Kliento adresas', c[3]);
  $('#clhint').textContent = '✓ Esamas klientas: ' + c[0] + (c[1] ? ' · ' + c[1] : '');
}

function renderNew() {
  const L = S.data.lists;
  const req = ' <span class="req">*</span>';
  const inp = (title, type, r, ph) => '<label>' + esc(title) + (r ? req : '') + '</label><input data-f="' + esc(title) + '" type="' + (type || 'text') + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + ' autocomplete="off">';
  const sel = (title, list, r, emptyLabel) => '<label>' + esc(title) + (r ? req : '') + '</label><select data-f="' + esc(title) + '">' + optList(list, '', emptyLabel || 'Pasirinkite...') + '</select>';
  const prev = lsGet('mech');
  const drv = S.auth.role === 'driver';
  $('#app').innerHTML =
    '<div class="card"><div class="nr">' + (drv ? 'Technikos paėmimas' : 'Naujas priėmimas') + '</div><div class="muted">' +
      (drv ? 'Paėmė: <b>' + esc(S.data.me || '') + '</b> · veikia ir be interneto' : 'Veikia ir be interneto – numeris suteikiamas išsiuntus.') + '</div></div>' +
    (drv ? '<input type="hidden" data-f="Priėmė" value="' + esc(S.data.me || '') + '">'
         : '<label>Priėmė' + req + '</label><select data-f="Priėmė">' + optList(L.workers, prev, 'Pasirinkite...') + '</select>') +
    inp('Telefonas', 'tel', true, 'Įveskite – esamas klientas bus rastas') +
    inp('Klientas', 'text', true) +
    '<div id="clhint" class="muted"></div>' +
    '<datalist id="cllist">' + (S.data.clients || []).map(c => '<option value="' + esc(c[0]) + '">' + esc(c[1]) + '</option>').join('') + '</datalist>' +
    '<label>Kliento el. paštas</label><input data-f="El. paštas" type="email" inputmode="email" placeholder="Įrašius – klientas gaus akto kopiją" autocomplete="off">' +
    inp('Kliento adresas', 'text', drv, drv ? 'Iš kur paimta technika' : '') +
    sel('Įrenginio tipas', L.types, true) +
    sel('Gamintojas', L.makers, true) +
    inp('Modelis', 'text', false) +
    inp('Serijos Nr. / IMEI', 'text', false) +
    sel('Komplektacija', L.kits, false, '— nėra —') +
    inp('Išvaizda / būklė', 'text', false) +
    sel('Gedimo tipas', L.faults, true) +
    '<label>Gedimo aprašymas (kliento žodžiais)' + req + '</label><textarea data-f="Gedimo aprašymas (kliento žodžiais)"></textarea>' +
    '<label>Garantinis?' + req + '</label><div class="radios"><label><input type="radio" name="w" value="Taip">Taip</label><label><input type="radio" name="w" value="Ne">Ne</label></div>' +
    '<label>Nuotraukos' + (drv ? req + ' <span class="muted">(bent viena: bendras vaizdas, pažeidimai, serijos Nr.)</span>' : ' (nebūtina)') + '</label><input id="ph" type="file" accept="image/*" multiple><div id="phi" class="muted"></div>' +
    '<label>Kliento parašas' + (drv ? req : ' (nebūtina)') + '</label>' +
    '<div class="muted">Klientas patvirtina, kad technika perduota servisui, o duomenys teisingi.</div>' +
    '<div class="sigbox"><canvas id="sig"></canvas><span class="sighint">Pasirašykite pirštu čia</span></div>' +
    '<button type="button" class="sec small" data-act="sigclear">Išvalyti parašą</button>' +
    '<button data-act="submitnew">' + (drv ? 'Išsaugoti paėmimą' : 'Išsaugoti priėmimą') + '</button>';
  const kl = $('[data-f="Klientas"]');
  if (kl) kl.setAttribute('list', 'cllist');
  sigInit();
}

/* ---------- Kliento parašas ---------- */
function sigInit() {
  const c = $('#sig');
  if (!c) return;
  const ctx = c.getContext('2d');
  const size = () => {
    const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'; ctx.fillStyle = '#111';
    S.sig = false; c.parentNode.classList.remove('signed');
  };
  size();
  let last = null;
  const pt = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  c.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { c.setPointerCapture(e.pointerId); } catch (x) {}
    last = pt(e); ctx.beginPath(); ctx.arc(last[0], last[1], 1.1, 0, 7); ctx.fill();
  });
  c.addEventListener('pointermove', e => {
    if (!last) return;
    e.preventDefault();
    const p = pt(e);
    ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    last = p;
    if (!S.sig) { S.sig = true; c.parentNode.classList.add('signed'); }
  });
  const end = () => { last = null; };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  S.sigClear = size;
}

/** Parašas kaip nedidelis PNG (baltas fonas), arba '' jei nepasirašyta. */
function sigData() {
  const c = $('#sig');
  if (!c || !S.sig) return '';
  const w = 600, h = Math.round(600 * c.height / c.width);
  const o = document.createElement('canvas'); o.width = w; o.height = h;
  const x = o.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
  x.drawImage(c, 0, 0, w, h);
  return o.toDataURL('image/png').split(',')[1];
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
  const drv = S.auth.role === 'driver';
  if (drv && !fields['Kliento adresas']) { toast('Užpildykite: Kliento adresas', 'err'); return; }
  if (fields['El. paštas'] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields['El. paštas'])) { toast('Neteisingas el. pašto adresas.', 'err'); return; }
  if (drv && !files.length) { toast('Pridėkite bent vieną nuotrauką.', 'err'); return; }
  const sig = sigData();
  if (drv && !sig) { toast('Reikalingas kliento parašas.', 'err'); return; }

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
    await obAdd({ type: 'intake', opId: uid(), tmpId, fields, sig, ts });
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
  if (o.type === 'warranty') return 'Garantinė pretenzija (' + esc(o.nr) + ')';
  if (o.type === 'wnew') return 'Nauja pretenzija: ' + esc((o.fields && o.fields.klientas) || '');
  if (o.type === 'intake') return 'Naujas priėmimas: ' + esc((o.fields && o.fields['Klientas']) || '');
  if (o.type === 'photo') return 'Nuotrauka (' + esc(String(o.nr).indexOf('tmp:') === 0 ? 'naujam priėmimui' : o.nr) + ')';
  return 'Komentaras / statusas (' + esc(String(o.nr).indexOf('tmp:') === 0 ? 'naujam priėmimui' : o.nr) + ')';
}

/* ---------- Garantinės pretenzijos ---------- */
const W_STAGES = ['Neužpildyta', 'Laukia patvirtinimo', 'Laukiamos dalys', 'Užbaigta'];
const W_PARTS = 'Laukiamos dalys';
const wStage = () => { const v = lsGet('wstage'); return W_STAGES.indexOf(v) >= 0 ? v : W_STAGES[0]; };
const wCls = st => (st === W_STAGES[0] ? 'q' : st === W_STAGES[1] ? 'p' : st === W_PARTS ? 'w' : 'h');
const daysSince = d => { if (!d) return null; const t = new Date(d + 'T00:00:00'); return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000); };

function renderWList() {
  if (!S.data) return;
  const items = S.data.items || [];
  const cur = wStage();
  const cnt = st => items.filter(it => it.gStage === st).length;
  if (!$('#wl')) {
    $('#app').innerHTML =
      '<button class="newbtn" data-act="nav" data-v="wnew">+ Nauja pretenzija (be serviso)</button>' +
      '<div class="seg">' + W_STAGES.map(st => '<button class="segb" data-act="wstage" data-s="' + esc(st) + '">' +
        '<span class="sl">' + esc(st) + '</span><span class="cnt" data-c="' + esc(st) + '"></span></button>').join('') + '</div>' +
      '<div class="searchwrap"><input id="q" type="search" placeholder="Ieškoti: Nr., klientas, gamintojas, akto Nr..." value="' + esc(S.q) + '"></div>' +
      '<div id="count"></div><div id="wl"></div>' +
      '<button class="sec" data-act="sync">Atnaujinti sąrašą</button>';
  }
  $$('.segb').forEach(b => b.classList.toggle('on', b.getAttribute('data-s') === cur));
  $$('[data-c]').forEach(c => {
    const n = cnt(c.getAttribute('data-c'));
    c.textContent = n;
    c.classList.toggle('warn', c.getAttribute('data-c') === W_STAGES[0] && n > 0);
  });
  const words = norm(S.q).split(' ').filter(Boolean);
  let out = '', n = 0;
  items.forEach(it => {
    if (it.gStage !== cur) return;
    const hay = norm([it.nr, it.klientas, it.irenginys, it.serija, it.telefonas, it.gAct, it.meistras].join(' '));
    for (const w of words) { if (hay.indexOf(w) < 0) return; }
    n++;
    const ds = cur === W_STAGES[0] ? daysSince(it.atlikta || it.itraukta) : daysSince(it.gDate);
    const info = cur === W_STAGES[0]
      ? (it.saltinis === 'Be serviso' ? 'Įtraukta ' + esc(it.itraukta || '–') + (ds != null ? ' · prieš ' + ds + ' d.' : '')
         : it.atlikta ? 'Suremontuota ' + esc(it.atlikta) + (ds != null ? ' · prieš ' + ds + ' d.' : '') : 'Remontas dar nebaigtas')
      : 'Aktas <b>' + esc(it.gAct || '–') + '</b> · pateikta ' + esc(it.gDate || '–') +
        (cur === W_PARTS ? ' · dalys <b>' + esc(it.gParts || '–') + '</b>' : '') +
        (cur !== W_STAGES[3] && ds != null ? ' · ' + ds + ' d.' : '');
    out += '<div class="card ' + (it.tmp ? 'tmp ' : 'tap ') + 's-' + wCls(it.gStage) + '"' + (it.tmp ? '' : ' data-act="open" data-k="' + esc(it.nr) + '"') + '>' +
      '<div class="top"><div class="nr">' + esc(it.nr) + ' · ' + esc(it.klientas) + '</div>' +
        (cur === W_STAGES[0] && ds != null && ds >= 7 ? '<span class="chip c-late">' + ds + ' d.</span>' : '<span class="chip c-' + wCls(it.gStage) + '">' + esc(it.gStage) + '</span>') + '</div>' +
      '<div class="dev">' + esc(it.irenginys) + '</div>' +
      '<div class="muted">' + info + (it.meistras ? ' · ' + esc(it.meistras) : '') + (it.saltinis === 'Be serviso' ? ' · <b>be serviso</b>' : '') + '</div></div>';
  });
  const ts = S.data.ts ? ' · atnaujinta ' + pad(new Date(S.data.ts).getHours()) + ':' + pad(new Date(S.data.ts).getMinutes()) : '';
  $('#count').textContent = 'Rasta: ' + n + ts;
  $('#wl').innerHTML = out || '<p class="muted">Šioje dalyje darbų nėra.</p>';
}

function renderWDetail(it) {
  const today = stamp(new Date()).slice(0, 10);
  $('#app').innerHTML =
    '<div class="card s-' + wCls(it.gStage) + '">' +
      '<div class="top"><div class="nr">' + esc(it.nr) + ' · ' + esc(it.klientas) + '</div><span class="chip c-' + wCls(it.gStage) + '">' + esc(it.gStage) + '</span></div>' +
      '<div class="dev">' + esc(it.irenginys) + '</div>' +
      (it.serija ? '<div class="muted">Serija / IMEI: ' + esc(it.serija) + '</div>' : '') +
      (it.saltinis === 'Be serviso'
        ? '<div class="muted"><b>Be serviso</b> · įtraukta ' + esc(it.itraukta || '–') + '</div>'
        : '<div class="muted">Priimta ' + esc(it.data || '–') + ' · suremontuota ' + esc(it.atlikta || '–') + (it.meistras ? ' · ' + esc(it.meistras) : '') + '</div>') +
      (it.aprasymas ? '<div class="pre"><b>Gedimas:</b> ' + esc(it.aprasymas) + '</div>' : '') +
      (it.komentarai ? '<div class="pre"><b>Meistro komentarai:</b>\n' + esc(it.komentarai) + '</div>' : '') +
      (it.gNote ? '<div class="pre"><b>Pretenzijos istorija:</b>\n' + esc(it.gNote) + '</div>' : '') +
    '</div>' +
    '<div class="row2">' +
      '<div><label>Garantinio akto Nr. <span class="req">*</span></label><input id="wa" type="text" autocomplete="off" value="' + esc(it.gAct || '') + '"></div>' +
      '<div><label>Pateikta tiekėjui <span class="req">*</span></label><input id="wd" type="date" max="' + today + '" value="' + esc(it.gDate || '') + '"></div>' +
    '</div>' +
    '<label>Būsena</label><select id="ws">' + W_STAGES.map(st => '<option' + (st === it.gStage ? ' selected' : '') + '>' + esc(st) + '</option>').join('') + '</select>' +
    '<div class="muted">Akto Nr. ir data privalomi visoms būsenoms, išskyrus „Neužpildyta“.</div>' +
    '<div id="wpbox"><label>Dalių kodas <span class="req">*</span></label><input id="wp" type="text" autocomplete="off" placeholder="Pvz.: 5823-01, 5823-02" value="' + esc(it.gParts || '') + '"></div>' +
    '<label>Komentaras <span class="req">*</span></label><textarea id="wc" placeholder="Pvz.: pateikta Husqvarna portale; patvirtinta, kompensuota 120 €..."></textarea>' +
    '<button data-act="wsave">Išsaugoti</button>' +
    '<button class="sec" data-act="nav" data-v="wlist">Atgal į sąrašą</button>';
  if (it.gStage === W_STAGES[0] && !it.gAct) $('#ws').value = W_STAGES[1];
  wPartsToggle();
}
function wPartsToggle() { const b = $('#wpbox'); if (b) b.classList.toggle('hidden', $('#ws').value !== W_PARTS); }

async function saveW(btn) {
  const it = findItem(S.cur);
  if (!it) return;
  const act = $('#wa').value.trim(), date = $('#wd').value, stage = $('#ws').value, comment = $('#wc').value.trim();
  const parts = $('#wp').value.trim();
  if (!comment) { toast('Komentaras privalomas.', 'err'); $('#wc').focus(); return; }
  if (stage !== W_STAGES[0] && (!act || !date)) { toast('Įrašykite garantinio akto Nr. ir pateikimo datą.', 'err'); return; }
  if (stage === W_PARTS && !parts) { toast('Įrašykite dalių kodą.', 'err'); $('#wp').focus(); return; }
  btn.disabled = true;
  try {
    await obAdd({ type: 'warranty', opId: uid(), nr: it.nr, mech: S.data.me || '', stage, act: act !== (it.gAct || '') ? act : '', date: date !== (it.gDate || '') ? date : '', parts: parts !== (it.gParts || '') ? parts : '', comment, ts: Date.now() });
    it.gAct = act; it.gDate = date; it.gStage = stage; if (parts) it.gParts = parts;
    it.gNote = (it.gNote ? it.gNote + '\n' : '') + (S.data.me ? S.data.me + ': ' : '') + '[' + stage + '] ' + comment;
    await kvSet('data', S.data);
    toast(navigator.onLine ? 'Išsaugota, siunčiama...' : 'Išsaugota telefone. Bus išsiųsta atsiradus internetui.');
    lsSet('wstage', stage);
    await loadPending();
    go('wlist');
    sync();
  } catch (e) {
    toast(e.message || String(e), 'err');
  } finally { btn.disabled = false; }
}

/** Nauja pretenzija be serviso (pvz. parduotai technikai, kuri neremontuojama servise). */
function renderWNew() {
  const today = stamp(new Date()).slice(0, 10);
  const req = ' <span class="req">*</span>';
  $('#app').innerHTML =
    '<div class="card"><div class="nr">Nauja pretenzija be serviso</div><div class="muted">Numeris (G-…) suteikiamas automatiškai išsiuntus.</div></div>' +
    '<label>Klientas' + req + '</label><input id="nk" type="text" autocomplete="off">' +
    '<label>Telefonas</label><input id="nt" type="tel" autocomplete="off">' +
    '<label>Įrenginys' + req + '</label><input id="ni" type="text" autocomplete="off" placeholder="Pvz.: Vejapjovė Husqvarna LC 140">' +
    '<label>Serijos Nr.</label><input id="ns" type="text" autocomplete="off">' +
    '<div class="row2">' +
      '<div><label>Garantinio akto Nr.</label><input id="wa" type="text" autocomplete="off"></div>' +
      '<div><label>Pateikta tiekėjui</label><input id="wd" type="date" max="' + today + '"></div>' +
    '</div>' +
    '<label>Būsena</label><select id="ws">' + W_STAGES.map(st => '<option>' + esc(st) + '</option>').join('') + '</select>' +
    '<div class="muted">Akto Nr. ir data privalomi visoms būsenoms, išskyrus „Neužpildyta“.</div>' +
    '<div id="wpbox"><label>Dalių kodas' + req + '</label><input id="wp" type="text" autocomplete="off" placeholder="Pvz.: 5823-01, 5823-02"></div>' +
    '<label>Komentaras' + req + '</label><textarea id="wc" placeholder="Gedimas, kas pateikta tiekėjui, kiti svarbūs dalykai..."></textarea>' +
    '<button data-act="wnewsave">Išsaugoti pretenziją</button>' +
    '<button class="sec" data-act="nav" data-v="wlist">Atšaukti</button>';
  wPartsToggle();
}

async function saveWNew(btn) {
  const v = id => $(id).value.trim();
  const fields = { klientas: v('#nk'), telefonas: v('#nt'), irenginys: v('#ni'), serija: v('#ns') };
  const act = v('#wa'), date = $('#wd').value, stage = $('#ws').value, parts = v('#wp'), comment = v('#wc');
  if (!fields.klientas) { toast('Įrašykite klientą.', 'err'); $('#nk').focus(); return; }
  if (!fields.irenginys) { toast('Įrašykite įrenginį.', 'err'); $('#ni').focus(); return; }
  if (!comment) { toast('Komentaras privalomas.', 'err'); $('#wc').focus(); return; }
  if (stage !== W_STAGES[0] && (!act || !date)) { toast('Įrašykite garantinio akto Nr. ir pateikimo datą.', 'err'); return; }
  if (stage === W_PARTS && !parts) { toast('Įrašykite dalių kodą.', 'err'); $('#wp').focus(); return; }
  btn.disabled = true;
  try {
    const tmpId = 'tmp:' + uid();
    await obAdd({ type: 'wnew', opId: uid(), tmpId, fields, stage, act, date, parts, comment, mech: S.data.me || '', ts: Date.now() });
    S.data.items.unshift({
      nr: '⏳ Nauja', tmp: true, tmpId, klientas: fields.klientas, telefonas: fields.telefonas,
      irenginys: fields.irenginys + (fields.serija ? ' · SN ' + fields.serija : ''), saltinis: 'Be serviso',
      itraukta: today(), gStage: stage, gAct: act, gDate: date, gParts: parts,
      gNote: (S.data.me ? S.data.me + ': ' : '') + '[' + stage + '] ' + comment
    });
    await kvSet('data', S.data);
    toast(navigator.onLine ? 'Pretenzija išsaugota, siunčiama...' : 'Išsaugota telefone. Bus išsiųsta atsiradus internetui.');
    lsSet('wstage', stage);
    await loadPending();
    go('wlist');
    sync();
  } catch (e) {
    toast(e.message || String(e), 'err');
  } finally { btn.disabled = false; }
}

/* ---------- Vadovo suvestinė ---------- */
const eur = v => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('lt-LT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const dPlural = n => n + ' d.';

async function loadDash(force) {
  if (!S.dash) S.dash = await kvGet('dash');
  renderDash();
  if (!navigator.onLine) return;
  if (!force && S.dash && Date.now() - (S.dash.ts || 0) < 60000) return;
  try {
    const j = await post({ pin: S.auth.pin, action: 'dashboard' });
    if (!j.ok) throw new Error(j.error || 'Klaida');
    j.ts = Date.now();
    S.dash = j;
    await kvSet('dash', j);
    if (S.view === 'dash') renderDash();
  } catch (e) {
    if (S.view === 'dash') toast('Suvestinės atnaujinti nepavyko: ' + (e.message || e), 'err');
  }
}

function renderDash() {
  const d = S.dash;
  if (!d) { $('#app').innerHTML = '<div class="card"><div class="nr">Suvestinė</div><div class="muted">Kraunama... Pirmą kartą reikia interneto.</div></div>'; return; }
  const c = d.menuo.dabar, p = d.menuo.praeitas;
  const delta = (a, b, money) => {
    if (!b && !a) return '<span class="muted">kaip praeitą mėn.</span>';
    if (!b) return '<span class="up">nauja</span>';
    const pc = Math.round((a - b) / b * 100);
    if (!pc) return '<span class="muted">= kaip praeitą mėn.</span>';
    return '<span class="' + (pc >= 0 ? 'up' : 'down') + '">' + (pc >= 0 ? '▲ ' : '▼ ') + Math.abs(pc) + '%</span> <span class="muted">vs ' + (money ? eur(b) : b) + '</span>';
  };
  const tile = (label, value, sub) => '<div class="tile"><div class="tl">' + label + '</div><div class="tv">' + value + '</div><div class="ts">' + sub + '</div></div>';
  const rev = c.darbai + (c.dalys || 0) + c.transportas, prevRev = p.darbai + (p.dalys || 0) + p.transportas;

  const list = (title, arr, unit, hint) => {
    let h = '<details class="att"' + (arr.length ? ' open' : '') + '><summary><span>' + title + '</span><span class="cnt' + (arr.length ? ' warn' : '') + '">' + arr.length + '</span></summary>';
    if (hint) h += '<div class="muted hint">' + hint + '</div>';
    if (!arr.length) h += '<div class="muted hint">Nėra.</div>';
    arr.slice(0, 30).forEach(x => {
      const open = !!findItem(x.nr);
      h += '<div class="card ' + (open ? 'tap ' : '') + 's-' + sc(x.statusas) + '"' + (open ? ' data-act="open" data-k="' + esc(x.nr) + '"' : '') + '>' +
        '<div class="top"><div class="nr">' + esc(x.nr) + ' · ' + esc(x.klientas) + '</div><span class="chip c-w">' + unit + ' ' + dPlural(x.dienos) + '</span></div>' +
        '<div class="dev">' + esc(x.irenginys) + '</div>' +
        '<div class="muted">' + (x.priezastis ? '<b>' + esc(x.priezastis) + '</b> · ' : '') + esc(x.statusas) + (x.meistras ? ' · ' + esc(x.meistras) : ' · nepriskirta') +
        (x.telefonas ? ' · <a href="tel:' + esc(x.telefonas.replace(/[^\d+]/g, '')) + '">' + esc(x.telefonas) + '</a>' : '') + '</div></div>';
    });
    if (arr.length > 30) h += '<div class="muted hint">Rodoma 30 iš ' + arr.length + '.</div>';
    return h + '</details>';
  };

  const bars = (title, arr) => {
    const max = Math.max(1, ...arr.map(x => x.kiekis));
    return '<div class="card"><div class="nr">' + title + '</div>' + (arr.length ? arr.map(x =>
      '<div class="bar"><span class="bl">' + esc(x.pavadinimas) + '</span><span class="bt"><span style="width:' + Math.round(x.kiekis / max * 100) + '%"></span></span><span class="bn">' + x.kiekis + '</span></div>').join('')
      : '<div class="muted">Duomenų nėra.</div>') + '</div>';
  };

  const dem = d.demesio, r = d.ribos;
  const totalAtt = new Set([].concat(dem.veluoja, dem.neatsiimta, dem.truksta, dem.eileje, dem.daliu, (d.pretenzijos && d.pretenzijos.velu) || []).map(x => x.nr)).size;
  const upd = d.ts ? pad(new Date(d.ts).getHours()) + ':' + pad(new Date(d.ts).getMinutes()) : '';

  $('#app').innerHTML =
    '<div class="dashhead"><div><div class="nr">Suvestinė · ' + esc(d.menuo.pavadinimas) + '</div><div class="muted">Atnaujinta ' + upd + ' · palyginta su praėjusiu mėnesiu</div></div>' +
    '<button class="small sec" data-act="dashrefresh">Atnaujinti</button></div>' +
    '<div class="tiles">' +
      tile('Apyvarta (su PVM)', eur(rev), delta(rev, prevRev, true)) +
      tile('Atlikta darbų', c.atlikta, delta(c.atlikta, p.atlikta)) +
      tile('Priimta', c.priimta, delta(c.priimta, p.priimta)) +
      tile('Vid. remonto trukmė', c.trukme == null ? '–' : String(c.trukme).replace('.', ',') + ' d.', p.trukme == null ? '<span class="muted">praeitą mėn. –</span>' : '<span class="muted">praeitą mėn. ' + String(p.trukme).replace('.', ',') + ' d.</span>') +
    '</div>' +
    '<div class="card"><div class="split"><span>Darbai <b>' + eur(c.darbai) + '</b></span><span>Dalys <b>' + eur(c.dalys || 0) + '</b></span><span>Transportas <b>' + eur(c.transportas) + '</b></span></div>' +
      '<div class="muted">Atlikta: garantinių ' + c.garantiniai + ' · negarantinių ' + c.negarantiniai + (c.nenurodyta ? ' · <b>nenurodyta ' + c.nenurodyta + '</b>' : '') + '</div>' +
      (d.kainuStulpeliai ? '' : '<div class="err-t">Lentelėje nėra kainų stulpelių – apyvarta nerodoma.</div>') + '</div>' +

    '<h2 class="sect">Reikia dėmesio <span class="cnt' + (totalAtt ? ' warn' : '') + '">' + totalAtt + '</span></h2>' +
    list('Neatsiimta technika', dem.neatsiimta, 'laukia', 'Darbas atliktas, bet klientas neatsiėmė ilgiau nei ' + r.PICKUP_DAYS + ' d.') +
    list('Ilgai eilėje', dem.eileje, 'eilėje', 'Darbas nepradėtas ilgiau nei ' + r.QUEUE_DAYS + ' d.') +
    list('Ilgai laukia dalių', dem.daliu, 'laukia', 'Dalių laukiama ilgiau nei ' + r.PARTS_DAYS + ' d.') +
    list('Vėluojantys darbai', dem.veluoja, 'nuo priėmimo', 'Nebaigta ilgiau nei ' + r.LATE_DAYS + ' d. nuo priėmimo (be jau išvardintų eilėje ar laukiančių dalių).') +
    (d.pretenzijos && d.pretenzijos.velu ? list('Neužpildytos garantinės pretenzijos', d.pretenzijos.velu, 'laukia', 'Garantinis remontas atliktas, bet pretenzija tiekėjui neužpildyta ' + 7 + ' d. ar ilgiau.') : '') +
    list('Atlikti be kainos ar garantijos žymos', dem.truksta, 'prieš', 'Per paskutines ' + r.CHECK_DAYS + ' d. atlikti darbai, kuriuos reikia sutvarkyti.') +

    (d.pretenzijos && d.pretenzijos.kiekiai ? '<h2 class="sect">Garantinės pretenzijos</h2><div class="card"><div class="split">' +
      Object.keys(d.pretenzijos.kiekiai).map(k => '<span>' + esc(k) + ' <b class="' + (k === 'Neužpildyta' && d.pretenzijos.kiekiai[k] ? 'down' : '') + '">' + d.pretenzijos.kiekiai[k] + '</b></span>').join('') +
      '</div></div>' : '') +
    '<h2 class="sect">Meistrai</h2>' +
    '<div class="tablewrap"><table class="mt"><thead><tr><th>Meistras</th><th title="Atlikta šį mėnesį">Atlikta</th><th>Apyvarta</th><th>Turi</th></tr></thead><tbody>' +
      (d.meistrai.length ? d.meistrai.map(m => '<tr><td>' + esc(m.meistras) + '</td><td>' + m.atlikta + '</td><td>' + eur(m.apyvarta) + '</td><td>' + m.dabar + '</td></tr>').join('') : '<tr><td colspan="4" class="muted">Duomenų nėra.</td></tr>') +
      (d.nepriskirta ? '<tr class="na"><td>Nepriskirta</td><td></td><td></td><td>' + d.nepriskirta + '</td></tr>' : '') +
    '</tbody></table></div>' +

    '<h2 class="sect">Tendencijos · ' + d.ribos.TREND_DAYS + ' d.</h2>' +
    bars('Dažniausi gedimai', d.gedimai) +
    bars('Dažniausi gamintojai', d.gamintojai) +
    '<div class="card"><div class="nr">Klientai šį mėnesį</div><div class="split"><span>Nauji <b>' + d.klientai.nauji + '</b></span><span>Grįžtantys <b>' + d.klientai.griztantys + '</b></span></div></div>';
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
    nr, mech: op.mech, comment: op.comment, status: op.status, warranty: op.warranty, price: op.price, partsPrice: op.partsPrice, transport: op.transport, orderedParts: op.orderedParts, stage: op.stage, act: op.act, date: op.date, parts: op.parts,
    kind: op.kind, b64: op.b64, fields: op.fields, sig: op.sig, ts: op.ts
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
  if (act === 'nav') { go(el.getAttribute('data-v')); if (S.view === 'dash') loadDash(false); return; }
  if (act === 'open') return go('detail', el.getAttribute('data-k'));
  if (act === 'dashrefresh') return loadDash(true);
  if (act === 'wstage') { lsSet('wstage', el.getAttribute('data-s')); return renderWList(); }
  if (act === 'wsave') return saveW(el);
  if (act === 'wnewsave') return saveWNew(el);
  if (act === 'filter') { S.filter = el.getAttribute('data-f'); $$('.fchip').forEach(c => c.classList.toggle('on', c.getAttribute('data-f') === S.filter)); return renderList(); }
  if (act === 'scope') { lsSet('scope', el.getAttribute('data-s')); return renderListView(); }
  if (act === 'save') return saveDetail(el);
  if (act === 'submitnew') return submitNew(el);
  if (act === 'sigclear') { if (S.sigClear) S.sigClear(); return; }
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
  if (ev.target.id === 'q' && S.view === 'wlist') { S.q = ev.target.value; renderWList(); return; }
  if (S.view === 'new' && ev.target.getAttribute) {
    const f = ev.target.getAttribute('data-f');
    if (f === 'Telefonas') clientLookup('tel');
    else if (f === 'Klientas') clientLookup('name');
  }
  if (ev.target.id === 'q') { S.q = ev.target.value; renderList(); }
});
document.addEventListener('change', ev => {
  if (ev.target.id === 'ws') { wPartsToggle(); return; }
  if (ev.target.id === 'st' && $('#opbox')) { if (/dali/i.test(ev.target.value)) { $('#opbox').classList.remove('hidden'); $('#op').focus(); } return; }
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
    if (a && d) { S.auth = a; S.data = d; go(homeView(a.role)); if (a.role === 'manager') loadDash(false); sync(); } else go('login');
  } catch (e) {
    go('login');
    say('Nepavyko atidaryti vietinės saugyklos: ' + (e.message || e), 'err');
  }
  setInterval(sync, 30000);
}

init();
})();
