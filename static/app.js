// RA Market Pulse frontend: phone-first, read-only analytics. There is no order or broker code anywhere.
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fmt = (x, d = 2) => x == null ? '—' : Number(x).toLocaleString('en-IN', {minimumFractionDigits: d, maximumFractionDigits: d});
const pct = x => x == null ? '—' : `<span class="${x >= 0 ? 'up' : 'dn'}">${x >= 0 ? '+' : ''}${fmt(x)}%</span>`;
const lakh = x => x == null ? '—' : (Math.abs(x) >= 1e5 ? fmt(x / 1e5, 2) + 'L' : fmt(x, 0));
const unavailable = (r, what) => `<div class="unavail"><b>DATA UNAVAILABLE</b> · ${esc(what)}<br><span class="mut">${esc(r && r.error || 'no response')}</span></div>`;
const asof = r => `<div class="asof">${esc(r.source)} · ${esc(r.as_of)}</div>`;
const TAG = {'LONG BUILD-UP': 'b-lb', 'SHORT COVERING': 'b-sc', 'SHORT BUILD-UP': 'b-sb', 'LONG UNWINDING': 'b-lu'};

// Data: the FastAPI server (/api/...) or, on GitHub Pages, JSON snapshots on the repo's `data` branch.
const params = new URLSearchParams(location.search);
const STATIC_MODE = location.hostname.endsWith('github.io') || params.has('static');
const DATA_BASE = location.hostname.endsWith('github.io')
  ? `https://raw.githubusercontent.com/${location.hostname.split('.')[0]}/${location.pathname.split('/')[1]}/data/`
  : 'https://raw.githubusercontent.com/Lucifer-dots/nifty-dashboard/data/';
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
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke" points="${pts}"/></svg>`;
}

// ---------------------------------------------------------------- header + index cards
let lastIdx = null;
async function loadStatus() {
  const s = await api('/api/status');
  if (s.ok === false && !s.server_time) { $('#mstatus').innerHTML = '<span class="dn">DATA UNAVAILABLE</span>'; return; }
  // Market clock in IST right now (the snapshot's own status can be hours old).
  const ist = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000), mins = ist.getHours() * 60 + ist.getMinutes();
  const openNow = ist.getDay() >= 1 && ist.getDay() <= 5 && mins >= 555 && mins <= 930;
  let st = s.nse_ok ? s.nse_market_status : (s.market_open_by_clock ? 'Open' : 'Closed');
  if (s.generated_epoch && !openNow) st = 'Closed';
  let line2 = esc((s.server_time || '').replace(/^\d+-\w+-\d+ /, '').replace(':00 IST', ' IST'));
  if (s.generated_epoch) {
    const age = Math.max(0, Math.round((Date.now() / 1000 - s.generated_epoch) / 60));
    const ageTxt = age < 60 ? `${age}m old` : age < 1440 ? `${Math.round(age / 60)}h old` : `${Math.round(age / 1440)}d old`;
    const stale = age > 20 && openNow;
    line2 = `<span class="${stale ? 'or' : ''}" title="snapshot ${esc(s.server_time)}">${ageTxt}${stale ? ' · STALE' : ''}</span>`;
  }
  $('#mstatus').innerHTML = `NSE <b class="${/open/i.test(st) ? 'open' : 'closed'}">${esc(st)}</b><br>${line2}`;
}
async function loadIndices() {
  const r = await api('/api/indices'); lastIdx = r;
  const n = r.ok && r.data.cards.find(c => c.label === 'NIFTY 50' && c.ok);
  $('#hdr-nifty').innerHTML = n ? `NIFTY <span class="${n.pct >= 0 ? 'up' : 'dn'}">${fmt(n.last)}</span> ${pct(n.pct)}` : '';
  return r;
}
function indexGrid(r) {
  if (!r || !r.ok) return unavailable(r, 'index prices');
  return `<div class="idx">${r.data.cards.map(c => c.ok ?
    `<div class="ic"><div class="l">${esc(c.label)}</div><div class="v ${c.pct >= 0 ? 'up' : 'dn'}">${fmt(c.last)}</div><div class="c">${pct(c.pct)} <span class="mut">${c.change >= 0 ? '+' : ''}${fmt(c.change)}</span></div></div>` :
    `<div class="ic"><div class="l">${esc(c.label)}</div><div class="dn">DATA UNAVAILABLE</div></div>`).join('')}</div>`;
}

