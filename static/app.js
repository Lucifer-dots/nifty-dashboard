// RA Market Pulse frontend. Read-only analytics; there is no order or broker code anywhere.
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = (x, d = 2) => x == null ? '—' : Number(x).toLocaleString('en-IN', {minimumFractionDigits: d, maximumFractionDigits: d});
const pct = x => x == null ? '—' : `<span class="${x >= 0 ? 'up' : 'dn'}">${x >= 0 ? '+' : ''}${fmt(x)}%</span>`;
const lakh = x => x == null ? '—' : (Math.abs(x) >= 1e5 ? fmt(x / 1e5, 2) + 'L' : fmt(x, 0));
const unavailable = (r, what) => `<div class="unavail"><b>DATA UNAVAILABLE</b> · ${esc(what)}<br><span class="mut">${esc(r && r.error || 'no response')}</span><div class="asof">checked ${esc(r && r.as_of || '')}</div></div>`;
const asof = r => `<div class="asof">source: ${esc(r.source)} · as of ${esc(r.as_of)}</div>`;
const TAG = {'LONG BUILD-UP': 'b-lb', 'SHORT COVERING': 'b-sc', 'SHORT BUILD-UP': 'b-sb', 'LONG UNWINDING': 'b-lu'};

// Two modes: the FastAPI server (/api/...) or a static host (GitHub Pages) reading JSON
// snapshots that a scheduled GitHub Action publishes to the repo's `data` branch.
const STATIC_MODE = location.hostname.endsWith('github.io');
const DATA_BASE = STATIC_MODE ? `https://raw.githubusercontent.com/${location.hostname.split('.')[0]}/${location.pathname.split('/')[1]}/data/` : '';
const safeName = s => String(s).toUpperCase().replace(/[^A-Z0-9-]/g, '_');
function dataUrl(path) {
  if (!STATIC_MODE) return path;
  const u = new URL(path, location.origin), q = u.searchParams, name = u.pathname.replace('/api/', '');
  let f = name + '.json';
  if (name === 'options') f = `options_${q.get('symbol') || 'NIFTY'}.json`;
  if (name === 'candles') f = `candles/${q.get('interval') || '5m'}/${safeName(q.get('symbol'))}.json`;
  return DATA_BASE + f + '?t=' + Math.floor(Date.now() / 60000);
}
async function api(path) {
  try {
    const r = await fetch(dataUrl(path), {cache: 'no-store'});
    if (r.status === 404 && STATIC_MODE) return {ok: false, error: 'not in the published snapshot (charts cover NIFTY, BANKNIFTY and NIFTY 50 stocks only)'};
    if (!r.ok) return {ok: false, error: `HTTP ${r.status}`};
    return await r.json();
  } catch (e) { return {ok: false, error: 'network error: ' + e.message}; }
}

function spark(vals, color) {
  if (!vals || vals.length < 2) return '<svg></svg>';
  const mn = Math.min(...vals), mx = Math.max(...vals), w = 100, h = 40;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - (mx === mn ? h / 2 : (v - mn) / (mx - mn) * (h - 4) + 2)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}

