#!/usr/bin/env node
/**
 * Text Your List Windows Companion Sender
 *
 * Polls the Text Your List server for pending messages and sends them
 * via Android Messages for Web using Playwright (headless Chromium).
 *
 * Requirements:
 *   - Windows with Node.js >= 18
 *   - Android phone with Messages app
 *   - Run setup.js first to pair your phone via QR code
 *
 * Setup:
 *   1. npm install
 *   2. node setup.js  (scan QR code once)
 *   3. node sender.js (runs headlessly from now on)
 */

'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ── Config ─────────────────────────────────────────────────────────────────

const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('config.json not found. Run setup.js first or copy config.json from the template.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { apiUrl, apiKey, paceSeconds = 30, pollIntervalSeconds = 10, sessionDir = 'session' } = config;

if (!apiUrl || !apiKey || apiKey.includes('YOUR_API_KEY')) {
  console.error('config.json is missing apiUrl or apiKey. Fill in your credentials.');
  process.exit(1);
}

const sessionPath = path.join(__dirname, sessionDir);

// ── State ──────────────────────────────────────────────────────────────────

let browser = null;
let page = null;
let lastSentAt = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

async function apiRequest(method, endpoint, body) {
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const fn = fetch || globalThis.fetch;
  const res = await fn(`${apiUrl}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ── Browser / Messages.google.com ─────────────────────────────────────────

async function launchBrowser() {
  if (!fs.existsSync(sessionPath)) {
    console.error(`Session directory not found: ${sessionPath}`);
    console.error('Run setup.js first to pair your Android phone.');
    process.exit(1);
  }

  log('Launching browser with saved session...');
  browser = await chromium.launchPersistentContext(sessionPath, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  page = await browser.newPage();
  await page.goto('https://messages.google.com/web/conversations', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Check if we are actually logged in
  const url = page.url();
  if (url.includes('authentication')) {
    log('Session expired. Re-run setup.js to re-pair your phone.');
    await browser.close();
    process.exit(1);
  }

  log('Connected to Android Messages for Web.');
}

async function sendSms(phone, message) {
  try {
    // Open new conversation
    await page.goto('https://messages.google.com/web/conversations/new', { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Type phone number in the recipient field
    const recipientInput = page.locator('input[aria-label*="recipient"], input[placeholder*="name"], mws-recipient-input input').first();
    await recipientInput.waitFor({ timeout: 10000 });
    await recipientInput.fill(phone);
    await page.keyboard.press('Enter');
    await sleep(1500);

    // Type message
    const msgInput = page.locator('div[contenteditable="true"][aria-label*="message"], textarea[aria-label*="message"]').first();
    await msgInput.waitFor({ timeout: 10000 });
    await msgInput.fill(message);
    await sleep(500);

    // Send
    await page.keyboard.press('Enter');
    await sleep(2000);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Main poll loop ─────────────────────────────────────────────────────────

async function poll() {
  try {
    const data = await apiRequest('GET', '/api/poll');
    if (!data || !data.message) return;

    const msg = data.message;
    log(`Got message ${msg.id} → ${msg.phone}`);

    // Respect pace
    const now = Date.now();
    const elapsed = (now - lastSentAt) / 1000;
    if (paceSeconds > 0 && elapsed < paceSeconds) {
      const wait = Math.ceil(paceSeconds - elapsed);
      log(`Pacing — waiting ${wait}s...`);
      await sleep(wait * 1000);
    }

    const result = await sendSms(msg.phone, msg.body);
    lastSentAt = Date.now();

    if (result.ok) {
      log(`Sent to ${msg.phone}`);
      await apiRequest('POST', '/api/ack', { message_id: msg.id, status: 'sent' });
    } else {
      log(`Failed to send to ${msg.phone}: ${result.error}`);
      await apiRequest('POST', '/api/ack', { message_id: msg.id, status: 'failed', error: result.error });
    }
  } catch (err) {
    log(`Poll error: ${err.message}`);
  }
}

async function main() {
  log('Text Your List Windows Companion starting...');
  log(`Server: ${apiUrl}`);
  log(`Poll interval: ${pollIntervalSeconds}s | Pace: ${paceSeconds}s between sends`);
  log('');

  await launchBrowser();

  log('Polling for messages. Leave this window open.');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await poll();
    await sleep(pollIntervalSeconds * 1000);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  log('Shutting down...');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
