import * as api from './api.js';
import { billTotals, balances, settleUp, pairwiseDebts, tripStats, format, toMinor } from './split.js';
import { odometer, revealRow, shootingStars, dotMatrix, orbitalRing } from './fx.js';

const root = document.getElementById('app');
const S = {
  trip: null,      // loaded Trip
  draft: null,     // unsaved Bill from /parse
  editing: null,   // working copy of the bill shown in the grid
  isDraft: false,
  error: '',
  warning: '',
  busy: '',        // non-empty string = busy message
  offline: !navigator.onLine,
  showReceipt: false,
  confirmDelete: false,
  pendingImage: null, // resized Blob kept for retry
  pendingUrl: null,   // object URL of pendingImage, shown behind the orbital ring
  gridShown: false,   // grid rows have staggered in once on this screen
  form: null,      // landing form values kept across a failed submit
  memberDraft: '', // "+ add" text kept across a failed save
  loadError: null, // non-404 trip load failure message
  exp: null,       // expense form values kept across a failed submit
  expSplit: { mode: 'equal', byMember: {} }, // expense form split mode and per-member values (major units), kept across errors
  lastInstruction: '', // add-bill instruction kept across a failed parse
  addPayer: '',    // add-bill payer kept across a failed parse
  instrText: '',   // grid "adjust in plain words" text kept across re-renders
  undo: null,      // {idx, item, until} of the row just removed from the grid
  gridScroll: 0,   // .gridwrap scrollLeft carried across in-place re-renders
  config: null,    // GET /api/config, fetched once at startup
  configFailed: false,
  tsToken: '',     // latest Turnstile token; cleared when a submit consumes it
  tsWidget: null,  // id of the rendered Turnstile widget (it lives in DOM that render() wipes)
  addPresent: null, // add-bill "who was there" ids kept across a failed parse (null = everyone)
  fx: [],          // stop() fns for canvases and listeners owned by the current screen; run before every repaint and on navigation
  payMode: 'simplified', // 'simplified' | 'direct', persisted in localStorage
};
let seq = 0;
let popCell = null; // {idx, m} of the dot that just turned on or changed weight; patchRow() pops only that one, then clears it
let enterNext = true; // set on navigation; the next paint plays the screen-enter animation, in-place re-renders do not
let addSeq = 0; // bumped on every navigation; an add-bill submit holding an older value was abandoned
let refetchHome = false; // set on navigation and tab focus; the next trip-home render refetches the trip
let justSaved = false; // the trip in S.trip was just returned by a save; skip the refetch (KV reads can lag a write)
let pressTimer = null, swallowClick = false, swallowTimer = null; // long-press state outlives re-renders
// After a long-press fired, swallow the click that follows the finger lift; expire the flag shortly after lift so a lost click cannot stick.
const armSwallowExpiry = () => { if (!swallowClick) return; clearTimeout(swallowTimer); swallowTimer = setTimeout(() => { swallowClick = false; }, 400); };
document.addEventListener('pointerup', armSwallowExpiry, true);
document.addEventListener('pointercancel', armSwallowExpiry, true);

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (m) => format(m, S.trip.currency);
const nameOf = (id) => S.trip.members.find((m) => m.id === id)?.name ?? '?';
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const errBox = () => (S.error ? `<div class="err">${esc(S.error)}</div>` : '');
const warnBox = () => { const w = S.warning || (S.isDraft ? S.editing?.warning : ''); return w ? `<div class="warn">${esc(w)}</div>` : ''; };

// Rolls el's amount from its previous value (el.dataset.v) to `to` minor units. Jumps under reduced motion.
const roll = (el, to) => { if (el) odometer(el, to, S.trip.currency, { signed: !!el.dataset.signed }); };
const stopFx = () => { for (const stop of S.fx) stop(); S.fx = []; };

// Last shown value per element key. Cleared on navigation (resetNav) so a new screen counts up from zero;
// not cleared by in-place re-renders, which continue from the previous value.
const shown = new Map();
function countIn(selector) {
  root.querySelectorAll(selector).forEach((el) => {
    const key = el.dataset.key, to = Number(el.dataset.to);
    el.dataset.v = String(shown.get(key) ?? 0);
    roll(el, to);
    shown.set(key, to);
  });
}

// Object URL for the retry photo; always revokes the previous one so none leak.
function setPending(blob) {
  if (S.pendingUrl) URL.revokeObjectURL(S.pendingUrl);
  S.pendingImage = blob;
  S.pendingUrl = blob ? URL.createObjectURL(blob) : null;
}

function remember(trip) {
  try {
    const list = JSON.parse(localStorage.getItem('evensteven.recent') || '[]').filter((t) => t.code !== trip.code);
    list.unshift({ code: trip.code, name: trip.name });
    localStorage.setItem('evensteven.recent', JSON.stringify(list.slice(0, 10)));
  } catch { /* storage unavailable */ }
}
function getPayMode() { try { return localStorage.getItem('evensteven.paymode') === 'direct' ? 'direct' : 'simplified'; } catch { return 'simplified'; } }
function setPayMode(m) { try { localStorage.setItem('evensteven.paymode', m); } catch { /* ignore */ } }
S.payMode = getPayMode();
function recent() { try { return JSON.parse(localStorage.getItem('evensteven.recent') || '[]'); } catch { return []; } }
function lastPayer() { try { return localStorage.getItem(`evensteven.payer.${S.trip.code}`) || ''; } catch { return ''; } }
function setLastPayer(id) { try { localStorage.setItem(`evensteven.payer.${S.trip.code}`, id); } catch { /* ignore */ } }

// ---------- routing ----------
function parseRoute() {
  const p = location.pathname.split('/').filter(Boolean);
  if (p[0] !== 't' || !p[1]) return { screen: 'landing' };
  const code = p[1].toUpperCase();
  if (p[2] === 'add') return { screen: 'add', code };
  if (p[2] === 'expense') return { screen: 'expense', code };
  if (p[2] === 'draft') return { screen: 'grid', code, draft: true };
  if (p[2] === 'bill' && p[3]) return { screen: 'grid', code, billId: p[3] };
  return { screen: 'home', code };
}

function resetNav() {
  addSeq++;
  S.error = ''; S.warning = ''; S.confirmDelete = false; S.showReceipt = false; S.memberDraft = ''; S.exp = null; S.expSplit = { mode: 'equal', byMember: {} }; S.editing = null;
  setPending(null); S.lastInstruction = ''; S.addPayer = ''; S.addPresent = null; // leaving the add screen abandons the retry photo
  shown.clear(); S.gridShown = false; enterNext = true; // new screen: numbers count from zero, rows stagger, screen enters
  clearTimeout(pressTimer); pressTimer = null; swallowClick = false;
  stopFx(); // no canvas or listener may outlive the screen that made it
  S.tsToken = '';
  S.undo = null; S.instrText = ''; S.gridScroll = 0; // nothing from this grid may leak into the next screen or bill
  refetchHome = true;
}

