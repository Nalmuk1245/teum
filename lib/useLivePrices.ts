"use client";

// Real-time gap overlay. The 8s /api/scan defines the opportunity universe +
// cost + transfer gates; this hook opens client-side WebSockets to Binance,
// Upbit and Bithumb and recomputes each kimchi opp's premium/net live (sub-second)
// on top of that. Runs in the browser only (WebSocket + useEffect).
//
// KR exchange WS (Upbit/Bithumb) work natively from a Korean IP — the intended
// deploy is a local personal PC in Korea, so no relay/geo-block concerns there.

import { useEffect, useRef, useState } from "react";
import type { Opportunity } from "./types";

export type LiveGap = { premiumPct: number; grossPct: number; netPct: number };
export type LiveStatus = { binance: boolean; upbit: boolean; bithumb: boolean };

export function useLivePrices(opps: Opportunity[], enabled: boolean) {
  const oppsRef = useRef(opps);
  oppsRef.current = opps;

  const bn = useRef(new Map<string, number>()); // base -> USDT
  const up = useRef(new Map<string, number>()); // base -> KRW
  const bt = useRef(new Map<string, number>()); // base -> KRW
  const fx = useRef({ upbit: 0, bithumb: 0 }); // USDT/KRW per venue

  const [overlay, setOverlay] = useState<Record<string, LiveGap>>({});
  const [status, setStatus] = useState<LiveStatus>({ binance: false, upbit: false, bithumb: false });

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let closed = false;
    const sockets: WebSocket[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    const set = (k: keyof LiveStatus, v: boolean) =>
      setStatus((s) => (s[k] === v ? s : { ...s, [k]: v }));

    // Codes currently needed on each KR venue (KRW-USDT/USDT_KRW always).
    const krCodes = (venue: "upbit" | "bithumb") => {
      const out = new Set<string>();
      for (const o of oppsRef.current) {
        if (o.mock || o.kind !== "kimchi") continue;
        const kr = o.legs.find((l) => l.quote === "KRW");
        if (kr && kr.venue === venue) out.add(o.base);
      }
      return out;
    };

    // ── Binance: one array stream covers every USDT ticker (~1s cadence) ──
    const connectBinance = () => {
      if (closed) return;
      const ws = new WebSocket("wss://stream.binance.com:9443/ws/!ticker@arr");
      sockets.push(ws);
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        set("binance", false);
        if (!closed) setTimeout(connectBinance, 2000);
      };
      ws.onmessage = (e) => {
        try {
          const arr = JSON.parse(e.data as string);
          if (!Array.isArray(arr)) return;
          set("binance", true); // green only once data actually arrives
          for (const t of arr) {
            if (typeof t.s === "string" && t.s.endsWith("USDT")) {
              bn.current.set(t.s.slice(0, -4), Number(t.c));
            }
          }
        } catch {
          /* ignore */
        }
      };
    };

    // ── Upbit ─────────────────────────────────────────────────────────────
    let upWs: WebSocket | null = null;
    const upSubbed = new Set<string>();
    const subUpbit = () => {
      if (!upWs || upWs.readyState !== WebSocket.OPEN) return;
      const codes = new Set<string>(["KRW-USDT"]);
      for (const base of krCodes("upbit")) codes.add(`KRW-${base}`);
      // Delta-only: re-sending the subscription frame every tick counts against
      // Upbit's WS rate limit and gets the connection dropped. Only send when a
      // genuinely new code appeared.
      const hasNew = [...codes].some((c) => !upSubbed.has(c));
      if (!hasNew && upSubbed.size > 0) return;
      for (const c of codes) upSubbed.add(c);
      upWs.send(JSON.stringify([{ ticket: "arb-cockpit" }, { type: "ticker", codes: [...upSubbed] }]));
    };
    const connectUpbit = () => {
      if (closed) return;
      const ws = new WebSocket("wss://api.upbit.com/websocket/v1");
      ws.binaryType = "arraybuffer";
      upWs = ws;
      sockets.push(ws);
      ws.onopen = () => {
        upSubbed.clear(); // fresh socket knows nothing — force a full (re)subscribe
        subUpbit();
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        set("upbit", false);
        if (!closed) setTimeout(connectUpbit, 2000);
      };
      ws.onmessage = (e) => {
        try {
          const text = new TextDecoder().decode(e.data as ArrayBuffer);
          const m = JSON.parse(text);
          if (m.code && typeof m.trade_price === "number") {
            set("upbit", true);
            const base = String(m.code).replace("KRW-", "");
            if (base === "USDT") fx.current.upbit = m.trade_price;
            else up.current.set(base, m.trade_price);
          }
        } catch {
          /* ignore */
        }
      };
    };

    // ── Bithumb ───────────────────────────────────────────────────────────
    let btWs: WebSocket | null = null;
    const btSubbed = new Set<string>();
    const subBithumb = () => {
      if (!btWs || btWs.readyState !== WebSocket.OPEN) return;
      const syms = new Set<string>(["USDT_KRW"]);
      for (const base of krCodes("bithumb")) syms.add(`${base}_KRW`);
      const hasNew = [...syms].some((s) => !btSubbed.has(s)); // delta-only (rate limit)
      if (!hasNew && btSubbed.size > 0) return;
      for (const s of syms) btSubbed.add(s);
      btWs.send(JSON.stringify({ type: "ticker", symbols: [...btSubbed], tickTypes: ["24H"] }));
    };
    const connectBithumb = () => {
      if (closed) return;
      const ws = new WebSocket("wss://pubwss.bithumb.com/pub/ws");
      btWs = ws;
      sockets.push(ws);
      ws.onopen = () => {
        btSubbed.clear(); // fresh socket — force full resubscribe
        subBithumb();
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        set("bithumb", false);
        if (!closed) setTimeout(connectBithumb, 2000);
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data as string);
          const c = m.content;
          if (m.type === "ticker" && c && c.symbol) {
            const base = String(c.symbol).replace("_KRW", "");
            const px = Number(c.closePrice);
            if (!px) return;
            set("bithumb", true);
            if (base === "USDT") fx.current.bithumb = px;
            else bt.current.set(base, px);
          }
        } catch {
          /* ignore */
        }
      };
    };

    connectBinance();
    connectUpbit();
    connectBithumb();

    // Recompute the live overlay from the latest prices + latest opps.
    const recompute = () => {
      // pick up any newly-listed KR bases since last tick
      subUpbit();
      subBithumb();
      const ov: Record<string, LiveGap> = {};
      for (const o of oppsRef.current) {
        if (o.mock || o.kind !== "kimchi") continue;
        const kr = o.legs.find((l) => l.quote === "KRW");
        if (!kr) continue;
        const venue = kr.venue as "upbit" | "bithumb";
        // KR price and FX must be LIVE — mixing a stale scan-time KR price with a
        // live opposite leg fabricates a moving premium on exactly the thin coins
        // where premia look biggest. Only the Binance side may fall back to the
        // scan price (its WS can be region-blocked; price drift there is smaller).
        const bnLeg = o.legs.find((l) => l.venue === "binance");
        const krw = venue === "upbit" ? up.current.get(o.base) : bt.current.get(o.base);
        const rate = venue === "upbit" ? fx.current.upbit : fx.current.bithumb;
        const usdt = bn.current.get(o.base) ?? bnLeg?.price;
        if (!krw || !rate || !usdt) continue; // no live KR data → no overlay (board keeps scan values)
        const premiumPct = ((krw / rate - usdt) / usdt) * 100;
        // Sign the gross by the opp's LISTED route — taking |premium| would show
        // a direction flip (premium inverting) as still-profitable when executing
        // the listed route actually loses the spread.
        const buyGlobal = o.legs.find((l) => l.side === "buy")?.venue === "binance";
        const grossPct = buyGlobal ? premiumPct : -premiumPct;
        ov[o.id] = { premiumPct, grossPct, netPct: grossPct - o.costPct };
      }
      setOverlay(ov);
    };
    timers.push(setInterval(recompute, 600));

    // Keepalive pings (Upbit/Bithumb drop idle sockets).
    timers.push(
      setInterval(() => {
        try {
          if (upWs?.readyState === WebSocket.OPEN) upWs.send("PING");
          if (btWs?.readyState === WebSocket.OPEN) btWs.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* ignore */
        }
      }, 30000),
    );

    return () => {
      closed = true;
      timers.forEach(clearInterval);
      sockets.forEach((ws) => {
        try {
          ws.onclose = null;
          ws.close();
        } catch {
          /* ignore */
        }
      });
    };
  }, [enabled]);

  return { overlay, status };
}
