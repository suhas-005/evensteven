import { getTrip, newId, json, error } from '../../../../lib/store.js';
import { readReceipt, assignShares } from '../../../../lib/ai.js';
import { applyRules } from '../../../../lib/rules.js';
import { LIMITS, str, contentLengthProblem } from '../../../../lib/limits.js';
import { takeBoth } from '../../../../lib/caps.js';
import { verifyTurnstile } from '../../../../lib/turnstile.js';

const PHOTO_TTL = 30 * 24 * 60 * 60;

const hasShares = (it) => Object.values(it.shares || {}).some((w) => Number(w) > 0);

export async function onRequestPost({ request, params, env }) {
  if (env.AI_DISABLED === '1') return error('Receipt reading is paused', 503);

  const problem = contentLengthProblem(request, LIMITS.bodyParse);
  if (problem) return error(problem, problem.includes('too large') ? 413 : 411);

  const trip = await getTrip(env, params.code);
  if (!trip) return error('No such trip', 404);

  let form;
  try { form = await request.formData(); } catch { return error('Expected multipart form data', 400); }

  const captcha = await verifyTurnstile(env, String(form.get('turnstileToken') || ''), request.headers.get('cf-connecting-ip'));
  if (!captcha.ok) return error('Captcha failed, reload and try again', 403);

  const image = form.get('image');
  if (!(image instanceof File) || image.size === 0) return error('Attach a receipt photo', 400);

  const instruction = String(form.get('instruction') || 'split equally').trim();
  if (instruction.length > 500) return error('Keep the instruction under 500 characters', 400);

  const bytes = new Uint8Array(await image.arrayBuffer());
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return error('Photo must be a JPEG', 400);

  const payerId = trip.members.some((m) => m.id === form.get('payerId')) ? String(form.get('payerId')) : trip.members[0].id;

  const givenIds = form.getAll('present').map(String);
  const presentMembers = trip.members.filter((m) => givenIds.includes(m.id));
  const present = presentMembers.length ? presentMembers : trip.members;
  const someAbsent = present.length < trip.members.length;

  try {
    if (!(await takeBoth(env, trip.code, 'parse'))) return error('Daily limit reached, try tomorrow.', 429);
  } catch (e) {
    console.error('quota failed', e);
    return error('Receipt reading is paused, try again later', 503);
  }

  const billId = newId();
  const imageKey = `${trip.code}/${billId}.jpg`;

  let receipt;
  try { receipt = await readReceipt(env, bytes.buffer); }
  catch (e) {
    console.error('readReceipt failed', e);
    return error("Couldn't read the receipt, try a clearer photo.", 502);
  }
  if (receipt.items.length === 0) return error("Couldn't find any items on that receipt, try a clearer photo.", 502);

  let storedKey;
  try {
    await env.RECEIPTS.put(imageKey, bytes, { expirationTtl: PHOTO_TTL });
    storedKey = imageKey;
  } catch (e) {
    console.error('photo put failed', e);
  }

  let items = receipt.items.map((it) => ({ id: newId(), ...it, shares: {} }));
  const ruled = applyRules(items, present, instruction);
  items = ruled.items;

  let warning;
  if (ruled.leftover.length) {
    try { items = await assignShares(env, items, present, ruled.leftover.join(', ')); }
    catch (e) {
      console.error('assignShares failed', e);
      warning = "Couldn't apply that instruction, edit the grid by hand.";
    }
  }

  // Empty shares mean "everyone in the trip" in the split maths, so absent members need explicit shares.
  if (someAbsent) {
    const presentShares = Object.fromEntries(present.map((m) => [m.id, 1]));
    items = items.map((it) => (hasShares(it) ? it : { ...it, shares: { ...presentShares } }));
  }

  return json({
    id: billId,
    title: str(receipt.merchant, LIMITS.title) || 'Receipt',
    payerId,
    createdAt: new Date().toISOString(),
    kind: 'receipt',
    items,
    tax: receipt.tax,
    tip: receipt.tip,
    discount: receipt.discount ?? 0,
    roundOff: receipt.roundOff ?? 0,
    taxMode: 'prorate',
    split: { mode: 'items', byMember: {} },
    instruction,
    ...(storedKey ? { imageKey: storedKey } : {}),
    needsReview: receipt.needsReview,
    ...(warning ? { warning } : {}),
  });
}
