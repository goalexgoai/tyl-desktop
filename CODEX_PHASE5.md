# Text Your List Desktop App — Phase 5 Directive

## Context

Phase 4 added license enforcement using a 14-day trial gate — this was wrong. There is no trial. There is an always-free tier with limit-based gating (already enforced in server.js). Phase 5 fixes that, fixes the billing navigation bug, cleans up companion-app references throughout the desktop UI, and redesigns the Getting Started view for desktop users.

**Project location:** `/home/ubuntu/projects/tyl-desktop/`
**Web app location (for download page):** `/home/ubuntu/projects/text-sender/`
**Do NOT touch anything else in text-sender besides what is specified below.**

---

## Fix 1: Remove 14-day trial enforcement from main.js

The blocking dialog, `getInstallDate()`, and `isGracePeriodExpired()` added in Phase 4 must be completely removed. There is no trial — free tier users can use the app forever with 50 sends/month and 10 contacts per bulk send (limits already enforced in server.js).

Remove all of the following from main.js:
- `function getInstallDate() { ... }`
- `function isGracePeriodExpired() { ... }`
- The `if (!license.licensed && isGracePeriodExpired()) { dialog.showMessageBox... }` block in the startup sequence

After removal, the startup sequence should be:
```javascript
app.whenReady().then(async () => {
  try {
    createTray();
    const port = await startServer();
    await clearBrowserSession();
    const license = await checkLicense(port);
    console.log('[main] license status:', JSON.stringify(license));
    createWindow(port);
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch (err) {
    console.error('Startup failed:', err);
    app.quit();
  }
});
```

---

## Fix 2: Intercept external URL navigation in main.js

In desktop mode, clicking "Get Starter" or "Manage Billing" triggers a redirect to Stripe Checkout or the Stripe billing portal. In Electron, this tries to load Stripe *inside* the app window — which won't work and looks broken.

Fix: in `createWindow()` in main.js, add a `will-navigate` handler on the webContents. Store the port in a variable accessible to `createWindow()` so it can be referenced in the handler.

```javascript
function createWindow(port) {
  mainWindow = new BrowserWindow({
    // ... existing options
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/app`);

  // Intercept external navigation — open in system browser instead
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Also handle new-window events (link target="_blank")
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // ... existing close/show handlers
}
```

Ensure `shell` is imported at the top of main.js — it should already be in the destructured require.

---

## Fix 3: Add isDesktop flag to preload.js

Read preload.js first. Add `isDesktop: true` to the existing `electronAPI` contextBridge object. Do not redefine the entire object — add the property to what's already there.

After this change, `window.electronAPI.isDesktop` will be `true` inside the Electron renderer, and `undefined` in a regular browser.

---

## Fix 4: Suppress companion status banner in desktop mode (app.js)

In `checkCompanionBanner()`, add a guard at the very top of the function:

```javascript
async function checkCompanionBanner() {
  if (window.electronAPI?.isDesktop) return; // Desktop app sends automatically — no companion needed
  const el = document.getElementById('companion-status-banner');
  // ... rest of function unchanged
}
```

---

## Fix 5: Fix Quick Send success message in desktop mode (app.js)

Line ~482 in app.js:
```javascript
resultEl.innerHTML = '<span style="color:var(--success)">&#10003; Queued — your companion app will send it shortly.</span>';
```

Change to:
```javascript
const successMsg = window.electronAPI?.isDesktop
  ? '&#10003; Queued — sending within the next few seconds.'
  : '&#10003; Queued — your companion app will send it shortly.';
