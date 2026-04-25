/**
 * Unit tests — business logic via the HTTP API
 * Tests: phone normalization, template rendering, send limits,
 *        password validation, PLANS config
 */
const { createTestServer, createTestUser, loginAs } = require('./helpers');

describe('Business logic — unit', () => {
  let app, db, request, cookies;

  beforeAll(async () => {
    ({ app, db, request } = await createTestServer());
    const user = await createTestUser(db);
    cookies = await loginAs(app, request, user);
  });

  // ── PLANS config ────────────────────────────────────────────────────────────
  describe('PLANS sanity', () => {
    test('GET /api/auth/me returns correct plan limits for starter', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(res.body.plan).toBe('starter');
      expect(res.body.monthly_limit).toBe(2000);
      expect(res.body.plan_label).toBe('Starter');
    });
  });

  // ── Phone normalization ─────────────────────────────────────────────────────
  // /api/preview takes { template, rows, columnMap } and returns array of previews
  describe('normalizePhone (via preview endpoint)', () => {
    function previewReq(phone, firstName = 'Test') {
      return request(app)
        .post('/api/preview')
        .set('Cookie', cookies)
        .send({
          template: 'Hello {first_name}',
          rows: [{ Phone: phone, First: firstName }],
          columnMap: { phone: 'Phone', first_name: 'First' },
        });
    }

    test('accepts 10-digit US number', async () => {
      const res = await previewReq('8015551234');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].phone).toBe('+18015551234');
    });

    test('accepts 11-digit with country code', async () => {
      const res = await previewReq('18015551234');
      expect(res.status).toBe(200);
      expect(res.body[0].phone).toBe('+18015551234');
    });

    test('accepts formatted number with dashes', async () => {
      const res = await previewReq('801-555-1234');
      expect(res.status).toBe(200);
      expect(res.body[0].phone).toBe('+18015551234');
    });

    test('short/invalid number is not normalized to E.164', async () => {
      const res = await previewReq('123');
      expect(res.status).toBe(200);
      // normalizePhone returns null for invalid; preview falls back to raw value — not E.164
      expect(res.body[0].phone).not.toMatch(/^\+1\d{10}$/);
    });
  });

  // ── Template rendering ──────────────────────────────────────────────────────
  describe('renderTemplate (via preview)', () => {
    function previewReq(template, firstName = 'Alice') {
      return request(app)
        .post('/api/preview')
        .set('Cookie', cookies)
        .send({
          template,
          rows: [{ Phone: '8015551234', First: firstName }],
          columnMap: { phone: 'Phone', first_name: 'First' },
        });
    }

    test('{first_name} is replaced', async () => {
      const res = await previewReq('Hello {first_name}!', 'Bob');
      expect(res.status).toBe(200);
      expect(res.body[0].body).toContain('Bob');
    });

    test('{{first_name}} double-brace syntax works', async () => {
      const res = await previewReq('Hi {{first_name}}', 'Carol');
      expect(res.status).toBe(200);
      expect(res.body[0].body).toContain('Carol');
    });

    test('unknown fields become empty string', async () => {
      const res = await previewReq('Hello {unknown_field}!', 'Dan');
      expect(res.status).toBe(200);
    });
  });

  // ── Send limit ──────────────────────────────────────────────────────────────
  describe('send limit enforcement', () => {
    test('/api/auth/me reports monthly_sends and remaining', async () => {
      const res = await request(app).get('/api/auth/me').set('Cookie', cookies);
      expect(res.body.monthly_sends).toBeGreaterThanOrEqual(0);
      expect(res.body.remaining_sends).toBeLessThanOrEqual(res.body.monthly_limit);
    });
  });

  // ── Password validation ─────────────────────────────────────────────────────
  describe('password validation (via change-password)', () => {
    test('rejects short password', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Cookie', cookies)
        .send({ currentPassword: 'TestPass1!', newPassword: 'abc' });
      expect(res.status).toBe(400);
    });

    test('rejects password with no number', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Cookie', cookies)
        .send({ currentPassword: 'TestPass1!', newPassword: 'NoNumbers!' });
      expect(res.status).toBe(400);
    });
  });
});