export function go(path) {
  resetNav();
  history.pushState(null, '', path);
  render();
}

// For bad or stale routes: replace the entry so Back does not bounce into it again.
function redirect(path) {
  history.replaceState(null, '', path);
  render();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('popstate', () => { resetNav(); render(); });
// Back on the tab: pick up other people's edits, but never mid-edit (busy, or typing in a home field).
const typing = () => root.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || S.busy || parseRoute().screen !== 'home') return;
  if (typing()) return;
  refetchHome = true; render();
});
// Flip the banner state always, but do not repaint while a home input has focus (a rename in progress would be wiped).
window.addEventListener('online', () => { S.offline = false; if (!(parseRoute().screen === 'home' && typing())) render(); });
window.addEventListener('offline', () => { S.offline = true; if (!(parseRoute().screen === 'home' && typing())) render(); });

// force: refetch even if this trip is loaded. A failed forced refetch keeps the trip already on screen.
async function ensureTrip(code, force = false) {
  if (S.trip?.code === code && !force) return true;
  try { S.trip = await api.getTrip(code); S.loadError = null; remember(S.trip); return true; }
  catch (e) {
    if (force && S.trip?.code === code) return true;
    S.trip = null; S.loadError = e.status === 404 ? null : e.message; return false; }
}

export async function persist(trip, nextPath) {
  if (S.busy) return;
  S.busy = 'Saving'; S.error = ''; render();
  try {
    S.trip = await api.saveTrip(trip);
    S.draft = null; S.editing = null; setPending(null); S.memberDraft = ''; S.exp = null;
    S.busy = '';
    justSaved = true;
    if (nextPath) go(nextPath); else render();
  } catch (e) {
    S.busy = '';
    if (e.status === 409 && e.data?.trip) {
      S.trip = e.data.trip; S.editing = null; S.draft = null; S.undo = null;
      S.error = 'Someone else saved this trip. Reloaded, your unsaved change was dropped.';
    } else S.error = e.message;
    render();
  }
}

function paint(html) {
  const gw = root.querySelector('.gridwrap');
  if (gw && !enterNext) S.gridScroll = gw.scrollLeft; // in-place re-render: keep the grid's horizontal scroll
  stopFx(); // before innerHTML: the stops still need their nodes
  root.innerHTML = html;
  const gw2 = root.querySelector('.gridwrap');
  if (gw2) gw2.scrollLeft = enterNext ? 0 : S.gridScroll;
  root.classList.remove('enter');
  if (enterNext) { enterNext = false; void root.offsetWidth; root.classList.add('enter'); }
}

export async function render() {
  const tok = ++seq;
  const r = parseRoute();
  if (!r.draft) S.draft = null; // leaving /draft discards the unsaved draft
  if (r.screen === 'landing') { paint(landing()); bindLanding(); return; }
  const force = refetchHome && r.screen === 'home' && !justSaved && !S.busy;
  refetchHome = false; justSaved = false;
  const ok = await ensureTrip(r.code, force);
  if (tok !== seq) return;
  const banner = S.offline ? '<div class="banner">Offline. Changes stay on this page until you reconnect.</div>' : '';
  if (!ok) {
    if (!S.loadError) { paint(notFound()); return; }
    paint(`${banner}<h1>Could not load trip</h1><div class="err">${esc(S.loadError)}</div><p><a href="#" id="retry">retry</a></p>`);
    root.querySelector('#retry').addEventListener('click', (e) => { e.preventDefault(); render(); });
    return;
  }
  let html = '', bind = () => {};
  if (r.screen === 'home') { html = home(); bind = bindHome; }
  else if (r.screen === 'expense') { html = expenseForm(); bind = bindExpense; }
  else if (r.screen === 'add') { html = addBill(); bind = bindAddBill; }
  else {
    const bill = r.draft ? S.draft : S.trip.bills.find((b) => b.id === r.billId);
    if (!bill) { redirect(`/t/${r.code}`); return; }
    if (!S.editing || S.editing.id !== bill.id) { S.editing = r.draft ? bill : structuredClone(bill); S.isDraft = !!r.draft; }
    html = grid(); bind = bindGrid;
  }
  paint(banner + html);
  bind();
}

// ---------- turnstile ----------
// render() wipes #ts, so each paint of a screen with a form re-renders the widget. The token survives that
// (it stays valid until a submit consumes it). With no site key the widget is skipped and forms submit without a token.
const tsOn = () => !!S.config?.turnstileSiteKey;
function renderTs(tries = 0) {
  const el = root.querySelector('#ts');
  if (!el || !tsOn() || el.dataset.ts) return;
  if (!window.turnstile) { if (tries < 50) setTimeout(() => renderTs(tries + 1), 200); return; }
  el.dataset.ts = '1';
  if (S.tsWidget != null) { try { window.turnstile.remove(S.tsWidget); } catch { /* widget already gone */ } S.tsWidget = null; }
  S.tsWidget = window.turnstile.render(el, {
    sitekey: S.config.turnstileSiteKey, theme: 'dark',
    callback: (t) => { S.tsToken = t; },
    'expired-callback': () => { S.tsToken = ''; },
    'error-callback': () => { S.tsToken = ''; },
  });
}
// Takes the token for one submit (it is single-use). Returns null when a widget is configured but not solved yet.
function takeTs() {
  if (S.config === null) return null; // config unknown: never post without a token we might need
  if (!tsOn()) return '';
  if (!S.tsToken) return null;
  const t = S.tsToken; S.tsToken = ''; return t;
}
const TS_WAIT = 'Still checking that you are human. Try again in a moment.';
const tsMsg = () => (S.config !== null ? TS_WAIT : S.configFailed ? "Couldn't load settings. Reload the page and try again." : 'Still loading, try again in a moment');

