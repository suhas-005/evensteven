const ZERO_DECIMAL = new Set(['INR', 'JPY', 'KRW', 'VND', 'IDR']);

export function decimals(currency) {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

export function toMinor(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10 ** decimals(currency));
}

export function fromMinor(minor, currency) {
  return minor / 10 ** decimals(currency);
}

export function format(minor, currency) {
  const d = decimals(currency);
  const locale = currency === 'INR' ? 'en-IN' : 'en';
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d,
  }).format(minor / 10 ** d);
}

// Per-member food shares in minor units (floats), before extras.
// `unassigned` is the amount-mode gap, charged to the payer by billTotals.
function itemBase(bill, ids, currency) {
  const food = Object.fromEntries(ids.map((id) => [id, 0]));
  let subtotal = 0;
  for (const item of bill.items || []) {
    const price = toMinor(item.price, currency);
    subtotal += price;
    const explicit = Object.entries(item.shares || {}).filter(([id, w]) => ids.includes(id) && Number(w) > 0);
    const list = explicit.length ? explicit : ids.map((id) => [id, 1]);
    const wsum = list.reduce((s, [, w]) => s + Number(w), 0);
    for (const [id, w] of list) food[id] += (price * Number(w)) / wsum;
  }
  return { food, subtotal, unassigned: 0 };
}

export function baseShares(bill, members, currency) {
  const ids = members.map((m) => m.id);
  const mode = bill.split?.mode || 'items';
  if (mode === 'items') return itemBase(bill, ids, currency);
  const subtotal = (bill.items || []).reduce((s, it) => s + toMinor(it.price, currency), 0);
  const by = bill.split?.byMember || {};
  const food = Object.fromEntries(ids.map((id) => [id, 0]));
  if (mode === 'percent') {
    const entries = ids.map((id) => [id, Math.max(0, Number(by[id]) || 0)]);
    const psum = entries.reduce((s, [, p]) => s + p, 0);
    if (psum > 0) for (const [id, p] of entries) food[id] = (subtotal * p) / psum;
    else for (const id of ids) food[id] = subtotal / ids.length;
    return { food, subtotal, unassigned: 0 };
  }
  let assigned = 0;
  for (const id of ids) { const a = Math.max(0, toMinor(by[id], currency)); food[id] = a; assigned += a; }
  return { food, subtotal, unassigned: subtotal - assigned };
}

// Returns integer minor-unit totals. Rounding remainder and roundOff go to the
// payer so the bill always sums exactly to the receipt total.
export function billTotals(bill, members, currency) {
  const ids = members.map((m) => m.id);
  const payer = ids.includes(bill.payerId) ? bill.payerId : ids[0];
  const { food, subtotal, unassigned } = baseShares(bill, members, currency);
  if (unassigned) food[payer] += unassigned;
  const tax = toMinor(bill.tax, currency), tip = toMinor(bill.tip, currency);
  const discount = toMinor(bill.discount, currency), roundOff = toMinor(bill.roundOff, currency);
  const extras = tax + tip - discount;
  // One rounding of the whole bill in major units, so it matches the printed total.
  const itemsMajor = (bill.items || []).reduce((s, it) => s + (Number(it.price) || 0), 0);
  const total = toMinor(itemsMajor + (Number(bill.tax) || 0) + (Number(bill.tip) || 0) - (Number(bill.discount) || 0) + (Number(bill.roundOff) || 0), currency);
  const participants = ids.filter((id) => food[id] > 0);
  const eq = participants.length ? participants : ids;
  const perMember = {}; let sum = 0;
  for (const id of ids) {
    let extra;
    if ((bill.taxMode || 'prorate') === 'equal') extra = eq.includes(id) ? extras / eq.length : 0;
    else extra = subtotal ? extras * (food[id] / subtotal) : extras / ids.length;
    perMember[id] = Math.round(food[id] + extra); sum += perMember[id];
  }
  perMember[payer] += total - sum;   // rounding remainder and roundOff land on the payer
  return { perMember, subtotal, tax, tip, discount, roundOff, total, unassigned };
}

export function balances(trip) {
  const net = Object.fromEntries(trip.members.map((m) => [m.id, 0]));
  for (const bill of trip.bills || []) {
    const { perMember, total } = billTotals(bill, trip.members, trip.currency);
    if (bill.payerId in net) net[bill.payerId] += total;
    for (const [id, v] of Object.entries(perMember)) net[id] -= v;
  }
  return net;
}

export function settleUp(net) {
  const debtors = Object.entries(net).filter(([, v]) => v < 0).map(([id, v]) => ({ id, amt: -v })).sort((a, b) => b.amt - a.amt);
  const creditors = Object.entries(net).filter(([, v]) => v > 0).map(([id, v]) => ({ id, amt: v })).sort((a, b) => b.amt - a.amt);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amt, creditors[j].amt);
    if (amount > 0) transfers.push({ from: debtors[i].id, to: creditors[j].id, amount });
    debtors[i].amt -= amount;
    creditors[j].amt -= amount;
    if (debtors[i].amt === 0) i++;
    if (creditors[j].amt === 0) j++;
  }
  return transfers;
}

export function pairwiseDebts(trip) {
  const owed = new Map(); // key `${from}|${to}` -> minor
  for (const bill of trip.bills || []) {
    const { perMember } = billTotals(bill, trip.members, trip.currency);
    for (const [id, v] of Object.entries(perMember)) {
      if (id === bill.payerId || v === 0) continue;
      // Negative share (discount larger than subtotal): the payer owes this member instead.
      const k = v > 0 ? `${id}|${bill.payerId}` : `${bill.payerId}|${id}`;
      owed.set(k, (owed.get(k) || 0) + Math.abs(v));
    }
  }
  const out = []; const seen = new Set();
  for (const [k, v] of owed) {
    const [a, b] = k.split('|'); const pair = [a, b].sort().join('|');
    if (seen.has(pair)) continue; seen.add(pair);
    const back = owed.get(`${b}|${a}`) || 0; const net = v - back;
    if (net > 0) out.push({ from: a, to: b, amount: net });
    else if (net < 0) out.push({ from: b, to: a, amount: -net });
  }
  return out.sort((x, y) => y.amount - x.amount || x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
}

export function tripStats(trip) {
  const bills = trip.bills || []; let total = 0; let biggest = null; const paid = {};
  for (const bill of bills) {
    const t = billTotals(bill, trip.members, trip.currency).total; total += t;
    if (!biggest || t > biggest.amount) biggest = { amount: t, title: bill.title || 'Bill' };
    paid[bill.payerId] = (paid[bill.payerId] || 0) + t;
  }
  const top = Object.entries(paid).sort((a, b) => b[1] - a[1])[0];
  return { total, perHead: trip.members.length ? Math.round(total / trip.members.length) : 0, biggest, paidMost: top ? { amount: top[1], memberId: top[0] } : null, bills: bills.length };
}
