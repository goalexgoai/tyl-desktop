/* Text Your List — frontend (authenticated app) — Build 3 */

// ── API helpers ────────────────────────────────────────────────────────────

async function api(method, path, body, isFormData) {
  const opts = { method, headers: {} };
  if (body && !isFormData) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body;
  }
  const res = await fetch(path, opts);
  if (res.status === 401) { window.location.href = '/login'; return; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data;
}

const get    = (p) => api('GET', p);
const post   = (p, b) => api('POST', p, b);
const patch  = (p, b) => api('PATCH', p, b);
const put    = (p, b) => api('PUT', p, b);
const del    = (p) => api('DELETE', p);

// ── State ──────────────────────────────────────────────────────────────────

let currentView = 'send';
let monitorInterval = null;
let currentUser = null;
let setupPhoneType = null;
let setupOsType = null;

// ── Emoji helpers ─────────────────────────────────────────────────────────

const EMOJI_DEFAULTS = ['😊','🎉','😂','❤️','🔥','👍','🙌','✅','🙏','📣'];
const EMOJI_LIBRARY = {
  'Smileys': ['😊','😂','🤣','😍','🥰','😘','😁','😄','😆','😅','🤩','🥳','😎','🤗','😏','🙃','🤔','😬','😐','😑','😶','🤐','😴','🤤','😷','🤒','😈'],
  'Gestures': ['👍','👎','👏','🙌','🤝','👊','✊','🤜','🤛','🖐','✋','👋','🤚','🤙','💪','🙏','🤞','👌','🤌','☝️','👆','👇','👈','👉'],
  'Hearts': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❤️‍🔥','💕','💞','💓','💗','💖','💘','💝','💟','❣️'],
  'Activities': ['🎉','🎊','🎈','🎁','🎂','🏆','🥇','⭐','🌟','✨','💫','🔥','💥','🎯','🎵','🎶','📣','📢','🔔','💡'],
  'Objects': ['📱','💻','📧','📩','📬','📝','✏️','📌','📎','🔑','🔒','💰','💳','🛒','🚀','✈️','🏠','🌐','🔗','📊'],
  'Symbols': ['✅','❌','⚠️','💯','🔴','🟢','🟡','⬆️','⬇️','➡️','⬅️','↩️','🔄','▶️','⏸️','⏹️','⏺️','🆕','🆓','🆙'],
};

function getEmojiUsage() {
  try { return JSON.parse(localStorage.getItem('emoji_usage') || '{}'); } catch(_) { return {}; }
}

function trackEmojiUsage(emoji) {
  const usage = getEmojiUsage();
  usage[emoji] = (usage[emoji] || 0) + 1;
  try { localStorage.setItem('emoji_usage', JSON.stringify(usage)); } catch(_) {}
}

function topEmojis(n) {
  n = n || 10;
  const usage = getEmojiUsage();
  const sorted = Object.entries(usage).sort((a, b) => b[1] - a[1]).map(e => e[0]);
  const result = [...sorted];
  for (const e of EMOJI_DEFAULTS) { if (result.length >= n) break; if (!result.includes(e)) result.push(e); }
  return result.slice(0, n);
}

function emojiBarHtml(target) {
  const emojis = topEmojis(10);
  return `<div class="emoji-bar" data-target="${target}">${emojis.map(e => `<span>${e}</span>`).join('')}<span class="emoji-more" title="More emojis">•••</span></div>`;
}

function refreshEmojiBar(target) {
  const bar = document.querySelector(`.emoji-bar[data-target="${target}"]`);
  if (!bar) return;
  bar.innerHTML = topEmojis(10).map(e => `<span>${e}</span>`).join('') + `<span class="emoji-more" title="More emojis">•••</span>`;
}

function openEmojiPicker(target) {
  const existing = document.getElementById('emoji-picker-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'emoji-picker-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4)';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--card-bg,#fff);border-radius:12px;padding:20px;max-width:480px;width:90%;max-height:70vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,0.18)';
  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><strong>Emoji Picker</strong><button id="emoji-picker-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted)">✕</button></div>`;
  for (const [cat, emojis] of Object.entries(EMOJI_LIBRARY)) {
    html += `<div style="margin-bottom:14px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:6px">${cat}</div><div style="display:flex;flex-wrap:wrap;gap:4px">${emojis.map(e => `<span class="epick-emoji" data-emoji="${e}" style="cursor:pointer;font-size:22px;padding:3px 5px;border-radius:6px;line-height:1;transition:background 0.1s" title="${e}">${e}</span>`).join('')}</div></div>`;
  }
  box.innerHTML = html;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.getElementById('emoji-picker-close').addEventListener('click', () => overlay.remove());
  box.querySelectorAll('.epick-emoji').forEach(span => {
    span.addEventListener('mouseenter', () => { span.style.background = 'var(--bg-alt,#f0f0f0)'; });
    span.addEventListener('mouseleave', () => { span.style.background = ''; });
    span.addEventListener('click', () => {
      const emoji = span.dataset.emoji;
      const ta = document.getElementById(target);
      if (ta) {
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? ta.value.length;
        ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start + emoji.length;
        ta.focus();
        ta.dispatchEvent(new Event('input'));
      }
      trackEmojiUsage(emoji);
      refreshEmojiBar(target);
      overlay.remove();
    });
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────

function pill(status) {
  return `<span class="pill pill-${status}">${status.replace('_', ' ')}</span>`;
}

function fmt(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'Z'));
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'Z'));
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function abbreviateColumnLabel(label) {
  // Display-only abbreviation; never changes the real column key used internally.
  const text = String(label || '');
  return text.length > 14 ? `${text.slice(0, 12)}…` : text;
}

function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function showToast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, duration);
}

async function openBillingPage() {
  try {
    const r = await get('/api/billing-link');
    window.location.href = r.url;
  } catch (_) {
    window.location.href = 'https://textyourlist.com/account';
  }
}

function upgradePrompt(msg) {
  return `<div class="alert alert-info" style="margin-bottom:16px">
    ${msg} &nbsp;
    <button class="btn btn-primary btn-sm" onclick="openBillingPage()">Upgrade now</button>
  </div>`;
}

// ── Merge field chips ──────────────────────────────────────────────────────

// Sanitize a CSV column name into a safe merge token: lowercase, non-alphanumeric → underscore
function sanitizeToken(col) {
  return col.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function mergeChipsHtml(textareaId) {
  // Before CSV is loaded, show generic hint chips (no phone — that's routing, not a merge field)
  const base = ['{first_name}', '{last_name}', '{special}'];
  return `
    <div class="merge-chips" id="merge-chips-${textareaId}" style="margin-bottom:8px">
      <span class="merge-chip-label">Insert field &rarr;</span>
      ${base.map(f => `<span class="merge-chip" data-field="${f}" data-target="${textareaId}">${f}</span>`).join('')}
    </div>`;
}

// After CSV upload: replace chips with tokens from all non-phone columns
function updateMergeChips(textareaId, columnMap) {
  const container = document.getElementById(`merge-chips-${textareaId}`);
  if (!container) return;
  const tokens = Object.keys(columnMap).filter(k => k !== 'phone');
  if (!tokens.length) return;
  container.innerHTML = `
    <span class="merge-chip-label">Insert field &rarr;</span>
    ${tokens.map(t => `<span class="merge-chip" data-field="{${t}}" data-target="${textareaId}" title="{${escHtml(t)}}">${escHtml(abbreviateColumnLabel(`{${t}}`))}</span>`).join('')}`;
  bindMergeChips();
}

function bindMergeChips() {
  document.querySelectorAll('.merge-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const ta = document.getElementById(chip.dataset.target);
      if (!ta) return;
      const pos = ta.selectionStart;
      const val = ta.value;
      const field = chip.dataset.field;
      ta.value = val.slice(0, pos) + field + val.slice(ta.selectionEnd);
      ta.setSelectionRange(pos + field.length, pos + field.length);
      ta.focus();
      ta.dispatchEvent(new Event('input'));
    });
  });
}

// ── Init / Auth ────────────────────────────────────────────────────────────

async function init() {
  try {
    currentUser = await get('/api/auth/me');
    updateUserBadge();
    updateSetupCheckmark();

    // Admin link — insert at top of sidebar-bottom (before Developer)
    if (currentUser.is_admin && !window.electronAPI?.isDesktop) {
      const adminLink = document.createElement('button');
      adminLink.className = 'nav-item';
      adminLink.innerHTML = '<span class="icon">&#9632;</span> Admin';
      adminLink.addEventListener('click', () => window.open('/admin', '_blank'));
      const sb = document.querySelector('.sidebar-bottom');
      if (sb) sb.insertBefore(adminLink, sb.firstChild);
    }

    // Show app footer
    const footerEl = document.getElementById('app-footer');
    if (footerEl) {
      footerEl.style.display = 'block';
      if (window.electronAPI?.isDesktop) {
        const webLinks = document.getElementById('footer-web-links');
        if (webLinks) webLinks.style.display = 'none';
      }
    }

    // Handle new signup or billing success
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') === '1') {
      currentView = 'start';
      history.replaceState({}, '', '/app');
    } else if (params.get('billing') === 'success') {
      currentUser = await get('/api/auth/me');
      updateUserBadge();
      history.replaceState({}, '', '/app');
    } else if (params.get('billing_flash') === 'not_configured') {
      const plan = params.get('plan') || 'paid';
      // Show flash after render
      setTimeout(() => showToast(`Billing not configured yet — you've been set up on the free plan. (Wanted: ${plan})`, 6000), 500);
      history.replaceState({}, '', '/app');
    }

  } catch (e) {
    window.location.href = '/login';
    return;
  }

  // Heartbeat — tells server the desktop is active so API sends auto-route.
  // On startup: wait for ping to update web_pending_count before checking for prompt.
  post('/api/desktop-ping').then(async () => {
    const fresh = await get('/api/auth/me').catch(() => null);
    if (fresh) { currentUser = fresh; updateUserBadge(); }
    const pending = currentUser.pending_api_count || 0;
    if (pending > 0) setTimeout(() => showPendingApiPrompt(pending), 400);
  }).catch(() => {});
  setInterval(() => post('/api/desktop-ping').catch(() => {}), 60000);

  // API pending poller — refreshes the dashboard banner without a full re-render
  setInterval(async () => {
    try {
      const fresh = await get('/api/auth/me');
      const prev = currentUser?.pending_api_count || 0;
      currentUser = fresh;
      updateUserBadge();
      if (fresh.pending_api_count !== prev && currentView === 'send') render();
    } catch (_) {}
  }, 30000);

  // Nav
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.view));
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await post('/api/auth/logout');
    window.location.href = '/login';
  });

  // Emoji bar — delegated click handler for dynamically rendered views
  document.getElementById('main').addEventListener('click', e => {
    const chip = e.target.closest('.emoji-bar span');
    if (!chip) return;
    const bar = chip.closest('.emoji-bar');
    const target = bar.dataset.target;
    if (chip.classList.contains('emoji-more')) {
      openEmojiPicker(target);
      return;
    }
    const ta = document.getElementById(target);
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const emoji = chip.textContent;
    ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + emoji.length;
    ta.focus();
    ta.dispatchEvent(new Event('input'));
    trackEmojiUsage(emoji);
    refreshEmojiBar(target);
  });


  render();
}

async function releaseApiMessages(paceSeconds) {
  try {
    const result = await post('/api/jobs/release-api', { paceSeconds });
    if (result.released > 0) {
      currentUser = await get('/api/auth/me');
      updateUserBadge();
      render();
      showToast(`${result.released} message${result.released===1?'':'s'} released — sending now.`);
    }
  } catch (err) {
    showToast('Could not release messages: ' + err.message);
  }
}

function showPendingApiPrompt(count) {
  const overlay = document.createElement('div');
  overlay.id = 'pending-api-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:9999';

  overlay.innerHTML = `
    <div style="background:var(--bg,#fff);border-radius:14px;padding:28px 32px;max-width:400px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.25)">
      <div style="font-size:22px;margin-bottom:10px">&#128274;</div>
      <h3 style="font-size:17px;font-weight:700;margin-bottom:8px;text-transform:none">${count} message${count===1?'':'s'} waiting</h3>
      <p style="font-size:13.5px;color:var(--text-muted,#666);margin-bottom:22px;line-height:1.6">
        You have held messages via API that have not been sent yet. What would you like to do?
      </p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button id="pending-send-now" class="btn btn-primary" style="font-size:14px;padding:10px">Send now</button>
        <button id="pending-keep-holding" class="btn btn-ghost" style="font-size:14px;padding:10px">Keep holding — I'll decide later</button>
        <button id="pending-cancel" style="font-size:13px;color:var(--text-muted,#888);background:none;border:none;cursor:pointer;padding:6px;text-align:center">Cancel all ${count} message${count===1?'':'s'}</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const pace = currentUser?.api_default_pace >= 0 ? currentUser.api_default_pace : 7;

  document.getElementById('pending-send-now').addEventListener('click', async () => {
    overlay.remove();
    await releaseApiMessages(pace);
  });
  document.getElementById('pending-keep-holding').addEventListener('click', () => overlay.remove());
  document.getElementById('pending-cancel').addEventListener('click', async () => {
    try {
      const r = await post('/api/jobs/cancel-api');
      overlay.remove();
      currentUser = await get('/api/auth/me');
      updateUserBadge();
      render();
      if (r.cancelled > 0) showToast(`${r.cancelled} pending message${r.cancelled===1?'':'s'} cancelled.`);
    } catch (err) {
      showToast('Could not cancel: ' + err.message);
    }
  });
}

async function cancelApiMessages() {
  if (!confirm('Cancel all pending API messages? This cannot be undone.')) return;
  try {
    const result = await post('/api/jobs/cancel-api', {});
    currentUser = await get('/api/auth/me');
    updateUserBadge();
    render();
    showToast(`${result.cancelled} message${result.cancelled===1?'':'s'} cancelled.`);
  } catch (err) {
    showToast('Could not cancel messages: ' + err.message);
  }
}

// Per-job review prompt — shown when clicking Review on a single held job in history
window._heldJobCache = {};

function showJobReviewPrompt(jobId) {
  const job = window._heldJobCache[jobId];
  if (!job) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:9999';
  const count = job.total || 1;
  overlay.innerHTML = `
    <div style="background:var(--bg,#fff);border-radius:14px;padding:28px 32px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.25)">
      <div style="font-size:22px;margin-bottom:10px">&#9208;</div>
      <h3 style="font-size:17px;font-weight:700;margin-bottom:4px;text-transform:none">${escHtml(job.name)}</h3>
      <p style="font-size:13px;color:var(--text-muted,#666);margin-bottom:20px">${count} message${count===1?'':'s'} held via API</p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button id="jrp-fast" class="btn btn-primary" style="font-size:14px;padding:10px">Send now (fast)</button>
        <button id="jrp-throttle" class="btn btn-ghost" style="font-size:14px;padding:10px">Send with Smart Throttle</button>
        <button id="jrp-hold" class="btn btn-ghost" style="font-size:14px;padding:10px">Keep holding</button>
        <button id="jrp-cancel" style="font-size:13px;color:var(--text-muted,#888);background:none;border:none;cursor:pointer;padding:6px;text-align:center">Cancel this job</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const pace = currentUser?.api_default_pace >= 0 ? currentUser.api_default_pace : 7;
  overlay.querySelector('#jrp-fast').addEventListener('click', async () => { overlay.remove(); await releaseApiJob(job.id, 0); });
  overlay.querySelector('#jrp-throttle').addEventListener('click', async () => { overlay.remove(); await releaseApiJob(job.id, pace); });
  overlay.querySelector('#jrp-hold').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#jrp-cancel').addEventListener('click', async () => { overlay.remove(); await cancelApiJob(job.id); });
}

async function releaseApiJob(jobId, paceSeconds) {
  try {
    await post('/api/jobs/release-api', { paceSeconds, job_id: jobId });
    currentUser = await get('/api/auth/me');
    updateUserBadge();
    render();
    showToast('Job released — sending now.');
  } catch (err) { showToast('Could not release job: ' + err.message); }
}

async function cancelApiJob(jobId) {
  try {
    await post('/api/jobs/cancel-api', { job_id: jobId });
    currentUser = await get('/api/auth/me');
    updateUserBadge();
    render();
    showToast('Job cancelled.');
  } catch (err) { showToast('Could not cancel job: ' + err.message); }
}

function updateSetupCheckmark() {
  const done = localStorage.getItem('setup_complete') === '1';
  const el = document.getElementById('setup-checkmark');
  if (el) el.style.display = done ? 'inline' : 'none';
}

function markSetupComplete() {
  localStorage.setItem('setup_complete', '1');
  updateSetupCheckmark();
}

function unmarkSetupComplete() {
  localStorage.removeItem('setup_complete');
  updateSetupCheckmark();
  renderGettingStarted(document.getElementById('main'));
}

function updateUserBadge() {
  const el = document.getElementById('user-plan-label');
  if (!el || !currentUser) return;
  const pct = Math.round((currentUser.monthly_sends / currentUser.monthly_limit) * 100);
  el.innerHTML = `
    <span style="display:block;font-size:11px;color:var(--text-muted)">${currentUser.email}</span>
    <span style="display:block;font-size:11px;color:var(--text-muted);margin-top:2px">${currentUser.plan_label} &middot; ${currentUser.monthly_sends}/${currentUser.monthly_limit} sends</span>
    <div style="margin-top:5px;height:3px;background:var(--border);border-radius:99px;overflow:hidden">
      <div style="height:100%;width:${Math.min(pct,100)}%;background:${pct>=90?'var(--danger)':pct>=70?'var(--warn)':'var(--accent)'}"></div>
    </div>`;
}

// ── Routing ──────────────────────────────────────────────────────────────

function navigate(view) {
  if (view === 'billing') {
    // All billing/pricing lives on the web — open account page in system browser
    const url = 'https://textyourlist.com/account';
    if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
    else window.open(url, '_blank');
    return;
  }
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  currentView = view;
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  render();
}

function render() {
  const main = document.getElementById('main');
  switch (currentView) {
    case 'send':        renderSend(main); break;
    case 'quick-send':  renderQuickSendPage(main); break;
    case 'contacts':    renderContactsPage(main); break;
    case 'templates':   renderTemplatesPage(main); break;
    case 'suppression': renderSuppressionPage(main); break;
    case 'history':     renderHistoryPage(main); break;
    case 'account':     renderAccount(main); break;
    case 'developer':   renderDeveloper(main); break;
    case 'help':        renderHelp(main); break;
    case 'billing':     renderBilling(main); break;
    case 'start':       renderGettingStarted(main); break;
    default:            main.innerHTML = '<div class="main-body">Not found</div>';
  }
}

// ── Send Messages page (Bulk Send) ──────────────────────────────────────────

function renderSend(main) {
  const u = currentUser;
  const periodStart = new Date(u.period_start + 'T00:00:00Z');
  const daysUntilReset = Math.max(0, 30 - Math.floor((new Date() - periodStart) / (1000*60*60*24)));

  main.innerHTML = `
    <div class="main-header">
      <h2>Send Messages</h2>
      <div style="font-size:12.5px;color:var(--text-muted)">
        ${u.monthly_sends} / ${u.monthly_limit} sends &nbsp;&middot;&nbsp; resets in ${daysUntilReset} day${daysUntilReset===1?'':'s'}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">&#128161; Tip: We recommend sending no more than 200 texts per day to protect your number from spam filters.</div>
    </div>
    <div id="companion-status-banner"></div>
    ${(u.pending_api_count || 0) > 0 ? `<div id="api-pending-banner" style="background:#fff7ed;border:1px solid #fb923c;border-radius:8px;padding:14px 16px;margin:0 0 14px;font-size:13.5px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <span style="font-weight:600;color:#9a3412">⏸ ${u.pending_api_count} message${u.pending_api_count===1?'':'s'} held via API — waiting for your approval</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" onclick="releaseApiMessages(0)">Send now (fast)</button>
          <button class="btn btn-ghost btn-sm" onclick="releaseApiMessages(${u.api_default_pace >= 0 ? u.api_default_pace : 7})">Smart Throttle</button>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('api-pending-banner').style.display='none'">Keep holding</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="cancelApiMessages()">Cancel all</button>
        </div>
      </div>
      <div style="font-size:12px;color:#c2410c;margin-top:6px">To act on these later, check <strong>Send History</strong> — they appear at the top with a Review button.</div>
    </div>` : ''}
    <div class="main-body"><div id="send-body"></div></div>`;

  renderBulkSend(document.getElementById('send-body'));
  checkCompanionBanner();
}

// ── Per-view page wrappers (promote tabs to top-level nav) ──────────────────

function renderQuickSendPage(main) {
  const u = currentUser;
  const periodStart = new Date(u.period_start + 'T00:00:00Z');
  const daysUntilReset = Math.max(0, 30 - Math.floor((new Date() - periodStart) / (1000*60*60*24)));
  main.innerHTML = `
    <div class="main-header">
      <h2>Test Send</h2>
      <div style="font-size:12.5px;color:var(--text-muted)">${u.monthly_sends} / ${u.monthly_limit} sends &nbsp;&middot;&nbsp; resets in ${daysUntilReset} day${daysUntilReset===1?'':'s'}</div>
    </div>
    <div class="main-body"><div id="send-body"></div></div>`;
  renderQuickSend(document.getElementById('send-body'));
}

function renderContactsPage(main) {
  main.innerHTML = `
    <div class="main-header"><h2>Contact Lists</h2></div>
    <div class="main-body"><div id="send-body"></div></div>`;
  renderContacts(document.getElementById('send-body'));
}

function renderTemplatesPage(main) {
  main.innerHTML = `
    <div class="main-header"><h2>Message Templates</h2></div>
    <div class="main-body"><div id="send-body"></div></div>`;
  renderTemplatesTab(document.getElementById('send-body'));
}