// ---------------------------------------------------------------- status + ticker
async function loadStatus() {
  const s = await api('/api/status');
  if (s.ok === false && !s.server_time) { $('#mstatus').innerHTML = '<span class="dn">DATA UNAVAILABLE</span>'; return; }
  const st = s.nse_ok ? s.nse_market_status : (s.market_open_by_clock ? 'Open (clock)' : 'Closed (clock)');
  let snap = '';
  if (s.generated_epoch) {
    const age = Math.round((Date.now() / 1000 - s.generated_epoch) / 60);
    const stale = age > 20 && s.market_open_by_clock;
    snap = `<br><span class="${stale ? 'or' : 'mut'}">snapshot ${esc(s.server_time)} · ${age} min old${stale ? ' · STALE' : ''}</span>`;
  }
  $('#mstatus').innerHTML = `NSE <b class="${/open/i.test(st) ? 'open' : 'closed'}">${esc(st)}</b>` + (snap || `<br>${esc(s.server_time || '')}`) +
    (s.nse_ok ? '' : '<br><span class="dn">NSE status unavailable</span>');
}
async function loadTicker() {
  const r = await api('/api/indices');
  if (!r.ok) { $('#ticker').innerHTML = unavailable(r, 'index prices'); return; }
  $('#ticker').innerHTML = r.data.cards.map(c => c.ok ?
    `<div class="tick"><div class="l">${esc(c.label)} <span class="mut">${esc(c.source)}</span></div><div class="v ${c.pct >= 0 ? 'up' : 'dn'}">${fmt(c.last)}</div><div>${c.change >= 0 ? '+' : ''}${fmt(c.change)} · ${pct(c.pct)}</div><div class="asof">${esc(c.as_of)}</div></div>` :
    `<div class="tick"><div class="l">${esc(c.label)}</div><div class="unavail"><b>DATA UNAVAILABLE</b></div></div>`).join('');
  return r;
}

// ---------------------------------------------------------------- pre-trade
async function loadPretrade() {
  const r = await api('/api/pretrade'), el = $('#tab-pretrade');
  if (!r.ok) { el.innerHTML = unavailable(r, 'pre-trade checks'); return; }
  const d = r.data, m = d.mood, L = d.levels;
  const moodCls = !m.label ? 'mut' : /IN/.test(m.label) && !/OUT/.test(m.label) ? 'up' : /OUT/.test(m.label) ? 'dn' : 'or';
  const lv = (k, label, cls = '') => `<div><span>${label}</span><b class="${cls}">${L[k] == null ? '—' : fmt(L[k])}</b></div>`;
  const setupsHtml = d.latest_setups.length ? d.latest_setups.map(alertCard).join('') :
    `<div class="mut">No rule has triggered in the latest session yet.${d.sources_ok.setups ? '' : ' (setup data unavailable)'}</div>`;
  el.innerHTML = `<div class="grid">
  <div class="card"><h3>Check 1 · Market mood — money in or out?</h3>
    <div class="check"><div class="num">1</div><div>
      <div class="mood ${moodCls}">${esc(m.label || 'DATA UNAVAILABLE')}</div>
      <div class="mut">score ${m.score} from ${m.inputs} of 3 inputs</div>
      <ul>${m.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div></div>
  <div class="card"><h3>Check 2 · NIFTY floor &amp; ceiling</h3>
    <div class="check"><div class="num">2</div><div style="flex:1">
      <div class="mut">Spot ${fmt(L.spot)} · weekly expiry ${esc(L.expiry || '—')}</div>
      <div class="lvl" style="margin-top:6px">
        ${lv('oi_resistance', 'Ceiling · max call OI', 'dn')}${lv('oi_support', 'Floor · max put OI', 'up')}
        ${lv('near_resistance', 'Biggest call wall within 2% above', 'dn')}${lv('near_support', 'Biggest put wall within 2% below', 'up')}
        ${lv('pdh', 'Prev day high ' + (L.prev_date || ''), 'or')}${lv('pdl', 'Prev day low', 'or')}
        ${lv('pdc', 'Prev close')}${lv('max_pain', 'Max pain', 'bl')}
      </div>
      ${d.sources_ok.options ? '' : unavailable({error: 'NSE option chain blocked/unavailable'}, 'OI walls')}
    </div></div></div>
  <div class="card" style="grid-column:1/-1"><h3>Check 3 · Why the setup formed &amp; where the stop is</h3>
    <div class="check"><div class="num">3</div><div style="flex:1">${setupsHtml}</div></div></div>
  </div>${asof(r)}`;
  bindAlerts(el, d.latest_setups);
}

