"""Analytics + rule engine. Pure functions over data from sources.py. No order placement anywhere."""
from __future__ import annotations

import math
from datetime import datetime

import numpy as np
import pandas as pd

from . import sources as S

INDEX_CARDS = [  # (label, NSE allIndices name, yahoo fallback)
    ("NIFTY 50", "NIFTY 50", "^NSEI"),
    ("BANK NIFTY", "NIFTY BANK", "^NSEBANK"),
    ("FIN NIFTY", "NIFTY FINANCIAL SERVICES", "NIFTY_FIN_SERVICE.NS"),
    ("SENSEX", None, "^BSESN"),
    ("MIDCAP SELECT", "NIFTY MIDCAP SELECT", "NIFTY_MID_SELECT.NS"),
    ("INDIA VIX", "INDIA VIX", "^INDIAVIX"),
]
INDEX_YF = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK"}


def _r(x, n=2):
    if x is None:
        return None
    try:
        if isinstance(x, str):
            x = float(x.replace(",", ""))
        if math.isnan(x) or math.isinf(x):
            return None
        return round(float(x), n)
    except Exception:
        return None


def ok(data, source, as_of=None, **extra):
    return {"ok": True, "source": source, "as_of": as_of or S.ist_str(), **extra, "data": data}


def fail(err, source):
    return {"ok": False, "source": source, "error": str(err), "as_of": S.ist_str(), "data": None}


# --------------------------------------------------------------------------- status
def status():
    out = {"server_time": S.ist_str(), "market_open_by_clock": S.market_open_by_clock()}
    try:
        ms = S.nse_market_status()
        cm = next(m for m in ms["marketState"] if m["market"] == "Capital Market")
        out["nse_market_status"] = cm["marketStatus"]
        out["nse_trade_date"] = cm["tradeDate"]
        out["nse_message"] = cm.get("marketStatusMessage")
        out["nse_ok"] = True
    except Exception as e:
        out["nse_ok"] = False
        out["nse_error"] = str(e)
    out["nse_last_error"] = S.NSE.last_error
    return out


# --------------------------------------------------------------------------- indices
def indices():
    cards, errors, nse_ts = [], [], None
    allidx = None
    try:
        allidx = S.nse_all_indices()
        nse_ts = allidx.get("timestamp")
    except Exception as e:
        errors.append(f"NSE allIndices: {e}")
    yf_syms = [c[2] for c in INDEX_CARDS]
    yfd = {}
    try:
        yfd = S.yf_download(yf_syms, "5d", "1d", "yf:idx", S.ttl(60, 900))
    except Exception as e:
        errors.append(f"Yahoo: {e}")
    for label, nse_name, ysym in INDEX_CARDS:
        card = {"label": label, "ok": False}
        row = None
        if allidx and nse_name:
            row = next((x for x in allidx["data"] if x["index"] == nse_name), None)
        if row:
            card.update(ok=True, last=_r(row["last"]), change=_r(row["variation"]), pct=_r(row["percentChange"]),
                        prev_close=_r(row["previousClose"]), open=_r(row.get("open")), high=_r(row.get("high")),
                        low=_r(row.get("low")), advances=row.get("advances"), declines=row.get("declines"),
                        source="NSE", as_of=f"{nse_ts} IST")
        elif ysym in yfd and len(yfd[ysym]) >= 2:
            d = yfd[ysym]
            last, prev = float(d["Close"].iloc[-1]), float(d["Close"].iloc[-2])
            card.update(ok=True, last=_r(last), change=_r(last - prev), pct=_r((last / prev - 1) * 100),
                        prev_close=_r(prev), open=_r(d["Open"].iloc[-1]), high=_r(d["High"].iloc[-1]),
                        low=_r(d["Low"].iloc[-1]), source="Yahoo", as_of=d.index[-1].strftime("%d-%b-%Y") + " (daily bar)")
        cards.append(card)
    breadth = None
    if allidx:
        n500 = next((x for x in allidx["data"] if x["index"] == "NIFTY 500"), None)
        breadth = {
            "nifty500_adv": int(n500["advances"]) if n500 else None,
            "nifty500_dec": int(n500["declines"]) if n500 else None,
            "all_adv": allidx.get("advances"), "all_dec": allidx.get("declines"),
            "as_of": f"{nse_ts} IST",
        }
    if not any(c["ok"] for c in cards):
        return fail("; ".join(errors), "NSE+Yahoo")
    return ok({"cards": cards, "breadth": breadth, "errors": errors}, "NSE allIndices / Yahoo")


