const { normalizeCsvBuffer, detectDelimiter, PHONE_COLUMN_RE } = require('../csv-intl');
const { parse } = require('csv-parse/sync');
const rowsOf = (buf) => parse(normalizeCsvBuffer(buf), { columns: true, skip_empty_lines: true, trim: true });
const cp1252 = (s) => Buffer.from([...s].map(c => ({ 'é': 0xe9, 'è': 0xe8, 'ü': 0xfc, 'ñ': 0xf1 }[c] ?? c.charCodeAt(0))));

describe('csv-intl', () => {
  test('comma UTF-8 passes through byte-identical (US files unchanged)', () => {
    const t = 'first_name,phone\nAna,"801-427-3388"\n';
    expect(normalizeCsvBuffer(Buffer.from(t))).toBe(t);
  });
  test('French Excel: semicolons + Windows-1252', () => {
    const r = rowsOf(cp1252('Prénom;Nom;Téléphone\r\nRené;Lefèvre;06 22 92 26 52\r\n'));
    expect(r).toEqual([{ 'Prénom': 'René', Nom: 'Lefèvre', 'Téléphone': '06 22 92 26 52' }]);
  });
  test('UTF-8 BOM stripped from first header', () => {
    const r = rowsOf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Prénom;Portable\nAna;0622922652\n')]));
    expect(Object.keys(r[0])).toEqual(['Prénom', 'Portable']);
  });
  test('UTF-16LE tab-separated (Excel "Unicode text")', () => {
    const body = Buffer.from('Name\tMobile\nJosé\t+34 612 345 678\n', 'utf16le');
    const r = rowsOf(Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
    expect(r).toEqual([{ Name: 'José', Mobile: '+34 612 345 678' }]);
  });
  test('semicolon file with commas inside values survives re-serialization', () => {
    const r = rowsOf(Buffer.from('Nom;Note;Mobile\n"Martin, Ana";"dit ""oui""";06 22 92 26 52\n'));
    expect(r[0]).toEqual({ Nom: 'Martin, Ana', Note: 'dit "oui"', Mobile: '06 22 92 26 52' });
  });
  test('delimiter detection ignores delimiters inside quotes', () => {
    expect(detectDelimiter('"a;b;c",phone\n')).toBe(',');
    expect(detectDelimiter('name;phone\n')).toBe(';');
    expect(detectDelimiter('phone\n')).toBe(',');
  });
  test.each(['Phone', 'Mobile', 'Téléphone', 'Telephone', 'Tél', 'Portable', 'Numéro', 'Handynummer', 'Telefon', 'Teléfono', 'Celular', 'Móvil', 'Cellulare', 'GSM', 'WhatsApp'])(
    'phone column recognized: %s', (h) => expect(PHONE_COLUMN_RE.test(h)).toBe(true));
  test.each(['Prénom', 'Nom', 'Nombre', 'Vorname', 'Email', 'Ville'])(
    'not a phone column: %s', (h) => expect(PHONE_COLUMN_RE.test(h)).toBe(false));
});
