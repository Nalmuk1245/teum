# arb-cockpit

Personal, semi-automated **arbitrage cockpit** — a separate Next.js app (not
part of coin-tracker). Scans four arbitrage strategies into one ranked board and
lets you **one-click execute** a chosen opportunity after a confirm step.

Runs on **:3100** (`npm run dev`) so it never clashes with coin-tracker (:3000).

## Strategies (`lib/strategies.ts`)
| kind | status | source |
|------|--------|--------|
| `kimchi` | ✅ wired | Upbit KRW vs Binance USDT premium (÷ USD/KRW) |
| `cross-cex` | 🚧 stub | price gap across binance/bybit/okx |
| `funding-basis` | 🚧 stub | perp funding vs spot (cash-and-carry) |
| `cex-dex` | 🚧 stub | CEX price vs DEX router quote |

`USE_MOCK=true` injects one sample opportunity per kind so the board + execute
flow work end-to-end before live data/keys.

## Architecture
- `lib/types.ts` — `Opportunity`, `Strategy`, `ExchangeAdapter`, `ExecReport`.
- `lib/exchanges.ts` — venue adapters (public tickers wired; `placeOrder` stubbed).
- `lib/strategies.ts` — the four strategy modules behind one interface.
- `lib/scanner.ts` — prefetch tickers once → run all strategies → merge + rank.
- `lib/execution.ts` — one-click executor, hard-gated by `DRY_RUN`.
- `app/api/scan` · `app/api/execute` — REST endpoints.
- `app/page.tsx` — the cockpit dashboard (board, filters, execute modal).

## Safety
- `DRY_RUN=true` (default): `/api/execute` **simulates** fills, never sends an order.
- API keys live only in `.env.local` (gitignored). Copy `.env.example`.
- Upbit 403s non-Korean IPs → kimchi needs a KR region/relay for live data.

## Next steps
1. Add a `MAX_ABS_PREMIUM` / depth-based `notionalCapUsd` (real size).
2. Wire `cross-cex` (add bybit/okx adapters) — cheapest real strategy to finish.
3. Sign `placeOrder` for binance/upbit, then flip `DRY_RUN=false` behind tests.
4. `transferStatus` gate (deposits/withdrawals enabled) before marking executable.