# --------------------------------------------------------------------------- stock flow (price vs OI)
def classify(price_pct, oi_pct):
    if price_pct is None or oi_pct is None:
        return None
    if price_pct >= 0 and oi_pct >= 0:
        return "LONG BUILD-UP"
    if price_pct >= 0 and oi_pct < 0:
        return "SHORT COVERING"
    if price_pct < 0 and oi_pct >= 0:
        return "SHORT BUILD-UP"
    return "LONG UNWINDING"


def stock_flow():
    try:
        sp = S.nse_oi_spurts()
    except Exception as e:
        return fail(e, "NSE OI spurts")
    rows = [x for x in sp["data"] if x["symbol"] not in
            ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "NIFTYFPI")]
    syms = [x["symbol"] + ".NS" for x in rows]
    try:
        px = S.yf_download(syms, "5d", "1d", "yf:fo_daily", S.ttl(120, 1800))
    except Exception as e:
        return fail(f"price change unavailable: {e}", "Yahoo")
    out = []
    for x in rows:
        d = px.get(x["symbol"] + ".NS")
        if d is None or len(d) < 2:
            continue
        last, prev = float(d["Close"].iloc[-1]), float(d["Close"].iloc[-2])
        price_pct = (last / prev - 1) * 100
        oi_pct = (x["changeInOI"] / x["prevOI"] * 100) if x.get("prevOI") else None
        out.append({"symbol": x["symbol"], "ltp": _r(last), "price_pct": _r(price_pct),
                    "oi_pct": _r(oi_pct), "oi_change": x["changeInOI"], "latest_oi": x["latestOI"],
                    "tag": classify(price_pct, oi_pct)})
    counts = {k: sum(1 for r in out if r["tag"] == k) for k in
              ("LONG BUILD-UP", "SHORT COVERING", "SHORT BUILD-UP", "LONG UNWINDING")}
    out.sort(key=lambda r: abs(r["oi_pct"] or 0), reverse=True)
    return ok({"stocks": out, "counts": counts, "nse_oi_timestamp": sp.get("timestamp") + " IST",
               "note": "OI = NSE F&O open interest change vs previous day; price % from Yahoo vs previous close."},
              "NSE OI spurts + Yahoo")