function renderSuppressionPage(main) {
  main.innerHTML = `
    <div class="main-header">
      <h2>Suppression List</h2>
      <div style="font-size:13px;color:var(--text-muted)">Numbers on this list are automatically skipped during bulk sends.</div>
    </div>
    <div class="main-body"><div id="send-body"></div></div>`;
  renderSuppressionTab(document.getElementById('send-body'));
}

async function renderHistoryPage(main) {
  main.innerHTML = `
    <div class="main-header"><h2>Send History</h2></div>
    <div class="main-body"><div id="send-body"></div></div>`;
  renderHistoryTab(document.getElementById('send-body'));
  // Ensure fresh data after navigation (renderHistoryTab loads once; this catches in-flight jobs)
  setTimeout(() => loadCampaignHistory(), 600);
}

async function checkCompanionBanner() {
  if (window.electronAPI?.isDesktop) return; // Desktop app sends automatically — no companion needed
  const el = document.getElementById('companion-status-banner');
  if (!el) return;
  try {
    const keys = await get('/api/keys');
    const activeKey = keys.find(k => k.active);
    if (!activeKey) return;
    const lastUsed = activeKey.last_used_at;
    const secsAgo = lastUsed ? (Date.now() - new Date(lastUsed + 'Z').getTime()) / 1000 : Infinity;
    if (secsAgo > 90) {
      el.innerHTML = `<div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:10px 16px;margin:0 0 12px;font-size:13.5px;display:flex;align-items:center;gap:10px">
        <span style="font-size:16px">&#9888;</span>
        <span><strong>Companion app not connected.</strong> Your messages are queued but won't send until your companion app is open and running.
        <a href="#" onclick="navigate('help');return false" style="color:var(--accent);text-decoration:underline">Go to Help</a> to download it.</span>
      </div>`;
    }
  } catch (e) { /* ignore */ }
}

// ── Test Send ────────────────────────────────────────────────────────────

function renderQuickSend(body) {
  const u = currentUser;
  const remaining = Math.max(0, u.monthly_limit - u.monthly_sends);
  const isBlocked = u.subscription_status === 'cancelled' || u.subscription_status === 'past_due';
  const isMac = window.electronAPI?.platform === 'darwin';
  const isPro = u.is_admin || u.manual_account || u.plan === 'pro';
  const showImageAttach = isMac && isPro;

  body.innerHTML = `
    ${isBlocked ? `<div class="alert alert-error" style="margin-bottom:16px">Your subscription has expired. <button class="btn btn-primary btn-sm" onclick="navigate('billing')">Upgrade now</button></div>` : ''}
    ${!isBlocked && remaining <= 0 ? upgradePrompt(`You've used all ${u.monthly_limit} sends this month.`) : ''}

    <div class="card" style="max-width:640px">
      <div class="card-header"><h3>Test Send</h3></div>
      <div class="card-body">
        <div class="form-row">
          <label>Phone number</label>
          <input type="text" id="qs-phone" placeholder="8015551234" style="max-width:280px" />
        </div>
        <div class="form-row">
          <label style="display:flex;justify-content:space-between;align-items:center">
            <span>Message <span style="font-weight:400;color:var(--text-muted)">${showImageAttach ? '(optional if attaching image)' : ''}</span></span>
            ${currentUser.templates ? `<a href="#" style="font-size:12px;color:var(--accent);text-decoration:underline;font-weight:500" onclick="loadTemplateIntoTextarea('qs-message');return false">Load template</a>` : ''}
          </label>
          <textarea id="qs-message" rows="4" placeholder="Type your message here..."></textarea>
          ${emojiBarHtml('qs-message')}
          <div class="char-count" id="qs-char">0 chars &middot; 1 segment</div>
        </div>
        ${showImageAttach ? `
        <div class="form-row">
          <label style="display:flex;align-items:center;gap:8px">
            Attach image
            <span style="font-size:11px;background:#C44A76;color:#fff;padding:2px 7px;border-radius:10px;font-weight:600;letter-spacing:.03em">PRO</span>
            <span style="font-size:12px;color:var(--text-muted)">JPG, PNG, GIF, WEBP · max 2 MB · Mac only</span>
          </label>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <label class="btn btn-ghost btn-sm" style="cursor:pointer;margin:0">
              Choose image
              <input type="file" id="qs-image-file" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none" />
            </label>
            <span id="qs-image-name" style="font-size:13px;color:var(--text-muted)">No image selected</span>
            <button id="qs-image-clear" style="display:none;background:none;border:none;color:var(--danger);cursor:pointer;font-size:13px;padding:0">Remove</button>
          </div>
          <div id="qs-image-preview" style="margin-top:8px"></div>
          <div id="qs-image-error" style="color:var(--danger);font-size:12.5px;margin-top:4px"></div>
        </div>` : ''}
        <div style="display:flex;align-items:center;gap:12px">
          <button class="btn btn-primary" id="qs-send" ${isBlocked?'disabled':''}>Send</button>
          <div id="qs-result" style="font-size:13px">${remaining<=0&&!isBlocked?'<span style="color:var(--text-muted);font-size:12px">Test sends don\'t count against your monthly limit.</span>':''}</div>
        </div>
      </div>
    </div>`;

  const msgEl = document.getElementById('qs-message');
  const charEl = document.getElementById('qs-char');
  msgEl.addEventListener('input', () => {
    const len = msgEl.value.length;
    const segs = Math.ceil(len / 160) || 1;
    charEl.textContent = `${len} chars · ${segs} segment${segs>1?'s':''}`;
    charEl.className = 'char-count' + (len > 306 ? ' char-danger' : len > 160 ? ' char-warn' : '');
  });

  let qsImageFile = null;
  let qsImageName = null;

  if (showImageAttach) {
    const fileInput = document.getElementById('qs-image-file');
    const nameEl = document.getElementById('qs-image-name');
    const clearBtn = document.getElementById('qs-image-clear');
    const previewEl = document.getElementById('qs-image-preview');
    const errEl = document.getElementById('qs-image-error');

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      errEl.textContent = '';
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        errEl.textContent = 'Image must be 2 MB or smaller.';
        fileInput.value = '';
        return;
      }
      qsImageFile = file;
      nameEl.textContent = file.name;
      clearBtn.style.display = 'inline';
      const reader = new FileReader();
      reader.onload = e => { previewEl.innerHTML = `<img src="${e.target.result}" style="max-height:120px;max-width:280px;border-radius:6px;border:1px solid #e5e7eb">` };
      reader.readAsDataURL(file);
    });

    clearBtn.addEventListener('click', () => {
      qsImageFile = null;
      qsImageName = null;
      fileInput.value = '';
      nameEl.textContent = 'No image selected';
      clearBtn.style.display = 'none';
      previewEl.innerHTML = '';
      errEl.textContent = '';
    });
  }

  document.getElementById('qs-send').addEventListener('click', async () => {
    const phone = document.getElementById('qs-phone').value.trim();
    const message = msgEl.value.trim();
    const resultEl = document.getElementById('qs-result');
    const btn = document.getElementById('qs-send');
    if (!phone) { resultEl.innerHTML = '<span style="color:var(--danger)">Phone number is required.</span>'; return; }
    if (!message && !qsImageFile) { resultEl.innerHTML = '<span style="color:var(--danger)">Message or image is required.</span>'; return; }

    showSendConfirmModal(
      phone, message || '(image only)', 1,
      async () => {
        btn.disabled = true;
        resultEl.innerHTML = 'Sending...';
        try {
          let imageName = null;
          if (qsImageFile) {
            const fd = new FormData();
            fd.append('image', qsImageFile);
            const upResp = await fetch('/api/upload-image', { method: 'POST', body: fd });
            const upJson = await upResp.json();
            if (!upResp.ok) throw new Error(upJson.error || 'Image upload failed');
            imageName = upJson.imageName;
          }
          await post('/api/send-one', { phone, message: message || '', imageName, test: true });
          const successMsg = window.electronAPI?.isDesktop
            ? '&#10003; Queued — sending within the next few seconds.'
            : '&#10003; Queued — your companion app will send it shortly.';
          resultEl.innerHTML = `<span style="color:var(--success)">${successMsg}</span>`;
          document.getElementById('qs-phone').value = '';
          msgEl.value = '';
          charEl.textContent = '0 chars · 1 segment';
          charEl.className = 'char-count';
          if (showImageAttach) {
            qsImageFile = null; qsImageName = null;
            document.getElementById('qs-image-file').value = '';
            document.getElementById('qs-image-name').textContent = 'No image selected';
            document.getElementById('qs-image-clear').style.display = 'none';
            document.getElementById('qs-image-preview').innerHTML = '';
          }
          currentUser = await get('/api/auth/me');
          updateUserBadge();
        } catch (err) {
          if (err.data && err.data.upgrade) {
            resultEl.innerHTML = `<span style="color:var(--danger)">${escHtml(err.message)} <button class="btn btn-primary btn-sm" onclick="navigate('billing')">Upgrade</button></span>`;
          } else {
            resultEl.innerHTML = `<span style="color:var(--danger)">${escHtml(err.message)}</span>`;
          }
          btn.disabled = isBlocked;
        }
      }
    );
  });
}

// ── Send confirmation modal — Change 9 ────────────────────────────────────

// showSendConfirmModal — previewRows is array of {phone, mergedBody, hasEmptyMerge} objects, or null for quick send
function showSendConfirmModal(previewContact, previewMessage, count, onConfirm, previewRows, opts = {}) {
  const root = document.getElementById('wizard-root');
  const overlay = document.createElement('div');
  overlay.className = 'wizard-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) root.innerHTML = ''; });

  const modal = document.createElement('div');
  modal.className = 'confirm-modal';

  const showWarning = count > 200;
  const { freeTruncated, freeTruncatedFrom, imageName } = opts;

  // Build preview rows HTML — show up to 10, scrollable, highlight empty merge fields
  let previewHtml = '';
  if (previewRows && previewRows.length) {
    const rows = previewRows.slice(0, 10);
    const moreCount = count - rows.length;
    previewHtml = `<div style="max-height:220px;overflow-y:auto;padding-right:4px">` +
      rows.map((r, i) => {
        const bodyHtml = escHtml(r.body || r).replace(/\[EMPTY_MERGE\]/g, '<mark style="background:#fef08a;border-radius:2px;padding:0 2px">(empty)</mark>');
        return `<div style="margin-bottom:${i < rows.length - 1 ? '10px' : '0'}">
          ${r.phone ? `<div style="font-size:11.5px;color:var(--text-muted);margin-bottom:3px">To: ${escHtml(r.phone)}</div>` : ''}
          <div class="confirm-preview" style="margin-bottom:0">${bodyHtml}</div>
        </div>`;
      }).join('') +
      `</div>` +
      (moreCount > 0 ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">…and ${moreCount} more contact${moreCount===1?'':'s'}</div>` : '');
  } else {
    previewHtml = `<div class="confirm-preview">${escHtml(typeof previewMessage === 'string' ? previewMessage : '')}</div>`;
  }

  modal.innerHTML = `
    <h2 style="font-size:17px;font-weight:700;margin-bottom:4px">Ready to send?</h2>
    <div style="font-size:13.5px;color:var(--text-muted);margin-bottom:14px">Sending to <strong style="color:var(--text)">${freeTruncated ? 'up to ' : ''}${count} contact${count===1?'':'s'}</strong>${freeTruncated ? ` <span style="color:var(--warning,#b45309)">(Free plan: first ${count} of ${freeTruncatedFrom})</span>` : ''}</div>
    ${freeTruncated ? `<div class="alert alert-warn" style="margin-bottom:12px">Free plan sends are limited to <strong>${count} contacts</strong>. Only the first ${count} contacts in your list will receive this message. <button class="btn btn-primary btn-sm" onclick="document.getElementById('wizard-root').innerHTML='';navigate('billing')">Upgrade for the full list</button></div>` : ''}
    ${imageName ? `<div style="font-size:13px;margin-bottom:10px;padding:8px 10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;color:var(--text)">&#128206; <strong>Attachment:</strong> ${escHtml(imageName)}</div>` : ''}
    ${previewHtml ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Message preview</div>${previewHtml}` : ''}
    ${showWarning ? `<div class="alert alert-warn" style="margin:12px 0 0">Sending to ${count} contacts. We recommend no more than 200/day to keep your number healthy.</div>` : ''}
    <div id="confirm-app-warn" style="display:none" class="alert alert-error" style="margin:10px 0 0"></div>
    ${window.electronAPI?.platform === 'darwin'
      ? `<div style="background:var(--bg-alt,#f7f7f7);border-radius:8px;padding:12px 14px;margin:14px 0 0;font-size:13px;color:var(--text-muted);line-height:1.7">
          Be sure <strong style="color:var(--text)">Messages</strong> is open on your Mac before sending.
         </div>`
      : `<div style="background:var(--bg-alt,#f7f7f7);border-radius:8px;padding:12px 14px;margin:14px 0 0">
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;user-select:none">
            <input type="checkbox" id="phonelink-confirm" style="margin-top:2px;flex-shrink:0;width:16px;height:16px;cursor:pointer">
            <span style="font-size:13px;color:var(--text);line-height:1.5">
              <strong>Phone Link</strong> is open and my phone is nearby.
              <a href="#" id="phonelink-help-link" style="color:var(--primary,#C44A76);margin-left:4px">Need help?</a>
            </span>
          </label>
          <div style="font-size:12px;color:var(--text-muted);margin-top:10px;padding-top:10px;border-top:1px solid var(--border,#e5e7eb);line-height:1.5">
            While sending, keep Phone Link in the foreground and avoid touching your keyboard, mouse, or the Phone Link window.
          </div>
         </div>`}
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-ghost" id="confirm-cancel">Cancel</button>
      <button class="btn btn-primary" id="confirm-send"${window.electronAPI?.platform !== 'darwin' ? ' disabled' : ''}>Send</button>
    </div>`;

  overlay.appendChild(modal);
  root.appendChild(overlay);

  document.getElementById('confirm-cancel').addEventListener('click', () => root.innerHTML = '');

  // Windows only: enable Send only after Phone Link checkbox is checked
  const phoneLinkCheck = document.getElementById('phonelink-confirm');
  if (phoneLinkCheck) {
    phoneLinkCheck.addEventListener('change', () => {
      document.getElementById('confirm-send').disabled = !phoneLinkCheck.checked;
    });
  }
  const phoneLinkHelpLink = document.getElementById('phonelink-help-link');
  if (phoneLinkHelpLink) {
    phoneLinkHelpLink.addEventListener('click', e => {
      e.preventDefault();
      if (window.electronAPI?.openExternal) window.electronAPI.openExternal('https://textyourlist.com/help-windows');
    });
  }

  document.getElementById('confirm-send').addEventListener('click', async () => {
    const sendBtn = document.getElementById('confirm-send');
    const warnEl = document.getElementById('confirm-app-warn');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Checking…';

    // Pre-check messaging app is running (desktop only)
    if (window.electronAPI?.isDesktop) {
      try {
        const isMac = window.electronAPI.platform === 'darwin';
        const isRunning = isMac
          ? await window.electronAPI.checkMessagesRunning()
          : await window.electronAPI.checkPhoneLinkRunning();
        if (!isRunning) {
          const appName = isMac ? 'Messages' : 'Phone Link';
          warnEl.textContent = `${appName} is not open. Open it now, then click Send.`;
          warnEl.style.display = 'block';
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send';
          return;
        }
      } catch {
        // IPC check failed — reset button state and proceed; send loop will handle it
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
      }
    }

    root.innerHTML = '';
    onConfirm();
  });
}

// ── Load template modal (shared by Test Send and Bulk Send) ───────────────

async function loadTemplateIntoTextarea(textareaId) {
  if (!currentUser.templates) {
    // No template access — show upgrade nudge
    const root = document.getElementById('wizard-root');
    const overlay = document.createElement('div');
    overlay.className = 'wizard-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) root.innerHTML = ''; });
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.innerHTML = `
      <h2 style="font-size:17px;font-weight:700;margin-bottom:12px">Templates</h2>
      <p style="color:var(--text-muted);font-size:13.5px;margin-bottom:16px">Saved templates require Starter or Pro plan.</p>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn btn-ghost" onclick="document.getElementById('wizard-root').innerHTML=''">Cancel</button>
        <button class="btn btn-primary" onclick="document.getElementById('wizard-root').innerHTML='';navigate('billing')">Upgrade</button>
      </div>`;
    overlay.appendChild(modal);
    root.innerHTML = '';
    root.appendChild(overlay);
    return;
  }

  let templates;
  try { templates = await get('/api/templates'); } catch (e) { return; }

  const root = document.getElementById('wizard-root');
  const overlay = document.createElement('div');
  overlay.className = 'wizard-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) root.innerHTML = ''; });

  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.style.width = '480px';

  if (!templates || !templates.length) {
    // Change 11: show "create first template" option
    modal.innerHTML = `
      <h2 style="font-size:17px;font-weight:700;margin-bottom:12px">Load a template</h2>
      <div style="text-align:center;padding:24px 0;color:var(--text-muted)">
        <div style="font-size:32px;margin-bottom:12px">&#9644;</div>
        <p style="margin-bottom:16px;font-size:13.5px">You haven't saved any templates yet.</p>
        <button class="btn btn-primary" onclick="document.getElementById('wizard-root').innerHTML='';navigate('templates');setTimeout(()=>openTemplateEditor(),100)">+ Create your first template</button>
      </div>
      <div style="text-align:right;margin-top:16px">
        <button class="btn btn-ghost" onclick="document.getElementById('wizard-root').innerHTML=''">Cancel</button>
      </div>`;
  } else {
    modal.innerHTML = `
      <h2 style="font-size:17px;font-weight:700;margin-bottom:16px">Load a template</h2>
      <div style="display:flex;flex-direction:column;gap:10px;max-height:340px;overflow-y:auto;margin-bottom:20px">
        ${templates.map(t => `
          <div class="card" style="padding:12px 14px;cursor:pointer;border:1px solid var(--border)" onclick="applyTemplate(${t.id},'${textareaId}')">
            <div style="font-weight:600;font-size:13.5px">${escHtml(t.name)}</div>
            <div style="font-size:12.5px;color:var(--text-muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.body)}</div>
          </div>`).join('')}
      </div>
      <div style="text-align:right">
        <button class="btn btn-ghost" onclick="document.getElementById('wizard-root').innerHTML=''">Cancel</button>
      </div>`;
  }

  overlay.appendChild(modal);
  root.innerHTML = '';
  root.appendChild(overlay);

  window._templateApplyTarget = textareaId;
  window._templateList = templates;
}

function applyTemplate(id, textareaId) {
  const templates = window._templateList || [];
  const t = templates.find(x => x.id === id);
  if (!t) return;
  const ta = document.getElementById(textareaId);
  if (ta) {
    ta.value = t.body;
    ta.dispatchEvent(new Event('input'));
  }
  document.getElementById('wizard-root').innerHTML = '';
}

// ── Bulk Send tab ─────────────────────────────────────────────────────────

