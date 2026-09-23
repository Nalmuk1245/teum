"use client";

// 코인 상세 패널을 어디서든 여는 컨텍스트. 패널 자체(CoinSheet)와 분리해 둔 이유:
// 패널이 운영 탭 컴포넌트(보유량 카드)를 쓰고, 운영 탭도 패널을 연다 — 한 파일이면 순환 임포트.

import { createContext, useContext } from "react";

/** base = 코인 티커. 빈 문자열이면 "코인 검색 + 막힌 코인 목록" 화면. */
export const CoinSheetCtx = createContext<(base: string) => void>(() => {});
export const useCoinSheet = () => useContext(CoinSheetCtx);
