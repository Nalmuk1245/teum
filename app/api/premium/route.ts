// 프리미엄 차트 데이터 — GET /api/premium?coin=ONG&a=upbit:spot&b=binance:spot&unit=3&count=400
import { NextResponse } from "next/server";
import { premiumSeries, UNITS, type ChartVenue, type MarketKind, type Unit, type VenueSpec } from "@/lib/premiumSeries";

export const dynamic = "force-dynamic";

// 같은 (코인·A·B·주기·개수) 요청은 짧게 재사용한다 — 창 두 개가 같은 차트를 열거나
// 부모가 다시 그려져도 거래소 캔들을 다시 치지 않게. 진행 중인 요청은 공유한다.
// 1분봉은 15초, 그 이상은 주기의 1/4 (최대 5분).
const gc = globalThis as unknown as { __premCache?: Map<string, { ts: number; ttl: number; p: Promise<unknown> }> };
gc.__premCache ??= new Map();
function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const m = gc.__premCache!;
  const hit = m.get(key);
  if (hit && Date.now() - hit.ts < hit.ttl) return hit.p as Promise<T>;
  const p = fn();
  m.set(key, { ts: Date.now(), ttl, p });
  p.catch(() => m.delete(key));
  if (m.size > 200) for (const [k, v] of m) if (Date.now() - v.ts > v.ttl) m.delete(k);
  return p;
}

const VENUES: ChartVenue[] = ["upbit", "bithumb", "binance", "bybit", "okx"];

function parseSpec(raw: string | null, fallback: VenueSpec): VenueSpec | null {
  if (!raw) return fallback;
  const [v, m = "spot"] = raw.split(":");
  if (!VENUES.includes(v as ChartVenue)) return null;
  if (m !== "spot" && m !== "futures") return null;
  // 원화 거래소엔 선물이 없다 — 조용히 현물로 바꾸면 화면이 거짓말을 한다.
  if ((v === "upbit" || v === "bithumb") && m === "futures") return null;
  return { venue: v as ChartVenue, market: m as MarketKind };
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const coin = (u.searchParams.get("coin") || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(coin)) return NextResponse.json({ error: "coin 필요 (예: ONG)" }, { status: 400 });

  const a = parseSpec(u.searchParams.get("a"), { venue: "upbit", market: "spot" });
  const b = parseSpec(u.searchParams.get("b"), { venue: "binance", market: "spot" });
  if (!a || !b) return NextResponse.json({ error: "거래소 지정이 올바르지 않습니다 (원화 거래소는 선물 없음)" }, { status: 400 });

  const unitRaw = Number(u.searchParams.get("unit") ?? 3);
  const unit = (UNITS.includes(unitRaw as Unit) ? unitRaw : 3) as Unit;
  const count = Math.max(20, Math.min(2000, Number(u.searchParams.get("count") ?? 400)));

  try {
    const ttl = Math.min(300_000, Math.max(15_000, unit * 60_000 / 4));
    const s = await cached(`${coin}|${a.venue}:${a.market}|${b.venue}:${b.market}|${unit}|${count}`, ttl, () => premiumSeries(coin, a, b, unit, count));
    if (!s.points.length) {
      return NextResponse.json({ error: `${coin}: 두 거래소에 겹치는 봉이 없습니다 (한쪽 미상장이거나 거래 없음)` }, { status: 200 });
    }
    return NextResponse.json(s);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "조회 실패" }, { status: 200 });
  }
}