// ---------------------------------------------------------------- flow
let flowFilter = 'ALL', flowData = null;
async function loadFlow() {
  const [idx, r] = await Promise.all([api('/api/indices'), api('/api/flow')]);
  const el = $('#tab-flow');
  let html = '<div class="grid">';
  if (idx.ok && idx.data.breadth) {
    const b = idx.data.breadth, t = b.nifty500_adv + b.nifty500_dec, ta = b.all_adv + b.all_dec;
    html += `<div class="card"><h3>Money flow · breadth</h3>
      <div>NIFTY 500: <b class="up">${b.nifty500_adv} up</b> / <b class="dn">${b.nifty500_dec} down</b></div>
      <div class="bar" style="margin:6px 0"><i style="width:${b.nifty500_adv / t * 100}%;background:var(--g)"></i><i style="width:${b.nifty500_dec / t * 100}%;background:var(--r)"></i></div>
      <div>All NSE: <b class="up">${b.all_adv}</b> / <b class="dn">${b.all_dec}</b></div>
      <div class="bar" style="margin:6px 0"><i style="width:${b.all_adv / ta * 100}%;background:var(--g)"></i><i style="width:${b.all_dec / ta * 100}%;background:var(--r)"></i></div>
      <div class="big ${b.nifty500_adv > b.nifty500_dec ? 'up' : 'dn'}">${b.nifty500_adv > b.nifty500_dec ? 'MONEY COMING IN' : 'MONEY GOING OUT'}</div>
      <div class="asof">NSE allIndices · ${esc(b.as_of)}</div></div>`;
  } else html += `<div class="card"><h3>Money flow · breadth</h3>${unavailable(idx, 'breadth')}</div>`;
  if (idx.ok) {
    html += `<div class="card"><h3>Index cards</h3><table><tr><th>INDEX</th><th>LAST</th><th>CHG%</th><th>ADV/DEC</th></tr>${idx.data.cards.map(c => c.ok ?
      `<tr><td>${esc(c.label)}</td><td>${fmt(c.last)}</td><td>${pct(c.pct)}</td><td>${c.advances ? `<span class="up">${c.advances}</span>/<span class="dn">${c.declines}</span>` : '<span class="mut">—</span>'}</td></tr>` :
      `<tr><td>${esc(c.label)}</td><td colspan=3 class="dn">DATA UNAVAILABLE</td></tr>`).join('')}</table>${asof(idx)}</div>`;
  }
  if (r.ok) {
    flowData = r;
    const c = r.data.counts, tot = Object.values(c).reduce((a, b) => a + b, 0);
    html += `<div class="card"><h3>F&amp;O OI build-up mix (${tot} stocks)</h3>
      ${Object.entries(c).map(([k, v]) => `<div style="margin:5px 0"><span class="badge ${TAG[k]}">${k}</span> <b>${v}</b><div class="bar"><i class="${TAG[k]}" style="width:${v / tot * 100}%;background:currentColor"></i></div></div>`).join('')}
      <div class="asof">${esc(r.data.note)}<br>NSE OI as of ${esc(r.data.nse_oi_timestamp)}</div></div>`;
    html += `<div class="card" style="grid-column:1/-1"><h3>Stock flow · price vs OI</h3>
      <div class="filters">${['ALL', ...Object.keys(TAG)].map(k => `<button data-f="${k}" class="${k === flowFilter ? 'on' : ''}">${k}</button>`).join('')}</div>
      <div class="flowlist scroll" id="flowtable"></div>${asof(r)}</div>`;
  } else html += `<div class="card"><h3>Stock flow</h3>${unavailable(r, 'F&O OI data')}</div>`;
  el.innerHTML = html + '</div>';
  el.querySelectorAll('.filters button').forEach(b => b.onclick = () => { flowFilter = b.dataset.f; loadFlowTable(); el.querySelectorAll('.filters button').forEach(x => x.classList.toggle('on', x === b)); });
  if (r.ok) loadFlowTable();
}
function loadFlowTable() {
  const rows = flowData.data.stocks.filter(s => flowFilter === 'ALL' || s.tag === flowFilter);
  $('#flowtable').innerHTML = `<table><tr><th>STOCK</th><th>LTP</th><th>PRICE%</th><th>OI%</th><th>OI CHG</th><th>SIGNAL</th></tr>${rows.map(s =>
    `<tr data-sym="${esc(s.symbol)}" style="cursor:pointer"><td>${esc(s.symbol)}</td><td>${fmt(s.ltp)}</td><td>${pct(s.price_pct)}</td><td>${pct(s.oi_pct)}</td><td>${lakh(s.oi_change)}</td><td><span class="badge ${TAG[s.tag]}">${esc(s.tag)}</span></td></tr>`).join('')}</table>`;
  $('#flowtable').querySelectorAll('tr[data-sym]').forEach(tr => tr.onclick = () => openChart(tr.dataset.sym));
}

