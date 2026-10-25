import { LIMITS, clamp, str } from './limits.js';

export const DEFAULT_VISION_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
// Kept as an alias for test/endpoints.test.js, which imports the old name.
export const VISION_MODEL = DEFAULT_VISION_MODEL;
export const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const TIMEOUT_MS = 30_000;
const runOpts = (env) => (env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined);

function withTimeout(promise, ms = TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Model call timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// End index (exclusive) of the balanced {...} starting at s[start], or -1.
function balancedEnd(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

// Models wrap answers in prose, examples and stray braces. Collect every parseable object
// and return the last one that passes isAnswer (or the last parseable one without it).
export function extractJson(text, isAnswer = () => true) {
  const s = String(text ?? '');
  const found = [];
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    const end = balancedEnd(s, i);
    if (end < 0) continue;
    try { found.push(JSON.parse(s.slice(i, end))); i = end - 1; } catch { /* prose brace, try the next */ }
  }
  const hit = found.filter(isAnswer).pop();
  if (hit === undefined) throw new Error('Model returned no JSON');
  return hit;
}

const hasItems = (o) => Array.isArray(o?.items);
const hasItemsOrRows = (o) => Array.isArray(o?.rows) || hasItems(o);
const hasShareItems = (o) => hasItems(o) && o.items.every((it) => it && typeof it === 'object' && ('shares' in it || 'id' in it));

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function normalizeReceipt(raw) {
  const rows = Array.isArray(raw.rows) ? raw.rows : (Array.isArray(raw.items) ? raw.items : []);
  const items = rows.map((r) => {
    const qty = num(r.qty); const rate = num(r.rate); const amount = num(r.amount ?? r.price);
    const calc = qty !== null && rate !== null ? qty * rate : null;
    const price = clamp(amount !== null && amount > 0 ? amount : calc, 0, LIMITS.money);
    const out = { name: str(r.name, LIMITS.itemName) || 'Item', price };
    if (qty && qty > 1) out.qty = qty;
    if (amount !== null && calc !== null && Math.abs(amount - calc) > 1) out.check = true;
    return out;
  }).filter((it) => it.price !== null && it.price > 0);

  const money = (v) => clamp(v, 0, LIMITS.money) ?? 0;
  const tax = money(num(raw.tax)), tip = money(num(raw.tip));
  const discount = money(Math.abs(num(raw.discount) || 0));
  const R = LIMITS.roundOff;
  let roundOff = clamp(num(raw.roundOff) || 0, -R, R);
  const subtotal = num(raw.subtotal), total = num(raw.total);
  // Round-off is whatever closes the printed total. Derive it when both totals are printed.
  let roundUnsure = false;
  if (subtotal !== null && total !== null) {
    const derived = total - (subtotal + tax + tip - discount);
    if (Math.abs(derived) <= 1) roundOff = Math.round(derived * 100) / 100;
    else roundUnsure = true;
  }
  const sum = items.reduce((s, i) => s + i.price, 0);
  const ref = subtotal ?? (total !== null ? total - tax - tip + discount - roundOff : null);
  const needsReview = roundUnsure || ref === null || Math.abs(sum - ref) > Math.max(ref * 0.01, 1);

  return { merchant: String(raw.merchant || '').trim(), items, tax, tip, discount, roundOff, needsReview };
}

function toBase64(bytes) {
  const u = new Uint8Array(bytes); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function normalizeShares(items, members, raw) {
  const ids = new Set(members.map((m) => m.id));
  const byId = Object.fromEntries((Array.isArray(raw.items) ? raw.items : []).map((it) => [it.id, it.shares || {}]));
  return items.map((item) => {
    const src = byId[item.id];
    if (!src) return item;
    const shares = {};
    for (const [id, w] of Object.entries(src)) {
      const n = Number(w);
      if (ids.has(id) && Number.isFinite(n) && n > 0) shares[id] = Math.min(LIMITS.weight, n);
    }
    if (Object.keys(shares).length === 0) return item;
    return { ...item, shares };
  });
}

const RECEIPT_PROMPT = `You are reading a photo of a restaurant or shop receipt.
Return ONLY a JSON object, no prose, exactly shaped like:
{"merchant":"string","rows":[{"name":"string","qty":number,"rate":number,"amount":number}],"subtotal":number,"tax":number,"tip":number,"discount":number,"roundOff":number,"total":number}
Rules:
- One entry in rows per purchased line, in printed order. amount is the line total as printed; rate is the unit price; qty defaults to 1.
- Read each row's numbers from that row only. Check that qty times rate equals amount; if the printed columns are misaligned, trust the amount column.
- Sum all tax-like lines (GST, CGST, SGST, VAT, service charge) into tax. Use 0 when absent.
- discount is the total of discount lines as a positive number, 0 if none. roundOff is the printed round-off adjustment, signed, 0 if none. tip is 0 unless printed.
- Do not include subtotal, tax, discount, round-off or total lines as rows.
- Keep names short, as printed.`;

export async function readReceipt(env, imageBytes) {
  const model = env.VISION_MODEL || DEFAULT_VISION_MODEL;
  const res = await withTimeout(env.AI.run(model, {
    messages: [{ role: 'user', content: [{ type: 'text', text: RECEIPT_PROMPT }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${toBase64(imageBytes)}` } }] }],
    max_tokens: 1500,
  }, runOpts(env)));
  const text = res?.response ?? res?.description ?? JSON.stringify(res);
  return normalizeReceipt(extractJson(text, hasItemsOrRows));
}

export async function assignShares(env, items, members, instruction) {
  const slim = items.map(({ id, name, price, shares }) => ({ id, name, price, shares: shares || {} }));
  const prompt = `You split restaurant bills between friends.
Members (id -> name): ${JSON.stringify(Object.fromEntries(members.map((m) => [m.id, m.name])))}
Items with current shares. Shares are weights per member id. An empty shares object means everyone equally.
${JSON.stringify(slim)}
Instruction: "${instruction}"

Update the shares to follow the instruction. Rules:
- If a member is vegetarian or veg, give them weight 0 on items that are clearly meat, chicken, fish, seafood or egg. Leave vegetarian items unchanged for them.
- "X skipped Y" or "X didn't have Y" means X gets weight 0 on Y.
- "X had two Y" means X has weight 2 on Y.
- If you change an item whose shares are empty, first write every member with weight 1, then apply the change.
- Items the instruction does not affect keep their current shares exactly.
- Never leave an item with no members unless the instruction says nobody had it.
Return ONLY JSON shaped like {"items":[{"id":"string","shares":{"memberId":number}}]} and include every item id.`;

  const res = await withTimeout(env.AI.run(env.TEXT_MODEL || TEXT_MODEL, {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
  }, runOpts(env)));
  return normalizeShares(items, members, extractJson(res?.response, hasShareItems));
}
