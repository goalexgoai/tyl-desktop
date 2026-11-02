/**
 * Cancellation rule (Dustin, 2026-10-29): a user who cancels keeps their paid
 * plan until the period they paid for ends, no matter when they log in; then
 * they move to the free plan and can still send within free limits.
 */
const { createTestServer, createTestUser, loginAs } = require('./helpers');

describe('cancelled subscriptions', () => {
  let app, db, request;
  beforeAll(async () => { ({ app, db, request } = await createTestServer()); });

  async function cancelledUser(email, daysLeft) {
    const u = await createTestUser(db, { email, plan: 'starter' });
    const end = new Date(Date.now() + daysLeft * 864e5).toISOString();
    db.prepare("UPDATE users SET subscription_status = 'cancelled', billing_period_end = ? WHERE email = ?").run(end, email);
    return u;
  }

  test('still inside the paid period → keeps the paid plan', async () => {
    const u = await cancelledUser('inperiod@example.com', 10);
    const cookies = await loginAs(app, request, u);
    const me = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(me.status).toBe(200);
    expect(me.body.plan).toBe('starter');
  });

  test('paid period over → free plan (not blocked)', async () => {
    const u = await cancelledUser('lapsed@example.com', -1);
    const cookies = await loginAs(app, request, u);
    const me = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(me.status).toBe(200);
    expect(me.body.plan).toBe('free');
    const row = db.prepare('SELECT plan, subscription_status FROM users WHERE email = ?').get('lapsed@example.com');
    expect(row).toEqual({ plan: 'free', subscription_status: 'free' });
  });
});