# --------------------------------------------------------------------------- option chain
def option_chain(symbol="NIFTY", width=10):
    symbol = symbol.upper()
    try:
        oc = S.nse_option_chain(symbol)
    except Exception as e:
        return fail(e, "NSE option chain")
    rec = oc["records"]
    spot = rec.get("underlyingValue")
    rows = []
    for d in rec["data"]:
        ce, pe = d.get("CE") or {}, d.get("PE") or {}
        rows.append({"strike": d["strikePrice"],
                     "ce_oi": ce.get("openInterest", 0) or 0, "ce_chg_oi": ce.get("changeinOpenInterest", 0) or 0,
                     "ce_ltp": ce.get("lastPrice"), "ce_iv": ce.get("impliedVolatility"),
                     "ce_vol": ce.get("totalTradedVolume", 0),
                     "pe_oi": pe.get("openInterest", 0) or 0, "pe_chg_oi": pe.get("changeinOpenInterest", 0) or 0,
                     "pe_ltp": pe.get("lastPrice"), "pe_iv": pe.get("impliedVolatility"),
                     "pe_vol": pe.get("totalTradedVolume", 0)})
    rows.sort(key=lambda r: r["strike"])
    if not rows or not spot:
        return fail("empty option chain", "NSE option chain")
    tot_ce = sum(r["ce_oi"] for r in rows)
    tot_pe = sum(r["pe_oi"] for r in rows)
    tot_ce_chg = sum(r["ce_chg_oi"] for r in rows)
    tot_pe_chg = sum(r["pe_chg_oi"] for r in rows)
    res = max(rows, key=lambda r: r["ce_oi"])
    sup = max(rows, key=lambda r: r["pe_oi"])
    # second walls (useful when the biggest wall is far away)
    above = [r for r in rows if spot <= r["strike"] <= spot * 1.02]   # walls within 2% of spot
    below = [r for r in rows if spot * 0.98 <= r["strike"] <= spot]
    near_res = max(above, key=lambda r: r["ce_oi"]) if above else None
    near_sup = max(below, key=lambda r: r["pe_oi"]) if below else None
    # max pain: strike minimising total option-writer payout
    strikes = [r["strike"] for r in rows if r["ce_oi"] or r["pe_oi"]]
    pain = {}
    for k in strikes:
        pain[k] = sum(r["ce_oi"] * max(0, k - r["strike"]) + r["pe_oi"] * max(0, r["strike"] - k) for r in rows)
    max_pain = min(pain, key=pain.get) if pain else None
    atm = min(rows, key=lambda r: abs(r["strike"] - spot))["strike"]
    i = next(i for i, r in enumerate(rows) if r["strike"] == atm)
    chain = rows[max(0, i - width): i + width + 1]
    pcr = tot_pe / tot_ce if tot_ce else None
    bias = None
    if pcr is not None:
        bias = "BULLISH (puts being written)" if pcr > 1.2 else "BEARISH (calls being written)" if pcr < 0.8 else "NEUTRAL"
    return ok({"symbol": symbol, "expiry": oc["_expiry"], "expiries": oc["_all_expiries"], "spot": spot,
               "atm": atm, "pcr": _r(pcr), "pcr_chg": _r(tot_pe_chg / tot_ce_chg) if tot_ce_chg else None,
               "pcr_bias": bias, "total_ce_oi": tot_ce, "total_pe_oi": tot_pe,
               "total_ce_chg_oi": tot_ce_chg, "total_pe_chg_oi": tot_pe_chg,
               "resistance": res["strike"], "resistance_oi": res["ce_oi"],
               "support": sup["strike"], "support_oi": sup["pe_oi"],
               "near_resistance": near_res and near_res["strike"], "near_support": near_sup and near_sup["strike"],
               "max_pain": max_pain, "chain": chain},
              "NSE option-chain-v3", as_of=f"{rec.get('timestamp')} IST")


# --------------------------------------------------------------------------- intraday helpers
def _universe():
    return [s + ".NS" for s in S.nifty50_symbols()]


def intraday_all():
    syms = ["^NSEI", "^NSEBANK"] + _universe()
    return S.yf_download(syms, "5d", "5m", "yf:intra5m", S.ttl(60, 900))


def daily_all():
    syms = ["^NSEI", "^NSEBANK"] + _universe()
    return S.yf_download(syms, "1y", "1d", "yf:daily1y", S.ttl(600, 3600))


def last_session(df: pd.DataFrame) -> pd.DataFrame:
    d = df.index[-1].date()
    day = df[df.index.date == d]
    return day[(day.index.time >= pd.Timestamp("09:15").time()) & (day.index.time < pd.Timestamp("15:30").time())]


def with_vwap(day: pd.DataFrame) -> pd.DataFrame:
    day = day.copy()
    tp = (day["High"] + day["Low"] + day["Close"]) / 3
    vol = day["Volume"].fillna(0)
    if vol.sum() > 0:
        day["VWAP"] = (tp * vol).cumsum() / vol.cumsum().replace(0, np.nan)
        day["vwap_kind"] = "VWAP"
    else:  # indices have no volume on Yahoo: use cumulative typical-price average, labelled as such
        day["VWAP"] = tp.expanding().mean()
        day["vwap_kind"] = "ATP (no volume)"
    return day


