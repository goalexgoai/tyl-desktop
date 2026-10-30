/**
 * Send-loop circuit breaker: one root cause hitting every message must pause
 * the job after a few attempts instead of failing the whole list (field data:
 * 537 identical failures on one customer's list). Mixed/unique errors and a
 * success in between must NOT trip it.
 */
jest.mock('../send-windows.js', () => jest.fn());
jest.mock('../send-mac.js', () => jest.fn());

const os = require('os');
const path = require('path');
const fs = require('fs');
const { createTestUser } = require('./helpers');

let db, app, sendFn, userId;
const PARSE_ERR = "At C:\\Users\\x\\AppData\\Local\\Temp\\textyourlist-1.ps1:237 char:103\r\n+ ... Catarina's\r\nMissing ')' in method call.\r\n    + FullyQualifiedErrorId : MissingEndParenthesisInMethodCall";

beforeAll(async () => {
  // Don't let the real 5s poll loops run; the test drives the loop directly.
  jest.spyOn(global, 'setInterval').mockImplementation(() => ({ unref() {}, ref() {} }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyl-loop-'));
  Object.assign(process.env, {
    TYL_DB_PATH: path.join(dir, 'tyl.db'),
    TYL_DATA_DIR: dir,
    TYL_WEB_URL: 'http://127.0.0.1:19743',
    DESKTOP_LICENSE_SECRET: 'test-secret',
    SESSION_SECRET: 'test-session-secret',
    TYL_DESKTOP: 'test', // truthy enables the send loop; not '1', so no port is bound
  });
  ({ app, db } = require('../server'));
  await createTestUser(db, { email: 'loop@example.com' });
  userId = db.prepare("SELECT id FROM users WHERE email = 'loop@example.com'").get().id;
  sendFn = process.platform === 'darwin' ? require('../send-mac.js') : require('../send-windows.js');
});

afterAll(() => { delete process.env.TYL_DESKTOP; });

let jobSeq = 0;
function makeJob(n) {
  const jobId = `job-${++jobSeq}`;
  db.prepare("UPDATE jobs SET status='completed' WHERE status='queued'").run();
  db.prepare("INSERT INTO jobs (id, user_id, name, template, status, pace_seconds, total) VALUES (?, ?, 'T', 'hi', 'queued', 0, ?)").run(jobId, userId, n);
  for (let i = 0; i < n; i++) {
    db.prepare("INSERT INTO messages (id, job_id, phone, body, status, created_at) VALUES (?, ?, ?, 'hi', 'pending', datetime('now', ?))")
      .run(`${jobId}-m${i}`, jobId, `+1555000${1000 + i}`, `+${i} seconds`);
  }
  return jobId;
}
async function runLoop(times) { for (let i = 0; i < times; i++) await app.locals.desktopSendLoop(); }
const statuses = (jobId) => db.prepare('SELECT status FROM messages WHERE job_id = ? ORDER BY created_at').all(jobId).map(r => r.status);

test('send loop is exposed when running as desktop', () => {
  expect(typeof app.locals.desktopSendLoop).toBe('function');
});

test('3 identical failures in a row pause the job and requeue those messages', async () => {
  sendFn.mockReset().mockRejectedValue(new Error(PARSE_ERR));
  const jobId = makeJob(10);
  await runLoop(6);
  expect(sendFn).toHaveBeenCalledTimes(3);
  expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('paused');
  expect(statuses(jobId).every(s => s === 'pending')).toBe(true);
  const errs = db.prepare("SELECT error FROM messages WHERE job_id = ? AND error IS NOT NULL").all(jobId).map(r => r.error);
  expect(errs.some(e => /sending paused after 3 failures in a row/i.test(e))).toBe(true);
  // User-facing text never contains the raw PowerShell dump
  expect(errs.some(e => /char:103|FullyQualifiedErrorId/.test(e))).toBe(false);
});

test('a success between failures resets the streak', async () => {
  sendFn.mockReset()
    .mockRejectedValueOnce(new Error("Recipient field not found\r\nAt C:\\a.ps1:1"))
    .mockRejectedValueOnce(new Error("Recipient field not found\r\nAt C:\\b.ps1:2"))
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce(new Error("Recipient field not found\r\nAt C:\\c.ps1:3"))
    .mockResolvedValue(true);
  const jobId = makeJob(5);
  await runLoop(5);
  expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('completed');
  expect(statuses(jobId).filter(s => s === 'failed')).toHaveLength(3);
});

test('different errors do not trip the breaker', async () => {
  sendFn.mockReset()
    .mockRejectedValueOnce(new Error('Recipient field not found'))
    .mockRejectedValueOnce(new Error('Message field not found'))
    .mockRejectedValueOnce(new Error(PARSE_ERR))
    .mockResolvedValue(true);
  const jobId = makeJob(4);
  await runLoop(4);
  expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('completed');
});

test('paused job detail exposes pause_reason', async () => {
  sendFn.mockReset().mockRejectedValue(new Error(PARSE_ERR));
  const jobId = makeJob(4);
  await runLoop(3);
  const agent = require('supertest').agent(app);
  await agent.post('/api/auth/login').send({ email: 'loop@example.com', password: 'TestPass1!' });
  const res = await agent.get(`/api/jobs/${jobId}`);
  expect(res.status).toBe(200);
  expect(res.body.pause_reason).toMatch(/Update Text Your List to the latest version/);
});

test('Phone Link setup problem pauses a bulk job on the first failure', async () => {
  sendFn.mockReset().mockRejectedValue(new Error("Phone Link pairing incomplete\r\nAt C:\\x.ps1:1"));
  const jobId = makeJob(5);
  await runLoop(3);
  expect(sendFn).toHaveBeenCalledTimes(1);
  expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('paused');
  expect(statuses(jobId).every(s => s === 'pending')).toBe(true);
  const err = db.prepare("SELECT error FROM messages WHERE job_id = ? AND error IS NOT NULL").get(jobId).error;
  expect(err).toMatch(/Try Bluetooth pairing again/);
});

test('Phone Link setup problem on a test send fails it instead of pausing', async () => {
  sendFn.mockReset().mockRejectedValue(new Error('Phone Link not set up: no phone connected'));
  const jobId = makeJob(1);
  db.prepare('UPDATE jobs SET is_test = 1 WHERE id = ?').run(jobId);
  await runLoop(2);
  expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('completed');
  expect(db.prepare('SELECT error FROM messages WHERE job_id = ?').get(jobId).error).toMatch(/isn't connected to your phone yet/);
});

describe('delivery reconciler (unconfirmed-send follow-up)', () => {
  // The reconciler's query is portfolio-wide by design (it has to catch up
  // leftovers from a crash/restart too), so it isn't scoped to one job/test.
  // Clear any unconfirmed rows a prior test in this file left behind so each
  // reconciler test sees exactly the row it created.
  beforeEach(() => {
    db.prepare("DELETE FROM messages WHERE status = 'unconfirmed'").run();
  });

  test('a timed-out-but-not-thrown send is recorded unconfirmed, not silently "sent"', async () => {
    sendFn.mockReset().mockResolvedValue({ confirmed: false, chatBeforeRowId: 555, chatService: 'SMS' });
    const jobId = makeJob(1);
    await runLoop(1);
    const msg = db.prepare('SELECT * FROM messages WHERE job_id = ?').get(jobId);
    expect(msg.status).toBe('unconfirmed');
    expect(msg.chat_before_rowid).toBe(555);
    expect(msg.chat_service).toBe('SMS');
    // The job itself is done sending (nothing left pending/sending) even though
    // this message's delivery outcome is still open — that's the reconciler's job.
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('completed');
  });

  test('legacy resolve shape ({} or true, e.g. Windows) is still treated as confirmed sent', async () => {
    sendFn.mockReset().mockResolvedValue(true);
    const jobId = makeJob(1);
    await runLoop(1);
    expect(db.prepare('SELECT status FROM messages WHERE job_id = ?').get(jobId).status).toBe('sent');
  });

  test('reconciler finalizes an unconfirmed message once chat.db settles', async () => {
    sendFn.mockReset().mockResolvedValue({ confirmed: false, chatBeforeRowId: 777, chatService: 'SMS' });
    sendFn.canReadChatDb = jest.fn().mockReturnValue(true);
    sendFn.checkDeliveryOnce = jest.fn()
      .mockReturnValueOnce('pending')   // first tick: still nothing — must NOT change status
      .mockReturnValueOnce('delivered'); // second tick: now confirmed
    const jobId = makeJob(1);
    await runLoop(1);
    const msgId = db.prepare('SELECT id FROM messages WHERE job_id = ?').get(jobId).id;

    await app.locals.reconcileUnconfirmedDeliveries();
    expect(db.prepare('SELECT status FROM messages WHERE id = ?').get(msgId).status).toBe('unconfirmed');

    await app.locals.reconcileUnconfirmedDeliveries();
    expect(db.prepare('SELECT status FROM messages WHERE id = ?').get(msgId).status).toBe('sent');
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status).toBe('completed');

    delete sendFn.canReadChatDb;
    delete sendFn.checkDeliveryOnce;
  });

  test('reconciler moves an unconfirmed message to failed when chat.db later reports an error', async () => {
    sendFn.mockReset().mockResolvedValue({ confirmed: false, chatBeforeRowId: 888, chatService: 'SMS' });
    sendFn.canReadChatDb = jest.fn().mockReturnValue(true);
    sendFn.checkDeliveryOnce = jest.fn().mockReturnValue('error');
    const jobId = makeJob(1);
    await runLoop(1);
    const msgId = db.prepare('SELECT id FROM messages WHERE job_id = ?').get(jobId).id;

    await app.locals.reconcileUnconfirmedDeliveries();
    const msg = db.prepare('SELECT status, error FROM messages WHERE id = ?').get(msgId);
    expect(msg.status).toBe('failed');
    expect(msg.error).toMatch(/didn't go through/i);

    delete sendFn.canReadChatDb;
    delete sendFn.checkDeliveryOnce;
  });

  test('a db_error probe leaves the message unconfirmed instead of guessing an outcome', async () => {
    sendFn.mockReset().mockResolvedValue({ confirmed: false, chatBeforeRowId: 999, chatService: 'SMS' });
    sendFn.canReadChatDb = jest.fn().mockReturnValue(true);
    sendFn.checkDeliveryOnce = jest.fn().mockReturnValue('db_error');
    const jobId = makeJob(1);
    await runLoop(1);
    const msgId = db.prepare('SELECT id FROM messages WHERE job_id = ?').get(jobId).id;

    await app.locals.reconcileUnconfirmedDeliveries();
    expect(db.prepare('SELECT status FROM messages WHERE id = ?').get(msgId).status).toBe('unconfirmed');

    delete sendFn.canReadChatDb;
    delete sendFn.checkDeliveryOnce;
  });

  test('SMS gets a longer reconcile window than iMessage: a 20-min-old SMS row is still reconciled', async () => {
    sendFn.mockReset().mockResolvedValue({ confirmed: false, chatBeforeRowId: 222, chatService: 'SMS' });
    sendFn.canReadChatDb = jest.fn().mockReturnValue(true);
    sendFn.checkDeliveryOnce = jest.fn().mockReturnValue('delivered');
    const jobId = makeJob(1);
    await runLoop(1);
    const msgId = db.prepare('SELECT id FROM messages WHERE job_id = ?').get(jobId).id;
    // Past the old flat 10-minute window, but within SMS's wider 45-minute one.
    db.prepare("UPDATE messages SET sent_at = datetime('now', '-20 minutes') WHERE id = ?").run(msgId);

    await app.locals.reconcileUnconfirmedDeliveries();
    expect(db.prepare('SELECT status FROM messages WHERE id = ?').get(msgId).status).toBe('sent');

    delete sendFn.canReadChatDb;
    delete sendFn.checkDeliveryOnce;
  });

  test('iMessage keeps the original 10-minute window: a 20-min-old iMessage row is left unconfirmed, never probed', async () => {
    sendFn.mockReset().mockResolvedValue({ confirmed: false, chatBeforeRowId: 333, chatService: 'iMessage' });
    sendFn.canReadChatDb = jest.fn().mockReturnValue(true);
    sendFn.checkDeliveryOnce = jest.fn().mockReturnValue('delivered');
    const jobId = makeJob(1);
    await runLoop(1);
    const msgId = db.prepare('SELECT id FROM messages WHERE job_id = ?').get(jobId).id;
    db.prepare("UPDATE messages SET sent_at = datetime('now', '-20 minutes') WHERE id = ?").run(msgId);

    await app.locals.reconcileUnconfirmedDeliveries();
    expect(db.prepare('SELECT status FROM messages WHERE id = ?').get(msgId).status).toBe('unconfirmed');
    expect(sendFn.checkDeliveryOnce).not.toHaveBeenCalled();

    delete sendFn.canReadChatDb;
    delete sendFn.checkDeliveryOnce;
  });

  test('reconciler is a no-op when the active sendFn has no reconciliation capability (e.g. Windows)', async () => {
    sendFn.mockReset().mockResolvedValue({ confirmed: false, chatBeforeRowId: 111, chatService: 'SMS' });
    // Deliberately NOT attaching canReadChatDb/checkDeliveryOnce to sendFn here.
    const jobId = makeJob(1);
    await runLoop(1);
    const msgId = db.prepare('SELECT id FROM messages WHERE job_id = ?').get(jobId).id;

    await expect(app.locals.reconcileUnconfirmedDeliveries()).resolves.toBeUndefined();
    expect(db.prepare('SELECT status FROM messages WHERE id = ?').get(msgId).status).toBe('unconfirmed');
  });
});