resultEl.innerHTML = `<span style="color:var(--success)">${successMsg}</span>`;
```

---

## Fix 6: Replace Getting Started with a Help view in desktop mode (app.js)

Find `function renderGettingStarted(main)` in app.js. At the very top of that function, add a desktop-mode branch that renders a Help & Tips page instead:

```javascript
function renderGettingStarted(main) {
  // Desktop mode: companion not needed — show help & tips instead
  if (window.electronAPI?.isDesktop) {
    main.innerHTML = `
      <div class="main-header"><h2>Help &amp; Tips</h2></div>
      <div class="main-body" style="max-width:640px">

        <div class="card" style="padding:24px;margin-bottom:16px">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:10px">You're all set</h3>
          <p style="font-size:13.5px;color:var(--text-muted);line-height:1.7">
            Text Your List is running. Messages send automatically through your Mac's Messages app (connected to your iPhone). No companion app needed — it's all built in.
          </p>
        </div>

        <div class="card" style="padding:24px;margin-bottom:16px">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:12px">How to send</h3>
          <ul style="font-size:13.5px;color:var(--text-muted);line-height:2;margin:0 0 0 18px">
            <li><strong style="color:var(--text)">Quick Send</strong> — send a single text to one number</li>
            <li><strong style="color:var(--text)">Bulk Send</strong> — upload a CSV or pick a saved list to send to many contacts at once</li>
            <li><strong style="color:var(--text)">Contacts</strong> — manage and save your contact lists for reuse</li>
            <li><strong style="color:var(--text)">Templates</strong> — save message templates (Starter and Pro plans)</li>
            <li><strong style="color:var(--text)">History</strong> — see all sent messages and their status</li>
          </ul>
        </div>

        <div class="card" style="padding:24px;margin-bottom:16px">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:10px">Free plan limits</h3>
          <ul style="font-size:13.5px;color:var(--text-muted);line-height:2;margin:0 0 12px 18px">
            <li>50 texts per month</li>
            <li>Bulk sends limited to 10 contacts at a time</li>
          </ul>
          <p style="font-size:13px;color:var(--text-muted)">Need more? <button class="btn btn-primary btn-sm" onclick="navigate('billing')">View plans</button></p>
        </div>

        <div class="card" style="padding:24px;margin-bottom:16px">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:10px">Tips</h3>
          <ul style="font-size:13.5px;color:var(--text-muted);line-height:2;margin:0 0 0 18px">
            <li>Keep Messages open on your Mac for fastest delivery</li>
            <li>Don't send more than 200 texts per day to avoid spam filters</li>
            <li>Suppression list lets you block numbers from receiving future sends</li>
          </ul>
        </div>

        <div class="card" style="padding:20px">
          <h3 style="font-size:14px;font-weight:700;margin-bottom:8px">Need help?</h3>
          <a href="mailto:support@textyourlist.com" class="btn btn-ghost btn-sm">Contact Support</a>
        </div>
      </div>`;
    return; // stop here — don't render the companion wizard below
  }

  // Web mode: companion download wizard (existing code follows unchanged)
  const isDone = localStorage.getItem('setup_complete') === '1';
  // ... rest of existing function unchanged
```

---

## Fix 7: Hide companion download buttons in Developer / API Keys section (app.js)

Find where the Mac/Windows companion download buttons are rendered (around line 2160):
```javascript
<a href="/api/keys/${k.id}/companion" download class="btn btn-primary btn-sm">&#8595; Mac</a>
<a href="/api/keys/${k.id}/companion?platform=windows" download class="btn btn-ghost btn-sm">&#8595; Windows</a>
```

Wrap these in a desktop check:
```javascript
${window.electronAPI?.isDesktop ? '' : `
  <a href="/api/keys/${k.id}/companion" download class="btn btn-primary btn-sm">&#8595; Mac</a>
  <a href="/api/keys/${k.id}/companion?platform=windows" download class="btn btn-ghost btn-sm">&#8595; Windows</a>
`}
```

Also find the API keys section description (around line 2002):
```
API keys connect your companion app to Text Your List. The companion picks up queued messages and sends them through your phone.
```

In desktop mode, change this to a note about API webhook access:
```javascript
${window.electronAPI?.isDesktop
  ? 'API keys are used for webhook sends (Pro plan) — integrate with Make, Zapier, or your own systems. The desktop app handles all sending automatically.'
  : 'API keys connect your companion app to Text Your List. The companion picks up queued messages and sends them through your phone.'}
```

Also find the key name placeholder input (around line 2012):
```javascript
placeholder="Mac companion, Windows companion, etc."
```
Change to:
```javascript
placeholder="${window.electronAPI?.isDesktop ? 'Webhook integration, Make, Zapier, etc.' : 'Mac companion, Windows companion, etc.'}"
```

Wait — template literals inside template literals need escaping. Look at the actual code context in app.js and match the quoting style. Read the surrounding 10 lines before making this edit to ensure the string context is correct.

---

## Fix 8: Remove companion help text from Quick Send tip (app.js)

Find around line 534:
```
Make sure the <strong style="color:var(--text)">companion app is running</strong>...
```

This is a help tip shown when the companion status is shown. Since we're suppressing the companion banner in desktop mode (Fix 4), this tip won't show. No change needed here — the banner suppression already handles it.

---

## Fix 9: Update plan feature lists in billing view to not mention companion (app.js)

In `renderBilling()`, find the feature lists for Free, Starter, and Pro plans. Each has:
```html
<li>&#10003; Companion app included</li>
```

In desktop mode, the companion IS the desktop app — listing it as a feature is misleading. Remove this line from all three plan cards when in desktop mode:

Find each occurrence of:
```html
<li>&#10003; Companion app included</li>
```

Replace with:
```javascript
${window.electronAPI?.isDesktop ? '' : '<li>&#10003; Companion app included</li>'}
```

There are 3 occurrences — one in each plan card (Free, Starter, Pro).

---

## Fix 10: Update sidebar nav label for desktop (app.js)

In app.html, the "Getting Started" nav button is:
```html
<button class="nav-item" data-view="start" id="nav-setup-guide">
  <span class="icon">&#9733;</span> Getting Started
  <span id="setup-checkmark" ...>&#10003;</span>
</button>
```

In desktop mode, "Getting Started" is replaced with "Help" (since the view now shows Help & Tips). Update the label in JavaScript after init, rather than touching the HTML:

In app.js, inside `init()`, after the existing setup code, add:

```javascript
// In desktop mode, rename "Getting Started" to "Help"
if (window.electronAPI?.isDesktop) {
  const setupBtn = document.getElementById('nav-setup-guide');
  if (setupBtn) {
    setupBtn.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === 'Getting Started') {
        node.textContent = ' Help';
      }
    });
  }
  // Hide the setup checkmark — not meaningful in desktop mode
  const checkmark = document.getElementById('setup-checkmark');
  if (checkmark) checkmark.style.display = 'none';
}
```

---

## Fix 11: Hide footer links to /terms and /privacy in desktop mode (app.html)

The footer in app.html links to `/terms` and `/privacy`. These routes are disabled in desktop mode. In desktop mode, the footer should either be hidden entirely or show only the support email.

In app.html, find the `app-footer` div and update it:

```html
<!-- App footer disclaimer -->
<div id="app-footer" style="display:none;text-align:center;padding:8px 16px;font-size:11.5px;color:#999;border-top:1px solid #e5e5e4;background:#fafafa">
  Text Your List schedules messages sent from your own device. You are responsible for compliance with applicable messaging laws.
  <span id="footer-web-links">
    &nbsp;&middot;&nbsp;
    <a href="/terms#disclaimer" style="color:#777;text-decoration:underline">See full disclaimer</a>
    &nbsp;&middot;&nbsp;
    <a href="/privacy" style="color:#777">Privacy Policy</a>
    &nbsp;&middot;&nbsp;
    <a href="/terms" style="color:#777">Terms of Use</a>
  </span>
  &nbsp;&middot;&nbsp;
  <a href="mailto:support@textyourlist.com" style="color:#777">Support</a>