def pretty(sym: str) -> str:
    return {"^NSEI": "NIFTY", "^NSEBANK": "BANKNIFTY"}.get(sym, sym.replace(".NS", ""))


def ysym(name: str) -> str:
    name = name.upper()
    return INDEX_YF.get(name, name if name.startswith("^") or name.endswith(".NS") else name + ".NS")


# --------------------------------------------------------------------------- rule engine
def _fmt_t(ts):
    return ts.strftime("%H:%M")


def scan_symbol(sym, df):
    day = last_session(df)
    if len(day) < 4:
        return []
    day = with_vwap(day)
    alerts = []
    name = pretty(sym)
    first = day.iloc[0]
    if day.index[0].strftime("%H:%M") == "09:15":
        hi, lo = float(first["High"]), float(first["Low"])
        for side in ("LONG", "SHORT"):
            for j in range(1, len(day) - 1):
                c, n = day.iloc[j], day.iloc[j + 1]
                brk = c["Close"] > hi if side == "LONG" else c["Close"] < lo
                hold = n["Close"] > hi if side == "LONG" else n["Close"] < lo
                if brk and hold:
                    entry = float(n["Close"])
                    stop = lo if side == "LONG" else hi
                    alerts.append(dict(
                        time=_fmt_t(day.index[j + 1]), symbol=name, yf=sym, side=side, rule="FIRST 5-MIN BREAK",
                        entry=entry, stop=stop,
                        why=(f"First 5-min candle (09:15-09:20) range {lo:.2f}-{hi:.2f}. "
                             f"The {_fmt_t(day.index[j])} candle closed {'above the high' if side=='LONG' else 'below the low'} "
                             f"({c['Close']:.2f}) and the next candle's close held it ({n['Close']:.2f})."),
                        stop_why=f"Stop at the other end of the first 5-min candle ({stop:.2f})."))
                    break
                if (side == "LONG" and c["Close"] < lo) or (side == "SHORT" and c["Close"] > hi):
                    break  # opposite side broke first; skip this side
    # VWAP reclaim / loss (need at least 3 bars on the other side first)
    kind = day["vwap_kind"].iloc[0]
    for side in ("LONG", "SHORT"):
        for j in range(4, len(day) - 1):
            prev3 = day.iloc[j - 3:j]
            c, n = day.iloc[j], day.iloc[j + 1]
            if side == "LONG":
                cond = ((prev3["Close"] < prev3["VWAP"]).all() and c["Close"] > c["VWAP"] * 1.001
                        and n["Close"] > n["VWAP"] * 1.001)
            else:
                cond = ((prev3["Close"] > prev3["VWAP"]).all() and c["Close"] < c["VWAP"] * 0.999
                        and n["Close"] < n["VWAP"] * 0.999)
            if cond:
                win = day.iloc[j - 3:j + 2]
                stop = float(win["Low"].min()) if side == "LONG" else float(win["High"].max())
                alerts.append(dict(
                    time=_fmt_t(day.index[j + 1]), symbol=name, yf=sym, side=side,
                    rule="VWAP RECLAIM" if side == "LONG" else "VWAP LOSS", entry=float(n["Close"]), stop=stop,
                    why=(f"Price closed {'below' if side=='LONG' else 'above'} {kind} for 3+ candles, then the "
                         f"{_fmt_t(day.index[j])} candle closed back {'above' if side=='LONG' else 'below'} it "
                         f"({c['Close']:.2f} vs {kind} {c['VWAP']:.2f}) and the next candle held."),
                    stop_why=f"Stop beyond the swing {'low' if side=='LONG' else 'high'} of the reclaim ({stop:.2f})."))
                break
    # Late strength / weakness: after 14:00, new day extreme, on the right side of VWAP, day move > 1%
    prev_close = None
    dates = sorted(set(df.index.date))
    if len(dates) >= 2:
        prev_close = float(df[df.index.date == dates[-2]]["Close"].iloc[-1])
    if prev_close:
        for j in range(len(day)):
            ts = day.index[j]
            if ts.hour < 14:
                continue
            c = day.iloc[j]
            hi_before = day["High"].iloc[:j].max()
            lo_before = day["Low"].iloc[:j].min()
            chg = (c["Close"] / prev_close - 1) * 100
            if c["Close"] > hi_before and c["Close"] > c["VWAP"] and chg > 1:
                stop = float(c["VWAP"])
                alerts.append(dict(time=_fmt_t(ts), symbol=name, yf=sym, side="LONG", rule="LATE STRENGTH",
                                   entry=float(c["Close"]), stop=stop,
                                   why=(f"After 14:00 the candle closed at a new day high ({c['Close']:.2f}), above "
                                        f"{kind} ({c['VWAP']:.2f}), with the stock up {chg:.2f}% on the day."),
                                   stop_why=f"Stop below {kind} ({stop:.2f})."))
                break
            if c["Close"] < lo_before and c["Close"] < c["VWAP"] and chg < -1:
                stop = float(c["VWAP"])
                alerts.append(dict(time=_fmt_t(ts), symbol=name, yf=sym, side="SHORT", rule="LATE WEAKNESS",
                                   entry=float(c["Close"]), stop=stop,
                                   why=(f"After 14:00 the candle closed at a new day low ({c['Close']:.2f}), below "
                                        f"{kind} ({c['VWAP']:.2f}), with the stock down {abs(chg):.2f}% on the day."),
                                   stop_why=f"Stop above {kind} ({stop:.2f})."))
                break
    for a in alerts:
        risk = abs(a["entry"] - a["stop"])
        sign = 1 if a["side"] == "LONG" else -1
        a["t1"], a["t2"] = _r(a["entry"] + sign * risk), _r(a["entry"] + sign * 2 * risk)  # 1R and 2R
        a["risk_pct"] = _r(risk / a["entry"] * 100)
        a["entry"], a["stop"] = _r(a["entry"]), _r(a["stop"])
        a["session"] = day.index[0].strftime("%d-%b-%Y")
        bar = next(t for t in day.index if t.strftime("%H:%M") == a["time"])
        a["chart_time"] = int(bar.timestamp()) + 19800  # IST shown as chart-UTC
        # Volume spike: trigger-bar volume vs the average of the previous 20 bars (stocks only;
        # Yahoo has no index volume, so indices get None rather than a guess).
        i = day.index.get_loc(bar)
        vol = day["Volume"].fillna(0)
        prior = vol.iloc[max(0, i - 20):i]
        if vol.sum() > 0 and len(prior) >= 5 and prior.mean() > 0:
            a["vol_ratio"] = _r(float(vol.iloc[i]) / float(prior.mean()), 1)
            a["vol_spike"] = a["vol_ratio"] >= 2.0
        else:
            a["vol_ratio"], a["vol_spike"] = None, None
    return alerts


