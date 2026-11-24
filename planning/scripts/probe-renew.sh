#!/usr/bin/env bash
# Verifies the renew call from plain HTTP (curl + cookie jar, no browser).
# Logs in, finds ONE checkout by title, renews only that item via PATCH /checkouts,
# and prints before/after due date + renewal count and the raw renew response.
# Credentials are prompted for silently; cookie values are never printed.
#
# Usage: ./scripts/probe-renew.sh ["Title substring"]   (default: "Ember's End")
set -euo pipefail

TITLE=${1:-"Ember's End"}
B=https://palatinelibrary.bibliocommons.com
G=https://gateway.bibliocommons.com/v2/libraries/palatinelibrary
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
DIR=$(mktemp -d); trap 'rm -rf "$DIR"' EXIT
JAR=$DIR/jar.txt

read -r -p "Card number / username: " NAME
read -r -s -p "PIN / password: " PIN; echo

curl -s -L -c "$JAR" -b "$JAR" -A "$UA" -o "$DIR/login.html" "$B/user/login"
read -r TOKEN ACTION < <(python3 - "$DIR/login.html" <<'E'
import re,sys
t=open(sys.argv[1]).read()
m=re.search(r'<meta[^>]*name="csrf-token"[^>]*>',t); tok=re.search(r'content="([^"]+)"',m.group(0)).group(1)
f=re.search(r'<form[^>]*loginForm[^>]*>',t); act=re.search(r'action="([^"]+)"',f.group(0)).group(1).replace('&amp;','&')
print(tok,act)
E
)
CODE=$(curl -s -c "$JAR" -b "$JAR" -A "$UA" -o /dev/null -w '%{http_code}' \
  -H "Origin: $B" -H "Referer: $B/user/login" \
  --data-urlencode "utf8=✓" --data-urlencode "authenticity_token=$TOKEN" \
  --data-urlencode "name=$NAME" --data-urlencode "user_pin=$PIN" \
  --data-urlencode "remember_me=true" --data-urlencode "local=false" --data-urlencode "commit=Log In" "$ACTION")
echo "login POST -> $CODE (302 = success)"
[ "$CODE" = 302 ] || { echo "login failed, stopping"; exit 1; }

curl -s -L -c "$JAR" -b "$JAR" -A "$UA" -o "$DIR/out.html" "$B/v2/checkedout/out"
ACCOUNT_ID=$(python3 - "$DIR/out.html" <<'E'
import re,sys,json
t=open(sys.argv[1]).read()
for m in re.finditer(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>',t,re.S):
    if len(m.group(1))>100000:
        print(list(json.loads(m.group(1))['entities']['accounts'].values())[0]['id']); break
E
)

list_checkouts() { curl -s -c "$JAR" -b "$JAR" -A "$UA" "$G/checkouts?accountId=$ACCOUNT_ID&materialType=PHYSICAL&page=1&size=100" > "$DIR/co.json"; }
show() { python3 - "$DIR/co.json" "$TITLE" "$1" <<'E'
import json,sys
j=json.load(open(sys.argv[1])); title=sys.argv[2].lower()
hits=[c for c in j['entities']['checkouts'].values() if title in c['bibTitle'].lower()]
for c in hits: print(f"  {sys.argv[3]}: {c['bibTitle']} | due {c['dueDate']} | renewed {c['timesRenewed']}x | actions {c['actions']} | id {c['checkoutId']}")
if sys.argv[3]=='before':
    if len(hits)!=1: print(f"ERROR: expected exactly 1 match for '{sys.argv[2]}', found {len(hits)}", file=sys.stderr); sys.exit(2)
    open(sys.argv[1]+'.id','w').write(hits[0]['checkoutId'])
E
}

echo "== Checkouts (before)"
list_checkouts; show before
CHECKOUT_ID=$(cat "$DIR/co.json.id")

read -r -p "Renew '$TITLE' now? This can't be undone. [y/N] " OK
[ "$OK" = y ] || { echo "aborted, nothing renewed"; exit 0; }

BODY=$(printf '{"accountId":%s,"checkoutIds":["%s"],"renew":true}' "$ACCOUNT_ID" "$CHECKOUT_ID")

echo "== Renew attempt 1: minimal headers (cookies + User-Agent + JSON content type only)"
CODE=$(curl -s -c "$JAR" -b "$JAR" -A "$UA" -X PATCH -H 'Content-Type: application/json' \
  -o "$DIR/renew.json" -w '%{http_code}' -d "$BODY" "$G/checkouts?locale=en-US")
echo "PATCH -> $CODE"
if [ "${CODE:0:1}" != 2 ]; then
  echo "== Renew attempt 2: adding Origin + Referer (only because attempt 1 was not 2xx)"
  CODE=$(curl -s -c "$JAR" -b "$JAR" -A "$UA" -X PATCH -H 'Content-Type: application/json' \
    -H "Origin: $B" -H "Referer: $B/v2/checkedout/out" \
    -o "$DIR/renew.json" -w '%{http_code}' -d "$BODY" "$G/checkouts?locale=en-US")
  echo "PATCH -> $CODE"
fi
echo "== Raw renew response (first 1500 chars)"
head -c 1500 "$DIR/renew.json"; echo

echo "== Checkouts (after)"
list_checkouts; show after