// ---------------------------------------------------------------- options
let ocSym = 'NIFTY';
async function loadOptions() {
  const r = await api('/api/options?symbol=' + ocSym), el = $('#tab-options');
  const sel = `<div class="filters">${['NIFTY', 'BANKNIFTY', 'FINNIFTY'].map(s => `<button data-s="${s}" class="${s === ocSym ? 'on' : ''}">${s}</button>`).join('')}</div>`;
  if (!r.ok) { el.innerHTML = sel + unavailable(r, `${ocSym} option chain (NSE)`); bindOc(el); return; }
  const d = r.data, mx = Math.max(...d.chain.map(x => Math.max(x.ce_oi, x.pe_oi)), 1);
  el.innerHTML = sel + `<div class="grid">
    <div class="card"><h3>${esc(d.symbol)} spot</h3><div class="big">${fmt(d.spot)}</div><div class="mut">ATM ${d.atm} · expiry ${esc(d.expiry)}</div></div>
    <div class="card"><h3>PCR (OI)</h3><div class="big ${d.pcr > 1.2 ? 'up' : d.pcr < 0.8 ? 'dn' : 'or'}">${fmt(d.pcr)}</div><div class="mut">${esc(d.pcr_bias)} · PCR of today's OI change ${fmt(d.pcr_chg)}</div></div>
    <div class="card"><h3>OI walls</h3><div>Resistance (max call OI) <b class="dn">${d.resistance}</b> <span class="mut">${lakh(d.resistance_oi)}</span></div>
      <div>Support (max put OI) <b class="up">${d.support}</b> <span class="mut">${lakh(d.support_oi)}</span></div>
      <div>Walls within ±2%: <b class="up">${d.near_support ?? '—'}</b> / <b class="dn">${d.near_resistance ?? '—'}</b></div></div>
    <div class="card"><h3>Max pain</h3><div class="big bl">${d.max_pain ?? '—'}</div><div class="mut">Total CE OI ${lakh(d.total_ce_oi)} · PE OI ${lakh(d.total_pe_oi)}</div></div>
    <div class="card" style="grid-column:1/-1"><h3>Chain near ATM</h3><div class="scroll"><table>
      <tr><th>CE OI</th><th>CE ΔOI</th><th>CE LTP</th><th>CE IV</th><th style="text-align:center">STRIKE</th><th>PE IV</th><th>PE LTP</th><th>PE ΔOI</th><th>PE OI</th></tr>
      ${d.chain.map(x => `<tr class="${x.strike === d.atm ? 'atm' : ''}">
        <td><span class="oibar" style="width:${x.ce_oi / mx * 60}px;background:var(--r)"></span> ${lakh(x.ce_oi)}</td><td class="${x.ce_chg_oi >= 0 ? 'up' : 'dn'}">${lakh(x.ce_chg_oi)}</td><td>${fmt(x.ce_ltp)}</td><td class="mut">${fmt(x.ce_iv, 1)}</td>
        <td style="text-align:center;font-weight:700" class="${x.strike === d.resistance ? 'dn' : x.strike === d.support ? 'up' : ''}">${x.strike}</td>
        <td class="mut">${fmt(x.pe_iv, 1)}</td><td>${fmt(x.pe_ltp)}</td><td class="${x.pe_chg_oi >= 0 ? 'up' : 'dn'}">${lakh(x.pe_chg_oi)}</td><td>${lakh(x.pe_oi)} <span class="oibar" style="width:${x.pe_oi / mx * 60}px;background:var(--g)"></span></td></tr>`).join('')}
    </table></div></div></div>${asof(r)}`;
  bindOc(el);
}
function bindOc(el) { el.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { ocSym = b.dataset.s; loadOptions(); }); }

