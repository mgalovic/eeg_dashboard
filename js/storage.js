/**
 * storage.js — EEG Dashboard
 *
 * Persists parsed datasets in localStorage so the app works across
 * page reloads without requiring a new file upload.
 *
 * Storage layout:
 *   eeg_index            — JSON array of snapshot IDs (newest first)
 *   eeg_snap_meta_{id}   — lightweight metadata object (fast to list)
 *   eeg_snap_data_{id}   — full parsed records array (serialised JSON)
 */

'use strict';

const Storage = (() => {

  const INDEX_KEY   = 'eeg_index';
  const META_PREFIX = 'eeg_snap_meta_';
  const DATA_PREFIX = 'eeg_snap_data_';

  const WARN_BYTES  = 4   * 1024 * 1024;   // 4 MB  — show usage warning
  const LIMIT_BYTES = 4.8 * 1024 * 1024;   // 4.8 MB — block new saves


  /* ── Private helpers ────────────────────────────────────────────── */

  function getIndex() {
    try   { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); }
    catch { return []; }
  }

  function setIndex(ids) {
    localStorage.setItem(INDEX_KEY, JSON.stringify(ids));
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** Approximate localStorage usage in bytes (UTF-16 × 2). */
  function _estimateBytes() {
    let n = 0;
    for (const k of Object.keys(localStorage)) {
      n += (k.length + (localStorage.getItem(k) ?? '').length) * 2;
    }
    return n;
  }


  /* ── Public API ─────────────────────────────────────────────────── */

  /**
   * Save a parsed dataset and return its snapshot id.
   *
   * @param {{ records, meta }} parsed — output of Parser.parseWorkbook()
   * @param {string}            label  — human-readable name (usually filename)
   * @returns {string} snapshot id
   * @throws if localStorage is full
   */
  function save(parsed, label) {
    const id  = generateId();
    const now = new Date();
    const { records, meta } = parsed;

    // Check space before writing
    if (_estimateBytes() > LIMIT_BYTES) {
      throw new Error('Storage is nearly full. Please delete an old dataset first.');
    }

    const snapshotMeta = {
      id,
      label:          label || meta.filename || 'Dataset',
      filename:       meta.filename,
      savedAt:        now.toISOString(),
      notes:          '',                         // user-editable note
      validRecords:   meta.validRecords,
      assistantCount: meta.assistants.length,
      consultantCount:meta.consultants.length,
      allDoctorCount: meta.allDoctors?.length ?? (meta.assistants.length + meta.consultants.length),
      dateMin:        meta.dateMin?.toISOString() ?? null,
      dateMax:        meta.dateMax?.toISOString() ?? null,
    };

    const serialisedRecords = records.map(r => ({
      date:        r.date.toISOString(),
      assistants:  r.assistants,
      consultants: r.consultants,
    }));

    const dataPayload = JSON.stringify({
      meta:    { ...meta, dateMin: meta.dateMin?.toISOString(), dateMax: meta.dateMax?.toISOString() },
      records: serialisedRecords,
    });

    try {
      localStorage.setItem(META_PREFIX + id, JSON.stringify(snapshotMeta));
      localStorage.setItem(DATA_PREFIX + id, dataPayload);
      const index = getIndex();
      index.unshift(id);
      setIndex(index);
    } catch (e) {
      console.warn('[Storage] Save failed:', e.message);
      throw new Error('Storage is full. Please delete an old dataset and try again.');
    }

    return id;
  }

  /**
   * Return metadata for all saved snapshots (newest first).
   */
  function listAll() {
    return getIndex()
      .map(id => {
        try   { return JSON.parse(localStorage.getItem(META_PREFIX + id)); }
        catch { return null; }
      })
      .filter(Boolean);
  }

  /**
   * Load a full snapshot (records + meta) by id.
   * Re-hydrates ISO date strings back to Date objects.
   * Returns null if not found or corrupt.
   */
  function load(id) {
    const raw = localStorage.getItem(DATA_PREFIX + id);
    if (!raw) return null;
    let payload;
    try   { payload = JSON.parse(raw); }
    catch { return null; }

    const records = payload.records.map(r => ({
      date:        new Date(r.date),
      assistants:  r.assistants,
      consultants: r.consultants,
    }));

    const meta = {
      ...payload.meta,
      dateMin: payload.meta.dateMin ? new Date(payload.meta.dateMin) : null,
      dateMax: payload.meta.dateMax ? new Date(payload.meta.dateMax) : null,
    };

    return { records, meta };
  }

  /**
   * Load the most recently saved snapshot, or null if none exist.
   */
  function loadLatest() {
    const index = getIndex();
    return index.length ? load(index[0]) : null;
  }

  /**
   * Return the metadata object for a single snapshot (no record hydration).
   */
  function getMeta(id) {
    try   { return JSON.parse(localStorage.getItem(META_PREFIX + id)); }
    catch { return null; }
  }

  /**
   * Rename a snapshot's display label.
   */
  function rename(id, newLabel) {
    const meta = getMeta(id);
    if (!meta) return;
    meta.label = newLabel.trim() || meta.label;
    localStorage.setItem(META_PREFIX + id, JSON.stringify(meta));
  }

  /**
   * Save a free-text note against a snapshot (visible in the dataset switcher).
   */
  function setNotes(id, text) {
    const meta = getMeta(id);
    if (!meta) return;
    meta.notes = (text ?? '').trim();
    localStorage.setItem(META_PREFIX + id, JSON.stringify(meta));
  }

  /**
   * Delete a snapshot (both meta and data keys) and remove from index.
   */
  function remove(id) {
    localStorage.removeItem(META_PREFIX + id);
    localStorage.removeItem(DATA_PREFIX + id);
    setIndex(getIndex().filter(i => i !== id));
  }

  /** True if at least one snapshot exists. */
  function hasAny() {
    return getIndex().length > 0;
  }

  /**
   * Return a storage usage summary suitable for display.
   * { bytes, label, nearLimit, overLimit }
   */
  function getUsageSummary() {
    const bytes = _estimateBytes();
    const mb    = bytes / (1024 * 1024);
    const label = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
    return {
      bytes,
      label,
      nearLimit: bytes > WARN_BYTES,
      overLimit: bytes > LIMIT_BYTES,
    };
  }

  return {
    save, listAll, load, loadLatest,
    getMeta, rename, setNotes, remove,
    hasAny, getUsageSummary,
  };

})();
