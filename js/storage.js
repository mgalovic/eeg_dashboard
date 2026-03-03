/**
 * storage.js — EEG Dashboard
 *
 * Persists parsed datasets in localStorage so the app works across
 * page reloads without requiring a new file upload.
 *
 * At most MAX_SNAPSHOTS datasets are kept; saving a new one automatically
 * evicts the oldest so storage never fills up.
 *
 * Storage layout:
 *   eeg_index            — JSON array of snapshot IDs (newest first)
 *   eeg_snap_meta_{id}   — lightweight metadata object (fast to list)
 *   eeg_snap_data_{id}   — full parsed records array (serialised JSON)
 */

'use strict';

const Storage = (() => {

  const INDEX_KEY    = 'eeg_index';
  const META_PREFIX  = 'eeg_snap_meta_';
  const DATA_PREFIX  = 'eeg_snap_data_';
  const MAX_SNAPSHOTS = 3;   // keep the 3 most recent uploads


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

  /** Remove a single snapshot's keys without touching the index. */
  function _deleteKeys(id) {
    localStorage.removeItem(META_PREFIX + id);
    localStorage.removeItem(DATA_PREFIX + id);
  }


  /* ── Public API ─────────────────────────────────────────────────── */

  /**
   * Save a parsed dataset and return its snapshot id.
   * If there are already MAX_SNAPSHOTS saved, the oldest is deleted first.
   *
   * @param {{ records, meta }} parsed — output of Parser.parseWorkbook()
   * @param {string}            label  — human-readable name (usually filename)
   * @returns {string} snapshot id
   * @throws if localStorage is unavailable or write fails
   */
  function save(parsed, label) {
    const id  = generateId();
    const now = new Date();
    const { records, meta } = parsed;

    const snapshotMeta = {
      id,
      label:           label || meta.filename || 'Dataset',
      filename:        meta.filename,
      savedAt:         now.toISOString(),
      notes:           '',                         // user-editable note
      validRecords:    meta.validRecords,
      assistantCount:  meta.assistants.length,
      consultantCount: meta.consultants.length,
      allDoctorCount:  meta.allDoctors?.length ?? (meta.assistants.length + meta.consultants.length),
      dateMin:         meta.dateMin?.toISOString() ?? null,
      dateMax:         meta.dateMax?.toISOString() ?? null,
    };

    const serialisedRecords = records.map(r => ({
      date:        r.date.toISOString(),
      assistants:  r.assistants,
      consultants: r.consultants,
      modality:    r.modality || 'EEG',
    }));

    const dataPayload = JSON.stringify({
      meta:    { ...meta, dateMin: meta.dateMin?.toISOString(), dateMax: meta.dateMax?.toISOString() },
      records: serialisedRecords,
    });

    try {
      // Evict oldest snapshots until we are below the cap
      const index = getIndex();
      while (index.length >= MAX_SNAPSHOTS) {
        _deleteKeys(index.pop());          // pop = oldest (index is newest-first)
      }

      localStorage.setItem(META_PREFIX + id, JSON.stringify(snapshotMeta));
      localStorage.setItem(DATA_PREFIX + id, dataPayload);
      index.unshift(id);                   // newest at front
      setIndex(index);
    } catch (e) {
      console.warn('[Storage] Save failed:', e.message);
      throw new Error('Could not save dataset. Browser storage may be unavailable or full.');
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
      modality:    r.modality || 'EEG',   // backward compat with pre-modality snapshots
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
    _deleteKeys(id);
    setIndex(getIndex().filter(i => i !== id));
  }

  /** True if at least one snapshot exists. */
  function hasAny() {
    return getIndex().length > 0;
  }

  /**
   * Return a snapshot-count summary for display.
   * { count, max, label }
   */
  function getUsageSummary() {
    const count = getIndex().length;
    return {
      count,
      max:   MAX_SNAPSHOTS,
      label: `${count} / ${MAX_SNAPSHOTS}`,
    };
  }

  return {
    save, listAll, load, loadLatest,
    getMeta, rename, setNotes, remove,
    hasAny, getUsageSummary,
  };

})();