// ---------------------------------------------------------------- pre-trade (first screen)
async function loadPretrade() {
  const r = await api('/api/pretrade'), el = $('#tab-pretrade');
  if (!r.ok) { el.innerHTML = unavailable(r, 'pre-trade checks') + indexGrid(lastIdx); return; }
  const d = r.data, m = d.mood, L = d.levels;
  const moodCls = !m.label ? 'mut' : /OUT/.test(m.label) ? 'dn' : /IN/.test(m.label) ? 'up' : 'or';
  const lv = (k, label, cls = '') => `<div><span>${label}</span><b class="${cls}">${L[k] == null ? '—' : fmt(L[k], L[k] % 1 ? 2 : 0)}</b></div>`;
  el.innerHTML = `<div class="grid">
  <div class="card"><h3>1 · Money in or out?</h3><div class="check"><div class="num">1</div><div style="min-width:0">
    <div class="mood ${moodCls}">${esc(m.label || 'DATA UNAVAILABLE')}</div>
    <div class="mut">score ${m.score} from ${m.inputs} of 3 inputs</div>
    <ul class="reasons">${m.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div></div>
  <div class="card"><h3>2 · NIFTY floor &amp; ceiling</h3><div class="check"><div class="num">2</div><div style="flex:1;min-width:0">
    <div><span class="big">${fmt(L.spot)}</span> <span class="mut">spot · expiry ${esc(L.expiry || '—')}</span></div>
    <div class="lvl">${lv('oi_resistance', 'Ceiling (call wall)', 'dn')}${lv('oi_support', 'Floor (put wall)', 'up')}
      ${lv('pdh', 'Prev high ' + (L.prev_date || ''), 'or')}${lv('pdl', 'Prev low', 'or')}
      ${lv('max_pain', 'Max pain', 'bl')}${lv('pdc', 'Prev close')}
      ${lv('near_resistance', 'Call wall ≤2% up', 'dn')}${lv('near_support', 'Put wall ≤2% down', 'up')}</div>
    ${d.sources_ok.options ? '' : unavailable({error: 'NSE option chain unavailable'}, 'OI walls')}</div></div></div>
  <div class="card span"><h3>3 · Why the setup formed &amp; where the stop is</h3>
    ${d.latest_setups.length ? d.latest_setups.map(alertCard).join('') : `<div class="mut">No rule has triggered in the latest session.${d.sources_ok.setups ? '' : ' (setup data unavailable)'}</div>`}</div>
  </div>
  <h3 class="bl" style="font-size:13px;letter-spacing:1px;margin:14px 2px 8px">INDICES</h3>${indexGrid(lastIdx)}${asof(r)}`;
  bindAlerts(el, d.latest_setups);
}

// ---------------------------------------------------------------- market flow
let flowFilter = 'ALL', flowData = null, flowShown = 40;
async function loadFlow() {
  const [r, mf] = await Promise.all([api('/api/flow'), api('/api/moneyflow')]), idx = lastIdx, el = $('#tab-flow');
  let html = moneyFlowHtml(mf) + '<div class="grid">';
  if (idx && idx.ok && idx.data.breadth) {
    const b = idx.data.breadth, t = b.nifty500_adv + b.nifty500_dec, ta = b.all_adv + b.all_dec;
    html += `<div class="card"><h3>Money flow · breadth</h3>
      <div class="big ${b.nifty500_adv > b.nifty500_dec ? 'up' : 'dn'}">${b.nifty500_adv > b.nifty500_dec ? 'MONEY COMING IN' : 'MONEY GOING OUT'}</div>
      <div style="margin-top:8px">NIFTY 500 <b class="up">${b.nifty500_adv}↑</b> <b class="dn">${b.nifty500_dec}↓</b></div>
      <div class="bar"><i style="width:${b.nifty500_adv / t * 100}%;background:var(--g)"></i><i style="width:${b.nifty500_dec / t * 100}%;background:var(--r)"></i></div>
      <div>All NSE <b class="up">${b.all_adv}↑</b> <b class="dn">${b.all_dec}↓</b></div>
      <div class="bar"><i style="width:${b.all_adv / ta * 100}%;background:var(--g)"></i><i style="width:${b.all_dec / ta * 100}%;background:var(--r)"></i></div>
      <div class="asof">NSE · ${esc(b.as_of)}</div></div>`;
  } else html += `<div class="card"><h3>Money flow · breadth</h3>${unavailable(idx, 'breadth')}</div>`;
  if (r.ok) {
    flowData = r;
    const c = r.data.counts, tot = Object.values(c).reduce((a, b) => a + b, 0) || 1;
    const col = {'LONG BUILD-UP': 'var(--g)', 'SHORT COVERING': 'var(--b)', 'SHORT BUILD-UP': 'var(--r)', 'LONG UNWINDING': 'var(--o)'};
    html += `<div class="card span"><h3>Stock flow · price vs OI</h3>
      <div class="chips" id="flowchips">${['ALL', ...Object.keys(TAG)].map(k => `<button data-f="${k}" class="${k === flowFilter ? 'on' : ''}">${k}</button>`).join('')}</div>
      <div id="flowlist" class="rows"></div>${asof(r)}</div>`;
  } else html += `<div class="card"><h3>Stock flow</h3>${unavailable(r, 'F&O OI data')}</div>`;
  el.innerHTML = html + '</div>' + `<h3 class="bl" style="font-size:11px;letter-spacing:1px;margin:12px 2px 6px">INDICES</h3>` + indexGrid(idx);
  const sa = $('#secall'); if (sa) sa.onclick = () => { mfSectorsAll = !mfSectorsAll; loadFlow(); };
  el.querySelectorAll('#flowchips button').forEach(b => b.onclick = () => {
    flowFilter = b.dataset.f; flowShown = 40; renderFlowList();
    el.querySelectorAll('#flowchips button').forEach(x => x.classList.toggle('on', x === b));
  });
  if (r.ok) renderFlowList();
}
function renderFlowList() {
  const all = flowData.data.stocks.filter(s => flowFilter === 'ALL' || s.tag === flowFilter), rows = all.slice(0, flowShown);
  $('#flowlist').innerHTML = rows.map(s => `<div class="row" data-sym="${esc(s.symbol)}">
      <div class="s"><b>${esc(s.symbol)}</b><span class="badge ${TAG[s.tag]}">${esc(s.tag)}</span></div>
      <div class="n">${fmt(s.ltp)}<br><small class="mut">px</small> ${pct(s.price_pct)} <small class="mut">OI</small> ${pct(s.oi_pct)}</div></div>`).join('') +
    (all.length > flowShown ? `<button class="more" id="flowmore">Show more (${all.length - flowShown})</button>` : '');
  $('#flowlist').querySelectorAll('.row').forEach(x => x.onclick = () => openChart(x.dataset.sym));
  const m = $('#flowmore'); if (m) m.onclick = () => { flowShown += 60; renderFlowList(); };
}

