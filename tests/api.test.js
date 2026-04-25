/**
 * Integration tests — full API flows
 * Tests: auth, templates, suppression, contact lists, jobs, API keys, health
 */
const { createTestServer, createTestUser, loginAs } = require('./helpers');

describe('API integration', () => {
  let app, db, request, cookies;

  beforeAll(async () => {
    ({ app, db, request } = await createTestServer());
    // Pro plan so templates are allowed
    const user = await createTestUser(db, { plan: 'pro' });
    cookies = await loginAs(app, request, user);
  });

  // ── Health ──────────────────────────────────────────────────────────────────
  describe('Health', () => {
    test('GET /health → 200 ok:true', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── Auth ────────────────────────────────────────────────────────────────────
  describe('Auth', () => {
    test('unauthenticated /api/auth/me → 401', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    test('authenticated /api/auth/me → 200 with email', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe('test@example.com');
      expect(res.body.plan).toBe('pro');
    });

    test('logout → 200, session cleared', async () => {
      const { email, password } = await createTestUser(db, { email: 'logout@example.com' });
      const c = await loginAs(app, request, { email, password });
      const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', c);
      expect(logoutRes.status).toBe(200);
      const meRes = await request(app).get('/api/auth/me').set('Cookie', c);
      expect(meRes.status).toBe(401);
    });

    test('wrong password → 4xx or 503 (web unavailable in test env)', async () => {
      // In tests TYL_WEB_URL is unreachable; wrong password offline grace fails → 503
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@example.com', password: 'WrongPass99!' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ── Templates ───────────────────────────────────────────────────────────────
  describe('Templates CRUD', () => {
    let templateId;

    test('GET /api/templates → 200 array', async () => {
      const res = await request(app).get('/api/templates').set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('POST /api/templates → 201 creates template', async () => {
      const res = await request(app)
        .post('/api/templates')
        .set('Cookie', cookies)
        .send({ name: 'Birthday', body: 'Happy birthday {first_name}!' });
      expect(res.status).toBe(201);
      expect(res.body.id).toBeTruthy();
      templateId = res.body.id;
    });

    test('GET /api/templates → includes created template', async () => {
      const res = await request(app).get('/api/templates').set('Cookie', cookies);
      expect(res.body.some(t => t.id === templateId)).toBe(true);
    });

    test('PATCH /api/templates/:id → updates template', async () => {
      const res = await request(app)
        .patch(`/api/templates/${templateId}`)
        .set('Cookie', cookies)
        .send({ name: 'Updated', body: 'Hi {first_name}' });
      expect(res.status).toBe(200);
    });

    test('DELETE /api/templates/:id → removes template', async () => {
      const res = await request(app)
        .delete(`/api/templates/${templateId}`)
        .set('Cookie', cookies);
      expect(res.status).toBe(200);
      const listRes = await request(app).get('/api/templates').set('Cookie', cookies);
      expect(listRes.body.some(t => t.id === templateId)).toBe(false);
    });
  });

  // ── Suppression list ────────────────────────────────────────────────────────
  describe('Suppression list', () => {
    const testPhone = '+18015559999';

    test('GET /api/suppression → 200 array', async () => {
      const res = await request(app).get('/api/suppression').set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('POST /api/suppression → 201 adds number', async () => {
      const res = await request(app)
        .post('/api/suppression')
        .set('Cookie', cookies)
        .send({ phone: testPhone });
      expect(res.status).toBe(201);
    });

    test('GET /api/suppression → includes added number', async () => {
      const res = await request(app).get('/api/suppression').set('Cookie', cookies);
      expect(res.body.some(s => s.phone === testPhone)).toBe(true);
    });

    test('DELETE /api/suppression/:phone → removes number', async () => {
      const res = await request(app)
        .delete(`/api/suppression/${encodeURIComponent(testPhone)}`)
        .set('Cookie', cookies);
      expect(res.status).toBe(200);
    });
  });

  // ── Contact lists ───────────────────────────────────────────────────────────
  describe('Contact lists', () => {
    let listId;
    const csvData = 'First,Phone\nAlice,8015551111\nBob,8015552222';
    const columns = ['First', 'Phone'];

    test('GET /api/lists → 200 array', async () => {
      const res = await request(app).get('/api/lists').set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('POST /api/lists → 201 creates list', async () => {
      const res = await request(app)
        .post('/api/lists')
        .set('Cookie', cookies)
        .send({ name: 'Test List', csv_data: csvData, columns, row_count: 2 });
      expect(res.status).toBe(201);
      expect(res.body.id).toBeTruthy();
      listId = res.body.id;
    });

    test('GET /api/lists/:id → returns list', async () => {
      const res = await request(app)
        .get(`/api/lists/${listId}`)
        .set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(listId);
    });

    test('PATCH /api/lists/:id/rename → renames list', async () => {
      const res = await request(app)
        .patch(`/api/lists/${listId}/rename`)
        .set('Cookie', cookies)
        .send({ name: 'Renamed List' });
      expect(res.status).toBe(200);
    });

    test('DELETE /api/lists/:id → removes list', async () => {
      const res = await request(app)
        .delete(`/api/lists/${listId}`)
        .set('Cookie', cookies);
      expect(res.status).toBe(200);
    });
  });

  // ── Jobs ────────────────────────────────────────────────────────────────────
  describe('Jobs', () => {
    let jobId;

    test('GET /api/jobs → 200 array', async () => {
      const res = await request(app).get('/api/jobs').set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('POST /api/jobs → 201 creates send job', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', cookies)
        .send({
          name: 'Test Campaign',
          template: 'Hello {first_name}!',
          rows: [{ First: 'Test', Phone: '8015550001' }],
          columnMap: { phone: 'Phone', first_name: 'First' },
          paceSeconds: 10,
        });
      expect(res.status).toBe(201);
      expect(res.body.job_id).toBeTruthy();
      jobId = res.body.job_id;
    });

    test('GET /api/jobs returns created job', async () => {
      const res = await request(app).get('/api/jobs').set('Cookie', cookies);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });

  // ── API keys ────────────────────────────────────────────────────────────────
  describe('API keys', () => {
    let keyId;

    test('GET /api/keys → 200 array', async () => {
      const res = await request(app).get('/api/keys').set('Cookie', cookies);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('POST /api/keys → 201 creates key', async () => {
      const res = await request(app)
        .post('/api/keys')
        .set('Cookie', cookies)
        .send({ name: 'Test Key' });
      expect(res.status).toBe(201);
      expect(res.body.key).toBeTruthy();
      // Retrieve the id via GET since POST doesn't return it
      const listRes = await request(app).get('/api/keys').set('Cookie', cookies);
      const found = listRes.body.find(k => k.name === 'Test Key');
      expect(found).toBeTruthy();
      keyId = found.id;
    });

    test('DELETE /api/keys/:id → removes key', async () => {
      const res = await request(app)
        .delete(`/api/keys/${keyId}`)
        .set('Cookie', cookies);
      expect(res.status).toBe(200);
    });
  });

  // ── Data persistence ────────────────────────────────────────────────────────
  describe('Data persistence', () => {
    test('created data survives across requests within session', async () => {
      await request(app).post('/api/templates').set('Cookie', cookies)
        .send({ name: 'Persist Test', body: 'Checking persistence' });
      const res = await request(app).get('/api/templates').set('Cookie', cookies);
      expect(res.body.some(t => t.name === 'Persist Test')).toBe(true);
    });
  });
});
