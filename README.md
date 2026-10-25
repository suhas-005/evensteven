# evensteven

Trip expense tracker with AI receipt splitting. One link per trip, no accounts.
Photograph a bill, type "split this, Rohan is veg, Priya skipped the biryani", review the grid, save.
The trip page shows who owes whom and the minimal transfers to settle.

## Stack

Cloudflare Pages + Functions + KV (trips and receipt photos, 30-day TTL) + Workers AI. Vanilla JS, no build.

## Develop

    npm install
    npx wrangler login
    npm run dev          # http://localhost:8788
    npm test             # node --test

Workers AI calls run against your account even in local dev.

## First deploy

    npm run provision                         # uses `name` from wrangler.toml
    npm run provision -- --name evenstevenapp # or pick the Pages project name
    npm run deploy

The repo ships `wrangler.example.toml` with placeholders. `wrangler.toml` holds your real KV ids, Turnstile site key and AI Gateway id and is git-ignored; `provision` creates it from the template the first time.

`provision` is idempotent: it creates only what is missing, writes the project name and KV ids into `wrangler.toml`, and prints the site's real `*.pages.dev` address (Cloudflare adds a suffix such as `-1m5` when the name is taken). KV ids already in `wrangler.toml` are reused, so changing `--name` keeps every trip.

To remove a project:

    npm run destroy -- --name OLDNAME              # deletes the Pages project only
    npm run destroy -- --name OLDNAME --with-data  # also deletes OLDNAME-TRIPS / OLDNAME-RECEIPTS

`destroy` always needs `--name`, lists what it will delete, and asks you to type the name to confirm (`--yes` skips that). It never deletes a KV namespace that `wrangler.toml` still uses.

## Notes

- Models: `VISION_MODEL` lives in `wrangler.toml` `[vars]`; `TEXT_MODEL` defaults in `lib/ai.js` (override with a var of the same name). If Cloudflare retires one, pick a replacement from the Workers AI catalogue.
- The Llama 3.2 vision model needs a one-time license acceptance on the account (send the prompt `agree` to the model once, for example from the Workers AI playground).
- Common phrases ("split equally", "X skipped Y", "X only had Y", "rest equally") are handled by `lib/rules.js` without the model. Anything else goes to the text model.
- Receipt photos expire after 30 days (KV `expirationTtl`). Item data stays.
- Members can be added and renamed, never removed. Trip creation takes member names as chips; the add-bill form has a "Who was there" checklist, and absent members start with their dots off. "Who was there" applies when the receipt is read. A later instruction in the grid such as "split equally" can include everyone again, and the payer can untick them in the grid.

## v2 setup

1. Turnstile: dashboard > Turnstile > Add widget, hostname `evenstevenapp.pages.dev` (the address `provision` prints; add any custom domain to the widget later), mode Managed. Copy the site key into `wrangler.toml` `[vars]` `TURNSTILE_SITE_KEY` and set the secret from a real terminal with `npx wrangler pages secret put TURNSTILE_SECRET --project-name evenstevenapp` (a non-interactive shell stores an empty secret, which leaves the captcha off), then redeploy. Set both together: a secret without a site key makes every create and parse return 403, because the page never shows a widget to produce a token. Until the secret is set, the server skips the captcha check and logs a warning.
2. AI Gateway: dashboard > AI > AI Gateway > Create, name `evensteven`, enable rate limiting (for example 60 requests per minute). Put the gateway id into `[vars]` `AI_GATEWAY_ID`.
3. Local dev test keys, in `.dev.vars` (gitignored): `TURNSTILE_SITE_KEY=1x00000000000000000000AA` and `TURNSTILE_SECRET=1x0000000000000000000000000000000AA`.
4. Kill switch: `AI_DISABLED` is a plain var in `wrangler.toml` `[vars]`, not a secret. To pause receipt reading, set it to `"1"` in `wrangler.toml` and redeploy; set it back to `"0"` and redeploy to resume.

## Limits

- Request bodies: `/parse` up to 1.5 MB, trip saves (`PUT`) up to 512 KB, other JSON endpoints up to 64 KB. A missing Content-Length is a 411.
- Quotas per day (UTC), counted in KV: per trip 30 parses and 60 assigns, globally 300 parses and 600 assigns. Over quota returns 429. Each model call costs 2 KV writes for the quota counters (rules-only `/assign` requests cost none). On the free plan only AI Gateway rate limiting truly protects the daily neuron budget, so provision it (v2 setup step 2).
- Cloudflare's edge sets Content-Length, so the size caps apply to the real body size.
- Text: trip name 60, member name 40, bill title 200, item name 100, instruction 500 characters. At most 50 members, 500 bills, 100 items per bill.
- Receipt photos are kept 30 days, only after the model succeeds and only as JPEG.

## Limitations

- **Stale writes.** Trips live in Workers KV, which is eventually consistent: a read in another region can lag a write by up to about 60 seconds. Saves use an `updatedAt` check (a stale save gets a 409 and reloads), but two people saving from different regions within that window can both pass the check, and one edit is lost. The app refetches the trip when you open the trip page or return to the tab, never mid-edit. A Durable Object or D1 would remove the window and is a follow-up.
- **Free-tier ceilings.** KV allows 1,000 writes per day, shared by trip saves and receipt photos. Workers AI allows 10,000 neurons per day. A busy day can exhaust either.
- **Input caps.** Instructions are limited to 500 characters, item names to 100, bills to 100 items, trips to 50 members and 500 bills.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free to use, change and share for personal and other noncommercial purposes, including by charities, schools and public institutions. Any commercial use, such as running it as part of a paid product or service, needs a separate licence from the author.

Required Notice: Copyright (c) 2026 Suhas M