// ---------------------------------------------------------------- money flow (sector in/out, F&O build-up, MFI / delta)
const cr = x => x == null ? '—' : (Math.abs(x) >= 1000 ? fmt(x / 1000, 1) + 'k' : fmt(x, 0)) + ' Cr';
let mfSectorsAll = false;
function flowChart(s) {  // two panels: cumulative delta (Rs Cr) and MFI 0-100
  const pts = s.series.filter(p => p.cd != null); if (pts.length < 3) return '';
  const W = 320, H1 = 70, H2 = 46, G = 8, n = pts.length - 1;
  const cds = pts.map(p => p.cd), mn = Math.min(0, ...cds), mx = Math.max(0, ...cds);
  const x = i => (i / n * W).toFixed(1), y1 = v => (H1 - (mx === mn ? H1 / 2 : (v - mn) / (mx - mn) * (H1 - 4) + 2)).toFixed(1);
  const zero = y1(0), line = pts.map((p, i) => `${x(i)},${y1(p.cd)}`).join(' ');
  const last = cds[cds.length - 1], col = last >= 0 ? 'var(--g)' : 'var(--r)';
  const mf = pts.map((p, i) => p.mfi == null ? null : `${x(i)},${(H1 + G + H2 - p.mfi / 100 * H2).toFixed(1)}`).filter(Boolean).join(' ');
  const gy = v => (H1 + G + H2 - v / 100 * H2).toFixed(1);
  return `<svg class="fchart" viewBox="0 0 ${W} ${H1 + G + H2}" preserveAspectRatio="none">
    <line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="#2a3a50" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
    <polygon points="0,${zero} ${line} ${W},${zero}" fill="${col}" opacity=".15"/>
    <polyline points="${line}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <rect x="0" y="${gy(80)}" width="${W}" height="${(gy(20) - gy(80)).toFixed(1)}" fill="#3fb0ff0d"/>
    <line x1="0" x2="${W}" y1="${gy(80)}" y2="${gy(80)}" stroke="#ff4d6a55" vector-effect="non-scaling-stroke"/>
    <line x1="0" x2="${W}" y1="${gy(20)}" y2="${gy(20)}" stroke="#00ff9c55" vector-effect="non-scaling-stroke"/>
    <polyline points="${mf}" fill="none" stroke="var(--y)" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>
    <div class="fleg"><span><i style="background:${col}"></i>Cum. delta</span><span><i style="background:var(--y)"></i>MFI (80/20 bands)</span></div>`;
}
function moneyFlowHtml(mf) {
  if (!mf || !mf.ok) return `<div class="card"><h3>Money flow</h3>${unavailable(mf, 'money flow')}</div>`;
  const d = mf.data, S = d.sectors; let h = '';
  if (S) {
    const tot = (S.inflow_cr || 0) + (S.outflow_cr || 0) || 1, rows = mfSectorsAll ? S.rows : [...S.rows.slice(0, 6), ...S.rows.slice(-6)].filter((r, i, a) => a.indexOf(r) === i);
    const mx = Math.max(...S.rows.map(r => Math.abs(r.net_cr || 0)), 1);
    h += `<div class="card"><h3>Where money is going today</h3>
      <div class="big ${S.net_cr >= 0 ? 'up' : 'dn'}">${S.net_cr >= 0 ? 'NET INFLOW' : 'NET OUTFLOW'} ${cr(Math.abs(S.net_cr))}</div>
      <div class="mut">${esc((S.universe || "").split(" (")[0])} turnover: <b class="up">${cr(S.inflow_cr)} in</b> (stocks up) · <b class="dn">${cr(S.outflow_cr)} out</b> (stocks down)</div>
      <div class="bar"><i style="width:${S.inflow_cr / tot * 100}%;background:var(--g)"></i><i style="width:${S.outflow_cr / tot * 100}%;background:var(--r)"></i></div>
      <div class="sectors">${rows.map(r => `<div class="sec">
        <div class="sn"><b>${esc(r.sector)}</b><small class="mut">${r.up}↑ ${r.down}↓ · ${pct(r.pct)}</small></div>
        <div class="sv ${r.net_cr >= 0 ? 'up' : 'dn'}">${r.net_cr >= 0 ? '+' : '−'}${cr(Math.abs(r.net_cr))}</div>
        <div class="sb"><div class="half l">${r.net_cr < 0 ? `<i style="width:${Math.abs(r.net_cr) / mx * 100}%"></i>` : ''}</div><div class="half r">${r.net_cr >= 0 ? `<i style="width:${r.net_cr / mx * 100}%"></i>` : ''}</div></div>
        <div class="sl mut">${r.leaders.map(x => `${esc(x.symbol)} ${x.pct >= 0 ? '+' : ''}${fmt(x.pct, 1)}%`).join(' · ')}</div></div>`).join('')}</div>
      ${S.rows.length > 12 ? `<button class="more" id="secall">${mfSectorsAll ? 'Show top and bottom only' : `Show all ${S.rows.length} sectors`}</button>` : ''}
      <div class="asof">Net = turnover of rising stocks − falling stocks, ${S.stocks} ${esc(S.universe || "")} stocks · ${esc(S.as_of)}</div></div>`;
  } else h += `<div class="card"><h3>Where money is going today</h3>${unavailable({error: (d.errors || []).join('; ')}, 'sector flow')}</div>`;
  if (d.fno) {
    const T = d.fno.tags, tc = T.reduce((a, t) => a + t.count, 0) || 1, tt = (d.fno.bull_cr + d.fno.bear_cr) || 1;
    const col = {'LONG BUILD-UP': 'var(--g)', 'SHORT COVERING': 'var(--b)', 'SHORT BUILD-UP': 'var(--r)', 'LONG UNWINDING': 'var(--o)'};
    h += `<div class="card"><h3>F&amp;O build-up · ${tc} stocks</h3>
      <div class="mut">Bullish OI money <b class="up">${cr(d.fno.bull_cr)}</b> vs bearish <b class="dn">${cr(d.fno.bear_cr)}</b></div>
      <div class="bar"><i style="width:${d.fno.bull_cr / tt * 100}%;background:var(--g)"></i><i style="width:${d.fno.bear_cr / tt * 100}%;background:var(--r)"></i></div>
      <div class="fno">${T.map(t => `<div class="ft" style="border-color:${col[t.tag]}"><span class="badge ${TAG[t.tag]}">${t.tag}</span><b>${t.count}</b><small class="mut">${cr(t.turnover_cr)} turnover</small><div class="bar"><i style="width:${t.count / tc * 100}%;background:${col[t.tag]}"></i></div></div>`).join('')}</div>
      <div class="asof">${esc(d.fno.source)} · OI ${esc(d.fno.as_of)}</div></div>`;
  }
  for (const k of ['NIFTY', 'BANKNIFTY']) {
    const s = d.intraday && d.intraday[k];
    if (!s) { h += `<div class="card"><h3>${k} · MFI &amp; delta</h3>${unavailable({error: 'no intraday data'}, k + ' money flow index')}</div>`; continue; }
    const mcls = s.mfi > 80 ? 'dn' : s.mfi < 20 ? 'up' : s.mfi >= 55 ? 'up' : s.mfi <= 45 ? 'dn' : 'or';
    h += `<div class="card"><h3>${k} · intraday money flow</h3>
      <div class="kv"><div><span>MFI (14×5m)</span><b class="${mcls}">${fmt(s.mfi, 1)}</b></div><div><span>Reading</span><b class="${mcls}" style="font-size:11px;white-space:normal">${esc(s.mfi_state)}</b></div>
      <div><span>Cum. delta</span><b class="${s.cum_delta_cr >= 0 ? 'up' : 'dn'}">${s.cum_delta_cr >= 0 ? '+' : ''}${cr(s.cum_delta_cr)}</b></div><div><span>Turnover</span><b>${cr(s.turnover_cr)}</b></div></div>
      ${flowChart(s)}
      <div class="asof">Volume proxy: 5-min turnover of ${s.constituents} ${k === 'NIFTY' ? 'NIFTY 50' : 'bank'} stocks (index volume isn't published) · ${esc(s.as_of)}</div></div>`;
  }
  return `<div class="grid">${h}</div>`;
}

