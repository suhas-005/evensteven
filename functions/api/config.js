import { json } from '../../lib/store.js';

export function onRequestGet({ env }) {
  return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || '' });
}
