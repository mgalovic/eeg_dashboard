/**
 * parser.js — EEG Dashboard
 *
 * Parses an .xlsx export from the MS Access EEG/EP database.
 *
 * Supported formats:
 *
 *   New (Dashboard.xlsx — UNION query):
 *     Modality — EEG | SEP | AEP | VEP
 *     Date     — report date (Excel serial or Date)
 *     AA       — primary reporter slot
 *     OA       — secondary reporter slot
 *     VISUM    — shortname of last editor (used to resolve SEP records)
 *
 *   Legacy (eeg_aa_oa.xlsx):
 *     Datum — date
 *     AA    — primary slot
 *     OA    — secondary slot
 *
 * Cell formats:
 *   Standard : "Full Name\nRole Title"  (multiple people: blank-line separated)
 *   Comma    : "Full Name, Role Title"  (single line, AEP style)
 *
 * SEP records carry no AA/OA names — they are attributed to the assistant doctor
 * whose VISUM code matches the VISUM column, resolved by a two-pass algorithm:
 *   Pass 1 — scan EEG rows, build VISUM → most-frequent AA-assistant map
 *   Pass 2 — process all rows; SEP rows use the VISUM map for attribution
 */

'use strict';

const Parser = (() => {

  /* ── Role classification ──────────────────────────────────────────── */

  const ASSISTANT_RE  = /assistenz(arzt|ärzt)/i;
  const CONSULTANT_RE = /oberarzt|oberärztin|chefarzt|chefärztin|leitende[rs]?\s+(ober|ärzt)|facharzt|fachärztin/i;

  function classifyRole(rawRole) {
    if (!rawRole) return 'unknown';
    const s = rawRole.replace(/[^a-zA-ZäöüÄÖÜß\s./]/g, '').trim();
    if (ASSISTANT_RE.test(s))  return 'assistant';
    if (CONSULTANT_RE.test(s)) return 'consultant';
    return 'unknown';
  }


  /* ── Name normalisation ───────────────────────────────────────────── */

  const PREFIX_RE = /^[\s,]*(Prof\.?\s+Dr\.?\s+med\.?|PD\s+Dr\.?\s+med\.?\s+univ\.?|PD\s+Dr\.?\s+med\.?|PD\s+Dr\.?|Dr\.?\s+med\.?\s+univ\.?|Dr\.?\s+med\.?|Dr\.?|sc\.nat\.)\s*/i;
  const QUAL_RE   = /\b(Ph\.?D\.?|MSc\s+ETH|MSc|MBA|FEBN|FEAN|MAS|MPH|M\.D\.)\b/gi;

  function normalizeName(raw) {
    if (!raw) return '';
    let name = raw.trim();
    let previous;
    do {
      previous = name;
      name = name.replace(PREFIX_RE, '');
    } while (name !== previous);
    name = name.replace(QUAL_RE, '');
    name = name.replace(/,+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return name;
  }


  /* ── Cell parsing ─────────────────────────────────────────────────── */

  /**
   * Parse a single AA or OA cell into an array of person objects.
   * Handles both the standard newline format and the AEP comma format.
   */
  function parseCell(cellValue) {
    if (cellValue === null || cellValue === undefined) return [];
    const text = String(cellValue).trim();
    if (!text) return [];

    const blocks = text.split(/\n[ \t]*\n/);

    return blocks
      .map(block => {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return null;

        let rawName, rawRole;

        if (lines.length === 1) {
          // AEP-style "Name, Role" comma-separated single line
          const commaIdx = lines[0].lastIndexOf(', ');
          if (commaIdx > 0) {
            rawName = lines[0].slice(0, commaIdx).trim();
            rawRole = lines[0].slice(commaIdx + 2).trim();
          } else {
            rawName = lines[0];
            rawRole = '';
          }
        } else {
          rawName = lines[0] || '';
          rawRole = lines[1] || '';
        }

        const canonicalName = normalizeName(rawName);
        const role          = classifyRole(rawRole);
        if (!rawName) return null;
        return { rawName, canonicalName, rawRole, role };
      })
      .filter(Boolean);
  }


  /* ── Date helpers ─────────────────────────────────────────────────── */

  function toDate(val) {
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
    if (typeof val === 'number') {
      const ms = (val - 25569) * 86400 * 1000;
      const d  = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof val === 'string' && val.trim()) {
      // Numeric string serial (Access may export date as a number string)
      const num = Number(val.trim());
      if (!isNaN(num) && num > 1000 && num < 100000) {
        const ms = (num - 25569) * 86400 * 1000;
        const d  = new Date(ms);
        if (!isNaN(d.getTime())) return d;
      }
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }


  /* ── Known modalities ─────────────────────────────────────────────── */

  const KNOWN_MODALITIES = new Set(['EEG', 'SEP', 'AEP', 'VEP']);

  function normalizeModality(raw) {
    const m = String(raw ?? '').trim().toUpperCase();
    return KNOWN_MODALITIES.has(m) ? m : 'EEG';
  }


  /* ── Main workbook parser ─────────────────────────────────────────── */

  /**
   * Parse an ArrayBuffer containing an .xlsx file.
   *
   * Returns:
   * {
   *   records: [{ date, assistants, consultants, modality }, …],
   *   meta: {
   *     filename, totalRows, validRecords, skippedRows,
   *     assistants, consultants, allDoctors,
   *     dateMin, dateMax,
   *     modalities,   // sorted unique modality strings
   *     visumMap,     // VISUM → canonical assistant name (for SEP attribution)
   *   }
   * }
   */
  function parseWorkbook(arrayBuffer, filename) {
    let workbook;
    try {
      workbook = XLSX.read(new Uint8Array(arrayBuffer), {
        type:      'array',
        cellDates: true,
      });
    } catch (e) {
      throw new Error('Could not read the file. Make sure it is a valid .xlsx file.');
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('The workbook contains no sheets.');

    const sheet = workbook.Sheets[sheetName];
    const rows  = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
      raw:    true,
    });

    if (rows.length < 2) {
      throw new Error('The file appears to be empty or has only a header row.');
    }

    // ── Detect column indices ──────────────────────────────────────────
    const headerRow   = rows[0].map(h => String(h ?? '').trim().toLowerCase());
    const modalityIdx = headerRow.findIndex(h => h === 'modality');
    const datumIdx    = headerRow.findIndex(h => h === 'datum' || h === 'date');
    const aaIdx       = headerRow.findIndex(h => h === 'aa');
    const oaIdx       = headerRow.findIndex(h => h === 'oa');
    const visumIdx    = headerRow.findIndex(h => h === 'visum');

    if (datumIdx === -1) {
      throw new Error(
        'Could not find a "Date" or "Datum" column. ' +
        `Headers found: ${rows[0].filter(Boolean).join(', ')}`
      );
    }

    const aaCol       = aaIdx  >= 0 ? aaIdx  : 1;
    const oaCol       = oaIdx  >= 0 ? oaIdx  : 2;
    const isNewFormat = modalityIdx !== -1 && visumIdx !== -1;

    // ── PASS 1: build VISUM → most-frequent AA-assistant map (EEG rows) ─
    const visumNameCounts = new Map(); // visum → Map<canonicalName, count>

    if (isNewFormat) {
      for (let i = 1; i < rows.length; i++) {
        const row      = rows[i];
        const modality = normalizeModality(row[modalityIdx]);
        if (modality !== 'EEG') continue;

        const visum = String(row[visumIdx] ?? '').trim();
        if (!visum) continue;

        for (const p of parseCell(row[aaCol])) {
          if (p.role !== 'assistant' || !p.canonicalName) continue;
          if (!visumNameCounts.has(visum)) visumNameCounts.set(visum, new Map());
          const nm = visumNameCounts.get(visum);
          nm.set(p.canonicalName, (nm.get(p.canonicalName) ?? 0) + 1);
        }
      }
    }

    // Resolve VISUM → best (most frequent) canonical name
    const visumMap = new Map();
    for (const [visum, nm] of visumNameCounts) {
      let best = null, bestN = 0;
      for (const [name, n] of nm) {
        if (n > bestN) { best = name; bestN = n; }
      }
      if (best) visumMap.set(visum, best);
    }

    // ── PASS 2: process all rows ───────────────────────────────────────
    const records       = [];
    let   skipped       = 0;
    const assistantSet  = new Set();
    const consultantSet = new Set();
    const modalitySet   = new Set();

    for (let i = 1; i < rows.length; i++) {
      const row      = rows[i];
      const rawDate  = row[datumIdx];
      const date     = toDate(rawDate);
      if (!date) { skipped++; continue; }

      const modality = isNewFormat ? normalizeModality(row[modalityIdx]) : 'EEG';
      modalitySet.add(modality);

      let assistantNames = [], consultantNames = [];

      if (modality === 'SEP' && isNewFormat) {
        // SEP has no AA/OA names — attribute via VISUM map
        const visum = String(row[visumIdx] ?? '').trim();
        const name  = visumMap.get(visum);
        if (name) {
          assistantNames = [name];
          assistantSet.add(name);
        }
      } else {
        const aaPersons = parseCell(row[aaCol]).map(p => ({ ...p, col: 'AA' }));
        const oaPersons = parseCell(row[oaCol]).map(p => ({ ...p, col: 'OA' }));
        const all       = [...aaPersons, ...oaPersons];

        let assistants  = all.filter(p => p.role === 'assistant');
        let consultants = all.filter(p => p.role === 'consultant');
        const unknowns  = all.filter(p => p.role === 'unknown');

        for (const u of unknowns) {
          if (u.col === 'AA') assistants.push(u);
          else                consultants.push(u);
        }

        assistantNames  = [...new Set(assistants.map(p => p.canonicalName).filter(Boolean))];
        consultantNames = [...new Set(consultants.map(p => p.canonicalName).filter(Boolean))];

        assistantNames.forEach(n  => assistantSet.add(n));
        consultantNames.forEach(n => consultantSet.add(n));
      }

      records.push({ date, assistants: assistantNames, consultants: consultantNames, modality });
    }

    if (!records.length) {
      throw new Error('No valid records found after parsing. Check the file format.');
    }

    // ── Build date range ──────────────────────────────────────────────
    let dateMin = records[0].date, dateMax = records[0].date;
    for (const r of records) {
      if (r.date < dateMin) dateMin = r.date;
      if (r.date > dateMax) dateMax = r.date;
    }

    const meta = {
      filename:        filename || 'Uploaded file',
      totalRows:       rows.length - 1,
      validRecords:    records.length,
      skippedRows:     skipped,
      assistants:      [...assistantSet].sort((a, b) => a.localeCompare(b, 'de')),
      consultants:     [...consultantSet].sort((a, b) => a.localeCompare(b, 'de')),
      allDoctors:      [...new Set([...assistantSet, ...consultantSet])].sort((a, b) => a.localeCompare(b, 'de')),
      dateMin,
      dateMax,
      modalities:      [...modalitySet].sort(),
      visumMap:        Object.fromEntries(visumMap),
    };

    console.group('[Parser] Parse complete');
    console.log('Valid records :', meta.validRecords);
    console.log('Skipped rows  :', meta.skippedRows);
    console.log('Modalities    :', meta.modalities);
    console.log('VISUM map size:', visumMap.size);
    console.log('Date range    :', dateMin.toLocaleDateString(), '–', dateMax.toLocaleDateString());
    console.log('Assistants    :', meta.assistants);
    console.log('Sample records:', records.slice(0, 3));
    console.groupEnd();

    return { records, meta };
  }


  /* ── Query helpers ────────────────────────────────────────────────── */

  /**
   * Monthly count breakdown by modality for a single doctor.
   * Returns [{ year, month, count, EEG, SEP, AEP, VEP }, …] sorted chronologically.
   */
  function monthlyCountsByModality(records, canonicalName) {
    const map = new Map(); // "YYYY-MM" → { EEG, SEP, AEP, VEP }

    for (const r of records) {
      if (!r.assistants.includes(canonicalName) && !r.consultants.includes(canonicalName)) continue;
      const key = `${r.date.getFullYear()}-${String(r.date.getMonth()).padStart(2, '0')}`;
      if (!map.has(key)) map.set(key, { EEG: 0, SEP: 0, AEP: 0, VEP: 0 });
      const m   = map.get(key);
      const mod = normalizeModality(r.modality);
      m[mod]++;
    }

    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, counts]) => {
        const [y, mo] = key.split('-').map(Number);
        const count   = counts.EEG + counts.SEP + counts.AEP + counts.VEP;
        return { year: y, month: mo, count, ...counts };
      });
  }

  /**
   * Monthly total count for a doctor (all modalities combined).
   * Delegates to monthlyCountsByModality for consistency.
   */
  function monthlyCountsForDoctor(records, canonicalName) {
    return monthlyCountsByModality(records, canonicalName)
      .map(({ year, month, count }) => ({ year, month, count }));
  }

  function totalForDoctor(records, canonicalName) {
    return records.filter(r =>
      r.assistants.includes(canonicalName) || r.consultants.includes(canonicalName)
    ).length;
  }

  function dateRangeForDoctor(records, canonicalName) {
    const dates = records
      .filter(r => r.assistants.includes(canonicalName) || r.consultants.includes(canonicalName))
      .map(r => r.date);
    if (!dates.length) return null;
    return {
      first: new Date(Math.min(...dates)),
      last:  new Date(Math.max(...dates)),
    };
  }

  function getMonthSeries(records, canonicalName) {
    const range = dateRangeForDoctor(records, canonicalName);
    if (!range) return [];

    const monthly  = monthlyCountsForDoctor(records, canonicalName);
    const countMap = new Map(monthly.map(({ year, month, count }) => [`${year}-${month}`, count]));

    const now      = new Date();
    const endYear  = now.getFullYear();
    const endMonth = now.getMonth();

    const result = [];
    let y = range.first.getFullYear();
    let m = range.first.getMonth();

    while (y < endYear || (y === endYear && m <= endMonth)) {
      result.push({ year: y, month: m, count: countMap.get(`${y}-${m}`) ?? 0 });
      m++;
      if (m > 11) { m = 0; y++; }
    }
    return result;
  }

  /**
   * Like getMonthSeries but extended through the rotation period end,
   * with per-modality counts and isFuture flag.
   *
   * @returns {{ series: object[], periodEnd: Date }}
   *   series items: { year, month, count, isFuture, EEG, SEP, AEP, VEP }
   */
  function getMonthSeriesForPeriod(records, canonicalName, periodMonths) {
    const range = dateRangeForDoctor(records, canonicalName);
    if (!range) return { series: [], periodEnd: null };

    const monthly  = monthlyCountsByModality(records, canonicalName);
    const countMap = new Map(monthly.map(m => [`${m.year}-${m.month}`, m]));

    const periodEnd = new Date(range.first.getFullYear(), range.first.getMonth() + periodMonths, 1);
    const now       = new Date();
    const seriesEnd = periodEnd > now ? periodEnd : now;

    const series = [];
    let y = range.first.getFullYear();
    let m = range.first.getMonth();
    const endY = seriesEnd.getFullYear();
    const endM = seriesEnd.getMonth();

    while (y < endY || (y === endY && m <= endM)) {
      const isFuture = new Date(y, m, 1) > now;
      const data     = countMap.get(`${y}-${m}`) ?? { EEG: 0, SEP: 0, AEP: 0, VEP: 0, count: 0 };
      series.push({
        year: y, month: m,
        count: data.count,
        isFuture,
        EEG: data.EEG ?? 0, SEP: data.SEP ?? 0,
        AEP: data.AEP ?? 0, VEP: data.VEP ?? 0,
      });
      m++;
      if (m > 11) { m = 0; y++; }
    }

    return { series, periodEnd };
  }

  function getActiveMonthCount(records, canonicalName) {
    const monthly = monthlyCountsForDoctor(records, canonicalName);
    const now = new Date();
    const curY = now.getFullYear(), curM = now.getMonth();
    return monthly.filter(m => {
      const isCurrent = m.year === curY && m.month === curM;
      return isCurrent ? m.count > 0 : m.count > 5;
    }).length;
  }

  function calculateProjection(records, canonicalName, periodMonths, target = 800) {
    const range = dateRangeForDoctor(records, canonicalName);
    if (!range) return null;

    const total = totalForDoctor(records, canonicalName);
    const now   = new Date();

    const periodStart   = range.first;
    const periodEnd     = new Date(periodStart.getFullYear(), periodStart.getMonth() + periodMonths, 1);
    const msDay         = 1000 * 60 * 60 * 24;
    const daysElapsed   = Math.max(1, (now - periodStart) / msDay);
    const daysTotal     = Math.max(1, (periodEnd - periodStart) / msDay);
    const daysRemaining = Math.max(0, (periodEnd - now) / msDay);

    const activeMonths = getActiveMonthCount(records, canonicalName);
    const ratePerMonth = activeMonths > 0
      ? total / activeMonths
      : total / Math.max(1, daysElapsed / 30.4375);
    const ratePerDay   = ratePerMonth / 30.4375;

    const projected = Math.round(total + ratePerDay * daysRemaining);

    const stillNeeded            = Math.max(0, target - total);
    const monthsRemaining        = daysRemaining / 30.4375;
    const requiredAdditionalRate = monthsRemaining > 0.5
      ? (stillNeeded / monthsRemaining)
      : null;

    const requiredMonthlyRate = target / periodMonths;
    const pctActual           = Math.round((total     / target) * 100);
    const pctProjected        = Math.round((projected / target) * 100);

    let status;
    if (projected >= target)            status = 'green';
    else if (projected >= target * 0.8) status = 'amber';
    else                                status = 'red';

    const isExpired      = now >= periodEnd;
    const periodProgress = Math.min(1, daysElapsed / daysTotal);

    return {
      total, projected, target,
      status,
      ratePerDay, ratePerMonth,
      requiredMonthlyRate, requiredAdditionalRate,
      pctActual, pctProjected,
      daysElapsed:   Math.round(daysElapsed),
      daysRemaining: Math.round(daysRemaining),
      periodEnd, periodStart, periodMonths,
      periodProgress, isExpired,
      activeMonths,
    };
  }

  /**
   * Returns a continuous month-by-month series with per-modality record counts
   * for the department overview chart.
   *
   * @param {object[]}      records
   * @param {string[]|null} doctorNames — optional filter; null = all records
   * @returns {Array<{year, month, EEG, SEP, AEP, VEP}>}
   */
  function getUnitMonthlySeriesByModality(records, doctorNames = null) {
    const nameSet   = doctorNames ? new Set(doctorNames) : null;
    const filtered  = nameSet
      ? records.filter(r => [...r.assistants, ...r.consultants].some(n => nameSet.has(n)))
      : records;

    if (!filtered.length) return [];

    const minDate  = new Date(Math.min(...filtered.map(r => r.date.getTime())));
    const now      = new Date();
    const countMap = new Map(); // "Y-M" → { EEG, SEP, AEP, VEP }

    for (const r of filtered) {
      const key = `${r.date.getFullYear()}-${r.date.getMonth()}`;
      if (!countMap.has(key)) countMap.set(key, { EEG: 0, SEP: 0, AEP: 0, VEP: 0 });
      const m   = countMap.get(key);
      const mod = normalizeModality(r.modality);
      m[mod]++;
    }

    const series = [];
    let y = minDate.getFullYear(), m = minDate.getMonth();
    const endY = now.getFullYear(), endM = now.getMonth();
    while (y < endY || (y === endY && m <= endM)) {
      const counts = countMap.get(`${y}-${m}`) ?? { EEG: 0, SEP: 0, AEP: 0, VEP: 0 };
      series.push({ year: y, month: m, ...counts });
      m++;
      if (m > 11) { m = 0; y++; }
    }
    return series;
  }

  /**
   * Legacy unit series (total count, optional doctor filter).
   * Kept for compatibility; prefer getUnitMonthlySeriesByModality for new code.
   */
  function getUnitMonthlySeries(records, doctorNames = null) {
    const nameSet  = doctorNames ? new Set(doctorNames) : null;
    const countMap = new Map();
    const minDates = [];

    for (const r of records) {
      const people = [...r.assistants, ...r.consultants];
      const match  = nameSet ? people.some(n => nameSet.has(n)) : people.length > 0;
      if (!match) continue;
      minDates.push(r.date);
      const key = `${r.date.getFullYear()}-${r.date.getMonth()}`;
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }

    if (!minDates.length) return [];

    const minDate = new Date(Math.min(...minDates.map(d => d.getTime())));
    const now     = new Date();
    const series  = [];
    let y = minDate.getFullYear(), m = minDate.getMonth();
    const endY = now.getFullYear(), endM = now.getMonth();
    while (y < endY || (y === endY && m <= endM)) {
      series.push({ year: y, month: m, count: countMap.get(`${y}-${m}`) ?? 0 });
      m++;
      if (m > 11) { m = 0; y++; }
    }
    return series;
  }


  /* ── Public API ───────────────────────────────────────────────────── */
  return {
    parseWorkbook,
    normalizeName,
    classifyRole,
    parseCell,
    monthlyCountsForDoctor,
    monthlyCountsByModality,
    totalForDoctor,
    dateRangeForDoctor,
    getMonthSeries,
    getMonthSeriesForPeriod,
    calculateProjection,
    getActiveMonthCount,
    getUnitMonthlySeries,
    getUnitMonthlySeriesByModality,
  };

})();