// ---------------------------------------------------------------- order blocks
let obType = 'ALL', obTf = 'ALL', obShown = 30, obData = null;
const obRange = b => `${fmt(b.bottom)} – ${fmt(b.top)}`;
function obRow(b, i, dead) {
  const side = b.type === 'BULL', where = side ? (b.dist_pct >= 0 ? 'above zone' : 'inside') : (b.dist_pct >= 0 ? 'below zone' : 'inside');
  return `<div class="row ob ${dead ? 'dead' : ''}" data-i="${i}" data-d="${dead ? 1 : 0}">
    <div class="s"><b>${esc(b.symbol)} <span class="badge ${side ? 'b-lb' : 'b-sb'}">${side ? 'BULL OB' : 'BEAR OB'}</span> <span class="pill">${b.tf}</span></b>
      <small class="mut">${obRange(b)} · formed ${esc(b.formed)}${dead ? ` · ${b.status} ${esc(b.status_at)}` : ''}</small></div>
    <div class="n">${dead ? `<span class="badge ${b.status === 'BROKEN' ? 'b-sb' : 'b-y'}">${b.status}</span>` : `<b class="${Math.abs(b.dist_pct) < 0.5 ? 'or' : ''}">${fmt(Math.abs(b.dist_pct))}%</b><br><small class="mut">${where}</small>`}</div></div>`;
}
async function loadOB() {
  const r = await api('/api/orderblocks'), el = $('#tab-ob');
  if (!r.ok) { el.innerHTML = unavailable(r, 'order blocks'); return; }
  obData = r; const c = r.data.counts;
  const chip = (k, cur, v) => `<button data-${k}="${v}" class="${v === cur ? 'on' : ''}">${v}</button>`;
  el.innerHTML = `<div class="idx">
      <div class="ic"><div class="l">Active blocks</div><div class="v">${c.active}</div><div class="c"><span class="up">${c.bull} bull</span> · <span class="dn">${c.bear} bear</span></div></div>
      <div class="ic"><div class="l">Mitigated / broken</div><div class="v mut">${c.mitigated_or_broken}</div><div class="c mut">last 5 sessions</div></div></div>
    <div class="card"><h3>Active order blocks · nearest first</h3>
      <div class="chips">${['ALL', 'BULL', 'BEAR'].map(v => chip('t', obType, v)).join('')}${['5m', '15m'].map(v => chip('f', obTf, v)).join('')}</div>
      <div id="oblist" class="rows"></div></div>
    <div class="card"><h3>Recently mitigated / broken</h3><div id="obdead" class="rows"></div></div>
    <div class="card"><h3>How a block qualifies</h3><div class="mut">${esc(r.data.method)}</div><div class="asof">${esc(r.data.universe)} · ${esc(r.source)} · ${esc(r.as_of)}</div></div>`;
  el.querySelectorAll('[data-t],[data-f]').forEach(b => b.onclick = () => {
    if (b.dataset.t) obType = b.dataset.t; else obTf = obTf === b.dataset.f ? 'ALL' : b.dataset.f;
    obShown = 30; loadOBList();
    el.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('on', x.dataset.t === obType));
    el.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('on', x.dataset.f === obTf));
  });
  loadOBList();
}
function loadOBList() {
  const f = b => (obType === 'ALL' || b.type === obType) && (obTf === 'ALL' || b.tf === obTf);
  const act = obData.data.active.filter(f), dead = obData.data.recent_mitigated.filter(f).slice(0, 15);
  $('#oblist').innerHTML = (act.slice(0, obShown).map((b, i) => obRow(b, i, false)).join('') || '<div class="mut">No active blocks for this filter.</div>') +
    (act.length > obShown ? `<button class="more" id="obmore">Show more (${act.length - obShown})</button>` : '');
  $('#obdead').innerHTML = dead.map((b, i) => obRow(b, i, true)).join('') || '<div class="mut">None.</div>';
  const m = $('#obmore'); if (m) m.onclick = () => { obShown += 40; loadOBList(); };
  document.querySelectorAll('#tab-ob .row.ob').forEach(x => x.onclick = () => {
    const b = (x.dataset.d === '1' ? dead : act)[+x.dataset.i]; openChart(b.symbol, null, '5m', b);
  });
}
// Shaded order-block zones over the candlestick chart (HTML overlay positioned from chart coordinates).
function drawZones(cs, blocks, firstT, focus) {
  const box = $('#chart'); if (!chart || !box) return;
  let layer = $('#oblayer'); if (!layer) { layer = document.createElement('div'); layer.id = 'oblayer'; box.appendChild(layer); }
  const ts = chart.timeScale(), w = ts.width();
  const seen = {};  // same zone on 5m and 15m: draw once, label both
  blocks = blocks.filter(b => { const k = b.top + '|' + b.bottom + '|' + b.status; if (seen[k]) { seen[k].tf2 = b.tf; return false; } seen[k] = b = Object.assign(b, {tf2: null}); return true; });
  layer.innerHTML = blocks.map(b => {
    const y1 = cs.priceToCoordinate(b.top), y2 = cs.priceToCoordinate(b.bottom);
    if (y1 == null || y2 == null || (y1 < 0 && y2 < 0) || (y1 > box.clientHeight && y2 > box.clientHeight)) return '';
    const xa = ts.timeToCoordinate(Math.max(b.formed_t, firstT)), xb = b.status_t ? ts.timeToCoordinate(b.status_t) : null;
    const x1 = Math.max(0, xa == null ? 0 : xa), x2 = Math.min(w, xb == null ? w : xb);
    if (x2 <= x1) return '';
    const bull = b.type === 'BULL', on = focus && b.formed_t === focus.formed_t && b.tf === focus.tf;
    return `<div class="obz ${bull ? 'bull' : 'bear'} ${b.status !== 'ACTIVE' ? 'dead' : ''} ${on ? 'on' : ''}" style="left:${x1}px;width:${x2 - x1}px;top:${Math.min(y1, y2)}px;height:${Math.max(2, Math.abs(y2 - y1))}px"><span>${bull ? 'Bull' : 'Bear'} OB ${b.tf}${b.tf2 ? '+' + b.tf2 : ''}${b.status !== 'ACTIVE' ? ' · ' + b.status.toLowerCase() : ''}</span></div>`;
  }).join('');
}

