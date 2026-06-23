/* Wellabe Rate Competitiveness & 2027 Sales Impact — main app logic. */
(() => {
  'use strict';

  const LS_KEY = 'wellabe_rate_model_v2'; // bumped: count-based reduction + higher elasticity defaults
  const DEFAULTS = {
    rerate: 0.15,        // Big 6 rerate before we act
    benchStat: 'avg',    // avg | median | min  (over the six Big-6 group rates)
    offset: -0.05,       // target position vs Big 6 post-rerate benchmark
    growth: 0.0,         // 2027 growth from 2026 baseline
    baselineTotal: null, // 2026 baseline $ total (null => use data.json default)
    defaultStart: '2027-01-01', // default rate-increase start date (per-state overridable)
    stateOn: {},         // state -> bool; absent => true (take the increase)
    stateStart: {},      // state -> 'YYYY-MM-DD'; absent => defaultStart
    reductionMode: 'count', // 'count' = elasticity cuts policy COUNT, premium/policy rises
                            //   with the rate increase; 'premium' = cuts premium dollars directly
    elastic: [           // {t: required-increase threshold, r: policy-count reduction}
      { t: 0.05, r: 0.05 },
      { t: 0.10, r: 0.20 },
      { t: 0.15, r: 0.35 },
      { t: 0.20, r: 0.50 },
      { t: 0.30, r: 0.65 },
      { t: 0.40, r: 0.80 },
    ],
    overrides: {},       // state -> count-reduction fraction
  };

  let DATA = null;       // loaded data.json
  let S = loadState();   // current inputs
  let MODEL = null;      // computed model (cached)

  // ---------- state ----------
  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY));
      if (raw) return Object.assign(structuredClone(DEFAULTS), raw);
    } catch (e) { /* ignore */ }
    return structuredClone(DEFAULTS);
  }
  function saveState() { localStorage.setItem(LS_KEY, JSON.stringify(S)); }

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
      const reqInc = rs ? rs.reqInc : 0;
      const on = S.stateOn[st] !== false;              // default: take the increase
      const start = S.stateStart[st] || S.defaultStart; // YYYY-MM-DD
      // Policy-count reduction once the increase is fully in effect:
      const countRed = on ? ((st in S.overrides) ? S.overrides[st] : elasticity(reqInc)) : 0;
      // Premium uplift on the policies that DO get written (count mode only).
      const uplift = (on && S.reductionMode === 'count') ? reqInc : 0;
      const b26 = sd.annual * scale;
      const monthsBase = sd.months.map(m => m * scale * (1 + S.growth));
      // For PROJ_YEAR months on/after the start date: fewer policies (1-countRed)
      // each carrying higher premium (1+uplift). Earlier months unchanged.
      const monthsAdj = monthsBase.map((v, i) => {
        const a = affectedFrac(start, i);
        return v * (1 - countRed * a) * (1 + uplift * a);
      });
      const b27 = monthsBase.reduce((a, b) => a + b, 0);
      const a27 = monthsAdj.reduce((a, b) => a + b, 0);
      sales[st] = {
        baseline2026: b26, baseline2027: b27, adjusted2027: a27,
        countRed,                        // policy-count reduction (full effect)
        uplift,                          // premium uplift per remaining policy
        effReduction: b27 ? (b27 - a27) / b27 : 0, // net premium reduction in PROJ_YEAR after timing
        reqInc, loss: b27 - a27, on, start,
        hasRate: !!rs, months: monthsBase, monthsAdj,
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

  // ---------- rendering ----------
  function renderAll() {
    compute();
    renderSummary();
    renderRates();
    renderIncreases();
    renderSales();
    renderStatePlan();
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

    // chart: baseline vs adjusted by selling state (sorted by baseline)
    const sts = [...DATA.salesStates].filter(s => DATA.sales[s].annual > 0)
      .sort((a, b) => DATA.sales[b].annual - DATA.sales[a].annual);
    Charts.salesByState('chartSummarySales', sts,
      sts.map(s => m.sales[s].baseline2027),
      sts.map(s => m.sales[s].adjusted2027),
      { horizontal: true });

    // chart: today's gap (wellabe as % of big6) for selling states
    const gs = sts.filter(s => m.rateStates[s]);
    Charts.pctByState('chartSummaryGap', gs,
      gs.map(s => 1 / (1 + m.rateStates[s].gapToday)), // wellabe / big6
      gs.map(() => Charts.COL.wellabe), { label: 'Wellabe vs Big 6:' });
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
      sts.map(s => m.sales[s].baseline2027), sts.map(s => m.sales[s].adjusted2027), { horizontal: false });

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
        <td class="${countMode && x.on && x.uplift > 0 ? 'pos' : 'muted'}">${countMode && x.on ? '+' + F.pct1(x.uplift) : '—'}</td>
        <td class="${x.effReduction > 0 ? 'neg' : (x.effReduction < 0 ? 'pos' : 'muted')}">${F.pct1(x.effReduction)}</td>
        <td>${F.money(x.adjusted2027)}</td>
        <td>${F.lossGain(x.loss)}</td></tr>`; }).join('') +
      `<tr style="font-weight:700"><td class="left">TOTAL</td><td></td><td></td>
        <td>${F.money(m.base2027)}</td><td></td><td></td>
        <td class="${m.lossPct >= 0 ? 'neg' : 'pos'}">${F.pct1(m.lossPct)}</td>
        <td>${F.money(m.adj2027)}</td><td>${F.lossGain(m.totalLoss)}</td></tr></tbody>`;
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
    const g = document.getElementById('inGrowth');
    const bs = document.getElementById('inBenchStat');
    const bl = document.getElementById('inBaseline');
    bl.min = Math.round(DATA.baselineTotal * 0.6);
    bl.max = Math.round(DATA.baselineTotal * 1.4);
    r.oninput = () => { S.rerate = +r.value; commit(); };
    o.oninput = () => { S.offset = +o.value; commit(); };
    g.oninput = () => { S.growth = +g.value; commit(); };
    bs.onchange = () => { S.benchStat = bs.value; commit(); };
    bl.oninput = () => { S.baselineTotal = +bl.value; commit(); };
    const rm = document.getElementById('inReductionMode');
    rm.onchange = () => { S.reductionMode = rm.value; buildElasticTable(); commit(); };
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
      S = structuredClone(DEFAULTS); saveState(); buildElasticTable(); renderAll();
    };
    buildElasticTable();
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
      <th>Rate&nbsp;+%</th><th>Count&nbsp;−%<br>override</th><th>Net&nbsp;−%<br>(timed)</th><th>2027&nbsp;loss / gain</th>
      </tr></thead><tbody>` +
      sts.map(s => {
        const x = m.sales[s], rs = m.rateStates[s];
        const on = S.stateOn[s] !== false;
        const start = S.stateStart[s] || S.defaultStart;
        const ov = s in S.overrides ? Math.round(S.overrides[s] * 100) : '';
        return `<tr>
          <td class="left">${s}${SELL.has(s) ? '<span class="tag-sell">sell</span>' : ''}${rs ? '' : ' <span class="muted">(no rate data)</span>'}</td>
          <td><input type="checkbox" data-st="${s}" data-f="on" ${on ? 'checked' : ''}></td>
          <td class="left"><input type="date" data-st="${s}" data-f="start" value="${start}" ${on ? '' : 'disabled'} style="min-width:140px"></td>
          <td class="${x.reqInc > 0.2 ? 'neg' : ''}">${rs ? F.pct1(x.reqInc) : '—'}</td>
          <td><input type="number" step="1" min="0" max="100" placeholder="auto" data-st="${s}" data-f="ov" value="${ov}" style="min-width:70px" ${on ? '' : 'disabled'}>%</td>
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
    document.getElementById('inGrowth').value = S.growth;
    document.getElementById('inGrowthVal').textContent = F.signpct(S.growth);
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
    initTabs();
    buildRateControls();
    buildInputs();
    renderAll();
  }).catch(err => {
    document.getElementById('metaLine').textContent = 'Failed to load data.json: ' + err;
    console.error(err);
  });
})();