// ---------------------------------------------------------------- setups
function alertCard(a, i) {
  return `<div class="card alert ${a.side}" data-i="${i}" style="margin-bottom:8px">
    <div><b>${esc(a.time)}</b> <span class="mut">${esc(a.session)}</span> · <b>${esc(a.symbol)}</b> · <span class="${a.side === 'LONG' ? 'up' : 'dn'}">${a.side}</span> <span class="pill">${esc(a.rule)}</span></div>
    <div>Trigger ${fmt(a.entry)} · Stop <b class="or">${fmt(a.stop)}</b> <span class="mut">(${fmt(a.risk_pct)}% risk)</span></div>
    <div class="why"><b>WHY IT QUALIFIED</b><br>${esc(a.why)}<br><b>STOP</b> ${esc(a.stop_why)}</div>
    <div class="asof">tap for chart</div></div>`;
}
function bindAlerts(el, alerts) { el.querySelectorAll('.alert').forEach(c => c.onclick = () => openChart(alerts[+c.dataset.i].symbol, alerts[+c.dataset.i])); }
async function loadSetups() {
  const r = await api('/api/setups'), el = $('#tab-setups');
  if (!r.ok) { el.innerHTML = unavailable(r, 'intraday setups'); return; }
  const d = r.data;
  el.innerHTML = `<div class="card" style="margin-bottom:10px"><h3>Rules (session ${esc(d.session || '—')}, ${d.universe} symbols)</h3><ul>${d.rules.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <div class="mut">Alerts are rule matches on 5-min candles, not recommendations. Nothing is ever ordered from here.</div></div>
    <div class="grid">${d.alerts.length ? d.alerts.map(alertCard).join('') : '<div class="mut">No rule has triggered in this session.</div>'}</div>${asof(r)}`;
  bindAlerts(el, d.alerts);
}

// ---------------------------------------------------------------- calm zone
async function loadCalm() {
  const r = await api('/api/calm'), el = $('#tab-calm');
  if (!r.ok) { el.innerHTML = unavailable(r, 'calm zone'); return; }
  const d = r.data, cnt = s => d.tiles.filter(t => t.state === s).length;
  el.innerHTML = `<div class="card" style="margin-bottom:10px"><h3>Calm Zone · session ${esc(d.session)}</h3>
    <span class="bl">CALM ${cnt('CALM')}</span> · <span class="mut">NORMAL ${cnt('NORMAL')}</span> · <span class="dn">VOLATILE ${cnt('VOLATILE')}</span><div class="asof">${esc(d.rule)}</div></div>
    <div class="tiles">${d.tiles.map(t => `<div class="tile ${t.state}" data-sym="${esc(t.symbol)}">
      <div style="display:flex;justify-content:space-between"><b>${esc(t.symbol)}</b><span class="badge ${t.state === 'CALM' ? 'b-sc' : t.state === 'VOLATILE' ? 'b-sb' : 'b-lu'}">${t.state}</span></div>
      ${spark(t.spark, t.pct >= 0 ? '#00ff9c' : '#ff3b5c')}
      <div>${fmt(t.last)} ${pct(t.pct)}</div><div class="mut">range/ATR ${fmt(t.ratio)}</div></div>`).join('')}</div>${asof(r)}`;
  el.querySelectorAll('.tile').forEach(t => t.onclick = () => openChart(t.dataset.sym));
}