// ---------------------------------------------------------------- options
let ocSym = 'NIFTY';
async function loadOptions() {
  const r = await api('/api/options?symbol=' + ocSym), el = $('#tab-options');
  const sel = `<div class="chips">${['NIFTY', 'BANKNIFTY', 'FINNIFTY'].map(s => `<button data-s="${s}" class="${s === ocSym ? 'on' : ''}">${s}</button>`).join('')}</div>`;
  if (!r.ok) { el.innerHTML = sel + unavailable(r, `${ocSym} option chain (NSE)`); bindOc(el); return; }
  const d = r.data, mx = Math.max(...d.chain.map(x => Math.max(x.ce_oi, x.pe_oi)), 1);
  el.innerHTML = sel + `<div class="idx">
    <div class="ic"><div class="l">${esc(d.symbol)} spot</div><div class="v">${fmt(d.spot)}</div><div class="c mut">ATM ${d.atm} · ${esc(d.expiry)}</div></div>
    <div class="ic"><div class="l">PCR (OI)</div><div class="v ${d.pcr > 1.2 ? 'up' : d.pcr < 0.8 ? 'dn' : 'or'}">${fmt(d.pcr)}</div><div class="c mut">${esc((d.pcr_bias || '').split(' ')[0])}</div></div>
    <div class="ic"><div class="l">Resistance · call wall</div><div class="v dn">${d.resistance}</div><div class="c mut">${lakh(d.resistance_oi)}</div></div>
    <div class="ic"><div class="l">Support · put wall</div><div class="v up">${d.support}</div><div class="c mut">${lakh(d.support_oi)}</div></div>
    <div class="ic"><div class="l">Max pain</div><div class="v bl">${d.max_pain ?? '—'}</div><div class="c mut">ΔOI PCR ${fmt(d.pcr_chg)}</div></div>
    <div class="ic"><div class="l">Walls within ±2%</div><div class="v"><span class="up">${d.near_support ?? '—'}</span>/<span class="dn">${d.near_resistance ?? '—'}</span></div></div>
  </div>
  <div class="card"><h3>Chain near ATM · swipe sideways →</h3><div class="hscroll"><table>
    <tr><th>STRIKE</th><th>CE OI</th><th>CE ΔOI</th><th>CE LTP</th><th>PE LTP</th><th>PE ΔOI</th><th>PE OI</th><th>CE IV</th><th>PE IV</th></tr>
    ${d.chain.map(x => `<tr class="${x.strike === d.atm ? 'atm' : ''}">
      <td class="${x.strike === d.resistance ? 'dn' : x.strike === d.support ? 'up' : ''}">${x.strike}</td>
      <td>${lakh(x.ce_oi)}<span class="oibar" style="width:${x.ce_oi / mx * 40}px;background:var(--r)"></span></td><td class="${x.ce_chg_oi >= 0 ? 'up' : 'dn'}">${lakh(x.ce_chg_oi)}</td><td>${fmt(x.ce_ltp)}</td>
      <td>${fmt(x.pe_ltp)}</td><td class="${x.pe_chg_oi >= 0 ? 'up' : 'dn'}">${lakh(x.pe_chg_oi)}</td><td><span class="oibar" style="width:${x.pe_oi / mx * 40}px;background:var(--g)"></span>${lakh(x.pe_oi)}</td>
      <td class="mut">${fmt(x.ce_iv, 1)}</td><td class="mut">${fmt(x.pe_iv, 1)}</td></tr>`).join('')}
  </table></div>${asof(r)}</div>`;
  bindOc(el);
}
function bindOc(el) { el.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { ocSym = b.dataset.s; loadOptions(); }); }

