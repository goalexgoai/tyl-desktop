// Phone number normalization with an explicit "home country" for numbers
// typed without a country code.
//
// Before v1.0.109 every 10-digit number was assumed to be US and got +1 in
// front, so a French mobile "06 22 92 26 52" became "+10622922652" and was
// sent to an invalid number (seen in real telemetry from a French user). Now
// numbers are parsed with libphonenumber-js against the user's chosen
// country and rejected unless they are a valid number for that country.
const { parsePhoneNumberFromString, getCountries, isSupportedCountry } = require('libphonenumber-js');

const DEFAULT_COUNTRY = 'US';

function resolveCountry(code) {
  const c = String(code || '').trim().toUpperCase();
  return isSupportedCountry(c) ? c : null;
}

// Legacy US rule, kept so a real US/Canada number is never newly rejected
// because the bundled metadata hasn't caught up with a new area code. A NANP
// area code can't start with 0 or 1, which is exactly what blocks the old
// "+1 06..." corruption.
function legacyNanp(digits) {
  if (digits.length === 10 && /^[2-9]/.test(digits)) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1' && /^[2-9]/.test(digits[1])) return '+' + digits;
  return null;
}

// Returns { phone, country, reason }. phone is E.164 or null; reason is a
// short plain-language explanation when phone is null.
function parsePhone(raw, country) {
  const home = resolveCountry(country) || DEFAULT_COUNTRY;
  if (raw == null || String(raw).trim() === '') return { phone: null, country: home, reason: 'No phone number' };
  let s = String(raw).trim();
  // "00" is the international dialing prefix outside North America.
  if (/^00[1-9]/.test(s.replace(/[\s().-]/g, ''))) s = '+' + s.replace(/[\s().-]/g, '').slice(2);
  // Extensions can't be texted; refuse rather than drop them silently.
  if (/(ext\.?|x|#)\s*\d+\s*$/i.test(s)) return { phone: null, country: home, reason: 'Has an extension (texts can only go to mobile numbers)' };

  const parsed = parsePhoneNumberFromString(s, home);
  if (parsed && parsed.isValid()) return { phone: parsed.number, country: parsed.country || home, reason: null };

  if (home === 'US' || home === 'CA') {
    const legacy = legacyNanp(s.replace(/\D/g, ''));
    if (legacy && !s.startsWith('+')) return { phone: legacy, country: home, reason: null };
  }
  const digits = s.replace(/\D/g, '');
  // Old versions read any long digit string as already international
  // ("447911123456" -> +447911123456). Keep that when it isn't a valid local
  // number but is a valid international one.
  if (!s.startsWith('+') && digits.length >= 11) {
    const intl = parsePhoneNumberFromString('+' + digits);
    if (intl && intl.isValid()) return { phone: intl.number, country: intl.country || home, reason: null };
  }
  if (digits.length < 7) return { phone: null, country: home, reason: 'Too short to be a phone number' };
  return {
    phone: null,
    country: home,
    reason: s.startsWith('+')
      ? 'Not a valid number for its country code'
      : `Not a valid ${home} number. If it's from another country, add its country code (like +33 or +44)`,
  };
}

function normalizePhone(raw, country) {
  return parsePhone(raw, country).phone;
}

function countryList() {
  let names = null;
  try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) {}
  return getCountries()
    .map(code => ({ code, name: (names && names.of(code)) || code }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { parsePhone, normalizePhone, resolveCountry, countryList, DEFAULT_COUNTRY };
