#!/usr/bin/env bash
# Logs in to Palatine Library (BiblioCommons) over plain HTTP and prints what the
# server does: status codes, Location, cookie NAMES/flags/expiry (never values),
# then checks that the gateway API accepts the session.
# Credentials are prompted for silently; nothing is written to disk except a temp cookie jar.
set -euo pipefail

B=https://palatinelibrary.bibliocommons.com
G=https://gateway.bibliocommons.com/v2/libraries/palatinelibrary
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
DIR=$(mktemp -d); trap 'rm -rf "$DIR"' EXIT
JAR=$DIR/jar.txt

read -r -p "Card number / username: " NAME
read -r -s -p "PIN / password: " PIN; echo

redact() { sed -E 's/^(set-cookie: [^=]+)=[^;]*/\1=<value>/I'; }

echo "== GET login page"
curl -s -L -c "$JAR" -b "$JAR" -A "$UA" -D "$DIR/h_get.txt" -o "$DIR/login.html" "$B/user/login"
TOKEN=$(python3 - "$DIR/login.html" <<'E'
import re,sys
t=open(sys.argv[1]).read()
m=re.search(r'<meta[^>]*name="csrf-token"[^>]*>',t)
c=re.search(r'content="([^"]+)"',m.group(0)) if m else None
print(c.group(1) if c else '')
E
)
ACTION=$(python3 - "$DIR/login.html" <<'E'
import re,sys
t=open(sys.argv[1]).read()
m=re.search(r'<form[^>]*loginForm[^>]*>',t)
print(re.search(r'action="([^"]+)"',m.group(0)).group(1).replace('&amp;','&'))
E
)
echo "csrf token length: ${#TOKEN}; form action: $ACTION"

echo "== POST login"
curl -s -c "$JAR" -b "$JAR" -A "$UA" -D "$DIR/h_post.txt" -o "$DIR/post_body.txt" \
  -w 'http_code=%{http_code} redirect_url=%{redirect_url}\n' \
  -H "Origin: $B" -H "Referer: $B/user/login" \
  --data-urlencode "utf8=✓" --data-urlencode "authenticity_token=$TOKEN" \
  --data-urlencode "name=$NAME" --data-urlencode "user_pin=$PIN" \
  --data-urlencode "remember_me=true" --data-urlencode "local=false" --data-urlencode "commit=Log In" \
  "$ACTION"
grep -iE '^(HTTP|location)' "$DIR/h_post.txt" || true
grep -i '^set-cookie' "$DIR/h_post.txt" | redact || true

echo "== Cookie jar (names, flags, expiry; values hidden)"
# Netscape format: domain, subdomain flag, path, secure, expiry(epoch), name, value; HttpOnly lines start with #HttpOnly_
awk 'NF>=7 { d=$1; h=(d ~ /^#HttpOnly_/)?"HttpOnly":""; sub(/^#HttpOnly_/,"",d);
     printf "%-28s domain=%-28s expires=%s %s\n",$6,d,($5==0?"session":$5),h }' "$JAR"

echo "== Resolve accountId from /v2/checkedout/out"
curl -s -L -c "$JAR" -b "$JAR" -A "$UA" -o "$DIR/out.html" -w 'http_code=%{http_code} final=%{url_effective}\n' "$B/v2/checkedout/out"
ACCOUNT_ID=$(python3 - "$DIR/out.html" <<'E'
import re,sys,json
t=open(sys.argv[1]).read()
for m in re.finditer(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>',t,re.S):
    if len(m.group(1))>100000:
        j=json.loads(m.group(1)); a=list(j['entities']['accounts'].values())
        print(a[0]['id'] if a else ''); break
E
)
if [ -n "$ACCOUNT_ID" ]; then echo "accountId found: yes"; else echo "accountId found: no"; fi

echo "== Gateway checks"
for ep in "checkouts?accountId=$ACCOUNT_ID&materialType=PHYSICAL&page=1&size=100" "fines?accountId=$ACCOUNT_ID"; do
  curl -s -c "$JAR" -b "$JAR" -A "$UA" -o "$DIR/gw.json" -w "GET ${ep%%\?*} -> %{http_code}\n" "$G/$ep"
done
python3 - "$DIR/gw.json" <<'E'
import json,sys
j=json.load(open(sys.argv[1])); print("fines summary:", j.get("borrowing",{}).get("summaries",{}).get("fines"))
E
echo "== Cookie-less gateway control (expect 401)"
curl -s -o /dev/null -A "$UA" -w '%{http_code}\n' "$G/checkouts?accountId=$ACCOUNT_ID&size=1"
