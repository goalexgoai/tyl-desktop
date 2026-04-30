/**
 * Agent API tests — GET /api/make/lists, GET /api/make/templates, POST /api/make/send-to-list
 */
const { createTestServer, createTestUser, loginAs } = require('./helpers');

const SAMPLE_CSV = `Phone,First,Last
3853499001,Alice,Smith
3853499002,Bob,Jones
not-a-phone,Carol,Bad
3853499001,Alice,Dupe`;

describe('Agent API (/api/make/*)', () => {
  let app, db, request, apiKey;

  beforeAll(async () => {
    ({ app, db, request } = await createTestServer());
    // Pro user so api_send is enabled
    const user = await createTestUser(db, { plan: 'pro' });
    const cookies = await loginAs(app, request, user);

    // Create an API key via the session-auth endpoint
    const keyRes = await request(app)
      .post('/api/keys')
      .set('Cookie', cookies)
      .send({ name: 'Test Agent Key' });
    apiKey = keyRes.body.key;

    // Seed a contact list
    await request(app)
      .post('/api/lists')
      .set('Cookie', cookies)
      .send({ name: 'April Leads', csv_data: SAMPLE_CSV, columns: JSON.stringify(['Phone', 'First', 'Last']), row_count: 4 });

    // Seed a template
    await request(app)
      .post('/api/templates')
      .set('Cookie', cookies)
      .send({ name: 'Follow Up', body: 'Hey {First}, just following up!' });
  });

  // ── Auth guard ────────────────────────────────────────────────────────────
  test('no API key → 401', async () => {
    const res = await request(app).get('/api/make/lists');
    expect(res.status).toBe(401);
  });

  // ── GET /api/make/lists ───────────────────────────────────────────────────
  describe('GET /api/make/lists', () => {
    test('returns list of contact lists', async () => {
      const res = await request(app)
        .get('/api/make/lists')
        .set('Authorization', `Bearer ${apiKey}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some(l => l.name === 'April Leads')).toBe(true);
      expect(res.body[0]).toHaveProperty('id');
      expect(res.body[0]).toHaveProperty('row_count');
    });
  });

  // ── GET /api/make/templates ───────────────────────────────────────────────
  describe('GET /api/make/templates', () => {
    test('returns list of templates with preview', async () => {
      const res = await request(app)
        .get('/api/make/templates')
        .set('Authorization', `Bearer ${apiKey}`);
      expect(res.status).toBe(200);
      expect(res.body.some(t => t.name === 'Follow Up')).toBe(true);
      expect(res.body[0]).toHaveProperty('preview');
    });
  });

  // ── POST /api/make/send-to-list ───────────────────────────────────────────
  describe('POST /api/make/send-to-list', () => {
    test('missing list → 400', async () => {
      const res = await request(app)
        .post('/api/make/send-to-list')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ template: 'Hello' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/list_id or list_name/);
    });

    test('missing template → 400', async () => {
      const res = await request(app)
        .post('/api/make/send-to-list')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ list_name: 'April Leads' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/template/);
    });

    test('unknown list name → 404 with helpful message', async () => {
      const res = await request(app)
        .post('/api/make/send-to-list')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ list_name: 'Nonexistent', template: 'Hello' });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/api\/make\/lists/);
    });

    test('send by list_name + inline template → job created, held for review', async () => {
      const res = await request(app)
        .post('/api/make/send-to-list')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ list_name: 'April Leads', template: 'Hi {First}!', pace_seconds: -1 });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('api_pending');
      expect(res.body.queued).toBe(2);           // 4 rows: 1 invalid phone, 1 duplicate = 2 valid
      expect(res.body.skipped_invalid).toBe(1);
      expect(res.body.skipped_duplicate).toBe(1);
      expect(res.body.job_id).toBeTruthy();
    });

    test('send by list_name + template_name → job queued immediately', async () => {
      const res = await request(app)
        .post('/api/make/send-to-list')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ list_name: 'April Leads', template_name: 'Follow Up', pace_seconds: 0 });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('queued');
      expect(res.body.queued).toBe(2);
    });

    test('custom campaign_name is reflected in response', async () => {
      const res = await request(app)
        .post('/api/make/send-to-list')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ list_name: 'April Leads', template: 'Hey!', campaign_name: 'Spring Blast', pace_seconds: -1 });
      expect(res.status).toBe(201);
      expect(res.body.campaign_name).toBe('Spring Blast');
    });

    test('unknown template_name → 404 with helpful message', async () => {
      const res = await request(app)
        .post('/api/make/send-to-list')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ list_name: 'April Leads', template_name: 'Ghost Template' });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/api\/make\/templates/);
    });
  });
});
