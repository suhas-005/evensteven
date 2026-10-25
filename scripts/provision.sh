#!/bin/sh
# Provision or destroy the Cloudflare resources for this app.
#
#   sh scripts/provision.sh [up] [--name NAME]
#       Idempotent: creates only what is missing. NAME defaults to `name` in wrangler.toml and is
#       written back there, so `npm run deploy` targets that Pages project.
#       KV ids already in wrangler.toml are reused when they still exist, so renaming the project
#       keeps every trip. New namespaces are titled NAME-TRIPS / NAME-RECEIPTS.
#
#   sh scripts/provision.sh destroy --name NAME [--with-data] [--yes]
#       Deletes the Pages project NAME. With --with-data, also deletes the KV namespaces titled
#       NAME-TRIPS and NAME-RECEIPTS (all trips and photos in them), except any namespace that
#       wrangler.toml still uses. Asks you to type NAME to confirm unless --yes is given.
set -eu
cd "$(dirname "$0")/.."

# wrangler.toml holds this deployment's real ids and keys and is git-ignored; the repo ships a template.
if [ ! -f wrangler.toml ]; then
  cp wrangler.example.toml wrangler.toml
  echo "created wrangler.toml from wrangler.example.toml"
fi

usage() {
  echo "usage: sh scripts/provision.sh [up] [--name NAME]" >&2
  echo "       sh scripts/provision.sh destroy --name NAME [--with-data] [--yes]" >&2
  exit 2
}

CMD=up
NAME=""
WITH_DATA=0
YES=0
case "${1:-}" in
  up|destroy) CMD=$1; shift ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --name) [ $# -ge 2 ] || usage; NAME=$2; shift 2 ;;
    --name=*) NAME=${1#--name=}; shift ;;
    --with-data) WITH_DATA=1; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

# Pages project names: lowercase letters, digits and dashes, not starting or ending with a dash.
valid_name() { printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,56}[a-z0-9])?$'; }

SUMMARY=""
note() { SUMMARY="$SUMMARY
  $1"; }

# Prints the JSON list of KV namespaces.
kv_list() { npx wrangler kv namespace list; }

# Prints the id of the KV namespace titled $1, or nothing.
kv_id() {
  kv_list | node -e '
    const t = process.argv[1];
    const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const m = list.find((n) => n.title === t);
    if (m) process.stdout.write(m.id);
  ' "$1"
}

# Exits 0 if a KV namespace with id $1 exists.
kv_exists() {
  kv_list | node -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.exit(list.some((n) => n.id === process.argv[1]) ? 0 : 1);
  ' "$1"
}

# Prints the id in wrangler.toml for binding $1, or nothing.
toml_id() {
  node -e '
    const src = require("fs").readFileSync("wrangler.toml", "utf8");
    const m = src.match(new RegExp("binding = \x22" + process.argv[1] + "\x22\\s*\\nid = \x22([^\x22]*)\x22"));
    if (m) process.stdout.write(m[1]);
  ' "$1"
}

# Sets the id of the [[kv_namespaces]] entry for binding $1 to $2.
# Prints "set" if the file changed, "same" if it already matched.
set_toml_id() {
  node -e '
    const fs = require("fs");
    const [binding, id] = process.argv.slice(1);
    const src = fs.readFileSync("wrangler.toml", "utf8");
    const re = new RegExp("(binding = \x22" + binding + "\x22\\s*\\nid = \x22)([^\x22]*)(\x22)");
    const m = src.match(re);
    if (!m) { console.error("no kv entry for " + binding); process.exit(1); }
    if (m[2] === id) { process.stdout.write("same"); process.exit(0); }
    fs.writeFileSync("wrangler.toml", src.replace(re, "$1" + id + "$3"));
    process.stdout.write("set");
  ' "$1" "$2"
}

# Prints the top-level `name` from wrangler.toml.
toml_name() {
  node -e '
    const m = require("fs").readFileSync("wrangler.toml", "utf8").match(/^name = "([^"]*)"/m);
    if (m) process.stdout.write(m[1]);
  '
}

# Sets the top-level `name` in wrangler.toml to $1. Prints "set" or "same".
set_toml_name() {
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync("wrangler.toml", "utf8");
    const m = src.match(/^name = "([^"]*)"/m);
    if (!m) { console.error("no name in wrangler.toml"); process.exit(1); }
    if (m[1] === process.argv[1]) { process.stdout.write("same"); process.exit(0); }
    fs.writeFileSync("wrangler.toml", src.replace(/^name = "[^"]*"/m, "name = \x22" + process.argv[1] + "\x22"));
    process.stdout.write("set");
  ' "$1"
}

# Prints the *.pages.dev domain of Pages project $1, or nothing if the project does not exist.
project_domain() {
  npx wrangler pages project list --json | node -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const p = list.find((x) => x["Project Name"] === process.argv[1]);
    if (p) process.stdout.write(String(p["Project Domains"]).split(",").map((d) => d.trim()).find((d) => d.endsWith(".pages.dev")) || "");
  ' "$1"
}

project_exists() {
  npx wrangler pages project list --json | node -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.exit(list.some((x) => x["Project Name"] === process.argv[1]) ? 0 : 1);
  ' "$1"
}

