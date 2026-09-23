# 서울(KR) 서버 이전

## 왜
업비트 공지 API는 KR IP에서만 열린다. 지금 서버(해외)는 차단돼 있어서 업비트 상장을 **거래가 열린 뒤**에야 잡는다(마켓 목록 변화). 상장따리의 핵심인 "공지 순간 해외 선점"이 업비트 쪽에선 안 된다. 빗썸 공지는 공식 API라 해외에서도 된다(2026-09-23 연결).

## 서버 고르기
- 리전: 서울 (AWS Lightsail ap-northeast-2, Vultr Seoul, 오라클 춘천/서울 등)
- 사양: **RAM 2GB 이상** 권장. 지금 1GB 박스는 빌드할 때 앱을 내려야 하고 스왑 스래싱이 났다.
- OS: Ubuntu 22.04/24.04

## 순서
1. 새 서버 생성, SSH 키 등록, 방화벽에 22·3100 열기
2. **거래소 API 키 IP 화이트리스트에 새 서버 IP 추가** (업비트는 필수 — 안 하면 서명 호출 전부 거부)
3. 새 서버에서 옛 서버로 SSH가 되게 키 설정 (rsync용)
4. 새 서버에서:
   ```
   curl -fsSL https://raw.githubusercontent.com/Nalmuk1245/teum/main/scripts/migrate-kr.sh -o migrate-kr.sh
   OLD=root@158.247.242.248 bash migrate-kr.sh
   ```
   스크립트가 맨 처음 업비트 공지 API가 열리는지 확인하고, 안 열리면 멈춘다.
5. 마지막 줄에 "업비트 공지 차단: False"가 나오면 성공. 옛 서버에서 `pm2 stop teum && pm2 save`
6. 대시보드 감시 상태에서 업비트 공지·빗썸 공지가 초록인지 확인

## 확인 항목
- `/api/listings`의 `watch.annBlocked`가 false, `annOkAgoSec`가 몇 초
- 상장 탭 성과 히스토리의 "감지" 열이 "업공지"로 찍히기 시작하는지 (전엔 "개장")
