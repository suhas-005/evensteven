import { contentLengthProblem } from './limits.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newCode(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

export async function getTrip(env, code) {
  if (!/^[A-Z2-9]{8}$/.test(code || '')) return null;
  return env.TRIPS.get(code, 'json');
}

export async function putTrip(env, trip) {
  trip.updatedAt = new Date().toISOString();
  await env.TRIPS.put(trip.code, JSON.stringify(trip));
  return trip;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
  });
}

export function error(message, status) {
  return json({ error: message }, status);
}

export async function readJson(request, max) {
  const problem = contentLengthProblem(request, max);
  if (problem) return { ok: false, response: error(problem, problem.includes('too large') ? 413 : 411) };
  try {
    const body = await request.json();
    if (!isPlainObject(body)) return { ok: false, response: error('Body must be a JSON object', 400) };
    return { ok: true, body };
  } catch {
    return { ok: false, response: error('Body must be JSON', 400) };
  }
}
