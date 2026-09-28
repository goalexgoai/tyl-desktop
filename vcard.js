// Convert a phone's exported contacts file (vCard / .vcf, from iCloud, Google, Outlook,
// Android, etc.) into the same first_name,last_name,phone CSV format the rest of the
// app already expects — so every downstream feature (lists, templates, sends) needs
// zero changes.

function isVCard(file) {
  if (!file) return false;
  if (file.originalname && /\.vcf$/i.test(file.originalname)) return true;
  if (file.mimetype && /vcard/i.test(file.mimetype)) return true;
  const head = (file.buffer || Buffer.alloc(0))
    .slice(0, 32)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  return /^BEGIN:VCARD/i.test(head);
}

// Unescapes a single vCard value: \\ \; \, \n \N per RFC 6350 §3.4
function unescapeValue(v) {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// Splits on an unescaped delimiter (leaves \<delim> intact as a literal char)
function splitUnescaped(str, delim) {
  const placeholder = '\u0000';
  return str
    .split('\\' + delim)
    .join(placeholder)
    .split(delim)
    .map(s => s.split(placeholder).join(delim));
}

// Undo RFC 6350 §3.2 line folding: a continuation line starts with a space or tab
function unfold(text) {
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function pickBestPhone(tels) {
  const nonFax = tels.filter(t => !t.isFax);
  const pool = nonFax.length ? nonFax : tels;
  const mobile = pool.find(t => t.isMobile);
  return (mobile || pool[0]).value;
}

function nameFromContact(c) {
  let first = '', last = '';
  if (c.n) {
    const parts = splitUnescaped(c.n, ';');
    last = unescapeValue(parts[0] || '').trim();
    first = unescapeValue(parts[1] || '').trim();
  }
  if (!first && !last && c.fn) {
    const fn = unescapeValue(c.fn).trim();
    const sp = fn.indexOf(' ');
    if (sp === -1) first = fn;
    else { first = fn.slice(0, sp); last = fn.slice(sp + 1); }
  }
  return { first, last };
}

// Parses raw vCard text into [{ first_name, last_name, phone }], skipping any
// contact with no usable phone number.
function parseVCard(text) {
  const lines = unfold(text);
  const contacts = [];
  let cur = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^BEGIN:VCARD$/i.test(line)) { cur = { fn: '', n: '', tels: [] }; continue; }
    if (/^END:VCARD$/i.test(line)) { if (cur) contacts.push(cur); cur = null; continue; }
    if (!cur) continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const nameParams = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [nameTokenRaw, ...paramTokens] = nameParams.split(';');
    // Apple exports group related lines under "item1.", "item2." etc — strip it.
    const propName = nameTokenRaw.replace(/^item\d+\./i, '').toUpperCase();
    const paramsStr = paramTokens.join(';');

    if (propName === 'FN') {
      cur.fn = value;
    } else if (propName === 'N') {
      cur.n = value;
    } else if (propName === 'TEL') {
      const v = unescapeValue(value).trim().replace(/^tel:/i, '');
      if (v) {
        cur.tels.push({
          value: v,
          isFax: /FAX/i.test(paramsStr),
          isMobile: /CELL|MOBILE|IPHONE/i.test(paramsStr),
        });
      }
    }
  }

  const rows = [];
  for (const c of contacts) {
    if (!c.tels.length) continue;
    const { first, last } = nameFromContact(c);
    rows.push({ first_name: first, last_name: last, phone: pickBestPhone(c.tels) });
  }
  return rows;
}

function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function rowsToCsv(rows) {
  const lines = rows.map(r => [r.first_name, r.last_name, r.phone].map(csvField).join(','));
  return ['first_name,last_name,phone', ...lines].join('\n') + '\n';
}

// Buffer in, CSV text out. Throws a user-facing message if nothing importable was found.
function vcardBufferToCsv(buffer) {
  const rows = parseVCard(buffer.toString('utf8'));
  if (!rows.length) {
    throw new Error('No contacts with phone numbers were found in this file. Numbers saved as fax-only or missing entirely are skipped.');
  }
  return rowsToCsv(rows);
}

module.exports = { isVCard, parseVCard, vcardBufferToCsv };