# ---------- destroy ----------
if [ "$CMD" = destroy ]; then
  [ -n "$NAME" ] || { echo "destroy needs --name NAME (no default, on purpose)" >&2; usage; }
  valid_name "$NAME" || { echo "invalid project name: $NAME" >&2; exit 2; }

  echo "This will delete:"
  if project_exists "$NAME"; then
    echo "  - Pages project $NAME ($(project_domain "$NAME")) and every deployment of it"
  else
    echo "  - (no Pages project named $NAME)"
  fi
  if [ "$WITH_DATA" = 1 ]; then
    for BINDING in TRIPS RECEIPTS; do
      ID=$(kv_id "$NAME-$BINDING")
      if [ -n "$ID" ]; then
        if [ "$ID" = "$(toml_id "$BINDING")" ]; then
          echo "  - KV namespace $NAME-$BINDING: SKIPPED, wrangler.toml still uses it for $BINDING"
        else
          echo "  - KV namespace $NAME-$BINDING ($ID) and all data in it"
        fi
      fi
    done
  fi

  if [ "$YES" != 1 ]; then
    if [ ! -t 0 ]; then echo "not a terminal: re-run with --yes to confirm" >&2; exit 1; fi
    printf 'Type the project name (%s) to confirm: ' "$NAME"
    read -r ANSWER
    [ "$ANSWER" = "$NAME" ] || { echo "aborted"; exit 1; }
  fi

  if project_exists "$NAME"; then
    npx wrangler pages project delete "$NAME" --yes
    note "deleted Pages project $NAME"
  fi
  if [ "$WITH_DATA" = 1 ]; then
    for BINDING in TRIPS RECEIPTS; do
      ID=$(kv_id "$NAME-$BINDING")
      [ -n "$ID" ] || continue
      if [ "$ID" = "$(toml_id "$BINDING")" ]; then
        note "kept KV namespace $NAME-$BINDING (still used by wrangler.toml)"
      else
        npx wrangler kv namespace delete --namespace-id "$ID" --skip-confirmation
        note "deleted KV namespace $NAME-$BINDING ($ID)"
      fi
    done
  fi
  echo
  echo "Summary:${SUMMARY:-
  nothing to delete}"
  exit 0
fi

# ---------- up ----------
[ -n "$NAME" ] || NAME=$(toml_name)
valid_name "$NAME" || { echo "invalid project name: $NAME" >&2; exit 2; }

RESULT=$(set_toml_name "$NAME")
[ "$RESULT" = set ] && note "wrangler.toml: name set to $NAME" || note "wrangler.toml: name already $NAME"

for BINDING in TRIPS RECEIPTS; do
  CUR=$(toml_id "$BINDING")
  if [ -n "$CUR" ] && kv_exists "$CUR"; then
    note "KV $BINDING: reusing $CUR from wrangler.toml"
    continue
  fi
  TITLE="$NAME-$BINDING"
  ID=$(kv_id "$TITLE")
  if [ -z "$ID" ]; then
    npx wrangler kv namespace create "$TITLE" >/dev/null
    ID=$(kv_id "$TITLE")
    [ -n "$ID" ] || { echo "created $TITLE but could not find its id" >&2; exit 1; }
    note "created KV namespace $TITLE ($ID)"
  else
    note "KV namespace $TITLE already existed ($ID)"
  fi
  RESULT=$(set_toml_id "$BINDING" "$ID")
  if [ "$RESULT" = set ]; then
    note "wrangler.toml: $BINDING id written"
  elif [ "$RESULT" != same ]; then
    echo "failed to update wrangler.toml for $BINDING" >&2; exit 1
  fi
done

if project_exists "$NAME"; then
  note "Pages project $NAME already existed"
else
  npx wrangler pages project create "$NAME" --production-branch main
  note "created Pages project $NAME (production branch main)"
fi

DOMAIN=$(project_domain "$NAME")
note "site: https://$DOMAIN"
if [ "$DOMAIN" != "$NAME.pages.dev" ]; then
  echo
  echo "Note: $NAME.pages.dev was taken, so Cloudflare assigned $DOMAIN."
  echo "      To try another name: sh scripts/provision.sh destroy --name $NAME, then provision again with --name OTHER."
fi

echo
echo "Summary:$SUMMARY"

# Dashboard steps that cannot be scripted. See README, "v2 setup".
echo
echo "Manual steps:"
echo "  1. Turnstile: dashboard > Turnstile > your widget (or Add widget, mode Managed): add hostname $DOMAIN."
echo "     Put the site key in wrangler.toml [vars] TURNSTILE_SITE_KEY. Set the secret from a real terminal"
echo "     (not a pasted/non-interactive shell, which stores an empty value):"
echo "       npx wrangler pages secret put TURNSTILE_SECRET --project-name $NAME"
echo "     then redeploy. A secret without a site key makes every create and parse return 403."
echo "  2. AI Gateway: dashboard > AI > AI Gateway > Create, enable rate limiting with the longest window offered."
echo "     Put the gateway id in wrangler.toml [vars] AI_GATEWAY_ID."
echo "  3. Local dev: .dev.vars with TURNSTILE_SITE_KEY=1x00000000000000000000AA and TURNSTILE_SECRET=1x0000000000000000000000000000000AA"
echo "  4. Kill switch: AI_DISABLED is a plain var. Set it to \"1\" in wrangler.toml [vars] and redeploy."
echo "  5. Deploy: npm run deploy"
