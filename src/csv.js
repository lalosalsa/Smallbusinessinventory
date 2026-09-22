'use strict';

/**
 * Small, dependency-free CSV reader/writer.
 * Handles quoted fields, embedded commas/newlines, escaped quotes and a BOM.
 */

function parseCsv(text) {
  if (text == null) return [];
  let s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; started = true; continue; }
    if (c === ',') { row.push(field); field = ''; started = true; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; started = false; continue; }
    field += c;
    started = true;
  }
  if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

/** Normalises a header cell so "Pack Size", "pack_size" and "PACKSIZE" all match. */
function normHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s\-.]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

/**
 * Parses CSV into objects keyed by a canonical field name.
 * `aliases` maps canonical name -> list of accepted header spellings.
 * Unmapped columns are kept under their normalised header so nothing is silently lost.
 */
function parseCsvObjects(text, aliases = {}) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], headers: [], unknown: [] };

  const lookup = new Map();
  for (const [canonical, names] of Object.entries(aliases)) {
    lookup.set(normHeader(canonical), canonical);
    for (const n of names) lookup.set(normHeader(n), canonical);
  }

  const rawHeaders = rows[0].map(normHeader);
  const headers = rawHeaders.map((h) => lookup.get(h) || h);
  const unknown = rawHeaders.filter((h) => !lookup.has(h) && h !== '');

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    headers.forEach((h, idx) => {
      if (!h) return;
      obj[h] = (rows[i][idx] ?? '').trim();
    });
    obj.__line = i + 1;
    out.push(obj);
  }
  return { rows: out, headers, unknown };
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Builds a CSV document. `columns` is [{ key, label }] or a list of keys. */
function toCsv(columns, rows) {
  const cols = columns.map((c) => (typeof c === 'string' ? { key: c, label: c } : c));
  const lines = [cols.map((c) => csvCell(c.label)).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c.key])).join(','));
  return lines.join('\r\n') + '\r\n';
}

function num(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|y|yes|t|true)$/i.test(String(value).trim());
}

module.exports = { parseCsv, parseCsvObjects, toCsv, normHeader, num, bool };
