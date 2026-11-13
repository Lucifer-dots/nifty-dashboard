# RA Market Pulse: NIFTY / SENSEX / Gold analytics dashboard

A read-only market analytics dashboard in the style of the Verquo AI reel.
**It has no order placement, no broker login and no trade execution.** Every number comes from a live
source. When a source fails, the UI shows a red **DATA UNAVAILABLE** badge; it never shows a guess.
*Educational only. Not investment advice.*

## Live site (GitHub Pages)
- **Site:** https://lucifer-dots.github.io/nifty-dashboard/. It is a static page served from the `gh-pages` branch.
- **Data:** `.github/workflows/refresh.yml` runs `tools/build_static.py` every 5 minutes, 09:00–15:45 IST, Monday to Friday, plus a 17:00 IST closing snapshot. Each run force-pushes the JSON snapshot as one commit to the `data` branch. The page reads that snapshot from raw.githubusercontent.com and shows how old it is. GitHub may delay scheduled runs by several minutes.
- **Manual refresh:** Actions → refresh-data → Run workflow.
- No secrets are stored in this repository. The workflow uses only the built-in, short-lived `GITHUB_TOKEN`.

## Run locally
```bash
git clone https://github.com/Lucifer-dots/nifty-dashboard && cd nifty-dashboard
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./run.sh start          # starts the server on http://localhost:8787 (background, survives the shell)
./run.sh status         # health check
./run.sh stop
TUNNEL=1 ./run.sh start # also tries a free Cloudflare quick tunnel (needs outbound port 7844)
.venv/bin/python shoot.py   # re-takes screenshots into screenshots/
```
Logs: `logs/server.log`, `logs/tunnel.log`. API docs: `/api/docs`.

## Tabs
| Tab | What it shows | Source |
|---|---|---|
| Pre-Trade | 3 checks: (1) market mood (money in or out) from NIFTY 500 breadth, F&O OI build-up mix and NIFTY PCR; (2) NIFTY floor and ceiling from the OI walls, max pain and the previous day's high, low and close; (3) the latest rule setups, with why they qualified and where the stop is | combined |
| Market Flow | Index cards, advance/decline breadth bars, F&O build-up mix, and a stock list tagged LONG BUILD-UP, SHORT COVERING, SHORT BUILD-UP or LONG UNWINDING (price % vs OI %) | NSE allIndices + NSE OI spurts + Yahoo |
| Option Pulse | NIFTY, BANKNIFTY and FINNIFTY chain at ±10 strikes around ATM (nearest expiry), PCR, max call and put OI walls, walls within ±2% of spot, max pain | NSE option-chain-v3 |
| Setups | Rule alerts on 5-min candles for NIFTY, BANKNIFTY and the NIFTY 50 stocks. Tap one to open a candlestick chart with VWAP, trigger and stop | Yahoo 5m |
| Calm Zone | Tiles with sparklines: today's range divided by the 14-day ATR (CALM < 0.6, VOLATILE > 1.0) | Yahoo 5m + daily |
| Screener | RSI(14) < 30 and > 70, MACD signal crosses in the last 3 sessions, Minervini trend template (7 of 8 rules) | Yahoo daily 1y |
| Gold & BTC | COMEX gold (GC=F) as the XAUUSD proxy plus a ₹/10 g conversion (excludes duty, so it is not an MCX quote), BTC-USD, USD/INR | Yahoo |

## Setup rules
- **FIRST 5-MIN BREAK:** a candle closes beyond the high or low of the 09:15–09:20 candle, and the next candle's close holds. The stop is the other end of the first candle. Only the side that breaks first is used.
- **VWAP RECLAIM / LOSS:** 3 or more closes on one side of VWAP, then a close at least 0.1% across it, and the next close holds. The stop is the swing extreme. Indices have no volume on Yahoo, so they use the running average of the typical price, labelled "ATP".
- **LATE STRENGTH / WEAKNESS:** after 14:00, a close at a new day high (or low) on the right side of VWAP, with the day's move above 1%. The stop is at VWAP.

## Data notes
- NSE JSON needs a cookie warm-up. The client warms up again every 4 minutes or on any failure, and retries 3 times.
- Refresh: a background loop every 60 s during market hours (09:15–15:30 IST, Mon–Fri) and every 10 min otherwise. The browser polls every 60 s. Outside market hours you see the last session's data, with its IST timestamp.
- If NSE blocks the request, indices fall back to Yahoo. The option chain, OI flow and PCR show "data unavailable". MIDCAP SELECT has no usable Yahoo series.
- The NIFTY 50 list comes from the NSE archives CSV, with a hard-coded fallback.
- PWA: there is a manifest and a service worker that caches only the app shell (API calls always go to the network). On Android Chrome, use "Add to Home screen". iOS Safari needs HTTPS for the service worker.

## Layout
`backend/sources.py` (NSE session, Yahoo, TTL cache) · `backend/analytics.py` (all metrics + rule engine) ·
`backend/app.py` (FastAPI routes + refresher) · `index.html`, `sw.js`, `manifest.webmanifest` and `static/` (app.js, style.css, icons, vendored lightweight-charts 4.2.0) · `tools/build_static.py` (JSON snapshot for static hosting).