async function renderBulkSend(body) {
  const u = currentUser;
  // All plans can use bulk send; free plan limited to 10 contacts per send
  const isFree = u.plan === 'free' && !u.is_admin && !u.manual_account;
  const bulkMax = u.bulk_max_contacts || (isFree ? 10 : Infinity);
  const isMac = window.electronAPI?.platform === 'darwin';
  const isPro = u.is_admin || u.manual_account || u.plan === 'pro';
  const showImageAttach = isMac && isPro;

  let savedLists = [];
  try { savedLists = await get('/api/lists'); } catch (_) {}

  // Health monitor data
  const dailySends = u.daily_sends || 0;
  const healthColor = dailySends <= 100 ? '#16a34a' : dailySends <= 150 ? '#d97706' : '#dc2626';
  const healthLabel = dailySends <= 100 ? '' : dailySends <= 150 ? 'Caution' : 'Warning';
  const healthPct = Math.min(100, Math.round(dailySends / 200 * 100));

  body.innerHTML = `
    <div style="max-width:700px">
      <!-- Daily Health Monitor -->
      <div id="bs-health-monitor" style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:14px">
        <div id="bs-health-dot" style="width:12px;height:12px;border-radius:50%;background:${healthColor};flex-shrink:0;box-shadow:0 0 6px ${healthColor}55"></div>
        <div style="flex:1">
          <div style="font-size:12.5px;font-weight:600;color:var(--text)">Today: <span id="bs-health-text">${dailySends} / 200 bulk messages${healthLabel ? ` <span style="font-weight:400;color:${healthColor}">${healthLabel}</span>` : ''}</span>
            <span class="daily-info-icon" title="We recommend no more than 200 bulk sends per day to protect your number from spam filters. Personalizing messages with merge fields (e.g. {first_name}) also helps. Test sends don't count toward this limit." style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#e5e7eb;color:#6b7280;font-size:10px;font-weight:700;cursor:default;margin-left:5px;vertical-align:middle">i</span>
          </div>
          <div style="background:#f3f4f6;border-radius:4px;height:5px;margin-top:5px;overflow:hidden">
            <div id="bs-health-bar" style="height:100%;width:${healthPct}%;background:${healthColor};border-radius:4px;transition:width 0.3s"></div>
          </div>
        </div>
        <div id="bs-health-remaining" style="font-size:11px;color:var(--text-muted);text-align:right;flex-shrink:0">${Math.max(0, 200 - dailySends)} left today</div>
      </div>
      ${isFree ? `<div class="alert alert-info" style="margin-bottom:16px">Free plan: bulk sends are limited to <strong>10 contacts</strong> per send. <button class="btn btn-primary btn-sm" onclick="navigate('billing')">Upgrade for more</button></div>` : ''}

      <!-- Section 1: Choose contacts -->
      <div class="card" style="margin-bottom:20px;padding:20px">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:16px">1. Choose your contacts</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.4px">Upload a new list</div>
            <div class="drop-zone" id="bs-dz" style="padding:24px 16px">
              <div class="dz-icon" style="font-size:22px;margin-bottom:8px">&#128196;</div>
              <p><strong>Drop CSV here</strong></p>
              <p style="margin-top:4px;font-size:12px"><span style="text-decoration:underline;cursor:pointer" id="bs-browse">browse</span></p>
            </div>
            <input type="file" id="bs-file" accept=".csv" style="display:none" />
            <div style="margin-top:6px;font-size:12px;color:var(--text-muted)">
              Need a template? <a href="/api/csv-template" download style="color:var(--accent);text-decoration:underline">Download CSV template</a>
            </div>
            <div id="bs-upload-result" style="margin-top:8px"></div>
          </div>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.4px">Use a saved list</div>
            ${savedLists.length
              ? `<select id="bs-saved-list" style="margin-bottom:8px">
                  <option value="">-- Select a list --</option>
                  ${savedLists.map(l => `<option value="${l.id}">${escHtml(l.name)} (${l.row_count})</option>`).join('')}
                </select>
                <button class="btn btn-ghost btn-sm" id="bs-load-list">Load list</button>`
              : `<p style="color:var(--text-muted);font-size:13px">No saved lists yet. Upload one from the Contacts tab first.</p>`}
          </div>
        </div>
        <div id="bs-csv-status" style="margin-top:12px"></div>
      </div>

      <!-- Section 2: Write message -->
      <div class="card" style="margin-bottom:20px;padding:20px">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:16px">2. Write your message</h3>
        <div class="form-row">
          <label style="display:flex;justify-content:space-between;align-items:center">
            <span>Message</span>
            ${u.templates ? `<a href="#" style="font-size:12px;color:var(--accent);text-decoration:underline;font-weight:500" onclick="loadTemplateIntoTextarea('bs-message');return false">Load template</a>` : ''}
          </label>
          ${mergeChipsHtml('bs-message')}
          <textarea id="bs-message" rows="4" placeholder="Hi {first_name}, just wanted to reach out..."></textarea>
          ${emojiBarHtml('bs-message')}
          <div class="char-count" id="bs-char">0 chars &middot; 1 segment</div>
          <div id="bs-merge-warning" style="display:none;margin-top:6px;padding:8px 12px;background:#fef3c7;border:1px solid #fbbf24;border-radius:6px;font-size:13px;color:#92400e"></div>
          <div id="bs-identical-warn" class="alert alert-warn" style="display:none;margin-top:8px;margin-bottom:0">&#9888; This message is identical for every recipient. Add a merge field like {first_name} for better delivery rates and to avoid spam filters.</div>
          <div id="bs-personalization-nudge" style="display:none;margin-top:8px;background:#fef9c3;border:1px solid #fbbf24;border-radius:8px;padding:10px 14px;font-size:13px">
            &#128161; <strong>Tip:</strong> Adding a name like <code>{first_name}</code> makes each text feel personal and dramatically improves response rates.
            <a href="#" style="color:#92400e;margin-left:6px;text-decoration:underline" onclick="document.getElementById('bs-personalization-nudge').style.display='none';return false">Got it</a>
          </div>
          <div id="bs-live-preview" style="display:none;margin-top:10px;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">
            <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Sample preview</div>
            <div id="bs-live-preview-text" style="font-size:13.5px;color:var(--text);white-space:pre-wrap;word-break:break-word"></div>
          </div>
          <div style="margin-top:10px">
            <a href="#" id="bs-save-template-link" style="font-size:12.5px;color:var(--accent);text-decoration:underline" onclick="saveBulkMessageAsTemplate();return false">Save as new template</a>
            <span id="bs-save-template-check" style="display:none;color:#16a34a;font-size:12.5px;margin-left:8px">&#10003; Saved to your templates</span>
          </div>
        </div>
        ${showImageAttach ? `
        <div class="form-row" style="margin-top:16px">
          <label style="display:flex;align-items:center;gap:8px">
            Attach image
            <span style="font-size:11px;background:#C44A76;color:#fff;padding:2px 7px;border-radius:10px;font-weight:600;letter-spacing:.03em">PRO</span>
            <span style="font-size:12px;color:var(--text-muted)">JPG, PNG, GIF, WEBP · max 2 MB · Mac only</span>
          </label>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <label class="btn btn-ghost btn-sm" style="cursor:pointer;margin:0">
              Choose image
              <input type="file" id="bs-image-file" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none" />
            </label>
            <span id="bs-image-name" style="font-size:13px;color:var(--text-muted)">No image selected</span>
            <button id="bs-image-clear" style="display:none;background:none;border:none;color:var(--danger);cursor:pointer;font-size:13px;padding:0">Remove</button>
          </div>
          <div id="bs-image-preview" style="margin-top:8px"></div>
          <div id="bs-image-error" style="color:var(--danger);font-size:12.5px;margin-top:4px"></div>
        </div>` : ''}
      </div>

      <!-- Section 3: Send settings -->
      <div class="card" style="margin-bottom:20px;padding:20px">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:16px">3. Send settings</h3>
        <div class="form-row">
          <label>Campaign name</label>
          <input type="text" id="bs-campaign-name" placeholder="e.g. April event invite" />
        </div>
        <div class="form-row">
          <label>Send speed</label>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">
            <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;text-transform:none;letter-spacing:0;font-weight:400;margin:0;color:var(--text)">
              <input type="radio" name="bs-pace" id="bs-pace-instant" value="0" checked style="margin-top:3px;flex-shrink:0" />
              <div>
                <div style="font-weight:600;font-size:13.5px">Fast <span style="font-weight:400;color:var(--text-muted)">— sends each text as quickly as your system allows</span></div>
                <div style="font-size:12px;color:var(--text-muted);font-weight:400">Typically 3–5 seconds per message. Best for warm lists where everyone knows you.</div>
              </div>
            </label>
            <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;text-transform:none;letter-spacing:0;font-weight:400;margin:0;color:var(--text)">
              <input type="radio" name="bs-pace" id="bs-pace-drip" value="7" style="margin-top:3px;flex-shrink:0" />
              <div>
                <div style="font-weight:600;font-size:13.5px">Smart Throttle <span style="font-weight:400;color:var(--text-muted)">— randomized 7–14s delay between sends</span></div>
                <div style="font-size:12px;color:var(--text-muted);font-weight:400">Mimics natural human timing to protect your number. Recommended for larger or newer lists.</div>
              </div>
            </label>
          </div>
          <div id="bs-time-estimate" style="font-size:12.5px;color:var(--text-muted);margin-top:10px"></div>
        </div>
        <div id="bs-new-list-note" style="display:none" class="alert alert-info" style="margin-top:8px">Slow drip recommended for larger or less familiar lists to protect your number.</div>
      </div>

      <!-- Section 4: Preview & Send -->
      <div style="display:flex;gap:12px;align-items:center">
        <button class="btn btn-primary btn-lg" id="bs-preview-send">Preview &amp; Send</button>
        <button class="btn btn-ghost btn-lg" id="bs-save-draft">Save Draft</button>
        <div id="bs-result"></div>
      </div>
      <div id="bs-alert" style="margin-top:12px"></div>

    </div>`;

  // State
  const bsState = { csvRaw: null, csvRows: [], csvColumns: [], columnMap: { phone: '', first_name: '', last_name: '', special: '' }, isNewList: false, totalCount: 0, imageFile: null, imageName: null };

  function showListLoaded(listName, rowCount) {
    document.getElementById('bs-csv-status').innerHTML = `<div class="alert alert-success" style="margin:0;display:flex;justify-content:space-between;align-items:center">&#10003; List "${escHtml(listName)}" loaded — ${rowCount} contacts <button id="bs-saved-clear-btn" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:12px">Change list</button></div>`;
    document.getElementById('bs-saved-clear-btn').addEventListener('click', () => {
      document.getElementById('bs-csv-status').innerHTML = '';
      const sel = document.getElementById('bs-saved-list');
      if (sel) sel.value = '';
      Object.assign(bsState, { csvRaw: null, csvRows: [], csvColumns: [], columnMap: { phone: '', first_name: '', last_name: '', special: '' }, isNewList: false, totalCount: 0 });
      updateEstimate();
    });
  }

  bindMergeChips();

  // Auto-refresh daily send counter every 10 seconds
  const healthPollInterval = setInterval(async () => {
    try {
      const fresh = await get('/api/auth/me');
      const n = fresh.daily_sends || 0;
      const hc = n <= 100 ? '#16a34a' : n <= 150 ? '#d97706' : '#dc2626';
      const hl = n <= 100 ? '' : n <= 150 ? 'Caution' : 'Warning';
      const hp = Math.min(100, Math.round(n / 200 * 100));
      const dot = document.getElementById('bs-health-dot');
      const txt = document.getElementById('bs-health-text');
      const bar = document.getElementById('bs-health-bar');
      const rem = document.getElementById('bs-health-remaining');
      if (!dot) { clearInterval(healthPollInterval); return; }
      dot.style.background = hc;
      dot.style.boxShadow = `0 0 6px ${hc}55`;
      txt.innerHTML = `${n} / 200 bulk messages${hl ? ` <span style="font-weight:400;color:${hc}">${hl}</span>` : ''}`;
      bar.style.width = hp + '%';
      bar.style.background = hc;
      rem.textContent = `${Math.max(0, 200 - n)} left today`;
    } catch (_) {}
  }, 10000);

  if (showImageAttach) {
    const bsFileInput = document.getElementById('bs-image-file');
    const bsNameEl   = document.getElementById('bs-image-name');
    const bsClearBtn = document.getElementById('bs-image-clear');
    const bsPreview  = document.getElementById('bs-image-preview');
    const bsErrEl    = document.getElementById('bs-image-error');

    bsFileInput.addEventListener('change', () => {
      const file = bsFileInput.files[0];
      bsErrEl.textContent = '';
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        bsErrEl.textContent = 'Image must be 2 MB or smaller.';
        bsFileInput.value = '';
        return;
      }
      bsState.imageFile = file;
      bsState.imageName = null;
      bsNameEl.textContent = file.name;
      bsClearBtn.style.display = 'inline';
      const reader = new FileReader();
      reader.onload = e => { bsPreview.innerHTML = `<img src="${e.target.result}" style="max-height:120px;max-width:280px;border-radius:6px;border:1px solid #e5e7eb">`; };
      reader.readAsDataURL(file);
    });

    bsClearBtn.addEventListener('click', () => {
      bsState.imageFile = null;
      bsState.imageName = null;
      bsFileInput.value = '';
      bsNameEl.textContent = 'No image selected';
      bsClearBtn.style.display = 'none';
      bsPreview.innerHTML = '';
      bsErrEl.textContent = '';
    });
  }

  // If navigated here via "Send" from Contacts page, auto-load that list
  if (window.pendingBulkListId) {
    const pendingId = window.pendingBulkListId;
    window.pendingBulkListId = null;
    (async () => {
      try {
        const list = await get(`/api/lists/${pendingId}`);
        bsState.csvRaw = list.csv_data;
        bsState.csvColumns = list.columns;
        bsState.csvRows = [];
        bsState.isNewList = false;
        bsState.totalCount = list.row_count || 0;
        try {
          const lines = list.csv_data.trim().split('\n');
          const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g,''));
          bsState.csvRows = lines.slice(1, 4).map(l => {
            const vals = l.split(',');
            const obj = {};
            headers.forEach((h,i) => obj[h] = (vals[i]||'').trim().replace(/^"|"$/g,''));
            return obj;
          });
        } catch (_) {}
        autoDetectColumns(bsState);
        showListLoaded(list.name, list.row_count);
        updateMergeChips('bs-message', bsState.columnMap);
        refreshBsPreview();
        const nameEl = document.getElementById('bs-campaign-name');
        if (nameEl && !nameEl.value) nameEl.value = list.name + ' — ' + new Date().toLocaleDateString();
        updateEstimate();
      } catch (err) {
        showToast('Error loading list: ' + err.message);
      }
    })();
  }

  // Save message as template inline
  window.saveBulkMessageAsTemplate = async function() {
    const body = document.getElementById('bs-message')?.value?.trim();
    if (!body) { showToast('Write a message first before saving as a template.'); return; }
    const name = prompt('Template name:', 'My template ' + new Date().toLocaleDateString());
    if (!name) return;
    try {
      await api('POST', '/api/templates', { name, body });
      const link = document.getElementById('bs-save-template-link');
      const check = document.getElementById('bs-save-template-check');
      if (link) link.style.display = 'none';
      if (check) { check.style.display = 'inline'; setTimeout(() => { if(check) check.style.display='none'; if(link) link.style.display='inline'; }, 3000); }
    } catch (err) {
      showToast('Could not save template: ' + (err.message || 'error'));
    }
  };

  // Character count + identical warning
  const msgEl = document.getElementById('bs-message');
  const charEl = document.getElementById('bs-char');

  function refreshBsPreview() {
    const warn = document.getElementById('bs-identical-warn');
    if (warn) warn.style.display = msgEl.value.includes('{') || !msgEl.value.trim() ? 'none' : 'block';

    const nudgeEl = document.getElementById('bs-personalization-nudge');
    if (nudgeEl) nudgeEl.style.display = msgEl.value.trim() && !msgEl.value.includes('{') ? 'block' : 'none';

    // Live preview — show merged sample using first loaded contact row
    const previewEl = document.getElementById('bs-live-preview');
    const previewText = document.getElementById('bs-live-preview-text');
    const tmpl = msgEl.value;
    if (previewEl && previewText && tmpl.trim()) {
      const sampleRow = (bsState.csvRows || [])[0] || {};
      const cm = bsState.columnMap || {};
      let preview = tmpl.replace(/\{(\w+)\}/g, (m, token) => {
        if (cm[token] && sampleRow[cm[token]] !== undefined) return sampleRow[cm[token]];
        if (sampleRow[token] !== undefined) return sampleRow[token];
        return m;
      });
      previewText.textContent = preview;
      previewEl.style.display = tmpl.includes('{') || Object.keys(sampleRow).length ? 'block' : 'none';
    } else if (previewEl) {
      previewEl.style.display = 'none';
    }
  }

  msgEl.addEventListener('input', () => {
    const len = msgEl.value.length;
    const segs = Math.ceil(len / 160) || 1;
    charEl.textContent = `${len} chars · ${segs} segment${segs>1?'s':''}`;
    charEl.className = 'char-count' + (len > 306 ? ' char-danger' : len > 160 ? ' char-warn' : '');
    refreshBsPreview();
    // Merge field mismatch warning
    const mergeWarnEl = document.getElementById('bs-merge-warning');
    if (mergeWarnEl && bsState.columnMap) {
      const tokens = [...msgEl.value.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
      const missing = tokens.filter(t => !(t in bsState.columnMap));
      if (missing.length) {
        mergeWarnEl.style.display = 'block';
        mergeWarnEl.textContent = `Warning: ${missing.map(t => '{'+t+'}').join(', ')} ${missing.length===1?'is':'are'} not in your contact list — will send as literal text.`;
      } else {
        mergeWarnEl.style.display = 'none';
      }
    }
  });

  // Pace + estimate
  function getPace() {
    const checked = document.querySelector('input[name="bs-pace"]:checked');
    return checked ? parseInt(checked.value) : 20;
  }
  function updateEstimate() {
    const count = bsState.totalCount || bsState.csvRows.length;
    const pace = getPace();
    const est = document.getElementById('bs-time-estimate');
    if (!est) return;
    if (!count) { est.textContent = ''; return; }
    if (pace === 0) {
      const approxMin = Math.round(count * 5 / 60 * 10) / 10;
      est.textContent = `${count} contacts — roughly ${approxMin < 1 ? Math.round(count * 5) + ' sec' : approxMin + ' min'} estimated`;
      return;
    }
    const totalSec = count * pace;
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    const timeStr = mins > 0 ? `${mins} min${secs > 0 ? ' ' + secs + ' sec' : ''}` : `${secs} sec`;
    est.textContent = `${count} contacts at ${pace}s each — estimated ${timeStr} to deliver`;
  }
  document.querySelectorAll('input[name="bs-pace"]').forEach(r => r.addEventListener('change', updateEstimate));

  // CSV upload
  const dz = document.getElementById('bs-dz');
  const fi = document.getElementById('bs-file');
  document.getElementById('bs-browse').addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { if (fi.files[0]) handleBsFile(fi.files[0]); });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleBsFile(e.dataTransfer.files[0]);
  });

  async function handleBsFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const data = await api('POST', '/api/upload', fd, true);
      bsState.csvRaw = data.raw;
      bsState.csvRows = data.rows;
      bsState.csvColumns = data.columns;
      bsState.isNewList = true;
      bsState.totalCount = data.total || data.rows.length;
      autoDetectColumns(bsState);

      // Build upload status messages
      const warnings = [];
      if (data.no_phone_column) {
        warnings.push(`<div class="alert alert-error" style="margin:6px 0 0">No phone column found. Name your phone column <strong>phone</strong>, <strong>mobile</strong>, <strong>cell</strong>, or <strong>number</strong> and re-upload.</div>`);
      }
      if (data.duplicate_count > 0) {
        warnings.push(`<div class="alert alert-warn" style="margin:6px 0 0">&#9888; This list contains <strong>${data.duplicate_count} duplicate phone number${data.duplicate_count===1?'':'s'}</strong>. Duplicates will be skipped automatically at send time.</div>`);
      }
      if (isFree && data.total > bulkMax) {
        warnings.push(`<div class="alert alert-warn" style="margin:6px 0 0">Free plan sends up to <strong>${bulkMax} contacts</strong>. Your list has ${data.total} — only the first ${bulkMax} will be sent. <button class="btn btn-primary btn-sm" onclick="navigate('billing')">Upgrade</button></div>`);
      }

      document.getElementById('bs-upload-result').innerHTML = `<div class="alert alert-success" style="margin:0;display:flex;justify-content:space-between;align-items:center">&#10003; ${data.total} contacts loaded <button id="bs-clear-btn" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:12px">Change list</button></div>${warnings.join('')}`;
      document.getElementById('bs-clear-btn').addEventListener('click', () => {
        document.getElementById('bs-upload-result').innerHTML = '';
        document.getElementById('bs-csv-status').innerHTML = '';
        document.getElementById('bs-file').value = '';
        Object.assign(bsState, { csvRaw: null, csvRows: [], csvColumns: [], columnMap: { phone: '', first_name: '', last_name: '', special: '' }, isNewList: false });
      });
      document.getElementById('bs-csv-status').innerHTML = `<div style="font-size:13px;color:var(--text-muted)">Columns: ${data.columns.map(c => `<code title="${escHtml(c)}" style="font-family:var(--mono);font-size:12px;background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px">${escHtml(abbreviateColumnLabel(c))}</code>`).join(', ')}</div>`;
      updateMergeChips('bs-message', bsState.columnMap);
      document.getElementById('bs-new-list-note').style.display = 'none';
      refreshBsPreview();
      // Auto-fill campaign name
      const nameEl = document.getElementById('bs-campaign-name');
      if (nameEl && !nameEl.value) nameEl.value = file.name.replace(/\.csv$/i,'') + ' — ' + new Date().toLocaleDateString();
      updateEstimate();
    } catch (err) {
      document.getElementById('bs-upload-result').innerHTML = `<div class="alert alert-error" style="margin:0">${escHtml(err.message)}</div>`;
    }
  }

  // Load saved list
  const loadListBtn = document.getElementById('bs-load-list');
  if (loadListBtn) {
    loadListBtn.addEventListener('click', async () => {
      const listId = document.getElementById('bs-saved-list').value;
      if (!listId) return;
      try {
        const list = await get(`/api/lists/${listId}`);
        const { parse } = { parse: (raw) => { /* minimal parse */ const lines = raw.trim().split('\n'); const headers = lines[0].split(','); return lines.slice(1).map(l => { const vals = l.split(','); const obj = {}; headers.forEach((h,i) => obj[h.trim()] = (vals[i]||'').trim()); return obj; }); } };
        bsState.csvRaw = list.csv_data;
        bsState.csvColumns = list.columns;
        bsState.csvRows = [];
        bsState.isNewList = false;
        bsState.totalCount = list.row_count || 0;
        // Parse first few rows for preview
        try {
          const lines = list.csv_data.trim().split('\n');
          const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g,''));
          bsState.csvRows = lines.slice(1, 4).map(l => {
            const vals = l.split(',');
            const obj = {};
            headers.forEach((h,i) => obj[h] = (vals[i]||'').trim().replace(/^"|"$/g,''));
            return obj;
          });
        } catch (_) {}
        autoDetectColumns(bsState);
        showListLoaded(list.name, list.row_count);
        updateMergeChips('bs-message', bsState.columnMap);
        const nameEl = document.getElementById('bs-campaign-name');
        refreshBsPreview();
        if (nameEl && !nameEl.value) nameEl.value = list.name + ' — ' + new Date().toLocaleDateString();
        updateEstimate();
      } catch (err) {
        showToast('Error loading list: ' + err.message);
      }
    });
  }

  function autoDetectColumns(state) {
    if (!state.csvColumns) return;
    const cols = state.csvColumns;
    // Detect phone column — do not offer as a merge field
    const phoneCol = cols.find(c => /phone|mobile|cell|number/i.test(c)) || cols[0] || '';
    state.columnMap = { phone: phoneCol };
    // Every other column becomes a merge token (sanitized to alphanumeric + underscore)
    for (const col of cols) {
      if (col === phoneCol) continue;
      const token = sanitizeToken(col);
      if (token) state.columnMap[token] = col;
    }
  }

  // Preview & Send
  document.getElementById('bs-preview-send').addEventListener('click', () => submitBulk(true));
  document.getElementById('bs-save-draft').addEventListener('click', () => submitBulk(false));

  async function submitBulk(queueNow) {
    const name = document.getElementById('bs-campaign-name').value.trim();
    const template = msgEl.value.trim();
    const pace = getPace();
    const alertEl = document.getElementById('bs-alert');

    if (!bsState.csvRaw) { alertEl.innerHTML = '<div class="alert alert-error">Please upload a contact list or load a saved list.</div>'; return; }
    if (!bsState.columnMap.phone) { alertEl.innerHTML = '<div class="alert alert-error">No phone column detected. Check your CSV.</div>'; return; }
    if (!template) { alertEl.innerHTML = '<div class="alert alert-error">Message cannot be empty.</div>'; return; }
    if (!name) { alertEl.innerHTML = '<div class="alert alert-error">Campaign name is required.</div>'; return; }

    // Personalization nudge — soft warning if no merge fields and sending to multiple contacts
    const hasPersonalization = /\{[\w_]+\}/.test(template);
    if (!hasPersonalization && queueNow) {
      const nudgeEl = document.getElementById('bs-personalization-nudge');
      if (nudgeEl) nudgeEl.style.display = 'block';
      // Don't block — just nudge. User can proceed.
    }

    if (queueNow) {
      // Count rows
      const lines = bsState.csvRaw.trim().split('\n');
      const totalInList = lines.slice(1).filter(l => l.trim()).length;

      // Monthly limit check (hard block)
      const remaining = currentUser.remaining_sends ?? (currentUser.monthly_limit - currentUser.monthly_sends);
      if (typeof remaining === 'number' && totalInList > remaining) {
        alertEl.innerHTML = `<div class="alert alert-warn">You have <strong>${remaining} sends</strong> left this month, but your list has <strong>${totalInList} contacts</strong>. <button class="btn btn-primary btn-sm" onclick="navigate('billing')">Upgrade for more sends</button> or reduce your list to ${remaining} contacts.</div>`;
        return;
      }

      // Free plan: truncate to bulkMax, show in preview modal (not a hard block)
      const effectiveTotal = (isFree && totalInList > bulkMax) ? bulkMax : totalInList;
      const freeTruncated = isFree && totalInList > bulkMax;

      // Build merged preview for up to 10 contacts — flag empty merge substitutions
      const templateTokens = [...new Set((template.match(/\{(\w+)\}/g) || []).map(t => t.slice(1,-1)))];
      const previewRows = (bsState.csvRows || []).slice(0, 10).map(row => {
        try {
          let msg = template;
          const cm = bsState.columnMap;
          msg = msg.replace(/\{(\w+)\}/g, (m, token) => {
            const colName = cm[token];
            const val = colName && row[colName] !== undefined ? row[colName] : (row[token] !== undefined ? row[token] : '');
            // Mark empty substitutions so we can highlight them
            return val || (templateTokens.includes(token) ? '[EMPTY_MERGE]' : m);
          });
          const phone = cm.phone ? (row[cm.phone] || '') : '';
          return { phone, body: msg };
        } catch (_) { return { phone: '', body: template }; }
      });
      if (!previewRows.length) previewRows.push({ phone: '', body: template });

      showSendConfirmModal(null, template, effectiveTotal, () => doSubmitBulk(true, name, template, pace), previewRows, { freeTruncated, freeTruncatedFrom: totalInList, imageName: bsState.imageFile ? bsState.imageFile.name : null });
    } else {
      doSubmitBulk(false, name, template, pace);
    }
  }

  async function doSubmitBulk(queueNow, name, template, pace) {
    const alertEl = document.getElementById('bs-alert');
    try {
      document.getElementById('bs-preview-send').disabled = true;
      document.getElementById('bs-save-draft').disabled = true;

      // Upload image if one is attached
      let imageName = null;
      if (bsState.imageFile) {
        const fd = new FormData();
        fd.append('image', bsState.imageFile);
        const upResp = await fetch('/api/upload-image', { method: 'POST', body: fd });
        const upJson = await upResp.json();
        if (!upResp.ok) throw new Error(upJson.error || 'Image upload failed');
        imageName = upJson.imageName;
      }

      const result = await post('/api/jobs', {
        name,
        template,
        rows: bsState.csvRaw,
        columnMap: bsState.columnMap,
        paceSeconds: pace,
        imageName,
      });
      if (queueNow) {
        await patch(`/api/jobs/${result.job_id}/status`, { status: 'queued' });
      }
      currentUser = await get('/api/auth/me');
      updateUserBadge();

      // Surface all skip reasons
      const skipParts = [];
      if (result.skipped_suppressed > 0) skipParts.push(`${result.skipped_suppressed} suppressed`);
      if (result.skipped_invalid > 0)    skipParts.push(`${result.skipped_invalid} invalid number${result.skipped_invalid===1?'':'s'}`);
      if (result.skipped_duplicate > 0)  skipParts.push(`${result.skipped_duplicate} duplicate${result.skipped_duplicate===1?'':'s'}`);
      if (result.truncated_count > 0)    skipParts.push(`${result.truncated_count} over free plan limit`);
      if (skipParts.length) showToast(`Queued — skipped: ${skipParts.join(', ')}`, 6000);

      // Guard against ghost job (all contacts skipped/invalid)
      if (result.queued === 0) {
        const skipDetail = skipParts.length ? `Skipped: ${skipParts.join(', ')}.` : 'No valid contacts found.';
        alertEl.innerHTML = `<div class="alert alert-error">No contacts were queued — ${skipDetail} Check your phone column and re-upload.</div>`;
        document.getElementById('bs-preview-send').disabled = false;
        document.getElementById('bs-save-draft').disabled = false;
        return;
      }

      navigate('history');
      setTimeout(() => openJobDetail(result.job_id), 300);
    } catch (err) {
      alertEl.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}${err.data&&err.data.upgrade?' <button class="btn btn-primary btn-sm" onclick="navigate(\'billing\')">Upgrade</button>':''}</div>`;
      document.getElementById('bs-preview-send').disabled = false;
      document.getElementById('bs-save-draft').disabled = false;
    }
  }
}

// ── Contacts tab ──────────────────────────────────────────────────────────

function renderContacts(body) {
  const u = currentUser;
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <div>
        <h3 style="font-size:15px;font-weight:700">Contact Lists</h3>
      </div>
      <div style="display:flex;gap:8px">
        <a href="/api/csv-template" download class="btn btn-ghost btn-sm" title="Download CSV template">&#8595; CSV Template</a>
        ${u.csv_upload ? `<button class="btn btn-ghost btn-sm" id="btn-create-list">+ Create List</button>` : ''}
        ${u.csv_upload ? `<button class="btn btn-primary" id="btn-upload-list">+ Upload List</button>` : ''}
      </div>
    </div>
    ${!u.csv_upload ? upgradePrompt('Contact lists require Starter or Pro plan.') : ''}
    <div class="alert alert-info" style="margin-bottom:16px;font-size:13px">
      <strong>CSV template columns:</strong> <code>first_name, last_name, phone, special</code> — The "special" column can hold a link, coupon code, or any custom text.
      <a href="/api/csv-template" download style="margin-left:8px;color:#1d4ed8;font-weight:600">&#8595; Download template</a>
    </div>
    <div class="card" id="lists-card">
      <div style="padding:20px;color:var(--text-muted)">Loading...</div>
    </div>`;

  const uploadBtn = document.getElementById('btn-upload-list');
  if (uploadBtn) uploadBtn.addEventListener('click', openListUpload);
  const createBtn = document.getElementById('btn-create-list');
  if (createBtn) createBtn.addEventListener('click', openCreateList);
  loadLists();
}

