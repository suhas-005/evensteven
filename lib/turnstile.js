let warned = false;

export async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) {
    if (!warned) { console.warn('TURNSTILE_SECRET unset; captcha verification skipped'); warned = true; }
    return { ok: true, reason: 'unconfigured' };
  }
  if (!token) return { ok: false, reason: 'missing' };

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: ctl.signal });
    const data = await res.json();
    return { ok: data.success === true, reason: data['error-codes']?.join(',') };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
