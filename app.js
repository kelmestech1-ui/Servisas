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
    go(j.role === 'manager' ? 'dash' : 'list');
    if (j.role === 'manager') loadDash(true);
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
const scope = () => lsGet('scope') || 'mine';

function visible() {
  const role = S.auth.role;
  return S.data.items.filter(it => {
    const n = norm(it.statusas);
    if (n.indexOf('atiduot') >= 0) return false;
    if (role === 'mechanic' && n.indexOf('atlikt') >= 0) return false;
    if (S.data.me && scope() === 'mine' && it.meistras && it.meistras !== S.data.me) return false;
    return true;
  });
}

function renderListView() {
  const chips = [['', 'Visi'], ['q', 'Eilėje'], ['w', 'Atliekama'], ['p', 'Dalių'], ['d', 'Atlikta']];
  $('#app').innerHTML =
    '<div class="searchwrap"><input id="q" type="search" placeholder="Ieškoti: Nr., klientas, įrenginys, serija..." value="' + esc(S.q) + '"></div>' +
    (S.data.me ? '<div class="chips scope">' +
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
  if (!it) return go('list');
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
      '<div><label>Darbų kaina, € su PVM</label><input id="pr" type="text" inputmode="decimal" autocomplete="off" placeholder="pvz. 35" value="' + esc(money(it.kaina)) + '"></div>' +
      '<div><label>Transportas, € su PVM</label><input id="tr" type="text" inputmode="decimal" autocomplete="off" placeholder="pvz. 20" value="' + esc(money(it.transportas)) + '"></div>' +
    '</div>' +
    '<label>Suremontuota garantiškai</label><select id="rw">' + optList(['Taip', 'Ne'], it.remontoGarantija || '', 'Nenurodyta') + '</select>' +
    '<label>Komentaras</label><textarea id="c" placeholder="Ką atlikta / kas rasta..."></textarea>' +
    '<label>Naujas statusas</label><select id="st">' + optList(S.data.statuses, '', 'Nekeisti') + '</select>' +
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
  const prNew = $('#pr').value.trim(), trNew = $('#tr').value.trim();
  for (const v of [prNew, trNew]) {
    const n = moneyNum(v);
    if (n !== null && (!isFinite(n) || n < 0)) { toast('Neteisinga suma: ' + v, 'err'); return; }
  }
  const pr = moneyNum(prNew) !== moneyNum(it.kaina) && prNew !== '' ? prNew : '';
  const tr = moneyNum(trNew) !== moneyNum(it.transportas) && trNew !== '' ? trNew : '';
  if (!comment && !status && !rw && !pr && !tr && !files.length) { toast('Įrašykite komentarą, kainą, pasirinkite statusą, garantiją arba nuotrauką.', 'err'); return; }
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
    if (text || status || rw || pr || tr) {
      await obAdd({ type: 'comment', opId: uid(), nr, mech, comment: text, status, warranty: rw, price: pr, transport: tr, ts: now });
      if (rw) it.remontoGarantija = rw;
      if (pr) it.kaina = String(moneyNum(pr));
      if (tr) it.transportas = String(moneyNum(tr));
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
  $('#app').innerHTML =
    '<div class="card"><div class="nr">Naujas priėmimas</div><div class="muted">Veikia ir be interneto – numeris suteikiamas išsiuntus.</div></div>' +
    '<label>Priėmė' + req + '</label><select data-f="Priėmė">' + optList(L.workers, prev, 'Pasirinkite...') + '</select>' +
    inp('Telefonas', 'tel', true, 'Įveskite – esamas klientas bus rastas') +
    inp('Klientas', 'text', true) +
    '<div id="clhint" class="muted"></div>' +
    '<datalist id="cllist">' + (S.data.clients || []).map(c => '<option value="' + esc(c[0]) + '">' + esc(c[1]) + '</option>').join('') + '</datalist>' +
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
  const kl = $('[data-f="Klientas"]');
  if (kl) kl.setAttribute('list', 'cllist');
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
  const rev = c.darbai + c.transportas, prevRev = p.darbai + p.transportas;

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
  const totalAtt = new Set([].concat(dem.veluoja, dem.neatsiimta, dem.truksta, dem.eileje, dem.daliu).map(x => x.nr)).size;
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
    '<div class="card"><div class="split"><span>Darbai <b>' + eur(c.darbai) + '</b></span><span>Transportas <b>' + eur(c.transportas) + '</b></span></div>' +
      '<div class="muted">Atlikta: garantinių ' + c.garantiniai + ' · negarantinių ' + c.negarantiniai + (c.nenurodyta ? ' · <b>nenurodyta ' + c.nenurodyta + '</b>' : '') + '</div>' +
      (d.kainuStulpeliai ? '' : '<div class="err-t">Lentelėje nėra kainų stulpelių – apyvarta nerodoma.</div>') + '</div>' +

    '<h2 class="sect">Reikia dėmesio <span class="cnt' + (totalAtt ? ' warn' : '') + '">' + totalAtt + '</span></h2>' +
    list('Neatsiimta technika', dem.neatsiimta, 'laukia', 'Darbas atliktas, bet klientas neatsiėmė ilgiau nei ' + r.PICKUP_DAYS + ' d.') +
    list('Ilgai eilėje', dem.eileje, 'eilėje', 'Darbas nepradėtas ilgiau nei ' + r.QUEUE_DAYS + ' d.') +
    list('Ilgai laukia dalių', dem.daliu, 'laukia', 'Dalių laukiama ilgiau nei ' + r.PARTS_DAYS + ' d.') +
    list('Vėluojantys darbai', dem.veluoja, 'nuo priėmimo', 'Nebaigta ilgiau nei ' + r.LATE_DAYS + ' d. nuo priėmimo (be jau išvardintų eilėje ar laukiančių dalių).') +
    list('Atlikti be kainos ar garantijos žymos', dem.truksta, 'prieš', 'Per paskutines ' + r.CHECK_DAYS + ' d. atlikti darbai, kuriuos reikia sutvarkyti.') +

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
    nr, mech: op.mech, comment: op.comment, status: op.status, warranty: op.warranty, price: op.price, transport: op.transport,
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
  if (act === 'nav') { go(el.getAttribute('data-v')); if (S.view === 'dash') loadDash(false); return; }
  if (act === 'open') return go('detail', el.getAttribute('data-k'));
  if (act === 'dashrefresh') return loadDash(true);
  if (act === 'filter') { S.filter = el.getAttribute('data-f'); $$('.fchip').forEach(c => c.classList.toggle('on', c.getAttribute('data-f') === S.filter)); return renderList(); }
  if (act === 'scope') { lsSet('scope', el.getAttribute('data-s')); return renderListView(); }
  if (act === 'save') return saveDetail(el);
  if (act === 'submitnew') return submitNew(el);
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
  if (S.view === 'new' && ev.target.getAttribute) {
    const f = ev.target.getAttribute('data-f');
    if (f === 'Telefonas') clientLookup('tel');
    else if (f === 'Klientas') clientLookup('name');
  }
  if (ev.target.id === 'q') { S.q = ev.target.value; renderList(); }
});
document.addEventListener('change', ev => {
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
    if (a && d) { S.auth = a; S.data = d; if (a.role === 'manager') { go('dash'); loadDash(false); } else go('list'); sync(); } else go('login');
  } catch (e) {
    go('login');
    say('Nepavyko atidaryti vietinės saugyklos: ' + (e.message || e), 'err');
  }
  setInterval(sync, 30000);
}

init();
})();