async function loadLists() {
  const card = document.getElementById('lists-card');
  if (!card) return;
  try {
    const lists = await get('/api/lists');
    if (!lists.length) {
      card.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9671;</div><p>No saved lists yet. Upload a CSV to save it as a reusable list.</p></div>`;
      return;
    }
    card.innerHTML = `
      <div class="card-header"><h3>Saved Lists (${lists.length})</h3></div>
      <table>
        <thead><tr><th>Name</th><th>Contacts</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>
          ${lists.map(l => `<tr>
            <td><a href="#" class="js-view-list" data-id="${l.id}" data-rows="${l.row_count}" style="font-weight:600;color:var(--accent);text-decoration:none" title="View list">${escHtml(l.name)}</a></td>
            <td>${l.row_count}</td>
            <td style="color:var(--text-muted);font-size:12.5px">${fmt(l.created_at)}</td>
            <td style="text-align:right">
              <div style="display:flex;gap:5px;justify-content:flex-end;align-items:center;flex-wrap:wrap">
                <button class="btn btn-ghost btn-sm js-rename-list" data-id="${l.id}" data-name="${escHtml(l.name)}">Rename</button>
                <a href="/api/lists/${l.id}/download" download class="btn btn-ghost btn-sm" title="Download list" style="font-size:16px;line-height:1;padding:3px 7px">&#8595;</a>
                <button class="btn btn-ghost btn-sm" onclick="replaceList(${l.id})">Replace</button>
                <button class="btn btn-primary btn-sm" onclick="sendFromList(${l.id})">Send</button>
                <button class="btn btn-ghost btn-sm" title="Delete list" style="color:var(--danger);font-size:16px;line-height:1;padding:3px 7px" onclick="deleteList(${l.id})">&#128465;</button>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    // Wire view-list links and rename buttons via event listeners (avoids XSS via list names)
    card.querySelectorAll('.js-view-list').forEach(a => {
      a.addEventListener('click', e => { e.preventDefault(); viewList(Number(a.dataset.id), Number(a.dataset.rows)); });
    });
    card.querySelectorAll('.js-rename-list').forEach(btn => {
      btn.addEventListener('click', () => renameList(Number(btn.dataset.id), btn.dataset.name));
    });
  } catch (err) {
    if (card) card.innerHTML = `<div class="alert alert-error" style="margin:16px">${escHtml(err.message)}</div>`;
  }
}

// Change 3: View list modal
async function viewList(listId, total) {
  try {
    const data = await get(`/api/lists/${listId}/view`);
    const root = document.getElementById('wizard-root');
    const overlay = document.createElement('div');
    overlay.className = 'wizard-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) root.innerHTML = ''; });

    const box = document.createElement('div');
    box.className = 'wizard';
    box.style.width = '820px';
    const rows = data.rows;
    const columns = data.columns || [];
    let editableRows = rows.map(r => ({ ...r }));
    const footer = document.createElement('div');
    footer.className = 'wizard-footer';

    const headerHtml = `
      <div class="wizard-header">
        <h2>Contact List Preview</h2>
        <div style="font-size:13px;color:var(--text-muted);margin-top:6px">Showing ${rows.length} of ${data.total} contacts</div>
      </div>`;

    box.innerHTML = `${headerHtml}
      <div class="wizard-body" style="overflow-x:auto">
        <div id="list-table-container"></div>
      </div>`;
    box.appendChild(footer);
    overlay.appendChild(box);
    root.appendChild(overlay);

    const tableContainer = box.querySelector('#list-table-container');
    if (!tableContainer) throw new Error('Failed to render list container');

    const previewTable = () => {
      if (!columns.length) return '<div class="alert alert-info">No columns available.</div>';
      return `<table>
        <thead><tr>${columns.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${columns.map(c => `<td style="font-size:12.5px">${escHtml(r[c]||'')}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
      ${data.total > 50 ? `<div style="padding:10px 0 0;font-size:12.5px;color:var(--text-muted)">Showing first 50 of ${data.total} contacts</div>` : ''}`;
    };

    const renderPreviewMode = () => {
      editableRows = rows.map(r => ({ ...r }));
      tableContainer.innerHTML = previewTable();
      footer.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" id="list-edit-view">Edit Table</button>
        <button class="btn btn-secondary" id="list-show-all">Show all ${data.total} rows</button>
        <button class="btn btn-primary" id="list-close">Close</button>
      </div>`;
      footer.querySelector('#list-edit-view').addEventListener('click', renderEditMode);
      footer.querySelector('#list-close').addEventListener('click', () => { root.innerHTML = ''; });
      footer.querySelector('#list-show-all').addEventListener('click', () => { alert(`This list contains ${data.total} contacts.`); });
    };

    const makeEmptyRow = () => columns.reduce((acc, col) => ({ ...acc, [col]: '' }), {});

    const renderEditMode = () => {
      tableContainer.innerHTML = `<table>
        <thead><tr>${columns.map(c => `<th>${escHtml(c)}</th>`).join('')}<th></th></tr></thead>
        <tbody>${editableRows.map((row, idx) => `<tr>${columns.map(c => `<td><input type="text" data-col="${escHtml(c)}" value="${escHtml(row[c]||'')}"/></td>`).join('')}<td style="text-align:right"><button class="btn btn-ghost btn-sm list-delete-row" data-index="${idx}">Delete</button></td></tr>`).join('')}</tbody>
      </table>`;
      footer.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" id="list-edit-add">Add row</button>
        <button class="btn btn-ghost" id="list-edit-add-col">Add column</button>
        <button class="btn btn-primary" id="list-edit-save">Save</button>
        <button class="btn btn-ghost" id="list-edit-cancel">Cancel</button>
      </div>`;
      footer.querySelector('#list-edit-add').addEventListener('click', () => {
        // Capture current input values before re-rendering
        const current = gatherRowsFromDom();
        current.forEach((row, i) => { editableRows[i] = row; });
        editableRows.push(makeEmptyRow());
        renderEditMode();
      });
      footer.querySelector('#list-edit-add-col').addEventListener('click', () => {
        // Use inline dialog — native prompt() is disabled in Electron
        const footerDiv = footer.querySelector('div');
        if (footer.querySelector('#edit-col-input')) return; // already open
        const snippet = document.createElement('div');
        snippet.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;margin-top:10px';
        snippet.innerHTML = `
          <input id="edit-col-input" type="text" placeholder="Column name (e.g. city)" style="flex:1;font-size:13px" />
          <button class="btn btn-primary btn-sm" id="edit-col-ok">Add</button>
          <button class="btn btn-ghost btn-sm" id="edit-col-cancel">Cancel</button>`;
        footerDiv.appendChild(snippet);
        const inp = snippet.querySelector('#edit-col-input');
        inp.focus();
        const doAdd = () => {
          const col = inp.value.trim().replace(/[^a-zA-Z0-9_]/g, '_');
          if (!col) { inp.focus(); return; }
          if (columns.includes(col)) { showToast(`Column "${col}" already exists.`); inp.focus(); return; }
          const current = gatherRowsFromDom();
          current.forEach((row, i) => { editableRows[i] = row; });
          columns.push(col);
          editableRows.forEach(row => { row[col] = ''; });
          renderEditMode();
        };
        snippet.querySelector('#edit-col-ok').addEventListener('click', doAdd);
        snippet.querySelector('#edit-col-cancel').addEventListener('click', () => snippet.remove());
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); if (e.key === 'Escape') snippet.remove(); });
      });
      footer.querySelector('#list-edit-cancel').addEventListener('click', renderPreviewMode);
      footer.querySelector('#list-edit-save').addEventListener('click', saveEditedList);
      tableContainer.querySelectorAll('.list-delete-row').forEach(btn => {
        btn.addEventListener('click', () => {
          // Capture current input values before re-rendering
          const current = gatherRowsFromDom();
          current.forEach((row, i) => { editableRows[i] = row; });
          const idx = parseInt(btn.dataset.index, 10);
          editableRows.splice(idx, 1);
          renderEditMode();
        });
      });
    };

    const gatherRowsFromDom = () => {
      const trs = tableContainer.querySelectorAll('tbody tr');
      return Array.from(trs).map(tr => {
        const obj = {};
        columns.forEach(col => {
          const input = tr.querySelector(`input[data-col="${col}"]`);
          obj[col] = input ? input.value.trim() : '';
        });
        return obj;
      }).filter(row => Object.values(row).some(val => val !== ''));
    };

    const encodeCsv = (rowsArray) => {
      const escape = (val) => `"${(val||'').replace(/"/g, '""')}"`;
      const lines = [columns.map(escape).join(',')];
      rowsArray.forEach(row => lines.push(columns.map(col => escape(row[col] || '')).join(',')));
      return lines.join('\n');
    };

    const saveEditedList = async () => {
      const updatedRows = gatherRowsFromDom();
      if (!updatedRows.length) { alert('Please keep at least one row.'); return; }
      const payload = {
        csv_data: encodeCsv(updatedRows),
        columns,
        row_count: updatedRows.length,
      };
      try {
        await put(`/api/lists/${listId}`, payload);
        showToast('List updated');
        root.innerHTML = '';
        loadLists();
      } catch (err) {
        alert('Save failed: ' + err.message);
      }
    };

    renderPreviewMode();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── Create list from UI ───────────────────────────────────────────────────────

function openCreateList() {
  const u = currentUser;
  const maxRows = u.bulk_max_contacts || 10;
  const isFree = u.plan === 'free' && !u.is_admin && !u.manual_account;

  const root = document.getElementById('wizard-root');
  root.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'wizard-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) root.innerHTML = ''; });

  const box = document.createElement('div');
  box.className = 'wizard';
  box.style.cssText = 'width:860px;max-width:calc(100vw - 40px)';

  let columns = ['first_name', 'last_name', 'phone'];
  let rows = [{ first_name: '', last_name: '', phone: '' }];

  const makeEmptyRow = () => columns.reduce((acc, c) => ({ ...acc, [c]: '' }), {});

  const encodeCsv = (rowsArr) => {
    const esc = v => `"${(v||'').replace(/"/g, '""')}"`;
    const lines = [columns.map(esc).join(',')];
    rowsArr.forEach(r => lines.push(columns.map(c => esc(r[c] || '')).join(',')));
    return lines.join('\n');
  };

  // Read current input values from DOM back into `rows` before any re-render
  const syncFromDom = () => {
    const trs = box.querySelectorAll('tbody tr');
    rows = Array.from(trs).map(tr => {
      const obj = {};
      columns.forEach(col => {
        const inp = tr.querySelector(`input[data-col="${escHtml(col)}"]`);
        obj[col] = inp ? inp.value : '';
      });
      return obj;
    });
  };

  const renderTable = () => {
    const nameVal = box.querySelector('#cl-name') ? box.querySelector('#cl-name').value : '';
    const atLimit = rows.length >= maxRows;

    box.innerHTML = `
      <div class="wizard-header">
        <h2>Create Contact List</h2>
        <div style="font-size:13px;color:var(--text-muted);margin-top:4px">
          ${rows.length} contact${rows.length !== 1 ? 's' : ''} &middot; plan limit: ${maxRows}
        </div>
      </div>
      <div class="wizard-body" style="padding-bottom:0">
        <div style="margin-bottom:16px">
          <input type="text" id="cl-name" placeholder="List name (required)" value="${escHtml(nameVal)}"
            style="width:100%;max-width:380px;font-size:14px;font-weight:600" />
        </div>
        <div style="overflow-x:auto;margin:0 -32px;padding:0 32px">
          <table style="min-width:100%">
            <thead>
              <tr>${columns.map(c => `<th style="white-space:nowrap">${escHtml(c)}</th>`).join('')}<th style="width:40px"></th></tr>
            </thead>
            <tbody>
              ${rows.map((row, idx) => `
                <tr>
                  ${columns.map(c => `<td><input type="text" data-col="${escHtml(c)}" value="${escHtml(row[c]||'')}" placeholder="${c === 'phone' ? '+1...' : ''}" style="min-width:110px" /></td>`).join('')}
                  <td><button class="btn btn-ghost btn-sm cl-del" data-idx="${idx}" style="padding:2px 6px;color:var(--danger)">&#10005;</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${atLimit ? `<div class="alert alert-warn" style="margin-top:12px">Plan limit of ${maxRows} reached. <button class="btn btn-primary btn-sm" onclick="document.getElementById('wizard-root').innerHTML='';navigate('billing')">Upgrade</button></div>` : ''}
      </div>
      <div class="wizard-footer" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-ghost btn-sm" id="cl-add-row" ${atLimit ? 'disabled style="opacity:0.4"' : ''}>+ Add row</button>
        <button class="btn btn-ghost btn-sm" id="cl-add-col">+ Add column</button>
        <div style="margin-left:auto;display:flex;gap:8px">
          <button class="btn btn-ghost" id="cl-cancel">Cancel</button>
          <button class="btn btn-primary" id="cl-save">Save list</button>
        </div>
      </div>`;

    // Add row
    box.querySelector('#cl-add-row').addEventListener('click', () => {
      syncFromDom();
      rows.push(makeEmptyRow());
      renderTable();
      // Focus first cell of new row
      const trs = box.querySelectorAll('tbody tr');
      const last = trs[trs.length - 1];
      if (last) { const inp = last.querySelector('input'); if (inp) inp.focus(); }
    });

    // Add column — use inline modal (Electron blocks native prompt())
    box.querySelector('#cl-add-col').addEventListener('click', () => {
      // Build a small inline dialog inside the wizard footer
      const footer = box.querySelector('.wizard-footer');
      if (box.querySelector('#cl-col-input')) return; // already open
      const snippet = document.createElement('div');
      snippet.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;margin-top:10px';
      snippet.innerHTML = `
        <input id="cl-col-input" type="text" placeholder="Column name (e.g. city)" style="flex:1;font-size:13px" />
        <button class="btn btn-primary btn-sm" id="cl-col-ok">Add</button>
        <button class="btn btn-ghost btn-sm" id="cl-col-cancel">Cancel</button>`;
      footer.appendChild(snippet);
      const inp = snippet.querySelector('#cl-col-input');
      inp.focus();

      const doAdd = () => {
        const col = inp.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!col) { inp.focus(); return; }
        if (columns.includes(col)) { showToast(`Column "${col}" already exists.`); inp.focus(); return; }
        syncFromDom();
        columns.push(col);
        rows.forEach(r => { r[col] = ''; });
        renderTable();
      };
      snippet.querySelector('#cl-col-ok').addEventListener('click', doAdd);
      snippet.querySelector('#cl-col-cancel').addEventListener('click', () => snippet.remove());
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); if (e.key === 'Escape') snippet.remove(); });
    });

    // Delete row
    box.querySelectorAll('.cl-del').forEach(btn => {
      btn.addEventListener('click', () => {
        syncFromDom();
        const idx = parseInt(btn.dataset.idx, 10);
        rows.splice(idx, 1);
        if (!rows.length) rows.push(makeEmptyRow());
        renderTable();
      });
    });

    // Cancel
    box.querySelector('#cl-cancel').addEventListener('click', () => { root.innerHTML = ''; });

    // Save
    box.querySelector('#cl-save').addEventListener('click', async () => {
      syncFromDom();
      const nameEl = box.querySelector('#cl-name');
      const listName = nameEl ? nameEl.value.trim() : '';
      if (!listName) { alert('Please enter a list name.'); if (nameEl) nameEl.focus(); return; }

      const nonEmpty = rows.filter(r => Object.values(r).some(v => v.trim()));
      if (!nonEmpty.length) { alert('Add at least one contact.'); return; }

      const phoneCol = columns.find(c => /phone|mobile|cell/i.test(c));
      if (!phoneCol) { alert('Include a column named "phone".'); return; }
      const missingPhone = nonEmpty.filter(r => !r[phoneCol].trim());
      if (missingPhone.length) {
        if (!confirm(`${missingPhone.length} row(s) have no phone number and will be skipped. Continue?`)) return;
      }
      const finalRows = nonEmpty.filter(r => r[phoneCol].trim());
      if (!finalRows.length) { alert('No rows with a phone number to save.'); return; }

      // Warn free users that the list exceeds bulk send cap
      if (isFree && finalRows.length > maxRows) {
        if (!confirm(`Your Free plan allows bulk sends up to ${maxRows} contacts. This list has ${finalRows.length} rows — you can save it, but only the first ${maxRows} will be sent unless you upgrade.\n\nSave anyway?`)) return;
      }

      const saveBtn = box.querySelector('#cl-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await post('/api/lists', {
          name: listName,
          csv_data: encodeCsv(finalRows),
          columns,
          row_count: finalRows.length,
        });
        root.innerHTML = '';
        loadLists();
        showToast(`"${listName}" saved — ${finalRows.length} contact${finalRows.length !== 1 ? 's' : ''}`);
      } catch (err) {
        alert('Save failed: ' + err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save list';
      }
    });
  };

  overlay.appendChild(box);
  root.appendChild(overlay);
  renderTable();
  // Focus name field immediately
  setTimeout(() => { const n = box.querySelector('#cl-name'); if (n) n.focus(); }, 50);
}

// Change 3: Replace list CSV
function replaceList(listId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.addEventListener('change', async () => {
    if (!input.files[0]) return;
    const fd = new FormData();
    fd.append('file', input.files[0]);
    try {
      const res = await fetch(`/api/lists/${listId}`, { method: 'PUT', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      showToast(`List replaced — ${data.row_count} contacts`);
      loadLists();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });
  input.click();
}

function openListUpload() {
  const root = document.getElementById('wizard-root');
  root.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'wizard-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) root.innerHTML = ''; });

  const box = document.createElement('div');
  box.className = 'wizard';
  box.innerHTML = `
    <div class="wizard-header"><h2>Save Contact List</h2></div>
    <div class="wizard-body">
      <div id="ul-alert"></div>
      <div style="margin-bottom:16px">
        <a href="/api/csv-template" download class="btn btn-ghost btn-sm">&#8595; Download CSV template</a>
        <span style="font-size:12px;color:var(--text-muted);margin-left:8px">Columns: first_name, last_name, phone, special</span>
      </div>
      <div class="form-row">
        <label>List Name</label>
        <input type="text" id="ul-name" placeholder="e.g. Spring 2026 Members" />
      </div>
      <div class="drop-zone" id="ul-dz">
        <div class="dz-icon">&#128196;</div>
        <p><strong>Drop CSV here</strong> or <span style="text-decoration:underline;cursor:pointer" id="ul-browse">browse</span></p>
        <p style="margin-top:6px;font-size:12px;color:var(--text-muted)">Columns: first_name, last_name, phone, special</p>
      </div>
      <input type="file" id="ul-file" accept=".csv" style="display:none" />
      <div id="ul-summary" style="margin-top:12px"></div>
    </div>
    <div class="wizard-footer">
      <button class="btn btn-ghost" id="ul-cancel">Cancel</button>
      <button class="btn btn-primary" id="ul-save" disabled>Save List</button>
    </div>`;

  overlay.appendChild(box);
  root.appendChild(overlay);

  let listData = null;

  document.getElementById('ul-cancel').addEventListener('click', () => root.innerHTML = '');
  document.getElementById('ul-browse').addEventListener('click', () => document.getElementById('ul-file').click());
  document.getElementById('ul-file').addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

  const dz = document.getElementById('ul-dz');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  async function handleFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const data = await api('POST', '/api/upload', fd, true);
      listData = data;
      document.getElementById('ul-summary').innerHTML = `
        <div class="alert alert-success">&#10003; ${data.total} contacts, ${data.columns.length} columns</div>`;
      document.getElementById('ul-save').disabled = false;
    } catch (err) {
      document.getElementById('ul-alert').innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
    }
  }

  document.getElementById('ul-save').addEventListener('click', async () => {
    const name = document.getElementById('ul-name').value.trim();
    if (!name) { document.getElementById('ul-alert').innerHTML = '<div class="alert alert-error">Name is required.</div>'; return; }
    if (!listData) return;
    try {
      await post('/api/lists', { name, csv_data: listData.raw, columns: listData.columns, row_count: listData.total });
      root.innerHTML = '';
      loadLists();
    } catch (err) {
      document.getElementById('ul-alert').innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
    }
  });
}

async function sendFromList(listId) {
  // Navigate to bulk send pre-loaded with this list
  window.pendingBulkListId = listId;
  navigate('send');
}

async function deleteList(id) {
  if (!confirm('Delete this list?')) return;
  await del(`/api/lists/${id}`);
  loadLists();
}

async function renameList(id, currentName) {
  const name = prompt('New name for this list', currentName);
  if (!name) return;
  try {
    await patch(`/api/lists/${id}/rename`, { name });
    showToast('List renamed');
    loadLists();
  } catch (err) {
    alert('Rename failed: ' + err.message);
  }
}

// ── Suppression tab ──────────────────────────────────────────────────────

function renderSuppressionTab(body) {
  body.innerHTML = `
    <div class="card" style="max-width:640px;margin-bottom:16px">
      <div class="card-header">
        <h3>Add Number</h3>
        <button class="btn btn-ghost btn-sm" id="sup-import-btn">&#8593; Import numbers (CSV)</button>
      </div>
      <div class="card-body">
        <div class="form-row-inline">
          <div class="form-row">
            <label>Phone Number</label>
            <input type="text" id="sup-phone" placeholder="+15555555555 or 8015551234" />
          </div>
          <div class="form-row">
            <label>Reason (optional)</label>
            <input type="text" id="sup-reason" placeholder="Opt-out, DNC, etc." />
          </div>
          <button class="btn btn-primary" id="sup-add" style="margin-bottom:0">Add</button>
        </div>
        <div id="sup-alert" style="margin-top:8px"></div>
      </div>
    </div>
    <div class="card" id="sup-list">Loading...</div>`;

  document.getElementById('sup-import-btn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.addEventListener('change', async () => {
      if (!input.files[0]) return;
      const fd = new FormData();
      fd.append('file', input.files[0]);
      try {
        const result = await api('POST', '/api/suppression/import', fd, true);
        document.getElementById('sup-alert').innerHTML = `<div class="alert alert-success">&#10003; ${result.added} numbers added, ${result.already_suppressed} already suppressed.</div>`;
        loadSuppressionList();
      } catch (err) {
        document.getElementById('sup-alert').innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
      }
    });
    input.click();
  });

  document.getElementById('sup-add').addEventListener('click', async () => {
    const phone = document.getElementById('sup-phone').value.trim();
    const reason = document.getElementById('sup-reason').value.trim();
    if (!phone) return;
    try {
      await post('/api/suppression', { phone, reason });
      document.getElementById('sup-phone').value = '';
      document.getElementById('sup-reason').value = '';
      document.getElementById('sup-alert').innerHTML = `<div class="alert alert-success">Added ${escHtml(phone)}</div>`;
      loadSuppressionList();
    } catch (err) {
      document.getElementById('sup-alert').innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
    }
  });

  loadSuppressionList();
}

