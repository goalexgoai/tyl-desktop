#!/usr/bin/env node
/**
 * Text Your List Windows Companion — Setup
 *
 * Opens a browser window to pair with Android Messages for Web.
 * Run this once to scan the QR code with your Android phone.
 * The session is saved so sender.js can run headlessly afterward.
 */

'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('config.json not found. Copy config.json from the template and fill in your apiUrl and apiKey.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const sessionDir = path.join(__dirname, config.sessionDir || 'session');
fs.mkdirSync(sessionDir, { recursive: true });

(async () => {
  console.log('Opening Android Messages for Web...');
  console.log('Scan the QR code with your Android phone.');
  console.log('Go to: Messages app > More (3 dots) > Device Pairing');
  console.log('');
  console.log('Once paired, this window will confirm and close automatically.');
  console.log('');

  const browser = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    args: ['--no-sandbox'],
    viewport: { width: 1024, height: 768 },
  });

  const page = await browser.newPage();
  await page.goto('https://messages.google.com/web/authentication', { waitUntil: 'domcontentloaded' });

  console.log('Waiting for QR code scan...');

  // Wait for successful pairing — the URL changes to /web/conversations after auth
  await page.waitForURL('**/web/conversations**', { timeout: 5 * 60 * 1000 }).catch(() => {});

  const currentUrl = page.url();
  if (currentUrl.includes('conversations')) {
    console.log('');
    console.log('Pairing successful! Session saved.');
    console.log('You can now run sender.js to start sending messages headlessly.');
  } else {
    console.log('');
    console.log('Pairing may not have completed. Try running setup.js again.');
  }

  await browser.close();
  process.exit(0);
})();
