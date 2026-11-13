"""Money flow + order blocks (smart-money concepts). Read-only analytics on real Yahoo/NSE data.

Definitions (shown on the page so nothing is a black box):
  * Turnover = close x volume (Rs). Sector inflow = turnover of stocks up today, outflow = turnover of
    stocks down today, net = inflow - outflow. A proxy for direction of traded money, not actual buyer/seller ledgers.
  * Index volume is not published intraday by Yahoo, so NIFTY / BANKNIFTY MFI and cumulative delta use the
    summed 5-min turnover of their constituents (NIFTY 50 stocks; listed bank stocks) as volume.
  * Cumulative delta proxy: sum over bars of turnover x close-location value ((C-L)-(H-C))/(H-L).
  * Order block: the last opposite-colour candle before a displacement move that closes beyond the most
    recent confirmed swing (break of structure). Displacement = BOS close is >=1.0 ATR beyond the block and
    >=1.5 ATR from the move's first open. Mitigated = price later traded back into the zone; broken = closed through it.
"""
from __future__ import annotations

import io
import logging

import numpy as np
import pandas as pd
import requests

from . import sources as S

log = logging.getLogger("smc")
BANKS = ["HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "INDUSINDBK", "BANKBARODA",
         "PNB", "FEDERALBNK", "AUBANK", "IDFCFIRSTB", "CANBK"]


def _r(x, n=2):
    try:
        x = float(x)
        return None if np.isnan(x) or np.isinf(x) else round(x, n)
    except Exception:
        return None


def _ct(ts) -> int:  # chart time: epoch seconds shifted so the axis reads IST
    return int(pd.Timestamp(ts).timestamp()) + 19800


# --------------------------------------------------------------------------- universes
def _fetch_list(url):
    import time as _t
    for attempt in range(3):
        try:
            r = requests.get(url, headers={"User-Agent": S.NSEClient.HEADERS["User-Agent"],
                                           "Accept": "text/csv,*/*", "Referer": "https://www.nseindia.com/"}, timeout=20)
            r.raise_for_status()
            df = pd.read_csv(io.StringIO(r.text))
            return {str(a).strip(): str(b).strip() for a, b in zip(df["Symbol"], df["Industry"])}
        except Exception as e:
            log.warning("list %s attempt %d failed: %s", url, attempt + 1, e)
            _t.sleep(1.5 * (attempt + 1))
    return None


def nifty500_industries() -> tuple[dict[str, str], str]:
    """(symbol -> industry, universe label). NIFTY 500 cached a day; a NIFTY 50 fallback is retried after 10 min."""
    def n500():
        m = _fetch_list("https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv")
        if not m or len(m) < 400:
            raise RuntimeError("NIFTY 500 list unavailable")
        return m
    try:
        return S.CACHE.get_or_set("nse:n500ind", 86400, n500), "NIFTY 500"
    except Exception:
        pass
    def n50():
        m = _fetch_list("https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv")
        if not m or len(m) < 45:
            raise RuntimeError("NSE index constituent lists unavailable")
        return m
    return S.CACHE.get_or_set("nse:n50ind", 600, n50), "NIFTY 50 (NIFTY 500 list unavailable right now)"


# --------------------------------------------------------------------------- money flow
def _session(df):
    d = df.index[-1].date()
    return df[df.index.date == d]