async function loadSuppressionList() {
  const list = await get('/api/suppression');
  const el = document.getElementById('sup-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9711;</div><p>No suppressed numbers</p></div>`;
    return;
  }
  el.innerHTML = `<table>
    <thead><tr><th>Phone</th><th>Reason</th><th>Added</th><th></th></tr></thead>
    <tbody>
      ${list.map(s => `<tr>
        <td style="font-family:var(--mono)">${escHtml(s.phone)}</td>
        <td>${escHtml(s.reason) || '—'}</td>
        <td style="color:var(--text-muted)">${fmt(s.created_at)}</td>
        <td style="text-align:right">
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="removeSuppressed('${escHtml(s.phone)}')">Remove</button>
        </td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

async function removeSuppressed(phone) {
  if (!confirm(`Remove ${phone} from suppression list?`)) return;
  await del(`/api/suppression/${encodeURIComponent(phone)}`);
  navigate('suppression');
}

// ── Templates tab ─────────────────────────────────────────────────────────

function renderTemplatesTab(body) {
  const u = currentUser;
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <h3 style="font-size:15px;font-weight:700">Templates</h3>
      ${u.templates ? `<button class="btn btn-primary" id="btn-new-template">+ New Template</button>` : ''}
    </div>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">Templates let you save messages to reuse. Open a template in Bulk Send to choose a contact list and send.</p>
    ${!u.templates ? upgradePrompt('Saved templates require Starter or Pro plan.') : ''}
    <div class="card" id="templates-card">
      <div style="padding:20px;color:var(--text-muted)">Loading...</div>
    </div>`;

  const newBtn = document.getElementById('btn-new-template');
  if (newBtn) newBtn.addEventListener('click', openTemplateEditor);
  loadTemplatesList();
}

async function loadTemplatesList() {
  const card = document.getElementById('templates-card');
  if (!card) return;
  if (!currentUser.templates) { card.innerHTML = ''; return; }
  try {
    const list = await get('/api/templates');
    if (!list.length) {
      card.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9644;</div><p>No templates yet. Save a message you send often.</p></div>`;
      return;
    }
    card.innerHTML = `
      <div class="card-header"><h3>Saved Templates (${list.length})</h3></div>
      <table>
        <thead><tr><th>Name</th><th>Message</th><th>Saved</th><th></th></tr></thead>
        <tbody>
          ${list.map(t => `<tr data-tid="${t.id}">
            <td><strong>${escHtml(t.name)}</strong></td>
            <td style="font-size:12.5px;color:var(--text-muted);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(t.body)}</td>
            <td style="color:var(--text-muted);font-size:12.5px">${fmt(t.created_at)}</td>
            <td style="text-align:right">
              <div style="display:flex;gap:5px;justify-content:flex-end;align-items:center;flex-wrap:wrap">
                <button class="btn btn-ghost btn-sm tmpl-view" data-tid="${t.id}">View</button>
                <button class="btn btn-ghost btn-sm tmpl-edit" data-tid="${t.id}">Edit</button>
                <button class="btn btn-primary btn-sm tmpl-bulk" data-tid="${t.id}">Send</button>
                <button class="btn btn-ghost btn-sm tmpl-del" data-tid="${t.id}" title="Delete template" style="color:var(--danger);font-size:16px;line-height:1;padding:3px 7px">&#128465;</button>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    // Store template data in a map and bind click handlers (avoids JSON-in-onclick quoting issues)
    const tmplMap = {};
    list.forEach(t => { tmplMap[t.id] = t; });

    card.querySelectorAll('.tmpl-view').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = tmplMap[btn.dataset.tid];
        if (t) viewTemplate(t.name, t.body);
      });
    });
    card.querySelectorAll('.tmpl-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = tmplMap[btn.dataset.tid];
        if (t) openTemplateEditor({ id: t.id, name: t.name, body: t.body });
      });
    });
    card.querySelectorAll('.tmpl-bulk').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = tmplMap[btn.dataset.tid];
        if (t) openTemplateInBulkSend(t.body);
      });
    });
    card.querySelectorAll('.tmpl-del').forEach(btn => {
      btn.addEventListener('click', () => deleteTemplate(btn.dataset.tid));
    });
  } catch (err) {
    if (card) card.innerHTML = `<div class="alert alert-error" style="margin:16px">${escHtml(err.message)}</div>`;
  }
}

function openTemplateEditor(prefill) {
  const root = document.getElementById('wizard-root');
  root.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'wizard-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) root.innerHTML = ''; });

  const isEdit = !!(prefill && prefill.id);
  const box = document.createElement('div');
  box.className = 'wizard';
  box.innerHTML = `
    <div class="wizard-header"><h2>${isEdit ? 'Edit Template' : 'Save Template'}</h2></div>
    <div class="wizard-body">
      <div id="tmpl-alert"></div>
      <div class="form-row">
        <label>Template Name</label>
        <input type="text" id="tmpl-name" placeholder="e.g. Event reminder" value="${escHtml(prefill?.name||'')}" />
      </div>
      <div class="form-row">
        <label>Message</label>
        ${mergeChipsHtml('tmpl-body')}
        <textarea id="tmpl-body" rows="5" placeholder="Hi {first_name}, just a reminder...">${escHtml(prefill?.body||'')}</textarea>
        <div class="char-count" id="tmpl-char">0 chars</div>
      </div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-top:-8px">Fields like {first_name} are replaced with real contact data when you send.</p>
    </div>
    <div class="wizard-footer">
      <button class="btn btn-ghost" id="tmpl-cancel">Cancel</button>
      <button class="btn btn-primary" id="tmpl-save">${isEdit ? 'Update Template' : 'Save Template'}</button>
    </div>`;

  overlay.appendChild(box);
  root.appendChild(overlay);

  bindMergeChips();

  const ta = document.getElementById('tmpl-body');
  const cc = document.getElementById('tmpl-char');
  ta.addEventListener('input', () => {
    const len = ta.value.length;
    cc.textContent = `${len} chars`;
    cc.className = 'char-count' + (len > 306 ? ' char-danger' : len > 160 ? ' char-warn' : '');
  });

  document.getElementById('tmpl-cancel').addEventListener('click', () => root.innerHTML = '');
  document.getElementById('tmpl-save').addEventListener('click', async () => {
    const name = document.getElementById('tmpl-name').value.trim();
    const body = ta.value.trim();
    if (!name || !body) {
      document.getElementById('tmpl-alert').innerHTML = '<div class="alert alert-error">Name and message are required.</div>';
      return;
    }
    try {
      if (isEdit) {
        await patch(`/api/templates/${prefill.id}`, { name, body });
      } else {
        await post('/api/templates', { name, body });
      }
      root.innerHTML = '';
      loadTemplatesList();
    } catch (err) {
      document.getElementById('tmpl-alert').innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
    }
  });
}

function viewTemplate(name, body) {
  const root = document.getElementById('wizard-root');
  root.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'wizard-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) root.innerHTML = ''; });
  const box = document.createElement('div');
  box.className = 'wizard-box';
  box.style.cssText = 'max-width:480px;padding:28px';
  box.innerHTML = `
    <h3 style="margin-bottom:12px;font-size:16px;font-weight:700">${escHtml(name)}</h3>
    <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.6;background:var(--bg-alt,#f5f5f5);padding:16px;border-radius:8px;margin-bottom:20px">${escHtml(body)}</pre>
    <div style="display:flex;gap:10px">
      <button class="btn btn-primary" id="vt-bulk-send">Use in Bulk Send</button>
      <button class="btn btn-ghost" id="vt-close">Close</button>
    </div>`;
  overlay.appendChild(box);
  root.appendChild(overlay);
  document.getElementById('vt-bulk-send').addEventListener('click', () => {
    root.innerHTML = '';
    openTemplateInBulkSend(body);
  });
  document.getElementById('vt-close').addEventListener('click', () => { root.innerHTML = ''; });
}

function openTemplateInBulkSend(body) {
  navigate('send');
  // After bulk send tab renders, fill message and show contact-list prompt
  setTimeout(() => {
    const ta = document.getElementById('bs-message');
    if (ta) {
      ta.value = body;
      ta.dispatchEvent(new Event('input'));
    }
    // Show a prompt to load contacts if none loaded yet
    const status = document.getElementById('bs-csv-status');
    const uploadResult = document.getElementById('bs-upload-result');
    if (status && !status.innerHTML.includes('contacts')) {
      const banner = document.createElement('div');
      banner.className = 'alert alert-info';
      banner.style.marginBottom = '8px';
      banner.innerHTML = '&#8593; Now choose a contact list above — upload a new CSV or pick a saved one — then hit <strong>Preview &amp; Send</strong>.';
      status.parentNode.insertBefore(banner, status);
    }
  }, 150);
}

async function deleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  await del(`/api/templates/${id}`);
  loadTemplatesList();
}

// ── History tab — campaign tracker ─────────────────────────────────────────

async function renderHistoryTab(body) {
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h3 style="font-size:15px;font-weight:700">Campaign History</h3>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="navigate('send')">+ New campaign</button>
        <button class="btn btn-ghost btn-sm" id="hist-refresh">Refresh</button>
      </div>
    </div>
    <div id="campaigns-card"><div style="color:var(--text-muted);padding:20px 0">Loading...</div></div>`;

  document.getElementById('hist-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('hist-refresh');
    if (btn) { btn.textContent = 'Refreshing…'; btn.disabled = true; }
    await loadCampaignHistory();
    if (btn) { btn.textContent = 'Refresh'; btn.disabled = false; }
  });
  loadCampaignHistory();

  // Auto-refresh if any job is active
  monitorInterval = setInterval(async () => {
    const jobs = await get('/api/jobs').catch(() => []);
    const hasActive = jobs.some(j => j.status === 'queued');
    if (!hasActive) { clearInterval(monitorInterval); monitorInterval = null; loadCampaignHistory(); return; }
    loadCampaignHistory();
  }, 3000);
}

function statusBadge(status) {
  const map = {
    draft:       'background:#e5e7eb;color:#374151',
    queued:      'background:#dbeafe;color:#1d4ed8',
    completed:   'background:#dcfce7;color:#15803d',
    failed:      'background:#fee2e2;color:#dc2626',
    paused:      'background:#fef9c3;color:#a16207',
    cancelled:   'background:#e5e7eb;color:#6b7280',
    api_pending: 'background:#fff7ed;color:#c2410c',
  };
  const style = map[status] || map.draft;
  const label = status === 'queued' ? '⟳ Sending' : status === 'api_pending' ? '⏸ Held' : status.charAt(0).toUpperCase() + status.slice(1);
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:600;${style}">${label}</span>`;
}

