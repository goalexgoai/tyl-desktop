# Text Your List Desktop App — Phase 6 Directive

## Context

Phases 1–5 are complete. The app sends, billing navigation opens in system browser, companion references are cleaned up, and the Help view is correct. Phase 6 covers three areas:

1. **Call-home license sync** — when a user pays on textyourlist.com, the desktop app automatically picks up their plan on next launch
2. **Security review** — full OWASP-focused audit of server.js and app.js
3. **Full QA audit** — verify every desktop-relevant feature works correctly, flag anything that is broken or behaves differently from the web app

**Project location:** `/home/ubuntu/projects/tyl-desktop/`
**Web app location:** `/home/ubuntu/projects/text-sender/`
**Do NOT modify text-sender unless explicitly stated below.**

---

## Part 1: Call-Home License Sync

### Problem

The desktop app has its own local SQLite database. When a user pays on textyourlist.com, their subscription is stored in the web database. The desktop app doesn't know about it — it still shows them as free tier.

### Solution

On every startup, the desktop app checks the user's email against textyourlist.com and updates the local plan accordingly.

---

### Step 1: Add /api/desktop-license endpoint to text-sender/server.js

Read text-sender/server.js first to understand routing conventions and where to add this.

The endpoint accepts an email and a shared secret header, and returns the user's current plan from the web database. It must be authenticated with a shared secret to prevent scraping.

```javascript
// Desktop license check endpoint — used by the Electron desktop app on startup
app.get('/api/desktop-license', async (req, res) => {
  const secret = req.headers['x-desktop-secret'];
  if (!secret || secret !== process.env.DESKTOP_LICENSE_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const user = db.prepare(
      'SELECT plan, subscription_status, billing_period_end, manual_account FROM users WHERE email = ?'
    ).get(email);
    if (!user) return res.json({ found: false });
    res.json({
      found: true,
      plan: user.plan,
      subscription_status: user.subscription_status,
      billing_period_end: user.billing_period_end || null,
      manual_account: user.manual_account || false,
    });
  } catch (err) {
    console.error('[desktop-license] error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});
```

Add `DESKTOP_LICENSE_SECRET=` to the text-sender .env.example file (not the actual .env — that has real values).

Push this change to the text-sender repo.

---

### Step 2: Add license sync to tyl-desktop/server.js

After the user logs in successfully (in the `POST /login` route and after session is established), add a background call-home check. Also call it on every `/api/auth/me` request.

Actually, the cleanest place: add a `syncLicenseFromWeb()` function to server.js that is called:
1. On user login (after session is set)
2. On startup for any existing logged-in user

```javascript
async function syncLicenseFromWeb(userId, email) {
  const licenseUrl = process.env.TYL_LICENSE_URL; // e.g. https://textyourlist.com/api/desktop-license
  const licenseSecret = process.env.DESKTOP_LICENSE_SECRET;
  if (!licenseUrl || !licenseSecret || !email) return;

  try {
    const https = require('https');
    const url = new URL(licenseUrl + '?email=' + encodeURIComponent(email));
    const data = await new Promise((resolve, reject) => {
      const opts = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { 'x-desktop-secret': licenseSecret },
      };
      https.get(opts, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch(_) { resolve(null); } });
      }).on('error', reject);
    });

    if (!data || !data.found) return;

    // Update local DB with web plan
    db.prepare(
      'UPDATE users SET plan = ?, subscription_status = ?, billing_period_end = ? WHERE id = ?'
    ).run(data.plan, data.subscription_status, data.billing_period_end || null, userId);

    console.log(`[license-sync] updated user ${userId} to plan=${data.plan} status=${data.subscription_status}`);
  } catch (err) {
    // License sync failure is non-fatal — user keeps local plan
    console.error('[license-sync] failed:', err.message);
  }
}
```

Call it after successful login:
```javascript
// In POST /login, after session.userId is set and before the response:
syncLicenseFromWeb(user.id, user.email).catch(() => {});
```

Call it on `/api/auth/me` (so plan updates are reflected on app load):
```javascript
// At the top of GET /api/auth/me:
syncLicenseFromWeb(user.id, user.email).catch(() => {});
```