// ---------- landing ----------
function landing() {
  const rec = recent();
  const f = S.form || {};
  const names = f.members || [];
  return `
    <h1>New trip</h1>
    <p>One link, no accounts. Share it with the group and anyone can add bills.</p>
    ${errBox()}
    <div class="card">
    <form id="new">
      <label>Trip name</label><input name="name" required placeholder="Goa, Dec 2026" autocomplete="off" value="${esc(f.name)}">
      <label>Currency</label>
      <select name="currency">
        ${['INR', 'USD', 'EUR', 'GBP', 'THB', 'JPY', 'AED', 'SGD', 'IDR', 'VND', 'KRW', 'LKR'].map((c) => `<option${c === f.currency ? ' selected' : ''}>${c}</option>`).join('')}
      </select>
      <label>Members</label>
      <div class="list" id="mlist">${names.map((n, i) => `<div><span class="name">${esc(n)}</span><button type="button" class="x" data-rm="${i}" aria-label="remove ${esc(n)}">×</button></div>`).join('')}<div class="addrow"><input id="newmember" placeholder="Name" autocomplete="off" maxlength="40" ${S.busy ? 'disabled' : ''}><button type="button" class="ghost" id="addchip" ${S.busy ? 'disabled' : ''}>add</button></div></div>
      <div id="ts"></div>
      <div class="actions"><button type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="busy">${esc(S.busy)}</span>` : 'Create trip'}</button></div>
    </form>
    ${rec.length ? `<h2>Recent</h2><div class="list">${rec.map((t) => `<div><a href="/t/${esc(t.code)}" data-link>${esc(t.name)}</a><span class="code">${esc(t.code)}</span></div>`).join('')}</div>` : ''}
    </div>
  `;
}

function bindLanding() {
  const form = root.querySelector('#new');
  const input = root.querySelector('#newmember');
  // Keep typed name/currency/members across re-renders and failed submits.
  const keep = () => {
    const f = new FormData(form);
    S.form = { name: String(f.get('name') || ''), currency: String(f.get('currency') || ''), members: S.form?.members || [] };
  };
  // Returns true if the name was added (or empty); sets S.error and returns false on duplicate or cap.
  const addName = () => {
    const name = input.value.trim();
    if (!name) return true;
    const list = S.form.members;
    if (list.some((n) => n.toLowerCase() === name.toLowerCase())) { S.error = `${name} is already added`; return false; }
    if (list.length >= 50) { S.error = 'At most 50 members'; return false; }
    list.push(name); input.value = ''; return true;
  };
  const add = async () => {
    if (S.busy) return;
    keep(); S.error = '';
    if (!addName()) { render(); return; }
    await render();
    root.querySelector('#newmember')?.focus();
  };
  keep();
  root.querySelector('#addchip').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  root.querySelector('#mlist').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-rm]'); if (!b || S.busy) return;
    keep(); S.error = ''; S.form.members.splice(Number(b.dataset.rm), 1);
    await render();
    root.querySelector('#newmember')?.focus();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (S.busy) return;
    keep(); S.error = '';
    if (!addName()) { render(); return; } // typed-but-not-added name counts
    if (S.form.members.length < 2) { S.error = 'Add at least two members'; render(); return; }
    const token = takeTs();
    if (token === null) { S.error = tsMsg(); render(); return; }
    const body = { name: S.form.name, currency: S.form.currency, members: S.form.members };
    if (token) body.turnstileToken = token;
    S.busy = 'Creating'; render();
    try {
      const { code } = await api.createTrip(body);
      S.busy = ''; S.trip = null; S.form = null;
      if (window.turnstile && S.tsWidget != null) { try { window.turnstile.reset(S.tsWidget); } catch { /* ignore */ } }
      go(`/t/${code}`);
    } catch (err) { S.busy = ''; S.error = err.message; render(); }
  });
  renderTs();
}

function notFound() {
  return `<h1>No such trip</h1><p>Check the link, or <a href="/" data-link>start a new trip</a>.</p>`;
}

// ---------- home ----------
function home() {
  const t = S.trip;
  const net = balances(t);
  const direct = S.payMode === 'direct';
  const st = tripStats(t);
  const settled = t.bills.length > 0 && t.members.every((m) => !net[m.id]);
  const transfers = settled ? [] : direct ? pairwiseDebts(t) : settleUp(net);
  const bills = [...t.bills].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const tile = (label, key, to, sub) => `<div class="tile"><span class="lbl">${esc(label)}</span><span class="num val" data-key="${esc(key)}" data-to="${esc(to)}"></span>${sub == null ? '' : `<span class="sub">${esc(sub)}</span>`}</div>`;
  return `
    <div class="spread">
      <div><h1>${esc(t.name)}</h1><span class="code">${esc(t.code)} · ${esc(t.currency)}</span></div>
      <button class="ghost" id="copy">copy link</button>
    </div>
    ${errBox()}
    ${S.busy ? `<div class="busy">${esc(S.busy)}</div>` : ''}
    <h2>Members</h2>
    <div class="list" id="members">
      ${t.members.map((m) => { const v = net[m.id]; return `<div><span class="name" data-rename="${esc(m.id)}" tabindex="0" role="button" aria-label="${esc(`rename ${m.name}`)}">${esc(m.name)}</span><span class="num badge ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v ? esc((v > 0 ? '+' : '') + fmt(v)) : ''}</span></div>`; }).join('')}
      <div class="addrow"><input id="addmember" placeholder="Name" maxlength="40" autocomplete="off" value="${esc(S.memberDraft)}" ${S.busy ? 'disabled' : ''} aria-label="add member"><button class="ghost" id="addmemberbtn" ${S.busy ? 'disabled' : ''}>add</button></div>
    </div>
    <h2>Stats</h2>
    <div class="tiles">
      ${tile('Total spent', 'st-total', st.total)}
      ${tile('Avg per person', 'st-head', st.perHead)}
      ${tile('Biggest bill', 'st-big', st.biggest ? st.biggest.amount : 0, st.biggest ? st.biggest.title : '—')}
      ${tile('Highest spender', 'st-paid', st.paidMost ? st.paidMost.amount : 0, st.paidMost ? nameOf(st.paidMost.memberId) : '—')}
    </div>
    <section${settled ? ' class="starfield" id="settled"' : ''}>
      <div class="spread"><h2>Who pays whom</h2><div class="seg small">${['simplified', 'direct'].map((k) => `<button type="button" data-pay="${k}" class="ghost small ${S.payMode === k ? 'on' : ''}" aria-pressed="${S.payMode === k}">${k}</button>`).join('')}</div></div>
      ${transfers.length
        ? `<div class="list stagger">${transfers.map((x, i) => `<div style="--i:${i}"><span>${esc(nameOf(x.from))}<span class="arrow"></span><span class="sr">&nbsp;pays&nbsp;</span>${esc(nameOf(x.to))}</span><span class="num" data-key="${esc(`tr-${x.from}-${x.to}`)}" data-to="${x.amount}"></span></div>`).join('')}</div>`
        : '<p>Everyone is square.</p>'}
    </section>
    <h2>Bills</h2>
    ${bills.length ? `<table>
      <thead><tr><th>Bill</th><th>Paid by</th><th class="num">Total</th></tr></thead>
      <tbody class="stagger">${bills.map((b, i) => { const bt = billTotals(b, t.members, t.currency); const shares = t.members.map((m) => `${esc(m.name)} ${esc(fmt(bt.perMember[m.id]))}`).join(' · '); return `<tr class="link" style="--i:${i}" data-bill="${esc(b.id)}"><td><a href="/t/${esc(t.code)}/bill/${esc(b.id)}" data-link>${esc(b.title)}</a>${b.imageKey ? ' <span class="dim">▣</span>' : ''}<span class="shares">${shares}</span></td><td class="dim">${esc(nameOf(b.payerId))}</td><td class="num">${fmt(bt.total)}</td></tr>`; }).join('')}</tbody>
    </table>` : '<p>No bills yet.</p>'}
    <div class="actions">
      <button id="addbill">+ bill from photo</button>
      <button class="ghost" id="addexp">+ expense</button>
    </div>
  `;
}

// Swap a member's name for an input. Enter and blur save, Esc cancels.
function startRename(span) {
  if (S.busy) return;
  const id = span.dataset.rename, m = S.trip.members.find((x) => x.id === id);
  if (!m) return;
  const inp = document.createElement('input');
  inp.className = 'rename'; inp.maxLength = 40; inp.value = m.name; inp.setAttribute('aria-label', `rename ${m.name}`);
  let done = false;
  const finish = (save, kbd) => {
    if (done) return; done = true;
    if (kbd) S.focusRename = id;
    const name = inp.value.trim();
    if (!save || !name || name === m.name) { render(); return; }
    const trip = structuredClone(S.trip);
    trip.members.find((x) => x.id === id).name = name;
    persist(trip);
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false, true); }
  });
  inp.addEventListener('blur', () => finish(true));
  span.replaceWith(inp); inp.focus(); inp.select();
}

function bindHome() {
  countIn('[data-key]');
  const code = S.trip.code;
  root.querySelector('#copy').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // currentTarget is null after the await
    try {
      await navigator.clipboard.writeText(location.origin + `/t/${code}`);
      btn.classList.add('swap');
      setTimeout(() => { btn.textContent = 'copied'; btn.classList.remove('swap'); }, 150);
      setTimeout(() => { btn.classList.add('swap'); setTimeout(() => { btn.textContent = 'copy link'; btn.classList.remove('swap'); }, 150); }, 1200);
    }
    catch { S.error = 'Could not copy. The link is in the address bar.'; render(); }
  });
  root.querySelector('#addbill').addEventListener('click', () => go(`/t/${code}/add`));
  root.querySelector('#addexp').addEventListener('click', () => go(`/t/${code}/expense`));
  // On touch, fx's capture handler swallows the first tap (it opens the shares); the second tap reaches this handler.
  root.querySelectorAll('tr[data-bill]').forEach((tr) => {
    tr.addEventListener('click', (e) => { if (!e.target.closest('a')) go(`/t/${code}/bill/${tr.dataset.bill}`); });
    S.fx.push(revealRow(tr));
  });
  root.querySelectorAll('[data-pay]').forEach((btn) => btn.addEventListener('click', () => {
    if (S.busy || S.payMode === btn.dataset.pay) return;
    S.payMode = btn.dataset.pay === 'direct' ? 'direct' : 'simplified'; setPayMode(S.payMode); render();
  }));
  const settled = root.querySelector('#settled');
  if (settled) S.fx.push(shootingStars(settled));

  root.querySelectorAll('.name[data-rename]').forEach((span) => {
    span.addEventListener('click', () => startRename(span));
    span.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startRename(span); } });
  });
  if (S.focusRename) { const id = S.focusRename; S.focusRename = null; const el = [...root.querySelectorAll('[data-rename]')].find((x) => x.dataset.rename === id); if (el) el.focus(); }
  const addInput = root.querySelector('#addmember');
  const addMember = () => {
    if (S.busy) return;
    const name = addInput.value.trim();
    if (!name) return;
    S.memberDraft = name;
    if (S.trip.members.length >= 50) { S.error = 'At most 50 members'; render(); return; }
    const trip = structuredClone(S.trip);
    trip.members.push({ id: uid(), name });
    persist(trip);
  };
  addInput.addEventListener('input', () => { S.memberDraft = addInput.value; });
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addMember(); } });
  root.querySelector('#addmemberbtn').addEventListener('click', addMember);
}

// ---------- expense ----------
function expenseForm() {
  const t = S.trip;
  const x = S.exp || {};
  const payer = x.payer || lastPayer() || t.members[0].id;
  const mode = S.expSplit.mode;
  const selected = t.members.map((m) => m.id).filter((id) => !x.forIds || x.forIds.includes(id));
  return `
    <h1>Add expense</h1>
    <p>Cabs, tickets, groceries. No photo.</p>
    ${errBox()}
    <form id="exp">
      <label>What</label><input name="title" required maxlength="200" placeholder="Airport cab" autocomplete="off" value="${esc(x.title)}">
      <label>Amount (${esc(t.currency)})</label><input name="amount" required inputmode="decimal" placeholder="0" value="${esc(x.amount)}">
      <label>Paid by</label>
      <select name="payer">${t.members.map((m) => `<option value="${esc(m.id)}" ${m.id === payer ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <label>For</label>
      <div class="chips">${t.members.map((m) => `<label class="chip" style="margin:0"><input type="checkbox" name="for" value="${esc(m.id)}" ${!x.forIds || x.forIds.includes(m.id) ? 'checked' : ''} style="width:auto"> ${esc(m.name)}</label>`).join('')}</div>
      <label>Split</label>
      <div class="seg" id="expmode">${[['equal', 'equally'], ['percent', 'by %'], ['amount', 'by amount']].map(([k, l]) => `<button type="button" data-mode="${esc(k)}" class="ghost ${mode === k ? 'on' : ''}" aria-pressed="${mode === k}">${l}</button>`).join('')}</div>
      ${splitControls({ mode, members: t.members, byMember: S.expSplit.byMember, selected, subtotal: toMinor(parseDec(x.amount ?? ''), t.currency) })}
      <div class="actions">
        <button type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="busy">${esc(S.busy)}</span>` : 'Save'}</button>
        <a href="/t/${esc(t.code)}" data-link class="ghost" style="padding:8px 10px">cancel</a>
      </div>
    </form>`;
}

function bindExpense() {
  const form = root.querySelector('#exp'), sp = S.expSplit;
  const checked = () => [...form.querySelectorAll('input[name="for"]:checked')].map((i) => i.value);
  // Capture the typed values so a re-render (mode switch, unchecking a person) does not lose them.
  const keep = () => {
    const f = new FormData(form);
    S.exp = { title: String(f.get('title')), amount: String(f.get('amount')), payer: String(f.get('payer')), forIds: f.getAll('for').map(String) };
  };
  const updateRemaining = () => setRemaining(remainingText(sp.mode, sp.byMember, checked(), toMinor(parseDec(form.elements.amount.value), S.trip.currency)));
  form.querySelectorAll('#expmode button[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
    if (S.busy || sp.mode === btn.dataset.mode) return;
    keep(); sp.mode = btn.dataset.mode; sp.byMember = {}; // percents and amounts are not interchangeable
    render();
  }));
  form.querySelectorAll('input[name="for"]').forEach((cb) => cb.addEventListener('change', () => { if (sp.mode === 'equal') return; keep(); render(); }));
  form.elements.amount.addEventListener('input', updateRemaining);
  bindSplitControls({ mode: sp.mode, by: sp.byMember, onChange: updateRemaining });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (S.busy) return;
    keep();
    const f = new FormData(e.target);
    const amount = parseDec(f.get('amount'));
    const forIds = S.exp.forIds, payerId = S.exp.payer;
    if (!(amount > 0)) { S.error = 'Amount must be more than zero'; render(); return; }
    if (!forIds.length) { S.error = 'Pick at least one person'; render(); return; }
    // percent and amount modes save the checked members' values only; unchecked members are absent, which baseShares treats as 0.
    const byMember = Object.fromEntries(forIds.map((id) => [id, Number(sp.byMember[id]) || 0]));
    if (sp.mode === 'percent' && Math.abs(forIds.reduce((s, id) => s + byMember[id], 0) - 100) > 0.05 + 1e-9) { S.error = 'Percentages must add up to 100'; render(); return; }
    if (sp.mode === 'amount' && forIds.reduce((s, id) => s + toMinor(byMember[id], S.trip.currency), 0) !== toMinor(amount, S.trip.currency)) { S.error = `Amounts must add up to ${fmt(toMinor(amount, S.trip.currency))}`; render(); return; }
    setLastPayer(payerId);
    const title = String(f.get('title')).trim();
    const bill = {
      id: uid(), title, payerId, createdAt: new Date().toISOString(), kind: 'expense',
      items: [{ id: uid(), name: title.slice(0, 100), price: amount, shares: sp.mode === 'equal' ? Object.fromEntries(forIds.map((id) => [id, 1])) : {} }],
      tax: 0, tip: 0, instruction: '',
    };
    if (sp.mode !== 'equal') bill.split = { mode: sp.mode, byMember };
    const trip = structuredClone(S.trip);
    trip.bills.unshift(bill);
    persist(trip, `/t/${trip.code}`);
  });
}

// ---------- grid ----------
// "1,5" -> 1.5; with both separators the last one is the decimal point and the other is a thousands separator.
const parseDec = (v) => {
  let s = String(v).trim();
  const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (s.includes('.') && s.includes(',')) s = `${s.slice(0, last).replace(/[.,]/g, '')}.${s.slice(last + 1)}`;
  else s = s.replace(',', '.');
  return Number(s) || 0;
};
// Mirror the server's clamps: parse, clamp, and rewrite the field only if the value was clamped.
function clamped(inp, min, max = Infinity) {
  const raw = parseDec(inp.value), v = Math.min(max, Math.max(min, raw));
  if (v !== raw) inp.value = String(v);
  return v;
}
const symbol = () => new Intl.NumberFormat('en', { style: 'currency', currency: S.trip.currency }).formatToParts(0).find((p) => p.type === 'currency')?.value || S.trip.currency;
// Shared by the expense form and the grid. Rows for `selected` members: preset buttons (percent only) and a value input.
// byMember is in major units (percent: 0..100). `subtotal` is minor units, used for the initial remaining line.
function splitControls({ mode, members, byMember, selected, subtotal }) {
  if (mode !== 'percent' && mode !== 'amount') return '';
  const rows = members.filter((m) => selected.includes(m.id)).map((m) => `<div class="splitrow" data-m="${esc(m.id)}"><span>${esc(m.name)}</span><span class="num row">
    ${mode === 'percent' ? [25, 50, 75].map((p) => `<button type="button" class="ghost small preset" data-p="${p}">${p}</button>`).join('') : ''}
    <input class="num by" data-m="${esc(m.id)}" inputmode="decimal" value="${esc(byMember[m.id] ?? '')}" style="width:9ch" aria-label="${esc(`${mode === 'percent' ? 'percent' : 'amount'} for ${m.name}`)}"> ${mode === 'percent' ? '%' : esc(symbol())}</span></div>`).join('');
  const rem = remainingText(mode, byMember, selected, subtotal);
  return `<div class="list">${rows}</div><div class="dim${rem ? ' warn-text' : ''}" id="remaining">${esc(rem)}</div>`;
}
// Empty when the split is complete. Percent mode compares against 100, amount mode against `subtotalMinor`.
function remainingText(mode, byMember, selected, subtotalMinor) {
  if (mode === 'percent') {
    const sum = selected.reduce((s, id) => s + (Number(byMember[id]) || 0), 0), r = Math.round((100 - sum) * 100) / 100;
    return Math.abs(100 - sum) <= 0.05 + 1e-9 ? '' : `Remaining: ${r}%`;
  }
  if (mode === 'amount') {
    const r = subtotalMinor - selected.reduce((s, id) => s + toMinor(byMember[id], S.trip.currency), 0);
    return r === 0 ? '' : `Remaining: ${fmt(r)}`;
  }
  return '';
}
function setRemaining(text) {
  const el = root.querySelector('#remaining'); if (!el) return;
  el.textContent = text; el.classList.toggle('warn-text', !!text);
}
// Presets and inputs write into `by` (the live byMember object) with the same clamps as the server, then call onChange.
function bindSplitControls({ mode, by, onChange }) {
  root.querySelectorAll('input.by').forEach((inp) => inp.addEventListener('input', () => {
    by[inp.dataset.m] = mode === 'percent' ? clamped(inp, 0, 100) : clamped(inp, 0);
    onChange();
  }));
  root.querySelectorAll('button.preset').forEach((btn) => btn.addEventListener('click', () => {
    if (S.busy) return;
    const id = btn.closest('.splitrow').dataset.m;
    by[id] = Number(btn.dataset.p);
    btn.closest('.splitrow').querySelector('input.by').value = String(by[id]);
    onChange();
  }));
}
// Plain text (callers escape or use textContent). Empty when nothing is unassigned.
function unassignedText(tot) {
  if (!tot.unassigned) return '';
  const b = S.editing, ms = S.trip.members;
  const payer = nameOf(ms.some((m) => m.id === b.payerId) ? b.payerId : ms[0].id);
  return `${fmt(Math.abs(tot.unassigned))} ${tot.unassigned > 0 ? 'unassigned, charged to' : 'over-assigned, credited to'} ${payer}`;
}

function grid() {
  const t = S.trip, b = S.editing, ms = t.members;
  const tot = billTotals(b, ms, t.currency);
  const mode = ['percent', 'amount'].includes(b.split?.mode) ? b.split.mode : 'items';
  const by = b.split?.byMember || {};
  const taxMode = b.taxMode === 'equal' ? 'equal' : 'prorate';
  const rows = b.items.map((it, idx) => {
    const explicit = Object.values(it.shares || {}).some((w) => Number(w) > 0);
    return `<tr data-idx="${idx}" style="--i:${idx}">
      <td class="cell"><input class="cell" data-f="name" maxlength="100" value="${esc(it.name)}" aria-label="item name">${it.check ? ' <span class="dim chk" title="qty × rate did not match the printed amount">?</span>' : ''}</td>
      <td class="cell num"><input class="cell num" data-f="price" inputmode="decimal" value="${esc(it.price)}" aria-label="price"></td>
      ${mode === 'items' ? ms.map((m) => {
        const w = Number(it.shares?.[m.id] || 0);
        const on = w > 0 || !explicit;
        return `<td class="tog"><button type="button" class="w ${on ? 'on' : ''} ${!explicit ? 'auto' : ''}" data-m="${esc(m.id)}" aria-label="${esc(m.name)}"><span class="dot">${w > 1 ? w : on ? '●' : ''}</span></button></td>`;
      }).join('') : ''}
      <td><button type="button" class="x" data-del aria-label="remove row">×</button></td>
    </tr>`;
  }).join('');
  const un = unassignedText(tot);

  return `
    <fieldset ${S.busy ? 'disabled' : ''} style="border:0;padding:0;margin:0;min-width:0">
    <div class="spread">
      <div>
        <input id="title" maxlength="200" value="${esc(b.title)}" aria-label="bill title" style="font-weight:700;font-size:18px;border-color:transparent;padding:0 2px;max-width:60vw">
        <div class="code">${S.isDraft ? 'unsaved draft' : 'saved bill'}${b.kind === 'receipt' ? ' · from photo' : ''}</div>
      </div>
      <select id="payer" aria-label="paid by">${ms.map((m) => `<option value="${esc(m.id)}" ${m.id === b.payerId ? 'selected' : ''}>${esc(m.name)} paid</option>`).join('')}</select>
    </div>
    ${errBox()}${warnBox()}
    ${b.needsReview ? '<div class="warn">Items don\'t add up to the receipt total, check the rows.</div>' : ''}
    ${S.undo && Date.now() < S.undo.until ? `<div class="warn" id="undobar">Removed ${esc(S.undo.item.name || 'row')}. <button type="button" class="ghost small" id="undo">undo</button></div>` : ''}
    <h2>Items${mode === 'items' ? ' <span class="dim">· tap a dot to toggle, hold to set 2×, 3×</span>' : ''}</h2>
    <div class="gridwrap"><table class="grid">
      <thead><tr><th class="cell">Item</th><th class="cell num">Price</th>${mode === 'items' ? ms.map((m) => `<th class="tog" title="${esc(m.name)}">${esc((() => { const cs = Array.from(m.name); return cs.length > 8 ? cs.slice(0, 7).join('') + '…' : m.name; })())}</th>`).join('') : ''}<th></th></tr></thead>
      <tbody id="rows" class="${S.gridShown ? '' : 'stagger'}">${rows}</tbody>
    </table></div>
    <div class="actions"><button type="button" class="ghost" id="addrow">+ row</button></div>
    <div class="list totals">
      <div><span>Subtotal</span><span class="num" id="subtotal" data-key="sub" data-to="${tot.subtotal}"></span></div>
      <div><span>Tax <button type="button" class="ghost small" id="taxmode">${taxMode === 'prorate' ? 'prorated' : 'equal'}</button></span><span class="num"><input id="tax" inputmode="decimal" value="${esc(b.tax || 0)}" class="num" style="width:10ch" aria-label="tax"></span></div>
      <div><span>Tip</span><span class="num"><input id="tip" inputmode="decimal" value="${esc(b.tip || 0)}" class="num" style="width:10ch" aria-label="tip"></span></div>
      <div><span>Discount</span><span class="num"><input id="discount" inputmode="decimal" value="${esc(b.discount || 0)}" class="num" style="width:10ch" aria-label="discount"></span></div>
      <div><span>Round-off</span><span class="num"><input id="roundoff" inputmode="text" pattern="-?[0-9]*[.,]?[0-9]*" value="${esc(b.roundOff || 0)}" class="num" style="width:10ch" aria-label="round-off"></span></div>
      <div><span><b>Total</b></span><span class="num" id="total" data-key="tot" data-to="${tot.total}" style="font-weight:700"></span></div>
    </div>
    <div class="spread"><h2>Each person owes</h2><div class="seg small" id="mode">${[['items', 'by item'], ['percent', 'by %'], ['amount', 'by amount']].map(([k, l]) => `<button type="button" data-mode="${esc(k)}" class="ghost small ${mode === k ? 'on' : ''}" aria-pressed="${mode === k}">${l}</button>`).join('')}</div></div>
    ${splitControls({ mode, members: ms, byMember: by, selected: ms.map((m) => m.id), subtotal: tot.subtotal })}
    ${mode === 'amount' ? `<div class="warn" id="unassigned" ${un ? '' : 'hidden'}>${esc(un)}</div>` : ''}
    <div class="list">${ms.map((m) => `<div><span>${esc(m.name)}</span><span class="num" data-total="${esc(m.id)}" data-key="${esc(`pm-${m.id}`)}" data-to="${tot.perMember[m.id]}"></span></div>`).join('')}</div>
    <h2>Adjust in plain words</h2>
    <textarea id="instr" placeholder="e.g. Priya had the tiramisu too, Sam is veg">
${esc(S.instrText)}</textarea>
    <div class="actions"><button type="button" class="ghost" id="apply" ${S.busy ? 'disabled' : ''}>${S.busy === 'Applying' ? '<span class="busy">Applying</span>' : 'apply'}</button>
      ${b.instruction ? `<span class="dim">last: “${esc(b.instruction)}”</span>` : ''}</div>
    ${b.imageKey ? `<h2>Receipt</h2><div class="receipt"><button type="button" class="ghost" id="toggleimg">${S.showReceipt ? 'hide photo' : 'view photo'}</button>
      ${S.showReceipt ? `<div><img id="rimg" src="${esc(api.imageUrl(t.code, b.id))}" alt="receipt"><p id="rimg-missing" hidden>Photo expired or missing.</p></div>` : ''}</div>` : ''}
    <div class="actions">
      <button type="button" id="save" ${S.busy ? 'disabled' : ''}>${S.busy === 'Saving' ? '<span class="busy">Saving</span>' : S.isDraft ? 'Save bill' : 'Save changes'}</button>
      <a href="/t/${esc(t.code)}" data-link class="ghost" style="padding:8px 10px">${S.isDraft ? 'discard' : 'back'}</a>
      ${!S.isDraft ? `<button type="button" class="danger" id="del" ${S.busy ? 'disabled' : ''}>${S.confirmDelete ? 'tap again to delete' : 'delete bill'}</button>` : ''}
    </div>
    </fieldset>`;
}

function updateTotals() {
  const t = S.trip, b = S.editing;
  const tot = billTotals(b, t.members, t.currency);
  roll(root.querySelector('#subtotal'), tot.subtotal);
  roll(root.querySelector('#total'), tot.total);
  shown.set('sub', tot.subtotal); shown.set('tot', tot.total);
  root.querySelectorAll('[data-total]').forEach((el) => {
    roll(el, tot.perMember[el.dataset.total]);
    shown.set(`pm-${el.dataset.total}`, tot.perMember[el.dataset.total]);
  });
  const un = root.querySelector('#unassigned');
  if (un) { const text = unassignedText(tot); un.textContent = text; un.hidden = !text; }
  const sp = b.split;
  if (sp && sp.mode !== 'items') setRemaining(remainingText(sp.mode, sp.byMember || {}, t.members.map((m) => m.id), tot.subtotal));
}

// Update one row's dots in place (the buttons are never replaced, so the long-press click lands on the same button),
// pop only the cell popCell names, then refresh totals.
function patchRow(idx) {
  const item = S.editing.items[idx];
  const tr = root.querySelector(`#rows tr[data-idx="${idx}"]`);
  if (!item || !tr) return;
  const explicit = Object.values(item.shares || {}).some((w) => Number(w) > 0);
  for (const btn of tr.querySelectorAll('button.w')) {
    const w = Number(item.shares?.[btn.dataset.m] || 0), on = w > 0 || !explicit;
    btn.classList.toggle('on', on); btn.classList.toggle('auto', !explicit);
    btn.querySelector('.dot').textContent = w > 1 ? w : on ? '●' : '';
    btn.classList.remove('pop');
    if (on && popCell && popCell.idx === idx && popCell.m === btn.dataset.m) { void btn.offsetWidth; btn.classList.add('pop'); }
  }
  popCell = null;
  updateTotals();
}