def setups():
    try:
        data = intraday_all()
    except Exception as e:
        return fail(e, "Yahoo 5m")
    alerts = []
    for sym, df in data.items():
        try:
            alerts.extend(scan_symbol(sym, df))
        except Exception:
            continue
    alerts.sort(key=lambda a: a["time"], reverse=True)
    session = alerts[0]["session"] if alerts else None
    return ok({"alerts": alerts, "session": session, "universe": len(data),
               "rules": ["FIRST 5-MIN BREAK: close beyond 09:15-09:20 high/low and next close holds",
                         "VWAP RECLAIM/LOSS: 3+ closes on one side, then a close at least 0.1% across VWAP and the next close holds",
                         "LATE STRENGTH/WEAKNESS: after 14:00, close at new day high/low, right side of VWAP, day move > 1%",
                         "Targets: T1 = 1R, T2 = 2R from the trigger (R = trigger-to-stop distance). VOL SPIKE = trigger-bar volume >= 2x the prior 20-bar average"]},
              "Yahoo 5m candles (NIFTY, BANKNIFTY + NIFTY 50 stocks)")


def candles(name: str, interval="5m"):
    sym = ysym(name)
    try:
        if interval == "1d":
            d = S.yf_download([sym], "6mo", "1d", f"yf:c1d:{sym}", S.ttl(600, 3600))[sym]
            day = d
            vw = None
            obs = None
        else:
            d = S.yf_download([sym], "5d", "5m", f"yf:c5:{sym}", S.ttl(60, 900))[sym]
            day = with_vwap(last_session(d))
            vw = [{"time": int(t.timestamp()) + 19800, "value": _r(v)} for t, v in day["VWAP"].items()]
            try:
                from .smc import blocks_for
                ob = blocks_for(d)
                obs = [b for b in ob if b["status"] == "ACTIVE"] + \
                    [b for b in ob if b["status"] != "ACTIVE" and b["status_t"] and b["status_t"] >= int(day.index[0].timestamp()) + 19800][-8:]
            except Exception:
                obs = None
    except Exception as e:
        return fail(e, "Yahoo")
    # lightweight-charts shows UTC; add +5:30 so the axis reads IST
    bars = [{"time": (int(t.timestamp()) + 19800) if interval != "1d" else t.strftime("%Y-%m-%d"),
             "open": _r(r.Open), "high": _r(r.High), "low": _r(r.Low), "close": _r(r.Close)}
            for t, r in day.iterrows()]
    return ok({"symbol": pretty(sym), "interval": interval, "bars": bars, "vwap": vw, "order_blocks": obs,
               "vwap_kind": (day["vwap_kind"].iloc[0] if vw else None)}, "Yahoo",
              as_of=(day.index[-1].strftime("%d-%b-%Y %H:%M IST") if interval != "1d" else
                     day.index[-1].strftime("%d-%b-%Y") + " daily bar") if len(day) else None)