// ---------------------------------------------------------------- screener
async function loadScreener() {
  const r = await api('/api/screener'), el = $('#tab-screener');
  if (!r.ok) { el.innerHTML = unavailable(r, 'screener'); return; }
  const d = r.data;
  const list = (rows, cols) => rows.length ? `<table><tr>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr>${rows.map(x => `<tr data-sym="${esc(x.symbol)}" style="cursor:pointer">${cols.map(c => `<td>${c[1](x)}</td>`).join('')}</tr>`).join('')}</table>` : '<div class="mut">None today.</div>';
  el.innerHTML = `<div class="grid">
    <div class="card"><h3>RSI(14) &lt; 30 · oversold</h3>${list(d.oversold, [['STOCK', x => esc(x.symbol)], ['LAST', x => fmt(x.last)], ['RSI', x => `<b class="up">${x.rsi}</b>`]])}</div>
    <div class="card"><h3>RSI(14) &gt; 70 · overbought</h3>${list(d.overbought, [['STOCK', x => esc(x.symbol)], ['LAST', x => fmt(x.last)], ['RSI', x => `<b class="dn">${x.rsi}</b>`]])}</div>
    <div class="card"><h3>MACD cross (last 3 sessions)</h3>${list(d.macd, [['STOCK', x => esc(x.symbol)], ['CROSS', x => `<b class="${x.macd_cross === 'BULLISH' ? 'up' : 'dn'}">${x.macd_cross}</b>`], ['ON', x => esc(x.macd_cross_date)], ['RSI', x => x.rsi]])}</div>
    <div class="card" style="grid-column:1/-1"><h3>Minervini trend template</h3><div class="mut">${esc(d.note)}</div><div class="scroll mv">${list(d.minervini, [['STOCK', x => esc(x.symbol)], ['LAST', x => fmt(x.last)], ['PASS', x => `<b class="${x.minervini_pass === x.minervini_total ? 'up' : x.minervini_pass >= 5 ? 'or' : 'mut'}">${x.minervini_pass}/${x.minervini_total}</b>`], ['FROM 52W HIGH', x => pct(x.pct_from_52w_high)], ['FAILED', x => `<span class="mut">${Object.entries(x.minervini_checks).filter(e => !e[1]).map(e => esc(e[0])).join(', ') || '—'}</span>`]])}</div></div>
  </div><div class="asof">Universe: ${esc(d.universe)}</div>${asof(r)}`;
  el.querySelectorAll('tr[data-sym]').forEach(tr => tr.onclick = () => openChart(tr.dataset.sym, null, '1d'));
}

// ---------------------------------------------------------------- global
async function loadGlobal() {
  const r = await api('/api/global'), el = $('#tab-global');
  if (!r.ok) { el.innerHTML = unavailable(r, 'gold & crypto'); return; }
  el.innerHTML = `<div class="grid">${r.data.cards.map(c => c.ok ? `<div class="card"><h3>${esc(c.label)}</h3>
    <div class="big">$${fmt(c.last_usd)} ${pct(c.pct)}</div><div class="mut">Day H ${fmt(c.high)} · L ${fmt(c.low)}</div>
    ${spark(c.spark, c.pct >= 0 ? '#00ff9c' : '#ff3b5c')}<div class="mut">5-day hourly</div>
    ${c.inr_10g ? `<div style="margin-top:6px">≈ ₹${fmt(c.inr_10g, 0)} / 10 g <div class="asof">${esc(c.inr_note)}</div></div>` : ''}
    ${c.inr ? `<div style="margin-top:6px">≈ ₹${fmt(c.inr, 0)}</div>` : ''}
    <div class="asof">last bar ${esc(c.as_of)}</div></div>` : `<div class="card"><h3>${esc(c.label)}</h3>${unavailable({error: 'no data'}, c.label)}</div>`).join('')}
    <div class="card"><h3>USD / INR</h3><div class="big">${fmt(r.data.usdinr, 3)}</div></div></div>${asof(r)}
    <div class="mut" style="margin-top:8px">MCX gold quotes are not available from a free public source here, so this shows COMEX gold (GC=F) as the XAUUSD proxy.</div>`;
}

