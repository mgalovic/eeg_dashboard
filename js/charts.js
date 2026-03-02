/**
 * charts.js — EEG Dashboard
 *
 * Chart.js wrapper.
 * Stage 2: monthly bar chart.
 * Stage 3: required-rate reference line, future-month ghost bars.
 * Stage 5: unit summary line chart (department view).
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

  let _doctorChart = null;
  let _unitChart   = null;

  function _destroyDoctor() {
    if (_doctorChart) { _doctorChart.destroy(); _doctorChart = null; }
  }
  function _destroyUnit() {
    if (_unitChart) { _unitChart.destroy(); _unitChart = null; }
  }
  function _destroyAll() {
    _destroyDoctor();
    _destroyUnit();
  }

  /* ── Status → reference line colour ──────────────────────────────── */
  function _refColor(status) {
    return status === 'green' ? C.greenLine
         : status === 'amber' ? C.amberLine
         : C.redLine;
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
          beginAtZero: true,
          suggestedMax: yMax ? yMax * 1.15 : undefined,
          grid:   { color: C.gridLine, drawBorder: false },
          border: { display: false },
          ticks:  { color: C.tickText, font: { size: 11.5 }, precision: 0 },
        },
      },
    };
  }


  /* ── Monthly bar chart (individual doctor view) ───────────────────── */
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string[]}  labels            — month labels
   * @param {number[]}  counts            — EEG count per month
   * @param {object}    [opts]
   * @param {number}    [opts.futureStart]    — index of first future month (those get ghost colour)
   * @param {number}    [opts.requiredRate]   — horizontal reference line y value
   * @param {string}    [opts.status]         — 'green'|'amber'|'red' (reference line colour)
   */
  function renderMonthlyBar(canvas, labels, counts, opts = {}) {
    _destroyDoctor();

    const { futureStart, requiredRate, status = 'red' } = opts;

    // Bar colours: future months get a ghost style
    const bgColors = counts.map((_, i) =>
      (futureStart != null && i >= futureStart) ? C.blueFuture : C.blue
    );
    const hoverColors = counts.map((_, i) =>
      (futureStart != null && i >= futureStart) ? 'rgba(37,99,235,0.25)' : C.blueHover
    );

    // Determine a sensible y-axis ceiling
    const dataMax = Math.max(...counts, requiredRate ?? 0);
    const options = _baseOptions(dataMax);

    // Tooltip: show month + count, hide the reference line entry
    options.plugins.tooltip.callbacks = {
      title: ctx  => ctx[0]?.label ?? '',
      label: ctx  => {
        if (ctx.dataset.label === '_ref_hidden') return null;
        const n = ctx.parsed.y;
        if (n === 0 && futureStart != null && ctx.dataIndex >= futureStart) return 'No reports yet';
        return `${n} EEG${n !== 1 ? 's' : ''}`;
      },
    };

    const datasets = [
      {
        type:                 'bar',
        label:                'EEGs reported',
        data:                 counts,
        backgroundColor:      bgColors,
        hoverBackgroundColor: hoverColors,
        borderRadius:         3,
        borderSkipped:        false,
        order:                2,
      },
    ];

    // Reference line: required monthly rate to hit target
    if (requiredRate != null) {
      const refColor = _refColor(status);
      datasets.push({
        type:          'line',
        label:         '_ref_hidden',          // hidden from legend & tooltip filter
        data:          Array(labels.length).fill(requiredRate),
        borderColor:   refColor,
        borderWidth:   1.5,
        borderDash:    [6, 4],
        pointRadius:   0,
        fill:          false,
        tension:       0,
        order:         1,
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
   * @param {HTMLCanvasElement} canvas
   * @param {string[]}          labels  — month labels
   * @param {number[]}          data    — total EEG interactions per month
   */
  function renderUnitSummary(canvas, labels, data) {
    _destroyUnit();

    const dataMax = Math.max(...data, 0);
    const options = _baseOptions(dataMax);

    options.plugins.tooltip.callbacks = {
      title: ctx => ctx[0]?.label ?? '',
      label: ctx => `${ctx.parsed.y} EEG${ctx.parsed.y !== 1 ? 's' : ''}`,
    };

    _unitChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label:              'Total EEGs',
          data,
          borderColor:        C.blue,
          borderWidth:        2,
          pointRadius:        3,
          pointHoverRadius:   5,
          pointBackgroundColor: C.blue,
          fill:               true,
          backgroundColor:    ctx => {
            const { chart } = ctx;
            const { ctx: chartCtx, chartArea } = chart;
            if (!chartArea) return 'rgba(37,99,235,0.10)';
            const gradient = chartCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            gradient.addColorStop(0, 'rgba(37,99,235,0.18)');
            gradient.addColorStop(1, 'rgba(37,99,235,0.02)');
            return gradient;
          },
          tension:            0.3,
        }],
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
    COLORS: C,
  };

})();
