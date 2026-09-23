#!/usr/bin/env bash
# teum을 KR(서울) 서버로 옮긴다 — 새 서버에서 root로 실행.
#
#   사용: OLD=root@158.247.242.248 bash migrate-kr.sh
#
# 하는 일: Node 20·pm2 설치 → 저장소 클론 → 옛 서버에서 .env.local·data/ 복사(rsync) →
#          빌드 → pm2 기동 → 업비트 공지 API가 이 IP에서 열리는지 확인.
# 옛 서버의 teum은 멈추지 않는다 — 새 서버가 확인되면 옛 서버에서 `pm2 stop teum`.
# 주의: 거래소 API 키의 IP 화이트리스트(업비트 필수)에 **새 서버 IP**를 먼저 추가할 것.
set -euo pipefail
OLD="${OLD:?OLD=root@<옛서버IP> 필요}"
REPO="${REPO:-https://github.com/Nalmuk1245/arb-cockpit.git}"
DIR="${DIR:-/root/teum}"

echo "== 1) 이 서버가 KR IP인가 (업비트 공지 API)"
ct=$(curl -s -o /dev/null -w "%{content_type}" -m 8 -A "Mozilla/5.0" -H "Referer: https://upbit.com/service_center/notice" \
  "https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=1&category=trade" || true)
if [[ "$ct" != *json* ]]; then echo "✗ 업비트 공지 API가 JSON을 안 준다 ($ct) — KR IP가 아니거나 차단. 중단."; exit 1; fi
echo "✓ 공지 API 열림"

echo "== 2) Node 20 · pm2"
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs rsync
fi
command -v pm2 >/dev/null || npm i -g pm2
pm2 install pm2-logrotate >/dev/null 2>&1 || true

echo "== 3) 코드"
[[ -d "$DIR/.git" ]] || git clone "$REPO" "$DIR"
cd "$DIR" && git pull --ff-only

echo "== 4) 비밀·상태 복사 (옛 서버 → 여기)"
rsync -az "$OLD:$DIR/.env.local" "$DIR/.env.local"
rsync -az --exclude 'episodes.jsonl.*' "$OLD:$DIR/data/" "$DIR/data/"
chmod 600 "$DIR/.env.local"
NEWIP=$(curl -s -4 -m 5 ifconfig.me || true)
if [[ -n "$NEWIP" ]] && grep -q '^ALLOWED_HOSTS=' .env.local; then
  sed -i "s/^ALLOWED_HOSTS=.*/ALLOWED_HOSTS=$NEWIP:3100,$NEWIP/" .env.local
  echo "  ALLOWED_HOSTS → $NEWIP"
fi

echo "== 5) 빌드 · 기동"
npm ci
NODE_OPTIONS=--max-old-space-size=900 npm run build
pm2 delete teum >/dev/null 2>&1 || true
pm2 start ecosystem.public.config.js && pm2 save && pm2 startup systemd -u root --hp /root >/dev/null || true

echo "== 6) 확인"
sleep 20
curl -s -m 20 "http://127.0.0.1:3100/api/health" | head -c 200; echo
curl -s -m 20 -u "$(grep '^BASIC_AUTH=' .env.local | cut -d= -f2)" "http://127.0.0.1:3100/api/listings" \
  | python3 -c "import sys,json; w=json.load(sys.stdin).get('watch',{}); print('업비트 공지 차단:', w.get('annBlocked'), '· 마지막 수신', w.get('annOkAgoSec'), '초 전 · 빗썸 공지', w.get('btAnnOkAgoSec'), '초 전')"
echo "끝. 옛 서버 정리: ssh $OLD 'pm2 stop teum && pm2 save'"
