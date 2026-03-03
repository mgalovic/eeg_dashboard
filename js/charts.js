/**
 * charts.js — EEG Dashboard
 *
 * Chart.js wrapper.
 * Stage 2: monthly bar chart.
 * Stage 3: required-rate reference line, future-month ghost bars.
 * Stage 5: unit summary line chart (department view).
 * Stage 6: stacked modality bars (EEG/SEP/AEP/VEP), multi-line unit chart.
 */

'use strict';

const Charts = (() => {

  /* ── Design tokens ────────────────────────────────────────────────── */
  const C = {
    blue:         '#2563eb',
    blueHover:    '#1d4ed8',
    blueFuture:   'rgba(37,99,235,0.13)',
    gridLine:     '#f3f4f6',
    axisLine:     '#e5e7eb',
    tickText:     '#6b7280',
    tooltipBg:    '#111827',
    tooltipTitle: '#9ca3af',
    green:        '#16a34a',
    greenLine:    'rgba(22,163,74,0.70)',
    amber:        '#d97706',
    amberLine:    'rgba(217,119,6,0.70)',
    red:          '#dc2626',
    redLine:      'rgba(220,38,38,0.70)',
  };

  /* ── Modality colour palette ──────────────────────────────────────── */
  const MOD_COLORS = {
    EEG: { solid: '#2563eb', ghost: 'rgba(37,99,235,0.13)',   hover: '#1d4ed8' },
    SEP: { solid: '#059669', ghost: 'rgba(5,150,105,0.15)',   hover: '#047857' },
    AEP: { solid: '#ea580c', ghost: 'rgba(234,88,12,0.15)',   hover: '#c2410c' },
    VEP: { solid: '#7c3aed', ghost: 'rgba(124,58,237,0.15)',  hover: '#6d28d9' },
  };

  const MODALITY_ORDER = ['EEG', 'SEP', 'AEP', 'VEP'];

  let _doctorChart = null;
  let _unitChart   = null;

  function _destroyDoctor() {
    if (_doctorChart) { _doctorChart.destroy(); _doctorChart = null; }
  }
  function _destroyUnit() {
    if (_unitChart) { _unitChart.destroy(); _unitChart = null; }
  }
  function _destroyAll() { _destroyDoctor(); _destroyUnit(); }

  /* ── Status → reference line colour ──────────────────────────────── */
  function _refColor(status) {
    return status === 'green' ? C.greenLine
         : status === 'amber' ? C.amberLine
         : C.redLine;
  }

  /* ── Hex → rgba helper ────────────────────────────────────────────── */
  function _hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /* ── Shared axis / plugin defaults ───────────────────────────────── */
  function _baseOptions(yMax) {
    return {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 380, easing: 'easeOutQuart' },
      interaction:         { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor:  C.tooltipBg,
          titleColor:       C.tooltipTitle,
          bodyColor:        '#fff',
          padding:          { x: 12, y: 9 },
          cornerRadius:     6,
          displayColors:    true,
          boxWidth:         10,
          boxHeight:        10,
          boxPadding:       4,
          filter: item => item.dataset.label !== '_ref_hidden',
        },
      },
      scales: {
        x: {
          grid:   { display: false },
          border: { color: C.axisLine },
          ticks:  {
            color:         C.tickText,
            font:          { size: 11.5 },
            maxRotation:   50,
            minRotation:   0,
            autoSkip:      true,
            maxTicksLimit: 24,
          },
        },
        y: {
          beginAtZero:  true,
          suggestedMax: yMax ? yMax * 1.15 : undefined,
          grid:         { color: C.gridLine, drawBorder: false },
          border:       { display: false },
          ticks:        { color: C.tickText, font: { size: 11.5 }, precision: 0 },
        },
      },
    };
  }


  /* ── Monthly bar chart (individual doctor view) ───────────────────── */
  /**
   * Renders a stacked bar chart broken down by modality.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {string[]}  labels  — month labels
   * @param {object[]}  series  — items: { year, month, count, isFuture, EEG, SEP, AEP, VEP }
   *                              (backward-compat: plain { count } items treated as EEG-only)
   * @param {object}    [opts]
   * @param {number}    [opts.futureStart]  — index of first future month
   * @param {number}    [opts.requiredRate] — horizontal reference line
   * @param {string}    [opts.status]       — 'green'|'amber'|'red'
   */
  function renderMonthlyBar(canvas, labels, series, opts = {}) {
    _destroyDoctor();

    const { futureStart, requiredRate, status = 'red' } = opts;

    // Detect which modalities have data in this series
    const hasModalityData   = series.length > 0 && series[0].EEG !== undefined;
    const activeModalities  = hasModalityData
      ? MODALITY_ORDER.filter(mod => series.some(m => (m[mod] ?? 0) > 0))
      : ['EEG'];

    const counts  = series.map(m => m.count ?? 0);
    const dataMax = Math.max(...counts, requiredRate ?? 0);
    const options = _baseOptions(dataMax);

    // Enable stacking when multiple modalities are present
    const stacked = activeModalities.length > 1;
    if (stacked) {
      options.scales.x.stacked = true;
      options.scales.y.stacked = true;
    }

    // Show legend only when multiple modalities are visible
    options.plugins.legend = {
      display:  stacked,
      position: 'top',
      labels:   { boxWidth: 12, boxHeight: 12, padding: 14, font: { size: 12 } },
    };

    options.plugins.tooltip.callbacks = {
      title: ctx => ctx[0]?.label ?? '',
      label: ctx => {
        if (ctx.dataset.label === '_ref_hidden') return null;
        const n = ctx.parsed.y;
        if (n === 0) return null;
        return `${ctx.dataset.label}: ${n}`;
      },
      footer: ctx => {
        if (!stacked) return undefined;
        const total = ctx.reduce((s, item) => s + (item.parsed.y || 0), 0);
        return total > 0 ? `Total: ${total}` : undefined;
      },
    };

    // Build one dataset per active modality
    const datasets = activeModalities.map(mod => {
      const mc = MOD_COLORS[mod] ?? MOD_COLORS.EEG;
      const data = hasModalityData
        ? series.map(m => m[mod] ?? 0)
        : counts;  // fallback: plain count array treated as EEG
      return {
        type:                 'bar',
        label:                mod,
        data,
        backgroundColor:      series.map((_, i) =>
          (futureStart != null && i >= futureStart) ? mc.ghost : mc.solid
        ),
        hoverBackgroundColor: series.map((_, i) =>
          (futureStart != null && i >= futureStart) ? mc.ghost : mc.hover
        ),
        borderRadius:         stacked ? 0 : 3,
        borderSkipped:        false,
        stack:                'reports',
        order:                2,
      };
    });

    // Reference line: required monthly rate to hit target
    if (requiredRate != null) {
      datasets.push({
        type:        'line',
        label:       '_ref_hidden',
        data:        Array(labels.length).fill(requiredRate),
        borderColor: _refColor(status),
        borderWidth: 1.5,
        borderDash:  [6, 4],
        pointRadius: 0,
        fill:        false,
        tension:     0,
        order:       1,
      });
    }

    _doctorChart = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets },
      options,
    });

    return _doctorChart;
  }


  /* ── Unit summary line chart (department view) ────────────────────── */
  /**
   * Renders one line per modality.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {string[]}          labels     — month labels
   * @param {object[]}          seriesData — [{ label, data: number[], color: '#hex' }, …]
   */
  function renderUnitSummary(canvas, labels, seriesData) {
    _destroyUnit();

    const dataMax   = Math.max(0, ...seriesData.flatMap(s => s.data));
    const options   = _baseOptions(dataMax);
    const singleLine = seriesData.length === 1;

    options.plugins.legend = {
      display:  !singleLine,
      position: 'top',
      labels:   { boxWidth: 12, boxHeight: 12, padding: 14, font: { size: 12 } },
    };
    options.plugins.tooltip.callbacks = {
      title: ctx => ctx[0]?.label ?? '',
      label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}`,
    };

    _unitChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: seriesData.map(s => ({
          label:               s.label,
          data:                s.data,
          borderColor:         s.color,
          borderWidth:         2,
          pointRadius:         3,
          pointHoverRadius:    5,
          pointBackgroundColor: s.color,
          fill:                singleLine,
          backgroundColor:     singleLine
            ? ctx => {
                const { chart } = ctx;
                const { ctx: chartCtx, chartArea } = chart;
                if (!chartArea) return _hexToRgba(s.color, 0.10);
                const gradient = chartCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                gradient.addColorStop(0, _hexToRgba(s.color, 0.18));
                gradient.addColorStop(1, _hexToRgba(s.color, 0.02));
                return gradient;
              }
            : 'transparent',
          tension: 0.3,
        })),
      },
      options,
    });

    return _unitChart;
  }


  /* ── Public API ───────────────────────────────────────────────────── */
  return {
    renderMonthlyBar,
    renderUnitSummary,
    destroy: _destroyAll,
    COLORS:  C,
    MOD_COLORS,
  };

})();