# --------------------------------------------------------------------------- calm zone
def atr(df, n=14):
    h, l, c = df["High"], df["Low"], df["Close"]
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    return tr.rolling(n).mean()


def calm_zone():
    try:
        intra, daily = intraday_all(), daily_all()
    except Exception as e:
        return fail(e, "Yahoo")
    tiles = []
    for sym, df in intra.items():
        dd = daily.get(sym)
        if dd is None or len(dd) < 20:
            continue
        day = last_session(df)
        if day.empty:
            continue
        sess_date = day.index[0].date()
        hist = dd[dd.index.date < sess_date]
        if len(hist) < 15:
            continue
        a = float(atr(hist).iloc[-1])
        rng = float(day["High"].max() - day["Low"].min())
        ratio = rng / a if a else None
        prev_close = float(hist["Close"].iloc[-1])
        last = float(day["Close"].iloc[-1])
        state = "CALM" if ratio < 0.6 else "VOLATILE" if ratio > 1.0 else "NORMAL"
        tiles.append({"symbol": pretty(sym), "yf": sym, "last": _r(last), "pct": _r((last / prev_close - 1) * 100),
                      "range": _r(rng), "atr14": _r(a), "ratio": _r(ratio), "state": state,
                      "spark": [_r(x) for x in day["Close"].tolist()]})
    tiles.sort(key=lambda t: t["ratio"])
    sess = None
    if intra:
        sess = last_session(next(iter(intra.values()))).index[0].strftime("%d-%b-%Y")
    return ok({"tiles": tiles, "session": sess,
               "rule": "ratio = today's high-low range / 14-day ATR. CALM < 0.6, NORMAL 0.6-1.0, VOLATILE > 1.0"},
              "Yahoo 5m + daily")


# --------------------------------------------------------------------------- screener
def rsi(c, n=14):
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn)


