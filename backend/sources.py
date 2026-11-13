"""Data sources: NSE public JSON (cookie warm-up session) and Yahoo Finance (yfinance).

Every fetch is cached. Nothing here invents numbers: on failure we raise, and the
API layer turns that into an explicit {"ok": false, "error": ...} payload.
"""
from __future__ import annotations

import io
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests
import yfinance as yf

log = logging.getLogger("sources")
IST = timezone(timedelta(hours=5, minutes=30))


def now_ist() -> datetime:
    return datetime.now(IST)


def ist_str(dt: datetime | None = None) -> str:
    return (dt or now_ist()).astimezone(IST).strftime("%d-%b-%Y %H:%M:%S IST")


# --------------------------------------------------------------------------- cache
class TTLCache:
    def __init__(self):
        self._d: dict[str, tuple[float, object]] = {}
        self._lock = threading.Lock()
        self._key_locks: dict[str, threading.Lock] = {}

    def get_or_set(self, key: str, ttl: float, fn):
        with self._lock:
            hit = self._d.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1]
            klock = self._key_locks.setdefault(key, threading.Lock())
        with klock:  # one fetch per key at a time
            with self._lock:
                hit = self._d.get(key)
                if hit and time.time() - hit[0] < ttl:
                    return hit[1]
            val = fn()
            with self._lock:
                self._d[key] = (time.time(), val)
            return val

    def last(self, key: str):
        with self._lock:
            return self._d.get(key)


CACHE = TTLCache()


# --------------------------------------------------------------------------- market clock
def market_open_by_clock(t: datetime | None = None) -> bool:
    t = t or now_ist()
    if t.weekday() >= 5:
        return False
    m = t.hour * 60 + t.minute
    return 9 * 60 + 15 <= m <= 15 * 60 + 30


def ttl(open_ttl: float = 60, closed_ttl: float = 900) -> float:
    return open_ttl if market_open_by_clock() else closed_ttl


# --------------------------------------------------------------------------- NSE
class NSEClient:
    BASE = "https://www.nseindia.com"
    HEADERS = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.nseindia.com/option-chain",
    }

    def __init__(self):
        self.s: requests.Session | None = None
        self.warmed_at = 0.0
        self.lock = threading.Lock()
        self.last_error: str | None = None
        self.last_ok: float | None = None
        self.dead_until = 0.0  # after a full failure, fail fast for a while instead of hammering NSE

    def _warm(self):
        s = requests.Session()
        s.headers.update(self.HEADERS)
        s.get(self.BASE + "/option-chain", timeout=15)
        self.s, self.warmed_at = s, time.time()

    def get(self, path: str):
        with self.lock:
            if time.time() < self.dead_until:
                raise RuntimeError(f"NSE unavailable ({self.last_error})")
            for attempt in range(3):
                try:
                    if self.s is None or time.time() - self.warmed_at > 240 or attempt > 0:
                        self._warm()
                    r = self.s.get(self.BASE + path, timeout=15)
                    if r.status_code == 200 and r.text.lstrip().startswith(("{", "[")):
                        data = r.json()
                        if data:  # NSE sometimes answers {} when the cookie is stale
                            self.last_ok, self.last_error = time.time(), None
                            return data
                    self.last_error = f"HTTP {r.status_code} on {path}"
                except Exception as e:  # network / JSON errors
                    self.last_error = f"{type(e).__name__}: {e}"
                time.sleep(1.0 + attempt)
            self.dead_until = time.time() + 120
            raise RuntimeError(f"NSE unavailable ({self.last_error})")


NSE = NSEClient()


def nse_market_status():
    return CACHE.get_or_set("nse:mstatus", 60, lambda: NSE.get("/api/marketStatus"))


def nse_all_indices():
    return CACHE.get_or_set("nse:allidx", ttl(45, 600), lambda: NSE.get("/api/allIndices"))


def nse_oi_spurts():
    return CACHE.get_or_set("nse:oispurts", ttl(60, 900),
                            lambda: NSE.get("/api/live-analysis-oi-spurts-underlyings"))


def nse_option_chain(symbol: str):
    def fetch():
        info = NSE.get(f"/api/option-chain-contract-info?symbol={symbol}")
        expiry = info["expiryDates"][0]
        oc = NSE.get(f"/api/option-chain-v3?type=Indices&symbol={symbol}&expiry={expiry}")
        oc["_expiry"] = expiry
        oc["_all_expiries"] = info["expiryDates"][:6]
        return oc
    return CACHE.get_or_set(f"nse:oc:{symbol}", ttl(60, 900), fetch)


NIFTY50_FALLBACK = (
    "ADANIENT ADANIPORTS APOLLOHOSP ASIANPAINT AXISBANK BAJAJ-AUTO BAJFINANCE BAJAJFINSV BEL "
    "BHARTIARTL CIPLA COALINDIA DRREDDY EICHERMOT ETERNAL GRASIM HCLTECH HDFCBANK HDFCLIFE HINDALCO "
    "HINDUNILVR ICICIBANK INDIGO INFY ITC JIOFIN JSWSTEEL KOTAKBANK LT M&M MARUTI MAXHEALTH NESTLEIND "
    "NTPC ONGC POWERGRID RELIANCE SBILIFE SBIN SHRIRAMFIN SUNPHARMA TATACONSUM TMPV TATASTEEL TCS "
    "TECHM TITAN TRENT ULTRACEMCO WIPRO").split()


def nifty50_symbols() -> list[str]:
    def fetch():
        try:
            r = requests.get("https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv",
                             headers={"User-Agent": NSEClient.HEADERS["User-Agent"]}, timeout=15)
            r.raise_for_status()
            df = pd.read_csv(io.StringIO(r.text))
            syms = [s.strip() for s in df["Symbol"].tolist()]
            if len(syms) >= 45:
                return syms
        except Exception as e:
            log.warning("nifty50 list fetch failed: %s", e)
        return NIFTY50_FALLBACK
    return CACHE.get_or_set("nse:n50", 86400, fetch)


# --------------------------------------------------------------------------- Yahoo
YF_LOCK = threading.Lock()


def yf_download(symbols: list[str], period: str, interval: str, key: str, ttl_s: float):
    """Batch download, returns dict symbol -> DataFrame (OHLCV, tz-aware IST index for intraday)."""
    def fetch():
        with YF_LOCK:
            df = yf.download(symbols, period=period, interval=interval, group_by="ticker",
                             progress=False, threads=True, auto_adjust=False)
        out = {}
        for s in symbols:
            try:
                sub = df[s] if len(symbols) > 1 or isinstance(df.columns, pd.MultiIndex) else df
                sub = sub.dropna(subset=["Close"])
                if sub.empty:
                    continue
                if sub.index.tz is not None:
                    sub = sub.tz_convert("Asia/Kolkata")
                out[s] = sub
            except Exception:
                continue
        if not out:
            raise RuntimeError("Yahoo Finance returned no data")
        return out
    return CACHE.get_or_set(key, ttl_s, fetch)