function bindGrid() {
  countIn('[data-key]');
  S.gridShown = true; popCell = null;
  const b = S.editing;
  const split = () => (b.split ||= { mode: 'items', byMember: {} });
  root.querySelector('#title').addEventListener('input', (e) => { b.title = e.target.value; });
  root.querySelector('#payer').addEventListener('change', (e) => { b.payerId = e.target.value; setLastPayer(b.payerId); updateTotals(); });
  root.querySelector('#tax').addEventListener('input', (e) => { b.tax = clamped(e.target, 0, 1e9); updateTotals(); });
  root.querySelector('#tip').addEventListener('input', (e) => { b.tip = clamped(e.target, 0, 1e9); updateTotals(); });
  root.querySelector('#discount').addEventListener('input', (e) => { b.discount = clamped(e.target, 0, 1e9); updateTotals(); });
  root.querySelector('#roundoff').addEventListener('input', (e) => { b.roundOff = clamped(e.target, -100, 100); updateTotals(); });
  root.querySelector('#taxmode').addEventListener('click', (e) => {
    if (S.busy) return;
    b.taxMode = b.taxMode === 'equal' ? 'prorate' : 'equal';
    e.currentTarget.textContent = b.taxMode === 'prorate' ? 'prorated' : 'equal';
    updateTotals();
  });
  root.querySelectorAll('#mode button[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
    if (S.busy) return;
    if (split().mode === btn.dataset.mode) return;
    split().mode = btn.dataset.mode; b.split.byMember = {}; // amounts and percents are not interchangeable
    render();
  }));
  if (b.split && b.split.mode !== 'items') bindSplitControls({ mode: b.split.mode, by: (b.split.byMember ||= {}), onChange: updateTotals });
  root.querySelector('#instr').addEventListener('input', (e) => { S.instrText = e.target.value; });
  root.querySelector('#undo')?.addEventListener('click', () => {
    if (S.busy || !S.undo) return;
    b.items.splice(S.undo.idx, 0, S.undo.item); S.undo = null; render();
  });

  const rows = root.querySelector('#rows');
  rows.addEventListener('input', (e) => {
    const inp = e.target.closest('input.cell'); if (!inp) return;
    const idx = Number(inp.closest('tr').dataset.idx);
    if (inp.dataset.f === 'price') {
      b.items[idx].price = clamped(inp, 0, 1e9);
      delete b.items[idx].check; inp.closest('tr').querySelector('.chk')?.remove();
    }
    else b.items[idx].name = inp.value;
    updateTotals();
  });

  // tap toggles, long-press cycles weight
  rows.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('button.w'); if (!btn) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      const idx = Number(btn.closest('tr').dataset.idx);
      const item = b.items[idx];
      if (!item) return;
      const explicit = item.shares && Object.values(item.shares).some((w) => Number(w) > 0);
      if (!explicit) item.shares = Object.fromEntries(S.trip.members.map((m) => [m.id, 1]));
      const cur = Number(item.shares[btn.dataset.m] || 0);
      if (!(cur > 0)) return; // never turn an explicit-off cell on by long-press
      swallowClick = true;
      item.shares[btn.dataset.m] = cur >= 4 ? 1 : cur + 1;
      popCell = { idx, m: btn.dataset.m };
      patchRow(idx);
    }, 450);
  });
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  rows.addEventListener('pointerup', cancelPress);
  rows.addEventListener('pointerleave', cancelPress, true);
  rows.addEventListener('pointercancel', cancelPress);
  rows.addEventListener('contextmenu', (e) => { if (e.target.closest('button.w')) e.preventDefault(); });
  rows.addEventListener('click', (e) => {
    const del = e.target.closest('button[data-del]');
    if (del) {
      if (S.busy) return;
      const idx = Number(del.closest('tr').dataset.idx);
      const u = S.undo = { idx, item: b.items[idx], until: Date.now() + 5000 };
      b.items.splice(idx, 1);
      render();
      // Drop the bar only if this undo is still current (resetNav and a newer delete both replace S.undo).
      setTimeout(() => { if (S.undo === u) { S.undo = null; root.querySelector('#undobar')?.remove(); } }, 5100);
      return;
    }
    const btn = e.target.closest('button.w'); if (!btn) return;
    if (swallowClick) { swallowClick = false; return; } // click that follows a long-press
    const idx = Number(btn.closest('tr').dataset.idx);
    const item = b.items[idx];
    const explicit = item.shares && Object.values(item.shares).some((w) => Number(w) > 0);
    if (!explicit) item.shares = Object.fromEntries(S.trip.members.map((m) => [m.id, 1]));
    if (Number(item.shares[btn.dataset.m] || 0) > 0) delete item.shares[btn.dataset.m];
    else { item.shares[btn.dataset.m] = 1; popCell = { idx, m: btn.dataset.m }; }
    patchRow(idx);
  });

  root.querySelector('#addrow').addEventListener('click', async () => {
    b.items.push({ id: uid(), name: '', price: 0, shares: {} });
    await render();
    root.querySelector('#rows tr:last-child input[data-f="name"]')?.focus();
  });

  root.querySelector('#apply').addEventListener('click', async () => {
    if (S.busy) return;
    const text = root.querySelector('#instr').value.trim();
    if (!text) { S.error = 'Type an instruction first'; render(); return; }
    S.busy = 'Applying'; S.error = ''; S.undo = null; render();
    try {
      const { items } = await api.assign(S.trip.code, b.items, text);
      b.items = items; b.instruction = text; S.instrText = '';
      S.busy = ''; render();
    } catch (e) {
      S.busy = ''; S.error = e.message;
      render(); // S.instrText keeps the typed instruction
    }
  });

  root.querySelector('#toggleimg')?.addEventListener('click', () => { S.showReceipt = !S.showReceipt; render(); });
  root.querySelector('#rimg')?.addEventListener('error', () => { root.querySelector('#rimg').hidden = true; root.querySelector('#rimg-missing').hidden = false; });

  root.querySelector('#save').addEventListener('click', () => {
    if (S.busy) return;
    b.items = b.items.filter((it) => it.name.trim() || it.price > 0);
    if (!b.items.length) { S.error = 'A bill needs at least one item'; render(); return; }
    if (!b.title.trim()) b.title = b.kind === 'receipt' ? 'Receipt' : 'Expense';
    const trip = structuredClone(S.trip);
    const i = trip.bills.findIndex((x) => x.id === b.id);
    const clean = structuredClone(b); delete clean.warning;
    if (i >= 0) trip.bills[i] = clean; else trip.bills.unshift(clean);
    persist(trip, `/t/${trip.code}`);
  });

  root.querySelector('#del')?.addEventListener('click', async () => {
    if (S.busy) return;
    if (!S.confirmDelete) { S.confirmDelete = true; render(); return; }
    S.confirmDelete = false;
    const trip = structuredClone(S.trip);
    trip.bills = trip.bills.filter((x) => x.id !== b.id);
    await persist(trip, `/t/${trip.code}`);
    // Only drop the photo once the bill is really gone (a 409 reload keeps it).
    if (b.imageKey && !S.trip.bills.some((x) => x.id === b.id)) { try { await api.deleteImage(trip.code, b.id); } catch { /* photo may already be expired */ } }
  });
}