// ---------------------------------------------------------------- setups
const targets = a => {  // 1R / 2R from the trigger; computed from published entry and stop only
  if (a.t1 != null) return [a.t1, a.t2];
  const r = Math.abs(a.entry - a.stop), s = a.side === 'LONG' ? 1 : -1;
  return [+(a.entry + s * r).toFixed(2), +(a.entry + 2 * s * r).toFixed(2)];
};
function alertCard(a, i) {
  const [t1, t2] = targets(a);
  const vol = a.vol_spike ? `<span class="badge b-y">VOL SPIKE ${a.vol_ratio}×</span>` : a.vol_ratio != null ? `<span class="pill">vol ${a.vol_ratio}×</span>` : '';
  return `<div class="card alert ${a.side}" data-i="${i}">
    <div class="alert-top"><span class="sym">${esc(a.symbol)}</span><span class="badge ${a.side === 'LONG' ? 'b-lb' : 'b-sb'}">${a.side}</span><span class="pill">${esc(a.rule)}</span>${vol}</div>
    <div class="mut">${esc(a.time)} IST · ${esc(a.session)} · risk ${fmt(a.risk_pct)}%</div>
    <div class="kv"><div><span>Trigger</span><b>${fmt(a.entry)}</b></div><div><span>Stop</span><b class="or">${fmt(a.stop)}</b></div>
      <div><span>T1 (1R)</span><b class="bl">${fmt(t1)}</b></div><div><span>T2 (2R)</span><b class="bl">${fmt(t2)}</b></div></div>
    <div class="why"><b>WHY IT QUALIFIED</b><br>${esc(a.why)}<br><b>STOP</b> ${esc(a.stop_why)}</div>
    <div class="tapcta">Tap for chart ›</div></div>`;
}
function bindAlerts(el, alerts) { el.querySelectorAll('.alert').forEach(c => c.onclick = () => openChart(alerts[+c.dataset.i].symbol, alerts[+c.dataset.i])); }
let setupSide = 'ALL', setupShown = 20;
async function loadSetups() {
  const r = await api('/api/setups'), el = $('#tab-setups');
  if (!r.ok) { el.innerHTML = unavailable(r, 'intraday setups'); return; }
  const d = r.data, all = d.alerts.filter(a => setupSide === 'ALL' || (setupSide === 'VOL SPIKE' ? a.vol_spike : a.side === setupSide));
  const shown = all.slice(0, setupShown);
  el.innerHTML = `<div class="chips">${['ALL', 'LONG', 'SHORT', 'VOL SPIKE'].map(k => `<button data-k="${k}" class="${k === setupSide ? 'on' : ''}">${k}</button>`).join('')}</div>
    <div class="mut" style="margin:0 2px 10px">${all.length} alerts · session ${esc(d.session || '—')} · ${d.universe} symbols. Rule matches, not recommendations.</div>
    <div class="grid">${shown.length ? shown.map(alertCard).join('') : '<div class="mut">No alerts for this filter.</div>'}</div>
    ${all.length > setupShown ? `<button class="more" id="setmore">Show more (${all.length - setupShown})</button>` : ''}
    <div class="card" style="margin-top:12px"><h3>Rules</h3><ul>${d.rules.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${asof(r)}</div>`;
  el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { setupSide = b.dataset.k; setupShown = 20; loadSetups(); });
  const m = $('#setmore'); if (m) m.onclick = () => { setupShown += 30; loadSetups(); };
  bindAlerts(el, shown);
}

// ---------------------------------------------------------------- calm zone
async function loadCalm() {
  const r = await api('/api/calm'), el = $('#tab-calm');
  if (!r.ok) { el.innerHTML = unavailable(r, 'calm zone'); return; }
  const d = r.data, cnt = s => d.tiles.filter(t => t.state === s).length;
  el.innerHTML = `<div class="card"><h3>Calm zone · ${esc(d.session)}</h3>
    <span class="badge b-sc">CALM ${cnt('CALM')}</span> <span class="badge b-lu">NORMAL ${cnt('NORMAL')}</span> <span class="badge b-sb">VOLATILE ${cnt('VOLATILE')}</span>
    <div class="asof">${esc(d.rule)}</div></div>
    <div class="tiles">${d.tiles.map(t => `<div class="tile ${t.state}" data-sym="${esc(t.symbol)}">
      <div class="hd"><b>${esc(t.symbol)}</b><span class="badge ${t.state === 'CALM' ? 'b-sc' : t.state === 'VOLATILE' ? 'b-sb' : 'b-lu'}">${t.state[0]}</span></div>
      ${spark(t.spark, t.pct >= 0 ? '#00ff9c' : '#ff4d6a')}
      <div>${fmt(t.last)}</div><div>${pct(t.pct)} <span class="mut">R/ATR ${fmt(t.ratio)}</span></div></div>`).join('')}</div>${asof(r)}`;
  el.querySelectorAll('.tile').forEach(t => t.onclick = () => openChart(t.dataset.sym));
}

