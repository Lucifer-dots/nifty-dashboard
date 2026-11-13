"""FastAPI app: read-only market analytics. There are no order, broker or execution endpoints."""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import analytics as A
from . import sources as S

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")
ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

app = FastAPI(title="Rythem Market Analytics", docs_url="/api/docs")


def safe(fn, *a, **k):
    try:
        return fn(*a, **k)
    except Exception as e:  # never 500 with a fake payload; say what failed
        log.exception("endpoint failed")
        return A.fail(f"{type(e).__name__}: {e}", fn.__name__)


@app.get("/api/status")
def api_status():
    return safe(A.status)


@app.get("/api/indices")
def api_indices():
    return safe(A.indices)


@app.get("/api/flow")
def api_flow():
    return safe(A.stock_flow)


@app.get("/api/options")
def api_options(symbol: str = Query("NIFTY", pattern="^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY)$"), width: int = 10):
    return safe(A.option_chain, symbol, min(max(width, 3), 25))


@app.get("/api/setups")
def api_setups():
    return safe(A.setups)


@app.get("/api/candles")
def api_candles(symbol: str = "NIFTY", interval: str = Query("5m", pattern="^(5m|1d)$")):
    return safe(A.candles, symbol, interval)


@app.get("/api/calm")
def api_calm():
    return safe(A.calm_zone)


@app.get("/api/screener")
def api_screener():
    return safe(A.screener)


@app.get("/api/global")
def api_global():
    return safe(A.global_assets)


@app.get("/api/pretrade")
def api_pretrade():
    return safe(A.pretrade)


@app.get("/healthz")
def health():
    return {"ok": True, "time": S.ist_str()}


@app.get("/")
def index():
    return FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/sw.js")
def sw():
    return FileResponse(ROOT / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(ROOT / "manifest.webmanifest", media_type="application/manifest+json")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ---------------------------------------------------------------- background refresher
def refresher():
    time.sleep(2)
    while True:
        t0 = time.time()
        for fn in (A.status, A.indices, A.stock_flow, lambda: A.option_chain("NIFTY"),
                   lambda: A.option_chain("BANKNIFTY"), A.setups, A.calm_zone, A.screener, A.global_assets):
            try:
                fn()
            except Exception as e:
                log.warning("refresh failed: %s", e)
        log.info("refresh cycle %.1fs (market open by clock: %s)", time.time() - t0, S.market_open_by_clock())
        time.sleep(60 if S.market_open_by_clock() else 600)


@app.on_event("startup")
def start_bg():
    threading.Thread(target=refresher, daemon=True).start()
