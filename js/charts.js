/* Chart.js helpers. Each function creates-or-updates a chart bound to a canvas id. */
const Charts = (() => {
  const registry = {};
  const COL = {
    wellabe: '#3da9fc', wellabeT: '#7cc6ff',
    big6: '#ff8a5c', big6After: '#ff6b6b',
    base: '#5b6b82', adj: '#3da9fc', loss: '#ff6b6b',
    good: '#43d39e', grid: 'rgba(255,255,255,.06)', tick: '#93a4ba',
  };
  const buckets = ['#3da9fc', '#00d4a0', '#ffb454', '#c98bff', '#ff8a5c', '#6ec7ff'];

  Chart.defaults.color = COL.tick;
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

  const money = v => '$' + Math.round(v).toLocaleString();
  const moneyShort = v => {
    const a = Math.abs(v);
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(v);
  };
  const pct = v => (v * 100).toFixed(1) + '%';

  function upsert(id, cfg) {
    if (registry[id]) { registry[id].destroy(); }
    const ctx = document.getElementById(id);
    registry[id] = new Chart(ctx, cfg);
    return registry[id];
  }

  const gridX = { grid: { color: COL.grid }, ticks: { color: COL.tick } };
  const gridY = { grid: { color: COL.grid }, ticks: { color: COL.tick } };

  return {
    COL, buckets, money, moneyShort, pct,

    // Grouped/stacked sales bars (baseline vs adjusted) — horizontal
    salesByState(id, labels, baseline, adjusted, opts = {}) {
      return upsert(id, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: '2027 baseline', data: baseline, backgroundColor: COL.base, borderRadius: 3 },
            { label: '2027 adjusted', data: adjusted, backgroundColor: COL.adj, borderRadius: 3 },
          ],
        },
        options: {
          indexAxis: opts.horizontal ? 'y' : 'x',
          maintainAspectRatio: false, responsive: true,
          plugins: {
            legend: { position: 'top' },
            tooltip: { callbacks: { label: c => c.dataset.label + ': ' + money(c.parsed[opts.horizontal ? 'x' : 'y']) } },
          },
          scales: {
            x: opts.horizontal ? { ...gridX, ticks: { ...gridX.ticks, callback: moneyShort } } : gridX,
            y: opts.horizontal ? gridY : { ...gridY, ticks: { ...gridY.ticks, callback: moneyShort } },
          },
        },
      });
    },

    // Horizontal bar of a single % metric per state, colored by sell flag
    pctByState(id, labels, values, colors, opts = {}) {
      return upsert(id, {
        type: 'bar',
        data: { labels, datasets: [{ label: opts.label || '%', data: values, backgroundColor: colors, borderRadius: 3 }] },
        options: {
          indexAxis: 'y', maintainAspectRatio: false, responsive: true,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: c => (opts.label || '') + ' ' + pct(c.parsed.x) } },
          },
          scales: { x: { ...gridX, ticks: { ...gridX.ticks, callback: v => (v * 100).toFixed(0) + '%' } }, y: gridY },
        },
      });
    },

    // Wellabe vs each Big-6 bucket (today, after rerate) + target line
    rateStack(id, bucketLabels, todayVals, afterVals, wellabe, target) {
      const labels = ['Wellabe', ...bucketLabels];
      const today = [wellabe, ...todayVals];
      const after = [null, ...afterVals];
      return upsert(id, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Today', data: today, backgroundColor: labels.map((l, i) => i === 0 ? COL.wellabe : COL.big6), borderRadius: 3 },
            { label: 'After Big 6 rerate', data: after, backgroundColor: COL.big6After, borderRadius: 3 },
          ],
        },
        options: {
          maintainAspectRatio: false, responsive: true,
          plugins: {
            legend: { position: 'top' },
            tooltip: { callbacks: { label: c => c.raw == null ? null : c.dataset.label + ': $' + c.parsed.y.toFixed(0) } },
            annotation: undefined,
          },
          scales: {
            x: gridX,
            y: { ...gridY, title: { display: true, text: 'Monthly premium ($)', color: COL.tick },
                 ticks: { ...gridY.ticks, callback: v => '$' + v } },
          },
        },
        plugins: [targetLinePlugin(target)],
      });
    },

    // Waterfall: baseline -> per-state losses -> adjusted
    waterfall(id, labels, bases, floating, colors) {
      return upsert(id, {
        type: 'bar',
        data: { labels, datasets: [
          { label: 'spacer', data: bases, backgroundColor: 'transparent', stack: 's' },
          { label: 'value', data: floating, backgroundColor: colors, stack: 's', borderRadius: 2 },
        ] },
        options: {
          maintainAspectRatio: false, responsive: true,
          plugins: {
            legend: { display: false },
            tooltip: { filter: c => c.datasetIndex === 1, callbacks: { label: c => moneyShort(Math.abs(c.raw)) } },
          },
          scales: { x: { ...gridX, ticks: { ...gridX.ticks, autoSkip: false, maxRotation: 60, minRotation: 60 } },
                    y: { ...gridY, ticks: { ...gridY.ticks, callback: moneyShort } } },
        },
      });
    },

    monthly(id, monthLabels, baseline, adjusted) {
      return upsert(id, {
        type: 'line',
        data: { labels: monthLabels, datasets: [
          { label: 'Baseline', data: baseline, borderColor: COL.base, backgroundColor: 'rgba(91,107,130,.15)', fill: true, tension: .3 },
          { label: 'Adjusted', data: adjusted, borderColor: COL.adj, backgroundColor: 'rgba(61,169,252,.15)', fill: true, tension: .3 },
        ] },
        options: {
          maintainAspectRatio: false, responsive: true,
          plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: c => c.dataset.label + ': ' + money(c.parsed.y) } } },
          scales: { x: gridX, y: { ...gridY, ticks: { ...gridY.ticks, callback: moneyShort } } },
        },
      });
    },
  };

  // Draws a horizontal dashed "target" line across the rate-stack chart.
  function targetLinePlugin(target) {
    return {
      id: 'targetLine',
      afterDraw(chart) {
        if (target == null) return;
        const { ctx, chartArea: { left, right }, scales: { y } } = chart;
        const yPix = y.getPixelForValue(target);
        ctx.save();
        ctx.strokeStyle = '#43d39e'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(left, yPix); ctx.lineTo(right, yPix); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = '#43d39e'; ctx.font = '11px sans-serif';
        ctx.fillText('Target $' + target.toFixed(0), left + 6, yPix - 5);
        ctx.restore();
      },
    };
  }
})();