async function loadCampaignHistory() {
  const card = document.getElementById('campaigns-card');
  if (!card) return;
  try {
    const jobs = await get('/api/jobs');
    if (!jobs.length) {
      card.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9636;</div><p>No campaigns yet. Click "New campaign" to get started.</p></div>`;
      return;
    }
    const displayed = jobs.slice(0, 50);
    displayed.forEach(j => { if (j.status === 'api_pending') window._heldJobCache[j.id] = j; });
    card.innerHTML = displayed.map(j => {
      const pct = j.total ? Math.round(j.sent / j.total * 100) : 0;
      const isActive = j.status === 'queued';
      const isDraft = j.status === 'draft';
      const isHeld = j.status === 'api_pending';
      const isWebJob = j._source === 'web';
      let actionBtn = '';
      if (isDraft) actionBtn = `<button class="btn btn-primary btn-sm" onclick="openJobDetail('${j.id}')">Edit &amp; Send</button>`;
      else if (isHeld) actionBtn = `<button class="btn btn-primary btn-sm" onclick="showJobReviewPrompt('${j.id}')">Review</button>`;
      else if (!isWebJob) actionBtn = `<button class="btn btn-ghost btn-sm" onclick="openJobDetail('${j.id}')">View</button>`;
      return `
        <div class="card" style="margin-bottom:12px;padding:16px 20px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px">
            <div>
              <div style="font-weight:700;font-size:14.5px;margin-bottom:4px">${escHtml(j.name)}</div>
              <div style="display:flex;align-items:center;gap:10px">
                ${statusBadge(j.status)}
                <span style="font-size:12.5px;color:var(--text-muted)">${j.sent} / ${j.total} sent${j.failed>0?` · <span style="color:var(--danger)">${j.failed} failed</span>`:''}</span>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              ${actionBtn}
            </div>
          </div>
          ${j.total > 0 ? `
            <div>
              <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-muted);margin-bottom:4px">
                <span>Progress</span><span>${pct}%</span>
              </div>
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%${isActive?';animation:none':''}"></div></div>
            </div>` : ''}
          <div style="font-size:12px;color:var(--text-muted);margin-top:8px">
            Started ${fmt(j.created_at)}
            ${j.updated_at && j.updated_at !== j.created_at ? ` · Updated ${fmt(j.updated_at)}` : ''}
            ${j.pace_seconds > 0 ? ` · Smart Throttle (~${j.pace_seconds}-${j.pace_seconds + 7}s)` : ''}
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    if (card) card.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
  }
}

// ── Job detail / monitor ──────────────────────────────────────────────────

async function openJobDetail(jobId) {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  const main = document.getElementById('main');
  main.innerHTML = `<div class="main-body" style="padding-top:24px">
    <button class="btn btn-ghost btn-sm" id="btn-back" style="margin-bottom:16px">&#8592; Send History</button>
    <div id="job-detail">Loading...</div>
  </div>`;
  document.getElementById('btn-back').addEventListener('click', () => {
    navigate('history');
  });
  await refreshJobDetail(jobId);
  monitorInterval = setInterval(() => refreshJobDetail(jobId), 4000);
}

async function refreshJobDetail(jobId) {
  try {
    const [job, { messages, total }] = await Promise.all([
      get(`/api/jobs/${jobId}`),
      get(`/api/jobs/${jobId}/messages?limit=50`)
    ]);
    const container = document.getElementById('job-detail');
    if (!container) return;

    const pct = job.total ? Math.round(job.sent / job.total * 100) : 0;
    const canQueue  = ['draft','paused'].includes(job.status);
    const canPause  = job.status === 'queued';
    const canCancel = ['draft','queued','paused'].includes(job.status);

    // Check if job was paused due to messaging app closing
    const pausedByApp = job.status === 'paused' && messages.some(m =>
      m.error && /closed — sending paused/i.test(m.error)
    );
    const appName = window.electronAPI?.platform === 'darwin' ? 'Messages' : 'Phone Link';

    container.innerHTML = `
      ${pausedByApp ? `<div class="alert alert-warn" style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px">
        <span>&#9888; <strong>${appName} closed</strong> — sending paused. Reopen ${appName}, then resume.</span>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button class="btn btn-primary btn-sm" onclick="setJobStatus('${jobId}','queued')">Resume</button>
          <button class="btn btn-ghost btn-sm" onclick="setJobStatus('${jobId}','cancelled')" style="color:var(--danger)">Cancel</button>
        </div>
      </div>` : ''}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;gap:12px">
        <div>
          <h2 style="font-size:20px;font-weight:700;letter-spacing:-0.4px">${escHtml(job.name)}</h2>
          <div style="margin-top:4px">${pill(job.status)}</div>
        </div>
        <div style="display:flex;gap:8px">
          ${canQueue && !pausedByApp ? `<button class="btn btn-primary btn-sm" onclick="setJobStatus('${jobId}','queued')">Resume</button>` : ''}
          ${canPause  ? `<button class="btn btn-ghost btn-sm" onclick="setJobStatus('${jobId}','paused')">Pause</button>` : ''}
          ${canCancel && !pausedByApp ? `<button class="btn btn-ghost btn-sm" onclick="setJobStatus('${jobId}','cancelled')" style="color:var(--danger)">Cancel</button>` : ''}
        </div>
      </div>
      <div class="monitor-stats">
        <div class="monitor-stat"><div class="ms-num">${job.total}</div><div class="ms-label">Total</div></div>
        <div class="monitor-stat"><div class="ms-num" style="color:var(--success)">${job.sent}</div><div class="ms-label">Sent</div></div>
        <div class="monitor-stat"><div class="ms-num" style="color:var(--danger)">${job.failed}</div><div class="ms-label">Failed</div></div>
        <div class="monitor-stat"><div class="ms-num">${job.total - job.sent - job.failed}</div><div class="ms-label">Pending</div></div>
      </div>
      <div class="card" style="margin-bottom:16px;padding:16px 20px">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-muted);margin-bottom:6px">
          <span>Progress</span><span>${pct}%</span>
        </div>
        <div class="progress-bar" style="height:8px">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>Messages (${total})</h3></div>
        <table>
          <thead><tr><th>Phone</th><th>Name</th><th>Status</th><th>Attempts</th><th>Sent at</th></tr></thead>
          <tbody>
            ${messages.map(m => `<tr>
              <td style="font-family:var(--mono);font-size:13px">${escHtml(m.phone)}</td>
              <td>${escHtml([m.first_name, m.last_name].filter(Boolean).join(' ')) || '—'}</td>
              <td>${pill(m.status)}</td>
              <td>${m.attempts}</td>
              <td>${fmt(m.sent_at)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${total > 50 ? `<div style="padding:12px 16px;font-size:12.5px;color:var(--text-muted)">Showing first 50 of ${total}</div>` : ''}
      </div>`;

    // Stop polling once job reaches a terminal state
    if (['completed', 'cancelled', 'failed'].includes(job.status)) {
      if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
    }

    // Dead-phones suppression banner — shown once on completion, dismissed after suppressing or manually
    if (job.status === 'completed' && job.failed > 0) {
      const suppressedKey = `suppress_done_${jobId}`;
      if (!localStorage.getItem(suppressedKey)) {
        try {
          const deadPhones = await get(`/api/jobs/${jobId}/dead-phones`);
          if (deadPhones.length > 0 && container) {
            const banner = document.createElement('div');
            banner.id = 'dead-suppress-banner';
            banner.style.cssText = 'background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13.5px;display:flex;align-items:center;justify-content:space-between;gap:12px';
            banner.innerHTML = `
              <span>&#9888; <strong>${deadPhones.length} number${deadPhones.length === 1 ? '' : 's'} failed permanently.</strong> Add to suppression list to skip them on future sends?</span>
              <div style="display:flex;gap:8px;flex-shrink:0">
                <button class="btn btn-primary btn-sm" id="btn-suppress-dead">Add to suppression list</button>
                <button class="btn btn-ghost btn-sm" id="btn-suppress-dismiss">Dismiss</button>
              </div>`;
            container.insertBefore(banner, container.firstChild);
            document.getElementById('btn-suppress-dead').addEventListener('click', async () => {
              try {
                await post(`/api/jobs/${jobId}/suppress-dead`, {});
                localStorage.setItem(suppressedKey, '1');
                banner.remove();
                showToast(`${deadPhones.length} number${deadPhones.length === 1 ? '' : 's'} added to suppression list.`);
              } catch (e) { showToast('Error: ' + e.message); }
            });
            document.getElementById('btn-suppress-dismiss').addEventListener('click', () => {
              localStorage.setItem(suppressedKey, '1');
              banner.remove();
            });
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    const container = document.getElementById('job-detail');
    if (container) container.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
  }
}

async function setJobStatus(jobId, status) {
  try {
    await patch(`/api/jobs/${jobId}/status`, { status });
    await refreshJobDetail(jobId);
  } catch (err) {
    alert(err.message);
  }
}

// ── Developer page — Change 1 & 4 ─────────────────────────────────────────

async function renderDeveloper(main) {
  const u = currentUser;
  const isProOrAdmin = u.is_admin || u.manual_account || u.plan === 'pro';
  const canCreateKey = isProOrAdmin || u.plan === 'starter' || u.plan === 'free';

  main.innerHTML = `
    <div class="main-header"><h2>Developer</h2></div>
    <div class="main-body">

      <!-- API Keys section -->
      <h3 style="font-size:16px;font-weight:700;margin-bottom:16px">API Keys</h3>
      <div class="alert alert-info" style="margin-bottom:16px">
        ${window.electronAPI?.isDesktop
          ? 'API keys are used for webhook sends (Pro plan) — integrate with Make, Zapier, or your own systems. The desktop app handles all sending automatically. API keys also work for AI agents (Claude, GPT, etc.) to send texts through your account.'
          : 'API keys connect your companion app to Text Your List. The companion picks up queued messages and sends them through your phone.'}
        ${window.electronAPI?.isDesktop ? '' : (u.plan === 'free' || u.plan === 'starter' ? ' Free and Starter plans include 1 companion key.' : ' Pro plan includes unlimited keys.')}
        ${isProOrAdmin ? ' Pro plan also enables the <code style="font-family:monospace">/api/make/send</code> webhook for Make, Zapier, etc.' : ''}
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h3>Create New Key</h3></div>
        <div class="card-body">
          ${canCreateKey ? `
            <div class="form-row-inline">
              <div class="form-row">
                <label>Key Name</label>
                <input type="text" id="key-name" placeholder="${window.electronAPI?.isDesktop ? 'Webhook integration, Make, Zapier, etc.' : 'Mac companion, Windows companion, etc.'}" ${!canCreateKey ? 'disabled' : ''} />
              </div>
              <button class="btn btn-primary" id="key-create" style="margin-bottom:0" ${!canCreateKey ? 'disabled' : ''}>Create</button>
            </div>
          ` : `
            <div class="alert alert-info">
              API keys require Pro plan. Upgrade to create integrations with Make, Zapier, and AI agents.
              <button class="btn btn-primary btn-sm" onclick="navigate('billing')" style="margin-left:8px">Upgrade</button>
            </div>
          `}
          <div id="key-result" style="margin-top:12px"></div>
        </div>
      </div>
      <div class="card" id="keys-list" style="margin-bottom:32px">Loading...</div>

      <!-- API Docs — link to web -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h3>API Documentation</h3></div>
        <div class="card-body">
          <p style="font-size:13.5px;color:var(--text-muted);margin-bottom:16px">Full API documentation, example payloads, and Make/Zapier integration guides are on our website.</p>
          <button class="btn btn-ghost" id="dev-docs-btn">View API Docs &rarr;</button>
        </div>
      </div>

    </div>`;

  // Wire docs link
  const docsBtn = document.getElementById('dev-docs-btn');
  if (docsBtn) {
    docsBtn.addEventListener('click', () => {
      const url = 'https://textyourlist.com/help/api';
      if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
      else window.open(url, '_blank');
    });
  }

  // Load keys
  loadKeys();

  const keyCreateBtn = document.getElementById('key-create');
  if (keyCreateBtn) keyCreateBtn.addEventListener('click', async () => {
    const name = document.getElementById('key-name').value.trim();
    if (!name) return;
    try {
      const result = await post('/api/keys', { name });
      document.getElementById('key-name').value = '';
      document.getElementById('key-result').innerHTML = `
        <div class="alert alert-success">
          <strong>Key created — copy it now, it won't be shown again:</strong><br/>
          <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
            <code style="font-family:var(--mono);font-size:13px;background:rgba(0,0,0,0.08);padding:4px 8px;border-radius:4px;flex:1;word-break:break-all">${result.key}</code>
            <button class="btn btn-ghost btn-sm" onclick="copyText('${result.key}');showToast('Copied!')">Copy</button>
          </div>
        </div>`;
      loadKeys();
    } catch (err) {
      if (err.data && err.data.upgrade) {
        document.getElementById('key-result').innerHTML = `<div class="alert alert-error">${escHtml(err.message)} <button class="btn btn-primary btn-sm" onclick="navigate('billing')">Upgrade</button></div>`;
      } else {
        document.getElementById('key-result').innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
      }
    }
  });
}

async function loadKeys() {
  const keys = await get('/api/keys');
  const el = document.getElementById('keys-list');
  if (!el) return;
  if (!keys.length) {
    el.innerHTML = `<div class="empty-state"><p>No API keys. Create one above.</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="card-header"><h3>Your Keys</h3></div>
    <table>
    <thead><tr><th>Name</th><th>Last Used</th><th>Created</th><th></th></tr></thead>
    <tbody>
      ${keys.map(k => `<tr>
        <td><strong>${escHtml(k.name)}</strong></td>
        <td style="color:var(--text-muted)">${fmt(k.last_used_at)}</td>
        <td style="color:var(--text-muted)">${fmt(k.created_at)}</td>
        <td style="text-align:right">
          ${k.active ? `<button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="revokeKey(${k.id})">Revoke</button>` : ''}
        </td>
      </tr>`).join('')}
    </tbody>
    </table>`;
}

async function revokeKey(id) {
  if (!confirm('Revoke this API key? This cannot be undone.')) return;
  await del(`/api/keys/${id}`);
  loadKeys();
}

// ── Getting Started ────────────────────────────────────────────────────────

function renderGettingStarted(main) {
  // Desktop mode: companion not needed — show help & tips instead
  if (window.electronAPI?.isDesktop) {
    main.innerHTML = `
      <div class="main-header"><h2>Help &amp; Tips</h2></div>
      <div class="main-body" style="max-width:640px">

        <div class="card" style="padding:24px;margin-bottom:16px">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:10px">You're all set</h3>
          <p style="font-size:13.5px;color:var(--text-muted);line-height:1.7">
            ${window.electronAPI?.platform === 'darwin'
              ? "Text Your List is running. Messages send automatically through your Mac's Messages app (connected to your iPhone)."
              : "Text Your List is running. Messages send through Microsoft Phone Link (connected to your Android or iPhone). Keep Phone Link open while sending."}
          </p>
        </div>

        <div class="card" style="padding:24px;margin-bottom:16px">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:12px">How to send</h3>
          <ul style="font-size:13.5px;color:var(--text-muted);line-height:2;margin:0 0 0 18px">
            <li><strong style="color:var(--text)">Test Send</strong> — send a single text to one number</li>
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
            ${window.electronAPI?.platform === 'darwin'
              ? '<li>Keep Messages open on your Mac for fastest delivery</li>'
              : '<li>Keep Phone Link open and your phone nearby while sending</li>'}
            <li>Don't send more than 200 texts per day to avoid spam filters</li>
            <li>Suppression list lets you block numbers from receiving future sends</li>
          </ul>
        </div>

        ${window.electronAPI?.platform === 'darwin' ? `
        <div class="card" style="padding:24px;margin-bottom:16px">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:10px">macOS Permissions</h3>
          <p style="font-size:13.5px;color:var(--text-muted);line-height:1.7">
            macOS requires two permissions: Automation (to send via Messages) and Full Disk Access (for smart iMessage vs SMS routing). If you skipped Full Disk Access, go to <strong>Account Settings → Manage Permissions</strong> to enable it.
          </p>
        </div>` : `
        <div class="card" style="padding:24px;margin-bottom:16px">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:10px">Phone Link setup</h3>
          <p style="font-size:13.5px;color:var(--text-muted);line-height:1.7">
            Text Your List sends through Microsoft Phone Link. Open Phone Link, sign in with your Microsoft account, and pair your phone. Keep Phone Link running in the background while sending.
          </p>
        </div>`}

        <div class="card" style="padding:20px">
          <h3 style="font-size:14px;font-weight:700;margin-bottom:8px">Need help?</h3>
          <a href="mailto:support@textyourlist.com" class="btn btn-ghost btn-sm">Contact Support</a>
        </div>
      </div>`;
    return;
  }

  const isDone = localStorage.getItem('setup_complete') === '1';
  const savedPhone = localStorage.getItem('setup_phone') || null;
  const savedOs = localStorage.getItem('setup_os') || null;
  setupPhoneType = savedPhone;
  setupOsType = savedOs;

  // Condensed "all set" view for returning users
  if (isDone) {
    main.innerHTML = `
      <div class="main-header"><h2>Getting Started <span style="color:#16a34a;font-size:16px">&#10003; Complete</span></h2></div>
      <div class="main-body" style="max-width:640px">

        <!-- Setup toggle -->
        <div style="display:flex;align-items:center;gap:14px;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;margin-bottom:20px">
          <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;flex-shrink:0">
            <input type="checkbox" id="setup-toggle-input" checked style="opacity:0;width:0;height:0">
            <span id="setup-toggle-track" style="position:absolute;inset:0;background:#16a34a;border-radius:99px;transition:0.2s"></span>
            <span id="setup-toggle-thumb" style="position:absolute;top:3px;left:23px;width:18px;height:18px;background:#fff;border-radius:50%;transition:0.2s"></span>
          </label>
          <div>
            <div style="font-size:14px;font-weight:600;color:#15803d">&#10003; Setup complete</div>
            <div style="font-size:12.5px;color:#166534">Toggle off to show setup steps again</div>
          </div>
        </div>

        <!-- Coming back tip — Change 8 -->
        <div class="card" style="padding:24px;margin-bottom:20px">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:10px">Coming back to send more texts?</h3>
          <p style="font-size:13.5px;color:var(--text-muted);margin-bottom:10px">Once your companion app is set up, you don't need to go through these steps again. Just:</p>
          <ol style="margin:0 0 16px 20px;font-size:13.5px;color:var(--text-muted);line-height:2">
            <li>Open your companion app on your computer (double-click the file you downloaded before)</li>
            <li>Leave it running</li>
            <li>Come back here and send — that's it</li>
          </ol>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" id="gs-redownload">Re-download companion app</button>
          </div>
          <div id="gs-redownload-note" style="margin-top:10px;font-size:13px;color:var(--text-muted)"></div>
        </div>

        <div class="card" style="padding:20px">
          <h3 style="font-size:14px;font-weight:700;margin-bottom:8px">Need help?</h3>
          <p style="font-size:13.5px;color:var(--text-muted)">Contact <a href="mailto:support@textyourlist.com" style="color:var(--accent)">support@textyourlist.com</a></p>
        </div>
      </div>`;
    document.getElementById('gs-redownload').addEventListener('click', async () => {
      await triggerCompanionDownload(savedPhone, savedOs, 'gs-redownload-note');
    });

    // Wire up toggle for the done view
    const toggleInput = document.getElementById('setup-toggle-input');
    if (toggleInput) {
      toggleInput.addEventListener('change', () => {
        if (!toggleInput.checked) {
          localStorage.removeItem('setup_complete');
          updateSetupCheckmark();
          renderGettingStarted(main);
        }
      });
    }
    return;
  }

  main.innerHTML = `
    <div class="main-header">
      <h2>Getting Started</h2>
    </div>
    <div class="main-body" style="max-width:720px">

      <div class="card" style="margin-bottom:20px;padding:20px">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:8px">How Text Your List works</h3>
        <p style="color:var(--text-muted);font-size:13.5px;line-height:1.8">
          Text Your List queues your messages on our server and delivers them through your own phone.
          You run a small companion app on your computer that picks up queued messages and sends them through your phone's messaging app.
        </p>
      </div>

      <!-- Step 1: Phone type -->
      <div class="card" style="margin-bottom:20px;padding:20px">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:16px">What's your phone?</h3>
        <div style="display:flex;gap:14px">
          <button class="phone-choice-btn ${savedPhone==='iphone'?'selected':''}" id="phone-iphone" onclick="selectPhone('iphone')">
            <span class="phone-choice-emoji">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>
            </span>
            iPhone
          </button>
          <button class="phone-choice-btn ${savedPhone==='android'?'selected':''}" id="phone-android" onclick="selectPhone('android')">
            <span class="phone-choice-emoji">
              <svg width="32" height="32" viewBox="0 0 576 512" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M420.55,301.93a24,24,0,1,1,24-24,24,24,0,0,1-24,24m-265.1,0a24,24,0,1,1,24-24,24,24,0,0,1-24,24m273.7-144.48,47.94-83a10,10,0,1,0-17.27-10h0l-48.54,84.07a301.25,301.25,0,0,0-246.56,0L116.18,64.45a10,10,0,1,0-17.27,10h0l47.94,83C64.53,202.22,8.24,285.55,0,384H576c-8.24-98.45-64.54-181.78-146.85-226.55"/></svg>
            </span>
            Android
          </button>
        </div>
      </div>

      <div id="os-choice-section" style="display:${savedPhone?'block':'none'}">
        <div class="card" style="margin-bottom:20px;padding:20px">
          <h3 style="font-size:15px;font-weight:700;margin-bottom:16px">What's your computer?</h3>
          <div style="display:flex;gap:14px">
            <button class="phone-choice-btn ${savedOs==='mac'?'selected':''}" id="os-mac" onclick="selectOs('mac')">
              <span class="phone-choice-emoji">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>
              </span>
              Mac
            </button>
            <button class="phone-choice-btn ${savedOs==='windows'?'selected':''}" id="os-windows" onclick="selectOs('windows')">
              <span class="phone-choice-emoji">
                <svg width="32" height="32" viewBox="0 0 448 512" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M0 93.7l183.6-25.3v177.4H0V93.7zm0 324.6l183.6 25.3V268.4H0v149.9zm203.8 28L448 480V268.4H203.8v177.9zm0-380.6v180.1H448V32L203.8 65.7z"/></svg>
              </span>
              Windows
            </button>
          </div>
        </div>
      </div>

      <div id="phone-instructions"></div>

      <!-- Change 12: Setup toggle -->
      <div style="margin-top:20px;display:flex;align-items:center;gap:14px;padding:16px;background:#f9fafb;border:1px solid var(--border);border-radius:8px">
        <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;flex-shrink:0">
          <input type="checkbox" id="setup-toggle-input" ${isDone ? 'checked' : ''} style="opacity:0;width:0;height:0">
          <span id="setup-toggle-track" style="position:absolute;inset:0;background:${isDone ? '#16a34a' : '#ccc'};border-radius:99px;transition:0.2s"></span>
          <span id="setup-toggle-thumb" style="position:absolute;top:3px;left:${isDone ? '23px' : '3px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:0.2s"></span>
        </label>
        <div>
          <div style="font-size:14px;font-weight:600">${isDone ? '&#10003; Setup complete' : 'Mark setup as done'}</div>
          <div style="font-size:12.5px;color:var(--text-muted)">Toggle on when your companion app is running</div>
        </div>
      </div>

      <!-- Change 8: Returning user tip -->
      <div class="card" style="margin-top:20px;padding:20px">
        <h3 style="font-size:14px;font-weight:700;margin-bottom:10px">Coming back to send more texts?</h3>
        <p style="font-size:13.5px;color:var(--text-muted);margin-bottom:10px">Once your companion app is set up, you don't need to go through these steps again. Just:</p>
        <ol style="margin:0 0 0 20px;font-size:13.5px;color:var(--text-muted);line-height:2">
          <li>Open your companion app on your computer (double-click the file you downloaded before)</li>
          <li>Leave it running</li>
          <li>Come back here and send — that's it</li>
        </ol>
      </div>

    </div>`;

  if (savedPhone && savedOs) renderPhoneInstructions(savedPhone, savedOs);

  // Wire up setup toggle
  const toggleInput = document.getElementById('setup-toggle-input');
  if (toggleInput) {
    toggleInput.addEventListener('change', () => {
      const track = document.getElementById('setup-toggle-track');
      const thumb = document.getElementById('setup-toggle-thumb');
      if (toggleInput.checked) {
        localStorage.setItem('setup_complete', '1');
        if (track) track.style.background = '#16a34a';
        if (thumb) thumb.style.left = '23px';
        updateSetupCheckmark();
        // Re-render to show condensed done view
        renderGettingStarted(document.getElementById('main'));
      } else {
        localStorage.removeItem('setup_complete');
        if (track) track.style.background = '#ccc';
        if (thumb) thumb.style.left = '3px';
        updateSetupCheckmark();
      }
    });
  }
}

function selectPhone(type) {
  setupPhoneType = type;
  localStorage.setItem('setup_phone', type);
  document.querySelectorAll('.phone-choice-btn').forEach(b => b.classList.remove('selected'));
  const btn = document.getElementById('phone-' + type);
  if (btn) btn.classList.add('selected');
  document.getElementById('os-choice-section').style.display = 'block';
  // Reset OS selection if phone changes
  if (setupOsType) renderPhoneInstructions(type, setupOsType);
  else document.getElementById('phone-instructions').innerHTML = '';
}

function selectOs(os) {
  setupOsType = os;
  localStorage.setItem('setup_os', os);
  document.querySelectorAll('#os-choice-section .phone-choice-btn').forEach(b => b.classList.remove('selected'));
  const btn = document.getElementById('os-' + os);
  if (btn) btn.classList.add('selected');
  if (setupPhoneType) renderPhoneInstructions(setupPhoneType, os);
}

function renderPhoneInstructions(phone, os) {
  const el = document.getElementById('phone-instructions');
  if (!el) return;

  const isPro = currentUser && (currentUser.plan === 'pro' || currentUser.is_admin || currentUser.manual_account);

  // Detect combo
  let steps, title, downloadNote;

  if (phone === 'iphone' && os === 'mac') {
    title = 'iPhone + Mac setup';
    steps = [
      ['Make sure Messages is open on your Mac', 'Open the Messages app and confirm it\'s signed in with your Apple ID. Your texts will send through it.'],
      ['Click "Get my companion app" below', 'A zip file (~165MB) will download.'],
      ['Extract the zip, then right-click TextYourListCompanion.app → Open', 'macOS will ask if you\'re sure — click Open. The app runs silently in the background and starts automatically at login from now on.'],
    ];
  } else if (phone === 'iphone' && os === 'windows') {
    title = 'iPhone + Windows setup';
    steps = [
      ['On your Windows PC, open the Start menu and search for "Phone Link" — open it', ''],
      ['Choose iPhone and follow the pairing steps', 'You\'ll need to turn on Bluetooth on both devices.'],
      ['Once paired, click "Get my companion app" below', 'A .zip file will download (~100MB).'],
      ['Extract the zip — you\'ll see a "TextYourList" folder. Open it and double-click TextYourList.exe', 'If Windows shows a Smart App Control warning: go to Settings → Windows Security → App &amp; Browser Control → Smart App Control → turn it Off. Then double-click TextYourList.exe again.'],
      ['The companion icon appears in your system tray — that\'s the companion running', 'It connects automatically and shows green when ready.'],
      ['Leave it running while you\'re sending texts', 'Phone Link will briefly come to the front when a message sends — that\'s normal.'],
    ];
  } else if (phone === 'android' && os === 'mac') {
    title = 'Android + Mac setup';
    steps = [
      ['On your Android phone, open Messages and go to messages.google.com to confirm it\'s set up', ''],
      ['Click "Get my companion app" below', 'A zip file will download.'],
      ['Extract the zip, then right-click TextYourListCompanion.app → Open', 'macOS will ask if you\'re sure — click Open. The app runs silently and starts at login automatically.'],
    ];
  } else if (phone === 'android' && os === 'windows') {
    title = 'Android + Windows setup';
    steps = [
      ['On your Android phone, open a browser and go to messages.google.com', 'Make sure it shows your conversations.'],
      ['Click "Get my companion app" below', 'A file will download automatically.'],
      ['Find it in your Downloads folder — right-click it and choose "Run with PowerShell"', 'If Windows shows a "Smart App Control" warning: open Settings → Windows Security → App &amp; Browser Control → Smart App Control → turn it Off. Then right-click the file and Run with PowerShell again.'],
      ['A window will open with a QR code', 'Scan it with your Android phone — open Messages, tap the 3-dot menu, then Device Pairing.'],
      ['You\'re connected', 'Future runs won\'t need the QR scan. Leave the window open while sending.'],
    ];
  } else {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <div class="card" style="padding:20px">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:16px">${title}</h3>
      <div style="display:grid;gap:12px;margin-bottom:20px">
        ${steps.map(([title, desc], i) => `
          <div style="border:1px solid var(--border);border-radius:8px;padding:14px 16px">
            <div style="font-weight:700;font-size:14px;margin-bottom:${desc?'6':'0'}px">${i+1}. ${title}</div>
            ${desc ? `<p style="color:var(--text-muted);font-size:13.5px">${desc}</p>` : ''}
          </div>`).join('')}
      </div>
      <div style="text-align:center">
        <button class="btn btn-primary btn-lg" id="gs-download-btn">Get my companion app &rarr;</button>
        <div id="gs-download-note" style="margin-top:10px;font-size:13px;color:var(--text-muted)"></div>
      </div>
    </div>`;

  document.getElementById('gs-download-btn').addEventListener('click', async () => {
    await triggerCompanionDownload(phone, os, 'gs-download-note');
  });
}

async function triggerCompanionDownload(phone, os, noteElId) {
  const noteEl = document.getElementById(noteElId);
  if (noteEl) noteEl.textContent = 'Setting up your download...';
  try {
    // Check for existing keys
    let keys = await get('/api/keys');
    let keyId;
    if (!keys || !keys.length) {
      // Auto-create one
      const result = await post('/api/keys', { name: 'My Companion' });
      keys = await get('/api/keys');
      if (noteEl) noteEl.innerHTML = 'Your API key was created automatically.';
      keyId = keys[0]?.id;
    } else {
      keyId = keys[0].id;
    }
    if (!keyId) { if (noteEl) noteEl.textContent = 'Could not find API key.'; return; }

    // Map phone+os to platform param
    let platform = 'mac';
    if (phone === 'windows' || os === 'windows') platform = 'windows';
    if (phone === 'iphone' && os === 'windows') platform = 'windows-iphone';
    if (phone === 'android' && os === 'windows') platform = 'windows';
    if (phone === 'android' && os === 'mac') platform = 'mac';
    if (phone === 'iphone' && os === 'mac') platform = 'mac-iphone';

    window.location.href = `/api/keys/${keyId}/companion?platform=${platform}`;
    if (noteEl && !noteEl.textContent.includes('created')) noteEl.textContent = 'Download started.';
  } catch (err) {
    if (noteEl) noteEl.textContent = 'Error: ' + err.message;
  }
}

// ── Billing ───────────────────────────────────────────────────────────────

function renderBilling(main) {
  const u = currentUser;
  const billingCycle = localStorage.getItem('billing_cycle') || 'monthly';

  const prices = {
    monthly: { starter: { price: '$10',  period: '/mo', sub: '',               savings: '' },
               pro:     { price: '$30',  period: '/mo', sub: '',               savings: '' } },
    annual:  { starter: { price: '$8',   period: '/mo', sub: 'billed $96/yr',  savings: 'Save $24/yr' },
               pro:     { price: '$24',  period: '/mo', sub: 'billed $288/yr', savings: 'Save $72/yr' } },
  };

  const cur = prices[billingCycle];

  // Cancellation UX — Change 14
  const showCancelledMsg = u.subscription_status === 'cancelled' && u.billing_period_end;
  const renewalInfo = (() => {
    if (u.subscription_status === 'active' && u.billing_period_end) {
      return `<p style="color:var(--text-muted);font-size:13px">Renews on ${fmtDate(u.billing_period_end)}</p>`;
    }
    if (showCancelledMsg) {
      return `<p style="color:var(--warn);font-size:13px">Access ends on ${fmtDate(u.billing_period_end)} — you can still send until then</p>`;
    }
    if (u.plan === 'free') return `<p style="color:var(--text-muted);font-size:13px">No subscription</p>`;
    return '';
  })();

  main.innerHTML = `
    <div class="main-header"><h2>Plan &amp; Billing</h2></div>
    <div class="main-body">

      <div class="card" style="margin-bottom:20px;padding:20px">
        <h3 style="margin-bottom:4px">Current plan: <strong>${u.plan_label}</strong></h3>
        <p style="color:var(--text-muted);font-size:13.5px;margin-bottom:4px">${u.monthly_sends} of ${u.monthly_limit} sends used this month</p>
        ${renewalInfo}
        ${u.subscription_status === 'past_due' ? `<p style="color:var(--danger);font-size:13px;margin-bottom:8px">Payment past due. Update payment method to continue sending.</p>` : ''}
        <div style="display:flex;gap:8px;margin-top:12px">
          ${u.plan !== 'free' ? `<button class="btn btn-secondary btn-sm" id="manage-subscription-btn">Manage Subscription</button>` : ''}
          ${u.subscription_status === 'active' && u.plan !== 'free' ? `<button class="btn btn-ghost btn-sm" id="cancel-sub-btn" style="color:var(--danger)">Cancel subscription</button>` : ''}
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:20px">
        <span style="font-size:14px;font-weight:${billingCycle==='monthly'?'700':'400'}">Monthly</span>
        <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer">
          <input type="checkbox" id="billing-toggle" ${billingCycle==='annual'?'checked':''} style="opacity:0;width:0;height:0">
          <span style="position:absolute;inset:0;background:${billingCycle==='annual'?'#16a34a':'#ccc'};border-radius:99px;transition:0.2s"></span>
          <span style="position:absolute;top:3px;left:${billingCycle==='annual'?'23px':'3px'};width:18px;height:18px;background:#fff;border-radius:50%;transition:0.2s"></span>
        </label>
        <span style="font-size:14px;font-weight:${billingCycle==='annual'?'700':'400'}">Annual <span style="font-size:12px;background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:99px;font-weight:600">Save 20%</span></span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">

        <div class="card" style="padding:24px;${u.plan==='free'?'border-color:var(--accent);border-width:2px':''}">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:8px">Free</div>
          <div style="font-size:30px;font-weight:800;margin-bottom:4px">$0</div>
          <ul style="list-style:none;font-size:13.5px;margin:12px 0 20px;display:flex;flex-direction:column;gap:6px">
            <li>&#10003; 50 texts/month</li>
            <li>&#10003; Bulk send up to 10 contacts</li>
            <li>&#10003; Saved list contact limit: 10</li>
            ${window.electronAPI?.isDesktop ? '' : '<li>&#10003; Companion app included</li>'}
            <li style="color:var(--text-muted)">&#8212; No saved templates</li>
            <li style="color:var(--text-muted)">&#8212; No API/webhook sends</li>
          </ul>
          ${u.plan === 'free' ? `<div class="btn" style="width:100%;justify-content:center;background:var(--bg);border:1px solid var(--border);color:var(--text-muted);cursor:default">Current plan</div>` : ''}
        </div>

        <div class="card" style="padding:24px;border-color:#2563eb;border-width:2px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#2563eb;margin-bottom:8px">Starter — Most popular</div>
          <div style="font-size:30px;font-weight:800;margin-bottom:4px">${cur.starter.price}<span style="font-size:15px;font-weight:400;color:var(--text-muted)">${cur.starter.period}</span></div>
          ${billingCycle==='annual' ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:2px">${cur.starter.sub}</div><div style="font-size:12px;color:#16a34a;font-weight:600;margin-bottom:4px">&#10003; ${cur.starter.savings}</div>` : ''}
          <ul style="list-style:none;font-size:13.5px;margin:12px 0 16px;display:flex;flex-direction:column;gap:6px">
            <li>&#10003; 2,000 texts/month*</li>
            <li>&#10003; CSV upload &amp; bulk send — unlimited contacts</li>
            <li>&#10003; Saved list contact limit: 100</li>
            <li>&#10003; Saved templates</li>
            ${window.electronAPI?.isDesktop ? '' : '<li>&#10003; Companion app included</li>'}
            <li style="color:var(--text-muted)">&#8212; No API/webhook sends</li>
          </ul>
          <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:12px">*Recommended max 200/day to protect your number</div>
          ${u.plan === 'starter'
            ? `<div class="btn" style="width:100%;justify-content:center;background:var(--bg);border:1px solid var(--border);color:var(--text-muted);cursor:default">Current plan</div>`
            : `<button class="btn btn-primary" style="width:100%;justify-content:center;background:#2563eb" id="upgrade-starter">Get Starter</button>`}
        </div>

        <div class="card" style="padding:24px;${u.plan==='pro'?'border-color:var(--accent);border-width:2px':''}">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:8px">Pro</div>
          <div style="font-size:30px;font-weight:800;margin-bottom:4px">${cur.pro.price}<span style="font-size:15px;font-weight:400;color:var(--text-muted)">${cur.pro.period}</span></div>
          ${billingCycle==='annual' ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:2px">${cur.pro.sub}</div><div style="font-size:12px;color:#16a34a;font-weight:600;margin-bottom:4px">&#10003; ${cur.pro.savings}</div>` : ''}
          <ul style="list-style:none;font-size:13.5px;margin:12px 0 16px;display:flex;flex-direction:column;gap:6px">
            <li>&#10003; 6,000 texts/month*</li>
            <li>&#10003; Unlimited API keys</li>
            <li>&#10003; CSV upload &amp; bulk send — unlimited contacts</li>
            <li>&#10003; Saved list contact limit: 1,000</li>
            <li>&#10003; Saved templates</li>
            <li>&#10003; API webhook sends (Make, Zapier)</li>
            ${window.electronAPI?.isDesktop ? '' : '<li>&#10003; Companion app included</li>'}
          </ul>
          <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:12px">*Recommended max 200/day to protect your number</div>
          ${u.plan === 'pro'
            ? `<div class="btn" style="width:100%;justify-content:center;background:var(--bg);border:1px solid var(--border);color:var(--text-muted);cursor:default">Current plan</div>`
            : `<button class="btn btn-primary" style="width:100%;justify-content:center" id="upgrade-pro">Get Pro</button>`}
        </div>

      </div>

      <div id="billing-msg" style="margin-top:16px"></div>
    </div>`;

  const msg = document.getElementById('billing-msg');

  document.getElementById('billing-toggle').addEventListener('change', (e) => {
    const cycle = e.target.checked ? 'annual' : 'monthly';
    localStorage.setItem('billing_cycle', cycle);
    renderBilling(main);
  });

  const starterBtn = document.getElementById('upgrade-starter');
  const proBtn = document.getElementById('upgrade-pro');
  const manageBtn = document.getElementById('manage-subscription-btn');
  const cancelBtn = document.getElementById('cancel-sub-btn');

  if (starterBtn) starterBtn.addEventListener('click', openBillingPage);
  if (proBtn) proBtn.addEventListener('click', openBillingPage);
  if (manageBtn) manageBtn.addEventListener('click', openBillingPage);
  if (cancelBtn) cancelBtn.addEventListener('click', openBillingPage);
}

// ── Wizard ────────────────────────────────────────────────────────────────

function openWizard(prefillCsv) {
  const root = document.getElementById('wizard-root');
  root.innerHTML = '';

  const state = {
    step: 1,
    csvRaw: prefillCsv ? prefillCsv.raw : null,
    csvRows: prefillCsv ? prefillCsv.rows : [],
    csvColumns: prefillCsv ? prefillCsv.columns : [],
    columnMap: { first_name: '', last_name: '', phone: '', link: '', special: '' },
    extraColumns: [],
    template: '',
    campaignName: '',
    paceSeconds: 30,
    result: null,
  };

  function renderWizard() {
    root.innerHTML = '';
    const overlay = document.createElement('div');
    overlay.className = 'wizard-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) closeWizard(); });

    const steps = ['Upload', 'Map Columns', 'Compose', 'Preview & Send'];
    const wizard = document.createElement('div');
    wizard.className = 'wizard';
    wizard.innerHTML = `
      <div class="wizard-header">
        <h2>New Campaign</h2>
        <div class="wizard-steps">
          ${steps.map((s,i) => `<div class="wizard-step-label ${state.step === i+1 ? 'active' : ''} ${state.step > i+1 ? 'done' : ''}">${s}</div>`).join('')}
        </div>
      </div>
      <div class="wizard-body" id="wizard-body"></div>
      <div class="wizard-footer">
        <button class="btn btn-ghost" id="wiz-cancel">${state.step === 1 ? 'Cancel' : '&larr; Back'}</button>
        <div class="wizard-footer-right" id="wiz-actions"></div>
      </div>`;

    overlay.appendChild(wizard);
    root.appendChild(overlay);

    document.getElementById('wiz-cancel').addEventListener('click', () => {
      if (state.step === 1) closeWizard();
      else { state.step--; renderWizard(); }
    });

    const body = document.getElementById('wizard-body');
    const actions = document.getElementById('wiz-actions');

    switch (state.step) {
      case 1: renderStep1(body, actions, state); break;
      case 2: renderStep2(body, actions, state); break;
      case 3: renderStep3(body, actions, state); break;
      case 4: renderStep4(body, actions, state); break;
    }
  }

  function next() { state.step++; renderWizard(); }
  renderWizard();

  // Step 1 — Upload CSV
  function renderStep1(body, actions, state) {
    body.innerHTML = `
      <div id="step1-alert"></div>
      <div style="margin-bottom:14px">
        <a href="/api/csv-template" download class="btn btn-ghost btn-sm">&#8595; Download CSV template</a>
        <span style="font-size:12px;color:var(--text-muted);margin-left:8px">Columns: first_name, last_name, phone, special</span>
      </div>
      <div class="drop-zone" id="drop-zone">
        <div class="dz-icon">&#128196;</div>
        <p><strong>Drop your CSV here</strong></p>
        <p style="margin-top:6px;color:var(--text-muted)">or <span style="text-decoration:underline;cursor:pointer" id="browse-link">click to browse</span></p>
        <p style="margin-top:8px;font-size:12px;color:var(--text-muted)">Columns can be anything — first_name, phone, special, etc.</p>
      </div>
      <input type="file" id="file-input" accept=".csv,text/csv" style="display:none" />
      <div id="csv-summary" style="margin-top:12px"></div>`;

    const dz = document.getElementById('drop-zone');
    const fi = document.getElementById('file-input');

    document.getElementById('browse-link').addEventListener('click', () => fi.click());
    fi.addEventListener('change', () => { if (fi.files[0]) handleFile(fi.files[0]); });
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    async function handleFile(file) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        const data = await api('POST', '/api/upload', fd, true);
        state.csvRaw = data.raw;
        state.csvRows = data.rows;
        state.csvColumns = data.columns;
        document.getElementById('csv-summary').innerHTML = `
          <div class="alert alert-success">
            &#10003; <strong>${data.total} contacts</strong> found &mdash;
            Columns: ${data.columns.map(c => `<code title="${escHtml(c)}" style="font-family:var(--mono);font-size:12px;background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px">${escHtml(abbreviateColumnLabel(c))}</code>`).join(', ')}
          </div>`;
        document.getElementById('step1-alert').innerHTML = '';
        actions.innerHTML = `<button class="btn btn-primary" id="wiz-next">Next &rarr;</button>`;
        document.getElementById('wiz-next').addEventListener('click', next);
      } catch (err) {
        if (err.data && err.data.upgrade) {
          document.getElementById('step1-alert').innerHTML = `<div class="alert alert-error">CSV upload requires Starter or Pro. <button class="btn btn-primary btn-sm" onclick="closeWizard();navigate('billing')">Upgrade</button></div>`;
        } else {
          document.getElementById('step1-alert').innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
        }
      }
    }

    if (state.csvRaw) {
      document.getElementById('csv-summary').innerHTML = `<div class="alert alert-success">&#10003; CSV loaded — ${state.csvRows.length}+ contacts</div>`;
      actions.innerHTML = `<button class="btn btn-primary" id="wiz-next">Next &rarr;</button>`;
      document.getElementById('wiz-next').addEventListener('click', next);
    }
  }

  // Step 2 — Map columns
  function renderStep2(body, actions, state) {
    const noneOpt = `<option value="">-- none --</option>`;
    const colOpts = (selected) => state.csvColumns.map(c =>
      `<option value="${escHtml(c)}" ${selected === c ? 'selected' : ''}>${escHtml(abbreviateColumnLabel(c))}</option>`
    ).join('');

    body.innerHTML = `
      <p style="color:var(--text-muted);margin-bottom:18px;font-size:13.5px">Map your CSV columns. Only Phone is required.</p>
      <div class="form-row">
        <label>First Name</label>
        <select id="map-first">${noneOpt}${colOpts(state.columnMap.first_name)}</select>
      </div>
      <div class="form-row">
        <label>Last Name</label>
        <select id="map-last">${noneOpt}${colOpts(state.columnMap.last_name)}</select>
      </div>
      <div class="form-row">
        <label>Phone Number <span style="color:var(--danger)">*</span></label>
        <select id="map-phone">${noneOpt}${colOpts(state.columnMap.phone)}</select>
      </div>
      <div class="form-row">
        <label>Special (link, coupon, custom text)</label>
        <select id="map-special">${noneOpt}${colOpts(state.columnMap.special)}</select>
      </div>
      <div id="step2-alert"></div>`;

    // Auto-detect
    const g = state.csvColumns.find(c => /phone|mobile|cell/i.test(c));
    if (g && !state.columnMap.phone) document.getElementById('map-phone').value = g;
    const firstG = state.csvColumns.find(c => /first.?name|fname/i.test(c));
    if (firstG && !state.columnMap.first_name) document.getElementById('map-first').value = firstG;
    const lastG = state.csvColumns.find(c => /last.?name|lname/i.test(c));
    if (lastG && !state.columnMap.last_name) document.getElementById('map-last').value = lastG;
    const specialG = state.csvColumns.find(c => /special|coupon|link|url/i.test(c));
    if (specialG && !state.columnMap.special) document.getElementById('map-special').value = specialG;

    actions.innerHTML = `<button class="btn btn-primary" id="wiz-next">Next &rarr;</button>`;
    document.getElementById('wiz-next').addEventListener('click', () => {
      const phone = document.getElementById('map-phone').value;
      if (!phone) {
        document.getElementById('step2-alert').innerHTML = `<div class="alert alert-error">Phone column is required.</div>`;
        return;
      }
      state.columnMap.first_name = document.getElementById('map-first').value;
      state.columnMap.last_name = document.getElementById('map-last').value;
      state.columnMap.phone = phone;
      state.columnMap.special = document.getElementById('map-special').value;
      const mapped = Object.values(state.columnMap).filter(Boolean);
      state.extraColumns = state.csvColumns.filter(c => !mapped.includes(c));
      next();
    });
  }

  // Step 3 — Compose
  function renderStep3(body, actions, state) {
    const builtinTags = [
      ...(state.columnMap.first_name ? ['{first_name}'] : []),
      ...(state.columnMap.last_name ? ['{last_name}'] : []),
      ...(state.columnMap.special ? ['{special}'] : []),
    ];
    const extraTags = state.extraColumns.map(c => `{${c}}`);
    const allTags = [...builtinTags, ...extraTags];

    body.innerHTML = `
      <div class="form-row">
        <label>Insert field</label>
        <div class="merge-tags">
          ${allTags.map(t => `<span class="merge-tag" data-tag="${escHtml(t)}">${escHtml(t)}</span>`).join('')}
          ${allTags.length === 0 ? '<span style="font-size:12px;color:var(--text-muted)">Map columns in step 2 to get merge fields</span>' : ''}
        </div>
      </div>
      <div class="form-row">
        <label>Message</label>
        <textarea id="template-input" rows="5" placeholder="Hi {first_name}, we have something for you: {special}">${escHtml(state.template)}</textarea>
        <div class="char-count" id="char-count">0 chars · 1 segment (160 chars = 1 SMS)</div>
      </div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-top:-8px">Fields like {first_name} are replaced with real contact data when you send.</p>
      <div id="preview-area"></div>
      <div id="step3-alert"></div>`;

    const ta = document.getElementById('template-input');
    const cc = document.getElementById('char-count');

    document.querySelectorAll('.merge-tag').forEach(el => {
      el.addEventListener('click', () => {
        const pos = ta.selectionStart;
        const val = ta.value;
        ta.value = val.slice(0, pos) + el.dataset.tag + val.slice(ta.selectionEnd);
        ta.setSelectionRange(pos + el.dataset.tag.length, pos + el.dataset.tag.length);
        ta.focus();
        updatePreview();
      });
    });

    async function updatePreview() {
      const tmpl = ta.value;
      const len = tmpl.length;
      const segs = Math.ceil(len / 160) || 1;
      cc.textContent = `${len} chars · ${segs} segment${segs>1?'s':''} (160 chars = 1 SMS)`;
      cc.className = 'char-count' + (len > 306 ? ' char-danger' : len > 160 ? ' char-warn' : '');
      if (!tmpl.trim()) { document.getElementById('preview-area').innerHTML = ''; return; }
      try {
        const previews = await post('/api/preview', {
          template: tmpl,
          rows: state.csvRows.slice(0, 3),
          columnMap: state.columnMap,
        });
        document.getElementById('preview-area').innerHTML = `
          <label style="margin-top:4px">Preview (first ${previews.length} contacts)</label>
          <div class="preview-box">
            ${previews.map(p => `
              <div class="preview-item">
                <div class="preview-to">To: ${escHtml(p.phone)}${p.first_name ? ` &mdash; ${escHtml(p.first_name)} ${escHtml(p.last_name)}` : ''}</div>
                <div class="preview-body">${escHtml(p.body)}</div>
              </div>`).join('')}
          </div>`;
      } catch (_) {}
    }

    ta.addEventListener('input', updatePreview);
    if (state.template) updatePreview();

    actions.innerHTML = `<button class="btn btn-primary" id="wiz-next">Preview &rarr;</button>`;
    document.getElementById('wiz-next').addEventListener('click', () => {
      const tmpl = ta.value.trim();
      if (!tmpl) {
        document.getElementById('step3-alert').innerHTML = `<div class="alert alert-error">Message cannot be empty.</div>`;
        return;
      }
      state.template = tmpl;
      next();
    });
  }

  // Step 4 — Review & send
  function renderStep4(body, actions, state) {
    const csvRows = parseCsvRowCount(state.csvRaw);
    const total = csvRows;
    const limit = currentUser.monthly_limit;
    const used = currentUser.monthly_sends;
    const remaining = limit - used;
    const willSend = Math.min(total, remaining);
    const blocked = remaining <= 0;

    body.innerHTML = `
      <div class="form-row">
        <label>Campaign Name</label>
        <input type="text" id="campaign-name" value="${escHtml(state.campaignName)}" placeholder="e.g. April event invite" />
      </div>
      <div class="form-row">
        <label>Send Pace</label>
        <div class="pace-options">
          <label class="pace-option">
            <input type="radio" name="pace" value="0" ${state.paceSeconds === 0 ? 'checked' : ''} />
            <span>As fast as possible</span>
          </label>
          <label class="pace-option">
            <input type="radio" name="pace" value="custom" ${state.paceSeconds > 0 ? 'checked' : ''} />
            <div class="pace-inline">
              <span>Every</span>
              <input type="number" id="pace-val" value="${state.paceSeconds || 30}" min="5" max="3600" />
              <span>seconds (recommended: 30–60)</span>
            </div>
          </label>
        </div>
      </div>
      <div class="summary-stats">
        <div class="stat-box"><div class="stat-num">${total}</div><div class="stat-label">Contacts</div></div>
        <div class="stat-box"><div class="stat-num" style="color:${blocked?'var(--danger)':'inherit'}">${remaining}</div><div class="stat-label">Sends remaining</div></div>
        <div class="stat-box"><div class="stat-num" style="color:${blocked?'var(--danger)':'var(--success)'}">~${willSend}</div><div class="stat-label">Will send</div></div>
      </div>
      ${blocked ? upgradePrompt(`You've used all ${limit} sends this month.`) : ''}
      ${!blocked && total > remaining ? `<div class="alert alert-info" style="margin-bottom:12px">You have ${remaining} sends left. Only the first ${remaining} contacts will be sent.</div>` : ''}
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:4px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Message template:</div>
        <div style="font-family:var(--mono);font-size:12.5px;line-height:1.6;white-space:pre-wrap">${escHtml(state.template)}</div>
      </div>
      <div id="step4-alert" style="margin-top:12px"></div>`;

    actions.innerHTML = `
      <button class="btn btn-ghost" id="wiz-queue-draft">Save Draft</button>
      <button class="btn btn-primary" id="wiz-queue-now" ${blocked?'disabled':''}>Queue Sends &rarr;</button>`;

    async function submit(queueNow) {
      const name = document.getElementById('campaign-name').value.trim();
      if (!name) {
        document.getElementById('step4-alert').innerHTML = `<div class="alert alert-error">Campaign name is required.</div>`;
        return;
      }
      const paceRadio = document.querySelector('input[name="pace"]:checked').value;
      const paceSeconds = paceRadio === '0' ? 0 : parseInt(document.getElementById('pace-val').value) || 30;
      state.campaignName = name;
      state.paceSeconds = paceSeconds;

      if (queueNow) {
        // Change 9: show confirmation modal
        const previewMsg = state.csvRows[0] ? (() => {
          try {
            // Simple replacement preview
            let msg = state.template;
            const row = state.csvRows[0];
            if (state.columnMap.first_name && row[state.columnMap.first_name]) msg = msg.replace(/\{first_name\}/gi, row[state.columnMap.first_name]);
            if (state.columnMap.last_name && row[state.columnMap.last_name]) msg = msg.replace(/\{last_name\}/gi, row[state.columnMap.last_name]);
            if (state.columnMap.special && row[state.columnMap.special]) msg = msg.replace(/\{special\}/gi, row[state.columnMap.special]);
            return msg;
          } catch (_) { return state.template; }
        })() : state.template;

        showSendConfirmModal(null, previewMsg, total, () => doSubmit(true));
      } else {
        doSubmit(false);
      }
    }

    async function doSubmit(queueNow) {
      document.getElementById('wiz-queue-now').disabled = true;
      document.getElementById('wiz-queue-draft').disabled = true;
      const name = state.campaignName;
      const paceSeconds = state.paceSeconds;

      try {
        const result = await post('/api/jobs', {
          name,
          template: state.template,
          rows: state.csvRaw,
          columnMap: state.columnMap,
          paceSeconds,
        });

        if (queueNow) {
          await patch(`/api/jobs/${result.job_id}/status`, { status: 'queued' });
        }

        currentUser = await get('/api/auth/me');
        updateUserBadge();
        closeWizard();
        navigate('history');
        setTimeout(() => openJobDetail(result.job_id), 300);
      } catch (err) {
        const alertEl = document.getElementById('step4-alert');
        if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}${err.data&&err.data.upgrade?' <button class="btn btn-primary btn-sm" onclick="closeWizard();navigate(\'billing\')">Upgrade</button>':''}</div>`;
        if (document.getElementById('wiz-queue-now')) document.getElementById('wiz-queue-now').disabled = false;
        if (document.getElementById('wiz-queue-draft')) document.getElementById('wiz-queue-draft').disabled = false;
      }
    }

    document.getElementById('wiz-queue-now').addEventListener('click', () => submit(true));
    document.getElementById('wiz-queue-draft').addEventListener('click', () => submit(false));
  }

  // Minimal CSV row counter (client-side)
  function parseCsvRowCount(csvRaw) {
    if (!csvRaw) return 0;
    const lines = csvRaw.trim().split('\n');
    return lines.slice(1).filter(l => l.trim()).length;
  }
}

