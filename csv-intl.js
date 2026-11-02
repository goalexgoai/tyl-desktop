// Normalizes an uploaded CSV to UTF-8, comma-delimited text so everything
// downstream (job creation, saved lists, previews) can keep parsing it with
// csv-parse defaults.
//
// Real-world non-US files broke uploads (tested 2026-11-02): European Excel
// saves with ';' delimiters, older Excel saves as Windows-1252 (é became �),
// and "Save as Unicode text" is UTF-16 with tabs.
const { parse } = require('csv-parse/sync');

function decodeBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (_) { return new TextDecoder('windows-1252').decode(buf); }
}

// Picks the delimiter from the header line: the most frequent of , ; tab |
// outside quotes. Ties and no-delimiter (single column) fall back to comma.
function detectDelimiter(text) {
  const header = (text.split(/\r?\n/).find(l => l.trim()) || '');
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQuotes = false;
  for (const ch of header) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const d of [';', '\t', '|']) if (counts[d] > counts[best]) best = d;
  return best;
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function normalizeCsvBuffer(buf) {
  const text = decodeBuffer(buf).replace(/^﻿/, '');
  const delimiter = detectDelimiter(text);
  if (delimiter === ',') return text;
  const records = parse(text, { delimiter, skip_empty_lines: true, relax_column_count: true });
  return records.map(r => r.map(csvField).join(',')).join('\n') + '\n';
}

// Phone column names in the languages we're likely to see. Order matters
// only in that the first matching column wins.
const PHONE_COLUMN_RE = /phone|mobile|cell|number|t[ée]l[ée]?phone|\btel\b|\bt[ée]l\.?$|portable|num[ée]ro|handy|telefon|tel[ée]fono|celular|m[oó]vil|movil|cellulare|telemovel|telem[oó]vel|gsm|whats ?app|\bnummer\b|mobil/i;

module.exports = { normalizeCsvBuffer, decodeBuffer, detectDelimiter, PHONE_COLUMN_RE };
