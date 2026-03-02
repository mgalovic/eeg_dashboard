/**
 * parser.js — EEG Dashboard
 *
 * Parses an .xlsx export from the MS Access EEG database.
 *
 * Expected columns (any order, detected by header):
 *   Datum  — date of the EEG report
 *   AA     — primary reporter slot (may hold assistant OR consultant)
 *   OA     — secondary reporter slot (may hold assistant OR consultant)
 *
 * Each AA/OA cell contains one or more people in this format:
 *   "Full Name\nRole Title"
 *
 * Multiple people are separated by a blank line (\n\n).
 * The role title determines seniority — the column label (AA/OA) cannot
 * be trusted because the slots are sometimes swapped.
 */

'use strict';

const Parser = (() => {

  /* ── Role classification ──────────────────────────────────────────── */

  // Keywords that unambiguously indicate an assistant / junior doctor.
  // Matches both male form (Assistenzarzt) and female/typo forms (Assistenzärztin, Assistenzärzti).
  const ASSISTANT_RE = /assistenz(arzt|ärzt)/i;

  // Keywords that indicate a senior / consultant doctor.
  // Covers: Oberarzt/in, Leitender Oberarzt, Chefarzt/in, Facharzt/in,
  //         Leitende Ärztin/Leitender Arzt (senior physician without Ober- prefix)
  const CONSULTANT_RE = /oberarzt|oberärztin|chefarzt|chefärztin|leitende[rs]?\s+(ober|ärzt)|facharzt|fachärztin/i;

  function classifyRole(rawRole) {
    if (!rawRole) return 'unknown';
    // Strip noise characters (typos like "Oberarzt$", "Oberarzt¨")
    const s = rawRole.replace(/[^a-zA-ZäöüÄÖÜß\s./]/g, '').trim();
    if (ASSISTANT_RE.test(s)) return 'assistant';
    if (CONSULTANT_RE.test(s)) return 'consultant';
    return 'unknown';
  }


  /* ── Name normalisation ───────────────────────────────────────────── */

  // Academic prefix titles to strip from the front of names.
  // sc.nat. = Doctor scientiae naturalis (non-medical PhD common in Swiss hospitals)
  const PREFIX_RE = /^[\s,]*(Prof\.?\s+Dr\.?\s+med\.?|PD\s+Dr\.?\s+med\.?\s+univ\.?|PD\s+Dr\.?\s+med\.?|PD\s+Dr\.?|Dr\.?\s+med\.?\s+univ\.?|Dr\.?\s+med\.?|Dr\.?|sc\.nat\.)\s*/i;

  // Post-nominal qualifications to strip wherever they appear
  const QUAL_RE = /\b(Ph\.?D\.?|MSc\s+ETH|MSc|MBA|FEBN|FEAN|MAS|MPH|M\.D\.)\b/gi;

  /**
   * Strip academic titles and post-nominal qualifications from a raw name
   * string, returning a compact canonical form (e.g. "A. Hauck").
   *
   * "Dr. med. A. Hauck, PhD"      → "A. Hauck"
   * "PD Dr. med. PhD M. Galovic"  → "M. Galovic"
   * "Dr. med. MSc ETH J. Meichtry"→ "J. Meichtry"
   * "M. Graure"                   → "M. Graure"
   */
  function normalizeName(raw) {
    if (!raw) return '';
    let name = raw.trim();

    // Strip prefix titles (iterate because some names have stacked titles)
    let previous;
    do {
      previous = name;
      name = name.replace(PREFIX_RE, '');
    } while (name !== previous);

    // Strip post-nominal qualifications
    name = name.replace(QUAL_RE, '');

    // Clean up residual commas and whitespace
    name = name.replace(/,+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    return name;
  }


  /* ── Cell parsing ─────────────────────────────────────────────────── */

  /**
   * Parse a single AA or OA cell value into an array of person objects.
   * Returns [] for empty / null cells.
   *
   * Each person object:
   *   { rawName, canonicalName, rawRole, role: 'assistant'|'consultant'|'unknown' }
   */
  function parseCell(cellValue) {
    if (cellValue === null || cellValue === undefined) return [];
    const text = String(cellValue).trim();
    if (!text) return [];

    // Split on one or more blank lines to get individual person blocks
    const blocks = text.split(/\n[ \t]*\n/);

    return blocks
      .map(block => {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return null;

        const rawName      = lines[0] || '';
        const rawRole      = lines[1] || '';
        const canonicalName = normalizeName(rawName);
        const role         = classifyRole(rawRole);

        if (!rawName) return null;
        return { rawName, canonicalName, rawRole, role };
      })
      .filter(Boolean);
  }


  /* ── Date helpers ─────────────────────────────────────────────────── */

  /**
   * Convert whatever SheetJS gives us for a date cell into a plain JS Date.
   * With cellDates:true, SheetJS returns Date objects directly.
   * Fallback handles numeric serial numbers and ISO strings.
   */
  function toDate(val) {
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
    if (typeof val === 'number') {
      // Excel date serial → JS timestamp (days since 1899-12-30)
      const ms = (val - 25569) * 86400 * 1000;
      const d  = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof val === 'string' && val.trim()) {
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }


  /* ── Main workbook parser ─────────────────────────────────────────── */

  /**
   * Parse an ArrayBuffer containing an .xlsx file.
   *
   * Returns:
   * {
   *   records: [{ date, assistants: string[], consultants: string[] }, …],
   *   meta: {
   *     filename,
   *     totalRows, validRecords, skippedRows,
   *     assistants: string[],   // sorted unique canonical names
   *     consultants: string[],  // sorted unique canonical names
   *     dateMin, dateMax
   *   }
   * }
   */
  function parseWorkbook(arrayBuffer, filename) {
    // ── Read workbook ──────────────────────────────────────────────
    let workbook;
    try {
      workbook = XLSX.read(new Uint8Array(arrayBuffer), {
        type:      'array',
        cellDates: true,   // date serials → JS Date objects in cell.v
      });
    } catch (e) {
      throw new Error('Could not read the file. Make sure it is a valid .xlsx file.');
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('The workbook contains no sheets.');

    const sheet = workbook.Sheets[sheetName];

    // Read once with raw:true to get Date objects + raw strings (preserves \n)
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header:  1,
      defval:  null,
      raw:     true,
    });

    if (rows.length < 2) {
      throw new Error('The file appears to be empty or has only a header row.');
    }

    // ── Detect column indices from header ──────────────────────────
    const headerRow = rows[0].map(h => String(h ?? '').trim().toLowerCase());

    const datumIdx = headerRow.findIndex(h => h === 'datum' || h === 'date');
    const aaIdx    = headerRow.findIndex(h => h === 'aa');
    const oaIdx    = headerRow.findIndex(h => h === 'oa');

    if (datumIdx === -1) {
      throw new Error(
        'Could not find a "Datum" column. ' +
        `Headers found: ${rows[0].filter(Boolean).join(', ')}`
      );
    }
    // Fallback: if AA/OA headers are missing, assume columns 1 and 2
    const aaCol = aaIdx >= 0 ? aaIdx : 1;
    const oaCol = oaIdx >= 0 ? oaIdx : 2;

    // ── Process rows ───────────────────────────────────────────────
    const records    = [];
    let   skipped    = 0;
    const assistantSet  = new Set();
    const consultantSet = new Set();

    for (let i = 1; i < rows.length; i++) {
      const row    = rows[i];
      const rawDate = row[datumIdx];
      const date   = toDate(rawDate);

      if (!date) { skipped++; continue; }

      const aaPersons = parseCell(row[aaCol]).map(p => ({ ...p, col: 'AA' }));
      const oaPersons = parseCell(row[oaCol]).map(p => ({ ...p, col: 'OA' }));
      const all       = [...aaPersons, ...oaPersons];

      let assistants  = all.filter(p => p.role === 'assistant');
      let consultants = all.filter(p => p.role === 'consultant');
      const unknowns  = all.filter(p => p.role === 'unknown');

      // Fallback for unclassified entries: assign by column position
      for (const u of unknowns) {
        if (u.col === 'AA') assistants.push(u);
        else                consultants.push(u);
      }

      const assistantNames  = [...new Set(assistants.map(p => p.canonicalName).filter(Boolean))];
      const consultantNames = [...new Set(consultants.map(p => p.canonicalName).filter(Boolean))];

      assistantNames.forEach(n  => assistantSet.add(n));
      consultantNames.forEach(n => consultantSet.add(n));

      records.push({ date, assistants: assistantNames, consultants: consultantNames });
    }

    if (!records.length) {
      throw new Error('No valid EEG records found after parsing. Check the file format.');
    }

    // ── Build date range ───────────────────────────────────────────
    let dateMin = records[0].date;
    let dateMax = records[0].date;
    for (const r of records) {
      if (r.date < dateMin) dateMin = r.date;
      if (r.date > dateMax) dateMax = r.date;
    }

    const meta = {
      filename:      filename || 'Uploaded file',
      totalRows:     rows.length - 1,
      validRecords:  records.length,
      skippedRows:   skipped,
      assistants:    [...assistantSet].sort((a, b) => a.localeCompare(b, 'de')),
      consultants:   [...consultantSet].sort((a, b) => a.localeCompare(b, 'de')),
      allDoctors:    [...new Set([...assistantSet, ...consultantSet])].sort((a, b) => a.localeCompare(b, 'de')),
      dateMin,
      dateMax,
    };

    console.group('[EEG Parser] Parse complete');
    console.log('Valid records :', meta.validRecords);
    console.log('Skipped rows  :', meta.skippedRows);
    console.log('Date range    :', dateMin.toLocaleDateString(), '–', dateMax.toLocaleDateString());
    console.log('Assistants    :', meta.assistants);
    console.log('Consultants   :', meta.consultants);
    console.log('Sample records:', records.slice(0, 5));
    console.groupEnd();

    return { records, meta };
  }


  /* ── Query helpers (used by Stage 2+ UI) ─────────────────────────── */

  /**
   * Returns an array of { year, month (0-based), count } for a given doctor.
   * Counts records where the doctor appears in either the assistant or consultant slot
   * (handles cases where AA/OA columns are swapped or a consultant is on rotation).
   */
  function monthlyCountsForDoctor(records, canonicalName) {
    const map = new Map(); // "YYYY-MM" → count

    for (const r of records) {
      if (!r.assistants.includes(canonicalName) && !r.consultants.includes(canonicalName)) continue;
      const key = `${r.date.getFullYear()}-${String(r.date.getMonth()).padStart(2, '0')}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }

    // Sort chronologically and unpack
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, count]) => {
        const [y, m] = key.split('-').map(Number);
        return { year: y, month: m, count };
      });
  }

  /**
   * Returns the total number of EEG records where the given doctor
   * appears in either the assistant or consultant slot.
   */
  function totalForDoctor(records, canonicalName) {
    return records.filter(r =>
      r.assistants.includes(canonicalName) || r.consultants.includes(canonicalName)
    ).length;
  }

  /**
   * Returns the earliest and latest report dates for the given doctor
   * (either role), or null if none found.
   */
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

  /**
   * Returns a continuous month-by-month array from the doctor's first report
   * month through to the current calendar month (inclusive), with a count
   * for each month (0 for months with no reports).
   *
   * Used to drive the bar chart — ensures no gaps in the X-axis.
   */
  function getMonthSeries(records, canonicalName) {
    const range = dateRangeForDoctor(records, canonicalName);
    if (!range) return [];

    const monthly  = monthlyCountsForDoctor(records, canonicalName);
    const countMap = new Map(monthly.map(({ year, month, count }) => [`${year}-${month}`, count]));

    // End at the later of last report month or current month
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
   * Like getMonthSeries but extends the series through the end of the
   * rotation period, marking future months with isFuture:true.
   *
   * @param {object[]} records
   * @param {string}   canonicalName
   * @param {number}   periodMonths — rotation length in months
   * @returns {{ series: object[], periodEnd: Date }}
   *   series items: { year, month, count, isFuture }
   */
  function getMonthSeriesForPeriod(records, canonicalName, periodMonths) {
    const range = dateRangeForDoctor(records, canonicalName);
    if (!range) return { series: [], periodEnd: null };

    const monthly  = monthlyCountsForDoctor(records, canonicalName);
    const countMap = new Map(monthly.map(({ year, month, count }) => [`${year}-${month}`, count]));

    // Period ends periodMonths calendar months after first report month
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
      series.push({ year: y, month: m, count: countMap.get(`${y}-${m}`) ?? 0, isFuture });
      m++;
      if (m > 11) { m = 0; y++; }
    }

    return { series, periodEnd };
  }

  /**
   * Returns the number of "active" months for a doctor — i.e. months in
   * which they reported more than 5 EEGs.
   *
   * The current (most recent) calendar month is always included if it has
   * any EEGs at all, because it may not yet be complete.
   *
   * Used to exclude break months from the rate/projection calculation.
   */
  function getActiveMonthCount(records, canonicalName) {
    const monthly = monthlyCountsForDoctor(records, canonicalName);
    const now = new Date();
    const curY = now.getFullYear(), curM = now.getMonth();
    return monthly.filter(m => {
      const isCurrent = m.year === curY && m.month === curM;
      return isCurrent ? m.count > 0 : m.count > 5;
    }).length;
  }


  /**
   * Calculate EEG projection for a doctor over a rotation period.
   *
   * Rate is based on active months only (months with >5 EEGs, current month
   * always included), so rotation breaks don't deflate the projected total.
   *
   * @param {object[]} records
   * @param {string}   canonicalName
   * @param {number}   periodMonths
   * @param {number}   [target=800]
   * @returns {object|null}  null if no reports found
   */
  function calculateProjection(records, canonicalName, periodMonths, target = 800) {
    const range = dateRangeForDoctor(records, canonicalName);
    if (!range) return null;

    const total = totalForDoctor(records, canonicalName);
    const now   = new Date();

    // Period anchored to first report date
    const periodStart = range.first;
    const periodEnd   = new Date(periodStart.getFullYear(), periodStart.getMonth() + periodMonths, 1);

    const msDay        = 1000 * 60 * 60 * 24;
    const daysElapsed  = Math.max(1, (now - periodStart) / msDay);
    const daysTotal    = Math.max(1, (periodEnd - periodStart) / msDay);
    const daysRemaining = Math.max(0, (periodEnd - now) / msDay);

    // Rate based on active months only — excludes break months (≤5 EEGs)
    const activeMonths = getActiveMonthCount(records, canonicalName);
    const ratePerMonth = activeMonths > 0
      ? total / activeMonths
      : total / Math.max(1, daysElapsed / 30.4375);
    const ratePerDay   = ratePerMonth / 30.4375;

    // Projected total at period end
    const projected = Math.round(total + ratePerDay * daysRemaining);

    // What additional monthly rate is needed from today to hit the target?
    const stillNeeded          = Math.max(0, target - total);
    const monthsRemaining      = daysRemaining / 30.4375;
    const requiredAdditionalRate = monthsRemaining > 0.5
      ? (stillNeeded / monthsRemaining)
      : null;

    // Required average monthly rate over the whole period
    const requiredMonthlyRate  = target / periodMonths;

    // Percentage of target reached or projected
    const pctActual    = Math.round((total     / target) * 100);
    const pctProjected = Math.round((projected / target) * 100);

    // Traffic light
    let status;
    if (projected >= target)            status = 'green';
    else if (projected >= target * 0.8) status = 'amber';
    else                                status = 'red';

    const isExpired     = now >= periodEnd;
    const periodProgress = Math.min(1, daysElapsed / daysTotal);

    return {
      total, projected, target,
      status,
      ratePerDay, ratePerMonth,
      requiredMonthlyRate, requiredAdditionalRate,
      pctActual, pctProjected,
      daysElapsed: Math.round(daysElapsed),
      daysRemaining: Math.round(daysRemaining),
      periodEnd, periodStart, periodMonths,
      periodProgress, isExpired,
      activeMonths,
    };
  }


  /**
   * Returns a continuous month-by-month count of EEG records in which at
   * least one doctor from `doctorNames` participated (either role).
   *
   * Each EEG record is counted once per month regardless of how many
   * tracked doctors appear on it.
   *
   * @param {object[]}        records
   * @param {string[]|null}   doctorNames — if null, counts all records with any person
   */
  function getUnitMonthlySeries(records, doctorNames = null) {
    const nameSet    = doctorNames ? new Set(doctorNames) : null;
    const countMap   = new Map(); // 'Y-M' → count
    const minDates   = [];

    for (const r of records) {
      const people = [...r.assistants, ...r.consultants];
      const match  = nameSet
        ? people.some(n => nameSet.has(n))
        : people.length > 0;
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
    totalForDoctor,
    dateRangeForDoctor,
    getMonthSeries,
    getMonthSeriesForPeriod,
    calculateProjection,
    getActiveMonthCount,
    getUnitMonthlySeries,
  };

})();
