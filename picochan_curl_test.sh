#!/usr/bin/env bash
# Usage: ./picochan_curl_test.sh [BASE_URL]
# Exemple: ./picochan_curl_test.sh http://127.0.0.1:5000
set -euo pipefail

BASE="${1:-http://127.0.0.1:80}"

pass(){ echo "✅ $*"; }
fail(){ echo "❌ $*"; exit 1; }

echo "=== Testing Pico-chan at: $BASE ==="

# 1) /healthz
curl -fsS "$BASE/healthz" | grep -q '"ok":true' && pass "/healthz ok" || fail "/healthz failed"

# 2) /channels (discussion + dessin)
chan_json="$(curl -fsS "$BASE/channels")"
echo "$chan_json" | grep -q "discussion" || fail "channels missing 'discussion'"
echo "$chan_json" | grep -q "dessin"     || fail "channels missing 'dessin'"
pass "/channels contains discussion & dessin"

# 3) POST /msg (discussion) -> 204 No Content
MSG="curl-test-$(date +%s%N)"
code=$(curl -fsS -o /dev/null -w "%{http_code}" -X POST \
  -F "chan=discussion" -F "text=$MSG" "$BASE/msg")
[ "$code" = "204" ] && pass "POST /msg 204" || fail "POST /msg returned $code"

# 4) GET /poll (discussion) contient le message
curl -fsS "$BASE/poll?last_id=0&chan=discussion" | grep -q "$MSG" \
  && pass "/poll discussion contains the posted message" \
  || fail "/poll discussion missing the message"

# 5) DESSIN — état initial du canvas
cv="$(curl -fsS "$BASE/dessin/canvas")"
echo "$cv" | grep -q '"w":24' || fail "canvas w!=24"
echo "$cv" | grep -q '"h":8'  || fail "canvas h!=8"
pass "/dessin/canvas has w=24 h=8"

# 6) DESSIN — push un petit diff (2 pixels)
diff_res="$(curl -fsS -X POST "$BASE/dessin/diff" \
  -H 'Content-Type: application/json' \
  -d '{"pixels":[{"x":0,"y":0,"ch":"@"},{"x":1,"y":0,"ch":"+"}]}' )"
echo "$diff_res" | grep -q '"ok":true' || fail "/dessin/diff not ok"
echo "$diff_res" | grep -q '"n":2'     || fail "/dessin/diff n!=2"
pass "/dessin/diff ok (2 pixels)"

# 7) DESSIN — publier le snapshot dans le fil
pub_res="$(curl -fsS -X POST "$BASE/dessin/publish")"
echo "$pub_res" | grep -q '"ok":true' && pass "/dessin/publish ok" || fail "/dessin/publish failed"

# 8) GET /poll (dessin) doit contenir au moins un message de chan=dessin
curl -fsS "$BASE/poll?last_id=0&chan=dessin" | grep -q '"chan":"dessin"' \
  && pass "/poll dessin contains at least one 'dessin' message" \
  || fail "/poll dessin has no 'dessin' message"

# 9) (optionnel) HEADERS SSE /stream ?chan=discussion
# On vérifie juste que l'endpoint répond bien 200 (on coupe après 1s)
set +e
headers=$(curl -s -o /dev/null -D - "$BASE/stream?chan=discussion" --max-time 1)
echo "$headers" | head -1 | grep -q "200" \
  && pass "/stream?chan=discussion returns 200" \
  || echo "⚠️  /stream discussion: pas de 200 visible (peut être lié au timing, sans gravité)"
headers2=$(curl -s -o /dev/null -D - "$BASE/dessin/stream" --max-time 1)
echo "$headers2" | head -1 | grep -q "200" \
  && pass "/dessin/stream returns 200" \
  || echo "⚠️  /dessin/stream: pas de 200 visible (peut être lié au timing, sans gravité)"
set -e

echo "🎉 Tests terminés avec succès."
