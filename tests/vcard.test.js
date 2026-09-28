/**
 * Unit tests for vcard.js — converting phone contact exports (.vcf) into the
 * same first_name,last_name,phone CSV shape the rest of the app expects.
 */
const { isVCard, parseVCard, vcardBufferToCsv } = require('../vcard');

describe('isVCard', () => {
  test('detects by .vcf extension regardless of mimetype', () => {
    expect(isVCard({ originalname: 'contacts.vcf', mimetype: 'application/octet-stream', buffer: Buffer.from('') })).toBe(true);
  });
  test('detects by vcard mimetype', () => {
    expect(isVCard({ originalname: 'export', mimetype: 'text/x-vcard', buffer: Buffer.from('') })).toBe(true);
  });
  test('detects by content sniff when extension/mimetype are generic', () => {
    expect(isVCard({ originalname: 'export.txt', mimetype: 'text/plain', buffer: Buffer.from('BEGIN:VCARD\nEND:VCARD') })).toBe(true);
  });
  test('a real CSV is not detected as vCard', () => {
    expect(isVCard({ originalname: 'list.csv', mimetype: 'text/csv', buffer: Buffer.from('first_name,phone\nJoe,5551234567') })).toBe(false);
  });
});

describe('parseVCard', () => {
  test('parses a standard v3.0 card with N and TYPE=CELL', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Barrington;Dustin;;;',
      'FN:Dustin Barrington',
      'TEL;TYPE=CELL:801-555-1234',
      'END:VCARD',
    ].join('\r\n');
    const rows = parseVCard(vcf);
    expect(rows).toEqual([{ first_name: 'Dustin', last_name: 'Barrington', phone: '801-555-1234' }]);
  });

  test('falls back to splitting FN when N is absent', () => {
    const vcf = 'BEGIN:VCARD\nFN:Karen Sanders\nTEL:3035551212\nEND:VCARD';
    const rows = parseVCard(vcf);
    expect(rows).toEqual([{ first_name: 'Karen', last_name: 'Sanders', phone: '3035551212' }]);
  });

  test('handles Apple item-grouped properties (itemN. prefix)', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Feliciano;Jennifer;;;',
      'item1.TEL;type=pref:305-555-9876',
      'item1.X-ABLabel:iPhone',
      'END:VCARD',
    ].join('\n');
    const rows = parseVCard(vcf);
    expect(rows).toEqual([{ first_name: 'Jennifer', last_name: 'Feliciano', phone: '305-555-9876' }]);
  });

  test('unfolds a continuation line split with a leading space', () => {
    const vcf = 'BEGIN:VCARD\nN:Sanders;Ka\n ren;;;\nTEL:3035551212\nEND:VCARD';
    const rows = parseVCard(vcf);
    expect(rows[0].first_name).toBe('Karen');
  });

  test('strips a v4.0 tel: URI prefix', () => {
    const vcf = 'BEGIN:VCARD\nVERSION:4.0\nFN:Kathy Nesper\nTEL;VALUE=uri;TYPE=cell:tel:+15551112222\nEND:VCARD';
    const rows = parseVCard(vcf);
    expect(rows[0].phone).toBe('+15551112222');
  });

  test('prefers a CELL/MOBILE number over other numbers on the same contact', () => {
    const vcf = [
      'BEGIN:VCARD',
      'FN:Multi Number',
      'TEL;TYPE=WORK,VOICE:801-555-0001',
      'TEL;TYPE=CELL:801-555-0002',
      'END:VCARD',
    ].join('\n');
    const rows = parseVCard(vcf);
    expect(rows[0].phone).toBe('801-555-0002');
  });

  test('skips a fax-only number in favor of any other number', () => {
    const vcf = [
      'BEGIN:VCARD',
      'FN:Fax And Voice',
      'TEL;TYPE=FAX:801-555-0003',
      'TEL;TYPE=HOME:801-555-0004',
      'END:VCARD',
    ].join('\n');
    const rows = parseVCard(vcf);
    expect(rows[0].phone).toBe('801-555-0004');
  });

  test('skips a contact with no phone number at all', () => {
    const vcf = 'BEGIN:VCARD\nFN:No Phone Person\nEMAIL:nobody@example.com\nEND:VCARD';
    expect(parseVCard(vcf)).toEqual([]);
  });

  test('parses multiple contacts in one file', () => {
    const vcf = [
      'BEGIN:VCARD', 'FN:First One', 'TEL:1111111111', 'END:VCARD',
      'BEGIN:VCARD', 'FN:Second One', 'TEL:2222222222', 'END:VCARD',
    ].join('\n');
    const rows = parseVCard(vcf);
    expect(rows.map(r => r.phone)).toEqual(['1111111111', '2222222222']);
  });

  test('unescapes commas, semicolons and backslashes in names', () => {
    const vcf = 'BEGIN:VCARD\nN:Smith\\, Jr.;John;;;\nTEL:5555555555\nEND:VCARD';
    const rows = parseVCard(vcf);
    expect(rows[0].last_name).toBe('Smith, Jr.');
  });
});

describe('vcardBufferToCsv', () => {
  test('produces CSV text the existing csv-parse pipeline can read', () => {
    const vcf = 'BEGIN:VCARD\nN:Barrington;Dustin;;;\nTEL:8015551234\nEND:VCARD';
    const csv = vcardBufferToCsv(Buffer.from(vcf));
    expect(csv).toBe('first_name,last_name,phone\nDustin,Barrington,8015551234\n');
  });

  test('quotes a field containing a comma', () => {
    const vcf = 'BEGIN:VCARD\nN:;Jo\\, Ann;;;\nTEL:8015551234\nEND:VCARD';
    const csv = vcardBufferToCsv(Buffer.from(vcf));
    expect(csv).toContain('"Jo, Ann"');
  });

  test('throws a friendly error when no contact has a phone number', () => {
    const vcf = 'BEGIN:VCARD\nFN:Ghost Contact\nEND:VCARD';
    expect(() => vcardBufferToCsv(Buffer.from(vcf))).toThrow(/No contacts with phone numbers/);
  });
});
