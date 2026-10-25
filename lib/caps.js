export const QUOTAS = { parse: { trip: 30, global: 300 }, assign: { trip: 60, global: 600 } };

export function dayKey(now = new Date()) { return now.toISOString().slice(0, 10); }

export async function takeQuota(env, scope, kind, limit) {
  const key = `q:${scope}:${dayKey()}:${kind}`;
  const cur = Number((await env.TRIPS.get(key)) || 0);
  if (cur >= limit) return false;
  await env.TRIPS.put(key, String(cur + 1), { expirationTtl: 172800 });
  return true;
}

// Read both counters first; write only when both have room, so a denied request writes nothing.
export async function takeBoth(env, code, kind) {
  const day = dayKey();
  const keys = [[`q:${code}:${day}:${kind}`, QUOTAS[kind].trip], [`q:global:${day}:${kind}`, QUOTAS[kind].global]];
  const curs = await Promise.all(keys.map(([k]) => env.TRIPS.get(k).then((v) => Number(v || 0))));
  if (curs.some((c, i) => c >= keys[i][1])) return false;
  await Promise.all(keys.map(([k], i) => env.TRIPS.put(k, String(curs[i] + 1), { expirationTtl: 172800 })));
  return true;
}