// ---------------------------------------------------------------- screener
async function loadScreener() {
  const r = await api('/api/screener'), el = $('#tab-screener');
  if (!r.ok) { el.innerHTML = unavailable(r, 'screener'); return; }
  const d = r.data;
  const rows = (list, right) => list.length ? `<div class="rows">${list.map(x => `<div class="row" data-sym="${esc(x.symbol)}"><div class="s"><b>${esc(x.symbol)}</b><small>${fmt(x.last)}</small></div><div class="n">${right(x)}</div></div>`).join('')}</div>` : '<div class="mut">None today.</div>';
  el.innerHTML = `<div class="grid">
    <div class="card"><h3>RSI(14) &lt; 30 · oversold</h3>${rows(d.oversold, x => `RSI <b class="up">${x.rsi}</b>`)}</div>
    <div class="card"><h3>RSI(14) &gt; 70 · overbought</h3>${rows(d.overbought, x => `RSI <b class="dn">${x.rsi}</b>`)}</div>
    <div class="card"><h3>MACD cross · last 3 sessions</h3>${rows(d.macd, x => `<b class="${x.macd_cross === 'BULLISH' ? 'up' : 'dn'}">${x.macd_cross}</b><br><small class="mut">${esc(x.macd_cross_date)} · RSI ${x.rsi}</small>`)}</div>
    <div class="card"><h3>Minervini trend template</h3><div class="mut">${esc(d.note)}</div>
      ${rows(d.minervini, x => `<b class="${x.minervini_pass === x.minervini_total ? 'up' : x.minervini_pass >= 5 ? 'or' : 'mut'}">${x.minervini_pass}/${x.minervini_total}</b><br><small>${pct(x.pct_from_52w_high)} <span class="mut">vs 52w hi</span></small>`)}</div>
  </div><div class="asof">Universe: ${esc(d.universe)} · tap a stock for its daily chart</div>${asof(r)}`;
  el.querySelectorAll('.row').forEach(x => x.onclick = () => openChart(x.dataset.sym, null, '1d'));
}

// ---------------------------------------------------------------- gold & btc
async function loadGlobal() {
  const r = await api('/api/global'), el = $('#tab-global');
  if (!r.ok) { el.innerHTML = unavailable(r, 'gold & crypto'); return; }
  el.innerHTML = `<div class="grid">${r.data.cards.map(c => c.ok ? `<div class="card"><h3>${esc(c.label)}</h3>
    <div class="big">$${fmt(c.last_usd)}</div><div>${pct(c.pct)} <span class="mut">H ${fmt(c.high)} · L ${fmt(c.low)}</span></div>
    ${spark(c.spark, c.pct >= 0 ? '#00ff9c' : '#ff4d6a')}<div class="mut">5-day hourly</div>
    ${c.inr_10g ? `<div style="margin-top:8px;font-size:18px">≈ ₹${fmt(c.inr_10g, 0)} / 10 g</div><div class="asof">${esc(c.inr_note)}</div>` : ''}
    ${c.inr ? `<div style="margin-top:8px;font-size:18px">≈ ₹${fmt(c.inr, 0)}</div>` : ''}
    <div class="asof">last bar ${esc(c.as_of)}</div></div>` : `<div class="card"><h3>${esc(c.label)}</h3>${unavailable({error: 'no data'}, c.label)}</div>`).join('')}
    <div class="card"><h3>USD / INR</h3><div class="big">${fmt(r.data.usdinr, 3)}</div>
    <div class="asof">MCX gold has no free public feed here, so COMEX gold (GC=F) is shown as the XAUUSD proxy.</div></div></div>${asof(r)}`;
}

