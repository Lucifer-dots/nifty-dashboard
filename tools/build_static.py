"""Build a JSON snapshot of every dashboard endpoint for static hosting (GitHub Pages).

Usage: python tools/build_static.py OUT_DIR
Writes OUT_DIR/{status,indices,flow,options_*,setups,moneyflow,orderblocks,calm,screener,global,pretrade}.json and
OUT_DIR/candles/{5m,1d}/<SYMBOL>.json. Failed sources are written as {"ok": false, "error": ...}
so the page shows DATA UNAVAILABLE instead of numbers. Read-only: no orders, no broker calls.
"""
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend import analytics as A  # noqa: E402
from backend import sources as S  # noqa: E402
from backend import smc  # noqa: E402

out = Path(sys.argv[1] if len(sys.argv) > 1 else "out")
(out / "candles" / "5m").mkdir(parents=True, exist_ok=True)
(out / "candles" / "1d").mkdir(parents=True, exist_ok=True)


def safe_name(s):
    return re.sub(r"[^A-Z0-9-]", "_", str(s).upper())


def write(name, payload):
    (out / name).parent.mkdir(parents=True, exist_ok=True)
    (out / name).write_text(json.dumps(payload, default=str, separators=(",", ":")))


def run(name, fn, *a):
    t = time.time()
    try:
        r = fn(*a)
    except Exception as e:
        r = A.fail(f"{type(e).__name__}: {e}", name)
    write(name + ".json", r)
    ok = r.get("ok", r.get("nse_ok"))
    print(f"{name:20s} ok={ok} {time.time()-t:5.1f}s {'' if ok else str(r.get('error') or r.get('nse_error'))[:160]}")
    return r


t0 = time.time()
st = A.status()
st["generated_epoch"] = int(time.time())
st["generated_by"] = "GitHub Actions snapshot"
write("status.json", st)
print("status", st.get("nse_ok"), st.get("nse_market_status"), st.get("nse_error", ""))
run("indices", A.indices)
run("flow", A.stock_flow)
for sym in ("NIFTY", "BANKNIFTY", "FINNIFTY"):
    run("options_" + sym, A.option_chain, sym)
run("setups", A.setups)
run("moneyflow", smc.money_flow)
run("orderblocks", smc.order_blocks)
run("calm", A.calm_zone)
run("screener", A.screener)
run("global", A.global_assets)
run("pretrade", A.pretrade)

# Candles for every symbol in the intraday universe, reusing the batch downloads.
n5 = nd = 0
try:
    intra = A.intraday_all()
    for sym, df in intra.items():
        day = A.with_vwap(A.last_session(df))
        if day.empty:
            continue
        bars = [{"time": int(t.timestamp()) + 19800, "open": A._r(r.Open), "high": A._r(r.High),
                 "low": A._r(r.Low), "close": A._r(r.Close)} for t, r in day.iterrows()]
        vw = [{"time": int(t.timestamp()) + 19800, "value": A._r(v)} for t, v in day["VWAP"].items()]
        ob = smc.blocks_for(df)
        t0d = int(day.index[0].timestamp()) + 19800
        obs = [b for b in ob if b["status"] == "ACTIVE"] + \
            [b for b in ob if b["status"] != "ACTIVE" and b["status_t"] and b["status_t"] >= t0d][-8:]
        write(f"candles/5m/{safe_name(A.pretty(sym))}.json",
              A.ok({"symbol": A.pretty(sym), "interval": "5m", "bars": bars, "vwap": vw, "order_blocks": obs,
                    "vwap_kind": day["vwap_kind"].iloc[0]}, "Yahoo",
                   as_of=day.index[-1].strftime("%d-%b-%Y %H:%M IST")))
        n5 += 1
except Exception as e:
    print("5m candles failed:", e)
try:
    daily = A.daily_all()
    for sym, d in daily.items():
        d = d.iloc[-130:]
        bars = [{"time": t.strftime("%Y-%m-%d"), "open": A._r(r.Open), "high": A._r(r.High),
                 "low": A._r(r.Low), "close": A._r(r.Close)} for t, r in d.iterrows()]
        write(f"candles/1d/{safe_name(A.pretty(sym))}.json",
              A.ok({"symbol": A.pretty(sym), "interval": "1d", "bars": bars, "vwap": None, "vwap_kind": None},
                   "Yahoo", as_of=d.index[-1].strftime("%d-%b-%Y") + " daily bar"))
        nd += 1
except Exception as e:
    print("daily candles failed:", e)
print(f"candles: {n5} intraday, {nd} daily · total {time.time()-t0:.1f}s · NSE last error: {S.NSE.last_error}")
