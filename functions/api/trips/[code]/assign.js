import { getTrip, json, error, isPlainObject, readJson } from '../../../../lib/store.js';
import { LIMITS } from '../../../../lib/limits.js';
import { assignShares } from '../../../../lib/ai.js';
import { applyRules } from '../../../../lib/rules.js';
import { takeBoth } from '../../../../lib/caps.js';

const MAX_ITEMS = 100;
const MAX_INSTRUCTION = 500;
const MAX_NAME = 100;

export async function onRequestPost({ request, params, env }) {
  if (env.AI_DISABLED === '1') return error('Receipt reading is paused', 503);

  const trip = await getTrip(env, params.code);
  if (!trip) return error('No such trip', 404);

  const r = await readJson(request, LIMITS.bodyJson);
  if (!r.ok) return r.response;
  const body = r.body;
  if (!Array.isArray(body.items)) return error('Items must be a list', 400);
  if (typeof body.instruction !== 'string') return error('Instruction must be text', 400);

  const instruction = body.instruction.trim();
  if (!instruction) return error('Type an instruction first', 400);
  if (instruction.length > MAX_INSTRUCTION) return error(`Keep the instruction under ${MAX_INSTRUCTION} characters`, 400);
  const items = body.items;
  if (!items.length) return error('No items to assign', 400);
  if (items.length > MAX_ITEMS) return error(`A bill can have at most ${MAX_ITEMS} items`, 400);
  if (!items.every((it) => isPlainObject(it) && typeof it.name === 'string')) {
    return error('Each item must be an object with a name', 400);
  }
  if (items.some((it) => it.name.length > MAX_NAME)) return error(`Item names can be at most ${MAX_NAME} characters`, 400);

  const ruled = applyRules(items, trip.members, instruction);
  let out = ruled.items;
  if (ruled.leftover.length) {
    try {
      if (!(await takeBoth(env, trip.code, 'assign'))) return error('Daily limit reached, try tomorrow.', 429);
    } catch (e) {
      console.error('quota failed', e);
      return error('Receipt reading is paused, try again later', 503);
    }
    try { out = await assignShares(env, out, trip.members, ruled.leftover.join(', ')); }
    catch (e) {
      console.error('assignShares failed', e);
      return error("Couldn't apply that instruction, edit the grid by hand.", 502);
    }
  }
  return json({ items: out });
}
