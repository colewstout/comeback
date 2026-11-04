(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  const money = (cents) => '$' + Math.round((cents || 0) / 100).toLocaleString('en-US');
  const DAY = 864e5;
  const dnum = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };
  const pretty = (iso) => new Date(dnum(iso) * DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const when = (ts) => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const gapTxt = (d) => (d >= 14 ? `every ${Math.round(d / 7)} wks` : `every ${Math.round(d)} days`);
  const agoTxt = (d) => (d >= 60 ? `${Math.round(d / 30)} months` : d >= 14 ? `${Math.round(d / 7)} weeks` : `${d} days`);

  const S = { me: null, filter: 'attention', shown: 100, customers: null, openId: null };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.startsWith('/api/auth')) { S.me = null; showAuth('login'); throw new Error(data.error || 'Please log in.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3800); }

  // ---------- auth
  function showAuth(which) {
    $('appView').hidden = true; $('authView').hidden = false;
    ['login', 'signup', 'forgot', 'reset'].forEach((f) => ($(`${f}Form`).hidden = which !== f));
    $('authError').hidden = true;
  }

  // The reset token arrives in the link's #reset=... part. Keep it in memory and clear it
  // from the address bar so it doesn't linger in history or get copied.
  let resetToken = null;
  function takeResetToken() {
    const m = /^#reset=([A-Za-z0-9_-]{20,200})$/.exec(location.hash);
    if (!m) return false;
    resetToken = m[1];
    history.replaceState(null, '', location.pathname + '#reset');
    return true;
  }

  $('forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/api/auth/forgot', { email: $('fp-email').value });
      const done = $('forgotDone'); done.textContent = r.message; done.hidden = false;
      $('authError').hidden = true;
    } catch (err) { authError(err.message); }
    finally { if (btn) btn.disabled = false; }
  });

  $('resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('rp-pw').value !== $('rp-pw2').value) return authError('The two passwords don’t match.');
    if (!resetToken) return authError('This page is missing its reset link. Open the link from your email again, or ask for a new one.');
    try {
      await api('POST', '/api/auth/reset', { token: resetToken, password: $('rp-pw').value });
      resetToken = null;
      location.hash = '#overview';
      await boot();
      toast('Your password is changed and you’re logged in.');
    } catch (err) { authError(err.message); }
  });
  function authError(msg) { const e = $('authError'); e.textContent = msg; e.hidden = false; }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/auth/login', { email: $('li-email').value, password: $('li-pw').value }); location.hash = '#overview'; await boot(); }
    catch (err) { authError(err.message); }
  });
  $('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/auth/signup', {
        name: $('su-name').value, businessName: $('su-biz').value, industry: $('su-industry').value,
        email: $('su-email').value, password: $('su-pw').value,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
      });
      location.hash = '#import'; await boot();
    } catch (err) { authError(err.message); }
  });
  $('logoutBtn').addEventListener('click', async () => { await api('POST', '/api/auth/logout').catch(() => {}); S.me = null; location.hash = '#login'; showAuth('login'); });

  // ---------- routing
  const TABS = ['overview', 'import', 'messages', 'settings'];
  function route() {
    if (takeResetToken() || location.hash === '#reset') return showAuth('reset');
    const h = location.hash.slice(1);
    if (h === 'forgot') return showAuth('forgot');
    if (!S.me) return showAuth(h === 'signup' ? 'signup' : 'login');
    if (h === 'billing-success') { toast('Thanks! Your subscription is active.'); location.hash = '#settings'; return; }
    const SQ_MSG = {
      'square-connected': 'Square is connected. Importing your last year of sales now; this can take a minute.',
      'square-cancelled': 'Square wasn’t connected because access wasn’t approved.',
      'square-error': 'Connecting Square didn’t work. Please try again.',
      'square-unavailable': 'Square isn’t set up on this server yet.',
    };
    if (SQ_MSG[h]) { toast(SQ_MSG[h]); location.hash = '#settings'; if (h === 'square-connected') pollSquare(); return; }
    const tab = TABS.includes(h) ? h : 'overview';
    $('authView').hidden = true; $('appView').hidden = false;
    TABS.forEach((t) => ($(`tab-${t}`).hidden = t !== tab));
    document.querySelectorAll('[data-tab]').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
    ({ overview: renderOverview, import: renderImports, messages: renderMessages, settings: renderSettings })[tab]().catch((e) => toast(e.message));
  }
  window.addEventListener('hashchange', route);

  async function boot() {
    try { S.me = await api('GET', '/api/me'); } catch { S.me = null; }
    if (S.me) renderBanner();
    route();
  }

  function renderBanner() {
    const b = S.me.business; const el = $('banner');
    const days = Math.ceil((new Date(b.trial_ends_at) - Date.now()) / DAY);
    let msg = '';
    if (b.plan_status === 'trialing') msg = days > 0 ? `Free trial: ${days} day${days === 1 ? '' : 's'} left. <a href="#settings">Choose a plan</a>` : `Your free trial has ended, so messages are paused. <a href="#settings">Choose a plan</a>`;
    else if (b.plan_status === 'past_due') msg = `Your last payment didn't go through, so messages are paused. <a href="#settings">Update billing</a>`;
    else if (b.plan_status === 'canceled') msg = `Your subscription is canceled, so messages are paused. <a href="#settings">Restart it</a>`;
    el.innerHTML = msg; el.hidden = !msg;
  }

  // ---------- overview
  const LABEL = { ok: 'On track', due: 'Due now', overdue: 'Overdue', lapsed: 'Lapsed', in_progress: 'Win-back running', won: 'Came back' };
  function pill(c) {
    let t = LABEL[c.display];
    if ((c.display === 'overdue' || c.display === 'lapsed') && c.rhythm) t += ` · ${c.rhythm.overdueByDays}d`;
    if (c.display === 'in_progress' && c.sequence) t = `Message ${c.sequence.steps_sent} of 3 sent`;
    return `<span class="pill p-${c.display}">${esc(t)}</span>`;
  }

  function strip(c, today) {
    if (!c.rhythm) return '';
    const W = 260, H = 24, y = 12, start = dnum(today) - 365, end = dnum(today) + 75;
    const x = (d) => (4 + Math.max(0, Math.min(1, (d - start) / (end - start))) * (W - 8)).toFixed(1);
    const col = { ok: 'var(--ok)', due: 'var(--due)', overdue: 'var(--over)', lapsed: 'var(--lapsed)', in_progress: 'var(--marigold)', won: 'var(--pine)' }[c.display];
    const next = dnum(c.rhythm.nextExpected), t = dnum(today);
    let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line x1="4" y1="${y}" x2="${W - 4}" y2="${y}" stroke="var(--line)" stroke-width="2"/>`;
    if (next <= t && c.display !== 'won') s += `<line x1="${x(next)}" y1="${y}" x2="${x(t)}" y2="${y}" stroke="${col}" stroke-width="2" stroke-dasharray="3 3"/>`;
    c.recentVisits.forEach((d) => (s += `<circle cx="${x(dnum(d))}" cy="${y}" r="4" fill="var(--pine)"/>`));
    if (c.display !== 'won') s += `<circle cx="${x(next)}" cy="${y}" r="5" fill="var(--surface)" stroke="${next > t ? 'var(--ok)' : col}" stroke-width="2"/>`;
    return s + `<line x1="${x(t)}" y1="3" x2="${x(t)}" y2="${H - 3}" stroke="var(--ink)" stroke-width="1.5"/></svg>`;
  }

  async function renderOverview() {
    const b = S.me.business;
    $('bizName').textContent = b.name;
    $('autopilotPill').className = `pill ${b.autopilot ? 'p-won' : ''}`;
    $('autopilotPill').textContent = b.autopilot ? 'Autopilot on' : 'Autopilot off';
    const [{ dashboard: d }, list] = await Promise.all([api('GET', '/api/dashboard'), api('GET', `/api/customers?status=${S.filter}`)]);
    S.customers = list;
    $('bizSub').textContent = d.customers ? `${d.customers.toLocaleString()} customers tracked` : 'No customers yet';
    $('tiles').innerHTML = `
      <div class="tile"><span>Due now</span><b>${d.due}</b><small>Right on their usual gap</small></div>
      <div class="tile bad"><span>Overdue or lapsed</span><b>${d.overdue + d.lapsed}</b><small>${d.customers ? Math.round(((d.overdue + d.lapsed) / d.customers) * 100) : 0}% of your list</small></div>
      <div class="tile bad"><span>Revenue slipping</span><b>${money(d.slippingMonthlyCents)}<small>/mo</small></b><small>From overdue customers</small></div>
      <div class="tile"><span>Win-backs running</span><b>${d.inProgress}</b><small>${d.last30.messagesSent} messages sent in 30 days</small></div>
      <div class="tile good"><span>Recovered (30 days)</span><b>${money(d.last30.recoveredCents)}</b><small>${d.last30.wins} came back · ${money(d.allTime.recoveredCents)} all time</small></div>`;
    $('emptyState').hidden = d.customers > 0;
    $('listCard').hidden = d.customers === 0;
    const F = [['attention', 'Needs attention', (c) => (c.due || 0) + (c.overdue || 0) + (c.lapsed || 0)], ['overdue', 'Overdue'], ['lapsed', 'Lapsed'], ['due', 'Due now'], ['in_progress', 'Win-back running'], ['won', 'Came back'], ['ok', 'On track'], ['all', 'All', () => list.total]];
    $('chips').innerHTML = F.map(([k, lab, fn]) => `<button class="chip" type="button" data-f="${k}" aria-pressed="${S.filter === k}">${lab}<span class="c">${fn ? fn(list.counts) : list.counts[k] || 0}</span></button>`).join('');
    renderRows();
  }

  function renderRows() {
    const { customers, today } = S.customers;
    const rows = customers.slice(0, S.shown);
    $('rows').innerHTML = `<div class="rhead"><span>Customer</span><span>Last 12 months</span><span>Usual gap</span><span>Avg spend</span><span>Status</span><span></span></div>` +
      (rows.length ? rows.map((c) => {
        const r = c.rhythm;
        const canStart = ['due', 'overdue', 'lapsed'].includes(c.display) && c.channel;
        return `<div class="crow">
          <div class="nm"><b>${esc(c.name)}</b><small>${r ? `${r.visitCount} visit${r.visitCount === 1 ? '' : 's'} · last ${pretty(r.lastVisit)}` : 'No visits'}</small></div>
          <div class="rh">${strip(c, today)}</div>
          <div class="gap">${r ? (r.learned ? gapTxt(r.intervalDays) : 'New customer') : '—'}<small>${r ? `seen ${agoTxt(r.daysSince)} ago` : ''}</small></div>
          <div class="money">${r ? money(r.avgCents) : '—'}<small>${r ? money(r.monthlyValueCents) + '/mo' : ''}</small></div>
          <div class="st">${pill(c)}</div>
          <div class="act"><button class="btn ${canStart ? 'btn-primary' : 'btn-ghost'} btn-sm" type="button" data-open="${c.id}">${canStart ? 'Win back' : 'Open'}</button></div>
        </div>`;
      }).join('') : `<div class="empty">Nobody here right now.</div>`) +
      (customers.length > S.shown ? `<div class="more"><button class="btn btn-ghost btn-sm" type="button" id="moreBtn">Show ${Math.min(100, customers.length - S.shown)} more of ${customers.length - S.shown}</button></div>` : '');
  }

  $('chips').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b) { S.filter = b.dataset.f; S.shown = 100; renderOverview().catch((err) => toast(err.message)); } });
  $('rows').addEventListener('click', (e) => {
    if (e.target.id === 'moreBtn') { S.shown += 100; return renderRows(); }
    const b = e.target.closest('[data-open]'); if (b) openCustomer(b.dataset.open);
  });

  // ---------- customer drawer
  let lastFocus = null;
  async function openCustomer(id) {
    S.openId = id;
    const data = await api('GET', `/api/customers/${id}`).catch((e) => (toast(e.message), null));
    if (!data) return;
    const { customer: c, visits, sequences, messages, preview } = data;
    const r = c.rhythm;
    const active = sequences.find((s) => s.status === 'active');
    const sentBySeq = (sid) => messages.filter((m) => m.sequence_id === sid && m.direction === 'out').sort((a, b) => a.step - b.step);
    const canStart = !active && c.channel;
    const blocked = !c.channel ? (c.sms_opted_out || c.email_opted_out ? 'This customer opted out of messages.' : 'Add an email, or a phone number with text permission, to reach this customer.') : '';

    let plan = '';
    if (active) {
      const sent = sentBySeq(active.id);
      plan = `<h2>Win-back in progress</h2><p class="muted">Code ${esc(active.discount_code)} · next message ${active.next_step_at ? when(active.next_step_at) : '—'}</p>` +
        sent.map((m) => `<div class="step sent"><h3><span>Message ${m.step + 1} · ${m.channel === 'sms' ? 'Text' : 'Email'}</span><span class="pill ${m.status === 'sent' ? 'p-won' : 'p-overdue'}">${esc(m.status)}</span></h3>${esc(m.body)}${m.error ? `<p class="error small">${esc(m.error)}</p>` : ''}</div>`).join('');
    } else if (preview.length) {
      plan = `<h2>${canStart ? 'What we’ll send' : 'Message preview'}</h2><p class="muted">By ${c.channel === 'sms' ? 'text' : 'email'}. It stops as soon as they come back or opt out.</p>` +
        preview.map((p) => `<div class="step"><h3><span>${esc(p.name)}</span><span class="muted small">Day ${p.day}</span></h3>${esc(p.body)}</div>`).join('');
    }

    const history = sequences.filter((s) => s.status !== 'active').map((s) => `<li>${pretty(s.started_at.slice(0, 10))}: ${s.status === 'won' ? `came back, ${money(s.recovered_cents)}` : s.status === 'stopped' ? `stopped (${esc(s.stop_reason || '')})` : 'no response'} · ${s.steps_sent} sent</li>`).join('');
    const replies = messages.filter((m) => m.direction === 'in').map((m) => `<div class="step"><h3><span>Reply</span><span class="muted small">${when(m.created_at)}</span></h3>${esc(m.body)}</div>`).join('');

    $('drawer').innerHTML = `
      <div class="dtop"><div><h2 id="dTitle" style="font-size:26px">${esc(c.name)}</h2><div style="margin-top:6px">${pill(c)}</div></div><button class="x" type="button" data-act="close" aria-label="Close">×</button></div>
      <div class="facts">
        <div><b>${r ? (r.learned ? gapTxt(r.intervalDays).replace('every ', '') : 'New') : '—'}</b>usual gap</div>
        <div><b>${r ? agoTxt(r.daysSince) : '—'}</b>since last visit</div>
        <div><b>${r ? money(r.avgCents) : '—'}</b>avg spend</div>
      </div>
      ${blocked ? `<p class="error small">${blocked}</p>` : ''}
      <div class="row-gap">
        ${canStart ? `<button class="btn btn-primary" type="button" data-act="start">Start win-back</button>` : ''}
        ${active ? `<button class="btn btn-ghost" type="button" data-act="stop">Stop win-back</button>` : ''}
      </div>
      ${replies ? `<h2>Replies</h2>${replies}` : ''}
      ${plan}
      <h2>Contact</h2>
      <form class="stack" id="contactForm">
        <div class="contact">
          <label class="field">Phone<input id="c-phone" value="${esc(c.phone || '')}" inputmode="tel"></label>
          <label class="field">Email<input id="c-email" value="${esc(c.email || '')}" type="email"></label>
        </div>
        <label class="check"><input type="checkbox" id="c-sms" ${c.sms_consent ? 'checked' : ''}> This customer agreed to receive texts${c.sms_opted_out ? ' (they replied STOP, so texts stay off)' : ''}</label>
        <div class="row-gap"><button class="btn btn-ghost btn-sm" type="submit">Save contact</button><button class="btn btn-danger btn-sm" type="button" data-act="optout">Never contact</button></div>
      </form>
      ${history ? `<h2>Past win-backs</h2><ul class="muted">${history}</ul>` : ''}
      <h2>Visits</h2>
      <div class="tbl"><table><thead><tr><th>Date</th><th class="n">Amount</th></tr></thead><tbody>${visits.slice(0, 24).map((v) => `<tr><td>${pretty(v.visited_at)}</td><td class="n">${money(v.amount_cents)}</td></tr>`).join('')}</tbody></table></div>`;
    lastFocus = document.activeElement;
    $('scrim').hidden = false; document.body.style.overflow = 'hidden';
    $('drawer').querySelector('[data-act="close"]').focus();
  }
  function closeDrawer() { $('scrim').hidden = true; document.body.style.overflow = ''; S.openId = null; lastFocus?.focus?.(); }

  $('drawer').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = S.openId;
    try {
      if (b.dataset.act === 'close') return closeDrawer();
      b.disabled = true;
      if (b.dataset.act === 'start') {
        const r = await api('POST', `/api/customers/${id}/winback`);
        toast(r.firstMessage === 'sent' ? 'First message sent.' : r.firstMessage === 'failed' ? 'Started, but the first message failed. We’ll retry within the hour.' : 'Started. The first message goes out at the start of your sending hours.');
      } else if (b.dataset.act === 'stop') { await api('POST', `/api/customers/${id}/stop`); toast('Win-back stopped.'); }
      else if (b.dataset.act === 'optout') { await api('POST', `/api/customers/${id}/opt-out`); toast('This customer won’t be contacted.'); }
      await openCustomer(id); renderOverview().catch(() => {});
    } catch (err) { toast(err.message); b.disabled = false; }
  });
  $('drawer').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/api/customers/${S.openId}`, { phone: $('c-phone').value || null, email: $('c-email').value || null, sms_consent: $('c-sms').checked });
      toast('Contact saved.'); await openCustomer(S.openId); renderOverview().catch(() => {});
    } catch (err) { toast(err.message); }
  });
  $('scrim').addEventListener('click', (e) => { if (e.target === $('scrim')) closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('scrim').hidden) closeDrawer(); });

  // ---------- import
  async function uploadFile(file) {
    if (!file) return;
    const out = $('importResult');
    if (file.size > 14 * 1024 * 1024) { out.innerHTML = `<div class="result err">That file is over 14 MB. Split it into smaller files.</div>`; return; }
    out.innerHTML = `<p class="muted">Uploading ${esc(file.name)}…</p>`;
    try {
      const csv = await file.text();
      const r = await api('POST', '/api/imports', { filename: file.name, csv, smsConsentAll: $('consentAll').checked });
      out.innerHTML = `<div class="result"><b>Done.</b> ${r.visitsAdded.toLocaleString()} new purchases, ${r.customersCreated.toLocaleString()} new customers, ${r.customersUpdated.toLocaleString()} existing customers updated.${r.duplicateRows ? ` ${r.duplicateRows.toLocaleString()} rows were already uploaded and were skipped.` : ''}
        ${r.skipped.length ? `<br><span class="small">${r.skipped.length} row(s) couldn't be read, for example line ${r.skipped[0].line}: ${esc(r.skipped[0].reason)}.</span>` : ''}
        <br><span class="small">Columns used: ${Object.entries(r.columns).filter(([, v]) => v).map(([k, v]) => `${k} = “${esc(v)}”`).join(', ')}</span>
        <br><a href="#overview">See who's overdue →</a></div>`;
      renderImports().catch(() => {});
    } catch (err) { out.innerHTML = `<div class="result err">${esc(err.message)}</div>`; }
  }
  $('csvFile').addEventListener('change', (e) => { uploadFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('on'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('on'); }));
  drop.addEventListener('drop', (e) => uploadFile(e.dataTransfer.files[0]));

  async function renderImports() {
    const [{ imports }, { square }] = await Promise.all([api('GET', '/api/imports'), api('GET', '/api/integrations')]);
    const hint = $('squareHint');
    hint.hidden = !square.available;
    hint.innerHTML = square.connected
      ? `<span>Square is connected${square.lastSyncedAt ? `, last synced ${when(square.lastSyncedAt)}` : ''}. New sales come in every hour, so you don't need to upload.</span><a class="btn btn-ghost btn-sm" href="#settings">Square settings</a>`
      : `<span><b>Use Square?</b> Connect it once and your sales come in automatically every hour.</span><a class="btn btn-primary btn-sm" href="/integrations/square/connect">Connect Square</a>`;
    $('imports').innerHTML = imports.length
      ? `<div class="tbl"><table><thead><tr><th>File</th><th>Uploaded</th><th class="n">New purchases</th><th class="n">New customers</th><th class="n">Unreadable rows</th></tr></thead><tbody>${imports.map((i) => `<tr><td>${esc(i.filename)}</td><td>${when(i.created_at)}</td><td class="n">${i.visits_added}</td><td class="n">${i.customers_created}</td><td class="n">${i.rows_skipped}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="muted">No uploads yet.</p>`;
  }

  // ---------- messages
  async function renderMessages() {
    const { messages } = await api('GET', '/api/messages');
    $('msgList').innerHTML = messages.length ? messages.map((m) => `
      <div class="msg ${m.direction}">
        <div class="meta"><b>${esc(m.customer_name || m.to_address)}</b>${m.direction === 'in' ? 'Reply' : `${m.channel === 'sms' ? 'Text' : 'Email'} ${m.step != null ? `· message ${m.step + 1}` : ''}`}<br>${when(m.created_at)}${m.status === 'failed' ? `<br><span class="error">Failed</span>` : ''}</div>
        <div class="body">${m.subject ? `<b>${esc(m.subject)}</b>\n` : ''}${esc(m.body)}${m.error ? `\n<span class="error small">${esc(m.error)}</span>` : ''}</div>
      </div>`).join('') : `<p class="muted">No messages yet. Start a win-back from the Customers tab, or turn on autopilot in Settings.</p>`;
  }

  // ---------- settings
  function hourLabel(h) { return h === 0 || h === 24 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h}am` : `${h - 12}pm`; }
  async function renderSettings() {
    S.me = await api('GET', '/api/me'); renderBanner();
    const b = S.me.business;
    $('s-autopilot').checked = b.autopilot;
    $('s-discount').value = b.discount_pct;
    $('s-mult').value = String(Number(b.overdue_multiplier));
    $('s-booking').value = b.booking_url || '';
    $('s-reply').value = b.reply_to_email || '';
    $('s-name').value = b.name;
    $('s-address').value = b.postal_address || '';
    $('s-industry').innerHTML = Object.entries(S.me.industries).map(([k, v]) => `<option value="${k}" ${k === b.industry ? 'selected' : ''}>${esc(v)}</option>`).join('');
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone').filter((z) => /^(America|Pacific|Europe|Australia)\//.test(z)); } catch { zones = []; }
    if (!zones.includes(b.timezone)) zones.unshift(b.timezone);
    $('s-tz').innerHTML = zones.map((z) => `<option ${z === b.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('');
    $('s-start').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === b.send_window_start ? 'selected' : ''}>${hourLabel(h)}</option>`).join('');
    $('s-end').innerHTML = Array.from({ length: 24 }, (_, i) => i + 1).map((h) => `<option value="${h}" ${h === b.send_window_end ? 'selected' : ''}>${hourLabel(h)}</option>`).join('');
    renderBilling();
    renderSquare().catch((e) => toast(e.message));
  }

  async function renderSquare(data) {
    const { square: q } = data || (await api('GET', '/api/integrations'));
    const card = $('squareCard');
    if (!q.available) { card.hidden = true; return; }
    card.hidden = false;
    const head = `<div class="sq-row"><div class="row-gap"><span class="sq-logo" aria-hidden="true"><i></i></span><div><h2>Square</h2><p class="muted small">Brings in sales from your Square account every hour. Read-only: we never change anything in Square.</p></div></div>`;
    if (!q.connected) {
      card.innerHTML = `${head}<a class="btn btn-primary" href="/integrations/square/connect">Connect Square</a></div>
        <p class="muted small">You'll sign in to Square and approve access to your customers and payments. We import the last 12 months of sales. Only payments with a customer attached at checkout can be matched to a person.</p>`;
      return;
    }
    const problem = q.status === 'needs_reauth' || q.status === 'error';
    card.innerHTML = `${head}<span class="pill ${problem ? 'p-overdue' : 'p-won'}">${q.status === 'needs_reauth' ? 'Needs reconnecting' : q.status === 'error' ? 'Sync problem' : 'Connected'}</span></div>
      ${q.lastError ? `<p class="error small">${esc(q.lastError)}</p>` : ''}
      <dl class="dl">
        ${q.accountName ? `<dt>Account</dt><dd>${esc(q.accountName)}</dd>` : ''}
        <dt>Last synced</dt><dd>${q.lastSyncedAt ? when(q.lastSyncedAt) : 'In progress…'}</dd>
        ${q.syncedThrough ? `<dt>Sales through</dt><dd>${when(q.syncedThrough)}</dd>` : ''}
      </dl>
      <div class="row-gap">
        ${q.status === 'needs_reauth' ? `<a class="btn btn-primary btn-sm" href="/integrations/square/connect">Reconnect Square</a>` : `<button class="btn btn-ghost btn-sm" type="button" data-sq="sync">Sync now</button>`}
        <button class="btn btn-ghost btn-sm" type="button" data-sq="disconnect">Disconnect</button>
        <span class="muted small" id="sqMsg" aria-live="polite"></span>
      </div>`;
  }

  let sqConfirm = false;
  $('squareCard').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sq]'); if (!b) return;
    const msg = $('sqMsg');
    try {
      if (b.dataset.sq === 'sync') {
        b.disabled = true; msg.textContent = 'Syncing…';
        const r = await api('POST', '/api/integrations/square/sync');
        const x = r.result;
        toast(`Square synced: ${x.visitsAdded} new sale${x.visitsAdded === 1 ? '' : 's'}${x.customersCreated ? `, ${x.customersCreated} new customers` : ''}${x.wins ? `, ${x.wins} came back` : ''}.`);
        await renderSquare({ square: { available: true, ...r.square } });
      } else if (b.dataset.sq === 'disconnect') {
        if (!sqConfirm) { sqConfirm = true; b.textContent = 'Click again to disconnect'; setTimeout(() => { sqConfirm = false; if (b.isConnected) b.textContent = 'Disconnect'; }, 4000); return; }
        sqConfirm = false;
        await api('POST', '/api/integrations/square/disconnect');
        toast('Square disconnected. Your customers and sales history stay here.');
        await renderSquare();
      }
    } catch (err) { msg.textContent = err.message; b.disabled = false; await renderSquare().catch(() => {}); }
  });

  // After connecting, refresh the card until the first import finishes.
  function pollSquare(tries = 0) {
    setTimeout(async () => {
      try {
        const data = await api('GET', '/api/integrations');
        if (!$('tab-settings').hidden) await renderSquare(data);
        if (!data.square.lastSyncedAt && tries < 40) pollSquare(tries + 1);
        else if (data.square.lastSyncedAt) toast('Your Square sales are in. Check the Customers tab.');
      } catch { /* ignore */ }
    }, 3000);
  }
  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('settingsMsg'); msg.textContent = 'Saving…';
    try {
      await api('PATCH', '/api/business', {
        autopilot: $('s-autopilot').checked, discount_pct: Number($('s-discount').value), overdue_multiplier: Number($('s-mult').value),
        booking_url: $('s-booking').value.trim(), reply_to_email: $('s-reply').value.trim(), name: $('s-name').value.trim(),
        industry: $('s-industry').value, timezone: $('s-tz').value, send_window_start: Number($('s-start').value), send_window_end: Number($('s-end').value),
        postal_address: $('s-address').value.trim() || null,
      });
      S.me = await api('GET', '/api/me');
      msg.textContent = 'Saved.';
    } catch (err) { msg.textContent = err.message; }
  });

  function renderBilling() {
    const { business: b, plans, capabilities: cap } = S.me;
    const status = { trialing: 'Free trial', active: 'Active', past_due: 'Payment failed', canceled: 'Canceled' }[b.plan_status];
    $('billingCard').innerHTML = `
      <h2>Plan</h2>
      <p>${esc(plans[b.plan]?.label || b.plan)} · <b>${status}</b>${b.plan_status === 'trialing' ? ` until ${new Date(b.trial_ends_at).toLocaleDateString()}` : ''}</p>
      ${!cap.sms ? `<p class="muted small">Texting is ${plans[b.plan]?.sms ? 'not connected on this server yet' : 'not included in your plan'}, so win-backs go out by email.</p>` : ''}
      <div class="plans">${['starter', 'growth', 'multi'].map((k) => `
        <div class="plan ${b.plan === k && b.plan_status === 'active' ? 'cur' : ''}">
          <span class="muted">${plans[k].label}</span><b>$${plans[k].priceUsd}<span class="muted small">/mo</span></b>
          <span class="small">Up to ${plans[k].maxCustomers.toLocaleString()} customers · ${plans[k].sms ? 'texts and email' : 'email only'}</span>
          ${b.plan === k && b.plan_status === 'active' ? `<span class="pill p-won">Current plan</span>` : `<button class="btn btn-primary btn-sm" type="button" data-plan="${k}" ${cap.billing ? '' : 'disabled'}>Choose ${plans[k].label}</button>`}
        </div>`).join('')}</div>
      ${b.has_billing ? `<button class="btn btn-ghost btn-sm" type="button" id="portalBtn">Manage billing and invoices</button>` : ''}
      ${cap.billing ? '' : `<p class="muted small">Online billing isn't connected on this server yet.</p>`}`;
  }
  $('billingCard').addEventListener('click', async (e) => {
    const plan = e.target.closest('[data-plan]')?.dataset.plan;
    try {
      if (plan) { const { url } = await api('POST', '/api/billing/checkout', { plan }); location.href = url; }
      if (e.target.id === 'portalBtn') { const { url } = await api('POST', '/api/billing/portal'); location.href = url; }
    } catch (err) { toast(err.message); }
  });

  boot();
})();
