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
  const TABS = ['overview', 'import', 'messages', 'settings', 'audit', 'admin'];
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
    if (tab === 'admin' && !S.me.isAdmin) { location.hash = '#overview'; return; }
    ({ overview: renderOverview, import: renderImports, messages: renderMessages, settings: renderSettings, audit: renderAudit, admin: renderAdmin })[tab]().catch((e) => toast(e.message));
  }
  window.addEventListener('hashchange', route);

  async function boot() {
    try { S.me = await api('GET', '/api/me'); } catch { S.me = null; }
    if (S.me) { renderBanner(); $('adminTab').hidden = !S.me.isAdmin; }
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
    if (c.display === 'in_progress' && c.sequence) t = c.sequence.kind === 'second_visit' ? `Second-visit offer · ${c.sequence.steps_sent} of 2 sent` : `Message ${c.sequence.steps_sent} of 3 sent`;
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
    renderSetup().catch(() => {});
    S.customers = list;
    $('bizSub').textContent = d.customers ? `${d.customers.toLocaleString()} customers tracked` : 'No customers yet';
    $('tiles').innerHTML = `
      <div class="tile"><span>Due now</span><b>${d.due}</b><small>Right on their usual gap</small></div>
      <div class="tile bad"><span>Overdue or lapsed</span><b>${d.overdue + d.lapsed}</b><small>${d.customers ? Math.round(((d.overdue + d.lapsed) / d.customers) * 100) : 0}% of your list</small></div>
      <div class="tile bad"><span>Revenue slipping</span><b>${money(d.slippingMonthlyCents)}<small>/mo</small></b><small>From overdue customers</small></div>
      <div class="tile"><span>Win-backs running</span><b>${d.inProgress}</b><small>${d.last30.messagesSent} messages sent in 30 days</small></div>
      <div class="tile good"><span>Recovered (30 days)</span><b>${money(d.last30.recoveredCents)}</b><small>${d.last30.wins} came back · ${money(d.allTime.recoveredCents)} all time</small></div>`;
    $('emptyState').hidden = d.customers > 0 || !S.setupHidden;
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
      const summary = r.format === 'customer_summary';
      out.innerHTML = `<div class="result"><b>Done.</b> ${summary
          ? `Read ${r.rowsTotal.toLocaleString()} customers from a client list and estimated their visit rhythm from first visit, last visit and visit count.`
          : `${r.visitsAdded.toLocaleString()} new purchases.`} ${r.customersCreated.toLocaleString()} new customers, ${r.customersUpdated.toLocaleString()} existing customers updated.${r.duplicateRows ? ` ${r.duplicateRows.toLocaleString()} rows were already uploaded and were skipped.` : ''}${r.excludedByStatus ? ` ${r.excludedByStatus.toLocaleString()} cancelled, no-show or refunded rows were left out.` : ''}
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

  $('adminBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sms]'); if (!b) return;
    const cell = b.parentElement;
    cell.innerHTML = `<form class="stack" data-smsform="${b.dataset.sms}" style="gap:6px"><input class="field-input" name="n" value="${esc(b.dataset.current)}" placeholder="+1 800 555 0123" aria-label="Texting number" style="font:14px var(--body);padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);min-width:150px"><div class="row-gap"><button class="btn btn-primary btn-sm" type="submit">Save</button><span class="muted small"></span></div></form>`;
    cell.querySelector('input').focus();
  });
  $('adminBody').addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-smsform]'); if (!f) return;
    e.preventDefault();
    try { await api('PATCH', `/api/admin/businesses/${f.dataset.smsform}`, { sms_from: f.n.value.trim() || null }); toast('Texting number saved.'); renderAdmin(); }
    catch (err) { f.querySelector('.muted').textContent = err.message; }
  });

  // ---------- guided setup
  const hourName = (h) => h === 0 || h === 24 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h}am` : `${h - 12}pm`;
  async function renderSetup() {
    const st = await api('GET', '/api/setup');
    S.setupHidden = st.dismissed || (st.complete && !S.forceSetup);
    const card = $('setupCard');
    if (S.setupHidden) { card.innerHTML = ''; $('emptyState').hidden = st.customers > 0; return; }
    $('emptyState').hidden = true;
    const b = S.me.business, p = st.autopilotPreview;
    const icon = (done) => `<span class="sicon ${done ? 'done' : ''}" aria-hidden="true">${done ? '✓' : ''}</span>`;
    const people = (n) => `${n} customer${n === 1 ? '' : 's'}`;
    const how = (x) => [x.sms ? `${x.sms} by text` : '', x.email ? `${x.email} by email` : ''].filter(Boolean).join(', ');
    const firstOpen = ['data', 'details', 'messages', 'autopilot'].find((k) => !st.steps[k]);
    const step = (key, title, doneText, body) => `
      <details class="sstep ${st.steps[key] ? 'is-done' : ''}" ${key === firstOpen ? 'open' : ''}>
        <summary>${icon(st.steps[key])}<span><b>${title}</b>${st.steps[key] ? `<span class="muted small"> · ${doneText}</span>` : ''}</span></summary>
        <div class="sbody">${body}</div>
      </details>`;
    card.innerHTML = `
      <section class="card setup" aria-labelledby="setupTitle">
        <div class="row-gap" style="justify-content:space-between">
          <div><h2 id="setupTitle">Get set up</h2><p class="muted small">${st.done} of ${st.total} done. Most owners finish in about 10 minutes.</p></div>
          <button class="btn btn-ghost btn-sm" type="button" id="setupHide">${st.complete ? 'Done' : 'Hide this'}</button>
        </div>
        <div class="sbar"><span style="width:${(st.done / st.total) * 100}%"></span></div>
        ${step('data', 'Bring in your sales history', `${st.customers.toLocaleString()} customers`, `
          <p>We need your past visits to learn how often each customer usually comes in.</p>
          <div class="row-gap">${S.me.capabilities.square ? (st.squareConnected ? '<span class="pill p-won">Square connected</span>' : '<a class="btn btn-primary btn-sm" href="/integrations/square/connect">Connect Square</a>') : ''}
          <a class="btn ${S.me.capabilities.square ? 'btn-ghost' : 'btn-primary'} btn-sm" href="#import">Upload a file</a></div>`)}
        ${step('details', 'Add your business details', 'saved', `
          <p>Your mailing address goes at the bottom of every email (the law requires it). A booking link lets customers book in one tap.</p>
          <div class="grid2">
            <label class="field">Mailing address<input id="su-address" value="${esc(b.postal_address || '')}" placeholder="12 Main St, Dallas, TX 75230"></label>
            <label class="field">Booking link (optional)<input id="su-booking" type="url" value="${esc(b.booking_url || '')}" placeholder="https://"></label>
          </div>
          <div class="row-gap"><button class="btn btn-primary btn-sm" type="button" id="suSaveDetails">Save details</button><span class="muted small" id="suDetailsMsg" aria-live="polite"></span></div>`)}
        ${step('messages', 'Review your messages', 'looks good', `
          <p>Here's what an overdue customer named Dana would get. Discount: ${b.discount_pct}%.</p>
          <div id="suPreviews" class="stack"><p class="muted small">Loading…</p></div>
          <div class="row-gap"><button class="btn btn-primary btn-sm" type="button" id="suLooksGood">Looks good</button><a class="btn btn-ghost btn-sm" href="#settings">Change wording or discount</a></div>`)}
        ${step('autopilot', 'Turn on autopilot', 'on', !st.steps.data ? '<p class="muted">Bring in your sales first, so we can show you who would be contacted.</p>' : `
          <p>If you turn it on now:</p>
          <ul>
            <li><b>${people(p.winback.count)}</b> who are overdue would get a friendly check-in${p.winback.count ? ` (${how(p.winback)})` : ''}.</li>
            ${b.second_visit_enabled ? (p.secondVisit.count ? `<li><b>${people(p.secondVisit.count)}</b> who visited once would get a thank-you offer (${how(p.secondVisit)}).</li>` : '<li>No first-time customers are due a thank-you offer yet. They’ll get one automatically when they are.</li>') : ''}
            <li>Messages only go out between ${hourName(p.sendWindow.start)} and ${hourName(p.sendWindow.end)} (${esc(p.sendWindow.timezone.replace('_', ' '))}), at most one a week per person, and stop when they come back.</li>
          </ul>
          ${!st.steps.details ? '<p class="error small">Add your mailing address first. Emails can’t go out without it.</p>' : ''}
          <div class="row-gap"><button class="btn btn-primary btn-sm" type="button" id="suAutopilot" ${!st.steps.details ? 'disabled' : ''}>Turn on autopilot</button><span class="muted small">You can turn it off any time in Settings.</span></div>`)}
      </section>`;
    if (!st.steps.messages) loadSetupPreviews();
  }
  async function loadSetupPreviews() {
    const box = $('suPreviews'); if (!box) return;
    const t = S.me.templates, custom = S.me.business.message_templates || {};
    try {
      const items = await Promise.all(t.steps.winback.map((st, i) => api('POST', '/api/templates/preview', { kind: 'winback', step: i, text: (custom.winback && custom.winback[i]) || t.defaults.winback[i] })
        .then((r) => `<div class="step"><h3><span>${esc(st.name)}</span><span class="muted small">Day ${st.day}</span></h3>${esc(r.body)}</div>`)));
      box.innerHTML = items.join('');
    } catch (err) { box.innerHTML = `<p class="error small">${esc(err.message)}</p>`; }
  }
  $('setupCard').addEventListener('click', async (e) => {
    const id = e.target.id; if (!['setupHide', 'suSaveDetails', 'suLooksGood', 'suAutopilot'].includes(id)) return;
    try {
      if (id === 'setupHide') { S.forceSetup = false; await api('PATCH', '/api/business', { setup_dismissed: true }); toast('Hidden. You can bring the checklist back any time from Settings.'); }
      if (id === 'suSaveDetails') {
        await api('PATCH', '/api/business', { postal_address: $('su-address').value.trim() || null, booking_url: $('su-booking').value.trim() });
        toast('Details saved.');
      }
      if (id === 'suLooksGood') { await api('POST', '/api/setup/messages-reviewed'); toast('Great. Those are the messages customers will get.'); }
      if (id === 'suAutopilot') { e.target.disabled = true; await api('PATCH', '/api/business', { autopilot: true }); toast('Autopilot is on. First messages go out within the hour, inside your sending hours.'); }
      S.me = await api('GET', '/api/me');
      await renderOverview();
    } catch (err) {
      if (id === 'suSaveDetails') $('suDetailsMsg').textContent = err.message; else toast(err.message);
      if (id === 'suAutopilot') e.target.disabled = false;
    }
  });

  $('showSetup').addEventListener('click', async () => {
    try { await api('PATCH', '/api/business', { setup_dismissed: false }); S.me = await api('GET', '/api/me'); S.forceSetup = true; location.hash = '#overview'; }
    catch (err) { toast(err.message); }
  });

  // ---------- "where's my export?" help
  const ASK_SUPPORT = (sys) => `<p>We couldn't confirm ${sys}'s menus, and they change between versions. The quickest route is to ask ${sys} support for:</p>
    <blockquote>"A CSV export of our appointment (or invoice) history for the last 12 months, with the client's name, phone, email, the date, the amount, and the appointment status."</blockquote>
    <p>A client list works too if it has <b>last visit</b>, <b>first visit</b> and <b>number of visits</b> columns. We'll estimate each client's rhythm from those.</p>`;
  const EXPORT_HELP = {
    square: `<p><b>Best: connect Square</b> (above). Your sales come in automatically every hour and you never upload again.</p>
      <p>Or upload a file:</p><ol>
        <li>In your Square Dashboard, open <b>Transactions</b>, choose the last 12 months, and click <b>Export → Transactions CSV</b>.</li>
        <li>Upload it here. Customer names only appear on sales where a customer was attached at checkout.</li></ol>
      <p class="muted small">Square's customer list export (Customers → Import/Export → Export customers) also works: it has first visit, last visit and visit counts, which we use to estimate each customer's rhythm.</p>`,
    jobber: `<ol><li>In Jobber, go to <b>Insights → Reports</b> and open the <b>Invoice report</b> (under Financial reports).</li>
      <li>Set the date range to the last 12 months and click <b>Export to CSV</b>. Jobber emails you the file.</li>
      <li>Upload it here. We read the client name, issued date and total, and skip drafts and voided invoices.</li></ol>
      <p class="muted small">Jobber's client export (Clients → More actions → Export clients) has contact details but no visit dates, so use the invoice report.</p>`,
    daysmart: `<ol><li>In DaySmart Pet, open the <b>Reports</b> tab and run the <b>Appointment Report</b> for the last 12 months.</li>
      <li>It exports to Excel. Open it and choose <b>File → Save As → CSV</b> (or in Google Sheets, <b>File → Download → CSV</b>).</li>
      <li>Upload the CSV here. Cancelled and no-show appointments are skipped automatically.</li></ol>
      <p class="muted small">Very large reports can time out. If that happens, run a few months at a time and upload each file; we skip anything already uploaded.</p>`,
    moego: `<ol><li>In MoeGo, open <b>Reports</b> and export an appointment or sales report for the last 12 months.</li>
      <li>Choose <b>CSV</b> (or Excel, then save it as CSV). Avoid PDF.</li>
      <li>Upload it here. Cancelled and no-show appointments are skipped automatically.</li></ol>
      <p class="muted small">Can't find it? Ask MoeGo support for "appointment history as CSV with client name, phone, email, date, total and status."</p>`,
    gingr: ASK_SUPPORT('Gingr'),
    urable: ASK_SUPPORT('Urable'),
    other: `<p>Any spreadsheet works if it has <b>one row per visit or purchase</b> with:</p>
      <ul><li><b>Customer:</b> name (or first and last name), plus phone and/or email if you have them</li><li><b>Date</b> of the visit</li><li><b>Amount</b> (optional, but needed to show money recovered)</li>
      <li>Optional: a <b>status</b> column (cancelled and no-show rows are skipped) and a <b>text OK</b> column for customers who agreed to texts</li></ul>
      <p>Or a client list with <b>last visit</b>, <b>first visit</b> and <b>number of visits</b>. Excel files need to be saved as CSV first.</p>`,
  };
  $('exportSystem').addEventListener('change', (e) => { $('exportSteps').innerHTML = EXPORT_HELP[e.target.value] || ''; });

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
    $('s-second').checked = b.second_visit_enabled;
    $('s-second-pct').value = b.second_visit_discount_pct;
    $('s-industry').innerHTML = Object.entries(S.me.industries).map(([k, v]) => `<option value="${k}" ${k === b.industry ? 'selected' : ''}>${esc(v)}</option>`).join('');
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone').filter((z) => /^(America|Pacific|Europe|Australia)\//.test(z)); } catch { zones = []; }
    if (!zones.includes(b.timezone)) zones.unshift(b.timezone);
    $('s-tz').innerHTML = zones.map((z) => `<option ${z === b.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('');
    $('s-start').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === b.send_window_start ? 'selected' : ''}>${hourLabel(h)}</option>`).join('');
    $('s-end').innerHTML = Array.from({ length: 24 }, (_, i) => i + 1).map((h) => `<option value="${h}" ${h === b.send_window_end ? 'selected' : ''}>${hourLabel(h)}</option>`).join('');
    renderBilling();
    renderWording();
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
        second_visit_enabled: $('s-second').checked, second_visit_discount_pct: Number($('s-second-pct').value),
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


  // ---------- message wording
  const KIND_LABEL = { winback: 'Win-back (overdue customers)', second_visit: 'Second-visit offer (first-time customers)' };
  let previewTimer;
  function renderWording() {
    const { business: b, templates: t } = S.me;
    const custom = b.message_templates || {};
    $('wordingCard').innerHTML = `
      <h2>Message wording</h2>
      <p class="muted">Write the messages in your own voice. Use these words in curly brackets and we'll fill them in for each customer: ${Object.entries(t.placeholders).map(([k, v]) => `<code title="${esc(v)}">{${k}}</code>`).join(' ')}. We always add “Reply STOP to opt out” to texts and an unsubscribe link to emails.</p>
      ${Object.entries(t.steps).map(([kind, steps]) => `
        <h3>${KIND_LABEL[kind]}</h3>
        ${steps.map((st, i) => `
          <div class="wstep" data-kind="${kind}" data-step="${i}">
            <div class="row-gap" style="justify-content:space-between"><b>${i + 1}. ${esc(st.name)}</b><span class="muted small">Day ${st.day}${custom[kind] && custom[kind][i] ? ' · your wording' : ' · default'}</span></div>
            <textarea class="wtext" id="w-${kind}-${i}" rows="3" maxlength="480" aria-label="${esc(st.name)} message">${esc((custom[kind] && custom[kind][i]) || t.defaults[kind][i])}</textarea>
            <div class="wprev muted small" aria-live="polite"></div>
            <button class="btn btn-ghost btn-sm" type="button" data-reset>Use default wording</button>
          </div>`).join('')}`).join('')}
      <div class="row-gap"><button class="btn btn-primary" type="button" id="wSave">Save wording</button><span class="muted" id="wMsg" aria-live="polite"></span></div>`;
    document.querySelectorAll('.wstep').forEach(preview);
  }
  async function preview(box) {
    const ta = box.querySelector('.wtext');
    try {
      const r = await api('POST', '/api/templates/preview', { kind: box.dataset.kind, step: Number(box.dataset.step), text: ta.value });
      box.querySelector('.wprev').innerHTML = (r.problems.length ? `<span class="error">${esc(r.problems[0])}</span><br>` : '') + `Preview: ${esc(r.body)}`;
    } catch (err) { box.querySelector('.wprev').textContent = err.message; }
  }
  $('wordingCard').addEventListener('input', (e) => {
    const box = e.target.closest('.wstep'); if (!box) return;
    clearTimeout(previewTimer); previewTimer = setTimeout(() => preview(box), 400);
  });
  $('wordingCard').addEventListener('click', async (e) => {
    const reset = e.target.closest('[data-reset]');
    if (reset) { const box = reset.closest('.wstep'); box.querySelector('.wtext').value = S.me.templates.defaults[box.dataset.kind][Number(box.dataset.step)]; return preview(box); }
    if (e.target.id !== 'wSave') return;
    const out = {};
    document.querySelectorAll('.wstep').forEach((box) => {
      const k = box.dataset.kind, i = Number(box.dataset.step), v = box.querySelector('.wtext').value.trim();
      (out[k] = out[k] || [])[i] = v === S.me.templates.defaults[k][i] ? null : v; // unchanged = keep using the default
    });
    $('wMsg').textContent = 'Saving…';
    try { await api('PATCH', '/api/business', { message_templates: out }); S.me = await api('GET', '/api/me'); renderWording(); $('wMsg').textContent = 'Saved. New messages will use this wording.'; }
    catch (err) { $('wMsg').textContent = err.message; }
  });

  // ---------- audit
  async function renderAudit() {
    const sel = $('a-industry');
    if (!sel.options.length) sel.innerHTML = Object.entries(S.me.industries).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  }
  $('a-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const errEl = $('auditError'); errEl.hidden = true;
    if (!$('a-name').value.trim()) { errEl.textContent = 'Add the business name first, so it appears on the report.'; errEl.hidden = false; return; }
    $('a-fileName').textContent = `Reading ${file.name}…`;
    try {
      const r = await api('POST', '/api/audit', { csv: await file.text(), industry: $('a-industry').value, businessName: $('a-name').value.trim() });
      $('a-fileName').textContent = `Report made from ${file.name}.`;
      renderAuditReport(r);
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; $('a-fileName').textContent = ''; }
  });
  function renderAuditReport(r) {
    const total = r.customers || 1;
    const pct = (n) => Math.round((n / total) * 100);
    const bar = [['ok', 'On schedule', 'var(--ok)'], ['due', 'Due now', 'var(--due)'], ['overdue', 'Overdue', 'var(--over)'], ['lapsed', 'Lapsed', 'var(--lapsed)']];
    const ft = r.firstTimers;
    $('auditReport').innerHTML = `
      <article class="report card">
        <div class="row-gap" style="justify-content:space-between;align-items:flex-start">
          <div><span class="eyebrow">Lost-customer audit</span><h2 class="rtitle">${esc(r.businessName)}</h2>
            <p class="muted small">${esc(r.industryLabel)} · ${r.customers.toLocaleString()} customers and ${r.visits.toLocaleString()} purchases from ${r.firstVisit ? pretty(r.firstVisit) : '—'} to ${r.lastVisit ? pretty(r.lastVisit) : '—'} · Prepared ${new Date(r.generatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} by One More Time</p></div>
          <button class="btn btn-ghost btn-sm no-print" type="button" onclick="window.print()">Print or save as PDF</button>
        </div>
        <div class="rbig">
          <div><b>${(r.byStatus.overdue + r.byStatus.lapsed).toLocaleString()}</b><span>customers are overdue for their usual visit (${pct(r.byStatus.overdue + r.byStatus.lapsed)}% of your list)</span></div>
          <div><b>${money(r.slippingMonthlyCents)}</b><span>a month in visits those customers used to make</span></div>
          <div><b>${money(r.slippingYearlyCents)}</b><span>a year if they don't come back</span></div>
        </div>
        <div class="rbar" role="img" aria-label="Customers by status">${bar.map(([k, l, c]) => r.byStatus[k] ? `<span style="width:${(r.byStatus[k] / total) * 100}%;background:${c}" title="${l}: ${r.byStatus[k]}"></span>` : '').join('')}</div>
        <div class="rlegend">${bar.map(([k, l, c]) => `<span><i style="background:${c}"></i>${l}: <b>${r.byStatus[k]}</b></span>`).join('')}</div>
        <div class="rcols">
          <div><h3>What winning some back is worth</h3><p>If 1 in 10 overdue customers comes back: <b>${money(r.recover10MonthlyCents)} a month</b>.<br>If 1 in 5 comes back: <b>${money(r.recover20MonthlyCents)} a month</b>.</p><p class="muted small">Average purchase ${money(r.avgVisitCents)}${r.medianGapDays ? ` · Regulars usually come back every ${r.medianGapDays >= 14 ? Math.round(r.medianGapDays / 7) + ' weeks' : r.medianGapDays + ' days'}` : ''}</p></div>
          <div><h3>First-time customers</h3>${ft.rate == null ? '<p class="muted">Not enough history to tell yet.</p>' : `<p><b>${Math.round(ft.rate * 100)}%</b> of first-time customers came back for a second visit (${ft.cameBack} of ${ft.total}).</p><p class="muted small">A thank-you offer a few weeks after the first visit is one of the easiest ways to raise this.</p>`}</div>
          <div><h3>How we'd reach them</h3><p>${r.reachable.phone} have a phone number, ${r.reachable.email} more have an email${r.reachable.none ? `, and ${r.reachable.none} have no contact details` : ''}.</p><p class="muted small">Texts only go to customers who agreed to receive them.</p></div>
        </div>
        ${r.topOverdue.length ? `<h3>Overdue customers worth the most</h3>
        <div class="tbl"><table><thead><tr><th>Customer</th><th>Last visit</th><th class="n">Usually every</th><th class="n">Days overdue</th><th class="n">Avg spend</th></tr></thead><tbody>
          ${r.topOverdue.map((o) => `<tr><td>${esc(o.name)}</td><td>${pretty(o.lastVisit)}</td><td class="n">${o.usualGapDays >= 14 ? Math.round(o.usualGapDays / 7) + ' wks' : o.usualGapDays + ' days'}</td><td class="n">${o.daysOverdue}</td><td class="n">${money(o.avgCents)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
        <div class="rnext"><h3>What One More Time would do</h3><p>Each overdue customer gets a friendly check-in, then a personal discount, then a last call, stopping the moment they book. You approve the wording, and every Monday you see exactly who came back and what they spent.</p></div>
        ${r.skippedRows ? `<p class="muted small">${r.skippedRows} rows couldn't be read and were left out.</p>` : ''}
      </article>`;
    $('auditReport').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- admin
  async function renderAdmin() {
    const o = await api('GET', '/api/admin/overview');
    const t = o.totals;
    $('adminBody').innerHTML = `
      <div class="tiles" style="grid-template-columns:repeat(4,1fr)">
        <div class="tile"><span>Waitlist sign-ups</span><b>${t.waitlist}</b></div>
        <div class="tile"><span>Businesses</span><b>${t.businesses}</b></div>
        <div class="tile"><span>Paying</span><b>${t.paying}</b></div>
        <div class="tile good"><span>Monthly revenue</span><b>$${t.mrr.toLocaleString()}</b></div>
      </div>
      <h2 class="sub">Waitlist</h2>
      <div class="card">${o.waitlist.length ? `<div class="tbl"><table><thead><tr><th>Business</th><th>Name</th><th>Email</th><th>Phone</th><th>Type</th><th>Message</th><th>Signed up</th></tr></thead><tbody>
        ${o.waitlist.map((w) => `<tr><td>${esc(w.business_name)}</td><td>${esc(w.name)}</td><td>${esc(w.email)}</td><td>${esc(w.phone || '')}</td><td>${esc(w.business_type)}</td><td>${esc(w.message)}</td><td>${when(w.created_at)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No sign-ups yet. They appear here when someone fills in the form on the website.</p>'}</div>
      <h2 class="sub">Businesses</h2>
      <div class="card">${o.businesses.length ? `<div class="tbl"><table><thead><tr><th>Business</th><th>Owner</th><th>Plan</th><th class="n">Customers</th><th class="n">Messages (30d)</th><th class="n">Won back (30d)</th><th>Square</th><th>Texting number</th><th>Joined</th></tr></thead><tbody>
        ${o.businesses.map((b) => `<tr><td>${esc(b.name)}<br><span class="muted small">${esc(S.me.industries[b.industry] || b.industry)}${b.autopilot ? ' · autopilot' : ''}</span></td><td>${esc(b.owner_email)}</td><td>${esc(b.plan)} · ${esc(b.plan_status)}</td><td class="n">${b.customers}</td><td class="n">${b.messages_30d}</td><td class="n">${b.wins_30d} · ${money(b.recovered_30d)}</td><td>${esc(b.square || '—')}</td><td><span class="muted small">${esc(b.sms_from || 'none')}</span><br><button class="btn btn-ghost btn-sm" type="button" data-sms="${b.id}" data-current="${esc(b.sms_from || '')}">Set number</button></td><td>${when(b.created_at)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No businesses yet.</p>'}</div>`;
  }

  boot();
})();
