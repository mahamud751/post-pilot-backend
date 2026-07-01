#!/usr/bin/env bash
# Production API smoke test — login + create post
# Usage: ./scripts/test-production-post.sh [email] [password]

set -euo pipefail

API="${API_BASE:-https://postapi.chapaimango.online/v1}"
EMAIL="${1:-pino@gmail.com}"
PASSWORD="${2:-}"

if [ -z "$PASSWORD" ]; then
  echo "Usage: $0 <email> <password>"
  exit 1
fi

echo "=== Health ==="
curl -sf "$API/health" | python3 -m json.tool

echo "=== Login: $EMAIL ==="
LOGIN_JSON=$(curl -sf -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

TOKEN=$(echo "$LOGIN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
USER_NAME=$(echo "$LOGIN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['name'])")
echo "Logged in as: $USER_NAME"

echo "=== Create draft post ==="
CREATE_JSON=$(curl -sf -X POST "$API/posts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "caption": "Play Store test #Sunrise #PostFlow",
    "platforms": ["instagram", "facebook"],
    "status": "draft"
  }')

echo "$CREATE_JSON" | python3 -m json.tool
POST_ID=$(echo "$CREATE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['post']['id'])")
echo "Created post id: $POST_ID"

echo "=== List posts (latest 3) ==="
curl -sf "$API/posts" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json; posts=json.load(sys.stdin)['posts'][:3];
[print(p['id'], p['status'], p['caption'][:40]) for p in posts]"

echo "=== Dashboard stats ==="
curl -sf "$API/dashboard" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json; s=json.load(sys.stdin)['stats']; print(s)"

echo "=== ALL TESTS PASSED ==="
