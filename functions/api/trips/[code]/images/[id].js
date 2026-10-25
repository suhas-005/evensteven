import { json, error } from '../../../../../lib/store.js';

const CODE_RE = /^[A-Z2-9]{8}$/;
const ID_RE = /^[0-9a-f]{8}$/;

// Validates route params before they become a storage key. Returns null when valid.
function badParams(p) {
  return CODE_RE.test(p.code || '') && ID_RE.test(p.id || '') ? null : error('Photo missing or expired', 404);
}

const key = (p) => `${p.code}/${p.id}.jpg`;

export async function onRequestGet({ params, env }) {
  const bad = badParams(params);
  if (bad) return bad;
  const body = await env.RECEIPTS.get(key(params), { type: 'stream' });
  if (!body) return error('Photo missing or expired', 404);
  return new Response(body, {
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' },
  });
}

export async function onRequestDelete({ params, env }) {
  const bad = badParams(params);
  if (bad) return bad;
  await env.RECEIPTS.delete(key(params));
  return json({ ok: true });
}