// ---------------------------------------------------------------- chart bottom sheet
let chart = null;
function closeSheet() { $('#sheet').classList.add('hidden'); document.body.style.overflow = ''; if (chart) { chart.remove(); chart = null; } }
async function openChart(symbol, alert = null, interval = '5m', obFocus = null) {
  $('#sheet').classList.remove('hidden'); document.body.style.overflow = 'hidden';
  $('#sheet-title').textContent = `${symbol} · ${interval === '1d' ? 'daily' : '5-min IST'}`;
  if (alert) {
    const [t1, t2] = targets(alert);
    $('#sheet-why').innerHTML = `<div class="kv"><div><span>Trigger</span><b>${fmt(alert.entry)}</b></div><div><span>Stop</span><b class="or">${fmt(alert.stop)}</b></div><div><span>T1</span><b class="bl">${fmt(t1)}</b></div><div><span>T2</span><b class="bl">${fmt(t2)}</b></div></div><div class="why"><b>WHY IT QUALIFIED</b><br>${esc(alert.why)}<br><b>STOP</b> ${esc(alert.stop_why)}</div>`;
  } else $('#sheet-why').innerHTML = '';
  const box = $('#chart'); box.innerHTML = '<div class="loading">loading…</div>';
  const r = await api(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);
  if ($('#sheet').classList.contains('hidden')) return;
  box.innerHTML = '';
  if (!r.ok) { box.innerHTML = unavailable(r, 'candles'); return; }
  if (chart) chart.remove();
  chart = LightweightCharts.createChart(box, {autoSize: true, layout: {background: {color: '#0b111a'}, textColor: '#d6e6f5', fontSize: 13},
    grid: {vertLines: {color: '#16212f'}, horzLines: {color: '#16212f'}}, timeScale: {timeVisible: interval !== '1d', secondsVisible: false},
    rightPriceScale: {borderColor: '#1a2636'}, crosshair: {mode: 0}, handleScroll: {vertTouchDrag: false}});
  const cs = chart.addCandlestickSeries({upColor: '#00ff9c', downColor: '#ff4d6a', borderVisible: false, wickUpColor: '#00ff9c', wickDownColor: '#ff4d6a'});
  cs.setData(r.data.bars);
  if (r.data.vwap) chart.addLineSeries({color: '#3fb0ff', lineWidth: 1, title: r.data.vwap_kind, priceLineVisible: false, lastValueVisible: false}).setData(r.data.vwap.filter(x => x.value != null));
  if (alert) {
    const [t1, t2] = targets(alert);
    cs.createPriceLine({price: alert.entry, color: '#ffe14d', lineWidth: 1, lineStyle: 0, title: 'TRIG'});
    cs.createPriceLine({price: alert.stop, color: '#ffad3b', lineWidth: 1, lineStyle: 2, title: 'STOP'});
    cs.createPriceLine({price: t1, color: '#3fb0ff', lineWidth: 1, lineStyle: 1, title: 'T1'});
    cs.createPriceLine({price: t2, color: '#3fb0ff', lineWidth: 1, lineStyle: 1, title: 'T2'});
    cs.setMarkers([{time: alert.chart_time, position: alert.side === 'LONG' ? 'belowBar' : 'aboveBar', color: alert.side === 'LONG' ? '#00ff9c' : '#ff4d6a',
      shape: alert.side === 'LONG' ? 'arrowUp' : 'arrowDown', text: alert.rule}]);
  }
  const obs = (r.data.order_blocks || []).filter(b => b.status !== 'ACTIVE' || Math.abs(b.dist_pct) <= 1.5 || (obFocus && b.formed_t === obFocus.formed_t));
  if (obFocus) {
    cs.createPriceLine({price: obFocus.top, color: obFocus.type === 'BULL' ? '#00ff9c' : '#ff4d6a', lineWidth: 1, lineStyle: 2, title: `${obFocus.type} OB ${obFocus.tf}`});
    cs.createPriceLine({price: obFocus.bottom, color: obFocus.type === 'BULL' ? '#00ff9c' : '#ff4d6a', lineWidth: 1, lineStyle: 2, title: ''});
    $('#sheet-why').innerHTML = `<div class="why"><b>${obFocus.type === 'BULL' ? 'BULLISH' : 'BEARISH'} ORDER BLOCK · ${obFocus.tf}</b><br>Zone ${obRange(obFocus)} · formed ${esc(obFocus.formed)} · structure broke ${esc(obFocus.bos)} · ${obFocus.status}${obFocus.status_at ? ' ' + esc(obFocus.status_at) : ''}</div>`;
  }
  chart.timeScale().fitContent();
  if (obs.length && r.data.bars.length) {
    const redraw = () => requestAnimationFrame(() => drawZones(cs, obs, r.data.bars[0].time, obFocus));
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw); chart.subscribeCrosshairMove(redraw);
    new ResizeObserver(redraw).observe($('#chart')); setTimeout(redraw, 60); setTimeout(redraw, 400);
  }
  $('#sheet-title').textContent += ` · ${r.as_of}`;
}
$('#sheet-close').onclick = closeSheet;
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => chart && chart.timeScale().fitContent(), 250); });
$('#sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

// ---------------------------------------------------------------- tabs, swipe, refresh
const ORDER = ['pretrade', 'flow', 'ob', 'options', 'setups', 'calm', 'screener', 'global'];
const LOADERS = {pretrade: loadPretrade, flow: loadFlow, ob: loadOB, options: loadOptions, setups: loadSetups, calm: loadCalm, screener: loadScreener, global: loadGlobal};
let current = (location.hash || '#pretrade').slice(1);
if (!LOADERS[current]) current = 'pretrade';
function show(tab, scroll = false) {  // only the active tab is rendered (lazy)
  current = tab; history.replaceState(null, '', location.search + '#' + tab);
  document.querySelectorAll('nav button').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('active', on); if (on && scroll) b.scrollIntoView({inline: 'center', block: 'nearest'}); });
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  if (scroll) window.scrollTo(0, 0);
  const el = $('#tab-' + tab); if (!el.innerHTML) el.innerHTML = '<div class="loading">loading live data…</div>';
  return LOADERS[tab]().then(() => {
    $('#updated').textContent = '· page refreshed ' + new Date().toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit'}) + ' IST';
    document.body.dataset.loaded = tab;
  });
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab, true));
let tx = null, ty = null;
$('#main').addEventListener('touchstart', e => {
  if (e.target.closest('.hscroll,.chips')) { tx = null; return; }
  tx = e.touches[0].clientX; ty = e.touches[0].clientY;
}, {passive: true});
$('#main').addEventListener('touchend', e => {
  if (tx == null) return;
  const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty; tx = null;
  if (Math.abs(dx) < 70 || Math.abs(dx) < 2 * Math.abs(dy)) return;
  const i = ORDER.indexOf(current) + (dx < 0 ? 1 : -1);
  if (i >= 0 && i < ORDER.length) show(ORDER[i], true);
}, {passive: true});
async function refresh() {
  await Promise.all([loadStatus(), loadIndices()]);
  if ($('#sheet').classList.contains('hidden')) await show(current);
}
refresh(); setInterval(refresh, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