def _mfi_delta(index_df, comps: dict, n=14):
    """MFI(14) and cumulative delta on the latest session, with volume = summed constituent turnover."""
    day = _session(index_df)
    if day.empty:
        return None
    turn = pd.Series(0.0, index=day.index)
    delta = pd.Series(0.0, index=day.index)
    used = 0
    for _s, d in comps.items():
        d = d[d.index.date == day.index[-1].date()].reindex(day.index)
        if d["Close"].notna().sum() < 3:
            continue
        used += 1
        t = (d["Close"] * d["Volume"]).fillna(0)
        rng = (d["High"] - d["Low"]).replace(0, np.nan)
        clv = (((d["Close"] - d["Low"]) - (d["High"] - d["Close"])) / rng).fillna(0)
        turn += t
        delta += t * clv
    if not used or turn.sum() <= 0:
        return None
    tp = (day["High"] + day["Low"] + day["Close"]) / 3
    raw = tp * turn
    up = raw.where(tp.diff() > 0, 0.0)
    dn = raw.where(tp.diff() < 0, 0.0)
    mfi = 100 - 100 / (1 + up.rolling(n).sum() / dn.rolling(n).sum().replace(0, np.nan))
    cum = delta.cumsum() / 1e7  # Rs crore
    series = [{"time": _ct(t), "mfi": _r(m, 1), "cd": _r(c, 1), "close": _r(cl)}
              for t, m, c, cl in zip(day.index, mfi, cum, day["Close"])]
    last_mfi = next((s["mfi"] for s in reversed(series) if s["mfi"] is not None), None)
    state = None if last_mfi is None else ("OVERBOUGHT (>80)" if last_mfi > 80 else "OVERSOLD (<20)" if last_mfi < 20
                                           else "BUYING PRESSURE" if last_mfi >= 55 else "SELLING PRESSURE" if last_mfi <= 45 else "NEUTRAL")
    return {"mfi": last_mfi, "mfi_state": state, "cum_delta_cr": series[-1]["cd"], "turnover_cr": _r(turn.sum() / 1e7, 0),
            "constituents": used, "series": series, "date": day.index[-1].strftime("%d-%b-%Y"),
            "as_of": day.index[-1].strftime("%d-%b-%Y %H:%M IST")}