function closeWizard() {
  document.getElementById('wizard-root').innerHTML = '';
}

// ── Account Settings (full view) ───────────────────────────────────────────

function renderAccount(main) {
  const u = currentUser;
  const planInfo = (() => {
    if (u.subscription_status === 'active' && u.billing_period_end) {
      const interval = u.billing_interval === 'annual' ? 'billed annually' : 'billed monthly';
      return `<div style="font-size:13.5px;color:var(--text-muted)">${u.plan_label} — ${interval}</div>
              <div style="font-size:13px;color:var(--text-muted);margin-top:2px">Renews ${fmtDate(u.billing_period_end)}</div>`;
    }
    if (u.subscription_status === 'cancelled' && u.billing_period_end) {
      return `<div style="font-size:13.5px;color:var(--warn)">Access ends ${fmtDate(u.billing_period_end)} — you can still send until then</div>`;
    }
    if (u.plan === 'free') return `<div style="font-size:13.5px;color:var(--text-muted)">Free plan — no subscription</div>`;
    return `<div style="font-size:13.5px;color:var(--text-muted)">${u.plan_label}</div>`;
  })();

  main.innerHTML = `
    <div class="main-header"><h2>Account Settings</h2></div>
    <div class="main-body">

      <div class="card" style="max-width:560px;margin-bottom:20px">
        <div class="card-header"><h3>Plan &amp; Billing</h3></div>
        <div class="card-body">
          ${planInfo}
          <div style="margin-top:10px">
            <div style="font-size:13px;color:var(--text-muted)">Sends: ${u.monthly_sends} / ${u.monthly_limit} this period</div>
            <div class="progress-bar" style="margin-top:6px">
              <div class="progress-fill" style="width:${Math.min(100, Math.round(u.monthly_sends/u.monthly_limit*100))}%"></div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
            ${u.plan !== 'pro' && !u.is_admin && !u.manual_account ? `<button class="btn btn-primary btn-sm" id="acct-upgrade-btn">Upgrade Plan</button>` : ''}
            ${u.plan !== 'free' ? `<button class="btn btn-ghost btn-sm" id="acct-manage-billing">Manage Billing</button>` : ''}
            ${u.subscription_status === 'active' && u.plan !== 'free' ? `<button class="btn btn-ghost btn-sm" id="acct-cancel-sub" style="color:var(--danger)">Cancel Subscription</button>` : ''}
          </div>
        </div>
      </div>

      <div class="card" style="max-width:560px;margin-bottom:20px">
        <div class="card-header"><h3>Account</h3></div>
        <div class="card-body">
          <div style="font-size:13.5px;color:var(--text-muted);margin-bottom:14px">${escHtml(u.email)}</div>
          <div id="chpw-alert"></div>
          <div class="form-row">
            <label>Current Password</label>
            <input type="password" id="chpw-current" placeholder="Current password" style="max-width:320px" />
          </div>
          <div class="form-row">
            <label>New Password</label>
            <input type="password" id="chpw-new" placeholder="New password (8+ chars, letter, number, special)" style="max-width:320px" />
          </div>
          <button class="btn btn-ghost btn-sm" id="chpw-save">Change Password</button>
        </div>
      </div>

      ${window.electronAPI?.platform === 'darwin' ? `
      <div class="card" style="max-width:560px;margin-bottom:20px">
        <div class="card-header"><h3>macOS Permissions</h3></div>
        <div class="card-body" style="font-size:13.5px;line-height:1.6">
          <p style="margin-bottom:10px">Text Your List needs two permissions: <strong>Automation</strong> (to send via Messages) and <strong>Full Disk Access</strong> (to detect iPhone vs Android and route to iMessage or SMS).</p>
          <p style="margin-bottom:14px;color:var(--text-muted)">If sending isn't working or smart routing is off, click below to re-run the permissions setup.</p>
          <button class="btn btn-primary btn-sm" id="btn-manage-permissions">Manage Permissions</button>
        </div>
      </div>` : ''}

      ${(u.plan === 'pro' || u.is_admin || u.manual_account) ? `
      <div class="card" style="max-width:560px;margin-bottom:20px">
        <div class="card-header"><h3 style="text-transform:none">Api send behavior <span style="font-size:11px;font-weight:500;background:var(--accent-light,#e8f0ff);color:var(--accent);padding:2px 7px;border-radius:10px;margin-left:6px">Pro</span></h3></div>
        <div class="card-body">
          <div id="api-pace-alert"></div>
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:6px;font-weight:600">When a message arrives via API:</p>
          <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px">
            <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;text-transform:none;letter-spacing:0;font-weight:normal">
              <input type="radio" name="api_pace" value="0" style="margin-top:3px" ${u.api_default_pace === 0 ? 'checked' : ''}>
              <span>
                <strong style="font-size:13.5px">Fast</strong>
                <div style="font-size:12.5px;color:var(--text-muted)">Send immediately while the app is open. Held for review if the app is closed.</div>
              </span>
            </label>
            <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;text-transform:none;letter-spacing:0;font-weight:normal">
              <input type="radio" name="api_pace" value="7" style="margin-top:3px" ${(u.api_default_pace === 7 || u.api_default_pace === 20 || u.api_default_pace == null) ? 'checked' : ''}>
              <span>
                <strong style="font-size:13.5px">Smart throttle (recommended)</strong>
                <div style="font-size:12.5px;color:var(--text-muted)">7-14s randomized delay while the app is open. Held for review if the app is closed.</div>
              </span>
            </label>
            <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;text-transform:none;letter-spacing:0;font-weight:normal">
              <input type="radio" name="api_pace" value="-1" style="margin-top:3px" ${u.api_default_pace === -1 ? 'checked' : ''}>
              <span>
                <strong style="font-size:13.5px">Hold for review</strong>
                <div style="font-size:12.5px;color:var(--text-muted)">Always held — even if the app is open. Nothing sends until you explicitly approve it. Best for Windows or anyone who wants full control.</div>
              </span>
            </label>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
            <p style="font-size:13px;color:var(--text-muted);font-weight:600;margin:0">Send platform:</p>
            <span title="Only matters if you have Text Your List installed on both Mac and Windows. Most users have one machine and can leave this on Mac (default)." style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--text-muted,#888);color:#fff;font-size:10px;font-weight:700;cursor:help;flex-shrink:0">i</span>
          </div>
          <div style="margin-bottom:14px">
            <select name="api_send_platform" style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13.5px;background:var(--bg);color:var(--text);text-transform:none">
              <option value="mac" ${(u.api_send_platform === 'mac' || !u.api_send_platform) ? 'selected' : ''}>Mac (default)</option>
              <option value="windows" ${u.api_send_platform === 'windows' ? 'selected' : ''}>Windows</option>
              <option value="any" ${u.api_send_platform === 'any' ? 'selected' : ''}>Any (first available)</option>
            </select>
            <div id="windows-platform-warning" style="margin-top:8px;padding:8px 10px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;font-size:12px;color:#92400e;${(u.api_send_platform === 'windows') ? '' : 'display:none'}">⚠ Windows sends go through Phone Link. If you are actively using your Windows machine when sends come in, Phone Link may disrupt your work. Consider using <strong>Hold until launch</strong> above to control when sends happen.</div>
          </div>
          <button class="btn btn-ghost btn-sm" id="save-api-pace">Save</button>
        </div>
      </div>` : ''}

    </div>`;

  const managePermBtn = document.getElementById('btn-manage-permissions');
  if (managePermBtn) managePermBtn.addEventListener('click', () => { window.location.href = '/setup'; });

  const upgBtn = document.getElementById('acct-upgrade-btn');
  if (upgBtn) upgBtn.addEventListener('click', openBillingPage);

  const manageBillingBtn = document.getElementById('acct-manage-billing');
  if (manageBillingBtn) manageBillingBtn.addEventListener('click', openBillingPage);

  const cancelBtn = document.getElementById('acct-cancel-sub');
  if (cancelBtn) cancelBtn.addEventListener('click', openBillingPage);

  document.getElementById('chpw-save').addEventListener('click', async () => {
    const currentPassword = document.getElementById('chpw-current').value;
    const newPassword = document.getElementById('chpw-new').value;
    const alertEl = document.getElementById('chpw-alert');
    alertEl.innerHTML = '';
    try {
      await post('/api/auth/change-password', { currentPassword, newPassword });
      alertEl.innerHTML = '<div class="alert alert-success">Password changed successfully.</div>';
      document.getElementById('chpw-current').value = '';
      document.getElementById('chpw-new').value = '';
    } catch (err) {
      alertEl.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
    }
  });

  const saveApiPaceBtn = document.getElementById('save-api-pace');
  if (saveApiPaceBtn) {
    const platformSelect = document.querySelector('select[name="api_send_platform"]');
    if (platformSelect) {
      platformSelect.addEventListener('change', () => {
        const warnEl = document.getElementById('windows-platform-warning');
        if (warnEl) warnEl.style.display = platformSelect.value === 'windows' ? '' : 'none';
      });
    }

    saveApiPaceBtn.addEventListener('click', async () => {
      const selected = document.querySelector('input[name="api_pace"]:checked');
      const platformEl = document.querySelector('select[name="api_send_platform"]');
      if (!selected) return;
      const alertEl = document.getElementById('api-pace-alert');
      alertEl.innerHTML = '';
      const pace = parseInt(selected.value, 10);
      const platform = platformEl ? platformEl.value : 'mac';
      try {
        await patch('/api/user/settings', { api_default_pace: pace, api_send_platform: platform });
        alertEl.innerHTML = '<div class="alert alert-success">Saved.</div>';
        currentUser.api_default_pace = pace;
        currentUser.api_send_platform = platform;
        // Update Windows warning visibility without full re-render
        const warnEl = document.getElementById('windows-platform-warning');
        if (warnEl) warnEl.style.display = platform === 'windows' ? '' : 'none';
      } catch (err) {
        alertEl.innerHTML = `<div class="alert alert-error">${escHtml(err.message)}</div>`;
      }
    });
  }
}

