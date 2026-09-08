#!/bin/bash
# End-to-end check of the notification Functions: runs `wrangler pages dev`
# against LOCAL D1 and drives subscribe → verify (GET must not verify, POST
# does) → expired token → dispatch of a 120-item payload → dedup re-dispatch.
# Sends nothing real (no RESEND_API_KEY locally), touches only local D1, and
# removes every row it creates.
#
# Prereqs: site built (`cd site && npm run build`), local D1 migrated, and
# site/.dev.vars with ENVIRONMENT=development and WEBHOOK_SECRET.
# Run from anywhere:  site/test/e2e/notifications.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SITE=$(cd "$HERE/../.." && pwd)
S=$(mktemp -d /tmp/notify-e2e.XXXXXX)
trap 'kill $WP 2>/dev/null; rm -rf "$S"' EXIT
D1=$(find $SITE/.wrangler/state/v3/d1 -name '*.sqlite' ! -name metadata.sqlite | head -1)
SECRET=$(grep '^WEBHOOK_SECRET=' $SITE/.dev.vars | cut -d= -f2- | tr -d '"')
BASE=http://localhost:8788
EMAIL="branch3-e2e@example.test"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1: got [$2] want [$3]"; fail=$((fail+1)); fi; }

cd $SITE
sqlite3 "$D1" "DELETE FROM subscriptions WHERE email LIKE 'branch3-%'; DELETE FROM email_rate_limits WHERE email LIKE 'branch3-%';"
# Other verified subscribers may exist in local D1; scope assertions to ours and
# remove every notification_log row this run creates afterwards.
RUN_START=$(sqlite3 "$D1" "select datetime('now')")
npx wrangler pages dev _site --port 8788 > $S/wrangler.log 2>&1 &
WP=$!
for i in $(seq 1 60); do curl -s -o /dev/null $BASE/ && break; sleep 1; done
echo "wrangler up after ${i}s (pid $WP)"

echo "--- 1. subscribe"
SUB=$(curl -s -X POST $BASE/api/subscribe -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"keywords\":[\"zebrafish\",\"cra\",\"bayshore blvd\"]}")
VURL=$(echo "$SUB" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("devVerifyUrl",""))')
check "subscribe returns devVerifyUrl" "$([ -n "$VURL" ] && echo yes)" "yes"
TOKEN=${VURL##*token=}
check "not verified after subscribe" "$(sqlite3 "$D1" "select verified from subscriptions where email='$EMAIL'")" "0"

echo "--- 2. GET verify must show a page, not verify"
GET_STATUS=$(curl -s -o $S/verify-get.html -w '%{http_code}' "$VURL")
check "GET /api/verify is 200" "$GET_STATUS" "200"
check "GET page has a POST form" "$(grep -c 'method="POST" action="/api/verify"' $S/verify-get.html)" "1"
check "still not verified after GET" "$(sqlite3 "$D1" "select verified from subscriptions where email='$EMAIL'")" "0"

echo "--- 3. POST verify"
POST_HDR=$(curl -s -o /dev/null -D - -X POST $BASE/api/verify -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "token=$TOKEN")
check "POST /api/verify is 303" "$(echo "$POST_HDR" | head -1 | awk '{print $2}')" "303"
check "redirects to status=verified with session token" "$(echo "$POST_HDR" | grep -i '^location:' | grep -c 'status=verified&email=.*&token=')" "1"
check "verified after POST" "$(sqlite3 "$D1" "select verified from subscriptions where email='$EMAIL'")" "1"
check "verification token cleared" "$(sqlite3 "$D1" "select verification_token is null from subscriptions where email='$EMAIL'")" "1"

echo "--- 4. expired token"
sqlite3 "$D1" "INSERT INTO subscriptions (id, email, verified, verification_token, unsubscribe_token, updated_at) VALUES ('branch3old', 'branch3-old@example.test', 0, '$(printf 'oldtoken' | shasum -a 256 | cut -d' ' -f1)', 'branch3unsub', datetime('now','-4 days'));"
check "old token GET redirects to verify_expired" "$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/api/verify?token=oldtoken" | grep -o 'status=[a-z_]*')" "status=verify_expired"
check "old token POST also refused" "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST $BASE/api/verify -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "token=oldtoken" | grep -o 'status=[a-z_]*')" "status=verify_expired"
check "old subscription still unverified" "$(sqlite3 "$D1" "select verified from subscriptions where id='branch3old'")" "0"

echo "--- 5. dispatch meeting 2824 (119 items) + a null-id item"
node "$HERE/make-notify-payload.js" "$S/payload.json"
R1=$(curl -s -X POST $BASE/api/notify -H 'Content-Type: application/json' -H "X-Webhook-Secret: $SECRET" --data-binary @$S/payload.json)
echo "  response: $(echo "$R1" | cut -c1-120)"
check "first dispatch emails our subscriber" "$(echo "$R1" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(any(e["to"]=="'$EMAIL'" for e in d.get("devEmails",[])))')" "True"
check "sentCount equals digests built" "$(echo "$R1" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["sentCount"]==len(d.get("devEmails",[])))')" "True"
LOGGED=$(sqlite3 "$D1" "select count(*) from notification_log nl join subscriptions s on s.id=nl.subscription_id where s.email='$EMAIL'")
echo "  logged rows: $LOGGED"
check "some matches logged" "$([ "$LOGGED" -gt 0 ] && echo yes)" "yes"
check "null-id item logged under its number key, one row per matched keyword" "$(sqlite3 "$D1" "select group_concat(keyword_matched) from (select keyword_matched from notification_log nl join subscriptions s on s.id=nl.subscription_id where s.email='$EMAIL' and nl.agenda_item_id='n999' order by keyword_matched)")" "bayshore blvd,zebrafish"
check "digest mentions the null-id item" "$(echo "$R1" | grep -c 'Zebrafish')" "1"
R2=$(curl -s -X POST $BASE/api/notify -H 'Content-Type: application/json' -H "X-Webhook-Secret: $SECRET" --data-binary @$S/payload.json)
check "second dispatch sends 0 (dedup across 120 item ids)" "$(echo "$R2" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("sentCount"))')" "0"
check "no dedup read error in log" "$(grep -c 'notification_log read failed' $S/wrangler.log)" "0"

echo "--- 6. subscribe validation happens before eligibility; cap is uniform"
CAP=$(curl -s -X POST $BASE/api/subscribe -H 'Content-Type: application/json' -d "{\"email\":\"branch3-cap@example.test\",\"keywords\":[\"a1\",\"a2\",\"a3\",\"a4\",\"a5\",\"a6\",\"a7\",\"a8\",\"a9\",\"b1\",\"b2\",\"b3\",\"b4\",\"b5\",\"b6\",\"b7\"]}")
check "16 keywords rejected with the uniform cap message" "$(echo "$CAP" | grep -c 'maximum of 15 keywords')" "1"

kill $WP 2>/dev/null; wait $WP 2>/dev/null
sqlite3 "$D1" "DELETE FROM subscriptions WHERE email LIKE 'branch3-%'; DELETE FROM email_rate_limits WHERE email LIKE 'branch3-%'; DELETE FROM notification_log WHERE meeting_id='2824' AND sent_at >= '$RUN_START';"
echo "local D1 cleanup: $(sqlite3 "$D1" "select count(*) from notification_log where meeting_id='2824'") rows remain for 2824"
echo "=== $pass passed, $fail failed ==="
grep -i "error\|exception" $S/wrangler.log | grep -v "turnstile\|X \[ERROR\] Error: The Cloudflare API" | head -5
exit $fail
