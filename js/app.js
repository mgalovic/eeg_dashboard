/**
 * app.js — EEG Dashboard
 *
 * Main application controller.
 * Stage 1: file upload, drag-and-drop, snapshot persistence.
 * Stage 2: doctor list sidebar, monthly bar chart.
 * Stage 3: projection, period controls, status badges.
 * Stage 4: dataset-switcher dropdown, auto-load, snapshot notes.
 * Stage 5: department overview table, unit summary chart, CSV export, responsive, print.
 */

'use strict';

const App = (() => {

  /* ── State ────────────────────────────────────────────────────────── */
  let activeDataset   = null;   // { records, meta }
  let activeSnapId    = null;   // id of the currently loaded snapshot (null if unsaved upload)
  let selectedDoctor  = null;   // canonical name string
  let periodMonths    = 6;      // rotation length (user-adjustable)
  let targetEEGs      = 800;    // exam threshold (user-adjustable)
  let dropdownOpen    = false;
  let currentView     = 'individual';  // 'individual' | 'dept'
  let overviewSort    = { col: 'name', dir: 'asc' };


  /* ── DOM references ───────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);

  const dom = {
    // Upload screen
    uploadZone:         $('upload-zone'),
    fileInput:          $('file-input'),
    browseBtn:          $('browse-btn'),
    parseStatus:        $('parse-status'),
    parseMessage:       $('parse-message'),
    savedSection:       $('saved-section'),
    snapshotList:       $('snapshot-list'),
    // Results header — dataset switcher
    dsSwitcher:         $('ds-switcher'),
    dsTrigger:          $('ds-trigger'),
    dsDropdown:         $('ds-dropdown'),
    dsList:             $('ds-list'),
    dsUsage:            $('ds-usage'),
    activeDatasetLabel: $('active-dataset-label'),
    uploadAnotherBtn:   $('upload-another-btn'),
    downloadSnapBtn:    $('download-snap-btn'),
    // Results screen — sidebar
    doctorSearch:       $('doctor-search'),
    doctorList:         $('doctor-list'),
    // View tabs
    viewTabs:           $('view-tabs'),
    individualView:     $('individual-view'),
    // Doctor detail (individual view)
    emptyState:         $('empty-state'),
    doctorDetail:       $('doctor-detail'),
    detailName:         $('detail-name'),
    detailPeriod:       $('detail-period'),
    periodPresets:      $('period-presets'),
    periodInput:        $('period-input'),
    targetInput:        $('target-input'),
    detailStats:        $('detail-stats'),
    statusBanner:       $('status-banner'),
    statusDotLg:        $('status-dot-lg'),
    statusTitle:        $('status-title'),
    statusDesc:         $('status-desc'),
    monthlyChart:       $('monthly-chart'),
    // Department view
    deptView:           $('dept-view'),
    unitChart:          $('unit-chart'),
    overviewTable:      $('overview-table'),
    overviewTbody:      $('overview-tbody'),
    tableInfo:          $('table-info'),
    exportCsvBtn:       $('export-csv-btn'),
    printBtn:           $('print-btn'),
    // About modal
    aboutModal:         $('about-modal'),
    aboutClose:         $('about-close'),
    aboutBtnUpload:     $('about-btn-upload'),
    aboutBtnResults:    $('about-btn-results'),
    // Toast
    toastContainer:     $('toast-container'),
  };


  /* ── Toast ────────────────────────────────────────────────────────── */
  function toast(message, type = 'default', duration = 4000) {
    const el = document.createElement('div');
    el.className   = `toast toast-${type}`;
    el.textContent = message;
    dom.toastContainer.appendChild(el);
    setTimeout(() => {
      el.classList.add('removing');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, duration);
  }


  /* ── Screen transitions ───────────────────────────────────────────── */
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(`screen-${name}`).classList.add('active');
  }


  /* ── Formatting helpers ───────────────────────────────────────────── */
  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('de-CH', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  }

  function fmtMonthLabel(year, month) {
    const d = new Date(year, month, 1);
    return d.toLocaleDateString('en-US', { month: 'short' }) + ` '${String(year).slice(2)}`;
  }

  function fmtRate(r) {
    return r != null ? r.toFixed(1) + '/mo' : '—';
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }


  /* ── Status helpers ───────────────────────────────────────────────── */
  const STATUS_LABELS = { green: 'On Track', amber: 'Behind Pace', red: 'At Risk' };

  function statusBannerText(proj) {
    if (!proj) return { title: '', desc: '' };
    const periodEndStr = fmtDate(proj.periodEnd);

    if (proj.isExpired) {
      const title = proj.total >= proj.target
        ? 'Target Reached'
        : `Period Ended — ${proj.pctActual}% of Target`;
      const desc  = `Reported ${proj.total.toLocaleString()} reports (target: ${proj.target.toLocaleString()}).`;
      return { title, desc };
    }

    let desc = `Projected ${proj.projected.toLocaleString()} reports by ${periodEndStr} — ${proj.pctProjected}% of ${proj.target} target.`;
    if (proj.status !== 'green' && proj.requiredAdditionalRate != null) {
      const extra = Math.ceil(proj.requiredAdditionalRate - proj.ratePerMonth);
      if (extra > 0) desc += ` Needs ${extra} more/month than current pace.`;
    }
    return { title: STATUS_LABELS[proj.status], desc };
  }


  /* ══════════════════════════════════════════════════════════════════
     DATASET SWITCHER DROPDOWN  (Stage 4 core feature)
     ══════════════════════════════════════════════════════════════════ */

  function openDropdown() {
    if (dropdownOpen) return;
    dropdownOpen = true;
    dom.dsDropdown.hidden = false;
    dom.dsTrigger.setAttribute('aria-expanded', 'true');
    renderDropdownList();
  }

  function closeDropdown() {
    if (!dropdownOpen) return;
    dropdownOpen = false;
    dom.dsDropdown.hidden = true;
    dom.dsTrigger.setAttribute('aria-expanded', 'false');
  }

  function toggleDropdown() {
    dropdownOpen ? closeDropdown() : openDropdown();
  }

  /** Render the snapshot-count pill in the dropdown header. */
  function renderUsageIndicator() {
    const u = Storage.getUsageSummary();
    dom.dsUsage.textContent = u.label + ' saved';
    dom.dsUsage.className   = 'ds-usage' + (u.count >= u.max ? ' warn' : '');
  }

  /** Rebuild the dropdown snapshot list. */
  function renderDropdownList() {
    renderUsageIndicator();

    const snapshots = Storage.listAll();
    dom.dsList.innerHTML = '';

    if (!snapshots.length) {
      const li = document.createElement('li');
      li.className   = 'ds-list-empty';
      li.textContent = 'No saved datasets yet. Upload a file to get started.';
      dom.dsList.appendChild(li);
      return;
    }

    snapshots.forEach(snap => {
      const isActive = snap.id === activeSnapId;
      const li = document.createElement('li');
      li.className  = 'ds-item' + (isActive ? ' active' : '');
      li.dataset.id = snap.id;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', isActive);

      const saved    = new Date(snap.savedAt);
      const dateStr  = saved.toLocaleDateString('de-CH', { day: '2-digit', month: 'short', year: 'numeric' });
      const timeStr  = saved.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
      const noteHtml = snap.notes
        ? `<div class="ds-item-note" title="${escHtml(snap.notes)}">${escHtml(snap.notes)}</div>`
        : '';

      li.innerHTML = `
        <svg class="ds-item-check" viewBox="0 0 14 14" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <polyline points="2,7 5.5,10.5 12,3"/>
        </svg>
        <div class="ds-item-body">
          <div class="ds-item-name">${escHtml(snap.label)}</div>
          <div class="ds-item-meta">
            ${dateStr} ${timeStr} &middot;
            ${snap.validRecords.toLocaleString()} records &middot;
            ${snap.allDoctorCount ?? snap.assistantCount} doctors
          </div>
          ${noteHtml}
        </div>
        <div class="ds-item-actions">
          <button class="btn-icon note-btn" title="Add / edit note"
                  aria-label="Edit note for ${escHtml(snap.label)}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2a1 1 0 011 1v9a1 1 0 01-1 1H5l-3 2V3a1 1 0 011-1z"/>
            </svg>
          </button>
          <button class="btn-icon rename-btn" title="Rename"
                  aria-label="Rename ${escHtml(snap.label)}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M11.5 2.5a1.414 1.414 0 012 2L5 13H3v-2L11.5 2.5z"/>
            </svg>
          </button>
          <button class="btn-icon delete-btn" title="Delete"
                  aria-label="Delete ${escHtml(snap.label)}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 4h10M6 4V2h4v2M5 4l.5 9h5L11 4"/>
            </svg>
          </button>
        </div>
      `;

      // Click row → load
      li.addEventListener('click', e => {
        if (e.target.closest('.ds-item-actions')) return;
        loadSnapshot(snap.id);
      });

      // Note button
      li.querySelector('.note-btn').addEventListener('click', e => {
        e.stopPropagation();
        const current = snap.notes || '';
        const newNote = prompt('Note for this dataset\n(visible in the dataset switcher):', current);
        if (newNote === null) return;             // cancelled
        Storage.setNotes(snap.id, newNote);
        snap.notes = newNote.trim();              // optimistic local update
        renderDropdownList();
      });

      // Rename button
      li.querySelector('.rename-btn').addEventListener('click', e => {
        e.stopPropagation();
        const label = prompt('Rename dataset:', snap.label);
        if (!label?.trim()) return;
        Storage.rename(snap.id, label.trim());
        if (isActive) dom.activeDatasetLabel.textContent = label.trim();
        renderDropdownList();
        renderSnapshotList();
      });

      // Delete button
      li.querySelector('.delete-btn').addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm(`Delete "${snap.label}"? This cannot be undone.`)) return;
        Storage.remove(snap.id);
        renderDropdownList();
        renderSnapshotList();
        toast('Dataset deleted.', 'default', 2500);

        // If the deleted snapshot was active, switch to the next one
        if (isActive) {
          const remaining = Storage.listAll();
          if (remaining.length) {
            loadSnapshot(remaining[0].id);
          } else {
            activeDataset = null;
            activeSnapId  = null;
            showScreen('upload');
          }
        }
      });

      dom.dsList.appendChild(li);
    });
  }

  /** Set up dropdown open/close event wiring. */
  function setupDropdown() {
    dom.dsTrigger.addEventListener('click', e => { e.stopPropagation(); toggleDropdown(); });

    // Keyboard: Escape closes, ArrowDown opens
    dom.dsTrigger.addEventListener('keydown', e => {
      if (e.key === 'Escape')    { closeDropdown(); dom.dsTrigger.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); openDropdown(); }
    });
    dom.dsDropdown.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeDropdown(); dom.dsTrigger.focus(); }
    });

    // Click outside → close
    document.addEventListener('click', e => {
      if (dropdownOpen && !dom.dsSwitcher.contains(e.target)) closeDropdown();
    });
  }


  /* ══════════════════════════════════════════════════════════════════
     UPLOAD SCREEN SNAPSHOT LIST
     ══════════════════════════════════════════════════════════════════ */

  function renderSnapshotList() {
    const snapshots = Storage.listAll();
    if (!snapshots.length) { dom.savedSection.hidden = true; return; }

    dom.savedSection.hidden = false;
    dom.snapshotList.innerHTML = '';

    snapshots.forEach(snap => {
      const li      = document.createElement('li');
      li.className  = 'snapshot-item';
      li.dataset.id = snap.id;

      const saved   = new Date(snap.savedAt);
      const dateStr = saved.toLocaleDateString('de-CH', { day: '2-digit', month: 'short', year: 'numeric' });
      const timeStr = saved.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

      li.innerHTML = `
        <div class="snapshot-item-meta">
          <div class="snapshot-item-name">${escHtml(snap.label)}</div>
          <div class="snapshot-item-date">
            ${dateStr} ${timeStr} &middot;
            ${snap.validRecords.toLocaleString()} records &middot;
            ${snap.allDoctorCount ?? snap.assistantCount} doctors
          </div>
        </div>
        <div class="snapshot-item-actions">
          <button class="btn-icon rename-btn" title="Rename" aria-label="Rename snapshot">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M11.5 2.5a1.414 1.414 0 012 2L5 13H3v-2L11.5 2.5z"/>
            </svg>
          </button>
          <button class="btn-icon delete-btn" title="Delete" aria-label="Delete snapshot">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 4h10M6 4V2h4v2M5 4l.5 9h5L11 4"/>
            </svg>
          </button>
        </div>
      `;

      li.addEventListener('click', e => {
        if (e.target.closest('.snapshot-item-actions')) return;
        loadSnapshot(snap.id);
      });
      li.querySelector('.rename-btn').addEventListener('click', e => {
        e.stopPropagation();
        const label = prompt('Rename dataset:', snap.label);
        if (label?.trim()) { Storage.rename(snap.id, label.trim()); renderSnapshotList(); }
      });
      li.querySelector('.delete-btn').addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm(`Delete "${snap.label}"? This cannot be undone.`)) return;
        Storage.remove(snap.id);
        renderSnapshotList();
        toast('Dataset deleted.', 'default', 2500);
      });

      dom.snapshotList.appendChild(li);
    });
  }


  /* ══════════════════════════════════════════════════════════════════
     DOCTOR LIST & CHART PANEL
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Return the filtered doctor list for the current dataset.
   *
   * Inclusion criteria (both must be met):
   *   • Total EEGs across either role > 35
   *   • EEGs in the last 6 calendar months > 20
   *
   * Covers assistants AND consultants on rotation (issue 2).
   * The 6-month window filters out doctors no longer actively rotating.
   */
  function getFilteredDoctors(records, meta) {
    const allDoctors = meta.allDoctors ??
      [...new Set([...(meta.assistants ?? []), ...(meta.consultants ?? [])])]
        .sort((a, b) => a.localeCompare(b, 'de'));

    const now          = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);

    return allDoctors.filter(name => {
      if (Parser.totalForDoctor(records, name) <= 35) return false;
      const recent = records.filter(r =>
        r.date >= sixMonthsAgo &&
        (r.assistants.includes(name) || r.consultants.includes(name))
      ).length;
      return recent > 20;
    });
  }

  function renderDoctorList(dataset) {
    dom.doctorList.innerHTML = '';

    const doctors = getFilteredDoctors(dataset.records, dataset.meta);

    if (!doctors.length) {
      const li = document.createElement('li');
      li.className   = 'doctor-list-empty';
      li.textContent = 'No doctors match the activity criteria (>35 total, >20 in last 6 months).';
      dom.doctorList.appendChild(li);
      return;
    }

    doctors.forEach(name => {
      const total    = Parser.totalForDoctor(dataset.records, name);
      const range    = Parser.dateRangeForDoctor(dataset.records, name);
      const proj     = Parser.calculateProjection(dataset.records, name, periodMonths, targetEEGs);
      const status   = proj?.status ?? 'none';
      const firstStr = range
        ? range.first.toLocaleDateString('de-CH', { month: 'short', year: 'numeric' })
        : '—';

      const li = document.createElement('li');
      li.className    = 'doctor-card';
      li.dataset.name = name;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.setAttribute('tabindex', '0');

      li.innerHTML = `
        <span class="status-dot" data-status="${status}" title="${STATUS_LABELS[status] ?? ''}"></span>
        <div class="doctor-card-content">
          <div class="doctor-card-body">
            <span class="doctor-name">${escHtml(name)}</span>
            <span class="eeg-badge">${total}</span>
          </div>
          <span class="doctor-since">From ${firstStr}</span>
        </div>
      `;

      li.addEventListener('click',   ()  => selectDoctor(name));
      li.addEventListener('keydown', e   => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDoctor(name); }
      });

      dom.doctorList.appendChild(li);
    });

    setupSearch();
    selectDoctor(doctors[0]);
  }

  function refreshAllStatusDots() {
    if (!activeDataset) return;
    dom.doctorList.querySelectorAll('.doctor-card').forEach(card => {
      const proj   = Parser.calculateProjection(activeDataset.records, card.dataset.name, periodMonths, targetEEGs);
      const status = proj?.status ?? 'none';
      const dot    = card.querySelector('.status-dot');
      if (dot) { dot.dataset.status = status; dot.title = STATUS_LABELS[status] ?? ''; }
    });
  }

  function selectDoctor(name) {
    selectedDoctor = name;
    dom.doctorList.querySelectorAll('.doctor-card').forEach(card => {
      const sel = card.dataset.name === name;
      card.classList.toggle('selected', sel);
      card.setAttribute('aria-selected', sel);
    });
    renderDoctorDetail(name, activeDataset);
  }

  function renderDoctorDetail(name, dataset) {
    const { records } = dataset;
    const total  = Parser.totalForDoctor(records, name);
    const range  = Parser.dateRangeForDoctor(records, name);
    const proj   = Parser.calculateProjection(records, name, periodMonths, targetEEGs);
    const { series } = Parser.getMonthSeriesForPeriod(records, name, periodMonths);

    dom.emptyState.hidden   = true;
    dom.doctorDetail.hidden = false;

    dom.detailName.textContent   = name;
    dom.detailPeriod.textContent = range ? `${fmtDate(range.first)} – ${fmtDate(range.last)}` : '';

    // Active months: months with >5 EEGs (excludes break months); current month exempt
    const activeMo = Parser.getActiveMonthCount(records, name);
    const avg      = activeMo > 0 ? (total / activeMo).toFixed(1) : '—';

    const chips = [
      { value: total.toLocaleString(),                              label: 'Total Reports',        cls: 'blue' },
      { value: proj ? proj.projected.toLocaleString() : '—',       label: `Projected (${periodMonths} mo)`, cls: proj?.status ?? '' },
      { value: fmtRate(proj?.ratePerMonth),                         label: 'Current pace',        cls: '' },
      { value: proj && !proj.isExpired ? proj.daysRemaining + 'd' : (proj?.isExpired ? 'Ended' : '—'), label: 'Days remaining', cls: '' },
    ];

    dom.detailStats.innerHTML = chips.map(c => `
      <div class="stat-chip">
        <span class="stat-chip-value ${c.cls}">${c.value}</span>
        <span class="stat-chip-label">${c.label}</span>
      </div>
    `).join('');

    if (proj) {
      const { title, desc } = statusBannerText(proj);
      dom.statusBanner.hidden       = false;
      dom.statusBanner.className    = `status-banner ${proj.status}`;
      dom.statusDotLg.dataset.status = proj.status;
      dom.statusTitle.textContent   = title;
      dom.statusDesc.textContent    = desc;
    } else {
      dom.statusBanner.hidden = true;
    }

    const futureStart = series.findIndex(m => m.isFuture);
    Charts.renderMonthlyBar(
      dom.monthlyChart,
      series.map(m => fmtMonthLabel(m.year, m.month)),
      series,   // full objects with EEG/SEP/AEP/VEP breakdown
      {
        futureStart:  futureStart >= 0 ? futureStart : undefined,
        requiredRate: proj?.requiredMonthlyRate,
        status:       proj?.status,
      }
    );
  }


  /* ══════════════════════════════════════════════════════════════════
     DEPARTMENT VIEW  (Stage 5)
     ══════════════════════════════════════════════════════════════════ */

  /** Switch between 'individual' and 'dept' views. */
  function switchView(view) {
    currentView = view;

    // Update tab active state
    dom.viewTabs.querySelectorAll('.view-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.view === view);
    });

    if (view === 'individual') {
      dom.individualView.hidden = false;
      dom.deptView.hidden       = true;
    } else {
      dom.individualView.hidden = true;
      dom.deptView.hidden       = false;
      renderOverviewTable();
      renderUnitSummaryChart();
    }
  }

  /** Render the sortable overview table for all filtered doctors. */
  function renderOverviewTable() {
    if (!activeDataset) return;
    const { records, meta } = activeDataset;

    const doctors = getFilteredDoctors(records, meta);

    // Build one row per filtered doctor
    const rows = doctors.map(name => {
      const range    = Parser.dateRangeForDoctor(records, name);
      const total    = Parser.totalForDoctor(records, name);
      const activeMo = Parser.getActiveMonthCount(records, name);
      const avg      = activeMo > 0 ? total / activeMo : 0;
      const proj     = Parser.calculateProjection(records, name, periodMonths, targetEEGs);
      return {
        name,
        first:     range?.first ?? null,
        total,
        avg,
        projected: proj?.projected ?? total,
        status:    proj?.status ?? 'none',
      };
    });

    // Sort
    const { col, dir } = overviewSort;
    const statusOrder  = { green: 0, amber: 1, red: 2, none: 3 };
    rows.sort((a, b) => {
      let va, vb;
      if      (col === 'name')      { va = a.name;  vb = b.name; }
      else if (col === 'first')     { va = a.first?.getTime() ?? 0; vb = b.first?.getTime() ?? 0; }
      else if (col === 'total')     { va = a.total; vb = b.total; }
      else if (col === 'avg')       { va = a.avg;   vb = b.avg; }
      else if (col === 'projected') { va = a.projected; vb = b.projected; }
      else if (col === 'status')    { va = statusOrder[a.status] ?? 3; vb = statusOrder[b.status] ?? 3; }
      const cmp = typeof va === 'string' ? va.localeCompare(vb, 'de') : (va - vb);
      return dir === 'asc' ? cmp : -cmp;
    });

    // Info bar
    const n = rows.length;
    dom.tableInfo.textContent =
      `${n} assistant doctor${n !== 1 ? 's' : ''} · ` +
      `${periodMonths}-month rotation · target ${targetEEGs.toLocaleString()} EEGs`;

    // Rows
    dom.overviewTbody.innerHTML = '';
    rows.forEach(row => {
      const tr  = document.createElement('tr');
      const lbl = STATUS_LABELS[row.status] ?? '—';
      tr.innerHTML = `
        <td class="ov-name">${escHtml(row.name)}</td>
        <td class="ov-date">${row.first ? fmtDate(row.first) : '—'}</td>
        <td class="num">${row.total.toLocaleString()}</td>
        <td class="num">${row.avg > 0 ? row.avg.toFixed(1) : '—'}</td>
        <td class="num">${row.projected.toLocaleString()}</td>
        <td><span class="status-chip ${row.status}">${lbl}</span></td>
      `;
      // Click → switch to individual view and select this doctor
      tr.addEventListener('click', () => {
        switchView('individual');
        selectDoctor(row.name);
      });
      dom.overviewTbody.appendChild(tr);
    });

    // Update sort arrows
    dom.overviewTable.querySelectorAll('th.sortable').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.col === col) th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
    });
  }

  /** Render the unit monthly line chart — reports per month, separate line per modality. */
  function renderUnitSummaryChart() {
    if (!activeDataset) return;
    const doctors      = getFilteredDoctors(activeDataset.records, activeDataset.meta);
    const series       = Parser.getUnitMonthlySeriesByModality(activeDataset.records, doctors);
    const labels       = series.map(m => fmtMonthLabel(m.year, m.month));

    const MOD_COLORS   = { EEG: '#2563eb', SEP: '#059669', AEP: '#ea580c', VEP: '#7c3aed' };
    const MOD_ORDER    = ['EEG', 'SEP', 'AEP', 'VEP'];
    const activeMods   = MOD_ORDER.filter(mod => series.some(m => (m[mod] ?? 0) > 0));

    const seriesData = activeMods.map(mod => ({
      label: mod,
      data:  series.map(m => m[mod] ?? 0),
      color: MOD_COLORS[mod],
    }));

    Charts.renderUnitSummary(dom.unitChart, labels, seriesData);
  }

  /** Export the overview table as a UTF-8 CSV file. */
  function exportCSV() {
    if (!activeDataset) return;
    const { records, meta } = activeDataset;

    const header = ['Name', 'First Report', 'Total Reports', 'Avg per Month', 'Projected Total', 'Status'];
    const dataRows = meta.assistants.map(name => {
      const range   = Parser.dateRangeForDoctor(records, name);
      const total   = Parser.totalForDoctor(records, name);
      const series  = Parser.getMonthSeries(records, name);
      const activeMo = series.filter(m => m.count > 0).length;
      const avg      = activeMo > 0 ? (total / activeMo).toFixed(1) : '0';
      const proj     = Parser.calculateProjection(records, name, periodMonths, targetEEGs);
      return [
        name,
        range?.first ? range.first.toLocaleDateString('de-CH') : '',
        total,
        avg,
        proj?.projected ?? total,
        STATUS_LABELS[proj?.status] ?? '',
      ];
    });

    const csv  = [header, ...dataRows]
      .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `eeg_overview_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Wire up view tabs, sort headers, export and print buttons. */
  /* ── About modal ──────────────────────────────────────────────────── */
  function openAbout()  { dom.aboutModal.hidden = false; dom.aboutClose.focus(); }
  function closeAbout() { dom.aboutModal.hidden = true; }

  function setupAboutModal() {
    dom.aboutBtnUpload.addEventListener('click', openAbout);
    dom.aboutBtnResults.addEventListener('click', openAbout);
    dom.aboutClose.addEventListener('click', closeAbout);
    // Click on backdrop closes
    dom.aboutModal.addEventListener('click', e => {
      if (e.target === dom.aboutModal) closeAbout();
    });
    // Escape closes
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !dom.aboutModal.hidden) closeAbout();
    });
  }


  function setupDeptView() {
    // View tab clicks
    dom.viewTabs.addEventListener('click', e => {
      const tab = e.target.closest('.view-tab');
      if (tab) switchView(tab.dataset.view);
    });

    // Sort header clicks
    dom.overviewTable.querySelector('thead').addEventListener('click', e => {
      const th = e.target.closest('th.sortable');
      if (!th) return;
      const col = th.dataset.col;
      if (overviewSort.col === col) {
        overviewSort.dir = overviewSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        overviewSort = { col, dir: col === 'name' || col === 'first' ? 'asc' : 'desc' };
      }
      renderOverviewTable();
    });

    // Export CSV
    dom.exportCsvBtn.addEventListener('click', exportCSV);

    // Print
    dom.printBtn.addEventListener('click', () => window.print());
  }


  /* ── Period controls ──────────────────────────────────────────────── */
  function syncPeriodControls(months) {
    periodMonths = months;
    dom.periodPresets.querySelectorAll('.period-btn').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.months) === months);
    });
    dom.periodInput.value = months;
  }

  function onPeriodChange(months) {
    const m = Math.max(1, Math.min(36, Math.round(months)));
    if (!m || isNaN(m)) return;
    syncPeriodControls(m);
    refreshAllStatusDots();
    if (selectedDoctor) renderDoctorDetail(selectedDoctor, activeDataset);
    if (currentView === 'dept') renderOverviewTable();
  }

  function setupPeriodControls() {
    dom.periodPresets.addEventListener('click', e => {
      const btn = e.target.closest('.period-btn');
      if (btn) onPeriodChange(Number(btn.dataset.months));
    });
    dom.periodInput.addEventListener('change', () => onPeriodChange(Number(dom.periodInput.value)));
    dom.periodInput.addEventListener('keydown', e => { if (e.key === 'Enter') onPeriodChange(Number(dom.periodInput.value)); });

    dom.targetInput.addEventListener('change', () => {
      const t = Math.max(1, Math.round(Number(dom.targetInput.value)));
      if (!t || isNaN(t)) return;
      targetEEGs = t;
      dom.targetInput.value = t;
      refreshAllStatusDots();
      if (selectedDoctor) renderDoctorDetail(selectedDoctor, activeDataset);
      if (currentView === 'dept') renderOverviewTable();
    });
    dom.targetInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') dom.targetInput.dispatchEvent(new Event('change'));
    });
  }


  /* ── Sidebar search ───────────────────────────────────────────────── */
  function setupSearch() {
    const el    = dom.doctorSearch;
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    dom.doctorSearch = clone;

    clone.addEventListener('input', () => {
      const q = clone.value.trim().toLowerCase();
      let anyVisible = false;
      dom.doctorList.querySelectorAll('.doctor-card').forEach(card => {
        const match = !q || card.dataset.name.toLowerCase().includes(q);
        card.hidden  = !match;
        if (match) anyVisible = true;
      });
      let msg = dom.doctorList.querySelector('.doctor-list-empty.no-results');
      if (!anyVisible && q) {
        if (!msg) {
          msg = document.createElement('li');
          msg.className = 'doctor-list-empty no-results';
          dom.doctorList.appendChild(msg);
        }
        msg.textContent = `No doctors matching "${clone.value.trim()}"`;
      } else if (msg) {
        msg.remove();
      }
    });
  }


  /* ── Load a snapshot ──────────────────────────────────────────────── */
  function loadSnapshot(id) {
    const dataset = Storage.load(id);
    if (!dataset) { toast('Could not load this dataset — it may be corrupted.', 'error'); return; }
    closeDropdown();
    activateDataset(dataset, id);
  }


  /* ── File upload ──────────────────────────────────────────────────── */
  function handleFile(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();

    // ── JSON snapshot import ──────────────────────────────────────────
    if (ext === 'json') {
      dom.parseStatus.hidden       = false;
      dom.parseMessage.textContent = `Loading snapshot "${file.name}"…`;

      const reader = new FileReader();
      reader.onload = e => {
        try {
          const payload = JSON.parse(e.target.result);
          if (!Array.isArray(payload.records) || !payload.meta) {
            throw new Error('This does not look like an EEG Dashboard snapshot file.');
          }

          const records = payload.records.map(r => ({
            date:        new Date(r.date),
            assistants:  r.assistants  ?? [],
            consultants: r.consultants ?? [],
            modality:    r.modality    || 'EEG',
          }));
          const meta = {
            ...payload.meta,
            dateMin: payload.meta.dateMin ? new Date(payload.meta.dateMin) : null,
            dateMax: payload.meta.dateMax ? new Date(payload.meta.dateMax) : null,
          };
          const parsed = { records, meta };

          let snapId = null;
          try { snapId = Storage.save(parsed, meta.filename || file.name); }
          catch (err) { toast(err.message, 'error', 6000); }

          dom.parseStatus.hidden = true;
          renderSnapshotList();
          activateDataset(parsed, snapId);
          toast(`Loaded ${records.length.toLocaleString()} records from snapshot.`, 'success');
        } catch (err) {
          dom.parseStatus.hidden = true;
          toast(err.message || 'Failed to load snapshot file.', 'error', 7000);
          console.error('[App] Snapshot import error:', err);
        }
      };
      reader.onerror = () => {
        dom.parseStatus.hidden = true;
        toast('Could not read the file. Please try again.', 'error');
      };
      reader.readAsText(file);
      return;
    }

    // ── Excel upload ──────────────────────────────────────────────────
    if (!['xlsx', 'xls'].includes(ext)) {
      toast('Please upload an Excel (.xlsx) or snapshot (.json) file.', 'error');
      return;
    }

    dom.parseStatus.hidden       = false;
    dom.parseMessage.textContent = `Reading "${file.name}"…`;

    const reader = new FileReader();
    reader.onload = e => {
      dom.parseMessage.textContent = 'Parsing records…';
      setTimeout(() => {
        try {
          const parsed = Parser.parseWorkbook(e.target.result, file.name);
          let snapId = null;
          try { snapId = Storage.save(parsed, file.name); }
          catch (err) { toast(err.message, 'error', 6000); }

          dom.parseStatus.hidden = true;
          renderSnapshotList();
          activateDataset(parsed, snapId);

          toast(
            `Parsed ${parsed.meta.validRecords.toLocaleString()} records · ` +
            `${parsed.meta.assistants.length} doctors found.`,
            'success'
          );
        } catch (err) {
          dom.parseStatus.hidden = true;
          toast(err.message || 'Failed to parse the file.', 'error', 7000);
          console.error('[App] Parse error:', err);
        }
      }, 50);
    };
    reader.onerror = () => {
      dom.parseStatus.hidden = true;
      toast('Could not read the file. Please try again.', 'error');
    };
    reader.readAsArrayBuffer(file);
  }


  /* ── Download current snapshot as JSON ────────────────────────────── */
  function downloadSnapshot() {
    if (!activeDataset) return;
    const { records, meta } = activeDataset;
    const payload = {
      version:  1,
      exported: new Date().toISOString(),
      meta: {
        ...meta,
        dateMin: meta.dateMin?.toISOString() ?? null,
        dateMax: meta.dateMax?.toISOString() ?? null,
      },
      records: records.map(r => ({
        date:        r.date.toISOString(),
        assistants:  r.assistants,
        consultants: r.consultants,
        modality:    r.modality || 'EEG',
      })),
    };

    const blob     = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url      = URL.createObjectURL(blob);
    const a        = document.createElement('a');
    a.href         = url;
    a.download     = `eeg-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast('Snapshot downloaded — drag it onto this page to reload in any browser.', 'success', 5000);
    closeDropdown();
  }


  /* ── Drag-and-drop ────────────────────────────────────────────────── */
  function setupDragDrop() {
    const zone = dom.uploadZone;
    zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', e => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    });
    zone.addEventListener('click', e => {
      if (e.target === dom.browseBtn || dom.browseBtn.contains(e.target)) return;
      dom.fileInput.click();
    });
    zone.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.fileInput.click(); }
    });
  }


  /* ── Activate dataset ─────────────────────────────────────────────── */
  function activateDataset(dataset, snapId = null) {
    activeDataset = dataset;
    activeSnapId  = snapId;

    // Update trigger label
    dom.activeDatasetLabel.textContent = dataset.meta.filename || 'Dataset';

    // Show view tabs and reset to individual view
    dom.viewTabs.hidden = false;
    if (currentView !== 'individual') {
      currentView = 'individual';
      dom.viewTabs.querySelectorAll('.view-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === 'individual');
      });
      dom.individualView.hidden = false;
      dom.deptView.hidden       = true;
    }

    syncPeriodControls(periodMonths);
    renderDoctorList(dataset);
    dom.doctorSearch.value = '';

    // Refresh dropdown if it's already open
    if (dropdownOpen) renderDropdownList();

    showScreen('results');
  }


  /* ── Init ─────────────────────────────────────────────────────────── */
  function init() {
    // File input wiring
    dom.browseBtn.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', () => {
      if (dom.fileInput.files?.length) handleFile(dom.fileInput.files[0]);
      dom.fileInput.value = '';
    });

    setupDragDrop();
    setupPeriodControls();
    setupDropdown();
    setupDeptView();
    setupAboutModal();

    // "Upload new file" lives in the dropdown footer
    dom.uploadAnotherBtn.addEventListener('click', () => {
      closeDropdown();
      showScreen('upload');
    });

    dom.downloadSnapBtn.addEventListener('click', downloadSnapshot);

    // ── Auto-load: open with the most recent dataset if one exists ──
    if (Storage.hasAny()) {
      renderSnapshotList();               // populate upload-screen list too
      const snapshots = Storage.listAll();
      const latest    = Storage.load(snapshots[0].id);
      if (latest) {
        activateDataset(latest, snapshots[0].id);
        return;                           // go straight to results screen
      }
    }
    // No saved data — show upload screen (default)
  }

  document.addEventListener('DOMContentLoaded', init);


  /* ── Public API ───────────────────────────────────────────────────── */
  return {
    getActiveDataset:  () => activeDataset,
    getSelectedDoctor: () => selectedDoctor,
    selectDoctor,
    showScreen,
    toast,
  };

})();
