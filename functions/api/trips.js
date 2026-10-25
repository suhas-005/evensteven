import { newCode, newId, putTrip, json, error, readJson } from '../../lib/store.js';
import { LIMITS, str } from '../../lib/limits.js';
import { verifyTurnstile } from '../../lib/turnstile.js';

export async function onRequestPost({ request, env }) {
  const r = await readJson(request, LIMITS.bodyJson);
  if (!r.ok) return r.response;
  const body = r.body;

  const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  const captcha = await verifyTurnstile(env, token, request.headers.get('cf-connecting-ip'));
  if (!captcha.ok) return error('Captcha failed, reload and try again', 403);

  const name = str(body.name, LIMITS.tripName);
  const currency = String(body.currency || 'INR').toUpperCase();
  const names = (Array.isArray(body.members) ? body.members : []).map((s) => str(s, LIMITS.memberName)).filter(Boolean);

  if (!name) return error('Trip needs a name', 400);
  if (!/^[A-Z]{3}$/.test(currency)) return error('Currency must be a 3-letter code', 400);
  if (names.length < 2) return error('Add at least two members', 400);
  if (names.length > LIMITS.members) return error(`A trip can have at most ${LIMITS.members} members`, 400);

  let code = newCode();
  for (let i = 0; i < 5 && (await env.TRIPS.get(code)); i++) code = newCode();

  const now = new Date().toISOString();
  const trip = {
    code, name, currency, createdAt: now, updatedAt: now,
    members: names.map((n) => ({ id: newId(), name: n })),
    bills: [],
  };
  await putTrip(env, trip);
  return json({ code }, 201);
}
