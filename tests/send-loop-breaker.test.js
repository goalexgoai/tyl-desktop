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