def screener():
    try:
        daily = daily_all()
    except Exception as e:
        return fail(e, "Yahoo daily")
    rows = []
    for sym, d in daily.items():
        if sym.startswith("^") or len(d) < 210:
            continue
        c = d["Close"]
        r = rsi(c)
        macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
        sig = macd.ewm(span=9, adjust=False).mean()
        diff = macd - sig
        cross = None
        for k in range(1, 4):  # cross in the last 3 sessions
            if diff.iloc[-k - 1] <= 0 < diff.iloc[-k]:
                cross = ("BULLISH", d.index[-k].strftime("%d-%b"))
                break
            if diff.iloc[-k - 1] >= 0 > diff.iloc[-k]:
                cross = ("BEARISH", d.index[-k].strftime("%d-%b"))
                break
        sma50, sma150, sma200 = c.rolling(50).mean(), c.rolling(150).mean(), c.rolling(200).mean()
        last = float(c.iloc[-1])
        lo52, hi52 = float(d["Low"].iloc[-252:].min()), float(d["High"].iloc[-252:].max())
        checks = {
            "price > 150 & 200 SMA": last > sma150.iloc[-1] and last > sma200.iloc[-1],
            "150 SMA > 200 SMA": sma150.iloc[-1] > sma200.iloc[-1],
            "200 SMA rising (1 month)": sma200.iloc[-1] > sma200.iloc[-22],
            "50 SMA > 150 & 200 SMA": sma50.iloc[-1] > sma150.iloc[-1] and sma50.iloc[-1] > sma200.iloc[-1],
            "price > 50 SMA": last > sma50.iloc[-1],
            ">= 30% above 52w low": last >= 1.3 * lo52,
            "within 25% of 52w high": last >= 0.75 * hi52,
        }
        passed = sum(bool(v) for v in checks.values())
        rows.append({"symbol": pretty(sym), "yf": sym, "last": _r(last), "rsi": _r(float(r.iloc[-1]), 1),
                     "macd_cross": cross[0] if cross else None, "macd_cross_date": cross[1] if cross else None,
                     "minervini_pass": passed, "minervini_total": len(checks),
                     "minervini_checks": {k: bool(v) for k, v in checks.items()},
                     "pct_from_52w_high": _r((last / hi52 - 1) * 100)})
    as_of = None
    if daily:
        as_of = next(iter(daily.values())).index[-1].strftime("%d-%b-%Y") + " daily close (today = live bar)"
    return ok({
        "oversold": sorted([r for r in rows if r["rsi"] is not None and r["rsi"] < 30], key=lambda r: r["rsi"]),
        "overbought": sorted([r for r in rows if r["rsi"] is not None and r["rsi"] > 70], key=lambda r: -r["rsi"]),
        "macd": [r for r in rows if r["macd_cross"]],
        "minervini": sorted(rows, key=lambda r: (-r["minervini_pass"], r["pct_from_52w_high"] * -1)),
        "universe": "NIFTY 50 stocks",
        "note": "Minervini template uses 7 of 8 rules (the IBD relative-strength rating is not available free).",
    }, "Yahoo daily (1y)", as_of=as_of)


# --------------------------------------------------------------------------- gold & crypto
def global_assets():
    syms = ["GC=F", "BTC-USD", "USDINR=X"]
    try:
        d = S.yf_download(syms, "5d", "1d", "yf:glob", S.ttl(120, 300))
        h = S.yf_download(["GC=F", "BTC-USD"], "5d", "1h", "yf:glob1h", S.ttl(300, 600))
    except Exception as e:
        return fail(e, "Yahoo")
    out = []
    fx = float(d["USDINR=X"]["Close"].iloc[-1]) if "USDINR=X" in d else None
    for sym, label in (("GC=F", "GOLD (COMEX, XAUUSD proxy)"), ("BTC-USD", "BITCOIN")):
        x = d.get(sym)
        if x is None or len(x) < 2:
            out.append({"label": label, "ok": False})
            continue
        last, prev = float(x["Close"].iloc[-1]), float(x["Close"].iloc[-2])
        card = {"label": label, "ok": True, "symbol": sym, "last_usd": _r(last), "pct": _r((last / prev - 1) * 100),
                "high": _r(x["High"].iloc[-1]), "low": _r(x["Low"].iloc[-1]),
                "spark": [_r(v) for v in h[sym]["Close"].tolist()] if sym in h else [],
                "as_of": h[sym].index[-1].strftime("%d-%b-%Y %H:%M IST") if sym in h else None}
        if fx:
            if sym == "GC=F":
                card["inr_10g"] = _r(last * fx / 31.1035 * 10, 0)
                card["inr_note"] = ("International price converted at USD/INR " + f"{fx:.2f}" +
                                    " per 10 g. Excludes import duty and GST, so MCX gold trades higher. Not an MCX quote.")
            else:
                card["inr"] = _r(last * fx, 0)
        out.append(card)
    return ok({"cards": out, "usdinr": _r(fx, 3)}, "Yahoo (GC=F, BTC-USD, USDINR=X)")


