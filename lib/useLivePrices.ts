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
/** Seconds since each venue's last WS message (null = never received). */
export type LiveAges = { binance: number | null; upbit: number | null; bithumb: number | null };

// Equal-enough overlay comparison. Sub-0.005%p wiggle is below anything the UI
// renders (2 decimals), so treating it as "unchanged" avoids a full re-render
// for a difference nobody can see.
const EPS = 0.005;
function sameOverlay(a: Record<string, LiveGap>, b: Record<string, LiveGap>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (!y) return false;
    if (Math.abs(x.netPct - y.netPct) > EPS) return false;
    if (Math.abs(x.grossPct - y.grossPct) > EPS) return false;
    if (Math.abs(x.premiumPct - y.premiumPct) > EPS) return false;
  }
  return true;
}

export function useLivePrices(opps: Opportunity[], enabled: boolean) {
  const oppsRef = useRef(opps);
  oppsRef.current = opps;

  const bn = useRef(new Map<string, number>()); // base -> USDT last
  const bnBook = useRef(new Map<string, { bid: number; ask: number }>()); // base -> best b/a (from !ticker@arr)
  const upBook = useRef(new Map<string, { bid: number; ask: number }>()); // base -> KRW best b/a (orderbook WS)
  const up = useRef(new Map<string, number>()); // base -> KRW
  const bt = useRef(new Map<string, number>()); // base -> KRW
  // Bithumb depth deltas → price→qty maps per side. No snapshot on this WS, so
  // the book converges from updates; phantom levels are clamped by last price.
  const btDepth = useRef(new Map<string, { bids: Map<number, number>; asks: Map<number, number>; ts: number }>());
  const fx = useRef({ upbit: 0, bithumb: 0 }); // USDT/KRW per venue

  const [overlay, setOverlay] = useState<Record<string, LiveGap>>({});
  const [status, setStatus] = useState<LiveStatus>({ binance: false, upbit: false, bithumb: false });
  const lastMsg = useRef<{ binance: number; upbit: number; bithumb: number }>({ binance: 0, upbit: 0, bithumb: 0 });
  const [ages, setAges] = useState<LiveAges>({ binance: null, upbit: null, bithumb: null });

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
          lastMsg.current.binance = Date.now();
          set("binance", true); // green only once data actually arrives
          for (const t of arr) {
            if (typeof t.s === "string" && t.s.endsWith("USDT")) {
              const base = t.s.slice(0, -4);
              bn.current.set(base, Number(t.c));
              const bid = Number(t.b), ask = Number(t.a);
              if (bid > 0 && ask > 0) bnBook.current.set(base, { bid, ask });
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
      upWs.send(JSON.stringify([
        { ticket: "arb-cockpit" },
        { type: "ticker", codes: [...upSubbed] },
        { type: "orderbook", codes: [...upSubbed] }, // best bid/ask → executable overlay
      ]));
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
          if (m.type === "orderbook" && m.code && Array.isArray(m.orderbook_units)) {
            const u = m.orderbook_units[0];
            const base = String(m.code).replace("KRW-", "");
            if (u?.bid_price > 0 && u?.ask_price > 0) {
              lastMsg.current.upbit = Date.now();
              upBook.current.set(base, { bid: u.bid_price, ask: u.ask_price });
            }
            return;
          }
          if (m.code && typeof m.trade_price === "number") {
            lastMsg.current.upbit = Date.now();
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
      btWs.send(JSON.stringify({ type: "orderbookdepth", symbols: [...btSubbed] })); // 실호가 (델타)
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
          if (m.type === "orderbookdepth" && c && Array.isArray(c.list)) {
            lastMsg.current.bithumb = Date.now();
            for (const d of c.list) {
              const base = String(d.symbol ?? "").replace("_KRW", "");
              if (!base) continue;
              let book = btDepth.current.get(base);
              if (!book) { book = { bids: new Map(), asks: new Map(), ts: 0 }; btDepth.current.set(base, book); }
              const side = d.orderType === "bid" ? book.bids : book.asks;
              const price = Number(d.price), qty = Number(d.quantity);
              if (!(price > 0)) continue;
              if (qty > 0) side.set(price, qty); else side.delete(price);
              book.ts = Date.now();
            }
            return;
          }
          if (m.type === "ticker" && c && c.symbol) {
            const base = String(c.symbol).replace("_KRW", "");
            const px = Number(c.closePrice);
            if (!px) return;
            lastMsg.current.bithumb = Date.now();
            set("bithumb", true);
            if (base === "USDT") fx.current.bithumb = px;
            else bt.current.set(base, px);
          }
        } catch {
          /* ignore */
        }
      };
    };

    // 델타북에서 best bid/ask — 스냅샷이 없는 WS라 마지막 체결가 ±5% 밖의
    // 팬텀 레벨(업데이트가 끊긴 잔재)은 걸러낸다.
    const btBest = (base: string): { bid: number; ask: number } | undefined => {
      const book = btDepth.current.get(base);
      if (!book || Date.now() - book.ts > 15_000) return undefined; // 신선한 것만
      const last = bt.current.get(base) ?? 0;
      let bid = 0, ask = Infinity;
      for (const [p] of book.bids) { if (last > 0 && p > last * 1.05) { book.bids.delete(p); continue; } if (p > bid) bid = p; }
      for (const [p] of book.asks) { if (last > 0 && p < last * 0.95) { book.asks.delete(p); continue; } if (p < ask) ask = p; }
      return bid > 0 && Number.isFinite(ask) && ask > bid ? { bid, ask } : undefined;
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
        const globalLeg = o.legs.find((l) => l.quote === "USDT");
        if (!kr || !globalLeg) continue;
        const venue = kr.venue as "upbit" | "bithumb";
        const buyGlobal = o.legs.find((l) => l.side === "buy")?.quote === "USDT";
        // PREFERRED: fully-executable live gross from real best bid/ask on both
        // sides (Upbit orderbook WS + Binance b/a) — same math as the scan.
        const kb = venue === "upbit" ? upBook.current.get(o.base) : btBest(o.base);
        const gb = bnBook.current.get(o.base);
        const rate = venue === "upbit" ? fx.current.upbit : fx.current.bithumb;
        if (kb && gb && rate > 0) {
          const grossPct = buyGlobal
            ? ((kb.bid / rate - gb.ask) / gb.ask) * 100      // buy global ask → sell KR bid
            : ((gb.bid - kb.ask / rate) / (kb.ask / rate)) * 100; // buy KR ask → sell global bid
          ov[o.id] = { premiumPct: grossPct, grossPct, netPct: grossPct - o.costPct };
          continue;
        }
        // FALLBACK (bithumb leg / book not yet streamed): anchor to the scan's
        // executable gross and apply only the live price-movement delta.
        const liveKr = venue === "upbit" ? up.current.get(o.base) : bt.current.get(o.base);
        const liveGlobal = bn.current.get(o.base); // Binance WS last (proxy for the USDT mover)
        const scanKr = kr.price, scanGlobal = globalLeg.price;
        if (!liveKr || !liveGlobal || !scanKr || !scanGlobal) continue; // no live pair → keep scan value
        const ratioNow = (liveKr / scanKr) / (liveGlobal / scanGlobal);
        const premiumDeltaPct = (ratioNow - 1) * 100;
        // buyGlobal (sell KR): profit rises as KR outpaces global (+delta).
        // reverse (sell global): profit rises as global outpaces KR (−delta).
        const grossPct = o.grossPct + (buyGlobal ? premiumDeltaPct : -premiumDeltaPct);
        ov[o.id] = { premiumPct: premiumDeltaPct, grossPct, netPct: grossPct - o.costPct };
      }
      // Only publish when something actually MOVED. These two setters used to
      // fire unconditionally with fresh object identities every 600ms — even
      // with zero WS messages and identical numbers — which re-rendered the
      // whole app (~100 renders/min on every tab, each cascading into full
      // sorts/filters over the opportunity list) purely to redraw the same
      // pixels. The WS message handlers were already identity-guarded; only this
      // interval was not.
      setOverlay((prev) => (sameOverlay(prev, ov) ? prev : ov));
      const now = Date.now();
      const age = (t: number) => (t ? Math.round((now - t) / 1000) : null);
      const nextAges: LiveAges = {
        binance: age(lastMsg.current.binance),
        upbit: age(lastMsg.current.upbit),
        bithumb: age(lastMsg.current.bithumb),
      };
      setAges((prev) =>
        prev.binance === nextAges.binance && prev.upbit === nextAges.upbit && prev.bithumb === nextAges.bithumb
          ? prev
          : nextAges,
      );
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

  return { overlay, status, ages };
}