def money_flow():
    from . import analytics as A
    out, errors = {}, []
    # 1) sector inflow / outflow (NIFTY 500)
    try:
        ind, universe = nifty500_industries()
        syms = [s + ".NS" for s in ind]
        px = S.yf_download(syms, "5d", "1d", f"yf:secd:{len(syms)}", S.ttl(300, 3600))
        sec, tot_in, tot_out, as_of = {}, 0.0, 0.0, None
        for s, industry in ind.items():
            d = px.get(s + ".NS")
            if d is None or len(d) < 2 or not d["Volume"].iloc[-1]:
                continue
            last, prev, vol = float(d["Close"].iloc[-1]), float(d["Close"].iloc[-2]), float(d["Volume"].iloc[-1])
            t, pc = last * vol, (last / prev - 1) * 100
            as_of = max(as_of or d.index[-1], d.index[-1])
            x = sec.setdefault(industry, {"sector": industry, "inflow": 0.0, "outflow": 0.0, "up": 0, "down": 0, "wpct": 0.0, "turn": 0.0, "top": []})
            if pc >= 0:
                x["inflow"] += t; x["up"] += 1; tot_in += t
            else:
                x["outflow"] += t; x["down"] += 1; tot_out += t
            x["wpct"] += pc * t; x["turn"] += t
            x["top"].append((t * (1 if pc >= 0 else -1), s, _r(pc)))
        rows = []
        for x in sec.values():
            top = sorted(x["top"], key=lambda z: -abs(z[0]))[:3]
            rows.append({"sector": x["sector"], "inflow_cr": _r(x["inflow"] / 1e7, 0), "outflow_cr": _r(x["outflow"] / 1e7, 0),
                         "net_cr": _r((x["inflow"] - x["outflow"]) / 1e7, 0), "up": x["up"], "down": x["down"],
                         "pct": _r(x["wpct"] / x["turn"]) if x["turn"] else None,
                         "leaders": [{"symbol": s, "pct": p} for _, s, p in top]})
        rows.sort(key=lambda r: r["net_cr"] or 0, reverse=True)
        out["sectors"] = {"rows": rows, "inflow_cr": _r(tot_in / 1e7, 0), "outflow_cr": _r(tot_out / 1e7, 0),
                          "net_cr": _r((tot_in - tot_out) / 1e7, 0), "stocks": sum(r["up"] + r["down"] for r in rows), "universe": universe,
                          "as_of": as_of.strftime("%d-%b-%Y") + " (daily bars, Yahoo)" if as_of is not None else None}
    except Exception as e:
        errors.append(f"sector flow: {e}")
        out["sectors"] = None
    # 2) F&O build-up counts + turnover
    try:
        fl = A.stock_flow()
        if not fl["ok"]:
            raise RuntimeError(fl.get("error"))
        stocks = fl["data"]["stocks"]
        vol = S.yf_download([s["symbol"] + ".NS" for s in stocks], "5d", "1d", "yf:fo_daily", S.ttl(120, 1800))
        agg = {k: {"tag": k, "count": 0, "turnover_cr": 0.0} for k in
               ("LONG BUILD-UP", "SHORT COVERING", "SHORT BUILD-UP", "LONG UNWINDING")}
        for s in stocks:
            if s["tag"] not in agg:
                continue
            a = agg[s["tag"]]
            a["count"] += 1
            d = vol.get(s["symbol"] + ".NS")
            if d is not None and len(d):
                a["turnover_cr"] += float(d["Close"].iloc[-1]) * float(d["Volume"].iloc[-1]) / 1e7
        for a in agg.values():
            a["turnover_cr"] = _r(a["turnover_cr"], 0)
        bull = agg["LONG BUILD-UP"]["turnover_cr"] + agg["SHORT COVERING"]["turnover_cr"]
        bear = agg["SHORT BUILD-UP"]["turnover_cr"] + agg["LONG UNWINDING"]["turnover_cr"]
        out["fno"] = {"tags": list(agg.values()), "bull_cr": _r(bull, 0), "bear_cr": _r(bear, 0),
                      "as_of": fl["data"]["nse_oi_timestamp"], "source": fl["source"] + " + Yahoo volume"}
    except Exception as e:
        errors.append(f"F&O build-up: {e}")
        out["fno"] = None
    # 3) intraday MFI + cumulative delta for NIFTY / BANKNIFTY
    out["intraday"] = {}
    try:
        intra = A.intraday_all()
        n50 = {s: intra[s + ".NS"] for s in S.nifty50_symbols() if s + ".NS" in intra}
        out["intraday"]["NIFTY"] = _mfi_delta(intra["^NSEI"], n50) if "^NSEI" in intra else None
        banks = S.yf_download([b + ".NS" for b in BANKS] + ["^NSEBANK"], "5d", "5m", "yf:bank5m", S.ttl(60, 900))
        out["intraday"]["BANKNIFTY"] = _mfi_delta(banks["^NSEBANK"], {k: v for k, v in banks.items() if k != "^NSEBANK"}) \
            if "^NSEBANK" in banks else None
    except Exception as e:
        errors.append(f"intraday MFI: {e}")
    if not out.get("sectors") and not out.get("fno") and not any(out["intraday"].values()):
        return A.fail("; ".join(errors), "money flow")
    out["errors"] = errors
    out["method"] = __doc__.split("Definitions")[1].strip()
    return A.ok(out, "Yahoo (NIFTY 500 daily, 5-min) + NSE OI")


# --------------------------------------------------------------------------- order blocks
def resample15(df):
    return df.resample("15min").agg({"Open": "first", "High": "max", "Low": "min", "Close": "last",
                                     "Volume": "sum"}).dropna(subset=["Close"])