# --------------------------------------------------------------------------- pre-trade 3 checks
def pretrade():
    idx, flow, oc = indices(), stock_flow(), option_chain("NIFTY")
    # (a) market mood
    score, reasons = 0, []
    if idx["ok"] and idx["data"]["breadth"] and idx["data"]["breadth"]["nifty500_adv"] is not None:
        b = idx["data"]["breadth"]
        ratio = b["nifty500_adv"] / max(1, b["nifty500_dec"])
        score += 1 if ratio > 1.3 else -1 if ratio < 0.77 else 0
        reasons.append(f"NIFTY 500 breadth {b['nifty500_adv']} up / {b['nifty500_dec']} down")
    if flow["ok"]:
        c = flow["data"]["counts"]
        bull = c["LONG BUILD-UP"] + c["SHORT COVERING"]
        bear = c["SHORT BUILD-UP"] + c["LONG UNWINDING"]
        score += 1 if bull > 1.3 * bear else -1 if bear > 1.3 * bull else 0
        reasons.append(f"F&O stocks: {bull} bullish OI (long build-up + short covering) vs {bear} bearish "
                       f"(short build-up + long unwinding)")
    if oc["ok"] and oc["data"]["pcr"] is not None:
        p = oc["data"]["pcr"]
        score += 1 if p > 1.2 else -1 if p < 0.8 else 0
        reasons.append(f"NIFTY PCR {p}")
    have = len(reasons)
    mood = None
    if have:
        mood = "MONEY COMING IN" if score >= 2 else "MONEY GOING OUT" if score <= -2 else \
            "LEANING IN" if score == 1 else "LEANING OUT" if score == -1 else "MIXED / NO EDGE"
    # (b) floor & ceiling
    levels = {}
    try:
        d = S.yf_download(["^NSEI"], "10d", "1d", "yf:nifty_d", S.ttl(300, 1800))["^NSEI"]
        today = S.now_ist().date()
        prev = d[d.index.date < today].iloc[-1] if d.index[-1].date() >= today else d.iloc[-2] if len(d) > 1 else None
        if prev is not None:
            levels.update(pdh=_r(prev["High"]), pdl=_r(prev["Low"]), pdc=_r(prev["Close"]),
                          prev_date=prev.name.strftime("%d-%b-%Y"))
    except Exception as e:
        levels["prior_day_error"] = str(e)
    if oc["ok"]:
        o = oc["data"]
        levels.update(spot=o["spot"], oi_support=o["support"], oi_resistance=o["resistance"],
                      near_support=o["near_support"], near_resistance=o["near_resistance"],
                      max_pain=o["max_pain"], expiry=o["expiry"])
    # (c) latest setup
    st = setups()
    latest = st["data"]["alerts"][:3] if st["ok"] else []
    return ok({"mood": {"label": mood, "score": score, "inputs": have, "reasons": reasons},
               "levels": levels, "latest_setups": latest,
               "sources_ok": {"indices": idx["ok"], "flow": flow["ok"], "options": oc["ok"], "setups": st["ok"]}},
              "combined")