Note: `syncLicenseFromWeb` is fire-and-forget (`.catch(() => {})`). It doesn't block login or page load. If the web server is unreachable, the local plan is used as fallback.

### Step 3: Add env vars to tyl-desktop/.env.example

Add these two lines to `/home/ubuntu/projects/tyl-desktop/.env.example`:
```
TYL_LICENSE_URL=https://textyourlist.com/api/desktop-license
DESKTOP_LICENSE_SECRET=
```

The shared secret should be the same value in both the desktop app's .env and the web app's .env. Generate a random 32-char string for the template placeholder (use `change_me_to_matching_secret` or similar).

---

## Part 2: Security Review

Read `server.js` and `public/app.js` in tyl-desktop. Report findings by file and line number. Check the following:

### server.js

1. **SQL injection** — all `db.prepare()` calls should use `?` placeholders, never string interpolation. Flag any that concatenate user input into SQL.

2. **Path traversal** — the multer upload and any file path construction should be checked. No user-controlled strings should be used in `path.join()` without sanitization.

3. **Rate limiting** — confirm rate limiters cover `/login`, `/signup`, `/api/send-one`, `/billing/checkout`. Check the window/max values are reasonable.

4. **Session configuration** — confirm:
   - `httpOnly: true` on cookies
   - `sameSite: 'lax'` (or 'strict') 
   - `secure: true` in production (confirm the `TYL_DESKTOP` bypass is only for the desktop mode)
   - Session secret is not hardcoded anywhere

5. **Authentication on all API routes** — every `/api/*` route that accesses user data should call `requireAuth`. List any that don't.

6. **CSRF protection** — the app uses session-based auth with `sameSite: 'lax'`. Check if any state-changing POST/PATCH/DELETE routes are vulnerable to CSRF. (Note: `sameSite: lax` provides partial protection, but POST requests from cross-origin are not automatically blocked in all cases.)

7. **Stripe webhook verification** — confirm the webhook handler uses `stripe.webhooks.constructEvent()` with the webhook secret, not just parsing raw JSON.

8. **Internal route protection** — `/internal/license-status` and `/internal/open-billing` check for localhost. Confirm this check is correct and can't be bypassed via headers like `X-Forwarded-For`.

9. **Admin routes** — confirm `/admin*` routes require `requireAuth` AND `user.is_admin === 1`.

10. **Error leakage** — confirm error handlers don't return stack traces or internal details to clients.

11. **CSV injection** — when CSV data is returned to the client, check if any cells could contain formulas (`=CMD()`, etc.) that would execute if a user opens the CSV in Excel.

### app.js (XSS review)

12. **`escHtml()` usage** — every place user-provided data is injected into innerHTML should use `escHtml()`. Scan for `.innerHTML = ` that includes any user data without escaping. List any unescaped injections.

13. **`eval()` or `Function()` usage** — search for any dynamic code execution. Should be none.

14. **External resource loading** — check if any user data is used in `src`, `href`, or `action` attributes without sanitization.

---

## Part 3: Full Desktop QA Audit

Read the current state of `server.js`, `public/app.js`, `public/app.html`, `main.js`, `db.js`, and `preload.js`. For each item below, check the code to determine if it will work correctly. Flag any bugs, missing implementations, or behaviors that differ from the web app in a way that would surprise the user.

### Authentication
- [ ] Signup creates account, redirects to `/app?new=1`
- [ ] Login works with correct credentials
- [ ] Login fails gracefully with wrong credentials (no stack trace in response)
- [ ] Password reset email flow works (requires SMTP env vars — note if not configured)
- [ ] "Change Password" in account panel validates current password before accepting new
- [ ] Logout clears session and redirects to login
- [ ] Re-login after logout starts fresh session (wrong-account bug fixed)

### Send — Quick Send
- [ ] Phone number field accepts 10-digit and E.164 format
- [ ] Message field shows character count and segment count
- [ ] Confirmation modal appears before sending
- [ ] Send posts to `/api/send-one`, embedded sender picks it up within 5 seconds
- [ ] Free tier: send is blocked after 50/month with upgrade prompt
- [ ] Paid tier: send allowed up to monthly limit

