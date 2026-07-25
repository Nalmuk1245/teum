"use client";

// 모바일 여부 — 앱 전체의 단일 소스. 여기 값 하나가 6개 파일 30여 곳의
// 레이아웃 분기를 먹인다.
//
// 왜 컨텍스트인가: 이전에는 `useState(false)` + 마운트 후 matchMedia였다. 서버가
// 그린 HTML과 하이드레이션 첫 렌더가 반드시 일치해야 하므로, 클라이언트만으로는
// **첫 페인트에 항상 데스크탑 레이아웃이 그려지고** 그 뒤 모바일로 바뀐다 —
// 폰에서 열 때마다 깨진 화면이 한 번 보이고, 기기가 느리면 그 구간이 길어진다.
// 인라인 스타일로 레이아웃을 잡는 구조에서는 CSS 미디어쿼리가 대신해 줄 수 없으니
// (React가 렌더 시점에 값을 알아야 한다), 서버가 User-Agent로 초기값을 정하고
// 마운트 후 matchMedia가 정정하는 방식이 남는 정답이다.
//
// 한계(의도적): 좁게 띄운 데스크탑 창이나 가로 모드 태블릿은 UA 추정이 틀릴 수
// 있고 그 경우 마운트 후 한 번 재배치된다. 실기기 폰(세로)에서는 처음부터 맞다.

import { createContext, useContext, useEffect, useState } from "react";

const MOBILE_MAX_PX = 640;
const Ctx = createContext(false);

export function MobileProvider({ initial, children }: { initial: boolean; children: React.ReactNode }) {
  const [mobile, setMobile] = useState(initial);
  useEffect(() => {
    // matchMedia가 최종 권위 — UA 추정이 틀렸으면 여기서 바로잡는다.
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`);
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return <Ctx.Provider value={mobile}>{children}</Ctx.Provider>;
}

export function useIsMobile(): boolean {
  return useContext(Ctx);
}
