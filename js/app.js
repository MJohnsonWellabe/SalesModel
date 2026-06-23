/* Wellabe Rate Competitiveness & 2027 Sales Impact — main app logic. */
(() => {
  'use strict';

  const LS_KEY = 'wellabe_rate_model_v6'; // bumped: per-month ratios, rate-take, CA/MD off
  const DEFAULTS = {
    rerate: 0.15,        // Big 6 rerate before we act
    benchStat: 'avg',    // avg | median | min  (over the six Big-6 group rates)
    offset: -0.05,       // target position vs Big 6 post-rerate benchmark
    growth: 0.0,         // 2027 runrate growth from 2026 baseline
    baselineTotal: null, // 2026 baseline $ total (null => use data.json default)
    baseline2026: null,  // optional uploaded 2026 monthly by state {ST:[12]}; null => data.json
    defaultStart: '2027-04-01', // default rate-increase start date (per-state overridable)
    stateOn: {},         // state -> bool; absent => true (take the increase)
    stateStart: {},      // state -> 'YYYY-MM-DD'; absent => defaultStart
    rateTake: {},        // state -> rate increase actually taken; absent => required increase
    // Per-state-per-month 2027/2026 ratio; entry null/absent => 1+growth. Establishes the 2027
    // baseline (reductions are done by lowering a month's ratio, e.g. IN Jan-Apr = 0.5).
    growthRatio: {},     // state -> array[12]
    reductionMode: 'count', // 'count' = elasticity cuts policy COUNT, premium/policy rises
                            //   with the rate increase; 'premium' = cuts premium dollars directly
    elastic: [           // {t: required-increase threshold, r: policy-count reduction}
      { t: 0.05, r: 0.05 },
      { t: 0.10, r: 0.15 },
      { t: 0.15, r: 0.30 },
      { t: 0.20, r: 0.40 },
      { t: 0.30, r: 0.60 },
      { t: 0.40, r: 0.70 },
    ],
    overrides: {},       // state -> count-reduction fraction
    mc: { impactSd: 0.20, delaySd: 1.0, trials: 2000 }, // Monte Carlo params
  };

  let DATA = null;       // loaded data.json
  let FRESH = false;     // true when no saved settings exist (apply computed default plan)
  let S = loadState();   // current inputs (may set FRESH)
  let MODEL = null;      // computed model (cached)
  let SUMMARY_EXPORT = [];  // array-of-arrays for the summary CSV export
  let MONTHLY_EXPORT = [];   // array-of-arrays for the monthly-by-state CSV export

  // ---------- state ----------
  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY));
      if (raw) return Object.assign(structuredClone(DEFAULTS), raw);
    } catch (e) { /* ignore */ }
    FRESH = true;
    return structuredClone(DEFAULTS);
  }
  function saveState() { localStorage.setItem(LS_KEY, JSON.stringify(S)); }

  // Default per-state plan (needs computed gaps): only the top-10 states we are
  // most behind Big 6 take the increase; MD & CA are on but start late (10/1).
  function applyDefaultPlan() {
    compute(); // rate-side gaps are independent of the plan inputs
    const ranked = DATA.salesStates
      .filter(s => MODEL.rateStates[s])
      .sort((a, b) => MODEL.rateStates[b].gapToday - MODEL.rateStates[a].gapToday);
    const top10 = new Set(ranked.slice(0, 10));
    S.stateOn = {};
    S.stateStart = {};
    for (const s of DATA.salesStates) {
      if (!top10.has(s)) S.stateOn[s] = false; // top 10 stay on (absent => on)
    }
    for (const s of ['MD', 'CA']) S.stateOn[s] = false; // no meaningful sales in window -> off
    saveState();
  }

  // ---------- compute engine ----------
  function benchmark(big6, stat) {
    const vals = big6.filter(v => v != null);
    if (!vals.length) return null;
    if (stat === 'min') return Math.min(...vals);
    if (stat === 'median') {
      const s = [...vals].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    return vals.reduce((a, b) => a + b, 0) / vals.length; // avg
  }

  const PROJ_YEAR = 2027; // the projection window we reduce
  // First PROJ_YEAR month (1..12) the increase affects; 1 if already in effect, 99 if off/after.
  function startMonthNum(startStr, on) {
    if (!on) return 99;
    const [sy, sm] = String(startStr).split('-').map(Number);
    if (!sy || sy < PROJ_YEAR) return 1;
    if (sy > PROJ_YEAR) return 99;
    return sm;
  }
  // Is PROJ_YEAR month `monthIdx` (0..11) on/after the rate-increase start date?
  function affectedFrac(startStr, monthIdx) {
    const [sy, sm] = String(startStr).split('-').map(Number);
    if (!sy) return 1;
    if (sy < PROJ_YEAR) return 1;   // already in effect before the window
    if (sy > PROJ_YEAR) return 0;   // starts after the window
    return (monthIdx + 1) >= sm ? 1 : 0;
  }

  function elasticity(inc) {
    // highest tier whose threshold <= increase; below first threshold => 0
    const tiers = [...S.elastic].sort((a, b) => a.t - b.t);
    let r = 0;
    for (const tier of tiers) { if (inc >= tier.t) r = tier.r; }
    return r;
  }

  function compute() {
    const stat = S.benchStat, rerate = S.rerate, offset = S.offset;
    // Per-state aggregation over rate cells
    const states = {}; // st -> {incrs, wSum, bSum, n}
    for (const c of DATA.cells) {
      const [st, , , , , wellabe, big6] = c;
      const bench = benchmark(big6, stat);
      if (bench == null || !wellabe) continue;
      const target = bench * (1 + rerate) * (1 + offset);
      const reqInc = Math.max(0, target / wellabe - 1);
      if (!states[st]) states[st] = { incrs: [], wSum: 0, bSum: 0, n: 0 };
      const o = states[st];
      o.incrs.push(reqInc); o.wSum += wellabe; o.bSum += bench; o.n++;
    }
    const rateStates = {};
    for (const st in states) {
      const o = states[st];
      const avgInc = o.incrs.reduce((a, b) => a + b, 0) / o.n;
      rateStates[st] = {
        reqInc: avgInc,
        wellabeAvg: o.wSum / o.n,
        big6Avg: o.bSum / o.n,
        gapToday: (o.bSum / o.n) / (o.wSum / o.n) - 1, // how far below big6 today
        cells: o.n,
      };
    }

    // Sales projection over the selling states
    const scale = (S.baselineTotal && DATA.baselineTotal)
      ? S.baselineTotal / DATA.baselineTotal : 1;
    const sales = {};
    let base2027 = 0, adj2027 = 0, baseline2026 = 0;
    for (const st of DATA.salesStates) {
      const sd = DATA.sales[st];
      const rs = rateStates[st];
      const reqInc = rs ? rs.reqInc : 0;                // required increase to reach target
      const on = S.stateOn[st] !== false;              // default: take the increase
      const start = S.stateStart[st] || S.defaultStart; // YYYY-MM-DD
      // Rate increase actually taken (user-overridable per state); defaults to required.
      const rateInc = (st in S.rateTake) ? S.rateTake[st] : reqInc;
      // Policy-count reduction once the increase is fully in effect (elasticity on the TAKEN increase):
      const countRed = on ? ((st in S.overrides) ? S.overrides[st] : elasticity(rateInc)) : 0;
      // Premium uplift on the policies that DO get written (count mode only) = the taken increase.
      const uplift = (on && S.reductionMode === 'count') ? rateInc : 0;

      // --- Establish the baseline (before any rerate impact) ---
      // 2026 by month (custom upload or default, scaled); 2027 = 2026 x per-month ratio (default 1+growth).
      const months26 = base26For(st);
      const est27 = est27For(st);
      const b26 = months26.reduce((a, b) => a + b, 0);

      // --- Layer the rerate impact on top of the established baseline ---
      const monthsAdj = est27.map((v, i) => {
        const a = affectedFrac(start, i);
        return v * (1 - countRed * a) * (1 + uplift * a);
      });
      const b27 = est27.reduce((a, b) => a + b, 0);             // established 2027 baseline
      const a27 = monthsAdj.reduce((a, b) => a + b, 0);
      const adjAnnual27 = b26 * (1 + S.growth);                 // 2027 at the flat default growth
      sales[st] = {
        baseline2026: b26, baseline2027: b27, adjusted2027: a27,
        preAdj2027: adjAnnual27,                 // 2027 at flat growth, before per-month ratio edits
        baselineAdjImpact: adjAnnual27 - b27,    // $ removed by per-month ratio reductions
        countRed, uplift, rateInc,
        affFrom: startMonthNum(start, on),       // first 2027 month the rerate hits (1..12, 99=never)
        effReduction: b27 ? (b27 - a27) / b27 : 0, // rerate reduction vs established baseline
        reqInc, loss: b27 - a27, on, start,
        hasRate: !!rs, months26, months: est27, monthsAdj,
      };
      baseline2026 += b26; base2027 += b27; adj2027 += a27;
    }

    // Weighted avg required increase across selling states (by 2026 sales)
    let wInc = 0, wSum = 0;
    for (const st of DATA.salesStates) {
      const rs = rateStates[st];
      if (rs) { wInc += rs.reqInc * DATA.sales[st].annual; wSum += DATA.sales[st].annual; }
    }
    const sellWeightedInc = wSum ? wInc / wSum : 0;

    // Avg gap today across selling states (sales-weighted)
    let gInc = 0, gSum = 0;
    for (const st of DATA.salesStates) {
      const rs = rateStates[st];
      if (rs) { gInc += rs.gapToday * DATA.sales[st].annual; gSum += DATA.sales[st].annual; }
    }
    const sellWeightedGap = gSum ? gInc / gSum : 0;

    MODEL = {
      rateStates, sales, baseline2026, base2027, adj2027,
      totalLoss: base2027 - adj2027,
      lossPct: base2027 ? (base2027 - adj2027) / base2027 : 0,
      sellWeightedInc, sellWeightedGap,
    };
    return MODEL;
  }

  // ---------- formatting ----------
  const F = {
    money: v => '$' + Math.round(v).toLocaleString(),
    moneyShort: Charts.moneyShort,
    pct1: v => (v * 100).toFixed(1) + '%',
    pct0: v => Math.round(v * 100) + '%',
    signpct: v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%',
    // loss is a positive number; negative loss = premium gain
    lossGain: v => v >= 0
      ? `<span style="color:var(--bad)">−$${Math.round(v).toLocaleString()}</span>`
      : `<span style="color:var(--good)">+$${Math.round(-v).toLocaleString()}</span>`,
  };
  const SELL = new Set(); // selling states set (filled after load)

  // Export an array-of-arrays (first row = header) as a CSV that Excel opens cleanly.
  function downloadCSV(filename, rows) {
    const esc = v => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = rows.map(r => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function readFile(input, cb) {
    const f = input.files && input.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { cb(r.result); } catch (e) { alert('Could not read file: ' + e.message); } input.value = ''; };
    r.readAsText(f);
  }
  // Standard-normal sampler (Box–Muller).
  function randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const clamp01 = x => Math.max(0, Math.min(1, x));

  // ---------- rendering ----------
  function renderAll() {
    compute();
    renderSummary();
    renderRates();
    renderIncreases();
    renderSales();
    renderStatePlan();
    refreshBaseline2027();
    syncInputWidgets();
  }

  function kpi(label, value, sub, cls) {
    return `<div class="kpi"><div class="label">${label}</div>
      <div class="value ${cls || ''}">${value}</div>
      <div class="delta">${sub || ''}</div></div>`;
  }

  function renderSummary() {
    document.getElementById('sumRerate').textContent = F.pct0(S.rerate);
    document.getElementById('sumTarget').textContent =
      (S.offset === 0 ? 'at' : `${Math.abs(S.offset * 100).toFixed(0)}% ${S.offset < 0 ? 'below' : 'above'}`);
    const m = MODEL;
    document.getElementById('summaryKpis').innerHTML = [
      kpi('Avg gap below Big 6 today', F.pct1(m.sellWeightedGap),
          'Sales-weighted; Big 6 avg ÷ our rate − 1', 'warn'),
      kpi('Avg increase we must take', F.pct1(m.sellWeightedInc),
          'To reach target after Big 6 rerate', 'bad'),
      kpi('2027 baseline sales', F.moneyShort(m.base2027),
          '2026 projection carried forward'),
      kpi('2027 adjusted sales', F.moneyShort(m.adj2027),
          'After count drop + premium uplift', 'good'),
      m.totalLoss >= 0
        ? kpi('Net premium loss', '−' + F.moneyShort(m.totalLoss), F.pct1(m.lossPct) + ' of baseline', 'bad')
        : kpi('Net premium gain', '+' + F.moneyShort(-m.totalLoss), F.pct1(-m.lossPct) + ' over baseline', 'good'),
    ].join('');

    // State-by-state summary table (sorted by 2027 baseline)
    const sts = [...DATA.salesStates].filter(s => DATA.sales[s].annual > 0)
      .sort((a, b) => m.sales[b].baseline2027 - m.sales[a].baseline2027);
    const header = ['State', 'Gap vs Big6 %', 'Req increase %', 'Take', 'Start',
      'Baseline adj %', '2027 baseline', '2027 adjusted', 'Rerate net %', 'Loss/gain'];
    const rows = sts.map(s => {
      const x = m.sales[s], rs = m.rateStates[s];
      const badjPct = x.preAdj2027 ? x.baselineAdjImpact / x.preAdj2027 : 0;
      return {
        s, gap: rs ? rs.gapToday : null, req: rs ? x.reqInc : null,
        on: x.on, start: x.on ? x.start : '', badj: badjPct,
        base: x.baseline2027, adj: x.adjusted2027, net: x.effReduction, loss: x.loss,
      };
    });
    SUMMARY_EXPORT = [header, ...rows.map(r => [
      r.s, r.gap == null ? '' : (r.gap * 100).toFixed(1), r.req == null ? '' : (r.req * 100).toFixed(1),
      r.on ? 'Yes' : 'No', r.start, (r.badj * 100).toFixed(0),
      Math.round(r.base), Math.round(r.adj), (r.net * 100).toFixed(1), Math.round(-r.loss),
    ]), ['TOTAL', '', '', '', '', '', Math.round(m.base2027), Math.round(m.adj2027),
      (m.lossPct * 100).toFixed(1), Math.round(-m.totalLoss)]];

    const tbl = document.getElementById('summaryTable');
    tbl.innerHTML = `<thead><tr>
      <th class="left">State</th><th>Gap vs Big6</th><th>Req +%</th><th>Take</th><th class="left">Start</th>
      <th>Baseline adj</th><th>2027 baseline</th><th>2027 adjusted</th><th>Rerate Δ%</th><th>Loss / gain</th>
      </tr></thead><tbody>` +
      rows.map(r => `<tr>
        <td class="left">${r.s}</td>
        <td class="${r.gap > 0 ? 'pos' : 'muted'}">${r.gap == null ? '—' : F.pct1(r.gap)}</td>
        <td>${r.req == null ? '—' : F.pct1(r.req)}</td>
        <td class="${r.on ? '' : 'muted'}">${r.on ? '✓' : '—'}</td>
        <td class="left muted">${r.on ? fmtStart(r.start) : '—'}</td>
        <td class="${r.badj > 0 ? 'neg' : 'muted'}">${r.badj > 0 ? '−' + F.pct1(r.badj) : '—'}</td>
        <td>${F.money(r.base)}</td><td>${F.money(r.adj)}</td>
        <td class="${r.net > 0 ? 'neg' : (r.net < 0 ? 'pos' : 'muted')}">${F.pct1(r.net)}</td>
        <td>${F.lossGain(r.loss)}</td></tr>`).join('') +
      `<tr style="font-weight:700"><td class="left">TOTAL</td><td></td><td></td><td></td><td></td><td></td>
        <td>${F.money(m.base2027)}</td><td>${F.money(m.adj2027)}</td>
        <td class="${m.lossPct >= 0 ? 'neg' : 'pos'}">${F.pct1(m.lossPct)}</td>
        <td>${F.lossGain(m.totalLoss)}</td></tr></tbody>`;

    // one chart kept for visual appeal
    Charts.salesByState('chartSummarySales', sts,
      sts.map(s => m.sales[s].baseline2027),
      sts.map(s => m.sales[s].adjusted2027),
      { horizontal: true });
  }

  // ----- Rate Competitiveness tab -----
  let rateSel = { state: null, age: null, gender: null, zip: null };
  function buildRateControls() {
    const stSel = document.getElementById('rateState');
    const rateStateList = [...new Set(DATA.cells.map(c => c[0]))].sort();
    stSel.innerHTML = rateStateList.map(s => `<option>${s}</option>`).join('');
    stSel.value = SELL.has('NC') ? 'NC' : rateStateList[0];
    rateSel.state = stSel.value;
    const ageSel = document.getElementById('rateAge');
    ageSel.innerHTML = `<option value="">All ages</option>` +
      [65, 68, 70, 75, 80].map(a => `<option>${a}</option>`).join('');
    const gSel = document.getElementById('rateGender');
    gSel.innerHTML = `<option value="">All</option><option value="M">Male</option><option value="F">Female</option>`;
    stSel.onchange = () => { rateSel.state = stSel.value; rateSel.zip = null; renderRates(); };
    ageSel.onchange = () => { rateSel.age = ageSel.value; rateSel.zip = null; renderRates(); };
    gSel.onchange = () => { rateSel.gender = gSel.value; rateSel.zip = null; renderRates(); };
  }

  function renderRates() {
    const st = rateSel.state;
    const rows = DATA.cells.filter(c =>
      c[0] === st &&
      (!rateSel.age || c[2] === +rateSel.age) &&
      (!rateSel.gender || c[3] === rateSel.gender));
    document.getElementById('rateCellCount').textContent = `${rows.length} cells`;
    document.getElementById('rateTableTitle').textContent =
      `— ${st}${rateSel.age ? ', age ' + rateSel.age : ''}${rateSel.gender ? ', ' + (rateSel.gender === 'M' ? 'Male' : 'Female') : ''}`;

    const stat = S.benchStat;
    const tbl = document.getElementById('rateTable');
    const rowData = rows.map(c => {
      const [s, zip, age, g, city, wellabe, big6] = c;
      const bench = benchmark(big6, stat);
      const after = bench != null ? bench * (1 + S.rerate) : null;
      const target = after != null ? after * (1 + S.offset) : null;
      const req = target != null ? Math.max(0, target / wellabe - 1) : null;
      return { c, zip, age, g, city, wellabe, bench, after, target, req };
    });
    const maxReq = Math.max(0.0001, ...rowData.map(r => r.req || 0));
    tbl.innerHTML =
      `<thead><tr>
        <th class="left">Zip</th><th class="left">City</th><th>Age</th><th>Sex</th>
        <th>Wellabe</th><th>Big6 (${stat})</th><th>Big6 +${F.pct0(S.rerate)}</th>
        <th>Target</th><th>Req&nbsp;%</th></tr></thead><tbody>` +
      rowData.map((r, i) => {
        const sel = rateSel.zip === r.zip + '|' + r.age + '|' + r.g;
        return `<tr class="clickable ${sel ? 'selected' : ''}" data-i="${i}">
          <td class="left">${r.zip}</td><td class="left">${r.city || ''}</td>
          <td>${r.age}</td><td>${r.g}</td>
          <td>$${r.wellabe.toFixed(0)}</td>
          <td>${r.bench != null ? '$' + r.bench.toFixed(0) : '—'}</td>
          <td>${r.after != null ? '$' + r.after.toFixed(0) : '—'}</td>
          <td>${r.target != null ? '$' + r.target.toFixed(0) : '—'}</td>
          <td class="bar-cell pos"><div class="bar" style="width:${(r.req || 0) / maxReq * 100}%"></div>
            <span>${r.req != null ? F.pct1(r.req) : '—'}</span></td>
        </tr>`;
      }).join('') + '</tbody>';

    tbl.querySelectorAll('tr.clickable').forEach(tr => {
      tr.onclick = () => {
        const r = rowData[+tr.dataset.i];
        rateSel.zip = r.zip + '|' + r.age + '|' + r.g;
        drawRateStack(r);
        tbl.querySelectorAll('tr').forEach(x => x.classList.remove('selected'));
        tr.classList.add('selected');
      };
    });

    // default chart = first row, or the cell average if none picked
    if (rowData.length) {
      const pick = rowData.find(r => rateSel.zip === r.zip + '|' + r.age + '|' + r.g) || rowData[0];
      drawRateStack(pick, !rateSel.zip);
    }
  }

  function drawRateStack(r, isAggregate) {
    const labels = DATA.buckets.map(b => DATA.bucketLabels[b]);
    const today = r.c[6];
    const after = today.map(v => v == null ? null : v * (1 + S.rerate));
    document.getElementById('rateChartTitle').textContent =
      `Carrier stack-up — ${r.c[0]} ${r.zip}xx, age ${r.age}, ${r.g === 'M' ? 'Male' : 'Female'}`;
    Charts.rateStack('chartRateStack', labels, today, after, r.wellabe, r.target);
  }

  // ----- Required Increases tab -----
  let incSort = { key: 'reqInc', dir: -1 };
  function renderIncreases() {
    const m = MODEL;
    const rsStates = Object.keys(m.rateStates).sort();
    // KPIs
    const sellInc = DATA.salesStates.filter(s => m.rateStates[s]);
    const maxState = sellInc.reduce((a, b) => m.rateStates[b].reqInc > m.rateStates[a].reqInc ? b : a, sellInc[0]);
    const minState = sellInc.reduce((a, b) => m.rateStates[b].reqInc < m.rateStates[a].reqInc ? b : a, sellInc[0]);
    document.getElementById('incKpis').innerHTML = [
      kpi('Sales-weighted required increase', F.pct1(m.sellWeightedInc), 'Across selling states', 'bad'),
      kpi('Largest required increase', `${maxState} ${F.pct1(m.rateStates[maxState].reqInc)}`, 'Furthest below Big 6 today', 'warn'),
      kpi('Smallest required increase', `${minState} ${F.pct1(m.rateStates[minState].reqInc)}`, 'Closest to Big 6 today', 'good'),
      kpi('States needing > 20% rerate', sellInc.filter(s => m.rateStates[s].reqInc > 0.20).length + ' of ' + sellInc.length, 'Triggers max attrition tier'),
    ].join('');

    // chart sorted by reqInc, selling states only
    const sts = sellInc.sort((a, b) => m.rateStates[b].reqInc - m.rateStates[a].reqInc);
    Charts.pctByState('chartInc', sts.map(s => s + (SELL.has(s) ? ' •' : '')),
      sts.map(s => m.rateStates[s].reqInc),
      sts.map(s => m.rateStates[s].reqInc > 0.20 ? Charts.COL.loss : (m.rateStates[s].reqInc > 0.10 ? Charts.COL.big6 : Charts.COL.good)),
      { label: 'Required increase:' });

    // table
    const tbl = document.getElementById('incTable');
    const rows = sellInc.map(s => {
      const rs = m.rateStates[s], sa = m.sales[s];
      return { s, gap: rs.gapToday, wellabe: rs.wellabeAvg, big6: rs.big6Avg,
               target: rs.big6Avg * (1 + S.rerate) * (1 + S.offset), reqInc: rs.reqInc,
               reduction: sa.countRed, cells: rs.cells };
    });
    rows.sort((a, b) => {
      const av = a[incSort.key], bv = b[incSort.key];
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return cmp * incSort.dir;
    });
    const head = [['s', 'State', 'left'], ['gap', 'Gap today'], ['wellabe', 'Wellabe avg'],
      ['big6', 'Big6 avg'], ['target', 'Target'], ['reqInc', 'Req %'], ['reduction', 'Count −%'], ['cells', 'Cells']];
    tbl.innerHTML = `<thead><tr>` +
      head.map(([k, lbl, cls]) => `<th class="${cls || ''}" data-k="${k}">${lbl}${incSort.key === k ? (incSort.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('') +
      `</tr></thead><tbody>` +
      rows.map(r => `<tr>
        <td class="left">${r.s}${SELL.has(r.s) ? '<span class="tag-sell">sell</span>' : ''}</td>
        <td class="pos">${F.pct1(r.gap)}</td>
        <td>$${r.wellabe.toFixed(0)}</td><td>$${r.big6.toFixed(0)}</td>
        <td>$${r.target.toFixed(0)}</td>
        <td class="${r.reqInc > 0.2 ? 'neg' : ''}">${F.pct1(r.reqInc)}</td>
        <td class="neg">${F.pct1(r.reduction)}</td>
        <td class="muted">${r.cells}</td></tr>`).join('') + '</tbody>';
    tbl.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (incSort.key === k) incSort.dir *= -1; else { incSort.key = k; incSort.dir = -1; }
      renderIncreases();
    });
  }

  // ----- Sales tab -----
  function renderSales() {
    const m = MODEL;
    document.getElementById('salesGrowthLbl').textContent = F.signpct(S.growth);
    document.getElementById('salesBaseLbl').textContent = F.moneyShort(m.baseline2026);
    document.getElementById('salesKpis').innerHTML = [
      kpi('2026 baseline', F.moneyShort(m.baseline2026), 'From sales-tracking projection'),
      kpi('2027 baseline', F.moneyShort(m.base2027), `Carried forward ${F.signpct(S.growth)}`),
      kpi('2027 adjusted', F.moneyShort(m.adj2027), 'After count drop + premium uplift', 'good'),
      m.totalLoss >= 0
        ? kpi('Net premium lost', '−' + F.moneyShort(m.totalLoss), F.pct1(m.lossPct) + ' of baseline', 'bad')
        : kpi('Net premium gained', '+' + F.moneyShort(-m.totalLoss), F.pct1(-m.lossPct) + ' over baseline', 'good'),
    ].join('');

    const sts = [...DATA.salesStates].filter(s => DATA.sales[s].annual > 0)
      .sort((a, b) => m.sales[b].baseline2027 - m.sales[a].baseline2027);
    Charts.salesByState('chartSalesByState', sts,
      sts.map(s => m.sales[s].baseline2027), sts.map(s => m.sales[s].adjusted2027),
      { horizontal: false, s2026: sts.map(s => m.sales[s].baseline2026) });

    // waterfall: baseline -> each state's net premium delta (loss down / gain up) -> adjusted
    const impactSorted = sts.filter(s => Math.abs(m.sales[s].loss) > 1)
      .sort((a, b) => Math.abs(m.sales[b].loss) - Math.abs(m.sales[a].loss));
    const wf = impactSorted.slice(0, 12);
    const otherDelta = impactSorted.slice(12).reduce((a, s) => a + m.sales[s].loss, 0);
    const steps = wf.map(s => ({ label: s, d: m.sales[s].loss }));
    if (Math.abs(otherDelta) > 1) steps.push({ label: 'Other', d: otherDelta });
    const labels = ['2027 baseline', ...steps.map(s => s.label), '2027 adjusted'];
    const bases = [0]; const floats = [m.base2027]; const colors = [Charts.COL.base];
    let running = m.base2027;
    for (const { d } of steps) {
      const after = running - d;
      bases.push(Math.min(running, after)); floats.push(Math.abs(d));
      colors.push(d >= 0 ? Charts.COL.loss : Charts.COL.good);
      running = after;
    }
    bases.push(0); floats.push(m.adj2027); colors.push(Charts.COL.adj);
    Charts.waterfall('chartSalesWaterfall', labels, bases, floats, colors);

    // monthly state selector
    const sel = document.getElementById('salesMonthState');
    if (!sel.dataset.built) {
      sel.innerHTML = sts.map(s => `<option>${s}</option>`).join('');
      sel.value = sts[0]; sel.dataset.built = '1';
      sel.onchange = drawMonthly;
    }
    drawMonthly();

    // detail table
    const countMode = S.reductionMode === 'count';
    const tbl = document.getElementById('salesTable');
    tbl.innerHTML = `<thead><tr>
      <th class="left">State</th><th>Take?</th><th>Start</th><th>2027 base</th>
      <th>Count −%</th><th>Rate +%</th><th>Net −% (timed)</th><th>2027 adjusted</th><th>Loss / gain</th></tr></thead><tbody>` +
      sts.map(s => { const x = m.sales[s]; return `<tr>
        <td class="left">${s}${SELL.has(s) ? '<span class="tag-sell">sell</span>' : ''}${x.hasRate ? '' : ' <span class="muted">(no rate data)</span>'}</td>
        <td>${x.on ? '✓' : '<span class="muted">—</span>'}</td>
        <td class="muted">${x.on ? fmtStart(x.start) : '—'}</td>
        <td>${F.money(x.baseline2027)}</td>
        <td class="${x.on && x.countRed > 0 ? 'neg' : 'muted'}">${x.on ? F.pct1(x.countRed) : '—'}</td>
        <td class="${x.on && x.rateInc > 0 ? 'pos' : 'muted'}">${x.on ? '+' + F.pct1(x.rateInc) : '—'}</td>
        <td class="${x.effReduction > 0 ? 'neg' : (x.effReduction < 0 ? 'pos' : 'muted')}">${F.pct1(x.effReduction)}</td>
        <td>${F.money(x.adjusted2027)}</td>
        <td>${F.lossGain(x.loss)}</td></tr>`; }).join('') +
      `<tr style="font-weight:700"><td class="left">TOTAL</td><td></td><td></td>
        <td>${F.money(m.base2027)}</td><td></td><td></td>
        <td class="${m.lossPct >= 0 ? 'neg' : 'pos'}">${F.pct1(m.lossPct)}</td>
        <td>${F.money(m.adj2027)}</td><td>${F.lossGain(m.totalLoss)}</td></tr></tbody>`;

    renderMonthlyTable(sts);
  }

  // Monthly-by-state matrix for 2026 (baseline) and 2027 (adjusted), + CSV export.
  function renderMonthlyTable(sts) {
    const m = MODEL, mo = DATA.months;
    const header = ['State', 'Year', ...mo, 'Total'];
    const exp = [header];
    const bodyRows = [];
    const totals26 = Array(12).fill(0), totals27 = Array(12).fill(0);
    for (const s of sts) {
      const x = m.sales[s];
      const sum = a => a.reduce((p, c) => p + c, 0);
      x.months26.forEach((v, i) => totals26[i] += v);
      x.monthsAdj.forEach((v, i) => totals27[i] += v);
      exp.push([s, 2026, ...x.months26.map(v => Math.round(v)), Math.round(sum(x.months26))]);
      exp.push([s, 2027, ...x.monthsAdj.map(v => Math.round(v)), Math.round(sum(x.monthsAdj))]);
      bodyRows.push(`<tr><td class="left" rowspan="2">${s}</td><td class="muted">2026</td>${
        x.months26.map(v => `<td>${F.moneyShort(v)}</td>`).join('')}<td>${F.moneyShort(sum(x.months26))}</td></tr>
        <tr><td>2027</td>${x.monthsAdj.map(v => `<td>${F.moneyShort(v)}</td>`).join('')}<td>${F.moneyShort(sum(x.monthsAdj))}</td></tr>`);
    }
    const sumAll = a => a.reduce((p, c) => p + c, 0);
    exp.push(['TOTAL', 2026, ...totals26.map(v => Math.round(v)), Math.round(sumAll(totals26))]);
    exp.push(['TOTAL', 2027, ...totals27.map(v => Math.round(v)), Math.round(sumAll(totals27))]);
    MONTHLY_EXPORT = exp;

    const tbl = document.getElementById('monthlyTable');
    tbl.innerHTML = `<thead><tr><th class="left">State</th><th>Year</th>${
      mo.map(x => `<th>${x}</th>`).join('')}<th>Total</th></tr></thead><tbody>` +
      bodyRows.join('') +
      `<tr style="font-weight:700"><td class="left" rowspan="2">TOTAL</td><td>2026</td>${
        totals26.map(v => `<td>${F.moneyShort(v)}</td>`).join('')}<td>${F.moneyShort(sumAll(totals26))}</td></tr>
       <tr style="font-weight:700"><td>2027</td>${totals27.map(v => `<td>${F.moneyShort(v)}</td>`).join('')}<td>${F.moneyShort(sumAll(totals27))}</td></tr></tbody>`;
  }

  // 'YYYY-MM-DD' -> 'Mon YYYY'
  function fmtStart(s) {
    const [y, mo] = String(s).split('-').map(Number);
    return DATA.months[(mo || 1) - 1] + " '" + String(y).slice(2);
  }

  function drawMonthly() {
    const s = document.getElementById('salesMonthState').value;
    const x = MODEL.sales[s];
    Charts.monthly('chartSalesMonthly', DATA.months, x.months, x.monthsAdj);
  }

  // ----- Inputs tab -----
  function buildInputs() {
    const r = document.getElementById('inRerate');
    const o = document.getElementById('inOffset');
    const bs = document.getElementById('inBenchStat');
    const bl = document.getElementById('inBaseline');
    bl.min = Math.round(DATA.baselineTotal * 0.6);
    bl.max = Math.round(DATA.baselineTotal * 1.4);
    r.oninput = () => { S.rerate = +r.value; commit(); };
    o.oninput = () => { S.offset = +o.value; commit(); };
    bs.onchange = () => { S.benchStat = bs.value; commit(); };
    bl.oninput = () => { S.baselineTotal = +bl.value; commit(); };
    const rm = document.getElementById('inReductionMode');
    rm.onchange = () => { S.reductionMode = rm.value; buildElasticTable(); commit(); };
    document.getElementById('dlSummary').onclick = () =>
      downloadCSV('wellabe_2027_summary.csv', SUMMARY_EXPORT);
    document.getElementById('dlMonthly').onclick = () =>
      downloadCSV('wellabe_monthly_by_state_2026_2027.csv', MONTHLY_EXPORT);
    document.getElementById('addTier').onclick = () => {
      S.elastic.push({ t: 0.5, r: 0.6 }); buildElasticTable(); commit();
    };
    // Per-state plan bulk controls
    const ds = document.getElementById('inDefaultStart');
    ds.onchange = () => { S.defaultStart = ds.value || '2027-01-01'; commit(); };
    document.getElementById('applyStartAll').onclick = () => {
      DATA.salesStates.forEach(s => { S.stateStart[s] = S.defaultStart; }); commit();
    };
    document.getElementById('enableAll').onclick = () => { S.stateOn = {}; commit(); };
    document.getElementById('disableAll').onclick = () => {
      DATA.salesStates.forEach(s => { S.stateOn[s] = false; }); commit();
    };
    document.getElementById('resetBtn').onclick = () => {
      S = structuredClone(DEFAULTS); applyDefaultPlan(); buildElasticTable(); buildBaselineUI(); renderAll();
    };
    // Save / share model
    document.getElementById('exportModel').onclick = () => downloadJSON('wellabe_model.json', S);
    document.getElementById('importModel').onchange = (e) => readFile(e.target, txt => {
      const obj = JSON.parse(txt);
      S = Object.assign(structuredClone(DEFAULTS), obj);
      saveState(); buildElasticTable(); buildBaselineUI(); renderAll();
    });
    document.getElementById('exportDates').onclick = () => {
      const rows = [['State', 'Take', 'StartDate']];
      DATA.salesStates.forEach(s => rows.push([s, S.stateOn[s] !== false ? 'Yes' : 'No',
        S.stateStart[s] || S.defaultStart]));
      downloadCSV('wellabe_start_dates.csv', rows);
    };
    document.getElementById('importDates').onchange = (e) => readFile(e.target, txt => {
      const lines = txt.trim().split(/\r?\n/).slice(1);
      lines.forEach(ln => {
        const [st, take, date] = ln.split(',').map(x => (x || '').trim());
        if (!st || !DATA.sales[st]) return;
        if (/^no$/i.test(take)) S.stateOn[st] = false; else delete S.stateOn[st];
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) S.stateStart[st] = date;
      });
      commit();
    });
    buildElasticTable();
    buildBaselineUI();
    buildMonteCarlo();
  }

  function buildElasticTable() {
    const t = document.getElementById('elasticTable');
    const tiers = [...S.elastic].sort((a, b) => a.t - b.t);
    S.elastic = tiers;
    const rlabel = S.reductionMode === 'count' ? 'Policy-count reduction' : 'Premium reduction';
    t.innerHTML = `<thead><tr><th>Required increase ≥</th><th>${rlabel}</th><th></th></tr></thead><tbody>` +
      tiers.map((tier, i) => `<tr>
        <td><input type="number" step="1" min="0" data-i="${i}" data-f="t" value="${Math.round(tier.t * 100)}">%</td>
        <td><input type="number" step="1" min="0" data-i="${i}" data-f="r" value="${Math.round(tier.r * 100)}">%</td>
        <td><button class="btn secondary" data-del="${i}" style="padding:3px 9px">×</button></td>
      </tr>`).join('') + '</tbody>';
    t.querySelectorAll('input').forEach(inp => inp.onchange = () => {
      S.elastic[+inp.dataset.i][inp.dataset.f] = (+inp.value) / 100; commit(); buildElasticTable();
    });
    t.querySelectorAll('button[data-del]').forEach(b => b.onclick = () => {
      S.elastic.splice(+b.dataset.del, 1); buildElasticTable(); commit();
    });
  }

  // Per-state plan table (rebuilt each recompute; inputs commit on blur).
  function renderStatePlan() {
    const t = document.getElementById('statePlanTable');
    if (!t) return;
    const m = MODEL;
    const sts = DATA.salesStates.filter(s => DATA.sales[s].annual > 0);
    t.innerHTML = `<thead><tr>
      <th class="left">State</th><th>Take<br>increase</th><th class="left">Start date</th>
      <th>Rate&nbsp;+%<br>(take)</th><th>Count&nbsp;−%<br>override</th><th>Net&nbsp;−%<br>(timed)</th><th>2027&nbsp;loss / gain</th>
      </tr></thead><tbody>` +
      sts.map(s => {
        const x = m.sales[s], rs = m.rateStates[s];
        const on = S.stateOn[s] !== false;
        const start = S.stateStart[s] || S.defaultStart;
        const ov = s in S.overrides ? Math.round(S.overrides[s] * 100) : '';
        const rt = s in S.rateTake ? Math.round(S.rateTake[s] * 100) : '';
        const reqPh = rs ? Math.round(x.reqInc * 100) : 0; // required increase as placeholder default
        return `<tr>
          <td class="left">${s}${SELL.has(s) ? '<span class="tag-sell">sell</span>' : ''}${rs ? '' : ' <span class="muted">(no rate data)</span>'}</td>
          <td><input type="checkbox" data-st="${s}" data-f="on" ${on ? 'checked' : ''}></td>
          <td class="left"><input type="date" data-st="${s}" data-f="start" value="${start}" ${on ? '' : 'disabled'} style="min-width:140px"></td>
          <td><input type="number" step="1" min="0" data-st="${s}" data-f="rt" value="${rt}" placeholder="${reqPh}" style="width:64px" ${on ? '' : 'disabled'}>%</td>
          <td><input type="number" step="1" min="0" max="100" placeholder="auto" data-st="${s}" data-f="ov" value="${ov}" style="width:64px" ${on ? '' : 'disabled'}>%</td>
          <td class="${x.effReduction > 0 ? 'neg' : (x.effReduction < 0 ? 'pos' : 'muted')}">${F.pct1(x.effReduction)}</td>
          <td>${F.lossGain(x.loss)}</td></tr>`;
      }).join('') + '</tbody>';

    t.querySelectorAll('input').forEach(inp => {
      const st = inp.dataset.st, f = inp.dataset.f;
      inp.onchange = () => {
        if (f === 'on') { if (inp.checked) delete S.stateOn[st]; else S.stateOn[st] = false; }
        else if (f === 'start') { S.stateStart[st] = inp.value || S.defaultStart; }
        else if (f === 'ov') {
          if (inp.value === '') delete S.overrides[st];
          else S.overrides[st] = Math.max(0, Math.min(1, (+inp.value) / 100));
        }
        else if (f === 'rt') {
          if (inp.value === '') delete S.rateTake[st];
          else S.rateTake[st] = Math.max(0, (+inp.value) / 100);
        }
        commit();
      };
    });
  }

  function syncInputWidgets() {
    document.getElementById('inRerate').value = S.rerate;
    document.getElementById('inRerateVal').textContent = F.pct0(S.rerate);
    document.getElementById('inOffset').value = S.offset;
    document.getElementById('inOffsetVal').textContent =
      S.offset === 0 ? 'match benchmark' : `${F.signpct(S.offset)} vs benchmark`;
    document.getElementById('inBenchStat').value = S.benchStat;
    const baseTot = S.baselineTotal || DATA.baselineTotal;
    document.getElementById('inBaseline').value = baseTot;
    document.getElementById('inBaselineVal').textContent =
      F.moneyShort(baseTot) + (S.baselineTotal && Math.abs(S.baselineTotal - DATA.baselineTotal) > 1
        ? ` (${F.signpct(baseTot / DATA.baselineTotal - 1)} vs model)` : ' (model)');
    document.getElementById('inDefaultStart').value = S.defaultStart;
    document.getElementById('inReductionMode').value = S.reductionMode;
    const isCount = S.reductionMode === 'count';
    document.getElementById('elasticWhat').textContent = isCount ? 'policy-count' : 'premium';
    document.getElementById('elasticWhat2').textContent = isCount ? 'policy count' : 'premium';
    const g2 = document.getElementById('inGrowth2');
    if (g2) { g2.value = S.growth; document.getElementById('inGrowth2Val').textContent = F.signpct(S.growth); }
  }

  // ---------- Baseline tab ----------
  const MOS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const scaleNow = () => (S.baselineTotal && DATA.baselineTotal) ? S.baselineTotal / DATA.baselineTotal : 1;
  // Source-of-truth 2026 monthly for a state (custom if uploaded/edited, else default×scale).
  function base26For(st) {
    if (S.baseline2026 && S.baseline2026[st]) return S.baseline2026[st].slice();
    const sc = scaleNow();
    return (DATA.sales[st] ? DATA.sales[st].months : Array(12).fill(0)).map(v => v * sc);
  }
  // Once the user edits/uploads, take ownership: materialize all states, drop the scale slider.
  function ensureCustomBaseline() {
    if (S.baseline2026) return;
    S.baseline2026 = {};
    DATA.salesStates.forEach(s => { S.baseline2026[s] = base26For(s); });
    S.baselineTotal = null;
  }
  // Per-month 2027/2026 ratio; an explicit value wins, else the flat 1+growth default.
  function ratioFor(st, m) {
    const arr = S.growthRatio[st];
    const r = arr ? arr[m] : null;
    return (r == null) ? (1 + S.growth) : r;
  }
  // 2027 established baseline months for a state = 2026[m] × per-month ratio.
  function est27For(st) {
    return base26For(st).map((v, m) => v * ratioFor(st, m));
  }

  function buildBaselineUI() {
    const sts = DATA.salesStates.filter(s => DATA.sales[s].annual > 0);
    // status
    const status = document.getElementById('baselineStatus');
    status.textContent = S.baseline2026
      ? 'Using a custom uploaded/edited baseline (the 2026 total scale slider is disabled).'
      : 'Using the default 2026 projection. Upload or edit any cell to take ownership.';
    // template + upload + reset + growth
    document.getElementById('dlTemplate').onclick = () => {
      const rows = [['State', ...MOS]];
      sts.forEach(s => rows.push([s, ...base26For(s).map(v => Math.round(v))]));
      downloadCSV('wellabe_baseline_2026_template.csv', rows);
    };
    document.getElementById('upBaseline').onchange = (e) => readFile(e.target, txt => {
      const lines = txt.trim().split(/\r?\n/);
      const out = {}; let n = 0;
      lines.slice(1).forEach(ln => {
        const parts = ln.split(',').map(x => (x || '').trim());
        const st = parts[0]; if (!st || !DATA.sales[st]) return;
        const mv = parts.slice(1, 13).map(x => +x || 0);
        if (mv.length === 12) { out[st] = mv; n++; }
      });
      if (!n) { alert('No valid rows found. Expect: State,Jan,…,Dec'); return; }
      sts.forEach(s => { if (!out[s]) out[s] = base26For(s); }); // keep states not in file
      S.baseline2026 = out; S.baselineTotal = null;
      buildBaselineTable(); buildBaselineUI(); commit();
    });
    document.getElementById('resetBaseline').onclick = () => {
      S.baseline2026 = null; buildBaselineTable(); buildBaselineUI(); commit();
    };
    const g2 = document.getElementById('inGrowth2');
    g2.oninput = () => { S.growth = +g2.value; commit(); };
    buildBaselineTable();
  }

  // Editable baseline: totals, monthly ratios, then 2026 (input) & 2027 (computed) amounts.
  // Frozen State column + a totals row. Cell refs cached for fast refresh.
  let BL_CELLS = null;
  const sumArr = a => a.reduce((p, c) => p + c, 0);
  const toM = v => (v / 1e6).toFixed(3);          // dollars -> millions string
  const fromM = x => (+x || 0) * 1e6;             // millions string -> dollars
  function blStatusCustom() {
    const st = document.getElementById('baselineStatus');
    if (st) st.textContent = 'Using a custom uploaded/edited baseline (the 2026 total scale slider is disabled).';
  }
  function buildBaselineTable() {
    const t = document.getElementById('baselineTable');
    if (!t) return;
    const sts = DATA.salesStates.filter(s => DATA.sales[s].annual > 0);
    const monthHdr = MOS.map(m => `<th>${m}</th>`).join('');
    t.innerHTML = `<thead>
      <tr><th class="left" rowspan="2">State</th><th rowspan="2">2026<br>total $M</th><th rowspan="2">2027<br>total $M</th>
        <th colspan="12">2027 / 2026 % (editable)</th><th colspan="12">2026 monthly $M</th><th colspan="12">2027 monthly $M</th></tr>
      <tr>${monthHdr}${monthHdr}${monthHdr}</tr></thead><tbody>` +
      sts.map(s => `<tr data-row="${s}"><td class="left">${s}</td>
        <td><input type="number" step="0.001" data-st="${s}" data-f="tot" value="0" style="width:78px"></td>
        <td data-c="tot27">—</td>
        ${MOS.map((m, i) => `<td><input type="number" step="1" data-st="${s}" data-f="ratio" data-i="${i}" value="" style="width:58px"></td>`).join('')}
        ${MOS.map((m, i) => `<td><input type="number" step="0.001" data-st="${s}" data-i="${i}" value="0" style="width:66px"></td>`).join('')}
        ${MOS.map((m, i) => `<td data-c="amt27" data-i="${i}">—</td>`).join('')}
      </tr>`).join('') +
      `<tr data-row="__total" style="font-weight:700"><td class="left">TOTAL</td>
        <td data-c="ttot26">—</td><td data-c="ttot27">—</td>
        ${MOS.map((m, i) => `<td data-c="tratio" data-i="${i}" class="muted">—</td>`).join('')}
        ${MOS.map((m, i) => `<td data-c="tamt26" data-i="${i}">—</td>`).join('')}
        ${MOS.map((m, i) => `<td data-c="tamt27" data-i="${i}">—</td>`).join('')}
      </tr></tbody>`;

    // cache refs
    BL_CELLS = { rows: {}, total: {} };
    for (const s of sts) {
      const tr = t.querySelector(`tr[data-row="${s}"]`);
      BL_CELLS.rows[s] = {
        totIn: tr.querySelector('input[data-f="tot"]'),
        tot27: tr.querySelector('[data-c="tot27"]'),
        ratio: [...tr.querySelectorAll('input[data-f="ratio"]')],
        amt26: [...tr.querySelectorAll('input[data-i]:not([data-f])')],
        amt27: [...tr.querySelectorAll('[data-c="amt27"]')],
      };
    }
    const tr = t.querySelector('tr[data-row="__total"]');
    BL_CELLS.total = {
      tot26: tr.querySelector('[data-c="ttot26"]'), tot27: tr.querySelector('[data-c="ttot27"]'),
      ratio: [...tr.querySelectorAll('[data-c="tratio"]')],
      amt26: [...tr.querySelectorAll('[data-c="tamt26"]')], amt27: [...tr.querySelectorAll('[data-c="tamt27"]')],
    };

    // seed editable 2026 inputs (in $M)
    for (const s of sts) { const b = base26For(s); BL_CELLS.rows[s].amt26.forEach((el, i) => el.value = toM(b[i])); }

    // editable 2026 monthly amounts ($M)
    BL_CELLS && sts.forEach(s => BL_CELLS.rows[s].amt26.forEach(inp => inp.onchange = () => {
      ensureCustomBaseline();
      S.baseline2026[s][+inp.dataset.i] = fromM(inp.value);
      blStatusCustom(); commit();
    }));
    // editable 2026 total ($M) -> scale the state's months proportionally
    sts.forEach(s => { BL_CELLS.rows[s].totIn.onchange = () => {
      ensureCustomBaseline();
      const target = fromM(BL_CELLS.rows[s].totIn.value);
      const cur = S.baseline2026[s], old = sumArr(cur);
      if (old > 0) cur.forEach((v, i) => cur[i] = v * target / old);
      else cur.forEach((_, i) => cur[i] = target / 12);
      BL_CELLS.rows[s].amt26.forEach((el, i) => el.value = toM(cur[i]));
      blStatusCustom(); commit();
    }; });
    // editable per-month 2027/2026 ratio (%) -> drives 2027
    sts.forEach(s => BL_CELLS.rows[s].ratio.forEach(inp => inp.onchange = () => {
      const i = +inp.dataset.i;
      if (inp.value === '') { if (S.growthRatio[s]) S.growthRatio[s][i] = null; }
      else { if (!S.growthRatio[s]) S.growthRatio[s] = Array(12).fill(null); S.growthRatio[s][i] = (+inp.value) / 100; }
      commit();
    }));
    refreshBaseline2027();
  }

  // Update totals, ratios (defaults) and the computed 2027 amounts (cheap; every recompute).
  function refreshBaseline2027() {
    if (!BL_CELLS) return;
    const sts = Object.keys(BL_CELLS.rows);
    const tot26 = Array(12).fill(0), tot27 = Array(12).fill(0);
    for (const s of sts) {
      const r = BL_CELLS.rows[s], b = base26For(s), e = est27For(s);
      if (document.activeElement !== r.totIn) r.totIn.value = toM(sumArr(b));
      r.tot27.textContent = toM(sumArr(e));
      b.forEach((v, i) => { tot26[i] += v; });
      e.forEach((v, i) => { r.amt27[i].textContent = toM(v); tot27[i] += v; });
      // ratio inputs: show explicit override, else placeholder = the live default (1+growth)
      r.ratio.forEach((inp, i) => {
        if (document.activeElement === inp) return;
        const arr = S.growthRatio[s], ov = arr ? arr[i] : null;
        inp.placeholder = ((1 + S.growth) * 100).toFixed(0);
        inp.value = (ov == null) ? '' : (ov * 100).toFixed(0);
      });
    }
    const T = BL_CELLS.total, s26 = sumArr(tot26), s27 = sumArr(tot27);
    T.tot26.textContent = toM(s26); T.tot27.textContent = toM(s27);
    tot26.forEach((v, i) => { T.ratio[i].textContent = tot26[i] ? (tot27[i] / tot26[i] * 100).toFixed(0) + '%' : '—'; T.amt26[i].textContent = toM(v); });
    tot27.forEach((v, i) => T.amt27[i].textContent = toM(v));
  }

  // ---------- Monte Carlo tab ----------
  let MC_TRIALS = [];
  function buildMonteCarlo() {
    const i = document.getElementById('mcImpact'), d = document.getElementById('mcDelay'),
          tr = document.getElementById('mcTrials');
    i.oninput = () => { S.mc.impactSd = +i.value; document.getElementById('mcImpactVal').textContent = F.pct0(S.mc.impactSd); saveState(); };
    d.oninput = () => { S.mc.delaySd = +d.value; document.getElementById('mcDelayVal').textContent = S.mc.delaySd + ' mo'; saveState(); };
    tr.onchange = () => { S.mc.trials = +tr.value; saveState(); };
    document.getElementById('runMC').onclick = runMC;
    document.getElementById('dlMC').onclick = () => {
      if (!MC_TRIALS.length) { alert('Run a simulation first.'); return; }
      downloadCSV('wellabe_montecarlo_trials.csv',
        [['Trial', 'Total2027Sales'], ...MC_TRIALS.map((v, k) => [k + 1, Math.round(v)])]);
    };
    i.value = S.mc.impactSd; d.value = S.mc.delaySd; tr.value = String(S.mc.trials);
    document.getElementById('mcImpactVal').textContent = F.pct0(S.mc.impactSd);
    document.getElementById('mcDelayVal').textContent = S.mc.delaySd + ' mo';
  }

  function runMC() {
    const m = MODEL, sts = DATA.salesStates.filter(s => DATA.sales[s].annual > 0);
    // precompute per-state arrays from the deterministic model
    const pre = sts.map(s => {
      const x = m.sales[s];
      return { est: x.months, cr: x.countRed, up: x.uplift, af: x.affFrom };
    });
    const N = S.mc.trials, sd = S.mc.impactSd, dsd = S.mc.delaySd;
    const totals = new Array(N);
    for (let t = 0; t < N; t++) {
      const g = 1 + sd * randn();
      const delay = Math.round(dsd * randn());
      let tot = 0;
      for (const p of pre) {
        const cr = clamp01(p.cr * g);
        const af = p.af >= 99 ? 99 : p.af + delay;
        const est = p.est;
        for (let i = 0; i < 12; i++) {
          const a = (i + 1) >= af ? 1 : 0;
          tot += est[i] * (1 - cr * a) * (1 + p.up * a);
        }
      }
      totals[t] = tot;
    }
    MC_TRIALS = totals;
    const sorted = [...totals].sort((a, b) => a - b);
    const pct = q => sorted[Math.min(N - 1, Math.floor(q * N))];
    const mean = totals.reduce((a, b) => a + b, 0) / N;
    const variance = totals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / N;
    const std = Math.sqrt(variance);
    const base = m.adj2027;
    const worse = totals.filter(v => v < base).length / N;

    document.getElementById('mcKpis').innerHTML = [
      kpi('Base case (deterministic)', F.moneyShort(base), '2027 adjusted'),
      kpi('Mean', F.moneyShort(mean), `σ ${F.moneyShort(std)}`),
      kpi('P5 — P95', F.moneyShort(pct(0.05)) + ' — ' + F.moneyShort(pct(0.95)), '90% interval'),
      kpi('Median (P50)', F.moneyShort(pct(0.50)), ''),
      kpi('P(below base case)', F.pct0(worse), `${N.toLocaleString()} trials`, worse > 0.5 ? 'bad' : 'good'),
    ].join('');

    // histogram
    const lo = sorted[0], hi = sorted[N - 1], bins = 30, w = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0), centers = new Array(bins);
    for (let b = 0; b < bins; b++) centers[b] = lo + (b + 0.5) * w;
    totals.forEach(v => { let b = Math.floor((v - lo) / w); if (b >= bins) b = bins - 1; if (b < 0) b = 0; counts[b]++; });
    Charts.histogram('chartMC', centers.map(c => F.moneyShort(c)), counts, (base - lo) / w);
  }

  function commit() { saveState(); renderAll(); }

  // ---------- tabs ----------
  function initTabs() {
    document.querySelectorAll('nav.tabs button').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tabpane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      };
    });
  }

  // ---------- boot ----------
  fetch('data.json').then(r => r.json()).then(data => {
    DATA = data;
    DATA.salesStates.forEach(s => SELL.add(s));
    document.getElementById('metaLine').innerHTML =
      `Plan G rates: ${data.cells.length.toLocaleString()} zip-3 × age × gender cells · ` +
      `Baseline 2026 sales: ${F.money(data.baselineTotal)} across ${data.salesStates.length} states · ` +
      `Data generated ${data.generated}`;
    if (FRESH) applyDefaultPlan(); // top-10-on / MD-CA-late default plan
    initTabs();
    buildRateControls();
    buildInputs();
    renderAll();
  }).catch(err => {
    document.getElementById('metaLine').textContent = 'Failed to load data.json: ' + err;
    console.error(err);
  });
})();