def find_order_blocks(df: pd.DataFrame, tf: str, swing=2, atr_n=14):
    if df is None or len(df) < atr_n + 2 * swing + 3:
        return []
    o, h, l, c = (df[k].to_numpy(float) for k in ("Open", "High", "Low", "Close"))
    idx = df.index
    n = len(df)
    tr = np.maximum(h - l, np.maximum(abs(h - np.roll(c, 1)), abs(l - np.roll(c, 1))))
    tr[0] = h[0] - l[0]
    atr = pd.Series(tr).rolling(atr_n, min_periods=5).mean().to_numpy()
    blocks, used = [], set()
    sh = sl = None  # [index, price, broken]
    for j in range(n):
        s = j - swing
        if s >= swing:
            if h[s] > h[s - swing:s].max() and h[s] >= h[s + 1:j + 1].max():
                sh = [s, h[s], False]
            if l[s] < l[s - swing:s].min() and l[s] <= l[s + 1:j + 1].min():
                sl = [s, l[s], False]
        a = atr[j]
        if not a or np.isnan(a):
            continue
        if sh and not sh[2] and c[j] > sh[1]:
            sh[2] = True
            k = next((t for t in range(j - 1, max(j - 8, -1), -1) if c[t] < o[t]), None)
            if k is not None and k not in used and c[j] - h[k] >= a and c[j] - o[k + 1] >= 1.5 * a:
                used.add(k)
                blocks.append({"type": "BULL", "k": k, "j": j, "top": h[k], "bottom": l[k]})
        if sl and not sl[2] and c[j] < sl[1]:
            sl[2] = True
            k = next((t for t in range(j - 1, max(j - 8, -1), -1) if c[t] > o[t]), None)
            if k is not None and k not in used and l[k] - c[j] >= a and o[k + 1] - c[j] >= 1.5 * a:
                used.add(k)
                blocks.append({"type": "BEAR", "k": k, "j": j, "top": h[k], "bottom": l[k]})
    ltp = c[-1]
    out = []
    for b in blocks:
        status, when = "ACTIVE", None
        for t in range(b["j"] + 1, n):
            if b["type"] == "BULL":
                if c[t] < b["bottom"]:
                    status, when = "BROKEN", t
                    break
                if status == "ACTIVE" and l[t] <= b["top"]:
                    status, when = "MITIGATED", t
            else:
                if c[t] > b["top"]:
                    status, when = "BROKEN", t
                    break
                if status == "ACTIVE" and h[t] >= b["bottom"]:
                    status, when = "MITIGATED", t
        dist = (ltp - b["top"]) / ltp * 100 if b["type"] == "BULL" else (b["bottom"] - ltp) / ltp * 100
        out.append({"type": b["type"], "tf": tf, "top": _r(b["top"]), "bottom": _r(b["bottom"]),
                    "formed": idx[b["k"]].strftime("%d-%b %H:%M"), "formed_t": _ct(idx[b["k"]]),
                    "bos": idx[b["j"]].strftime("%d-%b %H:%M"), "status": status,
                    "status_at": idx[when].strftime("%d-%b %H:%M") if when is not None else None,
                    "status_t": _ct(idx[when]) if when is not None else None,
                    "ltp": _r(ltp), "dist_pct": _r(dist)})
    return out


def blocks_for(df5: pd.DataFrame):
    return find_order_blocks(df5, "5m") + find_order_blocks(resample15(df5), "15m")


def order_blocks():
    from . import analytics as A
    try:
        intra = A.intraday_all()
    except Exception as e:
        return A.fail(e, "Yahoo 5-min")
    allb, as_of = [], None
    for ys, df in intra.items():
        name = A.pretty(ys)
        for b in blocks_for(df):
            b["symbol"] = name
            allb.append(b)
        as_of = max(as_of or df.index[-1], df.index[-1])
    active = sorted([b for b in allb if b["status"] == "ACTIVE"], key=lambda b: abs(b["dist_pct"] or 99))
    mitig = sorted([b for b in allb if b["status"] != "ACTIVE"], key=lambda b: b["status_t"] or 0, reverse=True)
    idx_first = sorted(active, key=lambda b: (b["symbol"] not in ("NIFTY", "BANKNIFTY")))
    return A.ok({"active": idx_first, "recent_mitigated": mitig[:40],
                 "counts": {"active": len(active), "bull": sum(b["type"] == "BULL" for b in active),
                            "bear": sum(b["type"] == "BEAR" for b in active), "mitigated_or_broken": len(mitig)},
                 "universe": "NIFTY, BANKNIFTY + NIFTY 50 stocks, last 5 sessions, 5m and 15m",
                 "method": "Last opposite candle before a displacement that breaks the latest swing high/low "
                           "(>=1 ATR beyond the block, >=1.5 ATR move). ACTIVE = price has not returned into the zone; "
                           "MITIGATED = price traded back into it; BROKEN = a close through the far side."},
                "Yahoo 5-min (15m resampled)", as_of=as_of.strftime("%d-%b-%Y %H:%M IST") if as_of is not None else None)
