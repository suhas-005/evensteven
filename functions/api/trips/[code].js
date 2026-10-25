import { getTrip, putTrip, json, error, isPlainObject, readJson } from '../../../lib/store.js';
import { LIMITS, clamp, str } from '../../../lib/limits.js';

function validMembers(list) {
  if (!Array.isArray(list)) return false;
  const ids = new Set();
  for (const m of list) {
    if (!isPlainObject(m) || typeof m.id !== 'string' || !/^[0-9a-f]{8}$/.test(m.id)) return false;
    if (typeof m.name !== 'string' || !m.name.trim()) return false;
    if (ids.has(m.id)) return false;
    ids.add(m.id);
  }
  return true;
}

const MODES = new Set(['items', 'percent', 'amount']);
const TAXMODES = new Set(['prorate', 'equal']);

// Returns { bill } (allowlisted, clamped, defaults filled) or { problem } (a human sentence).
function sanitizeBill(b, ids, code) {
  if (!isPlainObject(b)) return { problem: 'Each bill must be an object' };
  if (typeof b.title !== 'string' || b.title.length > LIMITS.title) return { problem: `Bill title must be text under ${LIMITS.title} characters` };
  if (!/^[0-9a-f]{8}$/.test(String(b.id))) return { problem: 'Bill id is invalid' };
  if (!ids.includes(b.payerId)) return { problem: 'Bill payer must be a member' };
  if (b.kind !== 'receipt' && b.kind !== 'expense') return { problem: 'Bill kind must be receipt or expense' };
  if (!Array.isArray(b.items) || b.items.length > LIMITS.items) return { problem: `A bill can have at most ${LIMITS.items} items` };
  const items = [];
  for (const it of b.items) {
    if (!isPlainObject(it) || typeof it.name !== 'string' || it.name.length > LIMITS.itemName) return { problem: `Item names must be text under ${LIMITS.itemName} characters` };
    if (typeof it.id !== 'string' || !it.id) return { problem: 'Each item needs an id' };
    const price = clamp(it.price, 0, LIMITS.money);
    if (price === null) return { problem: 'Item prices must be numbers' };
    if (!isPlainObject(it.shares ?? {})) return { problem: 'Item shares must be an object' };
    const shares = {};
    for (const [k, v] of Object.entries(it.shares || {})) {
      if (!ids.includes(k)) continue;
      const w = clamp(v, 0, LIMITS.weight);
      if (w !== null && w > 0) shares[k] = w;
    }
    const out = { id: it.id.slice(0, 16), name: it.name, price, shares };
    if (it.qty !== undefined) { const q = clamp(it.qty, 1, 1000); if (q !== null) out.qty = q; }
    if (it.check === true) out.check = true;
    items.push(out);
  }
  const split = isPlainObject(b.split) ? b.split : { mode: 'items', byMember: {} };
  if (!MODES.has(split.mode)) return { problem: 'Split mode must be items, percent or amount' };
  const byMember = {};
  const hi = split.mode === 'percent' ? LIMITS.percent : LIMITS.money;
  for (const [k, v] of Object.entries(isPlainObject(split.byMember) ? split.byMember : {})) {
    if (!ids.includes(k)) continue;
    const n = clamp(v, 0, hi);
    if (n !== null) byMember[k] = n;
  }
  const taxMode = b.taxMode === undefined ? 'prorate' : b.taxMode;
  if (!TAXMODES.has(taxMode)) return { problem: 'Tax mode must be prorate or equal' };
  const bill = {
    id: b.id, title: b.title, payerId: b.payerId,
    createdAt: typeof b.createdAt === 'string' ? b.createdAt.slice(0, 40) : new Date().toISOString(),
    kind: b.kind, items,
    tax: clamp(b.tax, 0, LIMITS.money) ?? 0, tip: clamp(b.tip, 0, LIMITS.money) ?? 0,
    discount: clamp(b.discount, 0, LIMITS.money) ?? 0,
    roundOff: clamp(b.roundOff, -LIMITS.roundOff, LIMITS.roundOff) ?? 0,
    taxMode, split: { mode: split.mode, byMember },
    instruction: str(b.instruction, LIMITS.instruction),
  };
  if (b.imageKey !== undefined) {
    if (b.imageKey !== `${code}/${b.id}.jpg`) return { problem: 'Bill image key is invalid' };
    bill.imageKey = b.imageKey;
  }
  if (b.needsReview === true) bill.needsReview = true;
  return { bill };
}

export async function onRequestGet({ params, env }) {
  const trip = await getTrip(env, params.code);
  return trip ? json(trip) : error('No such trip', 404);
}

export async function onRequestPut({ request, params, env }) {
  const current = await getTrip(env, params.code);
  if (!current) return error('No such trip', 404);

  const r = await readJson(request, LIMITS.bodyPut);
  if (!r.ok) return r.response;
  const incoming = r.body;

  if (incoming.updatedAt !== current.updatedAt) {
    return json({ error: 'Someone else saved this trip.', trip: current }, 409);
  }

  if (!validMembers(incoming.members)) {
    return error('Members must be a list of people, each with a unique 8-character id and a non-empty name', 400);
  }
  if (!Array.isArray(incoming.bills)) return error('Bills must be a list', 400);
  if (incoming.members.length > LIMITS.members) return error(`A trip can have at most ${LIMITS.members} members`, 400);
  if (incoming.bills.length > LIMITS.bills) return error(`A trip can have at most ${LIMITS.bills} bills`, 400);
  if (incoming.members.some((m) => m.name.trim().length > LIMITS.memberName)) {
    return error(`Member names must be at most ${LIMITS.memberName} characters`, 400);
  }
  const members = incoming.members.map((m) => ({ id: m.id, name: m.name.trim() }));
  const ids = members.map((m) => m.id);
  const bills = [];
  for (const b of incoming.bills) {
    const { bill, problem } = sanitizeBill(b, ids, params.code);
    if (problem) return error(problem, 400);
    bills.push(bill);
  }
  const name = str(incoming.name, LIMITS.tripName) || current.name;

  // Members may be added or renamed, never removed.
  for (const m of current.members) {
    if (!members.some((x) => x.id === m.id)) return error('Members cannot be removed', 400);
  }

  const trip = { ...current, name, members, bills };
  return json(await putTrip(env, trip));
}