// ── Help ───────────────────────────────────────────────────────────────────

function renderHelp(main) {
  main.innerHTML = `
    <div class="main-header"><h2>Help</h2></div>
    <div class="main-body">
      <div class="card" style="max-width:560px;margin-bottom:20px">
        <div class="card-header"><h3>Quick Tips</h3></div>
        <div class="card-body" style="font-size:13.5px;line-height:1.6;display:flex;flex-direction:column;gap:12px">
          <div><strong>Daily send limit</strong><br>We recommend no more than 200 bulk sends per day to protect your number from spam filters. Test sends don't count toward this limit.</div>
          <div><strong>Merge fields</strong><br>Use <code>{first_name}</code>, <code>{last_name}</code>, or any CSV column in your message to personalize each text.</div>
          <div><strong>Suppression list</strong><br>Numbers on your suppression list are automatically skipped in all bulk sends.</div>
          <div><strong>Test Send</strong><br>Use Test Send to send a one-off test message to a single number before doing a bulk send.</div>
        </div>
      </div>
      <div class="card" style="max-width:560px;margin-bottom:20px">
        <div class="card-header"><h3>Your data</h3></div>
        <div class="card-body" style="font-size:13.5px;line-height:1.6;color:var(--text-muted)">
          <p style="margin-bottom:8px">Contact lists, templates, and send history are stored locally on your computer — nothing is sent to our servers.</p>
          <p>Your data lives at: <code style="font-size:12px;background:var(--bg);padding:2px 6px;border-radius:4px">${window.electronAPI?.platform === 'darwin' ? '~/Library/Application Support/Text Your List/' : '%APPDATA%\\Text Your List\\'}</code></p>
          <p style="margin-top:8px">If you reinstall the app, this folder is preserved automatically. To keep a backup, copy this folder to a safe location.</p>
        </div>
      </div>
      <div class="card" style="max-width:560px;margin-bottom:20px">
        <div class="card-header"><h3>About</h3></div>
        <div class="card-body" style="font-size:13.5px;color:var(--text-muted)">
          Text Your List schedules messages sent from your own device. You are responsible for compliance with applicable messaging laws.
          <div style="margin-top:12px;display:flex;gap:12px">
            <button class="btn btn-ghost btn-sm js-help-ext" data-url="https://textyourlist.com/terms">Terms of Use</button>
            <button class="btn btn-ghost btn-sm js-help-ext" data-url="https://textyourlist.com/privacy">Privacy Policy</button>
          </div>
        </div>
      </div>
      <div class="card" style="max-width:560px">
        <div class="card-header"><h3>Support</h3></div>
        <div class="card-body">
          <p style="font-size:14px;margin-bottom:16px">Have a question or issue? Our support team is here to help.</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <a href="mailto:support@textyourlist.com" class="btn btn-primary">Email Support</a>
            <button class="btn btn-ghost" id="help-docs-btn">View Documentation</button>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('help-docs-btn').addEventListener('click', () => {
    const url = 'https://textyourlist.com/help';
    if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
    else window.open(url, '_blank');
  });

  main.querySelectorAll('.js-help-ext').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.url;
      if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
      else window.open(url, '_blank');
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────

init();
