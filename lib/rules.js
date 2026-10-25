const EQUAL_RE = /^(split (this |the bill |it )?equally|equal(ly)?|everyone equally|split( this)?)$/;
const SKIP_RE = /^(\S+) (?:skipped|skip|didn'?t have|did not have|didn'?t eat|did not eat|didn'?t|did not) (?:the |any )?(.+)$/;
const ONLY_RE = /^(\S+) only (?:had|ate|took) (?:the |a )?(.+)$/;
const REST_RE = /^(?:the )?(?:rest|everything else|others?|remaining)(?: items?)?(?: (?:is|are|split|shared))? equally$/;

function tokens(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}

function itemMatches(item, phrase) {
  const name = item.name.toLowerCase();
  const pt = tokens(phrase);
  if (pt.some((t) => name.includes(t))) return true;
  return tokens(name).some((t) => phrase.toLowerCase().includes(t));
}

function findMember(members, token) {
  const t = token.toLowerCase().replace(/['’]s$/, '');
  return members.find((m) => m.name.toLowerCase().startsWith(t)) || null;
}

function splitClauses(text, members) {
  const names = members.map((m) => m.name.toLowerCase().split(/\s+/)[0]).filter(Boolean);
  const andSplit = names.length ? new RegExp(`\\s+and\\s+(?=(?:${names.map((n) => n.slice(0, 3)).join('|')}))`, 'i') : null;
  let parts = text.split(/[,;.\n]+/);
  if (andSplit) parts = parts.flatMap((p) => p.split(andSplit));
  return parts.map((p) => p.trim().toLowerCase()).filter(Boolean);
}

function expand(item, ids) {
  const has = Object.values(item.shares || {}).some((w) => Number(w) > 0);
  if (!has) item.shares = Object.fromEntries(ids.map((id) => [id, 1]));
}

export function applyRules(items, members, instruction) {
  const ids = members.map((m) => m.id);
  const out = items.map((it) => ({ ...it, shares: { ...(it.shares || {}) } }));
  const clauses = splitClauses(String(instruction || ''), members);
  const leftover = [];
  const excluded = new Map(); // itemId -> Set(memberId)
  let equal = clauses.length === 0;
  let fillRest = false;
  const ops = [];

  for (const c of clauses) {
    if (EQUAL_RE.test(c)) { equal = true; continue; }
    if (REST_RE.test(c)) { fillRest = true; continue; }
    let m;
    if ((m = c.match(ONLY_RE)) && findMember(members, m[1])) { ops.push({ kind: 'only', member: findMember(members, m[1]), phrase: m[2] }); continue; }
    if ((m = c.match(SKIP_RE)) && findMember(members, m[1])) { ops.push({ kind: 'skip', member: findMember(members, m[1]), phrase: m[2] }); continue; }
    leftover.push(c);
  }

  if (equal) for (const it of out) it.shares = Object.fromEntries(ids.map((id) => [id, 1]));

  for (const op of ops.filter((o) => o.kind === 'only')) {
    for (const it of out) {
      if (itemMatches(it, op.phrase)) { expand(it, ids); it.shares[op.member.id] = it.shares[op.member.id] || 1; }
      else {
        expand(it, ids);
        delete it.shares[op.member.id];
        if (!excluded.has(it.id)) excluded.set(it.id, new Set());
        excluded.get(it.id).add(op.member.id);
      }
    }
  }

  for (const op of ops.filter((o) => o.kind === 'skip')) {
    for (const it of out) {
      if (!itemMatches(it, op.phrase)) continue;
      expand(it, ids);
      delete it.shares[op.member.id];
      if (!excluded.has(it.id)) excluded.set(it.id, new Set());
      excluded.get(it.id).add(op.member.id);
    }
  }

  if (fillRest || ops.length) {
    for (const it of out) {
      const has = Object.values(it.shares).some((w) => Number(w) > 0);
      if (has) continue;
      const ex = excluded.get(it.id) || new Set();
      it.shares = Object.fromEntries(ids.filter((id) => !ex.has(id)).map((id) => [id, 1]));
    }
  }

  return { items: out, leftover };
}