// ---------------------------------------------------------------- chart modal
let chart = null;
async function openChart(symbol, alert = null, interval = '5m') {
  $('#modal').classList.remove('hidden');
  $('#modal-title').textContent = `${symbol} · ${interval === '1d' ? 'daily' : '5-min'} (IST)`;
  $('#modal-why').innerHTML = alert ? `<b>WHY IT QUALIFIED</b><br>${esc(alert.why)}<br><b>STOP</b> ${esc(alert.stop_why)}` : '';
  const box = $('#chart'); box.innerHTML = '<div class="loading">loading…</div>';
  const r = await api(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);
  box.innerHTML = '';
  if (!r.ok) { box.innerHTML = unavailable(r, 'candles'); return; }
  if (chart) chart.remove();
  chart = LightweightCharts.createChart(box, {autoSize: true, layout: {background: {color: '#0b111a'}, textColor: '#cfe3f5'},
    grid: {vertLines: {color: '#16212f'}, horzLines: {color: '#16212f'}}, timeScale: {timeVisible: interval !== '1d', secondsVisible: false},
    crosshair: {mode: 0}});
  const cs = chart.addCandlestickSeries({upColor: '#00ff9c', downColor: '#ff3b5c', borderVisible: false, wickUpColor: '#00ff9c', wickDownColor: '#ff3b5c'});
  cs.setData(r.data.bars);
  if (r.data.vwap) {
    const v = chart.addLineSeries({color: '#2fa8ff', lineWidth: 1, title: r.data.vwap_kind, priceLineVisible: false});
    v.setData(r.data.vwap.filter(x => x.value != null));
  }
  if (alert) {
    cs.createPriceLine({price: alert.entry, color: '#ffe14d', lineWidth: 1, lineStyle: 0, title: 'TRIGGER ' + alert.entry});
    cs.createPriceLine({price: alert.stop, color: '#ffa62b', lineWidth: 1, lineStyle: 2, title: 'STOP ' + alert.stop});
    cs.setMarkers([{time: alert.chart_time, position: alert.side === 'LONG' ? 'belowBar' : 'aboveBar', color: alert.side === 'LONG' ? '#00ff9c' : '#ff3b5c',
      shape: alert.side === 'LONG' ? 'arrowUp' : 'arrowDown', text: alert.rule}]);
  }
  chart.timeScale().fitContent();
  $('#modal-title').textContent += ` · as of ${r.as_of}`;
}
$('#modal-close').onclick = () => $('#modal').classList.add('hidden');
$('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };

// ---------------------------------------------------------------- tabs + refresh
const LOADERS = {pretrade: loadPretrade, flow: loadFlow, options: loadOptions, setups: loadSetups, calm: loadCalm, screener: loadScreener, global: loadGlobal};
let current = (location.hash || '#pretrade').slice(1);
if (!LOADERS[current]) current = 'pretrade';
function show(tab) {
  current = tab; history.replaceState(null, '', '#' + tab);
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  const el = $('#tab-' + tab); if (!el.innerHTML) el.innerHTML = '<div class="loading">loading live data…</div>';
  return LOADERS[tab]().then(() => { $('#updated').textContent = '· refreshed ' + new Date().toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata'}) + ' IST'; document.body.dataset.loaded = tab; });
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));
async function refresh() { await Promise.all([loadStatus(), loadTicker()]); if ($('#modal').classList.contains('hidden')) await show(current); }
refresh(); setInterval(refresh, 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