</div>
```

Then in app.js `init()`, in the section that shows the footer, add:
```javascript
const footerEl = document.getElementById('app-footer');
if (footerEl) {
  footerEl.style.display = 'block';
  if (window.electronAPI?.isDesktop) {
    const webLinks = document.getElementById('footer-web-links');
    if (webLinks) webLinks.style.display = 'none';
  }
}
```

---

## Task 12: Create download page on the web app (text-sender)

In `/home/ubuntu/projects/text-sender/`, create two things:

### 12a. Create `public/download.html`

A clean download page styled to match the existing site style.css. Look at `public/landing.html` or `public/index.html` to understand the existing styles before writing this page.

The page should have:
- Page title: "Download Text Your List"
- Headline: "Send personal texts from your computer"
- Subheadline: "No phone plan fees. No carrier restrictions. Just texts — from your Mac or Windows PC, through your own phone."
- Two download buttons side by side:
  - Mac: "Download for Mac" → links to `https://github.com/goalexgoai/tyl-desktop/releases/latest/download/Text.Your.List-{version}.dmg` (use a generic `/releases/latest` redirect: `https://github.com/goalexgoai/tyl-desktop/releases/latest`)
  - Windows: Same pattern for .exe
- Actually use: `https://github.com/goalexgoai/tyl-desktop/releases` as the download link for both (users pick their version) until we have stable download URLs
- System requirements section:
  - Mac: macOS 12 or later, iPhone with Messages connected
  - Windows: Windows 10 or later, iPhone or Android phone
- "How it works" section (3 steps):
  1. Download and install the app
  2. Sign up with your email
  3. Start sending — messages go through your own phone
- FAQ section:
  - "Does it cost anything?" → Free plan: 50 texts/month. Upgrade for more.
  - "What phone do I need?" → iPhone (Mac or Windows). Android works on Windows with Phone Link.
  - "Do I need to keep it open?" → Yes, keep it running while sending. It works in the background.

### 12b. Add `/download` route in text-sender/server.js

Find a good location in server.js (near where other static page routes are served, like `/privacy`, `/terms`). Add:

```javascript
app.get('/download', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});
```

Read server.js first to find the right location — look for where `/privacy` or `/terms` is served and add the route nearby.

---

## What NOT to change

- `send-mac.js` / `send-windows.js` / `db.js` — do not touch
- API routes — do not touch  
- Stripe billing routes — do not touch
- Any other routes in text-sender — do not touch
- `/home/ubuntu/projects/text-sender/` beyond what is specified above

---

## After implementing Phase 5

Push all tyl-desktop changes to `https://github.com/goalexgoai/tyl-desktop` on the `main` branch.
Push all text-sender changes to whatever remote is configured for that repo.

Report:
1. 14-day trial removed from main.js
2. `will-navigate` intercept added
3. `isDesktop: true` in preload.js
4. Companion banner suppressed in desktop mode
5. Quick Send success message updated
6. Getting Started → Help & Tips view in desktop mode
7. Companion download buttons hidden in API Keys section
8. "Companion app included" removed from billing plan lists in desktop mode
9. Sidebar label updated to "Help" in desktop mode
10. Footer web links hidden in desktop mode
11. `/download` page created in text-sender (HTML + route)
12. Both repos pushed successfully