// ---------- add bill ----------
function addBill() {
  const t = S.trip;
  const payer = S.addPayer || lastPayer() || t.members[0].id;
  return `
    <h1>Bill from photo</h1>
    <p>Photograph the receipt. Then say how to split it, in plain words.</p>
    ${errBox()}
    ${S.busy && S.pendingImage && S.pendingUrl ? `<div class="scanwrap"><img src="${esc(S.pendingUrl)}" alt=""></div>` : ''}
    <form id="bill" novalidate>
      <fieldset ${S.busy ? 'disabled' : ''} style="border:0;padding:0;margin:0;min-width:0">
      <label>Receipt photo</label>
      <input type="file" name="image" accept="image/*">
      ${S.pendingImage ? '<p class="dim">Using the photo from your last attempt. Pick a new one to replace it.</p>' : ''}
      <label>How to split</label>
      <textarea name="instruction" placeholder="split equally">${esc(S.lastInstruction || 'split equally')}</textarea>
      <label>Paid by</label>
      <select name="payer">${t.members.map((m) => `<option value="${esc(m.id)}" ${m.id === payer ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <label>Who was there</label>
      <div class="chips">${t.members.map((m) => `<label class="chip" style="margin:0"><input type="checkbox" name="present" value="${esc(m.id)}" ${!S.addPresent || S.addPresent.includes(m.id) ? 'checked' : ''} style="width:auto"> ${esc(m.name)}</label>`).join('')}</div>
      <div id="ts"></div>
      <div class="actions">
        <button type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="busy">${esc(S.busy)}</span>` : 'Read receipt'}</button>
        <a href="/t/${esc(t.code)}" data-link class="ghost" style="padding:8px 10px">cancel</a>
      </div>
      </fieldset>
    </form>`;
}

function bindAddBill() {
  renderTs();
  const sw = root.querySelector('.scanwrap');
  if (sw) S.fx.push(orbitalRing(sw));
  root.querySelector('#bill').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (S.busy) return;
    const f = new FormData(e.target);
    const file = f.get('image');
    const instruction = String(f.get('instruction') || '').trim() || 'split equally';
    const payerId = String(f.get('payer'));
    const present = f.getAll('present').map(String);
    const code = S.trip.code;
    const visit = addSeq;
    // Abandoned (user navigated away): drop the busy flag and repaint if we are no longer on the add screen.
    const stale = () => {
      if (visit === addSeq) return false;
      S.busy = '';
      if (parseRoute().screen !== 'add') render();
      return true;
    };
    setLastPayer(payerId);
    S.lastInstruction = instruction; S.addPayer = payerId; S.addPresent = present;
    S.error = '';
    if (!present.length) { S.error = 'Pick at least one person who was there'; render(); return; }

    try {
      if (file && file.size > 0) {
        setPending(null); // a failed resize must not silently retry the old photo
        S.busy = 'Shrinking photo'; render();
        const img = await api.resizeImage(file, 1200, 0.8);
        if (stale()) return;
        setPending(img);
      }
      if (!S.pendingImage) { S.busy = ''; S.error = 'Attach a receipt photo'; render(); return; }

      const token = takeTs();
      if (token === null) { S.busy = ''; S.error = tsMsg(); render(); return; }
      S.busy = 'Reading receipt, this takes a few seconds'; render();
      const form = new FormData();
      form.append('image', S.pendingImage, 'receipt.jpg');
      form.append('instruction', instruction);
      form.append('payerId', payerId);
      present.forEach((id) => form.append('present', id));
      if (token) form.append('turnstileToken', token);
      const draft = await api.parseReceipt(code, form);
      if (stale()) return;
      S.busy = '';
      // render() clears S.draft off /draft, so set it and navigate straight away.
      S.draft = draft;
      setPending(null);
      if (window.turnstile && S.tsWidget != null) { try { window.turnstile.reset(S.tsWidget); } catch { /* ignore */ } }
      go(`/t/${code}/draft`); // the warning travels on the draft; grid() reads it from there
    } catch (err) {
      if (stale()) return;
      S.busy = '';
      S.error = err.message + (S.pendingImage ? ' Tap "Read receipt" to try again with the same photo.' : '');
      render();
    }
  });
}

// Fetch the Turnstile site key once. The first paint does not wait for it; the widget is added in place when it arrives.
// Retries with backoff; if every try fails S.config stays null and submits show an inline error (no silent captcha bypass).
async function loadConfig() {
  for (let i = 0; i < 3; i++) {
    try { S.config = await api.getConfig(); renderTs(); return; }
    catch { if (i < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** i)); }
  }
  S.configFailed = true;
}
// App-wide background: mounted once, outside #app and outside S.fx so paint()/resetNav() never tear it down.
const stopDots = dotMatrix(document.body);
loadConfig();
render();