### Send — Bulk Send
- [ ] CSV upload parses correctly and shows column preview
- [ ] Column mapping works (phone, first_name, last_name, special)
- [ ] Merge fields `{first_name}` etc. are substituted correctly per row
- [ ] Free tier: bulk send blocked at 11+ contacts with upgrade prompt
- [ ] Paid tier: bulk send works up to plan contact limit
- [ ] Saved list can be selected instead of uploading a new CSV
- [ ] Confirmation modal shows count before sending
- [ ] Jobs are queued and embedded sender picks them up

### Contacts
- [ ] Create new contact list works
- [ ] Edit list name works
- [ ] Delete list works
- [ ] Download list CSV works
- [ ] View list contacts works

### Suppression List
- [ ] Add number to suppression list
- [ ] Suppressed numbers are excluded from bulk sends
- [ ] Remove from suppression list

### Templates
- [ ] Free plan: template creation blocked with upgrade prompt
- [ ] Starter/Pro: create template, save, use in Quick Send or Bulk Send
- [ ] Edit template
- [ ] Delete template

### History
- [ ] History shows sent messages with status (sent/failed/queued)
- [ ] Timestamps display correctly
- [ ] Pagination or scroll works if many records

### Account Panel
- [ ] Shows correct plan label
- [ ] Shows correct sends used / monthly limit
- [ ] Progress bar reflects usage correctly
- [ ] "Upgrade Plan" button shows for free/starter, hidden for pro/admin/manual
- [ ] "Manage Billing" button shows for paid users, opens Stripe portal in browser (via will-navigate intercept)
- [ ] "Change Password" works

### Plan & Billing View
- [ ] Shows current plan correctly
- [ ] Monthly/annual toggle works
- [ ] "Current plan" shows on active plan card
- [ ] "Get Starter" / "Get Pro" buttons open Stripe Checkout in system browser (via will-navigate)
- [ ] Cancel subscription button shows for active paid users, opens portal in browser
- [ ] Manage Subscription button opens portal in browser

### Help View (replacing Getting Started in desktop mode)
- [ ] "Help & Tips" content renders (not the companion wizard)
- [ ] Sidebar label says "Help" not "Getting Started"
- [ ] No companion references visible

### Developer / API Keys
- [ ] API key creation works
- [ ] API key deletion works
- [ ] No Mac/Windows companion download buttons visible in desktop mode
- [ ] API key description updated for desktop mode

### Edge Cases
- [ ] Double-launch prevention: second launch focuses existing window
- [ ] App stays alive when window is closed on macOS (hides to dock)
- [ ] Tray icon visible on Windows, absent on macOS
- [ ] App quits cleanly on Cmd+Q (macOS) / close (Windows)
- [ ] Database doesn't lock on restart (WAL/SHM cleanup confirmed)
- [ ] Session cleared on every launch (wrong-account fix confirmed)
- [ ] External URLs (Stripe, mailto:) open in system browser
- [ ] Footer /terms and /privacy links hidden in desktop mode
- [ ] "Companion not connected" banner absent in desktop mode

### Known Gaps to Flag (not bugs, just inform)
- Call-home license sync requires both `TYL_LICENSE_URL` and `DESKTOP_LICENSE_SECRET` in .env to work. Without them, local plan is used (acceptable default).
- Auto-update only works once a GitHub Release is published. On first launch of a freshly built .dmg, `checkForUpdatesAndNotify()` will find no update (expected).
- Stripe webhook cannot receive events on localhost — plan upgrades flow through call-home sync on next login, not instantly. Document this.

---

## After implementing Phase 6

Push all tyl-desktop changes to `https://github.com/goalexgoai/tyl-desktop` on `main`.
Push the /api/desktop-license endpoint change to the text-sender repo.

Report:
1. Call-home sync implemented — confirm `syncLicenseFromWeb()` is called on login and `/api/auth/me`
2. `/api/desktop-license` added to text-sender with secret-header auth
3. Security findings — list each issue found by file:line with severity (Critical / High / Medium / Low) and recommended fix
4. QA audit results — list every item that has a bug or concern, with specific file:line reference
5. Items that are clean — brief confirmation
