// ─────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────
let currentUser       = null;   // { uid, username, name, role }
let campaigns         = {};     // { id: { name, assignedUids, createdAt } }  — ACTIVE campaigns only
let archivedCampaigns = {};     // { id: { ... } } — archived campaigns, loaded separately so they don't
                                 // bloat the day-to-day admin queries/renders (dashboard, filters, etc.)
let members           = {};     // { uid: { username, name, role } }
let userChecklist     = {};     // { campaignId: { entries, d5, d1, lastActive } }
let selectedCampaignId = null;
let calendarEntries   = [];     // shared admin calendar entries
let personalCalendarEntries = []; // personal entries for current user

const db = firebase.firestore();

// Snapshot of the application's true default checklist (defined in
// checklist-data.js, loaded before this script) — captured BEFORE any
// per-campaign or global override can mutate the live CHECKLIST_SECTIONS
// array. Needed so loadChecklistOverrides() can correctly reset back to
// the default when a campaign uses no override of its own (otherwise a
// previously-loaded custom template would incorrectly "stick").
const DEFAULT_CHECKLIST_SECTIONS = JSON.parse(JSON.stringify(CHECKLIST_SECTIONS));

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';
const ADMIN_UID      = 'admin';

// ─────────────────────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────────────────────
async function handleLogin() {
  const username = document.getElementById('login-username').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.style.display = 'none';

  if (!username || !password) { showError(errEl, 'Please enter your username and password.'); return; }

  const btn = document.getElementById('login-btn');
  btn.textContent = 'Signing in…'; btn.disabled = true;

  try {
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      currentUser = { uid: ADMIN_UID, username: ADMIN_USERNAME, name: 'Admin', role: 'admin' };
      sessionStorage.setItem('mcSession', JSON.stringify(currentUser));
      await loadAdminData();
      showScreen('admin-screen');
      return;
    }

    const snap = await db.collection('users').where('username', '==', username).limit(1).get();
    if (snap.empty) { showError(errEl, 'Username not found.'); return; }

    const doc  = snap.docs[0];
    const data = doc.data();
    if (data.password !== password) { showError(errEl, 'Incorrect password.'); return; }

    currentUser = { uid: doc.id, username: data.username, name: data.name, role: data.role || 'member', managedUids: data.managedUids || [] };
    sessionStorage.setItem('mcSession', JSON.stringify(currentUser));

    if (currentUser.role === 'manager') {
      await loadManagerData();
      showScreen('admin-screen');
    } else if (currentUser.role === 'team_lead') {
      await loadTeamLeadData();
      document.getElementById('tl-name-display').textContent = currentUser.name || currentUser.username;
      showScreen('teamlead-screen');
    } else {
      await loadMemberData(doc.id);
      document.getElementById('user-name-display').textContent = data.name || data.username;
      showScreen('user-screen');
    }

  } catch (e) {
    showError(errEl, 'Sign in failed. Please try again.'); console.error(e);
  } finally {
    btn.textContent = 'Sign in'; btn.disabled = false;
  }
}

function handleLogout() {
  currentUser = null;
  sessionStorage.removeItem('mcSession');
  showScreen('login-screen');
}

window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
  document.getElementById('login-username').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });

  const saved = sessionStorage.getItem('mcSession');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      if (currentUser.role === 'admin') {
        await loadAdminData(); showScreen('admin-screen');
      } else if (currentUser.role === 'manager') {
        await loadManagerData(); showScreen('admin-screen');
      } else if (currentUser.role === 'team_lead') {
        await loadTeamLeadData();
        document.getElementById('tl-name-display').textContent = currentUser.name || currentUser.username;
        showScreen('teamlead-screen');
      } else {
        await loadMemberData(currentUser.uid);
        document.getElementById('user-name-display').textContent = currentUser.name || currentUser.username;
        showScreen('user-screen');
      }
    } catch (e) { sessionStorage.removeItem('mcSession'); showScreen('login-screen'); }
  } else { showScreen('login-screen'); }
});

// ─────────────────────────────────────────────────────────────
//  DATA LOADING
// ─────────────────────────────────────────────────────────────
async function loadAdminData() {
  const usersSnap = await db.collection('users').get();
  members = {};
  usersSnap.forEach(doc => { members[doc.id] = { ...doc.data(), uid: doc.id }; });

  const campsSnap = await db.collection('campaigns').orderBy('createdAt', 'desc').get();
  campaigns = {};
  archivedCampaigns = {};
  campsSnap.forEach(doc => {
    const camp = { ...doc.data(), id: doc.id };
    if (camp.archived) archivedCampaigns[doc.id] = camp;
    else campaigns[doc.id] = camp;
  });

  applyRoleUI();
  populateAdminCampaignFilter();
  renderAdminView(true);
  await loadChecklistOverrides();
  await loadCalendarEntries();
  await loadCampaignRoster();
  await loadMasterlist();
  await checkBroadcastBadge();
  // Refresh data tab if it's currently showing
  const dataTab = document.getElementById('admin-tab-data');
  if (dataTab && dataTab.style.display !== 'none') renderDataTab();
  // Refresh registration tab if it's currently showing
  const regTab = document.getElementById('admin-tab-registration');
  if (regTab && regTab.style.display !== 'none') loadAndRenderRegPollAdmin();
  // Refresh members tab if it's currently showing
  refreshMembersTabIfOpen();
}

// ─────────────────────────────────────────────────────────────
//  MANAGER — reuses the admin-screen UI, scoped to the manager's own
//  team leads + the members inside those team leads' groups. Campaigns
//  stay unscoped (managers see all campaigns, same as admin); only the
//  shared `members` map is filtered. Almost every admin-screen render
//  function (dashboard, reports, data tab, members tab, kit/RSP progress
//  panels) reads from that shared `members` object, so filtering it here
//  scopes the whole screen without touching each render function.
// ─────────────────────────────────────────────────────────────
function computeManagerScopedUids(managerUser, sourceMembers) {
  const uids = new Set();
  (managerUser.managedUids || []).forEach(tlUid => {
    uids.add(tlUid);
    const tl = sourceMembers[tlUid];
    if (tl) (tl.managedUids || []).forEach(mUid => uids.add(mUid));
  });
  return uids;
}

async function loadManagerData() {
  const usersSnap = await db.collection('users').get();
  const allMembers = {};
  usersSnap.forEach(doc => { allMembers[doc.id] = { ...doc.data(), uid: doc.id }; });

  const scopedUids = computeManagerScopedUids(currentUser, allMembers);
  members = {};
  scopedUids.forEach(uid => { if (allMembers[uid]) members[uid] = allMembers[uid]; });

  // Campaigns: managers see ALL campaigns, same as admin.
  const campsSnap = await db.collection('campaigns').orderBy('createdAt', 'desc').get();
  campaigns = {};
  archivedCampaigns = {};
  campsSnap.forEach(doc => {
    const camp = { ...doc.data(), id: doc.id };
    if (camp.archived) archivedCampaigns[doc.id] = camp;
    else campaigns[doc.id] = camp;
  });

  applyRoleUI();
  populateAdminCampaignFilter();
  renderAdminView(true);
  await loadChecklistOverrides();
  await loadCalendarEntries();
  await loadCampaignRoster();
  await loadMasterlist();
  await checkBroadcastBadge();
  const dataTab = document.getElementById('admin-tab-data');
  if (dataTab && dataTab.style.display !== 'none') renderDataTab();
  const regTab = document.getElementById('admin-tab-registration');
  if (regTab && regTab.style.display !== 'none') loadAndRenderRegPollAdmin();
  refreshMembersTabIfOpen();
}

// Toggles the admin screen between full-admin and manager (scoped,
// org-structure-actions-hidden) presentation. Elements tagged
// class="admin-only" in the HTML are hidden in manager mode via the
// .manager-mode CSS rule in style.css.
function applyRoleUI() {
  const isManager = currentUser?.role === 'manager';
  const screen = document.getElementById('admin-screen');
  if (screen) screen.classList.toggle('manager-mode', isManager);
  const subEl  = document.getElementById('admin-sidebar-sub');
  const nameEl = document.getElementById('admin-sidebar-username');
  if (subEl)  subEl.textContent  = isManager ? 'Manager Dashboard' : 'Admin Dashboard';
  if (nameEl) nameEl.textContent = isManager ? (currentUser.name || currentUser.username) : 'Admin';
}

async function loadMemberData(uid) {
  const campsSnap = await db.collection('campaigns')
    .where('assignedUids', 'array-contains', uid)
    .orderBy('createdAt', 'desc')
    .get();
  campaigns = {};
  campsSnap.forEach(doc => {
    const camp = doc.data();
    if (camp.archived) return; // archived campaigns stay out of member-facing views
    campaigns[doc.id] = { ...camp, id: doc.id };
  });

  const checkSnap = await db.collection('checklists').doc(uid).get();
  userChecklist = checkSnap.exists ? checkSnap.data() : {};

  populateUserCampaignSelect();
  await loadChecklistOverrides();
  await loadCalendarEntries();
  await loadPersonalCalendarEntries(uid);
  await checkBroadcastBadge();
  await checkForPendingPoll();

  // Show team dashboard as the main view for members
  showUserTab('dashboard');
}

// ─────────────────────────────────────────────────────────────
//  ADMIN VIEW
// ─────────────────────────────────────────────────────────────
function populateAdminCampaignFilter() {
  const sel = document.getElementById('admin-campaign-filter');
  sel.innerHTML = '<option value="">All campaigns</option>';
  Object.values(campaigns).forEach(c => {
    sel.innerHTML += `<option value="${c.id}">${c.name}</option>`;
  });
  const label = document.getElementById('dashboard-campaign-label');
  if (label) {
    if (!sel.value) { label.textContent = 'All campaigns'; }
    else {
      const camp = campaigns[sel.value];
      const meta = campDateMetaHtml(camp);
      label.innerHTML = (camp?.name || 'All campaigns') + (meta ? ` &nbsp;·&nbsp; ${meta}` : '');
    }
  }
}

// ── Admin dashboard data cache ────────────────────────────────
// renderAdminView() used to re-fetch the ENTIRE checklists + taskChecks
// (+ each taskCheck's responses, one network round-trip at a time) every
// single time an admin clicked a campaign filter — that sequential refetch
// was the actual cause of the "delay before accurate details show up" bug.
// Now this data is fetched once into a shared cache; selecting a campaign
// just re-filters/re-aggregates the cache in memory (effectively instant).
// Pass force=true to actually refetch (used after sending/deleting a check,
// editing checklists, or clicking the explicit "Refresh" button).
let _dashCache = { checklists: null, taskChecks: null, taskCheckResponses: null };

async function loadAdminDashboardCache(force) {
  if (!force && _dashCache.checklists && _dashCache.taskChecks && _dashCache.taskCheckResponses) return;

  const [checkSnap, tcSnap] = await Promise.all([
    db.collection('checklists').get(),
    db.collection('taskChecks').get(),
  ]);

  const allChecklists = {};
  checkSnap.forEach(doc => { allChecklists[doc.id] = doc.data(); });

  const taskChecks = [];
  tcSnap.forEach(doc => taskChecks.push({ id: doc.id, ...doc.data() }));

  // Fetch every taskCheck's responses IN PARALLEL (was a sequential
  // for-loop before — the main culprit for the multi-second delay).
  const respPairs = await Promise.all(taskChecks.map(async tc => {
    const rs = await db.collection('taskCheckResponses').doc(tc.id).collection('responses').get();
    const responses = {};
    rs.forEach(d => { responses[d.id] = d.data(); });
    return [tc.id, responses];
  }));
  const taskCheckResponses = {};
  respPairs.forEach(([id, responses]) => { taskCheckResponses[id] = responses; });

  _dashCache = { checklists: allChecklists, taskChecks, taskCheckResponses };
}

async function renderAdminView(force) {
  await loadAdminDashboardCache(force);
  const filterCampaign = document.getElementById('admin-campaign-filter').value;
  const label = document.getElementById('dashboard-campaign-label');
  if (label) {
    if (!filterCampaign) { label.textContent = 'All campaigns'; }
    else {
      const camp = campaigns[filterCampaign];
      const meta = campDateMetaHtml(camp);
      label.innerHTML = (camp?.name || 'All campaigns') + (meta ? ` &nbsp;·&nbsp; ${meta}` : '');
    }
  }

  const allChecklists = _dashCache.checklists;

  let rows = [];
  let allRows = [];
  // Every campaign, regardless of the current filter — used by the
  // "Active Checklists" panel so all campaigns stay clickable even
  // while one is selected.
  const allCampaignList = Object.values(campaigns);

  // Campaigns can use a non-default checklist template (different item
  // count) — resolve each campaign's real total so completion isn't computed
  // against the wrong denominator (see resolveCampaignTotalItems).
  const totalItemsMap = await resolveCampaignTotalItems(allCampaignList);

  allCampaignList.forEach(camp => {
    (camp.assignedUids || []).forEach(uid => {
      const member = members[uid];
      if (!member) return;
      const cl = (allChecklists[uid] || {})[camp.id] || {};
      // One row PER ENTRY — each entry (e.g. "Lazada SG") has its own full
      // checklist, so its completion is computed individually against
      // this campaign's total item count rather than lumped together with
      // other entries (or computed against the wrong template's size).
      getEntryBreakdown(cl, totalItemsMap[camp.id]?.total, totalItemsMap[camp.id]?.validIds, totalItemsMap[camp.id]?.hasD5).forEach(eb => {
        // Per-row deadline, resolved against the calendar as precisely as the
        // entry allows: try this exact region+platform first (so MY-Shopee and
        // MY-Lazada get their OWN dates), then the region-wide fallback, then
        // any campaign-wide deadline, and finally an admin-set override captured
        // via the resolution modal. Whatever remains unresolved is flagged so
        // the admin can fill it in — no checklist is left with no due date.
        const entryRegion   = (eb.region || '').toUpperCase();
        const entryPlatform = _normalizePlatformCode(eb.platform);
        const rd = camp.regionDeadlines || {};
        const _ov = camp.deadlineOverrides || {};
        const comboKey = _deadlineKey(entryRegion, entryPlatform);
        // If this entry answered "Yes" to "Joining the After Party?", the
        // after-party END date the member entered supersedes every other
        // deadline source — it's the newest, most specific commitment for
        // this exact entry (see openAfterPartyModal / confirmAfterPartyDates).
        const afterPartyDeadline = (eb.entry && eb.entry.afterPartyEnd) || null;
        const rowDeadline =
          afterPartyDeadline                                // after-party override (highest priority)
          || (entryRegion && entryPlatform && rd[comboKey])   // exact region+platform
          || (entryRegion && rd[entryRegion])               // region-wide fallback
          || _ov[comboKey] || (entryRegion && _ov[entryRegion]) // admin override
          || camp.deadline                                  // campaign-wide
          || null;
        // Missing data: a row with a region but no resolvable deadline. Surfaced
        // to the admin resolution modal so it can be filled in.
        const needsDeadline = !!entryRegion && !rowDeadline;

        // Due-state: an incomplete entry is only an ISSUE once its own region's
        // deadline has passed. Before that it's "not due yet", never an issue.
        const nowTs  = Date.now();
        const dlTs   = rowDeadline ? new Date(rowDeadline).getTime() : null;
        const isDone = eb.overallPct === 100;
        let dueState;
        if (isDone)                    dueState = 'done';
        else if (dlTs && nowTs > dlTs) dueState = 'overdue';  // issue
        else                           dueState = 'not_due';  // within grace / no deadline

        allRows.push({
          member, camp,
          entryLabel: eb.label,
          entryRegion,
          entryPlatform,
          comboKey,
          needsDeadline,
          rowDeadline,
          isAfterPartyDeadline: !!afterPartyDeadline,
          dueState,
          isIssue: dueState === 'overdue',
          d5Done: eb.d5Done, d1Done: eb.d1Done, overallDone: eb.overallPct,
          d5Pct: eb.d5Pct, d1Pct: eb.d1Pct, totalItems: eb.totalItems, hasD5: eb.hasD5,
          lastActive: cl.lastActive || null,
        });
      });
    });
  });
  window._allAdminRows = allRows;

  // No checklist should be left without a due date. If any row couldn't resolve
  // a deadline from the calendar (region+platform), the region-wide fallback, or
  // the campaign-wide deadline, surface a centered modal so the admin fills it
  // in. Deferred so it never blocks the dashboard paint.
  setTimeout(() => maybePromptMissingDeadlines(allRows), 0);

  // The rest of the dashboard (stat cards, "Completion by team lead", and
  // the team progress table) only looks at rows for the selected campaign
  // (or every campaign, if none is selected).
  rows = filterCampaign ? allRows.filter(r => r.camp.id === filterCampaign) : allRows;

  // Apply sort
  const sortSel = document.getElementById('table-sort');
  const sortVal = sortSel ? sortSel.value : 'name';
  rows.sort((a, b) => {
    if (sortVal === 'name') return (a.member.name || a.member.username).localeCompare(b.member.name || b.member.username);
    if (sortVal === 'overall_desc') return b.overallDone - a.overallDone;
    if (sortVal === 'overall_asc')  return a.overallDone - b.overallDone;
    if (sortVal === 'lastactive') {
      const aT = a.lastActive ? new Date(a.lastActive).getTime() : 0;
      const bT = b.lastActive ? new Date(b.lastActive).getTime() : 0;
      return bT - aT;
    }
    return 0;
  });
  window._adminRows = rows;

  const total      = rows.length;
  const complete   = rows.filter(r => r.overallDone === 100).length;
  const inProgress = rows.filter(r => r.overallDone > 0 && r.overallDone < 100).length;
  const notStarted = rows.filter(r => r.overallDone === 0).length;
  const completePct  = total > 0 ? Math.round((complete / total) * 100) : 0;
  const inProgPct    = total > 0 ? Math.round((inProgress / total) * 100) : 0;
  const notStartPct  = total > 0 ? Math.round((notStarted / total) * 100) : 0;

  const overallCompletionRate = total > 0 ? Math.round((complete / total) * 100) : 0;

  // Load RSP & Kit completion rate for dashboard stat card.
  // Campaign-scoped checks are counted per (member × applicable entry);
  // checks with no campaign (legacy "All campaigns" checks) are still
  // counted per member, since entries only exist within a campaign.
  let rspTotal = 0, rspComplete = 0;
  try {
    for (const tc of _dashCache.taskChecks) {
      if (filterCampaign && tc.campaignId !== filterCampaign) continue;
      const responses = _dashCache.taskCheckResponses[tc.id] || {};

      const targetMembers = tc.targetUid
        ? [members[tc.targetUid]].filter(Boolean)
        : Object.values(members).filter(m => m.role !== 'admin');

      targetMembers.forEach(m => {
        const r = responses[m.uid];
        if (tc.campaignId) {
          const cl = (allChecklists[m.uid] || {})[tc.campaignId] || {};
          const entries = (cl.entries && cl.entries.length) ? cl.entries : [{ brand: '', platform: '', region: '' }];
          entries.forEach(entry => {
            if (!rspCheckAppliesToEntry(tc, entry)) return;
            rspTotal++;
            if (rspEntryOverallStatus(tc, r, rspEntryKey(entry)) === 'done') rspComplete++;
          });
        } else {
          rspTotal++;
          const allDone = tc.items.every(item => rspIsDoneLike(((r && r.items) || {})[item.id]));
          if (allDone) rspComplete++;
        }
      });
    }
  } catch(e) { /* non-blocking */ }
  const rspRate = rspTotal > 0 ? Math.round((rspComplete / rspTotal) * 100) : null;
  const rspColor = rspRate === null ? 'var(--text-muted)' : rspRate === 100 ? '#059669' : rspRate >= 50 ? '#D97706' : '#2563EB';
  const rspDisplay = rspRate === null ? '—' : rspRate + '%';

  document.getElementById('admin-stats').innerHTML = `
    <div class="stat-card"><div class="label">Total Checklists</div><div class="value blue">${total}</div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:100%;background:var(--blue);"></div></div></div>
    <div class="stat-card"><div class="label">Complete</div><div class="value green">${complete}</div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${completePct}%;background:#059669;"></div></div></div>
    <div class="stat-card"><div class="label">In Progress</div><div class="value amber">${inProgress}</div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${inProgPct}%;background:#D97706;"></div></div></div>
    <div class="stat-card"><div class="label">Not Started</div><div class="value red">${notStarted}</div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${notStartPct}%;background:#DC2626;"></div></div></div>
    <div class="stat-card"><div class="label">Completion Rate</div><div class="value" style="color:${overallCompletionRate===100?'#059669':overallCompletionRate>=50?'#D97706':'#2563EB'}">${overallCompletionRate}%</div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${overallCompletionRate}%;background:${overallCompletionRate===100?'#059669':overallCompletionRate>=50?'#D97706':'#2563EB'};"></div></div></div>
    <div class="stat-card"><div class="label">📦 RSP &amp; Kit Rate</div><div class="value" style="color:${rspColor}">${rspDisplay}</div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${rspRate||0}%;background:${rspColor};"></div></div></div>
  `;

  const tbody = document.getElementById('admin-tbody');
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:2rem;">No assignments yet. Create a campaign and assign members.</td></tr>`;
    renderDashboardWidgets(rows);
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const badge  = r.overallDone === 100 ? 'badge-done">Complete'
                 : r.overallDone === 0   ? 'badge-pending">Not started'
                 :                         'badge-partial">In progress';
    const lastStr = r.lastActive
      ? new Date(r.lastActive).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : '—';
    return `<tr>
      <td><strong>${r.member.name || r.member.username}</strong>${r.member.role === 'team_lead' ? ' <span style="font-size:10px;background:#eff6ff;color:#2563eb;border-radius:4px;padding:1px 6px;margin-left:2px;">Team Lead</span>' : ''}<br><span style="font-size:11px;color:var(--text-muted)">@${r.member.username}</span></td>
      <td>${r.camp.name}${r.entryRegion ? ` <span style="font-size:10px;font-weight:700;background:#EEF2FF;color:#4338CA;border-radius:4px;padding:1px 6px;margin-left:2px;">${escHtml(r.entryRegion)}</span>` : ''}${r.entryLabel ? ` <span style="font-size:11px;color:var(--text-muted);">· ${escHtml(r.entryLabel)}</span>` : ''}${r.rowDeadline ? `<br><span style="font-size:10px;color:${r.dueState === 'overdue' ? '#DC2626' : '#D97706'};font-weight:600;">⏰ ${fmtDeadlineShort(r.rowDeadline)}</span>` : ''}</td>
      <td>${r.hasD5 === false ? '<span style="color:var(--text-muted);font-size:11px;">N/A</span>' : `${miniBar(r.d5Pct)} ${r.d5Done}/${r.totalItems}`}</td>
      <td>${miniBar(r.d1Pct)} ${r.d1Done}/${r.totalItems}</td>
      <td><span class="badge ${badge}</span>${
        r.overallDone < 100 && r.dueState === 'overdue'
          ? '<br><span class="deadline-pill dp-red" style="margin-top:3px;display:inline-block;">⚠ Overdue</span>'
          : (r.overallDone < 100 && r.dueState === 'not_due' && r.rowDeadline)
            ? '<br><span class="deadline-pill ac-notdue" style="margin-top:3px;display:inline-block;" title="This region\u2019s deadline hasn\u2019t passed yet">Not due yet</span>'
            : ''
      }</td>
      <td style="font-size:12px;color:var(--text-muted)">${lastStr}</td>
      <td style="white-space:nowrap;">
        <button class="btn-link" onclick="openReviewModal('${r.member.uid}','${r.camp.id}')">Review</button>
        <button class="btn-link" style="color:#DC2626;margin-left:10px;" onclick="openDeleteClModal('${r.member.uid}','${r.camp.id}','${(r.member.name||r.member.username).replace(/'/g,"\\'")}')">Delete</button>
      </td>
    </tr>`;
  }).join('');

  renderDashboardWidgets(rows);
  filterProgressTable();
}

function filterProgressTable() {
  const q = (document.getElementById('table-search')?.value || '').toLowerCase();
  const rows = document.querySelectorAll('#admin-tbody tr');
  rows.forEach(tr => {
    const matchesSearch = !q || tr.textContent.toLowerCase().includes(q);
    let matchesStatus = true;
    if (_currentStatusFilter && _currentStatusFilter !== 'all') {
      const badgeEl = tr.querySelector('.badge');
      const txt = badgeEl ? badgeEl.textContent.trim().toLowerCase() : '';
      const isPending    = txt.includes('not started');
      const isInProgress = txt.includes('in progress');
      const isCompleted  = txt.includes('complete');
      if (_currentStatusFilter === 'pending'     && !isPending)    matchesStatus = false;
      if (_currentStatusFilter === 'in-progress' && !isInProgress) matchesStatus = false;
      if (_currentStatusFilter === 'completed'   && !isCompleted)  matchesStatus = false;
    }
    tr.classList.toggle('table-hidden', !(matchesSearch && matchesStatus));
  });
}


// ═════════════════════════════════════════════════════════════
//  D-DAY COUNTDOWN BANNER
// ═════════════════════════════════════════════════════════════
function renderDdayBanner() {
  const el = document.getElementById('dday-banner');
  if (!el) return;
  const now = new Date(); now.setHours(0,0,0,0);
  // Find the nearest upcoming dday event
  const ddays = calendarEntries
    .filter(e => e.type === 'dday' && e.date)
    .map(e => ({ ...e, dateObj: new Date(e.date) }))
    .filter(e => e.dateObj >= now)
    .sort((a,b) => a.dateObj - b.dateObj);

  if (ddays.length === 0) { el.style.display = 'none'; return; }

  const next = ddays[0];
  const nextDayOnly = new Date(next.dateObj); nextDayOnly.setHours(0,0,0,0);
  const diff = Math.round((nextDayOnly - now) / 86400000);
  let cls = 'dday-green', msg = '';
  if (diff === 0)      { cls = 'dday-red';   msg = '🔴 D-DAY IS TODAY'; }
  else if (diff === 1) { cls = 'dday-red';   msg = '🔴 D-DAY TOMORROW'; }
  else if (diff <= 5)  { cls = 'dday-amber'; msg = `⚠️ D-DAY IN ${diff} DAYS`; }
  else                 { cls = 'dday-green'; msg = `📅 D-DAY IN ${diff} DAYS`; }

  el.style.display = 'block';
  el.innerHTML = `
    <div class="dday-banner ${cls}">
      <div class="dday-banner-left">
        <span class="dday-banner-label">${msg}</span>
        <span class="dday-banner-name">${escHtml(next.title)}</span>
      </div>
      <span class="dday-banner-date">${next.dateObj.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'})}</span>
    </div>`;
}

// ═════════════════════════════════════════════════════════════
//  UPCOMING CAMPAIGN ALERT BANNER
//  "A campaign phase is coming up on the calendar and nobody has
//  created its checklist yet" — see getUpcomingCampaignAlerts().
// ═════════════════════════════════════════════════════════════
function renderCampaignAlertBanner() {
  const el = document.getElementById('campaign-alert-banner');
  if (!el) return;
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'manager';
  if (!isAdmin) { el.style.display = 'none'; return; }

  const alerts = getUpcomingCampaignAlerts();
  if (alerts.length === 0) { el.style.display = 'none'; el.innerHTML = ''; return; }

  el.style.display = 'block';
  el.innerHTML = alerts.map(a => {
    const info = _CANON_PHASE_INFO[a.phase] || { uiValue: '', label: 'Campaign' };
    let cls, msg;
    if (a.daysUntil <= 0)      { cls = 'camp-alert-red';   msg = '🔴 STARTS TODAY'; }
    else if (a.daysUntil === 1){ cls = 'camp-alert-red';   msg = '🔴 STARTS TOMORROW'; }
    else if (a.daysUntil <= 5) { cls = 'camp-alert-amber'; msg = `⚠️ IN ${a.daysUntil} DAYS`; }
    else                       { cls = 'camp-alert-green'; msg = `📅 IN ${a.daysUntil} DAYS`; }
    const monthLabel = `${_MONTH_LABELS[a.month]} ${a.year}`;
    const regionsStr = a.regions.length ? a.regions.join(', ') : 'no region tagged yet';
    return `<div class="camp-alert-row ${cls}">
      <div class="camp-alert-left">
        <span class="camp-alert-label">${msg}</span>
        <span class="camp-alert-name">${escHtml(info.label)} — ${escHtml(monthLabel)}</span>
        <span class="camp-alert-sub">No checklist created yet · ${escHtml(regionsStr)}</span>
      </div>
      <button class="btn-primary" style="width:auto;padding:7px 16px;font-size:12px;white-space:nowrap;" onclick="_startCampaignFromAlert('${info.uiValue}',${a.year},${a.month})">+ Create Checklist</button>
    </div>`;
  }).join('');
}

// Jump straight into New Campaign with the phase/month/year pre-picked, so
// the admin lands on the same Per-Region Deadlines preview this alert was
// computed from and can just confirm + assign members.
function _startCampaignFromAlert(phaseValue, year, month) {
  openNewCampaignModal();
  const nameEl = document.getElementById('new-campaign-name');
  if (nameEl) nameEl.value = `${_phaseLabel(phaseValue)} — ${_MONTH_LABELS[month]} ${year}`;
  const typeSel  = document.getElementById('new-campaign-cal-type');
  const monthSel = document.getElementById('new-campaign-cal-month');
  const yearSel  = document.getElementById('new-campaign-cal-year');
  if (typeSel)  typeSel.value  = phaseValue;
  if (monthSel) monthSel.value = String(month);
  if (yearSel)  yearSel.value  = String(year);
  refreshNewCampCalendarMap();
}

// ─────────────────────────────────────────────────────────────
//  DASHBOARD WIDGETS
// ─────────────────────────────────────────────────────────────
function renderDashboardWidgets(rows) {
  rows = rows || window._adminRows || [];
  renderCompletionChart(rows);
  renderDeadlinePanel();
  renderAlertsBanner(rows);
  renderDdayBanner();
  renderCampaignAlertBanner();
  renderTaskChecksInDashboard();
}

function renderCompletionChart(rows) {
  const el = document.getElementById('dash-completion-chart');
  if (!el) return;

  // Subtitle reflects the currently selected campaign (set via the sidebar
  // filter, or by clicking a campaign in the "Active Checklists" panel) so
  // it's clear these rates are scoped to one campaign rather than all of them.
  const subEl = document.getElementById('dash-completion-subtitle');
  if (subEl) {
    const filterCampId = document.getElementById('admin-campaign-filter')?.value || '';
    subEl.textContent = filterCampId ? `📁 ${campaigns[filterCampId]?.name || ''}` : '';
  }

  // Member-level aggregate: D-5 and D-1 are accumulated separately across
  // ALL of a member's entries/campaigns — never blended into one number.
  const memberMap = {};
  rows.forEach(r => {
    const uid  = r.member.uid;
    const name = r.member.name || r.member.username;
    if (!memberMap[uid]) memberMap[uid] = { name, uid, d5Done: 0, d5Total: 0, d1Done: 0, d1Total: 0 };
    memberMap[uid].d5Done  += r.d5Done;
    memberMap[uid].d5Total += (r.totalItems || TOTAL_ITEMS);
    memberMap[uid].d1Done  += r.d1Done;
    memberMap[uid].d1Total += (r.totalItems || TOTAL_ITEMS);
  });
  // Real-time, no-rounding-up completion: 100% ONLY when every item is
  // actually filled out, 0% only when none are. Anything partial floors so
  // a nearly-done group never falsely reads as complete (e.g. 199/200 → 99%,
  // not 100%), and a single filled item never rounds down to 0%.
  const exactPct = (done, total) => {
    if (total <= 0) return 0;
    if (done >= total) return 100;
    if (done <= 0) return 0;
    return Math.max(1, Math.min(99, Math.floor((done / total) * 100)));
  };
  Object.values(memberMap).forEach(m => {
    m.d5Pct  = exactPct(m.d5Done, m.d5Total);
    m.d1Pct  = exactPct(m.d1Done, m.d1Total);
    // Overall rate is based on D-1 inputs alone for every user.
    m.avgPct = m.d1Pct;
  });

  // Group members under their team lead (managedUids) — combined progress
  // is computed from the raw done/total sums of every managed member PLUS
  // the team lead's own checklist (a lead's rate reflects their whole team,
  // including themselves), not an average of percentages, so it stays
  // accurate regardless of how many items each member's campaign(s) have.
  const teamLeads = Object.values(members).filter(m => m.role === 'team_lead');
  const claimedUids = new Set();
  const leadGroups = teamLeads.map(tl => {
    const managedUids = tl.managedUids || [];
    const memberList = managedUids.map(uid => memberMap[uid]).filter(Boolean);
    memberList.forEach(m => claimedUids.add(m.uid));
    // Fold in the lead's own checklist progress, if they have any.
    const ownStats = memberMap[tl.uid];
    if (ownStats) claimedUids.add(tl.uid);
    const combinedList = ownStats ? [...memberList, ownStats] : memberList;
    const d5Done = combinedList.reduce((s, m) => s + m.d5Done, 0);
    const d5Total = combinedList.reduce((s, m) => s + m.d5Total, 0);
    const d1Done = combinedList.reduce((s, m) => s + m.d1Done, 0);
    const d1Total = combinedList.reduce((s, m) => s + m.d1Total, 0);
    const d5Pct = exactPct(d5Done, d5Total);
    const d1Pct = exactPct(d1Done, d1Total);
    return {
      name: tl.name || tl.username, uid: tl.uid,
      d5Pct, d1Pct, avgPct: d1Pct, // overall rate is D-1-based
      memberCount: memberList.length, hasOwnChecklist: !!ownStats,
      memberList: (ownStats ? [...memberList, { ...ownStats, isLead: true }] : memberList)
        .slice().sort((a, b) => b.avgPct - a.avgPct),
    };
  });

  // Members not under any team lead (and not a team lead with their own
  // checklist already counted above) are grouped as "Unassigned" so their
  // progress is still visible on the dashboard.
  const unassignedMembers = Object.values(memberMap).filter(m => !claimedUids.has(m.uid));
  if (unassignedMembers.length > 0) {
    const d5Done = unassignedMembers.reduce((s, m) => s + m.d5Done, 0);
    const d5Total = unassignedMembers.reduce((s, m) => s + m.d5Total, 0);
    const d1Done = unassignedMembers.reduce((s, m) => s + m.d1Done, 0);
    const d1Total = unassignedMembers.reduce((s, m) => s + m.d1Total, 0);
    const d5Pct = exactPct(d5Done, d5Total);
    const d1Pct = exactPct(d1Done, d1Total);
    leadGroups.push({
      name: 'Unassigned (no team lead)', uid: '_unassigned',
      d5Pct, d1Pct, avgPct: d1Pct,
      memberCount: unassignedMembers.length,
      memberList: unassignedMembers.slice().sort((a, b) => b.avgPct - a.avgPct),
    });
  }

  // Keep the main list clean: leads with no members assigned (for the
  // selected campaign scope) and no checklist of their own are pulled out
  // into a collapsed bucket rather than shown as empty rows. They stay
  // visible as a staffing signal without cluttering the progress view.
  // The "Unassigned" catch-all group is never bucketed.
  const emptyLeads = leadGroups.filter(g =>
    g.uid !== '_unassigned' && g.memberCount === 0 && !g.hasOwnChecklist
  );
  const emptyLeadUids = new Set(emptyLeads.map(g => g.uid));
  const activeGroups = leadGroups.filter(g => !emptyLeadUids.has(g.uid));

  activeGroups.sort((a, b) => b.avgPct - a.avgPct);

  const badge = document.getElementById('dash-completion-badge');
  if (badge) badge.textContent = `${activeGroups.length} team${activeGroups.length !== 1 ? 's' : ''}`;
  if (activeGroups.length === 0 && emptyLeads.length === 0) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No data yet.</div>'; return; }
  const barColor = pct => pct === 100 ? '#059669' : pct >= 50 ? '#D97706' : pct > 0 ? '#3B82F6' : '#D1D5DB';

  el.innerHTML = activeGroups.map((g, idx) => {
    const panelId = `lead-completion-panel-${idx}`;
    const memberRowsHtml = g.memberList.map(m => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);">
        <div style="flex:1.4;font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(m.name)}${m.isLead ? ' <span style="font-size:9px;color:var(--text-muted);font-weight:400;">(Team Lead)</span>' : ''}</div>
        <div style="font-size:10px;color:var(--text-muted);width:26px;">D-5</div>
        <div style="flex:1;background:#F3F4F6;border-radius:4px;height:6px;overflow:hidden;"><div style="width:${m.d5Pct}%;background:${barColor(m.d5Pct)};height:100%;border-radius:4px;"></div></div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--text-muted);width:32px;text-align:right;">${m.d5Pct}%</div>
        <div style="font-size:10px;color:var(--text-muted);width:26px;">D-1</div>
        <div style="flex:1;background:#F3F4F6;border-radius:4px;height:6px;overflow:hidden;"><div style="width:${m.d1Pct}%;background:${barColor(m.d1Pct)};height:100%;border-radius:4px;"></div></div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--text-muted);width:32px;text-align:right;">${m.d1Pct}%</div>
      </div>`).join('') || '<div style="font-size:12px;color:var(--text-muted);padding:6px 0;">No members.</div>';

    return `<div class="completion-member-block" style="margin-bottom:14px;border:1px solid var(--border);border-radius:10px;padding:10px 12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;cursor:pointer;" onclick="toggleLeadCompletionPanel('${panelId}', this)" title="Click to view individual members' checklist details">
        <div style="display:flex;align-items:center;gap:6px;min-width:0;">
          <span class="lead-completion-caret" data-panel="${panelId}" style="display:inline-block;font-size:10px;color:var(--text-muted);transition:transform .15s;">▶</span>
          <span class="completion-name" style="width:auto;font-weight:600;">${escHtml(g.name)}</span>
          <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;">(${g.memberCount} member${g.memberCount !== 1 ? 's' : ''}${g.hasOwnChecklist ? ' + lead' : ''})</span>
        </div>
      </div>
      <div class="completion-bar-row" style="margin-bottom:3px;">
        <div class="completion-name" style="width:32px;font-size:10px;color:var(--text-muted);">D-5</div>
        <div class="completion-track"><div class="completion-fill" style="width:${g.d5Pct}%;background:${barColor(g.d5Pct)};"></div></div>
        <div class="completion-pct">${g.d5Pct}%</div>
      </div>
      <div class="completion-bar-row">
        <div class="completion-name" style="width:32px;font-size:10px;color:var(--text-muted);">D-1</div>
        <div class="completion-track"><div class="completion-fill" style="width:${g.d1Pct}%;background:${barColor(g.d1Pct)};"></div></div>
        <div class="completion-pct">${g.d1Pct}%</div>
      </div>
      <div id="${panelId}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);">
        ${memberRowsHtml}
      </div>
    </div>`;
  }).join('');

  // Collapsed bucket for leads with no members assigned in this scope.
  if (emptyLeads.length > 0) {
    const bucketPanelId = 'lead-completion-empty-bucket';
    const namesHtml = emptyLeads
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(g => `<div style="font-size:12px;color:var(--text);padding:4px 0;border-bottom:1px solid var(--border);">${escHtml(g.name)}</div>`)
      .join('');
    el.innerHTML += `<div class="completion-member-block" style="margin-bottom:14px;border:1px dashed var(--border);border-radius:10px;padding:10px 12px;background:var(--bg-subtle,transparent);">
      <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;" onclick="toggleLeadCompletionPanel('${bucketPanelId}', this)" title="Team leads with no members assigned for this campaign">
        <div style="display:flex;align-items:center;gap:6px;min-width:0;">
          <span class="lead-completion-caret" data-panel="${bucketPanelId}" style="display:inline-block;font-size:10px;color:var(--text-muted);transition:transform .15s;">▶</span>
          <span class="completion-name" style="width:auto;font-weight:600;color:var(--text-muted);">${emptyLeads.length} lead${emptyLeads.length !== 1 ? 's' : ''} with no members assigned</span>
        </div>
      </div>
      <div id="${bucketPanelId}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);">
        ${namesHtml}
      </div>
    </div>`;
  }
}

function toggleLeadCompletionPanel(panelId, headerEl) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  const caret = headerEl.querySelector(`.lead-completion-caret[data-panel="${panelId}"]`);
  if (caret) caret.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
}

// (formerly toggleRspKitPanel — removed; the RSP & Kit list in Admin > Data
// is now a compact one-line-per-check list, no per-check expand/collapse.)

function renderDeadlinePanel() {
  // Renamed to renderActiveCampaignsPanel — kept for backward compat
  renderActiveCampaignsPanel();
}

// Which campaign rollups are expanded. Persists across re-renders so the
// panel doesn't snap shut every time the dashboard refreshes.
const calAcOpenGroups = {};
function toggleAcGroup(key) {
  calAcOpenGroups[key] = !calAcOpenGroups[key];
  renderActiveCampaignsPanel();
}

// ── Active Checklists Breakdown ──────────────────────────────────────────
// Campaigns are ROLLED UP by campaign type + month (e.g. "Mid-Month —
// Jul 2026"), with the per-region campaigns nested underneath. Each region
// keeps its OWN true D-Day and its own deadline (D-Day − 4h local) — we
// never flatten them to a single shared deadline, because a deadline that
// doesn't match a region's real go-live stops meaning anything.
//
// Instead the noise is handled in the VIEW:
//   • one rollup number per campaign (complete only when the LAST region is)
//   • regions sorted by urgency — whatever is closest to its own deadline
//     floats to the top, so the panel tells you what to chase today
//   • regions whose deadline is still far out are de-emphasised as
//     "not due yet" rather than shown as if they were late
// Always built from EVERY campaign (window._allAdminRows), regardless of
// the current dashboard filter, so every campaign stays clickable even
// while one of them is selected — see selectDashboardCampaign().
function renderActiveCampaignsPanel() {
  const el    = document.getElementById('dash-deadlines-list');
  const badge = document.getElementById('dash-camps-badge');
  if (!el) return;

  const rows = window._allAdminRows || window._adminRows || [];
  // Group rows by campaign
  const campMap = {};
  rows.forEach(r => {
    const id = r.camp.id;
    if (!campMap[id]) campMap[id] = {
      id, name: r.camp.name,
      dday: r.camp.dday || null,
      deadline: r.camp.deadline || null,
      campaignType: r.camp.campaignType || null,
      region: r.camp.region || null,
      total: 0, complete: 0, inProgress: 0, notStarted: 0,
    };
    campMap[id].total++;
    if (r.overallDone === 100)      campMap[id].complete++;
    else if (r.overallDone > 0)     campMap[id].inProgress++;
    else                            campMap[id].notStarted++;
  });

  const campList = Object.values(campMap);
  const activeCampId = document.getElementById('admin-campaign-filter')?.value || '';

  if (campList.length === 0) {
    if (badge) badge.textContent = '0 campaigns';
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No campaigns yet.</div>';
    return;
  }

  const nowTs   = Date.now();
  const nowDay  = new Date(); nowDay.setHours(0,0,0,0);
  const DAY_MS  = 86400000;
  // A region is "due soon" (worth chasing) once its own deadline is within
  // this window; beyond it, it's simply not due yet — not late.
  const DUE_SOON_DAYS = 2;

  // ── Roll campaigns up by campaign type + month of D-Day ─────────────────
  const _campKey = c => {
    const typeId = c.campaignType || 'other';
    const when   = c.dday || c.deadline;
    const d      = when ? new Date(when) : null;
    const period = d && !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth()).padStart(2,'0')}` : 'undated';
    return `${typeId}|${period}`;
  };
  const _campLabel = c => {
    const t = CAL_CAMPAIGN_TYPES.find(x => x.id === (c.campaignType || 'other')) || CAL_CAMPAIGN_TYPES[3];
    const when = c.dday || c.deadline;
    const d    = when ? new Date(when) : null;
    const per  = d && !isNaN(d) ? d.toLocaleDateString('en-GB',{month:'short',year:'numeric'}) : 'Undated';
    return { label: `${t.label} — ${per}`, color: t.color };
  };

  const groupMap = {};
  campList.forEach(c => {
    const k = _campKey(c);
    if (!groupMap[k]) {
      const meta = _campLabel(c);
      groupMap[k] = { key: k, label: meta.label, color: meta.color, camps: [],
                      total: 0, complete: 0, inProgress: 0, notStarted: 0 };
    }
    const g = groupMap[k];
    g.camps.push(c);
    g.total      += c.total;
    g.complete   += c.complete;
    g.inProgress += c.inProgress;
    g.notStarted += c.notStarted;
  });

  const groups = Object.values(groupMap);
  if (badge) badge.textContent = `${groups.length} campaign${groups.length !== 1 ? 's' : ''}`;

  // Urgency = ms until this region's own deadline (fallback D-Day). Regions
  // already complete sink to the bottom; undated regions sort last.
  const _urgency = c => {
    if (c.total > 0 && c.complete === c.total) return Number.MAX_SAFE_INTEGER - 1; // done
    const when = c.deadline || c.dday;
    const t = when ? new Date(when).getTime() : NaN;
    return isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  };

  groups.forEach(g => {
    g.camps.sort((a, b) => _urgency(a) - _urgency(b));
    // The group's own urgency is its most urgent unfinished region.
    g.urgency = g.camps.length ? _urgency(g.camps[0]) : Number.MAX_SAFE_INTEGER;
    // Rollup is complete only when the LAST region finishes.
    g.rate     = g.total > 0 ? Math.round((g.complete / g.total) * 100) : 0;
    g.allDone  = g.total > 0 && g.complete === g.total;
    // The campaign's overall D-Day window: earliest start → last to finish.
    const ddays = g.camps.map(c => c.dday).filter(Boolean).map(d => new Date(d)).filter(d => !isNaN(d));
    g.firstDday = ddays.length ? new Date(Math.min(...ddays)) : null;
    g.lastDday  = ddays.length ? new Date(Math.max(...ddays)) : null;
  });
  groups.sort((a, b) => a.urgency - b.urgency);

  // A group is auto-expanded if it contains the selected campaign, or if
  // anything inside it is due soon / overdue and still unfinished.
  const _dueState = c => {
    if (c.total > 0 && c.complete === c.total) return 'done';
    const when = c.deadline || c.dday;
    const t = when ? new Date(when).getTime() : NaN;
    if (isNaN(t)) return 'undated';
    if (t < nowTs) return 'overdue';
    if (t - nowTs <= DUE_SOON_DAYS * DAY_MS) return 'soon';
    return 'later';
  };

  let html = activeCampId
    ? `<div class="ac-clear-filter" onclick="selectDashboardCampaign('')">← Show all campaigns</div>`
    : '';

  html += groups.map((g, gi) => {
    const hasSelected = g.camps.some(c => c.id === activeCampId);
    const needsAction = g.camps.some(c => ['overdue','soon'].includes(_dueState(c)));
    const open        = calAcOpenGroups[g.key] !== undefined
      ? calAcOpenGroups[g.key]
      : (hasSelected || needsAction);
    calAcOpenGroups[g.key] = open;

    const rateColor = g.allDone ? '#059669' : g.rate >= 50 ? '#D97706' : '#2563EB';

    // Window pill: earliest region to start → last to finish.
    let windowTag = '';
    if (g.firstDday) {
      const fmt = d => d.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
      const span = (g.lastDday && g.lastDday.getTime() !== g.firstDday.getTime())
        ? `${fmt(g.firstDday)} → ${fmt(g.lastDday)}`
        : fmt(g.firstDday);
      const dOnly = new Date(g.firstDday); dOnly.setHours(0,0,0,0);
      const diff  = Math.round((dOnly - nowDay) / DAY_MS);
      let cls = 'dp-green';
      if (diff <= 0)     cls = 'dp-red';
      else if (diff <= 5) cls = 'dp-amber';
      windowTag = `<span class="deadline-pill ${cls}" style="margin-left:6px;" title="First region's D-Day → last region's D-Day">${span}</span>`;
    }
    const waitingNote = (!g.allDone && g.lastDday && g.complete > 0)
      ? `<div class="ac-group-note">Rolls up to 100% when the last region finishes.</div>`
      : '';

    const childRows = g.camps.map(c => {
      const state = _dueState(c);
      const rate  = c.total > 0 ? Math.round((c.complete / c.total) * 100) : 0;
      const rc    = rate === 100 ? '#059669' : rate >= 50 ? '#D97706' : '#2563EB';
      const isActive = c.id === activeCampId;

      let statePill = '';
      if (state === 'overdue')      statePill = `<span class="deadline-pill dp-red" style="margin-left:4px;">Overdue</span>`;
      else if (state === 'soon')    statePill = `<span class="deadline-pill dp-amber" style="margin-left:4px;">Due soon</span>`;
      else if (state === 'done')    statePill = `<span class="deadline-pill dp-green" style="margin-left:4px;">Done</span>`;
      else if (state === 'later')   statePill = `<span class="deadline-pill ac-notdue" style="margin-left:4px;" title="Deadline hasn't arrived yet — nothing to chase">Not due yet</span>`;

      let ddayTag = '';
      if (c.dday) {
        const dd = new Date(c.dday);
        if (!isNaN(dd)) ddayTag = `<span class="ac-meta">D-Day ${fmtDeadlineShort(c.dday)}</span>`;
      }
      let deadlineTag = '';
      if (c.deadline) {
        deadlineTag = `<span class="ac-meta" title="Checklist deadline (D-Day − 4h, local)">⏰ ${fmtDeadlineShort(c.deadline)}</span>`;
      }

      return `<div class="ac-camp-row ac-camp-child ac-state-${state}${isActive ? ' ac-camp-row-active' : ''}"
        onclick="selectDashboardCampaign('${c.id}')" title="Click to view this campaign only">
        <div class="ac-camp-top">
          <div class="ac-camp-name">${escHtml(c.name)}${statePill}${isActive ? ' <span style="font-size:10px;color:#2563EB;font-weight:700;">● selected</span>' : ''}</div>
          <div class="ac-camp-rate" style="color:${rc};font-family:var(--mono);font-size:13px;font-weight:700;">${rate}%</div>
        </div>
        <div class="ac-rate-bar"><div style="width:${rate}%;background:${rc};height:100%;border-radius:4px;transition:width .4s;"></div></div>
        <div class="ac-camp-meta-line">${ddayTag}${deadlineTag}</div>
        <div class="ac-camp-pills">
          <span class="ac-pill ac-green">✓ ${c.complete}</span>
          <span class="ac-pill ac-amber">⟳ ${c.inProgress}</span>
          <span class="ac-pill ac-red">— ${c.notStarted}</span>
          <span class="ac-pill ac-blue">${c.total} total</span>
        </div>
      </div>`;
    }).join('');

    const regionCount = g.camps.length;
    return `<div class="ac-group${g.allDone ? ' ac-group-done' : ''}">
      <div class="ac-group-head" onclick="toggleAcGroup('${g.key.replace(/'/g,"\\'")}')" title="Show / hide the regions in this campaign">
        <div class="ac-group-left">
          <span class="ac-group-caret" style="transform:rotate(${open ? 90 : 0}deg);">▶</span>
          <span class="ac-group-dot" style="background:${g.color};"></span>
          <span class="ac-group-name">${escHtml(g.label)}</span>
          ${windowTag}
          <span class="ac-group-count">${regionCount} region${regionCount !== 1 ? 's' : ''}</span>
        </div>
        <div class="ac-group-rate" style="color:${rateColor};">${g.rate}%</div>
      </div>
      <div class="ac-rate-bar ac-group-bar"><div style="width:${g.rate}%;background:${rateColor};height:100%;border-radius:4px;transition:width .4s;"></div></div>
      <div class="ac-camp-pills ac-group-pills">
        <span class="ac-pill ac-green">✓ ${g.complete}</span>
        <span class="ac-pill ac-amber">⟳ ${g.inProgress}</span>
        <span class="ac-pill ac-red">— ${g.notStarted}</span>
        <span class="ac-pill ac-blue">${g.total} total</span>
      </div>
      ${waitingNote}
      <div class="ac-group-body" style="display:${open ? 'block' : 'none'};">${childRows}</div>
    </div>`;
  }).join('');

  el.innerHTML = html;
}

// Clicking a campaign in the "Active Checklists" panel filters the WHOLE
// admin dashboard (stat cards, "Completion by team lead", and the team
// progress table) down to that single campaign — same effect as picking it
// from the sidebar campaign select, just one click away. Clicking the
// already-selected campaign again, or the "Show all campaigns" link,
// clears the filter.
function selectDashboardCampaign(campId) {
  const sel = document.getElementById('admin-campaign-filter');
  if (!sel) return;
  sel.value = (sel.value === campId) ? '' : campId;
  renderAdminView();
}

function renderAlertsBanner(rows) {
  // Keep alerts sidebar badge & nav button for extreme cases
  const notStarted = rows.filter(r => r.overallDone === 0);
  const alertsBtn  = document.getElementById('navbtn-alerts');
  const alertsDiv  = document.getElementById('nav-alerts-divider');
  const alertBadge = document.getElementById('nav-alert-badge');
  if (notStarted.length === 0) {
    if (alertsBtn)  alertsBtn.style.display  = 'none';
    if (alertsDiv)  alertsDiv.style.display  = 'none';
    return;
  }
  // Only show the alerts nav button if there are members not started
  if (alertsBtn)  { alertsBtn.style.display  = 'flex'; }
  if (alertsDiv)  { alertsDiv.style.display  = 'block'; }
  if (alertBadge) { alertBadge.textContent = notStarted.length; alertBadge.style.display = 'inline-block'; }
}

// ── Status filter for dashboard team progress table ──────────
let _currentStatusFilter = 'all';

function filterByStatus(btn, status) {
  _currentStatusFilter = status;
  document.querySelectorAll('.status-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const rows = document.querySelectorAll('#admin-tbody tr');
  rows.forEach(tr => {
    if (status === 'all') { tr.classList.remove('table-hidden'); return; }
    // Detect status from badge text inside the row
    const badgeEl = tr.querySelector('.badge');
    if (!badgeEl) { tr.classList.add('table-hidden'); return; }
    const txt = badgeEl.textContent.trim().toLowerCase();
    const isPending    = txt.includes('not started');
    const isInProgress = txt.includes('in progress');
    const isCompleted  = txt.includes('complete');
    if (status === 'pending'     && isPending)    tr.classList.remove('table-hidden');
    else if (status === 'in-progress' && isInProgress) tr.classList.remove('table-hidden');
    else if (status === 'completed'   && isCompleted)  tr.classList.remove('table-hidden');
    else tr.classList.add('table-hidden');
  });
}

async function quickNudge(memberName, uid) {
  openBroadcastModal();
  setTimeout(() => {
    document.getElementById('broadcast-message').value = `\u23F0 Friendly reminder: please complete your checklist before D-Day!`;
    if (uid) { const s = document.getElementById('broadcast-member-sel'); if (s) s.value = uid; }
    const nudgeBtn = document.querySelector('.btn-broadcast-type[data-type="nudge"]');
    if (nudgeBtn) selectBroadcastType(nudgeBtn);
  }, 120);
}

async function renderAlertsTab() {
  const el = document.getElementById('alerts-full-list');
  if (!el) return;
  const rows = window._adminRows || [];
  const notStarted = rows.filter(r => r.overallDone === 0);
  if (notStarted.length === 0) {
    el.innerHTML = `<div style="text-align:center;padding:4rem 2rem;"><div style="font-size:40px;margin-bottom:12px;">\uD83C\uDF89</div><div style="font-size:16px;font-weight:600;color:var(--navy);margin-bottom:8px;">All caught up!</div><div style="font-size:14px;color:var(--text-muted);">Every member has started their checklist.</div></div>`;
    return;
  }

  // Bulk nudge header
  const uniqueUids = [...new Set(notStarted.map(r => r.member.uid))];
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
      <div style="font-size:13px;color:var(--text-muted);">${notStarted.length} assignment${notStarted.length !== 1 ? 's' : ''} not started · ${uniqueUids.length} member${uniqueUids.length !== 1 ? 's' : ''}</div>
      <button class="btn-primary" style="width:auto;padding:8px 18px;background:#D97706;" onclick="bulkNudgeAll()">📣 Nudge All (${uniqueUids.length})</button>
    </div>` +
  notStarted.map(r => {
    const lastStr = r.lastActive ? 'Last active: ' + new Date(r.lastActive).toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : 'Never opened';
    return `<div class="alerts-member-row">
      <div class="alerts-member-info">
        <div class="alerts-member-name">${escHtml(r.member.name || r.member.username)}</div>
        <div class="alerts-member-sub">@${escHtml(r.member.username)} · ${escHtml(r.camp.name)}${r.entryLabel ? ' · ' + escHtml(r.entryLabel) : ''} · ${lastStr}</div>
      </div>
      <div class="alerts-member-actions">
        <button class="btn-link" onclick="openReviewModal('${r.member.uid}','${r.camp.id}')">View checklist</button>
        <button class="btn-ghost-light btn-sm" onclick="quickNudge('${escHtml(r.member.name||r.member.username).replace(/'/g,"\\'")}','${r.member.uid}')">\uD83D\uDCE3 Nudge</button>
      </div>
    </div>`;
  }).join('');
}

async function bulkNudgeAll() {
  const rows = window._adminRows || [];
  const notStarted = rows.filter(r => r.overallDone === 0);
  const uniqueUids = [...new Set(notStarted.map(r => r.member.uid))];
  if (uniqueUids.length === 0) return;
  if (!confirm(`Send a nudge broadcast to all ${uniqueUids.length} member(s) who haven't started?`)) return;
  try {
    await db.collection('broadcasts').add({
      type:       'nudge',
      message:    `⏰ Friendly reminder: please complete your checklist before D-Day!`,
      targetUid:  null,
      targetName: 'everyone (not started)',
      campaignId: null,
      campaignName: null,
      sentAt:     new Date().toISOString(),
      sentBy:     'Admin',
      readBy:     [],
    });
    showToast(`📣 Nudge sent to ${uniqueUids.length} member(s)!`, 'success');
  } catch(e) { showToast('Failed to send nudge.', 'warn'); console.error(e); }
}
function miniBar(pct) {
  const cls = pct === 100 ? '' : pct >= 50 ? ' warn' : ' danger';
  return `<div class="mini-bar"><div class="mini-track"><div class="mini-fill${cls}" style="width:${pct}%"></div></div><span class="mini-pct">${pct}%</span></div>`;
}

// `validIds`, when provided, restricts counting to item ids that actually
// exist in the campaign's CURRENT template. Without this, an edited-down
// template (items removed) leaves orphaned "done" flags in old Firestore
// data for items that no longer exist — those get double/over-counted and
// completion can exceed 100% even though every visible row is done.
function countDone(obj, validIds) {
  return Object.keys(obj || {}).filter(key => {
    if (validIds) {
      const m = key.match(/_e\d+$/);
      const baseId = m ? key.slice(0, m.index) : key;
      if (!validIds.has(baseId)) return false;
    }
    const v = obj[key];
    // 'yes'/'no' are the answered states of a "yesno"-type item (e.g.
    // "Joining the After Party?") — either answer counts as complete,
    // same as Done/N/A for a normal item.
    return v && (v.status === 'done' || v.status === 'na' || v.status === 'yes' || v.status === 'no');
  }).length;
}

// ─────────────────────────────────────────────────────────────
//  PER-ENTRY COMPLETION HELPERS
//  A checklist can have multiple "entries" (e.g. one per brand/platform/
//  region combo — "Lazada SG", "Shopee SG", etc). Each entry has its own
//  full set of D-5 / D-1 items, so completion must be computed PER ENTRY
//  against TOTAL_ITEMS — never by summing every entry's items together
//  over a single TOTAL_ITEMS denominator (that produces >100% rates).
// ─────────────────────────────────────────────────────────────
function checklistEntries(cl) {
  return (cl && cl.entries && cl.entries.length) ? cl.entries : [{}];
}

// Returns the set of item ids that actually exist in a sections array
// (CHECKLIST_SECTIONS or a saved template's sections).
function templateItemIds(sections) {
  const ids = new Set();
  (sections || []).forEach(sec => (sec.items || []).forEach(it => { if (it && it.id) ids.add(it.id); }));
  return ids;
}

// The valid item ids for whatever template is CURRENTLY loaded into
// CHECKLIST_SECTIONS (i.e. for the single checklist table on screen).
function getCurrentValidItemIds() {
  return templateItemIds(CHECKLIST_SECTIONS);
}

// Counts "done"/"na" items belonging to ONE entry index within a d5 or d1
// object. Entry 0 keys are bare item ids; entry N (N>0) keys are "itemId_eN".
// `validIds`, when provided, ignores keys for items no longer in the
// current template (see countDone above for why this matters).
function countDoneForEntryIdx(dataObj, entryIdx, validIds) {
  if (!dataObj) return 0;
  let n = 0;
  Object.keys(dataObj).forEach(key => {
    const m   = key.match(/_e(\d+)$/);
    const idx = m ? parseInt(m[1], 10) : 0;
    if (idx !== entryIdx) return;
    if (validIds) {
      const baseId = m ? key.slice(0, m.index) : key;
      if (!validIds.has(baseId)) return;
    }
    const v = dataObj[key];
    if (v && (v.status === 'done' || v.status === 'na' || v.status === 'yes' || v.status === 'no')) n++;
  });
  return n;
}

// Returns one breakdown row per entry of a single member+campaign checklist:
// { idx, label, d5Done, d1Done, d5Pct, d1Pct, overallPct, totalItems }.
// `label` is null when there's only the single default entry, so callers
// can skip showing it. `totalItems` defaults to getTotalItems() (the
// currently-loaded template's size) but callers iterating over MULTIPLE
// campaigns with potentially different templates should resolve and pass
// the correct per-campaign size explicitly (see resolveCampaignTotalItems) —
// otherwise a campaign using a non-default template (different item count)
// will show a wrong percentage even when every visible item is done.
// `validIds` should be passed alongside `totalItems` for the same reason —
// otherwise stale/orphaned item flags can push a count above 100%.
// `hasD5` — when false (a "No D-5" template), the D-5 stage doesn't exist
// for this checklist: d5Done/d5Pct are reported as 0. `overallPct` is
// ALWAYS based on D-1 inputs alone for every user — D-5 is informational
// only and never factors into anyone's overall completion percentage.
function getEntryBreakdown(cl, totalItems, validIds, hasD5) {
  const ti  = totalItems || getTotalItems();
  const ids = validIds || getCurrentValidItemIds();
  const d5Enabled = hasD5 !== false;
  cl = cl || {};
  const entries = checklistEntries(cl);
  return entries.map((entry, idx) => {
    const d5Done = d5Enabled ? countDoneForEntryIdx(cl.d5 || {}, idx, ids) : 0;
    const d1Done = countDoneForEntryIdx(cl.d1 || {}, idx, ids);
    const d5Pct  = d5Enabled && ti > 0 ? Math.round((d5Done / ti) * 100) : 0;
    const d1Pct  = ti > 0 ? Math.round((d1Done / ti) * 100) : 0;
    const overallPct = d1Pct;
    return {
      idx,
      label: entries.length > 1 ? buildEntryLabel(entry, idx) : null,
      region: entry.region || '',
      platform: entry.platform || '',
      // Raw entry object — carries afterPartyStart/afterPartyEnd when the
      // member answered "Yes" to "Joining the After Party?" for this entry,
      // so callers computing this entry's compliance deadline can honor it.
      entry,
      d5Done, d1Done, d5Pct, d1Pct, overallPct, totalItems: ti, hasD5: d5Enabled,
    };
  });
}

// Resolves the EFFECTIVE total-item count, valid item-id set, AND whether
// the D-5 stage applies for each campaign in campaignList, honoring
// per-campaign checklist templates (campaign.checklistTemplateId) and the
// global checklist override doc, WITHOUT mutating the shared
// CHECKLIST_SECTIONS / window._TOTAL_ITEMS_OVERRIDE state (those represent
// whichever single checklist table is currently open on screen — looping
// campaigns through them would corrupt that and also still only reflect
// the last campaign processed).
// Returns { [campaignId]: { total, validIds, hasD5 } }.
// Memoized — checklist templates / global checklist settings rarely change
// mid-session, but resolveCampaignTotalItems() used to be called on every
// dashboard render (and several other tabs), each time re-fetching both
// settings docs. Call invalidateChecklistSettingsCache() after editing
// templates or the global checklist so the next call picks up changes.
let _checklistSettingsCache = null;
function invalidateChecklistSettingsCache() { _checklistSettingsCache = null; }

async function resolveCampaignTotalItems(campaignList) {
  const map = {};
  let templates = [];
  let globalSections = null;
  let globalTotal = TOTAL_ITEMS;

  if (_checklistSettingsCache) {
    ({ templates, globalSections, globalTotal } = _checklistSettingsCache);
  } else {
    try {
      const tmplDoc = await db.collection('settings').doc('checklistTemplates').get();
      templates = tmplDoc.exists ? (tmplDoc.data().templates || []) : [];
    } catch (e) { /* fall back to default below */ }
    try {
      const glDoc = await db.collection('settings').doc('checklist').get();
      if (glDoc.exists && glDoc.data().sections) {
        globalSections = glDoc.data().sections;
        const sum = globalSections.reduce((s, sec) => s + ((sec.items || []).length), 0);
        if (sum > 0) globalTotal = sum;
      }
    } catch (e) { /* fall back to default below */ }
    _checklistSettingsCache = { templates, globalSections, globalTotal };
  }

  const globalValidIds = templateItemIds(globalSections || DEFAULT_CHECKLIST_SECTIONS);

  (campaignList || []).forEach(camp => {
    if (!camp) return;
    if (camp.checklistTemplateId) {
      const tmpl = templates.find(t => t.id === camp.checklistTemplateId);
      const sum = tmpl && tmpl.sections ? tmpl.sections.reduce((s, sec) => s + ((sec.items || []).length), 0) : 0;
      if (sum > 0) {
        map[camp.id] = { total: sum, validIds: templateItemIds(tmpl.sections), hasD5: tmpl.hasD5 !== false };
        return;
      }
    }
    map[camp.id] = { total: globalTotal, validIds: globalValidIds, hasD5: true };
  });
  return map;
}

// Resolves the actual SECTIONS array for ONE campaign (per-campaign template
// → global override → true default), WITHOUT touching the shared
// CHECKLIST_SECTIONS global. Used by contexts that render a checklist OUTSIDE
// the single "currently open checklist tab" flow (e.g. the admin/team-lead
// review modal) — mutating the shared global there would risk corrupting
// other admin UI that also reads it (like the Template Editor) after the
// modal closes.
async function resolveCampaignSections(camp) {
  try {
    if (camp?.checklistTemplateId) {
      const tmplDoc = await db.collection('settings').doc('checklistTemplates').get();
      if (tmplDoc.exists) {
        const templates = tmplDoc.data().templates || [];
        const tmpl = templates.find(t => t.id === camp.checklistTemplateId);
        if (tmpl && tmpl.sections && tmpl.sections.length > 0) return { sections: tmpl.sections, hasD5: tmpl.hasD5 !== false };
      }
    }
    const glDoc = await db.collection('settings').doc('checklist').get();
    if (glDoc.exists && glDoc.data().sections && glDoc.data().sections.length > 0) return { sections: glDoc.data().sections, hasD5: true };
  } catch (e) { /* fall back to default below */ }
  return { sections: DEFAULT_CHECKLIST_SECTIONS, hasD5: true };
}

// ─────────────────────────────────────────────────────────────
//  ADMIN REVIEW MODAL
// ─────────────────────────────────────────────────────────────
async function openReviewModal(uid, campId) {
  _reviewUid   = uid;
  _reviewCampId = campId;
  const member = members[uid];
  const camp   = campaigns[campId];
  document.getElementById('review-member-name').textContent    = member.name || member.username;
  document.getElementById('review-campaign-name').textContent  = camp.name;

  // Resolve whichever template this specific campaign actually uses (it
  // may differ from the default, or from whatever was last open elsewhere)
  // WITHOUT touching the shared CHECKLIST_SECTIONS global — otherwise the
  // modal could show the wrong section titles/items entirely (every status
  // looking blank because the item ids won't match what the member's real
  // data was saved under), and/or leave other admin UI (like the Template
  // Editor) reading a leftover template after the modal closes.
  const { sections, hasD5 } = await resolveCampaignSections(camp);

  const checkSnap = await db.collection('checklists').doc(uid).get();
  const cl = checkSnap.exists ? (checkSnap.data()[campId] || {}) : {};
  const d5Data = cl.d5 || {};
  const d1Data = cl.d1 || {};
  const entries = cl.entries || [{ brand: '', platform: '', region: '' }];

  let html = `<div class="review-table-wrap"><table class="review-table">`;
  const entryCount = entries.length;

  html += `<thead><tr>
    <th class="freeze" rowspan="2" style="min-width:220px">Item</th>
    <th class="freeze2" rowspan="2" style="min-width:220px">Guide question</th>`;
  entries.forEach((e, i) => {
    const label = buildEntryLabel(e, i);
    html += `<th colspan="${hasD5 ? 4 : 2}" style="text-align:center">${escHtml(label)}</th>`;
  });
  html += `</tr><tr>`;
  entries.forEach(() => {
    html += `${hasD5 ? `<th class="sub" colspan="2" style="text-align:center;">D-5<br><span style="font-size:10px;font-weight:400;opacity:0.7;">status &amp; notes</span></th>` : ''}<th class="sub" colspan="2" style="text-align:center;">D-1<br><span style="font-size:10px;font-weight:400;opacity:0.7;">status &amp; notes</span></th>`;
  });
  html += `</tr></thead><tbody>`;

  sections.forEach(sec => {
    const totalCols = 2 + entryCount * (hasD5 ? 4 : 2);
    html += `<tr class="rv-cat">
      <td class="freeze" colspan="1">${sec.title}</td>
      <td class="freeze2"></td>
      ${Array(entryCount * (hasD5 ? 4 : 2)).fill('<td></td>').join('')}
    </tr>`;

    sec.items.forEach(item => {
      html += `<tr>
        <td class="freeze" style="white-space:normal;line-height:1.4">${item.name}</td>
        <td class="freeze2" style="white-space:normal;line-height:1.4;color:var(--text-muted);font-size:12px">${item.guide}</td>`;

      entries.forEach((_, i) => {
        const key = i === 0 ? item.id : `${item.id}_e${i}`;
        const d5 = d5Data[key] || {};
        const d1 = d1Data[key] || {};
        const d5NoteFlag = d5.note ? `<span class="note-flag" title="${escHtml(d5.note)}">💬</span>` : '';
        const d1NoteFlag = d1.note ? `<span class="note-flag" title="${escHtml(d1.note)}">💬</span>` : '';
        html += `${hasD5 ? `<td>${statusBadge(d5.status)}</td>
                 <td style="color:var(--text-muted);font-size:12px;font-style:italic">${d5NoteFlag}${d5.note || ''}</td>` : ''}
                 <td>${statusBadge(d1.status)}</td>
                 <td style="color:var(--text-muted);font-size:12px;font-style:italic">${d1NoteFlag}${d1.note || ''}</td>`;
      });
      html += `</tr>`;
    });
  });

  html += `</tbody></table></div>`;

  // ── RSP & Kit Check details (read-only) — lets team leads (and admins)
  // see a member's Kit & RSP check status for this campaign without
  // leaving the review modal. Previously this detail wasn't visible to
  // leads anywhere outside the member's own Checklist tab.
  try {
    const tcSnap = await db.collection('taskChecks').where('campaignId', '==', campId).get();
    const relevantChecks = [];
    tcSnap.forEach(doc => {
      const tc = { id: doc.id, ...doc.data() };
      if (rspCheckAppliesToUser(tc, uid) && entries.some(e => rspCheckAppliesToEntry(tc, e))) relevantChecks.push(tc);
    });

    if (relevantChecks.length > 0) {
      const respDocs = await Promise.all(relevantChecks.map(tc =>
        db.collection('taskCheckResponses').doc(tc.id).collection('responses').doc(uid).get()));

      let rspHtml = `<div style="margin-top:20px;"><div class="section-label" style="margin-bottom:8px;">📦 RSP &amp; Kit Check</div>`;
      relevantChecks.forEach((tc, idx) => {
        const resp = respDocs[idx].exists ? respDocs[idx].data() : {};
        const applicableEntries = entries.map((e, i) => ({ e, i })).filter(({ e }) => rspCheckAppliesToEntry(tc, e));

        const entriesHtml = applicableEntries.map(({ e, i }) => {
          const key = rspEntryKey(e);
          const overall = rspEntryOverallStatus(tc, resp, key);
          const label = buildEntryLabel(e, i);
          const itemsHtml = tc.items.map(item => {
            const st = rspItemStatus(resp, key, item.id);
            return `<span class="rv-status ${RSP_STATUS_CLASS[st]}" style="font-size:10px;margin-right:6px;">${escHtml(item.label)}: ${RSP_STATUS_LABEL[st]}</span>`;
          }).join('');
          return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0;border-bottom:1px dashed var(--border);">
            <span style="font-size:12px;font-weight:600;min-width:140px;">${escHtml(label)}</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">${itemsHtml}</div>
          </div>`;
        }).join('');

        rspHtml += `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:10px;">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;">📦 ${escHtml(tc.title)}</div>
          ${entriesHtml}
        </div>`;
      });
      rspHtml += `</div>`;
      html += rspHtml;
    }
  } catch(e) { console.error('Review modal RSP load error', e); }

  document.getElementById('review-content').innerHTML = html;
  document.getElementById('review-overlay').style.display = 'flex';

  requestAnimationFrame(() => {
    const wrap = document.getElementById('review-content');
    const headRow1 = wrap.querySelector('.review-table thead tr:first-child');
    const subCells = wrap.querySelectorAll('.review-table th.sub');
    if (headRow1 && subCells.length) {
      const h = headRow1.getBoundingClientRect().height;
      subCells.forEach(th => { th.style.top = h + 'px'; });
    }
  });
}

function statusBadge(status) {
  if (!status) return `<span class="rv-blank">—</span>`;
  const map = {
    done:          ['rv-done',     'Done'],
    'in-progress': ['rv-progress', 'In Progress'],
    pending:       ['rv-pending',  'Pending'],
    na:            ['rv-na',       'N/A'],
  };
  const [cls, label] = map[status] || ['rv-blank', status];
  return `<span class="rv-status ${cls}">${label}</span>`;
}

function closeReviewModal(e) {
  if (e && e.target !== document.getElementById('review-overlay')) return;
  document.getElementById('review-overlay').style.display = 'none';
}

// Track what's currently open in the review modal for the delete button
let _reviewUid = null;
let _reviewCampId = null;

function openDeleteClFromReview() {
  if (!_reviewUid || !_reviewCampId) return;
  const member = members[_reviewUid];
  const camp   = campaigns[_reviewCampId];
  document.getElementById('review-overlay').style.display = 'none';
  openDeleteClModal(_reviewUid, _reviewCampId, member?.name || member?.username || _reviewUid);
}

// ── Delete checklist modal ──
function openDeleteClModal(uid, campId, memberName) {
  document.getElementById('delete-cl-msg').textContent =
    `This will permanently delete ${memberName}'s checklist progress for "${campaigns[campId]?.name || campId}". This cannot be undone.`;
  document.getElementById('delete-cl-error').style.display = 'none';
  document.getElementById('delete-cl-confirm-btn').onclick = () => confirmDeleteChecklist(uid, campId);
  document.getElementById('delete-cl-overlay').style.display = 'flex';
}

function closeDeleteClModal(e) {
  if (e && e.target !== document.getElementById('delete-cl-overlay')) return;
  document.getElementById('delete-cl-overlay').style.display = 'none';
}

async function confirmDeleteChecklist(uid, campId) {
  const errEl = document.getElementById('delete-cl-error');
  errEl.style.display = 'none';
  try {
    // Load the member's full checklist doc, remove only the campaign key, then save
    const snap = await db.collection('checklists').doc(uid).get();
    if (snap.exists) {
      const data = snap.data();
      delete data[campId];
      await db.collection('checklists').doc(uid).set(data);
    }
    document.getElementById('delete-cl-overlay').style.display = 'none';
    await renderAdminView(true);
  } catch(e) {
    showError(errEl, 'Failed to delete checklist. Try again.');
    console.error(e);
  }
}

// ── Admin: Delete ALL checklists globally ──
function openDeleteAllChecklistsModal() {
  document.getElementById('delete-all-cl-error').style.display = 'none';
  document.getElementById('delete-all-cl-password').value = '';
  document.getElementById('delete-all-cl-overlay').style.display = 'flex';
}

function closeDeleteAllChecklistsModal(e) {
  if (e && e.target !== document.getElementById('delete-all-cl-overlay')) return;
  document.getElementById('delete-all-cl-overlay').style.display = 'none';
}

async function confirmDeleteAllChecklists() {
  const errEl = document.getElementById('delete-all-cl-error');
  errEl.style.display = 'none';
  const pwd = document.getElementById('delete-all-cl-password').value;
  if (pwd !== ADMIN_PASSWORD) {
    showError(errEl, 'Incorrect admin password. Please try again.');
    return;
  }
  const btn = document.getElementById('delete-all-cl-confirm-btn');
  btn.textContent = 'Deleting…'; btn.disabled = true;
  try {
    const snap = await db.collection('checklists').get();
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    userChecklist = {};
    document.getElementById('delete-all-cl-overlay').style.display = 'none';
    await renderAdminView(true);
  } catch(e) {
    showError(errEl, 'Failed to delete all checklists. Try again.');
    console.error(e);
  } finally {
    btn.textContent = 'Delete ALL Checklists'; btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
//  MEMBER MANAGEMENT
// ─────────────────────────────────────────────────────────────
function openMemberModal() {
  document.getElementById('new-member-username').value = '';
  document.getElementById('new-member-name').value     = '';
  document.getElementById('new-member-password').value = '';
  document.getElementById('member-modal-error').style.display = 'none';
  document.getElementById('member-modal-overlay').style.display = 'flex';
}

function closeMemberModal(e) {
  if (e && e.target !== document.getElementById('member-modal-overlay')) return;
  document.getElementById('member-modal-overlay').style.display = 'none';
}

// Refreshes the Members tab's member list, if it's the tab currently open.
function refreshMembersTabIfOpen() {
  const membersTab = document.getElementById('admin-tab-members');
  if (membersTab && membersTab.style.display !== 'none') renderMembersTab();
}

async function addMember() {
  const username = document.getElementById('new-member-username').value.trim().toLowerCase();
  const name     = document.getElementById('new-member-name').value.trim();
  const password = document.getElementById('new-member-password').value.trim();
  const errEl    = document.getElementById('member-modal-error');
  errEl.style.display = 'none';

  if (!username || !name || !password) { showError(errEl, 'All fields are required.'); return; }
  if (username === ADMIN_USERNAME)      { showError(errEl, 'That username is reserved.'); return; }

  const existing = await db.collection('users').where('username', '==', username).limit(1).get();
  if (!existing.empty) { showError(errEl, 'Username already taken.'); return; }

  try {
    const ref = await db.collection('users').add({ username, name, password, role: 'member' });
    members[ref.id] = { uid: ref.id, username, name, password, role: 'member' };
    document.getElementById('new-member-username').value = '';
    document.getElementById('new-member-name').value     = '';
    document.getElementById('new-member-password').value = '';
    closeMemberModal();
    refreshMembersTabIfOpen();
  } catch (e) { showError(errEl, 'Failed to add member. Try again.'); }
}

async function deleteMember(uid, displayName) {
  if (!confirm(`Remove ${displayName}? They will lose access immediately.`)) return;
  try {
    await db.collection('users').doc(uid).delete();
    delete members[uid];
    refreshMembersTabIfOpen();
    // Sync data tab if open
    const dataTab = document.getElementById('admin-tab-data');
    if (dataTab && dataTab.style.display !== 'none') renderDataTab();
  } catch (e) { showToast('Failed to remove member.', 'warn'); }
}

// ─────────────────────────────────────────────────────────────
//  CAMPAIGN MODAL
// ─────────────────────────────────────────────────────────────
function openNewCampaignModal() {
  const list      = document.getElementById('member-assign-list');
  const nonAdmins = Object.values(members).filter(m => m.role !== 'admin');
  list.innerHTML  = nonAdmins.length === 0
    ? '<div style="color:var(--text-muted);font-size:13px;">No members yet. Add members first.</div>'
    : nonAdmins.map(m =>
        `<div class="member-chip" data-uid="${m.uid}" onclick="toggleChip(this)">${m.name || m.username}${m.role === 'team_lead' ? ' <span style="font-size:9px;opacity:0.75;">(Team Lead)</span>' : ''}</div>`
      ).join('');
  document.getElementById('new-campaign-name').value          = '';
  document.getElementById('new-campaign-dday').value          = '';
  document.getElementById('new-campaign-dday-time').value     = '';
  document.getElementById('new-campaign-deadline').value      = '';
  document.getElementById('new-campaign-deadline-time').value = '';
  document.getElementById('modal-error').style.display   = 'none';
  newCampBulkMatched = {};
  document.getElementById('new-camp-bulk-file').value = '';
  document.getElementById('new-camp-bulk-preview').innerHTML = '';
  populateCampaignTemplateSel();
  initNewCampCalendarControls();
  document.getElementById('modal-overlay').style.display = 'flex';
}

// ══════════════════════════════════════════════════════════════════
//  NEW CAMPAIGN — MAP DEADLINES FROM CALENDAR
//  The merged flow: admin types the campaign details manually, and this
//  panel maps the chosen phase + month onto the admin calendar to derive
//  each region's on-time deadline (the same buildRegionDeadlineMap() the
//  Generate-from-Calendar flow uses, so both stay in sync). Regions with
//  no calendar date are flagged; the admin skips them (they fall back to
//  the campaign-wide deadline) or fixes the calendar and re-maps.
// ══════════════════════════════════════════════════════════════════

// Resolved map for the current modal session: { REGION: deadlineISO }.
// null/empty means "no calendar mapping" → createCampaign passes null and
// every entry uses the campaign-wide deadline, exactly as before this flow.
let newCampRegionDeadlines = {};
// Regions the admin chose to skip this session (flagged, no calendar date).
// Skipped regions are simply omitted from the saved map.
let newCampSkippedRegions = new Set();

const _MONTH_LABELS = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];

// Fill the month/year dropdowns (defaulting to the current month) and clear
// any previous session's resolved map + preview.
function initNewCampCalendarControls() {
  newCampRegionDeadlines = {};
  newCampSkippedRegions = new Set();

  const now = new Date();
  const monthSel = document.getElementById('new-campaign-cal-month');
  const yearSel  = document.getElementById('new-campaign-cal-year');
  const typeSel  = document.getElementById('new-campaign-cal-type');
  if (typeSel) typeSel.value = '';

  if (monthSel) {
    monthSel.innerHTML = _MONTH_LABELS
      .map((m, i) => `<option value="${i}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`)
      .join('');
  }
  if (yearSel) {
    const y0 = now.getFullYear();
    yearSel.innerHTML = [y0 - 1, y0, y0 + 1]
      .map(y => `<option value="${y}" ${y === y0 ? 'selected' : ''}>${y}</option>`)
      .join('');
  }

  const preview = document.getElementById('new-campaign-cal-preview');
  if (preview) {
    preview.innerHTML = `<div style="font-size:11px;color:var(--text-muted);">Pick a phase and month above to pull each region's deadline from the calendar. Leave this untouched to just use the single deadline set above for everyone.</div>`;
  }
}

// Recompute the resolved map on every control change and render the preview,
// including flags for regions that appear in the calendar month but resolved
// to no usable deadline. `_prevSkipped` is preserved across re-maps so an
// admin's skip choices survive a month/phase tweak.
// Render one row of the calendar-mapped deadline preview. Handles both bare
// region keys ("MY") and region+platform composites ("MY|shopee"), showing a
// region badge plus, when present, a platform badge — so the admin can see MY
// Shopee and MY Lazada as the distinct deadlines they now are.
function _deadlinePreviewRow(key, iso) {
  const [region, platformId] = String(key).split('|');
  const rLabel = (CAL_REGION_MAP[region]?.label) || region;
  const p = platformId ? CAL_PLATFORM_MAP[platformId] : null;
  const regionBadge = `<span class="rp-reg-tag" style="background:#E0F2FE;color:#075985;">${escHtml(rLabel)}</span>`;
  const platBadge = p
    ? `<span class="rp-reg-tag" style="background:${p.color}1A;color:${p.color};">${escHtml(p.label)}</span>`
    : `<span style="font-size:10px;color:var(--text-muted);">all platforms</span>`;
  return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 8px;background:var(--bg-soft,#F8FAFC);border-radius:6px;">
    <span style="display:flex;gap:5px;align-items:center;min-width:130px;">${regionBadge}${platBadge}</span>
    <span style="color:var(--text-muted);">${escHtml(_fmtDeadline(iso))}</span>
  </div>`;
}

function refreshNewCampCalendarMap() {
  const preview = document.getElementById('new-campaign-cal-preview');
  if (!preview) return;

  const typeVal  = document.getElementById('new-campaign-cal-type')?.value || null;
  const monthVal = parseInt(document.getElementById('new-campaign-cal-month')?.value, 10);
  const yearVal  = parseInt(document.getElementById('new-campaign-cal-year')?.value, 10);
  if (isNaN(monthVal) || isNaN(yearVal)) return;

  // The resolved-deadline map: { REGION: deadlineISO }. Same builder the
  // Generate flow uses, so a region is judged identically whichever path
  // created its campaign.
  const resolved = buildRegionDeadlineMap({
    year: yearVal, month: monthVal, campaignType: typeVal || null,
  });

  // Also collect every region that HAS a calendar event this month/phase but
  // produced NO usable deadline (no explicit Deadline event and a date-only
  // D-Day with no time to subtract from). Those are the ones to flag.
  const flagged = _regionsWithoutDeadline({ year: yearVal, month: monthVal, campaignType: typeVal || null }, resolved);

  newCampRegionDeadlines = resolved;

  const resolvedRegions = Object.keys(resolved).sort();
  if (resolvedRegions.length === 0 && flagged.length === 0) {
    preview.innerHTML = `<div class="chooser-warn" style="font-size:12px;">No region-tagged calendar events found for ${escHtml(_MONTH_LABELS[monthVal])} ${yearVal}${typeVal ? ' · ' + escHtml(_phaseLabel(typeVal)) : ''}. Add D-Day or Deadline events to the calendar, or just use the single deadline above for everyone.</div>`;
    return;
  }

  let html = '';

  if (resolvedRegions.length > 0) {
    html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Deadlines mapped from the calendar — each region &amp; platform is judged on-time/late against its own date:</div>`;
    // Sort so a region's own fallback row sits above its platform-specific rows.
    const _sortedKeys = resolvedRegions.slice().sort((a, b) => {
      const [ra] = a.split('|'), [rb] = b.split('|');
      if (ra !== rb) return ra.localeCompare(rb);
      return a.localeCompare(b); // bare region ("MY") sorts before "MY|lazada"
    });
    html += `<div style="display:flex;flex-direction:column;gap:4px;">` +
      _sortedKeys.map(k => _deadlinePreviewRow(k, resolved[k])).join('') +
      `</div>`;
  }

  if (flagged.length > 0) {
    // Read-only heads-up. These regions have a calendar event but no time to
    // derive a deadline from, so they'll automatically fall back to the
    // campaign-wide deadline typed above. No action needed here — the fix is to
    // add a start time to the event on the calendar (which also fixes the
    // deadline for everyone using that event).
    html += `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px;">
      <div style="font-size:12px;color:#B45309;font-weight:600;margin-bottom:4px;">No time set for ${flagged.length} region${flagged.length !== 1 ? 's' : ''}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">These have a calendar event but no start time, so no per-region deadline can be derived. They'll use the campaign-wide Checklist Deadline set above. To give a region its own deadline, add a start time to its event on the calendar.</div>`;
    html += `<div style="display:flex;flex-direction:column;gap:4px;">` +
      flagged.map(r => {
        const label = (CAL_REGION_MAP[r]?.label) || r;
        return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 8px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;">
          <span style="font-weight:600;min-width:52px;">${escHtml(label)}</span>
          <span style="color:#B45309;flex:1;">Uses campaign-wide deadline</span>
        </div>`;
      }).join('') +
      `</div>`;
  }

  preview.innerHTML = html;
}

// Regions that appear in the calendar for this scope but have no resolved
// deadline in `resolvedMap`. Mirrors buildRegionDeadlineMap's scoping so the
// two agree on what "in scope" means.
function _regionsWithoutDeadline({ year, month, campaignType }, resolvedMap) {
  const monthStart = new Date(year, month, 1);
  const monthEnd   = new Date(year, month + 1, 0);
  const seen = new Set();
  calendarEntries.forEach(e => {
    if (!e.date) return;
    const d = new Date(e.date);
    if (d < monthStart || d > monthEnd) return;
    if (campaignType) {
      const want = _canonicalPhase(campaignType);
      const got  = _canonicalPhase(_calCampaignType(e).id) || _canonicalPhase(e.type);
      if (want && got && want !== got) return;
      if ((!want || !got) && _calCampaignType(e).id !== campaignType && e.type !== campaignType) return;
    }
    // D-Day / Deadline events can supply a deadline directly; a phase-tagged
    // "Other"-milestone event (e.g. Campaign=Mid-Month, Milestone left as
    // default) is treated the same way buildRegionDeadlineMap treats it — as
    // an implicit D-Day. A region seen only via a Teasing/Meeting event isn't
    // "missing a deadline" in a meaningful sense, so those still aren't
    // flagged. This keeps the flag list to genuinely actionable gaps (a D-Day
    // /implicit D-Day with no time, or no Deadline event).
    const isImplicitDday = (e.type === 'other' || !e.type) && _canonicalPhase(_calCampaignType(e).id);
    if (e.type !== 'dday' && e.type !== 'deadline' && !isImplicitDday) return;
    const r = _calRegionOf(e);
    if (!r) return;
    seen.add(r.id);
  });
  return [...seen].filter(r => !(resolvedMap && resolvedMap[r])).sort();
}

// Skip control removed — the calendar panel is read-only now. Regions without
// a derivable deadline simply fall back to the campaign-wide deadline, so
// newCampSkippedRegions stays empty and every resolved region is kept as-is.

// Human label for a phase id used in the calendar-map controls.
function _phaseLabel(typeVal) {
  if (typeVal === 'mid_month')    return 'Mid-Month';
  if (typeVal === 'payday')       return 'PayDay';
  if (typeVal === 'double_digit') return 'Double Digit';
  return 'Any phase';
}

// Pretty-print a resolved deadline ("2026-07-14T16:00" → "Jul 14, 4:00 PM").
function _fmtDeadline(iso) {
  if (!iso) return '—';
  const [datePart, timePart] = iso.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const base = `${_MONTH_LABELS[mo - 1].slice(0, 3)} ${d}`;
  if (!timePart) return base;
  let [h, mi] = timePart.slice(0, 5).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${base}, ${h}:${String(mi).padStart(2, '0')} ${ampm}`;
}

function toggleChip(el) { el.classList.toggle('selected'); }

// Combine a date input and time input into a "YYYY-MM-DDTHH:MM" string (or just date if no time)
function combineDatetime(dateId, timeId) {
  const date = document.getElementById(dateId)?.value || '';
  const time = document.getElementById(timeId)?.value || '';
  if (!date) return null;
  return time ? `${date}T${time}` : date;
}

// Split a stored "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DD") back into [dateStr, timeStr]
function splitDatetime(value) {
  if (!value) return ['', ''];
  if (value.includes('T')) {
    const [d, t] = value.split('T');
    return [d, t.slice(0, 5)]; // strip seconds if any
  }
  return [value, ''];
}

// Toggle all chips in a member-list container
function selectAllChips(listId) {
  const chips = document.querySelectorAll(`#${listId} .member-chip`);
  const allSelected = [...chips].every(c => c.classList.contains('selected'));
  chips.forEach(c => allSelected ? c.classList.remove('selected') : c.classList.add('selected'));
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').style.display = 'none';
}

// ══════════════════════════════════════════════════════════════════
//  SHARED CAMPAIGN ENGINE
//  One writer for every path that creates a campaign (manual "+ New
//  Campaign", "Generate from Calendar", and anything added later).
//  Previously createCampaign() and confirmGenerateChecklist() each
//  hand-rolled the campaign write + checklist merge + broadcast, so a
//  fix to one silently missed the other. Now they both call this.
//
//  Checklist writes are NON-DESTRUCTIVE: existing entries (and the
//  member's progress on them) are kept; only genuinely new brand/
//  platform/region combos are appended.
// ══════════════════════════════════════════════════════════════════
async function createCampaignWithChecklists({
  name,
  uids = [],
  entries = {},          // { uid: [{ label, brand, platform, region }] }
  templateId = null,     // ← mega vs non-mega
  dday = null,
  deadline = null,
  region = null,
  platform = null,
  campaignType = null,
  fromPollId = null,
  broadcastMessage = null, // null → no broadcast sent
  regionDeadlines = null,  // { REGION: deadlineISO } — per-region deadlines from the calendar
}) {
  const ref = await db.collection('campaigns').add({
    name,
    assignedUids:        uids,
    createdAt:           firebase.firestore.FieldValue.serverTimestamp(),
    createdBy:           ADMIN_UID,
    fromPollId:          fromPollId || null,
    checklistTemplateId: templateId || null,
    region:              region || null,
    platform:            platform || null,
    campaignType:        campaignType || null,
    dday:                dday || null,
    deadline:            deadline || null,
    regionDeadlines:     regionDeadlines || null,
  });
  const campaignId = ref.id;

  // Merge entries into each member's checklist doc without clobbering progress.
  const withEntries = Object.entries(entries).filter(([uid, en]) => uids.includes(uid) && en && en.length);
  if (withEntries.length > 0) {
    await Promise.all(withEntries.map(async ([uid, newEntries]) => {
      const docRef = db.collection('checklists').doc(uid);
      const snap   = await docRef.get();
      const existingCampData = (snap.exists && snap.data()[campaignId]) || {};
      const existingEntries  = existingCampData.entries || [];
      const newOnes = newEntries.filter(en =>
        !existingEntries.some(ex => ex.brand === en.brand && ex.platform === en.platform && ex.region === en.region)
      );
      await docRef.set({
        [campaignId]: {
          ...existingCampData,
          entries: [...existingEntries, ...newOnes],
          lastActive: new Date().toISOString(),
        }
      }, { merge: true });
    }));
  }

  if (broadcastMessage) {
    await db.collection('broadcasts').add({
      type: 'custom',
      message: broadcastMessage,
      targetUid: null, targetName: 'everyone',
      campaignId, campaignName: name,
      sentAt: new Date().toISOString(), sentBy: 'Admin', readBy: [],
    });
  }

  return campaignId;
}

// One template-dropdown filler for every modal that offers the mega/non-mega
// choice (new campaign, edit campaign, generate). Loads templates if needed.
async function populateTemplateSel(elId, selectedId) {
  await loadChecklistTemplates();
  const sel = document.getElementById(elId);
  if (!sel) return;
  sel.innerHTML = `<option value="">None (use default checklist)</option>` +
    (checklistTemplates || []).map(t =>
      `<option value="${t.id}" ${t.id === selectedId ? 'selected' : ''}>${escHtml(t.name)}</option>`
    ).join('');
}

// ─── Campaign creation chooser ────────────────────────────────
// "+ New Campaign" now asks HOW first, because the two flows answer different
// questions: manual = "I know exactly who and what"; generate = "work it out
// from the calendar + roster".
function openCampaignChooser() {
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'manager';
  if (!isAdmin) return;
  const hasRoster = !!(campaignRoster && campaignRoster.length);
  const rosterNote = document.getElementById('chooser-roster-note');
  if (rosterNote) {
    rosterNote.innerHTML = hasRoster
      ? ''
      : `<div class="chooser-warn">No roster uploaded yet — generating from the calendar needs a Bulk Assign sheet first.</div>`;
  }
  document.getElementById('campaign-chooser-overlay').style.display = 'flex';
}

function closeCampaignChooser(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('campaign-chooser-overlay').style.display = 'none';
}

function chooseCampaignMode(mode) {
  // "Generate from calendar" was removed — Bulk Assign is the calendar-driven
  // path now. Any mode simply opens the manual New Campaign modal.
  closeCampaignChooser();
  openNewCampaignModal();
}

async function createCampaign() {
  const name  = document.getElementById('new-campaign-name').value.trim();
  const errEl = document.getElementById('modal-error');
  if (!name) { showError(errEl, 'Please enter a campaign name.'); return; }

  const selectedChips = document.querySelectorAll('#member-assign-list .member-chip.selected');
  const assignedUids  = [...selectedChips].map(c => c.dataset.uid);
  if (assignedUids.length === 0) { showError(errEl, 'Please assign at least one member.'); return; }

  try {
    const pollId = document.getElementById('modal-overlay').dataset.pollId || null;
    const selectedTemplateId = document.getElementById('campaign-template-sel')?.value || null;

    // Entries can come from two optional sources — poll responses and the
    // in-modal Excel upload. Build one { uid: [entries] } map from both; the
    // shared engine handles the non-destructive merge from there.
    const prefillData = {};

    if (pollId && Object.keys(pollResponses || {}).length > 0) {
      assignedUids.forEach(uid => {
        const resp = pollResponses[uid];
        if (resp && resp.status === 'registered' && resp.registrations && resp.registrations.length > 0) {
          prefillData[uid] = resp.registrations.map(r => ({
            label:    [r.brand, r.platform, r.region].filter(Boolean).join('_'),
            brand:    r.brand || '',
            platform: r.platform || '',
            region:   r.region || '',
          }));
        }
      });
    }

    if (newCampBulkMatched && Object.keys(newCampBulkMatched).length > 0) {
      Object.entries(newCampBulkMatched).forEach(([uid, entries]) => {
        if (!assignedUids.includes(uid)) return; // only members actually assigned here
        const merged = [...(prefillData[uid] || [])];
        entries.forEach(en => {
          if (!merged.some(ex => ex.brand === en.brand && ex.platform === en.platform && ex.region === en.region)) merged.push(en);
        });
        prefillData[uid] = merged;
      });
    }

    const hasEntries = Object.keys(prefillData).length > 0;

    // Calendar-mapped per-region deadlines: take the resolved map from the
    // "Map from Calendar" panel and drop any regions the admin skipped (those
    // fall back to the campaign-wide deadline in reporting). Null when nothing
    // was mapped, so behaviour is identical to before for admins who ignore
    // the panel.
    let regionDeadlines = null;
    if (newCampRegionDeadlines && Object.keys(newCampRegionDeadlines).length > 0) {
      const kept = {};
      Object.entries(newCampRegionDeadlines).forEach(([region, dl]) => {
        if (!newCampSkippedRegions.has(region)) kept[region] = dl;
      });
      if (Object.keys(kept).length > 0) regionDeadlines = kept;
    }

    await createCampaignWithChecklists({
      name,
      uids:       assignedUids,
      entries:    prefillData,
      templateId: selectedTemplateId,
      dday:       combineDatetime('new-campaign-dday', 'new-campaign-dday-time'),
      deadline:   combineDatetime('new-campaign-deadline', 'new-campaign-deadline-time'),
      regionDeadlines,
      // Whatever phase was picked in "Per-Region Deadlines from Calendar" —
      // saved on the campaign itself so future features (e.g. the upcoming-
      // campaign alert) can match it precisely instead of guessing from the
      // name. '' (Any phase) is normalised to null, same as an untouched picker.
      campaignType: document.getElementById('new-campaign-cal-type')?.value || null,
      fromPollId: pollId,
      // Only shout about it when there's actually a pre-filled checklist waiting.
      broadcastMessage: hasEntries
        ? `🚀 Campaign "${name}" is ready! Your checklist has been pre-filled with your registered details. Go to the Checklist tab to start.`
        : null,
    });

    // Lock the poll if this campaign came from one.
    if (pollId) {
      try {
        await POLL_META_REF(pollId).set({ status: 'locked', lockedAt: new Date().toISOString() }, { merge: true });
        const listDoc2 = await POLLS_LIST_REF().get();
        if (listDoc2.exists) {
          const pls  = listDoc2.data().polls || [];
          const pidx = pls.findIndex(p => p.id === pollId);
          if (pidx >= 0) { pls[pidx].status = 'locked'; await POLLS_LIST_REF().set({ polls: pls }); }
        }
      } catch(le) { console.warn('Could not lock poll:', le); }
    }

    document.getElementById('modal-overlay').dataset.pollId = '';
    document.getElementById('modal-overlay').style.display = 'none';
    await loadAdminData();
    showToast(`✅ Campaign "${name}" created.`, 'success');
  } catch (e) {
    showError(errEl, 'Failed to create campaign. Try again.');
    console.error(e);
  }
}


// ─── Admin: Duplicate Campaign ───────────────────────────────
async function duplicateCampaign(campId) {
  const camp = campaigns[campId];
  if (!camp) return;
  const newName = prompt('New campaign name:', camp.name + ' (copy)');
  if (!newName || !newName.trim()) return;
  try {
    await db.collection('campaigns').add({
      name:        newName.trim(),
      assignedUids: camp.assignedUids || [],
      createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
      createdBy:   ADMIN_UID,
      fromPollId:  null,
    });
    await loadAdminData();
    showToast(`✅ Campaign "${newName.trim()}" created!`, 'success');
  } catch(e) { showToast('Failed to duplicate campaign. Try again.', 'warn'); console.error(e); }
}

// ─── Admin: Edit Campaign ─────────────────────────────────────
async function openEditCampaignModal(campId) {
  const camp = campaigns[campId];
  if (!camp) return;

  // Ensure templates are loaded
  if (!checklistTemplates || checklistTemplates.length === 0) {
    await loadChecklistTemplates();
  }

  const overlay = document.getElementById('edit-campaign-overlay');
  overlay.dataset.campId = campId;

  document.getElementById('edit-campaign-name').value     = camp.name;
  // Populate date + time fields from stored ISO-like values
  const [ddayDate, ddayTime]         = splitDatetime(camp.dday);
  const [deadlineDate, deadlineTime] = splitDatetime(camp.deadline);
  document.getElementById('edit-campaign-dday').value          = ddayDate;
  document.getElementById('edit-campaign-dday-time').value     = ddayTime;
  document.getElementById('edit-campaign-deadline').value      = deadlineDate;
  document.getElementById('edit-campaign-deadline-time').value = deadlineTime;
  document.getElementById('edit-campaign-error').style.display = 'none';

  // Build template selector
  const tmplSel = document.getElementById('edit-campaign-template-sel');
  tmplSel.innerHTML = `<option value="">None (use default checklist)</option>`;
  (checklistTemplates || []).forEach(t => {
    tmplSel.innerHTML += `<option value="${t.id}" ${camp.checklistTemplateId === t.id ? 'selected' : ''}>${escHtml(t.name)}</option>`;
  });

  // Build member chips
  const nonAdmins = Object.values(members).filter(m => m.role !== 'admin');
  const list = document.getElementById('edit-member-assign-list');
  list.innerHTML = nonAdmins.length === 0
    ? '<div style="color:var(--text-muted);font-size:13px;">No members yet.</div>'
    : nonAdmins.map(m => {
        const sel = (camp.assignedUids || []).includes(m.uid) ? 'selected' : '';
        const tag = m.role === 'team_lead' ? ' <span style="font-size:9px;opacity:0.75;">(Team Lead)</span>' : '';
        return `<div class="member-chip ${sel}" data-uid="${m.uid}" onclick="toggleChip(this)">${m.name || m.username}${tag}</div>`;
      }).join('');

  overlay.style.display = 'flex';
}

function closeEditCampaignModal(e) {
  if (e && e.target !== document.getElementById('edit-campaign-overlay')) return;
  document.getElementById('edit-campaign-overlay').style.display = 'none';
}

async function saveEditCampaign() {
  const overlay = document.getElementById('edit-campaign-overlay');
  const campId  = overlay.dataset.campId;
  const name    = document.getElementById('edit-campaign-name').value.trim();
  const errEl   = document.getElementById('edit-campaign-error');
  errEl.style.display = 'none';

  if (!name) { showError(errEl, 'Campaign name is required.'); return; }

  const selectedChips = document.querySelectorAll('#edit-member-assign-list .member-chip.selected');
  const assignedUids  = [...selectedChips].map(c => c.dataset.uid);
  if (assignedUids.length === 0) { showError(errEl, 'Please assign at least one member.'); return; }

  const templateId = document.getElementById('edit-campaign-template-sel')?.value || null;
  const dday       = combineDatetime('edit-campaign-dday', 'edit-campaign-dday-time');
  const deadline   = combineDatetime('edit-campaign-deadline', 'edit-campaign-deadline-time');

  try {
    await db.collection('campaigns').doc(campId).update({
      name,
      assignedUids,
      checklistTemplateId: templateId || null,
      dday:     dday || null,
      deadline: deadline || null,
    });
    campaigns[campId] = { ...campaigns[campId], name, assignedUids, checklistTemplateId: templateId || null, dday: dday || null, deadline: deadline || null };
    overlay.style.display = 'none';
    await loadAdminData();
    showToast('✅ Campaign updated!', 'success');
  } catch(e) {
    showError(errEl, 'Failed to save. Try again.');
    console.error(e);
  }
}

// ─── Admin: Delete single Campaign ───────────────────────────
async function deleteCampaign(campId, campName) {
  if (!confirm(`Delete campaign "${campName}"?\n\nThis will remove the campaign and all assigned members' checklist progress for it. This cannot be undone.`)) return;
  try {
    // Delete the campaign document
    await db.collection('campaigns').doc(campId).delete();

    // Remove campaign key from all member checklists
    const clSnap = await db.collection('checklists').get();
    const batch  = db.batch();
    clSnap.forEach(doc => {
      const data = doc.data();
      if (data[campId] !== undefined) {
        const updated = { ...data };
        delete updated[campId];
        batch.set(doc.ref, updated);
      }
    });
    await batch.commit();

    delete campaigns[campId];
    await loadAdminData();
    showToast(`✅ Campaign "${campName}" deleted.`, 'success');
  } catch(e) {
    showToast('Failed to delete campaign. Try again.', 'warn');
    console.error(e);
  }
}

// ─────────────────────────────────────────────────────────────
//  CAMPAIGN ARCHIVE
//  Archiving never deletes Firestore data — it just sets
//  campaigns/{id}.archived = true so active queries/renders (dashboard,
//  filters, member & team-lead views) skip it, keeping those light over
//  time. A CSV completion summary is downloaded first as an offline
//  reference, since the raw data is no longer surfaced in the active UI.
// ─────────────────────────────────────────────────────────────

// Builds and downloads a one-campaign CSV summary (same columns as the
// full Reports export, scoped to a single campaign). Returns true on
// success so callers can decide whether to proceed with archiving.
async function exportCampaignSummaryCSV(camp) {
  try {
    const checkSnap     = await db.collection('checklists').get();
    const allChecklists = {};
    checkSnap.forEach(doc => { allChecklists[doc.id] = doc.data(); });
    const totalItemsMap = await resolveCampaignTotalItems([camp]);
    const campInfo       = totalItemsMap[camp.id] || { total: TOTAL_ITEMS, validIds: null, hasD5: true };
    const hasD5           = campInfo.hasD5 !== false;

    const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB') : '';

    const rows = [['Campaign', 'Member', 'Username',
      'D-5 Done', 'D-5 Total', 'D-5 %',
      'D-1 Done', 'D-1 Total', 'D-1 %',
      'Overall %', 'Status', 'Last Active', 'Completed', 'Brand/Platform/Region']];

    (camp.assignedUids || []).forEach(uid => {
      const member = members[uid];
      if (!member) return;
      const cl         = (allChecklists[uid] || {})[camp.id] || {};
      const d5Done     = hasD5 ? countDone(cl.d5 || {}, campInfo.validIds) : 0;
      const d1Done     = countDone(cl.d1 || {}, campInfo.validIds);
      const entryCount = (cl.entries || []).length || 1;
      const ti         = campInfo.total * entryCount;
      const overallPct = ti ? Math.round((d1Done / ti) * 100) : 0;
      const d5Pct      = hasD5 && ti ? Math.round((d5Done / ti) * 100) : 0;
      const d1Pct      = ti ? Math.round((d1Done / ti) * 100) : 0;
      const status     = overallPct === 100 ? 'Complete' : overallPct > 0 ? 'In Progress' : 'Not Started';
      const entries    = (cl.entries || []).map(e => e.label || [e.brand, e.platform, e.region].filter(Boolean).join(' · ')).filter(Boolean).join(' | ');

      rows.push([
        camp.name, member.name || member.username, member.username,
        hasD5 ? d5Done : 'N/A', hasD5 ? ti : 'N/A', hasD5 ? d5Pct + '%' : 'N/A',
        d1Done, ti, d1Pct + '%',
        overallPct + '%', status, fmtDate(cl.lastActive), fmtDate(cl.completedAt), entries,
      ]);
    });

    if (rows.length === 1) rows.push(['(no assigned members / no progress recorded)']);

    const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${camp.name.replace(/[^a-z0-9]+/gi, '_')}_Summary_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  } catch (e) {
    console.error('exportCampaignSummaryCSV failed:', e);
    showToast('Failed to generate the summary file.', 'warn');
    return false;
  }
}

async function archiveCampaign(campId, campName) {
  const camp = campaigns[campId];
  if (!camp) return;
  if (!confirm(`Archive campaign "${campName}"?\n\nA completion summary (.csv) will download as a reference. The campaign will move to Archived Campaigns and stop appearing in the active dashboard, filters, and member/team-lead views. All data is kept — you can restore it anytime.`)) return;

  const ok = await exportCampaignSummaryCSV(camp);
  if (!ok && !confirm('The summary download failed. Archive the campaign anyway?')) return;

  try {
    await db.collection('campaigns').doc(campId).update({ archived: true, archivedAt: new Date().toISOString() });
    delete campaigns[campId];
    archivedCampaigns[campId] = { ...camp, archived: true, archivedAt: new Date().toISOString() };
    await loadAdminData();
    showToast(`📦 Campaign "${campName}" archived.`, 'success');
  } catch (e) {
    showToast('Failed to archive campaign. Try again.', 'warn');
    console.error(e);
  }
}

async function restoreCampaign(campId, campName) {
  if (!confirm(`Restore campaign "${campName}" to active campaigns?`)) return;
  try {
    await db.collection('campaigns').doc(campId).update({ archived: false });
    delete archivedCampaigns[campId];
    await loadAdminData();
    showToast(`✅ Campaign "${campName}" restored.`, 'success');
  } catch (e) {
    showToast('Failed to restore campaign. Try again.', 'warn');
    console.error(e);
  }
}

async function permanentlyDeleteArchivedCampaign(campId, campName) {
  if (!confirm(`Permanently delete archived campaign "${campName}"?\n\nThis removes the campaign and all assigned members' checklist progress for it for good. This cannot be undone — make sure you've kept the downloaded summary if you need it.`)) return;
  try {
    await db.collection('campaigns').doc(campId).delete();
    const clSnap = await db.collection('checklists').get();
    const batch  = db.batch();
    clSnap.forEach(doc => {
      const data = doc.data();
      if (data[campId] !== undefined) {
        const updated = { ...data };
        delete updated[campId];
        batch.set(doc.ref, updated);
      }
    });
    await batch.commit();

    delete archivedCampaigns[campId];
    renderArchivedCampaignsList();
    showToast(`🗑 Archived campaign "${campName}" permanently deleted.`, 'success');
  } catch (e) {
    showToast('Failed to delete archived campaign. Try again.', 'warn');
    console.error(e);
  }
}

let _archivedCampaignsVisible = false;
function toggleArchivedCampaignsView() {
  _archivedCampaignsVisible = !_archivedCampaignsVisible;
  const list = document.getElementById('data-archived-campaigns-list');
  const btn  = document.getElementById('data-archived-toggle-btn');
  if (list) list.style.display = _archivedCampaignsVisible ? 'block' : 'none';
  if (btn)  btn.textContent = _archivedCampaignsVisible ? 'Hide' : 'View';
  if (_archivedCampaignsVisible) renderArchivedCampaignsList();
}

function renderArchivedCampaignsList() {
  const countEl = document.getElementById('data-archived-count');
  const count = Object.keys(archivedCampaigns).length;
  if (countEl) countEl.textContent = count;

  const list = document.getElementById('data-archived-campaigns-list');
  if (!list) return;
  const campList = Object.values(archivedCampaigns);
  if (campList.length === 0) {
    list.innerHTML = '<div class="data-empty">No archived campaigns.</div>';
    return;
  }
  list.innerHTML = campList.map(c => {
    const assignedNames = (c.assignedUids || []).map(uid => {
      const m = members[uid];
      return m ? (m.name || m.username) : uid;
    }).join(', ') || '—';
    const archivedDt = c.archivedAt ? new Date(c.archivedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';
    return `
      <div class="data-list-row">
        <div>
          <div class="data-row-title">${escHtml(c.name)}</div>
          <div class="data-row-sub">Archived ${archivedDt} · Members: ${escHtml(assignedNames)}</div>
        </div>
        <button class="btn-ghost-light btn-sm" onclick="exportCampaignSummaryCSV(archivedCampaigns['${c.id}'])" title="Download summary again">⬇ Summary</button>
        <button class="btn-ghost-light btn-sm" style="color:#059669;border-color:#bbf7d0;" onclick="restoreCampaign('${c.id}','${escHtml(c.name).replace(/'/g,"\\'")}')" title="Restore to active">↩ Restore</button>
        <button class="btn-ghost-light btn-sm" style="color:#DC2626;border-color:#FCA5A5;" onclick="permanentlyDeleteArchivedCampaign('${c.id}','${escHtml(c.name).replace(/'/g,"\\'")}')" title="Permanently delete">🗑 Delete</button>
      </div>`;
  }).join('');
}



// ─────────────────────────────────────────────────────────────
//  USER TABS  (calendar vs checklist)
// ─────────────────────────────────────────────────────────────
function showUserTab(tab) {
  const dashView = document.getElementById('user-dashboard-view');
  const calView  = document.getElementById('user-calendar-view');
  const clView   = document.getElementById('user-checklist-view');

  // Update sidebar nav active state
  ['dashboard','calendar','checklist'].forEach(t => {
    const btn = document.getElementById('user-navbtn-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
  });

  // Hide all views
  if (dashView) dashView.style.display = 'none';
  if (calView)  calView.style.display  = 'none';
  if (clView)   clView.style.display   = 'none';

  if (tab === 'dashboard') {
    if (dashView) dashView.style.display = 'block';
    renderUserDashboard();
  } else if (tab === 'calendar') {
    if (calView) calView.style.display = 'block';
    renderCalendarView(calView);
  } else {
    if (clView) clView.style.display = 'block';
    if (selectedCampaignId) {
      renderUserChecklist();
    }
  }
}

function showTlTab(tab) {
  const dashView = document.getElementById('tl-dashboard-view');
  const calView  = document.getElementById('tl-calendar-view');
  const clView   = document.getElementById('tl-checklist-view');

  // Update sidebar nav active state
  ['dashboard','calendar','checklist'].forEach(t => {
    const btn = document.getElementById('tl-navbtn-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
  });

  // Hide all views
  if (dashView) dashView.style.display = 'none';
  if (calView)  calView.style.display  = 'none';
  if (clView)   clView.style.display   = 'none';

  if (tab === 'calendar') {
    if (calView) calView.style.display = 'block';
    renderCalendarView(calView);
  } else if (tab === 'checklist') {
    if (clView) clView.style.display = 'block';
    enterTlChecklistTab();
  } else {
    if (dashView) dashView.style.display = 'block';
    renderTeamLeadView();
  }
}

// ─────────────────────────────────────────────────────────────
//  USER CHECKLIST — COMBINED D-5 / D-1 TABLE VIEW
// ─────────────────────────────────────────────────────────────
function populateUserCampaignSelect() {
  const sel = document.getElementById('user-campaign-select');
  sel.innerHTML = '<option value="">Select campaign…</option>';
  Object.values(campaigns).forEach(c => {
    sel.innerHTML += `<option value="${c.id}">${c.name}</option>`;
  });
}

async function loadUserChecklist() {
  const sel = document.getElementById('user-campaign-select');
  selectedCampaignId = sel.value;

  if (!selectedCampaignId) {
    document.getElementById('user-no-campaign').style.display     = 'block';
    document.getElementById('user-checklist').style.display       = 'none';
    document.getElementById('user-progress-bar-wrap').style.display = 'none';
    const banner = document.getElementById('user-progress-banner');
    if (banner) banner.style.display = 'none';
    const rspBanner = document.getElementById('user-rspkit-banner');
    if (rspBanner) rspBanner.style.display = 'none';
    const userCampSub = document.getElementById('user-campaign-sub');
    if (userCampSub) userCampSub.textContent = 'Select a campaign to begin';
    return;
  }

  document.getElementById('user-campaign-name').textContent       = campaigns[selectedCampaignId]?.name || '';
  const userCampSub = document.getElementById('user-campaign-sub');
  if (userCampSub) userCampSub.innerHTML = campDateMetaHtml(campaigns[selectedCampaignId]) || 'Fill out your checklist below';
  document.getElementById('user-no-campaign').style.display       = 'none';
  document.getElementById('user-checklist').style.display         = 'block';
  document.getElementById('user-progress-bar-wrap').style.display = 'block';

  // Load the correct checklist sections for this campaign's template
  await loadChecklistOverrides(selectedCampaignId);

  ensureEntries();
  renderUserChecklist();
  updateUserProgress();
}

function ensureEntries() {
  if (!userChecklist[selectedCampaignId]) userChecklist[selectedCampaignId] = {};
  if (!userChecklist[selectedCampaignId].entries || userChecklist[selectedCampaignId].entries.length === 0) {
    userChecklist[selectedCampaignId].entries = [{ brand: '', platform: '', region: '' }];
  }
}

function getEntries() {
  return (userChecklist[selectedCampaignId] || {}).entries || [{ brand: '', platform: '', region: '' }];
}

function addEntry() {
  ensureEntries();
  userChecklist[selectedCampaignId].entries.push({ brand: '', platform: '', region: '' });
  renderUserChecklist();
  updateUserProgress();
  saveChecklist();
}

function updateEntryField(index, field, value) {
  ensureEntries();
  userChecklist[selectedCampaignId].entries[index][field] = value;
  saveChecklist();
}

// New: single editable label per entry
function updateEntryLabel(index, value) {
  ensureEntries();
  userChecklist[selectedCampaignId].entries[index].label = value;
  saveChecklist();
}

function buildEntryLabel(entry, index) {
  if (entry.label) return entry.label;
  const parts = [entry.brand, entry.platform, entry.region].filter(Boolean);
  return parts.length ? parts.join(' · ') : `Entry ${index + 1}`;
}

function removeEntry(index) {
  ensureEntries();
  if (userChecklist[selectedCampaignId].entries.length <= 1) return;
  userChecklist[selectedCampaignId].entries.splice(index, 1);
  renderUserChecklist();
  updateUserProgress();
  saveChecklist();
}

const collapsedCats = {};

function toggleCat(catId) {
  collapsedCats[catId] = !collapsedCats[catId];
  document.querySelectorAll(`[data-cat="${catId}"]`).forEach(row => {
    row.style.display = collapsedCats[catId] ? 'none' : '';
  });
  const arrow = document.getElementById(`arrow-${catId}`);
  if (arrow) arrow.classList.toggle('open', !collapsedCats[catId]);
}

// ── BULK SELECT STATE ──
let bulkTab = 'd5'; // which tab the bulk action applies to

function openBulkPanel(tab, catId) {
  bulkTab = tab;
  const panel = document.getElementById('bulk-action-panel');
  panel.dataset.catId = catId || '';
  panel.dataset.tab = tab;
  panel.style.display = 'flex';
}

function closeBulkPanel() {
  document.getElementById('bulk-action-panel').style.display = 'none';
  // Uncheck all
  document.querySelectorAll('.row-cb:checked, .cat-cb:checked').forEach(cb => cb.checked = false);
  updateSelectAllState();
}

function applyBulkStatus(status, targetTab) {
  // targetTab: 'd5' or 'd1' — which column group to update
  const tab = targetTab || 'd5';

  // Collect checked row checkboxes — one per item row
  const checked = [...document.querySelectorAll('.row-cb:checked')];
  if (checked.length === 0) {
    document.getElementById('bulk-count-label').textContent = 'No items selected';
    return;
  }

  const entryCount = getEntries().length;

  checked.forEach(cb => {
    const itemId = cb.dataset.itemId;
    // Apply to ALL entry columns for this item
    for (let ei = 0; ei < entryCount; ei++) {
      ensurePath(tab);
      const key = ei === 0 ? itemId : `${itemId}_e${ei}`;
      userChecklist[selectedCampaignId][tab][key] = {
        ...(userChecklist[selectedCampaignId][tab][key] || {}), status
      };
      const sel = document.getElementById(`sel-${tab}-${itemId}-${ei}`);
      if (sel) {
        sel.value = status;
        sel.className = `status-sel ${statusClass(status)}`;
      }
    }
  });

  updateUserProgress();
  saveChecklist();
  // Keep panel open so user can also set D-1 after D-5 without re-selecting
  document.getElementById('bulk-count-label').textContent =
    `${checked.length} item${checked.length > 1 ? 's' : ''} selected — ${tab.toUpperCase()} updated ✓`;
}

function toggleSelectAll(masterCb) {
  const checked = masterCb.checked;
  document.querySelectorAll('.row-cb').forEach(cb => {
    cb.checked = checked;
  });
  document.querySelectorAll('.cat-cb').forEach(cb => {
    cb.checked = checked;
  });
  updateBulkBar();
}

function toggleCatCheckboxes(catCb, catId) {
  const checked = catCb.checked;
  document.querySelectorAll(`.row-cb[data-cat="${catId}"]`).forEach(cb => {
    cb.checked = checked;
  });
  updateSelectAllState();
  updateBulkBar();
}

// Bulk-apply a status to all items in a category for D-5 or D-1
// Show a small status-picker popup anchored to the category checkbox
function toggleCatD5(cb, catId, entryIdx) {
  if (!cb.checked) { cb.checked = false; return; } // unchecking does nothing
  showCatStatusPicker(cb, catId, entryIdx, 'd5');
}

function toggleCatD1(cb, catId, entryIdx) {
  if (!cb.checked) { cb.checked = false; return; }
  showCatStatusPicker(cb, catId, entryIdx, 'd1');
}

function showCatStatusPicker(anchorCb, catId, entryIdx, tab) {
  // Remove any existing picker
  const existing = document.getElementById('cat-status-picker');
  if (existing) existing.remove();

  // Tick all row checkboxes in this category+tab so user sees bulk scope
  const rowCbs = [...document.querySelectorAll(`.row-cb[data-cat="${catId}"][data-tab="${tab}"][data-entry-idx="${entryIdx}"]`)];
  rowCbs.forEach(cb => { cb.checked = true; });

  const resetRowCbs = () => rowCbs.forEach(cb => { cb.checked = false; });

  const statuses = [
    { v: 'done',        l: 'Done',        cls: 'csp-done' },
    { v: 'in-progress', l: 'In Progress', cls: 'csp-progress' },
    { v: '',            l: 'Pending',     cls: 'csp-pending' },
    { v: 'na',          l: 'N/A',         cls: 'csp-na' },
  ];

  const picker = document.createElement('div');
  picker.id = 'cat-status-picker';

  // Label at top of picker
  const label = document.createElement('div');
  label.textContent = `Bulk set ${tab.toUpperCase()} — ${catId.replace(/_/g,' ')}`;
  label.style.cssText = 'font-size:10px;font-weight:600;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.05em;padding:2px 4px 6px;border-bottom:1px solid rgba(255,255,255,0.12);margin-bottom:4px;white-space:nowrap;';
  picker.appendChild(label);

  picker.style.cssText = `
    position:fixed;z-index:9999;background:#1B3A6B;border:1px solid rgba(255,255,255,0.2);
    border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:4px;
    box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:140px;
  `;

  statuses.forEach(s => {
    const btn = document.createElement('button');
    btn.textContent = s.l;
    btn.className = 'csp-btn ' + s.cls;
    btn.onclick = () => {
      applyCatStatus(catId, entryIdx, tab, s.v);
      picker.remove();
      anchorCb.checked = false;
      resetRowCbs();
      document.removeEventListener('mousedown', dismiss);
    };
    picker.appendChild(btn);
  });

  // Cancel on outside click
  const dismiss = (e) => {
    if (!picker.contains(e.target) && e.target !== anchorCb) {
      picker.remove();
      anchorCb.checked = false;
      resetRowCbs();
      document.removeEventListener('mousedown', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);

  // Position near the checkbox
  document.body.appendChild(picker);
  const rect = anchorCb.getBoundingClientRect();
  const ph = picker.offsetHeight || 160;
  const pw = picker.offsetWidth  || 150;
  let top  = rect.bottom + 6;
  let left = rect.left - 4;
  if (top + ph > window.innerHeight) top = rect.top - ph - 6;
  if (left + pw > window.innerWidth)  left = rect.right - pw;
  picker.style.top  = top  + 'px';
  picker.style.left = left + 'px';
}

function applyCatStatus(catId, entryIdx, tab, status) {
  const selector = `.row-cb[data-cat="${catId}"][data-tab="${tab}"][data-entry-idx="${entryIdx}"]`;
  const items = [...document.querySelectorAll(selector)];
  items.forEach(rowCb => {
    const itemId = rowCb.dataset.itemId;
    const ei = parseInt(rowCb.dataset.entryIdx);
    ensurePath(tab);
    const key = ei === 0 ? itemId : `${itemId}_e${ei}`;
    userChecklist[selectedCampaignId][tab][key] = {
      ...(userChecklist[selectedCampaignId][tab][key] || {}), status
    };
    const sel = document.getElementById(`sel-${tab}-${itemId}-${ei}`);
    if (sel) { sel.value = status; sel.className = `status-sel ${statusClass(status)}`; }
  });
  updateUserProgress();
  saveChecklist();
}

function onRowCbChange() {
  updateSelectAllState();
  updateBulkBar();
}

function updateSelectAllState() {
  const all   = [...document.querySelectorAll('.row-cb')];
  const allCh = all.every(cb => cb.checked);
  const someCh = all.some(cb => cb.checked);
  const master = document.getElementById('select-all-cb');
  if (master) {
    master.checked       = allCh;
    master.indeterminate = !allCh && someCh;
  }
  // Per-cat
  document.querySelectorAll('.cat-cb').forEach(catCb => {
    const catId = catCb.dataset.catId;
    const catRows = [...document.querySelectorAll(`.row-cb[data-cat="${catId}"]`)];
    catCb.checked       = catRows.every(cb => cb.checked);
    catCb.indeterminate = !catCb.checked && catRows.some(cb => cb.checked);
  });
}

function updateBulkBar() {
  const checked = [...document.querySelectorAll('.row-cb:checked')];
  const bar     = document.getElementById('bulk-action-panel');
  if (checked.length > 0) {
    bar.style.display = 'flex';
    document.getElementById('bulk-count-label').textContent = `${checked.length} item${checked.length > 1 ? 's' : ''} selected`;
  } else {
    bar.style.display = 'none';
  }
}

// ── Main render ──
function renderUserChecklist() {
  if (!selectedCampaignId) return;

  const campData   = userChecklist[selectedCampaignId] || {};
  const d5Data     = campData.d5 || {};
  const d1Data     = campData.d1 || {};
  const entries    = getEntries();
  const entryCount = entries.length;

  const containerId = currentUser?.role === 'team_lead' ? 'tl-checklist' : 'user-checklist';
  const container = document.getElementById(containerId);
  if (!container) return;

  const hasD5 = getHasD5();

  // Bulk action bar (floating)
  let html = `
  <div id="bulk-action-panel" style="display:none;position:sticky;top:0;z-index:50;
    background:var(--navy);color:white;padding:10px 16px;border-radius:var(--radius);
    margin-bottom:10px;align-items:center;gap:10px;flex-wrap:wrap;box-shadow:0 4px 16px rgba(27,58,107,0.3);">
    <span id="bulk-count-label" style="font-size:13px;font-weight:600;min-width:100px;"></span>
    ${hasD5 ? `<div style="display:flex;align-items:center;gap:6px;border-left:1px solid rgba(255,255,255,0.2);padding-left:10px;">
      <span style="font-size:11px;font-weight:700;color:#93C5FD;letter-spacing:.05em;">D-5:</span>
      <button class="bulk-btn bulk-done"     onclick="applyBulkStatus('done','d5')">✓ Done</button>
      <button class="bulk-btn bulk-progress" onclick="applyBulkStatus('in-progress','d5')">⟳ In Progress</button>
      <button class="bulk-btn bulk-pending"  onclick="applyBulkStatus('','d5')">— Pending</button>
      <button class="bulk-btn bulk-na"       onclick="applyBulkStatus('na','d5')">N/A</button>
    </div>` : ''}
    <div style="display:flex;align-items:center;gap:6px;border-left:1px solid rgba(255,255,255,0.2);padding-left:10px;">
      <span style="font-size:11px;font-weight:700;color:#C4B5FD;letter-spacing:.05em;">D-1:</span>
      <button class="bulk-btn bulk-done"     onclick="applyBulkStatus('done','d1')">✓ Done</button>
      <button class="bulk-btn bulk-progress" onclick="applyBulkStatus('in-progress','d1')">⟳ In Progress</button>
      <button class="bulk-btn bulk-pending"  onclick="applyBulkStatus('','d1')">— Pending</button>
      <button class="bulk-btn bulk-na"       onclick="applyBulkStatus('na','d1')">N/A</button>
    </div>
    <button class="bulk-btn bulk-cancel" onclick="closeBulkPanel()" style="margin-left:auto;">✕ Cancel</button>
  </div>`;

  html += `<div class="checklist-table-wrap"><div class="cl-scroll"><table class="cl-table">`;

  // ── THEAD row 1 ──
  html += `<thead><tr>
    <th class="col-freeze-item" rowspan="2" style="min-width:44px;width:44px;">
      <span class="th-inner" style="display:flex;align-items:center;justify-content:center;">
        <input type="checkbox" id="select-all-cb" class="bulk-master-cb" onchange="toggleSelectAll(this)" title="Select all" />
      </span>
    </th>
    <th class="col-freeze-item2" rowspan="2"><span class="th-inner">Item</span></th>
    <th class="col-freeze-guide" rowspan="2"><span class="th-inner">Guide Questions</span></th>`;

  entries.forEach((e, i) => {
    const labelVal = buildEntryLabel(e, i);
    html += `<th colspan="${hasD5 ? 5 : 3}" class="entry-group-header" style="border-left:3px solid rgba(255,255,255,0.3);">
      <span class="th-inner" style="display:flex;align-items:center;gap:8px;justify-content:center;">
        <input type="text" id="entry-label-${i}" placeholder="Entry ${i+1}"
          value="${escHtml(labelVal)}"
          oninput="updateEntryLabel(${i},this.value)"
          style="font-size:13px;font-weight:600;padding:4px 12px;border:1px solid rgba(255,255,255,0.3);border-radius:6px;background:rgba(255,255,255,0.12);color:white;font-family:var(--font);text-align:center;min-width:160px;max-width:260px;" />
        ${i > 0 ? `<button onclick="removeEntry(${i})" title="Remove entry" style="background:rgba(239,68,68,0.25);border:1px solid rgba(239,68,68,0.4);color:#FCA5A5;border-radius:50%;width:20px;height:20px;font-size:11px;cursor:pointer;flex-shrink:0;">✕</button>` : ''}
      </span>
    </th>`;
  });

  html += `<th rowspan="2" style="vertical-align:bottom;padding-bottom:4px;background:var(--navy);">
    <span class="th-inner">
      <button class="btn-add-entry" onclick="addEntry()">+ Add entry</button>
    </span>
  </th>`;
  html += `</tr>`;

  // ── THEAD row 2: D-5 [☐] Status | D-1 [☐] Status | Notes (shared) ──
  html += `<tr class="sub-head">`;
  entries.forEach((e, i) => {
    const borderL = 'border-left:3px solid rgba(255,255,255,0.3)';
    html += `${hasD5 ? `
    <th class="sub-head sub-head-cb-col d5-zone" style="${borderL};">
      <span class="th-inner" style="display:flex;align-items:center;justify-content:center;padding:6px 2px;">
        <span class="sub-day-pill d5-pill">D-5</span>
      </span>
    </th>
    <th class="sub-head d5-zone sub-head-status-col">
      <span class="th-inner" style="display:block;padding:6px 10px;text-align:center;font-size:11px;font-weight:600;color:#DBEAFE;letter-spacing:.04em;text-transform:uppercase;">Status</span>
    </th>` : ''}
    <th class="sub-head sub-head-cb-col d1-zone" ${!hasD5 ? `style="${borderL};"` : ''}>
      <span class="th-inner" style="display:flex;align-items:center;justify-content:center;padding:6px 2px;">
        <span class="sub-day-pill d1-pill">D-1</span>
      </span>
    </th>
    <th class="sub-head d1-zone sub-head-status-col">
      <span class="th-inner" style="display:block;padding:6px 10px;text-align:center;font-size:11px;font-weight:600;color:#EDE9FE;letter-spacing:.04em;text-transform:uppercase;">Status</span>
    </th>
    <th class="sub-head sub-head-notes-col" style="background:var(--navy)!important;">
      <span class="th-inner" style="display:block;padding:6px 8px;text-align:center;font-size:11px;color:#BFDBFE;">Notes</span>
    </th>`;
  });
  html += `</tr></thead>`;

  // ── TBODY ──
  html += `<tbody>`;

  CHECKLIST_SECTIONS.forEach(sec => {
    const isOpen    = !collapsedCats[sec.id];
    const totalCols = 3 + entryCount * (hasD5 ? 4 : 2) + 1; // +1 for checkbox col, +1 for item name

    // Build per-entry D-5 (if applicable) and D-1 cat checkboxes plus a shared notes empty td
    let catEntryCells = '';
    for (let ei = 0; ei < entryCount; ei++) {
      const borderL = ei === 0 ? 'border-left:2px solid rgba(255,255,255,0.2)' : '';
      catEntryCells += `
        ${hasD5 ? `<td style="padding:4px 8px;text-align:center;background:var(--navy);${borderL}">
          <input type="checkbox" class="cat-d5-cb" data-cat-id="${sec.id}" data-entry-idx="${ei}"
            onchange="toggleCatD5(this,'${sec.id}',${ei})" title="Click to bulk-set D-5 status for this category"
            style="width:14px;height:14px;cursor:pointer;accent-color:#93C5FD;" />
        </td>
        <td style="padding:4px 6px;background:var(--navy);"></td>` : ''}
        <td style="padding:4px 8px;text-align:center;background:var(--navy);${!hasD5 ? borderL : ''}">
          <input type="checkbox" class="cat-d1-cb" data-cat-id="${sec.id}" data-entry-idx="${ei}"
            onchange="toggleCatD1(this,'${sec.id}',${ei})" title="Click to bulk-set D-1 status for this category"
            style="width:14px;height:14px;cursor:pointer;accent-color:#C4B5FD;" />
        </td>
        <td style="padding:4px 6px;background:var(--navy);"></td>
        <td style="background:var(--navy);"></td>`;
    }

    html += `<tr class="cat-header">
      <td style="padding:6px 8px;text-align:center;">
        <input type="checkbox" class="cat-cb bulk-cat-cb" data-cat-id="${sec.id}"
          onchange="toggleCatCheckboxes(this,'${sec.id}')" title="Select all rows in category" />
      </td>
      <td class="col-freeze-item2" colspan="1" onclick="toggleCat('${sec.id}')" style="cursor:pointer;">
        <span class="cat-toggle-arrow ${isOpen ? 'open' : ''}" id="arrow-${sec.id}">&#9658;</span>
        ${sec.title}
        <span style="font-weight:400;opacity:0.7;font-size:10px">(${sec.items.length})</span>
      </td>
      <td class="col-freeze-guide" onclick="toggleCat('${sec.id}')"></td>
      ${catEntryCells}
      <td></td>
    </tr>`;

    sec.items.forEach(item => {
      const displayStyle = isOpen ? '' : 'display:none';
      html += `<tr class="item-row" data-cat="${sec.id}" style="${displayStyle}">
        <td style="padding:6px 8px;text-align:center;background:var(--surface);">
          <input type="checkbox" class="row-cb" data-item-id="${item.id}" data-cat="${sec.id}" data-entry-idx="0" data-tab="d5"
            onchange="onRowCbChange()" />
        </td>
        <td class="col-freeze-item2" style="font-size:12px;font-weight:500;line-height:1.4">${item.name}</td>
        <td class="col-freeze-guide" style="font-size:11px;color:var(--text-muted);line-height:1.4">${item.guide}</td>`;

      entries.forEach((_, ei) => {
        const d5key  = ei === 0 ? item.id : `${item.id}_e${ei}`;
        const d5val  = (d5Data[d5key] || {}).status || '';
        const d1val  = (d1Data[d5key] || {}).status || '';
        const sharedNote = escHtml((d1Data[d5key] || {}).note || (d5Data[d5key] || {}).note || '');
        const borderL = ei === 0 ? 'border-left:2px solid var(--border-strong)' : '';

        html += `
        ${hasD5 ? `<td class="d5-cb-col" style="${borderL};">
          <input type="checkbox" class="row-cb" data-item-id="${item.id}" data-cat="${sec.id}" data-entry-idx="${ei}" data-tab="d5"
            onchange="onRowCbChange()" />
        </td>
        <td style="background:rgba(37,99,235,0.04);padding:4px 6px;">
          <select class="status-sel ${statusClass(d5val)}" id="sel-d5-${item.id}-${ei}" data-prev="${d5val}"
            onchange="handleStatusChange('${item.id}','d5',${ei},this)">
            ${item.type === 'yesno' ? yesNoOptions(d5val) : statusOptions(d5val)}
          </select>
        </td>` : ''}
        <td class="d1-cb-col" ${!hasD5 ? `style="${borderL};"` : ''}>
          <input type="checkbox" class="row-cb" data-item-id="${item.id}" data-cat="${sec.id}" data-entry-idx="${ei}" data-tab="d1"
            onchange="onRowCbChange()" />
        </td>
        <td style="background:rgba(124,58,237,0.04);padding:4px 6px;">
          <select class="status-sel ${statusClass(d1val)}" id="sel-d1-${item.id}-${ei}" data-prev="${d1val}"
            onchange="handleStatusChange('${item.id}','d1',${ei},this)">
            ${item.type === 'yesno' ? yesNoOptions(d1val) : statusOptions(d1val)}
          </select>
        </td>
        <td style="padding:4px 6px;">
          <input class="note-input" type="text" placeholder="Notes…" value="${sharedNote}" id="note-${item.id}-${ei}"
            oninput="handleNoteChange('${item.id}','d1',${ei},this.value)"
            onblur="saveChecklist()" />
        </td>`;
      });

      html += `<td></td></tr>`;
    });
  });

  html += `</tbody></table></div></div>`;
  container.innerHTML = html;

  // RSP & Kit Checking banner — per brand/platform/region entry, sitting
  // right above the table (same column order as the entry headers above).
  const bannerId = containerId === 'tl-checklist' ? 'tl-rspkit-banner' : 'user-rspkit-banner';
  renderEntryRspKitBanner(bannerId, entries);

  // Keep the second header row (D-5/D-1 Status, Notes) pinned directly under
  // the first header row regardless of actual rendered height, so the two
  // sticky rows never overlap when scrolling.
  requestAnimationFrame(() => {
    const headRow1 = container.querySelector('.cl-table thead tr:first-child');
    const subHeadCells = container.querySelectorAll('.cl-table thead tr.sub-head th');
    if (headRow1 && subHeadCells.length) {
      const h = headRow1.getBoundingClientRect().height;
      subHeadCells.forEach(th => { th.style.top = h + 'px'; });
    }
  });
}

// ── Status helpers ──
function statusOptions(current) {
  const opts = [
    { v: '',            l: 'Pending' },
    { v: 'done',        l: 'Done' },
    { v: 'in-progress', l: 'In Progress' },
    { v: 'na',          l: 'N/A' },
  ];
  return opts.map(o => `<option value="${o.v}" ${current === o.v ? 'selected' : ''}>${o.l}</option>`).join('');
}

// Options for a "yesno"-type item (e.g. "Joining the After Party?") — a
// plain Yes/No question rather than a task status.
function yesNoOptions(current) {
  const opts = [
    { v: '',    l: 'Select…' },
    { v: 'yes', l: 'Yes' },
    { v: 'no',  l: 'No' },
  ];
  return opts.map(o => `<option value="${o.v}" ${current === o.v ? 'selected' : ''}>${o.l}</option>`).join('');
}

function statusClass(status) {
  return {
    done: 's-done', 'in-progress': 's-progress', na: 's-na', '': 's-pending',
    yes: 's-done', no: 's-na', // "yesno" item answers reuse the done/na color treatment
  }[status] || 's-pending';
}

// Looks up a checklist item's definition by id across CHECKLIST_SECTIONS,
// so rendering/handler code can tell a normal item apart from a "yesno"
// item (e.g. "Joining the After Party?") without threading extra params
// through every call site.
function findChecklistItem(itemId) {
  for (const sec of CHECKLIST_SECTIONS) {
    const found = (sec.items || []).find(it => it.id === itemId);
    if (found) return found;
  }
  return null;
}

function handleStatusChange(itemId, tab, entryIndex, selectEl) {
  const status = selectEl.value;
  const item   = findChecklistItem(itemId);

  // "yesno"-type items (e.g. "Joining the After Party?") don't behave like
  // a normal task status: selecting "Yes" must first collect the after-party
  // start/end dates via a popup before anything is committed — those dates
  // become this entry's new checklist deadline and get written to Notes.
  // Selecting "No" is a plain completion sign, same as any other status.
  if (item && item.type === 'yesno' && status === 'yes') {
    openAfterPartyModal(itemId, tab, entryIndex, selectEl);
    return; // commit happens in confirmAfterPartyDates() if the user saves
  }

  selectEl.className = `status-sel ${statusClass(status)}`;
  selectEl.dataset.prev = status;
  ensurePath(tab);
  const key = entryIndex === 0 ? itemId : `${itemId}_e${entryIndex}`;
  userChecklist[selectedCampaignId][tab][key] = {
    ...(userChecklist[selectedCampaignId][tab][key] || {}), status
  };

  // Reverting a "yesno" item away from "Yes" (back to blank or "No") clears
  // any previously-set after-party override on this entry, so a stale date
  // range doesn't keep overriding the compliance deadline.
  if (item && item.type === 'yesno') {
    clearAfterPartyOverride(entryIndex);
  }

  updateUserProgress();
  saveChecklist();
}

// ─────────────────────────────────────────────────────────────
//  "JOINING THE AFTER PARTY?" — Yes/No popup for start/end dates
// ─────────────────────────────────────────────────────────────
// When a member answers "Yes", we need the after-party start/end dates
// before committing anything: those dates (a) become this entry's new
// checklist deadline for compliance purposes, and (b) get written into
// the Notes column right next to the Yes/No answer, on the same row.
let _apCtx = null; // { itemId, tab, entryIndex, selectEl, prevValue }

function openAfterPartyModal(itemId, tab, entryIndex, selectEl) {
  _apCtx = { itemId, tab, entryIndex, selectEl, prevValue: selectEl.dataset.prev || '' };

  const entries = getEntries();
  const entry   = entries[entryIndex] || {};
  document.getElementById('ap-start').value = entry.afterPartyStart || '';
  document.getElementById('ap-end').value   = entry.afterPartyEnd   || '';
  const errEl = document.getElementById('ap-modal-error');
  if (errEl) errEl.style.display = 'none';

  document.getElementById('after-party-overlay').style.display = 'flex';
}

// `arg` is either a bare boolean (true = revert the select, called from the
// Cancel button) or a click event (backdrop click — only closes/reverts if
// the click was directly on the overlay, not inside the modal card).
function closeAfterPartyModal(arg) {
  if (arg && arg.target) {
    if (arg.target !== document.getElementById('after-party-overlay')) return;
  }
  document.getElementById('after-party-overlay').style.display = 'none';
  const shouldRevert = arg === true || (arg && arg.target);
  if (shouldRevert && _apCtx && _apCtx.selectEl) {
    _apCtx.selectEl.value = _apCtx.prevValue;
    _apCtx.selectEl.className = `status-sel ${statusClass(_apCtx.prevValue)}`;
  }
  _apCtx = null;
}

function confirmAfterPartyDates() {
  if (!_apCtx) return;
  const startVal = document.getElementById('ap-start').value;
  const endVal   = document.getElementById('ap-end').value;
  const errEl    = document.getElementById('ap-modal-error');

  if (!startVal || !endVal) {
    if (errEl) { errEl.textContent = 'Please enter both a start and end date.'; errEl.style.display = 'block'; }
    return;
  }
  if (new Date(endVal) < new Date(startVal)) {
    if (errEl) { errEl.textContent = 'End date can\'t be before the start date.'; errEl.style.display = 'block'; }
    return;
  }

  const { itemId, tab, entryIndex, selectEl } = _apCtx;

  // Commit the "Yes" status now that we have dates.
  selectEl.value = 'yes';
  selectEl.className = `status-sel ${statusClass('yes')}`;
  selectEl.dataset.prev = 'yes';
  ensurePath(tab);
  const key = entryIndex === 0 ? itemId : `${itemId}_e${entryIndex}`;
  userChecklist[selectedCampaignId][tab][key] = {
    ...(userChecklist[selectedCampaignId][tab][key] || {}), status: 'yes'
  };

  // Store the dates on the entry itself — this is what the admin dashboard
  // reads to override this entry's compliance deadline (see the
  // afterPartyDeadline lookup in loadAdminDashboardCache / getEntryBreakdown).
  ensureEntries();
  const entry = userChecklist[selectedCampaignId].entries[entryIndex];
  entry.afterPartyStart = startVal;
  entry.afterPartyEnd   = endVal;

  // Surface the dates in the Notes column, right beside the Yes/No answer,
  // same row, same entry.
  const fmtApDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB') : '';
  const noteText = `After Party: ${fmtApDate(startVal)} – ${fmtApDate(endVal)}`;
  handleNoteChange(itemId, 'd1', entryIndex, noteText);
  const noteInput = document.getElementById(`note-${itemId}-${entryIndex}`);
  if (noteInput) noteInput.value = noteText;

  closeAfterPartyModal(false);
  updateUserProgress();
  saveChecklist();
}

// Clears a previously-set after-party date override on one entry (called
// when the "yesno" answer is changed away from "Yes").
function clearAfterPartyOverride(entryIndex) {
  ensureEntries();
  const entry = userChecklist[selectedCampaignId].entries[entryIndex];
  if (entry) { delete entry.afterPartyStart; delete entry.afterPartyEnd; }
}

function handleNoteChange(itemId, tab, entryIndex, note) {
  ensurePath(tab);
  const key = entryIndex === 0 ? itemId : `${itemId}_e${entryIndex}`;
  userChecklist[selectedCampaignId][tab][key] = {
    ...(userChecklist[selectedCampaignId][tab][key] || {}), note
  };
}

function ensurePath(tab) {
  if (!userChecklist[selectedCampaignId])        userChecklist[selectedCampaignId] = {};
  if (!userChecklist[selectedCampaignId][tab])   userChecklist[selectedCampaignId][tab] = {};
}

function updateUserProgress() {
  const isTl     = currentUser?.role === 'team_lead';
  const uiPrefix = isTl ? 'tl' : 'user';
  const campSrc  = isTl ? tlOwnCampaigns : campaigns;

  // Use the size of whatever template is actually loaded for this campaign
  // (loadChecklistOverrides may have swapped in a non-default template) —
  // never the hardcoded default TOTAL_ITEMS, or a campaign with fewer/more
  // items than default will show a wrong percentage even at 100% done.
  const ti  = getTotalItems();
  // Only count items that actually exist in the CURRENT template. If a
  // template was ever edited down, leftover "done" flags for items that no
  // longer exist would otherwise inflate the count past the total (e.g.
  // showing 67/62 instead of capping at the real total).
  const ids = getCurrentValidItemIds();

  const campData = userChecklist[selectedCampaignId] || {};
  const hasD5    = getHasD5();
  const d5Done   = hasD5 ? countDone(campData.d5 || {}, ids) : 0;
  const d1Done   = countDone(campData.d1 || {}, ids);
  const entries  = getEntries();
  // Overall completion is based on D-1 inputs alone for every user — Done
  // and N/A are treated the same, and D-5 (when present) is informational
  // only and never factors into the overall percentage.
  const done     = d1Done;
  const total    = ti * entries.length;
  const pct      = total > 0 ? Math.round((done / total) * 100) : 0;
  const d5Pct    = hasD5 && (ti * entries.length) > 0 ? Math.round((d5Done / (ti * entries.length)) * 100) : 0;
  const d1Pct    = (ti * entries.length) > 0 ? Math.round((d1Done / (ti * entries.length)) * 100) : 0;

  // Inline progress banner above checklist
  const banner = document.getElementById(`${uiPrefix}-progress-banner`);
  if (banner) {
    const color = pct === 100 ? '#059669' : pct >= 50 ? '#D97706' : '#2563EB';
    const emoji = pct === 100 ? '🎉' : pct >= 50 ? '🔥' : '📋';

    // No per-entry breakdown list here — that detail already lives in the
    // Overview tab's "Breakdown by Campaign" section, so showing it again
    // above the checklist table itself was a duplicate. This banner stays
    // a quick at-a-glance summary; the table below it is the real checklist.
    banner.style.display = 'block';
    banner.innerHTML = `
      <div class="user-prog-banner">
        <div class="user-prog-banner-top">
          <span class="user-prog-emoji">${emoji}</span>
          <span class="user-prog-title">${escHtml(campSrc[selectedCampaignId]?.name || '')}</span>
          <span class="user-prog-pct" style="color:${color};">${pct}%</span>
        </div>
        <div class="user-prog-bar-track"><div class="user-prog-bar-fill" style="width:${pct}%;background:${color};"></div></div>
        <div class="user-prog-detail">
          ${hasD5 ? `<span>D-5: ${d5Done}/${ti * entries.length} (${d5Pct}%)</span>` : ''}
          <span>D-1: ${d1Done}/${ti * entries.length} (${d1Pct}%)</span>
          <span>${done} / ${total} items complete</span>
        </div>
        <div id="${uiPrefix}-kitrsp-mini" class="user-prog-detail" style="display:none;margin-top:4px;"></div>
      </div>`;
  }

  // Legacy progress bar (sidebar)
  const legacyLabel = document.getElementById(`${uiPrefix}-progress-label`);
  const legacyPct   = document.getElementById(`${uiPrefix}-progress-pct`);
  const legacyFill  = document.getElementById(`${uiPrefix}-progress-fill`);
  if (legacyLabel) legacyLabel.textContent = `${done} / ${total} items complete`;
  if (legacyPct)   legacyPct.textContent   = `${pct}%`;
  if (legacyFill)  legacyFill.style.width  = `${pct}%`;
  // Update sidebar
  updateUserSidebarProgress();
}

let saveTimer = null;
function saveChecklist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!currentUser || !selectedCampaignId) return;
    const saveData = { ...userChecklist };
    if (!saveData[selectedCampaignId]) saveData[selectedCampaignId] = {};
    saveData[selectedCampaignId].lastActive = new Date().toISOString();

    // Record startedAt on the very first save for this campaign
    if (!saveData[selectedCampaignId].startedAt) {
      saveData[selectedCampaignId].startedAt = new Date().toISOString();
    }

    // Record completedAt if just hit 100% (based on D-1 inputs alone —
    // Done and N/A are treated the same, for every user).
    const campData   = saveData[selectedCampaignId];
    const validIds   = getCurrentValidItemIds();
    const d1Done     = countDone(campData.d1 || {}, validIds);
    const entries    = (campData.entries || [{ brand:'',platform:'',region:'' }]);
    const totalItems = getTotalItems() * entries.length;
    const isNowComplete = totalItems > 0 && d1Done >= totalItems;
    if (isNowComplete && !campData.completedAt) {
      saveData[selectedCampaignId].completedAt = new Date().toISOString();
    }

    await db.collection('checklists').doc(currentUser.uid).set(saveData, { merge: true });
  }, 800);
}

// ─────────────────────────────────────────────────────────────
//  ══════════════ CAMPAIGN CALENDAR ══════════════
// ─────────────────────────────────────────────────────────────
// Shared entries: /settings/calendar  → { entries: [...] }
// Personal entries: /calendarPersonal/{uid} → { entries: [...] }
//
// Shared entry: { id, title, date, endDate, type, campaignId, description, color, createdBy, assignedUids }
//   assignedUids: [] means visible to ALL assigned members; non-empty means only those UIDs + admin
// Personal entry: { id, title, date, endDate, type, description, color }

const CAL_ENTRY_TYPES = [
  { id: 'teasing',      label: 'Teasing',       color: '#7C3AED' },
  { id: 'dday',         label: 'D-Day',         color: '#DC2626' },
  { id: 'deadline',     label: 'Deadline',      color: '#D97706' },
  { id: 'meeting',      label: 'Meeting',       color: '#2563EB' },
  { id: 'payday_sale',  label: 'PayDay Sale',   color: '#059669' },
  { id: 'midmonth_sale',label: 'Mid-Month Sale',color: '#DB2777' },
  { id: 'other',        label: 'Other',         color: '#64748B' },
];

// ── Direction A: campaign phase drives the colour, region is a badge ──
// Campaign phases group the many per-region sale events into the 3 buckets
// the team actually plans around. `match` lets us auto-classify existing
// entries whose phase lives only in the title text (e.g. "PayDay Sale").
const CAL_CAMPAIGN_TYPES = [
  { id: 'double_digit', label: 'Double Digit', color: '#7C3AED', match: /\b(\d{1,2})\.\1\b|double\s*digit/i },
  { id: 'mid_month',    label: 'Mid-Month',    color: '#DB2777', match: /mid[-\s]?month|sulit/i },
  { id: 'payday',       label: 'PayDay',       color: '#059669', match: /pay[-\s]?day|sweldo/i },
  { id: 'other',        label: 'Other',        color: '#64748B', match: null },
];

// Regions carry their own badge colour so "which market" is scannable at a
// glance. Keys are the bracket codes already used in event titles.
// Per-region only — combined codes (SGTH, SGMYTH) were removed so calendar
// filtering and per-region deadline matching stay exact. Always add a separate
// event per market. (_expandRegionCode still splits any legacy combined code
// that lingers in old data, so historical events don't break.)
const CAL_REGIONS = [
  { id: 'MY',    label: 'MY',    color: '#2563EB' },
  { id: 'PH',    label: 'PH',    color: '#D97706' },
  { id: 'VN',    label: 'VN',    color: '#059669' },
  { id: 'TH',    label: 'TH',    color: '#0891B2' },
  { id: 'SG',    label: 'SG',    color: '#DB2777' },
  { id: 'LAZ',   label: 'LAZ',   color: '#EA580C' },
];
const CAL_REGION_MAP = Object.fromEntries(CAL_REGIONS.map(r => [r.id, r]));

// Normalise a region string from an uploaded sheet to a canonical CAL_REGIONS
// code, so checklist entry regions always match the keys used by the
// per-region deadline map. Without this, "Singapore" / "sg" / "SG " would each
// become a distinct key and silently fail the deadline join. Returns the
// canonical code (e.g. "SG") or '' if unrecognised, so the caller can flag it.
const _REGION_ALIASES = {
  SG: 'SG', SGP: 'SG', SINGAPORE: 'SG',
  MY: 'MY', MYS: 'MY', MALAYSIA: 'MY',
  PH: 'PH', PHL: 'PH', PHILIPPINES: 'PH', PILIPINAS: 'PH',
  VN: 'VN', VNM: 'VN', VIETNAM: 'VN', 'VIET NAM': 'VN',
  TH: 'TH', THA: 'TH', THAILAND: 'TH',
  LAZ: 'LAZ', LAZADA: 'LAZ',
};
function _normalizeRegionCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  if (CAL_REGION_MAP[s]) return s;          // already a canonical code
  if (_REGION_ALIASES[s]) return _REGION_ALIASES[s];
  return '';                                 // unknown → let caller flag it
}

// ── Platforms ────────────────────────────────────────────────────────────
// Platform is its own dimension, separate from region. Existing entries
// encode it in the title ("LAZ Mid-Month Sale", "SHP PayDay Sale"), and
// "LAZ" was historically even offered as a *region* — so `match` lets us
// infer the platform from legacy titles with no migration step. New entries
// set `platform` explicitly via the entry form.
const CAL_PLATFORMS = [
  { id: 'lazada',  label: 'Lazada',  short: 'LAZ', color: '#EA580C', match: /\b(laz(ada)?)\b/i },
  { id: 'shopee',  label: 'Shopee',  short: 'SHP', color: '#EF4444', match: /\b(shp|shopee)\b/i },
  { id: 'tiktok',  label: 'TikTok',  short: 'TT',  color: '#0F172A', match: /\b(tt|tik(\s*tok)?|tiktok)\b/i },
];
const CAL_PLATFORM_MAP = Object.fromEntries(CAL_PLATFORMS.map(p => [p.id, p]));

// Normalise a free-text platform (from a checklist entry or an uploaded sheet:
// "Shopee", "SHP", "shopee", "lazada") to a canonical CAL_PLATFORMS id
// ("shopee", "lazada", "tiktok"). Returns '' when it doesn't map to a calendar
// platform (e.g. "Zalora", which has no calendar D-Day dimension) so callers
// can fall back to the region-wide deadline or prompt the admin. This mirrors
// _normalizeRegionCode so the composite region|platform deadline keys always
// join cleanly regardless of how the platform was spelled upstream.
function _normalizePlatformCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const lc = s.toLowerCase();
  if (CAL_PLATFORM_MAP[lc]) return lc;                 // already a canonical id
  const byShort = CAL_PLATFORMS.find(p => p.short.toLowerCase() === lc);
  if (byShort) return byShort.id;
  const byMatch = CAL_PLATFORMS.find(p => p.match.test(s));
  return byMatch ? byMatch.id : '';                    // unknown → caller decides
}

// Build the composite key used by the deadline map + reporting lookup so a
// region's platforms can carry DIFFERENT deadlines. Region-only entries (no
// platform) use the bare region code as their key, preserved as a fallback.
function _deadlineKey(region, platformId) {
  const r = String(region || '').toUpperCase();
  return platformId ? `${r}|${platformId}` : r;
}

// Resolve an entry's platform: explicit field wins, else infer from the
// title so pre-existing events light up correctly straight away. Legacy
// entries that used region="LAZ" are also caught here.
function _calPlatformOf(entry) {
  if (!entry) return null;
  if (entry.platform) return CAL_PLATFORM_MAP[entry.platform] || null;
  // Legacy: platform smuggled into the region field (region === 'LAZ').
  const legacyRegion = (entry.region || '').toUpperCase();
  const byRegion = CAL_PLATFORMS.find(p => p.short === legacyRegion);
  if (byRegion) return byRegion;
  const t = entry.title || '';
  return CAL_PLATFORMS.find(p => p.match.test(t)) || null;
}

// Pull a leading "[MY]" / "{MY}" style bracket code out of a title, so legacy
// entries migrate without re-entry. Returns { region, cleanTitle }.
function _calExtractRegion(title) {
  if (!title) return { region: '', cleanTitle: '' };
  const m = title.match(/^\s*[\[\{]\s*([A-Za-z]{2,7})\s*[\]\}]\s*(.*)$/);
  if (m && CAL_REGION_MAP[m[1].toUpperCase()]) {
    return { region: m[1].toUpperCase(), cleanTitle: m[2].trim() };
  }
  return { region: '', cleanTitle: title };
}

// Resolve an entry's campaign phase: explicit field wins, else infer from
// title text so existing data colours correctly with no migration step.
function _calCampaignType(entry) {
  if (entry.campaignType) {
    return CAL_CAMPAIGN_TYPES.find(c => c.id === entry.campaignType) || CAL_CAMPAIGN_TYPES[3];
  }
  const t = entry.title || '';
  for (const c of CAL_CAMPAIGN_TYPES) {
    if (c.match && c.match.test(t)) return c;
  }
  return CAL_CAMPAIGN_TYPES[3];
}

// The region for an entry: explicit field wins, else parse the title prefix.
function _calRegionOf(entry) {
  if (entry.region) return CAL_REGION_MAP[entry.region] || null;
  const { region } = _calExtractRegion(entry.title);
  return region ? CAL_REGION_MAP[region] : null;
}

// Title with any region prefix stripped, so the badge doesn't duplicate it.
function _calCleanTitle(entry) {
  if (entry.region) return entry.title || '';
  return _calExtractRegion(entry.title).cleanTitle || entry.title || '';
}

// Active filters for the calendar header (empty = show all).
let calFilterRegion   = '';
let calFilterCampaign = '';
let calFilterPlatform = '';
function calSetRegionFilter(v)   { calFilterRegion = v;   renderCalendarView(getCalTarget()); }
function calSetCampaignFilter(v) { calFilterCampaign = v; renderCalendarView(getCalTarget()); }
function calSetPlatformFilter(v) { calFilterPlatform = v; renderCalendarView(getCalTarget()); }

let calCurrentMonth = new Date().getMonth();
let calCurrentYear  = new Date().getFullYear();
let calEditingEntry = null; // { entry, isPersonal }

// entry.recurrence: null | { freq: 'daily'|'weekly'|'monthly', until: 'YYYY-MM-DD'|null }
// Expands a (possibly recurring) entry into concrete { start, end } Date occurrences
// that overlap the given [rangeStart, rangeEnd] window. Non-recurring entries just
// return their single occurrence if it overlaps.
function _calRecurrenceOccurrences(entry, rangeStart, rangeEnd) {
  const results = [];
  if (!entry.date) return results;
  const baseStart = new Date(`${entry.date}T00:00:00`);
  const baseEnd   = new Date(`${entry.endDate || entry.date}T00:00:00`);
  if (isNaN(baseStart) || isNaN(baseEnd)) return results;
  const durationDays = Math.round((baseEnd - baseStart) / 86400000);
  const freq  = entry.recurrence && entry.recurrence.freq;

  if (!freq || freq === 'none') {
    if (baseEnd >= rangeStart && baseStart <= rangeEnd) results.push({ start: baseStart, end: baseEnd });
    return results;
  }

  const until = entry.recurrence.until ? new Date(`${entry.recurrence.until}T00:00:00`) : null;
  // Occurrence dates (YYYY-MM-DD) that have been detached from the series —
  // either edited into their own standalone entry or deleted for that date
  // only. Skipped during expansion so the series shows a gap there.
  const exceptions = new Set(entry.recurrence.exceptions || []);
  const pad = n => String(n).padStart(2, '0');
  let cursor = new Date(baseStart);
  const maxOccurrences = 3660; // generous cap (~10yrs daily) to avoid runaway loops
  let n = 0;

  while (n < maxOccurrences) {
    n++;
    if (until && cursor > until) break;
    if (cursor > rangeEnd) break;
    const cursorISO = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
    const occEnd = new Date(cursor.getTime() + durationDays * 86400000);
    if (occEnd >= rangeStart && !exceptions.has(cursorISO)) {
      results.push({ start: new Date(cursor), end: occEnd });
    }
    if (freq === 'daily')        cursor.setDate(cursor.getDate() + 1);
    else if (freq === 'weekly')  cursor.setDate(cursor.getDate() + 7);
    else if (freq === 'monthly') cursor.setMonth(cursor.getMonth() + 1);
    else break;
  }
  return results;
}

function _calRecurrenceLabel(entry) {
  const freq = entry.recurrence && entry.recurrence.freq;
  if (!freq || freq === 'none') return '';
  return { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[freq] || '';
}

async function loadCalendarEntries() {
  try {
    const doc = await db.collection('settings').doc('calendar').get();
    calendarEntries = doc.exists ? (doc.data().entries || []) : [];
  } catch(e) { calendarEntries = []; }
  // Repair any events still stored in the old 12-hour "hh:mm AM/PM" time
  // format (which made derived deadlines 4h off). Idempotent + best-effort.
  try { _migrateLegacyCalTimes(); } catch(_) {}
}

async function loadPersonalCalendarEntries(uid) {
  try {
    const doc = await db.collection('calendarPersonal').doc(uid).get();
    personalCalendarEntries = doc.exists ? (doc.data().entries || []) : [];
  } catch(e) { personalCalendarEntries = []; }
}

async function saveCalendarEntries() {
  await db.collection('settings').doc('calendar').set({ entries: calendarEntries });
}

// ── Region roster (Option 2 full-auto): a persisted copy of the last
// bulk-assign upload, kept as flat rows so any region filter can slice it.
// Row shape mirrors bulkAssignMatched entries: { uid, brand, platform, region }.
let campaignRoster = []; // [{ uid, brand, platform, region }]
async function loadCampaignRoster() {
  try {
    const doc = await db.collection('settings').doc('roster').get();
    campaignRoster = doc.exists ? (doc.data().rows || []) : [];
  } catch(e) { campaignRoster = []; }
}
async function saveCampaignRoster() {
  await db.collection('settings').doc('roster').set({
    rows: campaignRoster,
    updatedAt: new Date().toISOString(),
  });
}
// Flatten a { uid: [entries] } match map into roster rows and persist, merging
// with any existing rows (last upload wins per uid+brand+platform+region).
async function _persistRosterFromMatched(matched) {
  const rows = [];
  Object.entries(matched || {}).forEach(([uid, entries]) => {
    (entries || []).forEach(en => rows.push({
      uid, brand: en.brand || '', platform: en.platform || '', region: en.region || '',
    }));
  });
  // Merge: drop old rows for any uid present in this upload, then add fresh.
  const touchedUids = new Set(rows.map(r => r.uid));
  campaignRoster = [
    ...campaignRoster.filter(r => !touchedUids.has(r.uid)),
    ...rows,
  ];
  try { await saveCampaignRoster(); } catch(e) { console.error('roster save failed', e); }
}
// Some calendar events use a COMBINED region code covering several markets
// (e.g. "SGTH" = SG + TH, "SGMYTH" = SG + MY + TH), while the roster sheet
// lists members under plain single-market codes (SG, TH, MY). Expand a
// region id into the set of single-market codes it represents so roster
// matching bridges the two. A plain code expands to just itself.
const _SINGLE_MARKET_CODES = ['PH', 'MY', 'VN', 'TH', 'SG'];
function _expandRegionCode(regionId) {
  if (!regionId) return [];
  const id = regionId.toUpperCase();
  // Known single-market code → itself.
  if (_SINGLE_MARKET_CODES.includes(id)) return [id];
  // Combined code → every single-market code whose letters appear in it,
  // in order, so "SGTH" → [SG, TH] and "SGMYTH" → [SG, MY, TH]. LAZ and any
  // other non-market codes fall through to matching on the code as-is.
  const parts = [];
  let rest = id;
  // Greedily peel two-letter market codes off the front.
  while (rest.length >= 2) {
    const head = rest.slice(0, 2);
    if (_SINGLE_MARKET_CODES.includes(head)) { parts.push(head); rest = rest.slice(2); }
    else break;
  }
  return (parts.length && rest.length === 0) ? parts : [id];
}

// Slice the roster for one region (and optionally one platform) →
// { uid: [{label,brand,platform,region}] }, matching the shape
// confirmBulkAssign already knows how to consume.
// A combined region (SGTH) matches roster rows for any of its markets (SG, TH).
// When platformId is given, only that platform's rows are included, so a
// Lazada checklist doesn't pull in Shopee brands.
function rosterForRegion(regionId, platformId) {
  const out = {};
  const wanted = new Set(_expandRegionCode(regionId));
  const plat   = platformId ? CAL_PLATFORM_MAP[platformId] : null;
  campaignRoster
    .filter(r => !regionId || wanted.has((r.region || '').toUpperCase()))
    .filter(r => {
      if (!plat) return true; // no platform scope → all platforms
      const rp = (r.platform || '').trim();
      if (!rp) return false;
      // Roster platform strings vary ("LAZ", "Lazada", "lazada") — match on
      // the platform's own pattern so all spellings land correctly.
      return plat.match.test(rp) || rp.toUpperCase() === plat.short;
    })
    .forEach(r => {
      if (!out[r.uid]) out[r.uid] = [];
      const label = [r.brand, r.platform, r.region].filter(Boolean).join('_');
      if (!out[r.uid].some(e => e.brand === r.brand && e.platform === r.platform && e.region === r.region)) {
        out[r.uid].push({ label, brand: r.brand, platform: r.platform, region: r.region });
      }
    });
  return out;
}

// Derive a checklist deadline from a D-Day datetime string: D-Day minus 4
// hours, in the SAME local clock as the D-Day (no timezone conversion, so
// deadlines stay fair across markets). Returns a "YYYY-MM-DDTHH:mm" string,
// or null when the D-Day has no time component (date-only) or is missing.
// The 4-hour offset is the default; the campaign's `deadline` field remains
// editable afterward.
const DEADLINE_OFFSET_HOURS = 4;
function _deadlineFromDday(ddayStr) {
  if (!ddayStr || !ddayStr.includes('T')) return null; // need a time to subtract from
  const [datePart, timePart] = ddayStr.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi]    = timePart.slice(0, 5).split(':').map(Number);
  // Build in local time and subtract the offset; Date handles day/month
  // rollover (e.g. 02:00 − 4h → previous day 22:00) automatically.
  const dt = new Date(y, mo - 1, d, h, mi);
  dt.setHours(dt.getHours() - DEADLINE_OFFSET_HOURS);
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

// ── Per-region deadline map from the calendar ─────────────────────────────
// For one month + campaign type, return { REGION: deadlineISO } read straight
// from the admin's calendar. Each region's deadline is:
//   1. an explicit Deadline-type event for that region, if present; else
//   2. that region's D-Day event time minus 4h (DEADLINE_OFFSET_HOURS); else
//   3. a phase-tagged event whose Milestone was left as the default "Other"
//      (e.g. a "Mid-Month Sale" event that only has Campaign/Region/Platform
//      set) — treated the same as #2, since in practice admins often tag
//      region+platform on the sale event itself without switching Milestone
//      to D-Day/Deadline.
// This is the single source of truth reporting compares against, so the admin
// only ever maintains the calendar. One generation covers every region; each
// region is then judged against its own deadline (see renderAdminView).
// Normalise the two phase vocabularies to one canonical token so they can be
// compared regardless of which convention filled the calendar:
//   entry-form / classifier:  mid_month | payday | double_digit
//   legacy sale event types:  midmonth_sale | payday_sale
// Returns null for anything with no phase (dday, deadline, meeting, other…),
// which the caller treats as "don't use this to decide the match".
function _canonicalPhase(id) {
  switch (id) {
    case 'mid_month':
    case 'midmonth_sale': return 'mid';
    case 'payday':
    case 'payday_sale':   return 'payday';
    case 'double_digit':  return 'dd';
    default:              return null;
  }
}

function buildRegionDeadlineMap({ year, month, campaignType }) {
  // Compare dates as plain "YYYY-MM-DD" strings, NOT Date objects. Building
  // `new Date(year, month, 1)` (local midnight) and comparing it to
  // `new Date("2026-07-31")` (parsed as UTC midnight) mixes two clocks, so in
  // any timezone east of UTC the last day of the month was judged "after"
  // month-end and silently dropped — that region then got no deadline. String
  // bounds are timezone-independent and inclusive on both ends.
  const pad = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, month + 1, 0).getDate();
  const monthStartStr = `${year}-${pad(month + 1)}-01`;
  const monthEndStr   = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
  const _dt = e => e.startTime ? `${e.date}T${e.startTime}` : e.date;

  // Collect the best D-Day / explicit Deadline event PER region+platform, so a
  // region whose platforms launch on different days (e.g. MY-Shopee on Jul 19
  // vs MY-Lazada on Jul 24) yields a distinct deadline for each — the calendar,
  // not the region, becomes the source of truth. A region-only bucket (bare
  // region code, no platform) is kept alongside so events without a platform
  // tag still resolve, and so a checklist entry whose platform has no dated
  // event can fall back to the region-wide date.
  const perKey = {}; // { "MY|shopee": { dday, deadline }, "MY": {...}, ... }
  calendarEntries.forEach(e => {
    if (!e.date) return;
    const dateStr = String(e.date).slice(0, 10); // normalise to YYYY-MM-DD
    if (dateStr < monthStartStr || dateStr > monthEndStr) return;
    // Match the campaign phase when one was requested. Two vocabularies are in
    // play: the phase classifier (mid_month/payday/double_digit, used by the
    // entry form's campaignType field + _calCampaignType) and the raw event
    // type (midmonth_sale/payday_sale, used on legacy sale events). D-Day and
    // Deadline events carry the phase on their campaignType field, not their
    // type, so we normalise BOTH the request and the event to a canonical
    // phase before comparing — otherwise a phase filter would wrongly exclude
    // the very dday/deadline events it needs.
    if (campaignType) {
      const want = _canonicalPhase(campaignType);
      const got  = _canonicalPhase(_calCampaignType(e).id) || _canonicalPhase(e.type);
      if (want && got && want !== got) return;
      // If either side can't be canonicalised, fall back to the old loose
      // check so nothing that used to match stops matching.
      if ((!want || !got) && _calCampaignType(e).id !== campaignType && e.type !== campaignType) return;
    }
    const r = _calRegionOf(e);
    if (!r) return;
    const region = r.id;
    // Platform is optional. When present, the event feeds ONLY that region's
    // platform-specific bucket. When absent, it feeds the region-wide bucket
    // (which every platform in that region can fall back to).
    const p = _calPlatformOf(e);
    const platformId = p ? p.id : '';
    const key = _deadlineKey(region, platformId);

    const bump = (k) => {
      perKey[k] = perKey[k] || { dday: null, deadline: null, fallback: null };
      if (e.type === 'deadline') {
        const iso = _dt(e);
        if (!perKey[k].deadline || iso < perKey[k].deadline) perKey[k].deadline = iso;
      } else if (e.type === 'dday') {
        const iso = _dt(e);
        if (!perKey[k].dday || iso < perKey[k].dday) perKey[k].dday = iso;
      } else if ((e.type === 'other' || !e.type) && _canonicalPhase(_calCampaignType(e).id)) {
        // The event's Milestone dropdown was left on its default ("Other")
        // but its Campaign dropdown carries a real phase (Mid-Month/PayDay/
        // Double Digit) — e.g. a "Mid-Month Sale" event the admin tagged with
        // region + platform but never switched to D-Day/Deadline. Treat it as
        // an implicit D-Day so the deadline map isn't blind to it just because
        // a second dropdown wasn't touched. Explicit dday/deadline events
        // above still take priority whenever they exist for the same key.
        const iso = _dt(e);
        if (!perKey[k].fallback || iso < perKey[k].fallback) perKey[k].fallback = iso;
      }
    };
    bump(key);
    // A platform-tagged event ALSO contributes to the region-wide fallback
    // (earliest across platforms), so a region key always exists whenever any
    // event for that region does. This keeps region-less checklist rows and
    // unknown-platform rows (e.g. Zalora) resolvable.
    if (platformId) bump(region);
  });

  const out = {};
  Object.entries(perKey).forEach(([key, v]) => {
    const deadline = v.deadline || _deadlineFromDday(v.dday) || _deadlineFromDday(v.fallback);
    if (deadline) out[key] = deadline;
  });
  // Shape: { "MY|shopee": "2026-07-19T16:00", "MY|lazada": "2026-07-24T16:00",
  //          "MY": "2026-07-19T16:00" (region-wide fallback), ... }
  return out;
}

// ── Upcoming campaign alert ─────────────────────────────────────────────
// Warns the admin when a campaign phase is coming up soon on the calendar
// (any Teasing/D-Day/Deadline/Other event tagged with a Campaign phase) but
// no campaign/checklist has been created for it yet. Reuses the same phase
// vocabulary and calendar-reading helpers as the deadline map above, so a
// phase+month is judged identically here and in the New Campaign preview.

// How many days out to start warning about an approaching, checklist-less
// campaign phase.
const CAMPAIGN_ALERT_LOOKAHEAD_DAYS = 14;

// Map a canonical phase token (mid/payday/dd, from _canonicalPhase) back to
// the <select> value + display label used by the New Campaign calendar
// controls and the entry-form Campaign dropdown.
const _CANON_PHASE_INFO = {
  mid:    { uiValue: 'mid_month',    label: 'Mid-Month'    },
  payday: { uiValue: 'payday',       label: 'PayDay'       },
  dd:     { uiValue: 'double_digit', label: 'Double Digit' },
};

// Best-effort: does an existing campaign already "cover" this phase+month?
// Checked in order of confidence:
//   1. an explicit campaignType on the campaign doc (set by New Campaign's
//      Per-Region Deadlines from Calendar picker — see createCampaign());
//   2. phase/month/year parsed out of the campaign name, the same best-effort
//      parse the calendar-mapping preview already falls back to;
//   3. if neither side can tell us a phase at all, a loose month-only match
//      on the campaign's own dates, so a completely untagged/untitled
//      campaign still isn't re-flagged.
// This deliberately leans toward NOT alerting when unsure — a missed
// reminder is noticed a day later on the calendar; a false alarm on every
// dashboard load just trains admins to ignore the banner.
function _campaignCoversPhaseMonth(camp, phase, year, month) {
  if (!camp) return false;
  const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;

  const inferred  = inferGenScopeFromName(camp.name);
  const campPhase = _canonicalPhase(camp.campaignType) || _canonicalPhase(inferred.campaignType);

  const dates = [camp.dday, camp.deadline, ...Object.values(camp.regionDeadlines || {})]
    .filter(Boolean)
    .map(d => String(d).slice(0, 7));
  const nameMonthStr = (inferred.year != null && inferred.month != null)
    ? `${inferred.year}-${String(inferred.month + 1).padStart(2, '0')}`
    : null;
  const monthMatches = dates.includes(monthStr) || nameMonthStr === monthStr;

  if (campPhase) return campPhase === phase && monthMatches;
  return monthMatches;
}

// Scan the calendar for phase-tagged events within the lookahead window,
// bucket them into one alert per phase+month (so 5 "MY/PH/VN Mid-Month"
// events collapse into a single "Mid-Month — August" alert), and drop any
// bucket an existing campaign already covers.
function getUpcomingCampaignAlerts(lookaheadDays = CAMPAIGN_ALERT_LOOKAHEAD_DAYS) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + lookaheadDays);

  const groups = {}; // "phase|year|month" -> { phase, year, month, earliest, regions:Set }
  calendarEntries.forEach(e => {
    if (!e.date) return;
    const phase = _canonicalPhase(_calCampaignType(e).id);
    if (!phase) return; // no Campaign phase tagged on this event at all
    const d = new Date(String(e.date).slice(0, 10));
    if (isNaN(d) || d < today || d > horizon) return;

    const year = d.getFullYear(), month = d.getMonth();
    const key = `${phase}|${year}|${month}`;
    const r = _calRegionOf(e);
    groups[key] = groups[key] || { phase, year, month, earliest: d, regions: new Set() };
    if (d < groups[key].earliest) groups[key].earliest = d;
    if (r) groups[key].regions.add(r.label || r.id);
  });

  const campList = Object.values(campaigns);
  return Object.values(groups)
    .filter(g => !campList.some(c => _campaignCoversPhaseMonth(c, g.phase, g.year, g.month)))
    .map(g => ({ ...g, regions: [...g.regions].sort(), daysUntil: Math.round((g.earliest - today) / 86400000) }))
    .sort((a, b) => a.earliest - b.earliest);
}

// ── Missing-deadline resolution modal ───────────────────────────────────
// A checklist row is "unresolved" when it has a region but no deadline could
// be derived from the calendar (region+platform), the region-wide fallback, or
// the campaign-wide deadline. Rather than let such a row silently never go
// overdue, we pop a centered modal listing each unresolved campaign + region +
// platform combo and let the admin type a deadline. Saved values are written to
// the campaign's `deadlineOverrides` map (keyed by the same region|platform
// composite used at lookup time), so every checklist ends up with a due date.
let _resolveDeadlineState = null; // { combos: [{campId, campName, region, platform, comboKey, count}] }

// Only the admin/manager should be interrupted by this (team leads and CDMs
// can't edit campaign deadlines). Also skip if the modal is already open.
function _canResolveDeadlines() {
  const role = currentUser?.role;
  return role === 'admin' || role === 'manager';
}

function maybePromptMissingDeadlines(rows) {
  if (!_canResolveDeadlines()) return;
  if (document.getElementById('resolve-deadlines-overlay')) return; // already open
  const unresolved = (rows || []).filter(r => r.needsDeadline);
  if (unresolved.length === 0) return;

  // De-duplicate to unique campaign + region + platform combos (many CDMs share
  // the same brand/platform/region, so one input fixes all of them at once).
  const map = {};
  unresolved.forEach(r => {
    const campId   = r.camp?.id || '';
    const key = `${campId}::${r.comboKey}`;
    if (!map[key]) {
      map[key] = {
        campId,
        campName: r.camp?.name || campId,
        region:   r.entryRegion || '',
        platform: r.entryPlatform || '',   // canonical id ('' when unknown, e.g. Zalora)
        platformLabel: r.entryPlatform ? (CAL_PLATFORM_MAP[r.entryPlatform]?.label || r.entryPlatform)
                     : (r.entryPlatform === '' && r.comboKey.includes('|') ? r.comboKey.split('|')[1] : ''),
        comboKey: r.comboKey,
        count: 0,
      };
    }
    map[key].count++;
  });

  _resolveDeadlineState = { combos: Object.values(map) };
  _openResolveDeadlinesModal();
}

function _openResolveDeadlinesModal() {
  const combos = _resolveDeadlineState?.combos || [];
  if (combos.length === 0) return;

  let overlay = document.getElementById('resolve-deadlines-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'resolve-deadlines-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) { /* require explicit action */ } };
    document.body.appendChild(overlay);
  }

  // Default suggested time: 16:00 (the D-Day − standard 4pm cutoff convention
  // used across the app). Date is left blank so the admin picks intentionally.
  const rowsHtml = combos.map((c, i) => {
    const platTxt = c.platform
      ? `<span class="rp-reg-tag" style="background:#EEF2FF;color:#4338CA;">${escHtml(CAL_PLATFORM_MAP[c.platform]?.label || c.platform)}</span>`
      : (c.platformLabel
          ? `<span class="rp-reg-tag" style="background:#FEF3C7;color:#92400E;">${escHtml(c.platformLabel)}</span>`
          : `<span class="rp-reg-tag" style="background:#F3F4F6;color:#6B7280;">no platform</span>`);
    return `
    <div style="display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
      <div style="flex:1;min-width:180px;">
        <div style="font-size:13px;font-weight:600;color:var(--text);">${escHtml(c.campName)}</div>
        <div style="margin-top:3px;display:flex;gap:5px;align-items:center;">
          <span class="rp-reg-tag" style="background:#E0F2FE;color:#075985;">${escHtml(c.region || '—')}</span>
          ${platTxt}
          <span style="font-size:11px;color:var(--text-muted);">· ${c.count} checklist${c.count === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="date" id="rd-date-${i}" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px;font-size:13px;">
        <input type="time" id="rd-time-${i}" value="16:00" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px;font-size:13px;">
      </div>
    </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="modal" style="max-width:640px;">
      <div class="modal-header" style="display:flex;align-items:flex-start;gap:10px;margin-bottom:6px;">
        <div style="font-size:22px;line-height:1;">⏰</div>
        <div>
          <h3 style="margin:0;font-size:17px;color:var(--text);">Set missing checklist deadlines</h3>
          <p style="margin:4px 0 0;font-size:12.5px;color:var(--text-muted);line-height:1.5;">
            These region/platform combos have checklists but no deadline from the
            calendar or campaign. Give each one a due date so it can be tracked as
            on-time or overdue. Nothing is left without a deadline.
          </p>
        </div>
      </div>
      <div id="rd-list" style="margin-top:8px;">${rowsHtml}</div>
      <div id="resolve-deadlines-error" class="error-msg" style="display:none;margin-top:10px;"></div>
      <div class="modal-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button class="btn-outline" onclick="dismissResolveDeadlines()">Later</button>
        <button class="btn-primary" onclick="saveResolveDeadlines()">Save deadlines</button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
}

// "Later" — close without saving. The modal will re-appear on the next
// dashboard render while rows remain unresolved, so nothing is lost.
function dismissResolveDeadlines() {
  const o = document.getElementById('resolve-deadlines-overlay');
  if (o) o.style.display = 'none';
}

async function saveResolveDeadlines() {
  const combos = _resolveDeadlineState?.combos || [];
  const errEl = document.getElementById('resolve-deadlines-error');
  if (errEl) errEl.style.display = 'none';

  // Collect each combo's typed deadline. Require a date for every row so we
  // never write a half-filled override that leaves some checklists un-dated.
  const entered = [];
  for (let i = 0; i < combos.length; i++) {
    const d = document.getElementById(`rd-date-${i}`)?.value || '';
    const t = document.getElementById(`rd-time-${i}`)?.value || '';
    if (!d) {
      if (errEl) { errEl.textContent = 'Please set a date for every row before saving.'; errEl.style.display = 'block'; }
      return;
    }
    entered.push({ combo: combos[i], iso: t ? `${d}T${t}` : d });
  }

  // Group overrides by campaign, then write once per campaign (merge into any
  // existing deadlineOverrides map). Keyed by the region|platform composite so
  // reporting's lookup finds them in the same slot it checks.
  const byCamp = {};
  entered.forEach(({ combo, iso }) => {
    byCamp[combo.campId] = byCamp[combo.campId] || {};
    byCamp[combo.campId][combo.comboKey] = iso;
  });

  try {
    await Promise.all(Object.entries(byCamp).map(async ([campId, overrides]) => {
      const existing = (campaigns[campId]?.deadlineOverrides) || {};
      const merged = { ...existing, ...overrides };
      await db.collection('campaigns').doc(campId).update({ deadlineOverrides: merged });
      if (campaigns[campId]) campaigns[campId].deadlineOverrides = merged; // keep local cache in sync
    }));
    dismissResolveDeadlines();
    showToast('✅ Deadlines saved — checklists are now tracked against them.', 'success');
    await renderAdminView(true);
  } catch (e) {
    console.error(e);
    if (errEl) { errEl.textContent = 'Failed to save. Please try again.'; errEl.style.display = 'block'; }
  }
}

// Best-effort: infer { year, month, campaignType } for a generation from a
// campaign name like "Mid-Month — Jul 2026" / "PayDay — Aug 2026", so the
// deadline map can be built even when the flow doesn't track them explicitly.
// Returns null for any part it can't parse; callers fall back sensibly.
function inferGenScopeFromName(name) {
  const s = String(name || '');
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const mMatch = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  const yMatch = s.match(/\b(20\d{2})\b/);
  let campaignType = null;
  if (/mid[\s-]*month/i.test(s))       campaignType = 'midmonth_sale';
  else if (/pay[\s-]*day/i.test(s))    campaignType = 'payday_sale';
  else if (/double[\s-]*digit|\b\d\.\d\b|\b(11\.11|12\.12|10\.10|9\.9)\b/i.test(s)) campaignType = null; // double-digit spans regions; leave type open
  const month = mMatch ? months.indexOf(mMatch[1].toLowerCase().slice(0,3)) : null;
  const year  = yMatch ? Number(yMatch[1]) : null;
  return { year, month, campaignType };
}

// ── Generate-from-calendar flow removed ─────────────────────────────
// The "Generate from Calendar" modal and its helpers (_buildChecklistPlan,
// openGenChecklistModal, refreshGenChecklistPlan, confirmGenerateChecklist,
// generateChecklistFromCalendarView, genChecklistPlan) were retired. Bulk
// Assign is now the single calendar-driven path for creating checklists.
// inferGenScopeFromName + _deadlineFromDday + buildRegionDeadlineMap remain,
// since Bulk Assign and the New Campaign preview still use them.

async function savePersonalCalendarEntries() {
  if (!currentUser) return;
  await db.collection('calendarPersonal').doc(currentUser.uid).set({ entries: personalCalendarEntries });
}

function getVisibleSharedEntries() {
  if (!currentUser) return calendarEntries;
  if (currentUser.role === 'admin' || currentUser.role === 'manager') return calendarEntries;
  // Members/team leads: see shared entries assigned to all, specifically to them,
  // or that they personally created (a team lead who tags only their members
  // should still see the event they just added on their own calendar).
  return calendarEntries.filter(e => {
    if (e.createdBy && e.createdBy === currentUser.uid) return true;
    if (!e.assignedUids || e.assignedUids.length === 0) return true;
    return e.assignedUids.includes(currentUser.uid);
  });
}

// Returns a short "added by <team lead>" label for shared entries created by a
// team lead, so admins can spot alignment events (e.g. campaign D-days) added
// by team leads at a glance. Returns '' for admin-created or personal entries.
function _calCreatorLabel(entry) {
  if (!entry || entry._type !== 'shared' || !entry.createdBy || entry.createdBy === ADMIN_UID) return '';
  const creator = members[entry.createdBy];
  if (!creator || creator.role !== 'team_lead') return '';
  return creator.name || creator.username || 'Team Lead';
}

function renderCalendarView(targetEl) {
  const wrap = targetEl || document.getElementById('user-calendar-view');
  if (!wrap) return;

  const now        = new Date();
  const year       = calCurrentYear;
  const month      = calCurrentMonth;
  const firstDay   = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName  = new Date(year, month, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  const sharedVisible = getVisibleSharedEntries();
  // Admin sees all shared entries; members see only their personal ones
  const personalVisible = currentUser?.role !== 'admin' ? personalCalendarEntries : [];

  // Build day → entries map
  const dayMap = {};
  let allVisible = [
    ...sharedVisible.map(e => ({ ...e, _type: 'shared' })),
    ...personalVisible.map(e => ({ ...e, _type: 'personal' })),
  ];

  // Direction A filters: narrow by region and/or campaign phase. Personal
  // events are always kept (they're the user's own notes, not campaign data).
  if (calFilterRegion || calFilterCampaign || calFilterPlatform) {
    allVisible = allVisible.filter(e => {
      if (e._type === 'personal') return true;
      if (calFilterRegion) {
        const r = _calRegionOf(e);
        if (!r || r.id !== calFilterRegion) return false;
      }
      if (calFilterCampaign && _calCampaignType(e).id !== calFilterCampaign) return false;
      if (calFilterPlatform) {
        const p = _calPlatformOf(e);
        if (!p || p.id !== calFilterPlatform) return false;
      }
      return true;
    });
  }

  const _monthRangeStart = new Date(year, month, 1);
  const _monthRangeEnd   = new Date(year, month, daysInMonth);

  allVisible.forEach(entry => {
    const occurrences = _calRecurrenceOccurrences(entry, _monthRangeStart, _monthRangeEnd);
    occurrences.forEach(occ => {
      // The occurrence's own start date (YYYY-MM-DD), so a click on this cell
      // can tell the modal WHICH instance of a recurring series was opened.
      const pad = n => String(n).padStart(2, '0');
      const occStartISO = `${occ.start.getFullYear()}-${pad(occ.start.getMonth() + 1)}-${pad(occ.start.getDate())}`;
      // Enumerate each day in this occurrence's range
      for (let d = new Date(occ.start); d <= occ.end; d.setDate(d.getDate() + 1)) {
        if (d.getFullYear() !== year || d.getMonth() !== month) continue;
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (!dayMap[key]) dayMap[key] = [];
        dayMap[key].push({ ...entry, _occStartISO: occStartISO });
      }
    });
  });

  // Stable, predictable ordering within each day: campaign events first
  // (grouped by region, then title), personal events last. Without this the
  // order was whatever Firestore happened to return, which made entries
  // appear to jump around between days.
  Object.keys(dayMap).forEach(k => {
    dayMap[k].sort((a, b) => {
      if (a._type !== b._type) return a._type === 'personal' ? 1 : -1;
      const ra = (_calRegionOf(a)?.label || '~');
      const rb = (_calRegionOf(b)?.label || '~');
      if (ra !== rb) return ra.localeCompare(rb);
      return (a.title || '').localeCompare(b.title || '');
    });
  });

  const isAdmin   = currentUser?.role === 'admin' || currentUser?.role === 'manager';
  const isTeamLead = currentUser?.role === 'team_lead';
  const canAddPersonal = !isAdmin;

  let html = `
  <div class="cal-wrap">
    <div class="cal-header">
      <div class="cal-nav">
        <button class="cal-nav-btn" onclick="calNav(-1)">&#8592;</button>
        <span class="cal-month-label">${monthName}</span>
        <button class="cal-nav-btn" onclick="calNav(1)">&#8594;</button>
        <button class="cal-nav-btn" onclick="calGoToday()" style="font-size:11px;padding:4px 10px;">Today</button>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <select class="cal-filter-select" onchange="calSetCampaignFilter(this.value)" title="Filter by campaign">
          <option value="">All campaigns</option>
          ${CAL_CAMPAIGN_TYPES.filter(c => c.id !== 'other').map(c =>
            `<option value="${c.id}" ${calFilterCampaign === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}
        </select>
        <select class="cal-filter-select" onchange="calSetRegionFilter(this.value)" title="Filter by region">
          <option value="">All regions</option>
          ${CAL_REGIONS.map(r =>
            `<option value="${r.id}" ${calFilterRegion === r.id ? 'selected' : ''}>${r.label}</option>`).join('')}
        </select>
        <select class="cal-filter-select" onchange="calSetPlatformFilter(this.value)" title="Filter by platform">
          <option value="">All platforms</option>
          ${CAL_PLATFORMS.map(p =>
            `<option value="${p.id}" ${calFilterPlatform === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
        </select>
        <div class="cal-legend">
          ${CAL_CAMPAIGN_TYPES.map(t => `<span class="cal-legend-dot" style="background:${t.color}"></span><span style="font-size:11px;color:var(--text-muted)">${t.label}</span>`).join('')}
          ${canAddPersonal ? `<span class="cal-legend-dot" style="background:#94A3B8;border:2px dashed #64748B;box-sizing:border-box;"></span><span style="font-size:11px;color:var(--text-muted)">My Events</span>` : ''}
        </div>
        ${isAdmin ? `<button class="btn-outline" style="background:var(--blue);border-color:var(--blue);font-size:12px;" onclick="openCalEntryModal(null,false)">+ Add Event</button>` : ''}
        ${isTeamLead ? `<button class="btn-outline" style="background:var(--blue);border-color:var(--blue);font-size:12px;" onclick="openCalEntryModal(null,false)">+ Team Event</button>` : ''}
        ${canAddPersonal ? `<button class="btn-outline" style="background:#475569;border-color:#475569;font-size:12px;" onclick="openCalEntryModal(null,true)">+ My Event</button>` : ''}
      </div>
    </div>

    <div class="cal-grid-wrap">
      <div class="cal-weekdays">
        ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-wd">${d}</div>`).join('')}
      </div>
      <div class="cal-grid">`;

  // Leading empty cells
  for (let i = 0; i < firstDay; i++) {
    html += `<div class="cal-day cal-day-empty"></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = (d === now.getDate() && month === now.getMonth() && year === now.getFullYear());
    const key     = `${year}-${month}-${d}`;
    const dayEntries = dayMap[key] || [];

    html += `<div class="cal-day ${isToday ? 'cal-day-today' : ''}">
      <div class="cal-day-num ${isToday ? 'cal-today-num' : ''}">${d}</div>
      <div class="cal-day-events">`;

    // Render EVERY entry for the day. Previously this capped at 4 with a
    // "+N more" link, which silently hid entries on busy days (Mid-Month can
    // easily exceed 4 across PH/SG/MY/VN/TH × Lazada/Shopee) and made it look
    // like new events hadn't saved. The day cell scrolls if it overflows.
    dayEntries.forEach(entry => {
      const camp     = _calCampaignType(entry);
      const col      = entry._type === 'personal' ? '#94A3B8' : camp.color;
      const border   = entry._type === 'personal' ? '2px dashed #64748B' : 'none';
      const region   = entry._type === 'personal' ? null : _calRegionOf(entry);
      const shown     = _calCleanTitle(entry);
      const isEditable = isAdmin || (entry._type === 'personal') || (isTeamLead && entry.createdBy === currentUser?.uid);
      const creatorLabel = isAdmin ? _calCreatorLabel(entry) : '';
      const recurLabel = _calRecurrenceLabel(entry);
      const regionBadge = region
        ? `<span class="cal-region-badge" style="background:${region.color};">${escHtml(region.label)}</span>`
        : '';
      const plat = entry._type === 'personal' ? null : _calPlatformOf(entry);
      const platformBadge = plat
        ? `<span class="cal-platform-badge" style="background:${plat.color};" title="${escHtml(plat.label)}">${escHtml(plat.short)}</span>`
        : '';
      html += `<div class="cal-event" style="background:${col}1f;border-left:3px solid ${col};border:${border};"
        onclick="${isEditable ? `openCalEntryModal('${entry.id}',${entry._type === 'personal'},${entry._occStartISO ? `'${entry._occStartISO}'` : 'null'})` : ''}"
        title="${escHtml(entry.title)}${plat ? ` — ${escHtml(plat.label)}` : ''}${entry._type === 'personal' ? ' (My Event)' : ''}${creatorLabel ? ` — added by ${escHtml(creatorLabel)} (Team Lead)` : ''}${recurLabel ? ` — Repeats ${recurLabel}` : ''}">
        ${regionBadge}${platformBadge}<span style="color:${col};font-size:10px;font-weight:600;">${recurLabel ? '🔁 ' : ''}${escHtml(shown)}${creatorLabel ? ' 👤' : ''}</span>
      </div>`;
    });
    html += `</div>`; // close .cal-day-events (scrolling list)

    // Busy-day indicator. Purely informational — every entry is rendered and
    // the list scrolls, so there is nothing hidden to "expand" into.
    if (dayEntries.length > 4) {
      html += `<div class="cal-event-count" title="${dayEntries.length} events this day — scroll the cell to see them all">${dayEntries.length} events ⌄</div>`;
    }

    html += `</div>`; // close .cal-day
  }

  html += `</div></div>`; // cal-grid, cal-grid-wrap

  // Upcoming events list (expand recurring entries into their next occurrences).
  // Regular members ("All User" view) see events scoped to whichever month is
  // currently shown in the grid above, so the list moves in lockstep with the
  // month nav arrows. Admin/team lead keep the rolling "next 365 days" view
  // since they need a running overview regardless of which month they're browsing.
  const isMemberView = !isAdmin && !isTeamLead;
  const todayCutoff = new Date(); todayCutoff.setHours(0,0,0,0);
  const upcomingCutoff   = isMemberView ? _monthRangeStart : todayCutoff;
  const upcomingRangeEndBase = isMemberView ? _monthRangeEnd : (() => { const d = new Date(todayCutoff); d.setDate(d.getDate() + 365); return d; })();
  let upcoming = [];
  allVisible.forEach(entry => {
    const occurrences = _calRecurrenceOccurrences(entry, upcomingCutoff, upcomingRangeEndBase);
    occurrences.forEach(occ => {
      // For the member/month-scoped view, only keep occurrences that overlap
      // the selected month. For the rolling view, keep anything not fully ended.
      const cutoffForFilter = isMemberView ? upcomingCutoff : todayCutoff;
      if (occ.end >= cutoffForFilter) upcoming.push({ ...entry, _occStart: occ.start, _occEnd: occ.end });
    });
  });
  upcoming = upcoming.sort((a,b) => a._occStart - b._occStart);
  if (!isMemberView) upcoming = upcoming.slice(0, 8);

  if (upcoming.length > 0) {
    html += `<div class="cal-upcoming">
      <div class="section-label" style="margin-bottom:10px;">Upcoming${isMemberView ? ` — ${monthName}` : ''}</div>
      <div class="cal-upcoming-list">`;
    upcoming.forEach(entry => {
      const camp = _calCampaignType(entry);
      const col = entry._type === 'personal' ? '#94A3B8' : camp.color;
      const region = entry._type === 'personal' ? null : _calRegionOf(entry);
      const shown = _calCleanTitle(entry);
      const regionBadge = region
        ? `<span class="cal-region-badge" style="background:${region.color};margin-right:4px;">${escHtml(region.label)}</span>`
        : '';
      const isMultiDay = entry._occEnd && entry._occEnd.getTime() !== entry._occStart.getTime();
      const dateStr = isMultiDay
        ? `${entry._occStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${entry._occEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
        : entry._occStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', weekday: 'short' });
      const isEditable = isAdmin || (entry._type === 'personal') || (isTeamLead && entry.createdBy === currentUser?.uid);
      const creatorLabel = isAdmin ? _calCreatorLabel(entry) : '';
      const recurLabel = _calRecurrenceLabel(entry);
      const _occISO = entry._occStart ? `${entry._occStart.getFullYear()}-${String(entry._occStart.getMonth()+1).padStart(2,'0')}-${String(entry._occStart.getDate()).padStart(2,'0')}` : null;
      html += `<div class="cal-upcoming-item" style="border-left:3px solid ${col};"
        ${isEditable ? `onclick="openCalEntryModal('${entry.id}',${entry._type === 'personal'},${_occISO ? `'${_occISO}'` : 'null'})" style="border-left:3px solid ${col};cursor:pointer;"` : ''}>
        <div class="cal-upcoming-date">${dateStr}</div>
        <div class="cal-upcoming-title">${regionBadge}${recurLabel ? '🔁 ' : ''}${escHtml(shown)}</div>
        ${entry.description ? `<div class="cal-upcoming-desc">${escHtml(entry.description)}</div>` : ''}
        ${entry._type === 'personal' ? '<span class="cal-personal-badge">My Event</span>' : ''}
        ${creatorLabel ? `<span class="cal-personal-badge" style="background:#EFF6FF;color:#2563EB;">Added by ${escHtml(creatorLabel)} (TL)</span>` : ''}
        ${recurLabel ? `<span class="cal-personal-badge" style="background:#F5F3FF;color:#7C3AED;">Repeats ${recurLabel}</span>` : ''}
        <span class="cal-type-badge" style="background:${col}20;color:${col};">${camp.label}</span>
      </div>`;
    });
    html += `</div></div>`;
  }

  html += `</div>`; // cal-wrap

  wrap.innerHTML = html;
}

function getCalTarget() {
  // Render into whichever calendar host is actually visible: admin, team lead, or user.
  const adminHost = document.getElementById('admin-calendar-host');
  if (adminHost && adminHost.offsetParent !== null) return adminHost;
  const tlHost = document.getElementById('tl-calendar-view');
  if (tlHost && tlHost.offsetParent !== null) return tlHost;
  return document.getElementById('user-calendar-view');
}

function calNav(dir) {
  calCurrentMonth += dir;
  if (calCurrentMonth > 11) { calCurrentMonth = 0; calCurrentYear++; }
  if (calCurrentMonth < 0)  { calCurrentMonth = 11; calCurrentYear--; }
  renderCalendarView(getCalTarget());
}

function calGoToday() {
  const now = new Date();
  calCurrentMonth = now.getMonth();
  calCurrentYear  = now.getFullYear();
  renderCalendarView(getCalTarget());
}

// ── Calendar time field helpers (HH MM AM/PM) ─────────────────
function _setCalTimeFields(prefix, timeStr) {
  // Loads a STORED time back into the HH / MM / AM-PM dropdowns.
  // Storage format is 24-hour "HH:mm" (e.g. "20:00"). We also still accept the
  // legacy "hh:mm AM/PM" shape so any old data written before this fix loads
  // correctly. The dropdowns themselves are 12-hour, so convert to 12h here.
  const hEl = document.getElementById(`cal-entry-${prefix}-hour`);
  const mEl = document.getElementById(`cal-entry-${prefix}-minute`);
  const aEl = document.getElementById(`cal-entry-${prefix}-ampm`);
  if (!hEl || !mEl || !aEl) return;
  if (!timeStr) { hEl.value = ''; mEl.value = ''; aEl.value = ''; return; }
  const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) { hEl.value = ''; mEl.value = ''; aEl.value = ''; return; }
  let h24;
  const m = match[2];
  const ap = (match[3] || '').toUpperCase();
  if (ap) {
    // Legacy 12-hour string with an explicit meridiem.
    let hh = parseInt(match[1], 10) % 12;
    if (ap === 'PM') hh += 12;
    h24 = hh;
  } else {
    // Canonical 24-hour string.
    h24 = parseInt(match[1], 10);
  }
  const meridiem = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 || 12;
  hEl.value = String(h12).padStart(2, '0');
  mEl.value = m;
  aEl.value = meridiem;
}

function _getCalTimeField(prefix) {
  // Reads the 12-hour HH / MM / AM-PM dropdowns and returns a canonical
  // 24-hour "HH:mm" string (e.g. 08 / 00 / PM -> "20:00"). Everything
  // downstream (calendarEntries[].startTime, _deadlineFromDday, the
  // `${date}T${startTime}` ISO builders) assumes 24-hour, so the meridiem
  // MUST be folded in here -- otherwise 8 PM was being stored as "08:00" and
  // read as 8 AM, making the derived deadline 4 hours off (and in the wrong
  // half of the day).
  const h = document.getElementById(`cal-entry-${prefix}-hour`)?.value;
  const m = document.getElementById(`cal-entry-${prefix}-minute`)?.value;
  const a = document.getElementById(`cal-entry-${prefix}-ampm`)?.value;
  if (!h || !m || !a) return '';
  let hh = parseInt(h, 10) % 12;
  if (a.toUpperCase() === 'PM') hh += 12;
  return `${String(hh).padStart(2, '0')}:${m}`;
}

// One-time migration: older calendar events stored their time in the buggy
// 12-hour "hh:mm AM/PM" format (the meridiem was silently dropped when a
// deadline was derived). Rewrite any such values in place to canonical 24-hour
// "HH:mm" so _deadlineFromDday and the ISO builders read them correctly.
// Idempotent: values already in "HH:mm" form are left untouched. Runs once per
// load against the in-memory calendarEntries; persists only the rows it fixes.
function _migrateLegacyCalTimes() {
  if (typeof calendarEntries === 'undefined' || !Array.isArray(calendarEntries)) return;
  const to24 = v => {
    if (!v) return v;
    const mt = String(v).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i); // ONLY legacy meridiem form
    if (!mt) return v; // already 24h "HH:mm" (or unrecognised) -> leave as-is
    let hh = parseInt(mt[1], 10) % 12;
    if (mt[3].toUpperCase() === 'PM') hh += 12;
    return `${String(hh).padStart(2, '0')}:${mt[2]}`;
  };
  const dirty = [];
  calendarEntries.forEach(e => {
    const ns = to24(e.startTime);
    const ne = to24(e.endTime);
    if (ns !== e.startTime || ne !== e.endTime) {
      e.startTime = ns; e.endTime = ne;
      dirty.push(e);
    }
  });
  if (dirty.length && typeof saveCalendarEntries === 'function') {
    // Best-effort persist; failures just mean it retries next load.
    Promise.resolve()
      .then(() => saveCalendarEntries())
      .then(() => console.info(`Migrated ${dirty.length} calendar event time(s) to 24-hour format.`))
      .catch(err => console.warn('Calendar time migration could not persist:', err));
  }
}

// ── Calendar Entry Modal ──
function openCalEntryModal(entryId, isPersonal, occurrenceDate) {
  calEditingEntry = null;

  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'manager';
  const isTeamLead = currentUser?.role === 'team_lead';

  if (entryId) {
    const list = isPersonal ? personalCalendarEntries : calendarEntries;
    const found = list.find(e => e.id === entryId);
    // occurrenceDate (YYYY-MM-DD) identifies WHICH instance of a recurring
    // series was clicked, so "edit only this one" knows which date to split
    // out. It's null for non-recurring events and for the series base itself.
    if (found) calEditingEntry = { entry: found, isPersonal, occurrenceDate: occurrenceDate || null };
  }

  const entry = calEditingEntry?.entry || {};
  const personalMode = isPersonal || (!isAdmin && !isTeamLead && !entryId);

  // Populate member assign list (admin: all members; team lead: their own bucket only)
  let memberAssignHtml = '';
  if ((isAdmin || isTeamLead) && !isPersonal) {
    const assignable = isAdmin
      ? Object.values(members).filter(m => m.role !== 'admin')
      : Object.values(tlMembers || {});
    const assignLabel = isAdmin ? 'Visible to (leave all unchecked = all members)' : 'Send to (select members in your team)';
    memberAssignHtml = `
    <div class="field">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <label style="margin:0;">${assignLabel}</label>
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-outline" style="font-size:11px;padding:2px 8px;" onclick="_calToggleAllMembers(true)">Select All</button>
          <button type="button" class="btn-outline" style="font-size:11px;padding:2px 8px;" onclick="_calToggleAllMembers(false)">Clear</button>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);max-height:100px;overflow-y:auto;">
        ${assignable.map(m => {
          const checked = entry.assignedUids && entry.assignedUids.includes(m.uid) ? 'checked' : '';
          return `<label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;padding:3px 8px;border:1px solid var(--border);border-radius:99px;background:var(--surface);">
            <input type="checkbox" class="cal-member-cb" value="${m.uid}" ${checked} />
            ${escHtml(m.name || m.username)}
          </label>`;
        }).join('')}
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${isAdmin ? 'Unchecked = visible to all tagged members' : 'Selected members + Admin will be notified for alignment'}</div>
    </div>`;
  }

  document.getElementById('cal-modal-title').textContent = entryId ? (personalMode ? 'Edit My Event' : 'Edit Event') : (personalMode ? 'Add My Event' : 'Add Event');
  // Region + campaign phase: fall back to inference so legacy events (region
  // in the title, phase implied by wording) open with the right values, and
  // show the title without the "[MY]" prefix once it's captured as a field.
  // A legacy entry may have region="LAZ" — that was a platform smuggled into
  // the region field, so don't carry it over as a region.
  const _rawRegion = entry.region || _calRegionOf(entry)?.id || '';
  const _inferredRegion = CAL_PLATFORMS.some(p => p.short === _rawRegion.toUpperCase())
    ? '' : _rawRegion;
  const _inferredCampaign = entry.campaignType || _calCampaignType(entry).id;
  // Platform is inferred from the title (or a legacy region="LAZ") when the
  // entry predates the platform field, so opening an old event pre-fills it.
  const _inferredPlatform = entry.platform || _calPlatformOf(entry)?.id || '';
  const _regionSel = document.getElementById('cal-entry-region');
  const _campSel   = document.getElementById('cal-entry-campaign-type');
  const _platSel   = document.getElementById('cal-entry-platform');
  if (_regionSel) _regionSel.value = _inferredRegion;
  if (_campSel)   _campSel.value   = _inferredCampaign;
  if (_platSel)   _platSel.value   = _inferredPlatform;
  document.getElementById('cal-entry-title-input').value   = entryId ? _calCleanTitle(entry) : (entry.title || '');
  // For a recurring series, show the DATE OF THE CLICKED OCCURRENCE (shifting
  // the end date by the same span) rather than the series' base date, so
  // editing "just this one" operates on the instance the admin clicked.
  const _occDate = calEditingEntry?.occurrenceDate || null;
  const _isRecurringOpen = !!(entry.recurrence && entry.recurrence.freq);
  if (_occDate && _isRecurringOpen) {
    document.getElementById('cal-entry-date').value = _occDate;
    if (entry.endDate && entry.date && entry.endDate !== entry.date) {
      const span = Math.round((new Date(`${entry.endDate}T00:00:00`) - new Date(`${entry.date}T00:00:00`)) / 86400000);
      const oe = new Date(`${_occDate}T00:00:00`); oe.setDate(oe.getDate() + span);
      const pad = n => String(n).padStart(2, '0');
      document.getElementById('cal-entry-enddate').value = `${oe.getFullYear()}-${pad(oe.getMonth() + 1)}-${pad(oe.getDate())}`;
    } else {
      document.getElementById('cal-entry-enddate').value = _occDate;
    }
  } else {
    document.getElementById('cal-entry-date').value        = entry.date || '';
    document.getElementById('cal-entry-enddate').value     = entry.endDate || '';
  }
  // "type" is now the milestone axis (dday/deadline/teasing/meeting/other).
  // Legacy events typed 'payday_sale'/'midmonth_sale' carried their phase in
  // the type field; those map to 'other' here since the phase now lives on the
  // Campaign dropdown. Deadline-mapping still keys off dday/deadline, untouched.
  const _legacyType = entry.type || '';
  const _milestoneType = ['teasing','dday','deadline','meeting','other'].includes(_legacyType) ? _legacyType : 'other';
  document.getElementById('cal-entry-type').value          = _milestoneType;
  document.getElementById('cal-entry-desc').value          = entry.description || '';
  document.getElementById('cal-entry-personal-mode').value = personalMode ? '1' : '0';

  // Campaign events get an auto-composed, standardized title (Campaign · Region
  // · Platform · Milestone); the free-text title box is hidden for them and
  // shown only for personal notes, which stay free-typed.
  const _titleField = document.getElementById('cal-entry-title-field');
  const _titleAutoNote = document.getElementById('cal-entry-title-auto-note');
  const _titleInput = document.getElementById('cal-entry-title-input');
  if (personalMode) {
    if (_titleField) _titleField.style.display = '';
    if (_titleAutoNote) _titleAutoNote.style.display = 'none';
    if (_titleInput) { _titleInput.readOnly = false; _titleInput.style.background = ''; }
  } else {
    // Hide the raw title box for campaign events; the auto-name note explains it.
    if (_titleField) _titleField.style.display = 'none';
    if (_titleAutoNote) _titleAutoNote.style.display = 'block';
    if (_titleInput) _titleInput.readOnly = true;
  }

  // Populate start time fields
  _setCalTimeFields('start', entry.startTime || '');
  // Populate end time fields
  _setCalTimeFields('end', entry.endTime || '');
  document.getElementById('cal-member-assign-wrap').innerHTML = memberAssignHtml;
  document.getElementById('cal-entry-error').style.display    = 'none';

  // Populate recurrence fields
  document.getElementById('cal-entry-recurrence').value = (entry.recurrence && entry.recurrence.freq) || 'none';
  document.getElementById('cal-entry-recurrence-until').value = (entry.recurrence && entry.recurrence.until) || '';
  toggleCalRecurrenceUntil();
  document.getElementById('cal-recurrence-hint').style.display = (entryId && entry.recurrence && entry.recurrence.freq) ? 'block' : 'none';

  const deleteBtn = document.getElementById('cal-delete-btn');
  deleteBtn.style.display = entryId ? 'inline-flex' : 'none';

  // Build the standardized title for campaign events from the resolved
  // Campaign/Region/Platform/Milestone selects, so every campaign event follows
  // the same naming convention. The admin sees the resulting name in the note
  // under the (hidden) title box and it recomposes live as they change fields.
  // Personal events keep their free text.
  if (!personalMode) _calComposeTitle();
  // Set the initial Save-enabled state (composeTitle already validates for
  // shared events; this covers personal mode, which skips composeTitle).
  _calValidateEntry();

  document.getElementById('cal-entry-overlay').style.display = 'flex';
}

// Compose a standardized, human-readable title for a campaign calendar event
// from the Campaign · Region · Platform · Milestone selects, e.g.
// "PayDay — TH · Lazada · D-Day". This is what the admin asked for: the
// campaign dropdown drives the naming so events stay consistently labelled
// instead of free-typed. Writes into the (hidden) title input, which
// saveCalEntry then reads, so the rest of the pipeline is unchanged.
// No-op in personal mode — personal notes keep their free text.
function _calComposeTitle() {
  const personalMode = document.getElementById('cal-entry-personal-mode')?.value === '1';
  if (personalMode) return;

  const campId = document.getElementById('cal-entry-campaign-type')?.value || 'other';
  const region = document.getElementById('cal-entry-region')?.value || '';
  const platId = document.getElementById('cal-entry-platform')?.value || '';
  const milestone = document.getElementById('cal-entry-type')?.value || 'other';

  const campLabel = (CAL_CAMPAIGN_TYPES.find(c => c.id === campId) || {}).label || 'Event';
  const platLabel = platId ? ((CAL_PLATFORMS.find(p => p.id === platId) || {}).label || '') : '';
  const milestoneLabel = ({
    teasing: 'Teasing', dday: 'D-Day', deadline: 'Deadline', meeting: 'Meeting', other: '',
  })[milestone] || '';

  // Head is the campaign phase; the rest are dot-joined qualifiers that are
  // present. "Other" campaign with nothing else falls back to a neutral label
  // so the title is never empty (title is still required downstream).
  const qualifiers = [region, platLabel, milestoneLabel].filter(Boolean).join(' · ');
  let title;
  if (campId === 'other' && !qualifiers) title = 'Event';
  else if (campId === 'other')           title = qualifiers;
  else                                    title = qualifiers ? `${campLabel} — ${qualifiers}` : campLabel;

  const input = document.getElementById('cal-entry-title-input');
  if (input) input.value = title;

  // Mirror the composed name into the visible note (the raw input is hidden for
  // campaign events) so the admin can see exactly what the event will be named.
  const note = document.getElementById('cal-entry-title-auto-note');
  if (note) note.innerHTML = `Auto-named: <strong>${escHtml(title)}</strong> <span style="opacity:0.7;">(from Campaign · Region · Platform · Milestone)</span>`;

  // Any field that composes the title also affects completeness — re-validate.
  _calValidateEntry();
}

// Live completeness gate for SHARED (non-personal) calendar events. Region,
// Platform, Start Date and Start Time are all required so every event that can
// feed a checklist deadline carries the full reference the reporting side needs
// — no event is saved with the details that make it usable left blank. Personal
// notes are exempt (they never drive a checklist). Returns the list of missing
// field labels (empty = valid) and toggles the Save button + hint accordingly.
function _calValidateEntry() {
  const saveBtn = document.getElementById('cal-entry-save');
  const hint    = document.getElementById('cal-entry-required-hint');
  const personalMode = document.getElementById('cal-entry-personal-mode')?.value === '1';

  // Personal events: no requirement — always allow save.
  if (personalMode) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; saveBtn.style.cursor = ''; }
    if (hint) hint.style.display = 'none';
    return [];
  }

  const region       = document.getElementById('cal-entry-region')?.value || '';
  const platform     = document.getElementById('cal-entry-platform')?.value || '';
  const date         = document.getElementById('cal-entry-date')?.value || '';
  const startTime    = _getCalTimeField('start'); // '' unless HH+MM+AM/PM all set
  const milestone    = document.getElementById('cal-entry-type')?.value || 'other';
  const campaignType = document.getElementById('cal-entry-campaign-type')?.value || 'other';

  const missing = [];
  if (!region)    missing.push('Region');
  if (!platform)  missing.push('Platform');
  if (!date)      missing.push('Start Date');
  if (!startTime) missing.push('Start Time');
  // D-Day/Deadline events are what buildRegionDeadlineMap() reads to generate
  // per-region checklist deadlines, and it filters them by Campaign phase
  // (Mid-Month/PayDay/Double Digit). The Campaign select defaults to "Other",
  // so without this check a D-Day/Deadline event can be saved fully "complete"
  // (region+platform+date+time) yet still be invisible to every phase-filtered
  // New Campaign preview — the exact "no region-tagged events found" trap.
  if ((milestone === 'dday' || milestone === 'deadline') && campaignType === 'other') {
    missing.push('Campaign phase');
  }

  if (saveBtn) {
    const ok = missing.length === 0;
    saveBtn.disabled = !ok;
    saveBtn.style.opacity = ok ? '' : '0.5';
    saveBtn.style.cursor  = ok ? '' : 'not-allowed';
  }
  if (hint) {
    if (missing.length === 0) {
      hint.style.display = 'none';
    } else {
      hint.style.display = 'block';
      hint.innerHTML = `Complete these before saving: <strong>${missing.map(escHtml).join(', ')}</strong>. `
        + `Shared events need a region, platform, date and start time so the checklist has a complete deadline reference`
        + `${missing.includes('Campaign phase') ? ' — and D-Day/Deadline events need a real Campaign phase (not "Other") or they won\'t show up in phase-filtered checklist generation.' : '.'}`;
    }
  }
  return missing;
}

// Select All / Clear on the "Visible to" member checklist in the calendar
// entry modal, so admins don't have to click every member one by one.
function _calToggleAllMembers(checkedState) {
  document.querySelectorAll('.cal-member-cb').forEach(cb => { cb.checked = checkedState; });
}

function toggleCalRecurrenceUntil() {
  const freq = document.getElementById('cal-entry-recurrence')?.value;
  const wrap = document.getElementById('cal-recurrence-until-wrap');
  if (wrap) wrap.style.display = (freq && freq !== 'none') ? 'block' : 'none';
}

function closeCalEntryModal(e) {
  if (e && e.target !== document.getElementById('cal-entry-overlay')) return;
  document.getElementById('cal-entry-overlay').style.display = 'none';
}

async function saveCalEntry() {
  const title    = document.getElementById('cal-entry-title-input').value.trim();
  const date     = document.getElementById('cal-entry-date').value;
  const endDate  = document.getElementById('cal-entry-enddate').value;
  const type     = document.getElementById('cal-entry-type').value;
  const region       = document.getElementById('cal-entry-region')?.value || '';
  const platform     = document.getElementById('cal-entry-platform')?.value || '';
  const campaignType = document.getElementById('cal-entry-campaign-type')?.value || 'other';
  const desc     = document.getElementById('cal-entry-desc').value.trim();
  const personalMode = document.getElementById('cal-entry-personal-mode').value === '1';
  const errEl    = document.getElementById('cal-entry-error');
  const startTime = _getCalTimeField('start');
  const endTime   = _getCalTimeField('end');
  const recurrenceFreq  = document.getElementById('cal-entry-recurrence').value || 'none';
  const recurrenceUntil = document.getElementById('cal-entry-recurrence-until').value || '';
  errEl.style.display = 'none';

  if (!title) { showError(errEl, 'Title is required.'); return; }
  if (!date)  { showError(errEl, 'Start date is required.'); return; }
  if (recurrenceFreq !== 'none' && recurrenceUntil && recurrenceUntil < date) {
    showError(errEl, '"Repeat Until" must be on or after the start date.'); return;
  }

  // Completeness backstop for SHARED events: region, platform, date, start
  // time (and, for D-Day/Deadline milestones, a real Campaign phase) are all
  // required so the checklist always has a full deadline reference. The Save
  // button is disabled live while anything's missing (see _calValidateEntry);
  // this guards the programmatic path / any stale state.
  if (!personalMode) {
    const missing = _calValidateEntry();
    if (missing.length > 0) {
      showError(errEl, `Please complete: ${missing.join(', ')}. Shared events need a region, platform, date and start time.`);
      return;
    }
  }

  const campInfo = CAL_CAMPAIGN_TYPES.find(c => c.id === campaignType) || CAL_CAMPAIGN_TYPES[3];

  // Gather assigned UIDs (admin or team lead shared entries only)
  let assignedUids = [];
  if (!personalMode && (currentUser?.role === 'admin' || currentUser?.role === 'manager' || currentUser?.role === 'team_lead')) {
    assignedUids = [...document.querySelectorAll('.cal-member-cb:checked')].map(cb => cb.value);
  }

  // Duplicate guard: if an identical entry already exists (same title, dates,
  // region and campaign type), warn before adding a second one. This catches
  // the common case of re-entering an event that looked "missing" but was
  // actually just scrolled out of view on a busy day.
  if (!personalMode && !calEditingEntry) {
    const _norm = s => (s || '').trim().toLowerCase();
    const dup = calendarEntries.find(e =>
      _norm(e.title) === _norm(title) &&
      e.date === date &&
      (e.endDate || e.date) === (endDate || date) &&
      _norm(e.region) === _norm(region) &&
      _norm(e.platform) === _norm(platform) &&
      (e.campaignType || 'other') === campaignType
    );
    if (dup) {
      const go = confirm(
        `An identical event already exists:\n\n` +
        `  ${title}\n  ${date}${(endDate && endDate !== date) ? ` – ${endDate}` : ''}` +
        `${region ? `\n  Region: ${region}` : ''}\n\n` +
        `Add it again anyway? (Cancel is usually what you want.)`
      );
      if (!go) return;
    }
  }

  const entryData = {
    title, date,
    endDate: endDate || date,
    type,
    region: region || null,
    platform: platform || null,
    campaignType,
    description: desc,
    startTime: startTime || null,
    endTime: endTime || null,
    color: campInfo.color,
    recurrence: recurrenceFreq !== 'none'
      ? { freq: recurrenceFreq, until: recurrenceUntil || null,
          // Carry forward any existing per-occurrence exceptions on edit.
          exceptions: (calEditingEntry?.entry?.recurrence?.exceptions) || [] }
      : null,
    assignedUids,
    // Link-to-Campaign was removed from the form; preserve any value an entry
    // already had so nothing that relied on it silently drops.
    campaignId: (calEditingEntry?.entry?.campaignId) || null,
    createdBy: currentUser?.uid || '',
    updatedAt: new Date().toISOString(),
  };

  try {
    if (personalMode) {
      if (calEditingEntry && calEditingEntry.isPersonal) {
        const idx = personalCalendarEntries.findIndex(e => e.id === calEditingEntry.entry.id);
        if (idx >= 0) personalCalendarEntries[idx] = { ...personalCalendarEntries[idx], ...entryData };
      } else {
        personalCalendarEntries.push({ id: `pce_${Date.now()}`, ...entryData });
      }
      await savePersonalCalendarEntries();
    } else {
      const editingExisting = calEditingEntry && !calEditingEntry.isPersonal;
      const parent = editingExisting ? calEditingEntry.entry : null;
      const parentIsRecurring = !!(parent && parent.recurrence && parent.recurrence.freq);

      if (editingExisting && parentIsRecurring) {
        // Recurring edit → ask scope. `_calEditScope` returns 'one', 'all',
        // or null (cancelled). "This event" splits the clicked occurrence out
        // as its own non-recurring entry and adds an exception on the parent
        // for that date. "All events" updates the series in place.
        const scope = await _calEditScope('save');
        if (scope === null) return; // cancelled — keep modal open

        if (scope === 'all') {
          const idx = calendarEntries.findIndex(e => e.id === parent.id);
          // Keep the series' base date/endDate; only the recurrence RULE and
          // the shared fields (title, region, times, etc.) propagate. Editing
          // "all" from one occurrence shouldn't move the whole series onto
          // that occurrence's date.
          if (idx >= 0) {
            calendarEntries[idx] = {
              ...calendarEntries[idx],
              ...entryData,
              date: parent.date,
              endDate: parent.endDate || parent.date,
              recurrence: entryData.recurrence
                ? { ...entryData.recurrence, exceptions: (parent.recurrence.exceptions || []) }
                : null,
            };
          }
        } else {
          // scope === 'one' → detach this occurrence.
          const occISO = calEditingEntry.occurrenceDate || parent.date;
          // 1) add the exception to the parent series so the instance vanishes
          const idx = calendarEntries.findIndex(e => e.id === parent.id);
          if (idx >= 0) {
            const ex = new Set((calendarEntries[idx].recurrence?.exceptions) || []);
            ex.add(occISO);
            calendarEntries[idx] = {
              ...calendarEntries[idx],
              recurrence: { ...calendarEntries[idx].recurrence, exceptions: [...ex] },
            };
          }
          // 2) add the edited occurrence as a standalone, non-recurring entry
          //    on the date shown in the form (which defaulted to occISO).
          calendarEntries.push({
            id: `ce_${Date.now()}`,
            ...entryData,
            recurrence: null,
            detachedFrom: parent.id,   // provenance, for possible future "re-link"
          });
        }
      } else if (editingExisting) {
        // Non-recurring existing entry → straight update.
        const idx = calendarEntries.findIndex(e => e.id === parent.id);
        if (idx >= 0) calendarEntries[idx] = { ...calendarEntries[idx], ...entryData };
      } else {
        // Brand-new entry.
        calendarEntries.push({ id: `ce_${Date.now()}`, ...entryData });
      }

      await saveCalendarEntries();
      if (currentUser?.role === 'team_lead' && assignedUids.length > 0) {
        await notifyCalEntryAlignment(entryData, assignedUids);
      }
    }
    document.getElementById('cal-entry-overlay').style.display = 'none';
    renderCalendarView(getCalTarget());
  } catch(e) { showError(errEl, 'Failed to save. Try again.'); console.error(e); }
}

// Ask whether a recurring-event change applies to just the clicked date or the
// whole series. Returns 'one' | 'all' | null (cancelled). A lightweight
// confirm-based chooser keeps this dependency-free and consistent with the
// app's existing confirm() prompts; `action` tailors the wording.
function _calEditScope(action) {
  const verb = action === 'delete' ? 'delete' : 'save';
  // Two-step so the user gets a genuine three-way choice (this / all / cancel)
  // out of the browser's two-button confirm.
  const onlyThis = confirm(
    `This is a repeating event.\n\n` +
    `• Click OK to ${verb} ONLY this date's event.\n` +
    `• Click Cancel to choose "all events in the series" (or to back out).`
  );
  if (onlyThis) return 'one';
  const allSeries = confirm(
    `Apply to the WHOLE series?\n\n` +
    `• Click OK to ${verb} EVERY event in this repeating series.\n` +
    `• Click Cancel to back out and change nothing.`
  );
  return allSeries ? 'all' : null;
}

async function deleteCalEntry() {
  if (!calEditingEntry) return;
  const entry = calEditingEntry.entry;
  const isRecurring = entry?.recurrence && entry.recurrence.freq;

  try {
    if (calEditingEntry.isPersonal) {
      // Personal recurring events get the same this/all choice.
      if (isRecurring) {
        const scope = await _calEditScope('delete');
        if (scope === null) return;
        const idx = personalCalendarEntries.findIndex(e => e.id === entry.id);
        if (idx < 0) return;
        if (scope === 'one') {
          const occISO = calEditingEntry.occurrenceDate || entry.date;
          const ex = new Set((personalCalendarEntries[idx].recurrence?.exceptions) || []);
          ex.add(occISO);
          personalCalendarEntries[idx] = {
            ...personalCalendarEntries[idx],
            recurrence: { ...personalCalendarEntries[idx].recurrence, exceptions: [...ex] },
          };
        } else {
          personalCalendarEntries = personalCalendarEntries.filter(e => e.id !== entry.id);
        }
      } else {
        if (!confirm('Delete this event?')) return;
        personalCalendarEntries = personalCalendarEntries.filter(e => e.id !== entry.id);
      }
      await savePersonalCalendarEntries();
    } else {
      if (isRecurring) {
        const scope = await _calEditScope('delete');
        if (scope === null) return;
        const idx = calendarEntries.findIndex(e => e.id === entry.id);
        if (idx < 0) return;
        if (scope === 'one') {
          // Delete just this date → add an exception so the series skips it.
          const occISO = calEditingEntry.occurrenceDate || entry.date;
          const ex = new Set((calendarEntries[idx].recurrence?.exceptions) || []);
          ex.add(occISO);
          calendarEntries[idx] = {
            ...calendarEntries[idx],
            recurrence: { ...calendarEntries[idx].recurrence, exceptions: [...ex] },
          };
        } else {
          // Delete the whole series.
          calendarEntries = calendarEntries.filter(e => e.id !== entry.id);
        }
      } else {
        if (!confirm('Delete this event?')) return;
        calendarEntries = calendarEntries.filter(e => e.id !== entry.id);
      }
      await saveCalendarEntries();
    }
    document.getElementById('cal-entry-overlay').style.display = 'none';
    renderCalendarView(getCalTarget());
  } catch(e) { showToast('Failed to delete event.', 'warn'); console.error(e); }
}

// Admin calendar view (inside admin screen)
function switchAdminTab(tab) {
  const managerRestricted = ['data', 'members', 'alerts', 'checklist'];
  if (currentUser?.role === 'manager' && managerRestricted.includes(tab)) tab = 'dashboard';

  const tabs = ['dashboard', 'calendar', 'data', 'members', 'reports', 'alerts', 'checklist'];
  tabs.forEach(t => {
    const el = document.getElementById('admin-tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });

  // Update sidebar nav active state
  document.querySelectorAll('.nav-item').forEach(b => {
    if (b.id && b.id.startsWith('navbtn-')) b.classList.remove('active');
  });
  const navBtn = document.getElementById('navbtn-' + tab);
  if (navBtn) navBtn.classList.add('active');

  // Also update legacy tab btn class if present
  document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
  const legacyBtn = document.getElementById('atab-' + tab);
  if (legacyBtn) legacyBtn.classList.add('active');

  if (tab === 'calendar') {
    renderCalendarView(document.getElementById('admin-calendar-host'));
  }
  if (tab === 'data') {
    _rspKitCheckData = [];
    renderDataTab();
  }
  if (tab === 'members') {
    renderMembersTab();
  }
  if (tab === 'alerts') {
    renderAlertsTab();
  }
  if (tab === 'reports') {
    renderReportTab();
  }
  if (tab === 'dashboard') {
    renderAdminView(true);
  }
  if (tab === 'checklist') {
    renderChecklistTab();
  }
}

async function renderMembersTab() {
  // ── Members list: Team Leads (+ their groups) goes in #data-members-list,
  // regular individual Members go in their own #data-regular-members-list
  // card — these are two separate containers in the HTML, so each needs to
  // be filled independently or the second one is left permanently empty. ──
  const membEl = document.getElementById('data-members-list');
  const regEl  = document.getElementById('data-regular-members-list');
  if (!membEl) return;
  try {
    const nonAdmins = Object.values(members).filter(m => m.role !== 'admin')
      .sort((a, b) => (a.name || a.username || '').localeCompare(b.name || b.username || ''));

    const managers = nonAdmins.filter(m => m.role === 'manager');
    const teamLeads = nonAdmins.filter(m => m.role === 'team_lead');
    const regularMembers = nonAdmins.filter(m => m.role !== 'team_lead' && m.role !== 'manager');

    // Fetch checklist data for TL compliance dashboard
    let allChecklists = {};
    try {
      const checkSnap = await db.collection('checklists').get();
      checkSnap.forEach(doc => { allChecklists[doc.id] = doc.data(); });
    } catch(e) {}

    // Campaigns can use a non-default checklist template — resolve each
    // campaign's real total item count (see resolveCampaignTotalItems).
    const dataTabTotalItemsMap = await resolveCampaignTotalItems(Object.values(campaigns));

    let tlHtml = '';
    let mgrHtml = '';

  // ── Filter input (filters rows in BOTH cards at once) ──
  tlHtml += `
    <div style="padding:8px 0 10px;">
      <input type="text" id="data-member-filter" placeholder="Filter by name or username…"
        oninput="filterDataMemberList(this.value)"
        style="width:100%;box-sizing:border-box;font-size:13px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);" />
    </div>`;

  // ── Managers section (admin only — a manager viewing this screen is
  // already scoped to their own team leads via `members`, so they'd never
  // see other managers here anyway; skip building it to save the work) ──
  if (currentUser?.role === 'admin' && managers.length > 0) {
    mgrHtml += `<div class="data-member-section-label" style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;padding:4px 0 6px;">Managers</div>`;
    mgrHtml += managers.map(mgr => {
      const managedTlUids = mgr.managedUids || [];
      const managedTls = managedTlUids.map(uid => members[uid]).filter(Boolean);

      // Aggregate scope: the manager's team leads + every member each of
      // those team leads manages (mirrors computeManagerScopedUids).
      let scopedUids = [];
      managedTls.forEach(tl => {
        scopedUids.push(tl.uid);
        (tl.managedUids || []).forEach(u => scopedUids.push(u));
      });
      scopedUids = [...new Set(scopedUids)];

      let mgrComplete = 0, mgrInProgress = 0, mgrNotStarted = 0;
      scopedUids.forEach(uid => {
        const m = members[uid];
        if (!m) return;
        let bestPct = 0;
        Object.values(campaigns).forEach(camp => {
          if (!(camp.assignedUids || []).includes(uid)) return;
          const cl = (allChecklists[uid] || {})[camp.id] || {};
          getEntryBreakdown(cl, dataTabTotalItemsMap[camp.id]?.total, dataTabTotalItemsMap[camp.id]?.validIds, dataTabTotalItemsMap[camp.id]?.hasD5).forEach(eb => {
            if (eb.overallPct > bestPct) bestPct = eb.overallPct;
          });
        });
        if (bestPct === 100) mgrComplete++;
        else if (bestPct > 0) mgrInProgress++;
        else mgrNotStarted++;
      });
      const mgrTeamCount = scopedUids.length;
      const mgrRate = mgrTeamCount > 0 ? Math.round((mgrComplete / mgrTeamCount) * 100) : 0;
      const mgrRateColor = mgrRate === 100 ? '#059669' : mgrRate >= 50 ? '#D97706' : '#2563EB';
      const dashId = `mgr-dash-${mgr.uid}`;

      const tlListRows = managedTls.map(tl => {
        const cnt = (tl.managedUids || []).length;
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;">
          <span>${escHtml(tl.name || tl.username)} <span style="color:var(--text-muted);">(${cnt} member${cnt !== 1 ? 's' : ''})</span></span>
        </div>`;
      }).join('') || '<div style="color:var(--text-muted);font-size:12px;">No team leads assigned.</div>';

      return `
      <div class="data-list-row data-mgr-row" data-name="${escHtml((mgr.name || mgr.username || '').toLowerCase())}" data-username="${escHtml((mgr.username || '').toLowerCase())}" style="flex-direction:column;align-items:stretch;gap:0;padding:0;">
        <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;">
          <div style="flex:1;min-width:0;">
            <div class="data-row-title" style="display:flex;align-items:center;gap:6px;">
              ${escHtml(mgr.name || mgr.username)}
              <span class="manager-badge">Manager</span>
            </div>
            <div class="data-row-sub">@${escHtml(mgr.username)} · ${managedTlUids.length} team lead${managedTlUids.length !== 1 ? 's' : ''} · ${mgrTeamCount} people total · Compliance: <span style="color:${mgrRateColor};font-weight:600;">${mgrRate}%</span></div>
          </div>
          <button class="btn-ghost-light btn-sm" style="color:#7C3AED;border-color:#DDD6FE;" onclick="openEditMgrModal('${mgr.uid}')">✏️ Team Leads</button>
          <button class="btn-ghost-light btn-sm" style="font-size:11px;color:#7C3AED;border-color:#C4B5FD;" onclick="openAdminResetPassword('${mgr.uid}', '${(mgr.name || mgr.username).replace(/'/g,"\\'")}')">Reset Pwd</button>
          <button class="btn-ghost-light btn-sm" style="color:#DC2626;border-color:#FCA5A5;" onclick="deleteMember('${mgr.uid}','${(mgr.name||mgr.username).replace(/'/g,"\\'")}')">Remove</button>
          ${mgrTeamCount > 0 ? `<button class="btn-ghost-light btn-sm" style="font-size:11px;" onclick="toggleTlDash('${dashId}')">📊 View</button>` : ''}
        </div>
        ${mgrTeamCount > 0 ? `
        <div id="${dashId}" style="display:none;border-top:1px solid var(--border);padding:10px 14px;background:var(--surface2);">
          <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
            <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:#f0fdf4;color:#059669;border:1px solid #bbf7d0;">✓ ${mgrComplete} Complete</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:#fffbeb;color:#D97706;border:1px solid #fde68a;">⟳ ${mgrInProgress} In Progress</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:#fef2f2;color:#DC2626;border:1px solid #fecaca;">— ${mgrNotStarted} Not Started</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:0;">${tlListRows}</div>
        </div>` : ''}
      </div>`;
    }).join('');
  }

  // ── Team Leads section (each with the list of members in their group) ──
  if (teamLeads.length === 0) {
    tlHtml += '<div class="data-empty">No team leads yet.</div>';
  } else {
    tlHtml += `<div class="data-member-section-label" style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;padding:4px 0 6px;">Team Leads</div>`;
    tlHtml += teamLeads.map(tl => {
      const managedUids = tl.managedUids || [];
      const managedCount = managedUids.length;

      // Build per-member compliance mini-rows — includes the lead's OWN
      // checklist too (if they're assigned to any campaign themselves), so
      // a lead's compliance rate reflects their whole team, not just the
      // members they manage.
      const hasOwnAssignment = Object.values(campaigns).some(camp => (camp.assignedUids || []).includes(tl.uid));
      const complianceUids = hasOwnAssignment ? [...managedUids, tl.uid] : managedUids;
      const teamCount = complianceUids.length;

      let complianceRows = '';
      let tlComplete = 0, tlInProgress = 0, tlNotStarted = 0;
      complianceUids.forEach(uid => {
        const m = members[uid];
        if (!m) return;
        let bestPct = 0;
        Object.values(campaigns).forEach(camp => {
          if (!(camp.assignedUids || []).includes(uid)) return;
          const cl = (allChecklists[uid] || {})[camp.id] || {};
          getEntryBreakdown(cl, dataTabTotalItemsMap[camp.id]?.total, dataTabTotalItemsMap[camp.id]?.validIds, dataTabTotalItemsMap[camp.id]?.hasD5).forEach(eb => {
            if (eb.overallPct > bestPct) bestPct = eb.overallPct;
          });
        });
        if (bestPct === 100) tlComplete++;
        else if (bestPct > 0) tlInProgress++;
        else tlNotStarted++;
        const barColor = bestPct === 100 ? '#059669' : bestPct > 0 ? '#3B82F6' : '#E5E7EB';
        const isLeadRow = uid === tl.uid;
        complianceRows += `
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);">
            <div style="flex:1;font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(m.name || m.username)}${isLeadRow ? ' <span style="font-size:9px;color:var(--text-muted);font-weight:400;">(Team Lead)</span>' : ''}</div>
            <div style="flex:2;background:#F3F4F6;border-radius:4px;height:6px;overflow:hidden;">
              <div style="width:${bestPct}%;background:${barColor};height:100%;border-radius:4px;transition:width .3s;"></div>
            </div>
            <div style="font-size:11px;font-family:var(--mono);color:var(--text-muted);min-width:32px;text-align:right;">${bestPct}%</div>
          </div>`;
      });

      const dashId = `tl-dash-${tl.uid}`;
      const tlRate = teamCount > 0 ? Math.round((tlComplete / teamCount) * 100) : 0;
      const tlRateColor = tlRate === 100 ? '#059669' : tlRate >= 50 ? '#D97706' : '#2563EB';

      return `
      <div class="data-list-row data-tl-row" data-name="${escHtml((tl.name || tl.username || '').toLowerCase())}" data-username="${escHtml((tl.username || '').toLowerCase())}" style="flex-direction:column;align-items:stretch;gap:0;padding:0;">
        <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;">
          <div style="flex:1;min-width:0;">
            <div class="data-row-title" style="display:flex;align-items:center;gap:6px;">
              ${escHtml(tl.name || tl.username)}
              <span style="font-size:10px;background:#eff6ff;color:#2563eb;border-radius:4px;padding:1px 6px;">Team Lead</span>
            </div>
            <div class="data-row-sub">@${escHtml(tl.username)} · ${managedCount} member${managedCount !== 1 ? 's' : ''} · Compliance: <span style="color:${tlRateColor};font-weight:600;">${tlRate}%</span>${hasOwnAssignment ? ' <span style="font-size:10px;color:var(--text-muted);">(incl. lead)</span>' : ''}</div>
          </div>
          <button class="btn-ghost-light btn-sm" style="color:#2563eb;border-color:#bfdbfe;" onclick="openEditTlModal('${tl.uid}')">✏️ Members</button>
          <button class="btn-ghost-light btn-sm" style="font-size:11px;color:#7C3AED;border-color:#C4B5FD;" onclick="openAdminResetPassword('${tl.uid}', '${(tl.name || tl.username).replace(/'/g,"\\'")}')">Reset Pwd</button>
          <button class="btn-ghost-light btn-sm" style="color:#DC2626;border-color:#FCA5A5;" onclick="deleteMember('${tl.uid}','${(tl.name||tl.username).replace(/'/g,"\\'")}')">Remove</button>
          ${teamCount > 0 ? `<button class="btn-ghost-light btn-sm" style="font-size:11px;" onclick="toggleTlDash('${dashId}')">📊 View</button>` : ''}
        </div>
        ${teamCount > 0 ? `
        <div id="${dashId}" style="display:none;border-top:1px solid var(--border);padding:10px 14px;background:var(--surface2);">
          <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
            <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:#f0fdf4;color:#059669;border:1px solid #bbf7d0;">✓ ${tlComplete} Complete</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:#fffbeb;color:#D97706;border:1px solid #fde68a;">⟳ ${tlInProgress} In Progress</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:#fef2f2;color:#DC2626;border:1px solid #fecaca;">— ${tlNotStarted} Not Started</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:0;">${complianceRows || '<div style="color:var(--text-muted);font-size:12px;">No members assigned.</div>'}</div>
        </div>` : ''}
      </div>`;
    }).join('');
  }

  membEl.innerHTML = tlHtml;
  const mgrEl = document.getElementById('data-managers-list');
  if (mgrEl) mgrEl.innerHTML = mgrHtml;

  // ── Regular members — rendered into their own card/container ──
  let regHtml = '';
  if (regularMembers.length === 0) {
    regHtml = '<div class="data-empty">No individual members yet.</div>';
  } else {
    regHtml += `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--border);margin-bottom:4px;">
        <input type="checkbox" id="data-members-select-all" style="accent-color:var(--blue);width:15px;height:15px;cursor:pointer;"
          onchange="toggleSelectAllDataMembers(this.checked)" title="Select all members" />
        <label for="data-members-select-all" style="font-size:11px;font-weight:600;color:var(--text-muted);cursor:pointer;text-transform:uppercase;letter-spacing:.05em;">Select All</label>
      </div>`;
    regHtml += regularMembers.map(m => `
      <div class="data-list-row data-reg-row" id="data-mrow-${m.uid}"
        data-name="${escHtml((m.name || m.username || '').toLowerCase())}" data-username="${escHtml((m.username || '').toLowerCase())}">
        <input type="checkbox" class="data-member-cb" value="${m.uid}" style="accent-color:var(--blue);width:15px;height:15px;cursor:pointer;flex-shrink:0;"
          onchange="onDataMemberCheckChange()" />
        <div style="flex:1;min-width:0;">
          <div class="data-row-title">${escHtml(m.name || m.username)}</div>
          <div class="data-row-sub">@${escHtml(m.username)}</div>
        </div>
        <button class="btn-ghost-light btn-sm" style="font-size:11px;color:#7C3AED;border-color:#C4B5FD;" onclick="openAdminResetPassword('${m.uid}', '${(m.name || m.username).replace(/'/g,"\\'")}')">Reset Pwd</button>
        <button class="btn-ghost-light btn-sm" style="color:#DC2626;border-color:#FCA5A5;"
          onclick="deleteMember('${m.uid}','${(m.name||m.username).replace(/'/g,"\'")}')">Remove</button>
      </div>`).join('');
  }

  if (regEl) regEl.innerHTML = regHtml;
  } catch (e) {
    console.error('renderMembersTab failed:', e);
    membEl.innerHTML = '<div class="data-empty">Failed to load members. Please refresh and try again.</div>';
    if (regEl) regEl.innerHTML = '';
  }
}

async function renderDataTab() {
  // ── Campaigns list ──
  const campEl = document.getElementById('data-campaigns-list');
  const campList = Object.values(campaigns);
  if (campList.length === 0) {
    campEl.innerHTML = '<div class="data-empty">No campaigns yet.</div>';
  } else {
    campEl.innerHTML = campList.map(c => {
      const assignedNames = (c.assignedUids || []).map(uid => {
        const m = members[uid];
        return m ? (m.name || m.username) : uid;
      }).join(', ') || '—';
      return `
        <div class="data-list-row">
          <div>
            <div class="data-row-title">${escHtml(c.name)}</div>
            <div class="data-row-sub">Members: ${escHtml(assignedNames)}</div>
          </div>
          <button class="btn-ghost-light btn-sm" onclick="openEditCampaignModal('${c.id}')" title="Edit campaign">✏️ Edit</button>
          <button class="btn-ghost-light btn-sm" onclick="duplicateCampaign('${c.id}')" title="Duplicate campaign">⧉ Clone</button>
          <button class="btn-ghost-light btn-sm" style="color:#D97706;border-color:#fde68a;" onclick="archiveCampaign('${c.id}','${escHtml(c.name).replace(/'/g,"\\'")}')" title="Archive campaign (downloads a summary first)">📦 Archive</button>
          <button class="btn-ghost-light btn-sm" style="color:#DC2626;border-color:#FCA5A5;" onclick="deleteCampaign('${c.id}','${escHtml(c.name).replace(/'/g,"\\'")}')" title="Delete campaign">🗑 Delete</button>
        </div>`;
    }).join('');
  }

  renderArchivedCampaignsList();

  // ── Members list now lives in the dedicated Members tab (see renderMembersTab) ──

  // ── Checklists list ──
  const clEl = document.getElementById('data-checklists-list');
  try {
    const checkSnap = await db.collection('checklists').get();
    const allChecklists = {};
    checkSnap.forEach(doc => { allChecklists[doc.id] = doc.data(); });

    // Campaigns can use a non-default checklist template — resolve each
    // campaign's real total item count (see resolveCampaignTotalItems).
    const clTotalItemsMap = await resolveCampaignTotalItems(Object.values(campaigns));

    let rows = [];
    Object.values(campaigns).forEach(camp => {
      (camp.assignedUids || []).forEach(uid => {
        const member = members[uid];
        if (!member) return;
        const cl = (allChecklists[uid] || {})[camp.id] || {};
        // One row per entry — see getEntryBreakdown for why.
        getEntryBreakdown(cl, clTotalItemsMap[camp.id]?.total, clTotalItemsMap[camp.id]?.validIds, clTotalItemsMap[camp.id]?.hasD5).forEach(eb => {
          rows.push({ member, camp, entryLabel: eb.label, d5Done: eb.d5Done, d1Done: eb.d1Done, d5Pct: eb.d5Pct, d1Pct: eb.d1Pct, totalItems: eb.totalItems, hasD5: eb.hasD5, cl });
        });
      });
    });

    if (rows.length === 0) {
      clEl.innerHTML = '<div class="data-empty">No checklist progress recorded yet.</div>';
    } else {
      clEl.innerHTML = `<table class="data-cl-table">
        <thead><tr>
          <th>Member</th><th>Campaign</th>
          <th>D-5</th><th>D-1</th><th>Last Active</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows.map(r => {
          const lastStr = r.cl.lastActive
            ? new Date(r.cl.lastActive).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
            : '—';
          return `<tr>
            <td><strong>${escHtml(r.member.name || r.member.username)}</strong><br>
              <span style="font-size:11px;color:var(--text-muted)">@${escHtml(r.member.username)}</span></td>
            <td>${escHtml(r.camp.name)}${r.entryLabel ? ` <span style="font-size:11px;color:var(--text-muted);">· ${escHtml(r.entryLabel)}</span>` : ''}</td>
            <td>${r.hasD5 === false ? '<span style="color:var(--text-muted);font-size:11px;">N/A</span>' : `${miniBar(r.d5Pct)} ${r.d5Done}/${r.totalItems}`}</td>
            <td>${miniBar(r.d1Pct)} ${r.d1Done}/${r.totalItems}</td>
            <td style="font-size:12px;color:var(--text-muted)">${lastStr}</td>
            <td style="white-space:nowrap;">
              <button class="btn-link" onclick="openReviewModal('${r.member.uid}','${r.camp.id}')">Review</button>
              <button class="btn-link" style="color:#DC2626;margin-left:8px;"
                onclick="openDeleteClModal('${r.member.uid}','${r.camp.id}','${(r.member.name||r.member.username).replace(/'/g,"\'")}')">Delete</button>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    }
  } catch(e) {
    console.error('Error loading checklists:', e);
    if (clEl) clEl.innerHTML = '<div class="data-empty">Error loading checklist data.</div>';
  }
}

// ── Data tab: toggle team lead compliance dashboard ──────────
function toggleTlDash(dashId) {
  const el = document.getElementById(dashId);
  if (!el) return;
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : 'block';
  // Update button label
  const btn = el.previousElementSibling?.querySelector('button:last-child');
  if (btn) btn.textContent = isOpen ? '📊 View' : '📊 Hide';
}

// ── Data tab: filter members list by name / username ─────────
function filterDataMemberList(query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll('.data-mgr-row').forEach(row => {
    const name = row.dataset.name || '';
    const user = row.dataset.username || '';
    row.style.display = (!q || name.includes(q) || user.includes(q)) ? '' : 'none';
  });
  document.querySelectorAll('.data-tl-row').forEach(row => {
    const name = row.dataset.name || '';
    const user = row.dataset.username || '';
    row.style.display = (!q || name.includes(q) || user.includes(q)) ? '' : 'none';
  });
  document.querySelectorAll('.data-reg-row').forEach(row => {
    const name = row.dataset.name || '';
    const user = row.dataset.username || '';
    row.style.display = (!q || name.includes(q) || user.includes(q)) ? '' : 'none';
  });
  // Show/hide the "Team Leads" section label based on whether any team
  // lead row is still visible.
  const tlVisible = [...document.querySelectorAll('.data-tl-row')].some(r => r.style.display !== 'none');
  document.querySelectorAll('.data-member-section-label').forEach(el => {
    el.style.display = tlVisible ? '' : 'none';
  });
}

// ── Data tab: bulk member select/remove ──────────────────────
function toggleSelectAllDataMembers(checked) {
  document.querySelectorAll('.data-member-cb').forEach(cb => { cb.checked = checked; });
  onDataMemberCheckChange();
}

function onDataMemberCheckChange() {
  const checked = document.querySelectorAll('.data-member-cb:checked');
  const btn = document.getElementById('remove-selected-members-btn');
  if (btn) btn.style.display = checked.length > 0 ? 'inline-flex' : 'none';
  // Sync the select-all checkbox state
  const all = document.querySelectorAll('.data-member-cb');
  const selectAll = document.getElementById('data-members-select-all');
  if (selectAll) selectAll.checked = all.length > 0 && checked.length === all.length;
}

async function removeSelectedMembers() {
  const checked = [...document.querySelectorAll('.data-member-cb:checked')];
  if (checked.length === 0) return;
  const names = checked.map(cb => {
    const m = members[cb.value];
    return m ? (m.name || m.username) : cb.value;
  });
  if (!confirm(`Remove ${checked.length} member(s)?\n\n${names.join(', ')}\n\nThey will lose access immediately.`)) return;
  const btn = document.getElementById('remove-selected-members-btn');
  if (btn) { btn.textContent = 'Removing…'; btn.disabled = true; }
  let done = 0, failed = 0;
  for (const cb of checked) {
    try {
      await db.collection('users').doc(cb.value).delete();
      delete members[cb.value];
      done++;
    } catch(e) { failed++; console.error(e); }
  }
  if (btn) { btn.textContent = '🗑 Remove Selected'; btn.disabled = false; btn.style.display = 'none'; }
  if (done > 0) showToast(`✅ Removed ${done} member(s)${failed ? ', '+failed+' failed' : ''}.`, 'success');
  else showToast('Failed to remove members. Try again.', 'warn');
  renderMembersTab();
}

let _rspKitCheckData = []; // cache for filtering
let _rspKitGroupRegistry = []; // per-render lookup so onclick attrs only need a plain integer key (see renderRspKitList)
let _rspKitActiveFilter = 'all'; // currently selected status filter button, tracked separately from "reload"

async function renderRspKitList(filter, forceReload) {
  const el = document.getElementById('data-rsp-kit-list');
  if (!el) return;
  el.innerHTML = '<div class="data-empty">Loading…</div>';
  _rspKitGroupRegistry = [];

  try {
    if (_rspKitCheckData.length === 0 || forceReload) {
      const snap = await db.collection('taskChecks').orderBy('sentAt', 'desc').get();
      _rspKitCheckData = [];
      snap.forEach(doc => _rspKitCheckData.push({ id: doc.id, ...doc.data() }));
    }

    if (_rspKitCheckData.length === 0) {
      el.innerHTML = '<div class="data-empty">No task checks sent yet. Click "+ Send Check" to get started.</div>';
      return;
    }

    // Group individual per-member taskChecks back into one logical "send"
    // action, the same way Campaigns shows one row covering every assigned
    // member. New sends are tagged with a shared batchId (see
    // sendTaskCheck); older data without one falls back to grouping by
    // title + campaign + same-minute timestamp, since a single "Send Check"
    // click creates all its per-member docs within the same minute.
    const groups = {};
    const groupOrder = [];
    _rspKitCheckData.forEach(tc => {
      const key = tc.batchId || `legacy_${tc.title}|${tc.campaignId || ''}|${(tc.sentAt || '').slice(0, 16)}`;
      if (!groups[key]) { groups[key] = []; groupOrder.push(key); }
      groups[key].push(tc);
    });

    // For each group, load responses and compute member statuses
    let html = '';
    for (const key of groupOrder) {
      const group = groups[key];
      const tc = group[0]; // representative doc for title/campaign/date display

      const allTargetMembers = [];
      for (const doc of group) {
        const members_ = doc.targetUid
          ? [members[doc.targetUid]].filter(Boolean)
          : Object.values(members).filter(m => m.role !== 'admin');
        members_.forEach(m => { if (!allTargetMembers.some(x => x.uid === m.uid)) allTargetMembers.push(m); });
      }

      // Compute per-member overall status (used for the status filter buttons),
      // pulling each member's response from whichever doc in the group targets them.
      const memberStatuses = await Promise.all(allTargetMembers.map(async m => {
        const owningDoc = group.find(d => !d.targetUid || d.targetUid === m.uid) || group[0];
        const respDoc = await db.collection('taskCheckResponses').doc(owningDoc.id).collection('responses').doc(m.uid).get();
        const r = respDoc.exists ? respDoc.data() : {};
        const statuses = owningDoc.items.map(item => (r.items || {})[item.id] || 'pending');
        const allDone  = statuses.every(rspIsDoneLike);
        const anyProg  = statuses.some(s => s === 'in-progress' || rspIsDoneLike(s));
        const overall  = allDone ? 'done' : anyProg ? 'in-progress' : 'pending';
        return { m, overall };
      }));

      // Apply filter
      const filtered = filter === 'all' ? memberStatuses : memberStatuses.filter(ms => ms.overall === filter);
      if (filtered.length === 0) continue;

      const dt = new Date(tc.sentAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
      const groupIds = group.map(d => d.id);

      // Register this group's data and reference it by a plain integer key
      // in the onclick attributes below, instead of embedding raw
      // JSON/strings inline — titles or campaign names containing an
      // apostrophe would otherwise break out of the onclick='...' attribute
      // and silently no-op the button (this was the "delete isn't working" bug).
      const regKey = _rspKitGroupRegistry.push({ groupIds, title: tc.title }) - 1;

      // Match the Campaigns card style: one row per "send" action, with the
      // assigned member names listed right below the title, and a single
      // Delete button that removes every underlying doc in the group at once.
      const assignedNames = allTargetMembers.map(m => m.name || m.username).join(', ') || '—';
      html += `<div class="data-list-row">
        <div style="min-width:0;flex:1;">
          <div class="data-row-title">📦 ${escHtml(tc.title)}${tc.campaignName ? ` <span style="font-weight:400;color:var(--text-muted);">· ${escHtml(tc.campaignName)}</span>` : ''}</div>
          <div class="data-row-sub">Members: ${escHtml(assignedNames)}</div>
          <div class="data-row-sub">${dt}</div>
        </div>
        <button class="btn-ghost-light btn-sm" onclick="openTaskCheckTrackerGroup(${regKey})">View All</button>
        <button class="btn-ghost-light btn-sm admin-only" style="color:#0F766E;border-color:#5EEAD4;" onclick="openEditTaskCheckGroup(${regKey})">✏️ Edit</button>
        <button class="btn-ghost-light btn-sm" style="color:#DC2626;border-color:#FCA5A5;" onclick="deleteTaskCheckGroup(${regKey})">🗑 Delete</button>
      </div>`;
    }

    el.innerHTML = html || '<div class="data-empty">No results match this filter.</div>';
  } catch(e) {
    el.innerHTML = '<div class="data-empty">Error loading RSP & Kit data.</div>';
    console.error(e);
  }
}

function filterRspKitList(btn, filter) {
  document.querySelectorAll('.rsp-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _rspKitActiveFilter = filter;
  renderRspKitList(filter);
}

// Opens the tracker for the first check in a group; "View All" on a grouped
// row is mainly a quick peek, so showing the first member's doc covers the
// common case without building a separate multi-doc tracker view.
function openTaskCheckTrackerGroup(regKey) {
  const entry = _rspKitGroupRegistry[regKey];
  if (!entry) return;
  openTaskCheckTracker(entry.groupIds[0]);
}

// ── Admin: Edit an already-sent RSP & Kit Check group ──────────────────
// Reuses the "Send Task Check" modal in an "edit" mode: pre-fills title,
// items, campaign, targeted entries and member selection from the group's
// existing docs, then repoints the Save button at saveTaskCheckEdit()
// instead of sendTaskCheck() so nothing is duplicated.
function openEditTaskCheckGroup(regKey) {
  if (currentUser?.role !== 'admin') return; // admin-only, per RSP & Kit edit access
  const entry = _rspKitGroupRegistry[regKey];
  if (!entry) return;
  openTaskCheckModalForEdit(entry.groupIds);
}

async function openTaskCheckModalForEdit(groupIds) {
  const docs = _rspKitCheckData.filter(tc => groupIds.includes(tc.id));
  if (!docs.length) return;
  const rep = docs[0]; // representative doc for shared fields (title/items/campaign/entries)

  _taskCheckItems = (rep.items || []).map(i => ({ ...i }));
  renderTaskCheckItemsList();

  // Populate campaigns dropdown, then select the group's campaign (if any)
  const campSel = document.getElementById('tc-campaign-sel');
  campSel.innerHTML = '<option value="">All campaigns</option>';
  Object.values(campaigns).forEach(c => {
    campSel.innerHTML += `<option value="${c.id}">${escHtml(c.name)}</option>`;
  });
  campSel.value = rep.campaignId || '';
  campSel.onchange = function() {
    const campName = this.options[this.selectedIndex].text;
    const base = 'Kit & RSP Check';
    document.getElementById('tc-title').value = this.value ? `${base} — ${campName}` : base;
    tcLoadEntriesForCampaign(this.value);
  };

  // Populate member chips, pre-selecting whoever this group currently targets.
  // A group with a doc that has no targetUid means it was sent to "All
  // members" — leave every chip unselected, matching the create-flow
  // convention where an empty selection means "everyone".
  const wasSentToAll = docs.some(d => !d.targetUid);
  const targetedUids = docs.filter(d => d.targetUid).map(d => d.targetUid);
  const chipWrap = document.getElementById('tc-member-chips');
  const nonAdmins = Object.values(members).filter(m => m.role !== 'admin');
  chipWrap.innerHTML = nonAdmins.length === 0
    ? '<div style="color:var(--text-muted);font-size:13px;">No members yet.</div>'
    : nonAdmins.map(m =>
        `<div class="member-chip${(!wasSentToAll && targetedUids.includes(m.uid)) ? ' selected' : ''}" data-uid="${m.uid}" onclick="toggleChip(this)" title="@${escHtml(m.username)}">${escHtml(m.name || m.username)}</div>`
      ).join('');
  const saBtn = document.getElementById('tc-select-all-btn');
  if (saBtn) saBtn.textContent = 'Select All';

  document.getElementById('tc-title').value = rep.title;
  document.getElementById('tc-error').style.display = 'none';

  // Entry targeting (brand/platform/region), if this group's campaign has any
  _tcSelectedEntries = rep.entries || [];
  const entriesField = document.getElementById('tc-entries-field');
  if (rep.campaignId) {
    await tcLoadEntriesForCampaign(rep.campaignId);
    document.querySelectorAll('#tc-entries-chips .member-chip').forEach(chip => {
      const match = _tcSelectedEntries.some(e =>
        (e.brand || '') === (chip.dataset.brand || '') &&
        (e.platform || '') === (chip.dataset.platform || '') &&
        (e.region || '') === (chip.dataset.region || ''));
      if (match) chip.classList.add('selected');
    });
  } else if (entriesField) {
    entriesField.style.display = 'none';
  }

  // Switch the modal chrome into "edit" mode
  const overlay = document.getElementById('taskcheck-overlay');
  overlay.dataset.editGroupIds = JSON.stringify(groupIds);
  const titleEl = document.getElementById('taskcheck-modal-title');
  if (titleEl) titleEl.textContent = '✏️ Edit Task Check';
  const subtitleEl = document.getElementById('taskcheck-modal-subtitle');
  if (subtitleEl) subtitleEl.textContent = 'Update the title, items, or who this check is sent to. Members who keep their assignment keep their existing progress.';
  const saveBtn = document.getElementById('taskcheck-save-btn');
  if (saveBtn) { saveBtn.textContent = '💾 Save Changes'; saveBtn.setAttribute('onclick', 'saveTaskCheckEdit()'); }

  overlay.style.display = 'flex';
}

// Saves edits to an existing RSP & Kit Check group. Members who remain
// targeted keep their existing taskCheckResponses (so in-progress/done
// status isn't lost just because the admin tweaked the title or added an
// item); members removed from targeting have their doc + responses
// deleted, and newly-added members get a fresh doc + notification, the
// same way a brand-new send works.
async function saveTaskCheckEdit() {
  const overlay = document.getElementById('taskcheck-overlay');
  const groupIds = JSON.parse(overlay.dataset.editGroupIds || '[]');
  const errEl = document.getElementById('tc-error');
  errEl.style.display = 'none';
  if (!groupIds.length) return;

  const title  = document.getElementById('tc-title').value.trim();
  const campId = document.getElementById('tc-campaign-sel').value;
  if (!title) { showError(errEl, 'Please enter a title.'); return; }
  const validItems = _taskCheckItems.filter(i => i.label.trim());
  if (validItems.length === 0) { showError(errEl, 'Please add at least one check item.'); return; }

  const selectedChips = [...document.querySelectorAll('#tc-member-chips .member-chip.selected')];
  const selectedUids  = selectedChips.map(c => c.dataset.uid);
  const sendToAll     = selectedUids.length === 0;
  const campName      = campId ? campaigns[campId]?.name : null;
  const targetEntries = campId ? _tcSelectedEntries : [];
  const commonFields  = { title, items: validItems, campaignId: campId || null, campaignName: campName || null, entries: targetEntries };

  const saveBtn = document.getElementById('taskcheck-save-btn');
  const prevLabel = saveBtn ? saveBtn.textContent : '';
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }

  try {
    const docs      = _rspKitCheckData.filter(tc => groupIds.includes(tc.id));
    const batchId   = docs.find(d => d.batchId)?.batchId || `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const wasAll    = docs.some(d => !d.targetUid);

    async function addMemberDoc(uid) {
      const m = members[uid];
      if (!m) return;
      const memberName = m.name || m.username;
      const ref = await db.collection('taskChecks').add({
        ...commonFields, sentAt: new Date().toISOString(), sentBy: 'Admin',
        targetUid: uid, targetName: memberName, batchId,
      });
      await db.collection('broadcasts').add({
        type: 'taskcheck',
        message: `📦 Task Check updated: "${title}" — please review and update your status.`,
        targetUid: uid, targetName: memberName,
        campaignId: campId || null, campaignName: campName || null,
        sentAt: new Date().toISOString(), sentBy: 'Admin', readBy: [],
        taskCheckId: ref.id,
      });
    }

    async function removeMemberDoc(docId) {
      const respSnap = await db.collection('taskCheckResponses').doc(docId).collection('responses').get();
      for (const r of respSnap.docs) await r.ref.delete();
      await db.collection('taskCheckResponses').doc(docId).delete().catch(() => {});
      await db.collection('taskChecks').doc(docId).delete();
    }

    if (wasAll && sendToAll) {
      // Still targeting everyone — just update the single shared doc.
      const allDoc = docs.find(d => !d.targetUid);
      await db.collection('taskChecks').doc(allDoc.id).update(commonFields);
    } else if (!wasAll && !sendToAll) {
      // Per-member before and after — diff the membership.
      const existingUidToDoc = {};
      docs.forEach(d => { if (d.targetUid) existingUidToDoc[d.targetUid] = d; });
      const existingUids = Object.keys(existingUidToDoc);
      const toRemove = existingUids.filter(u => !selectedUids.includes(u));
      const toAdd    = selectedUids.filter(u => !existingUids.includes(u));
      const toKeep   = existingUids.filter(u => selectedUids.includes(u));

      for (const uid of toKeep)   await db.collection('taskChecks').doc(existingUidToDoc[uid].id).update(commonFields);
      for (const uid of toRemove) await removeMemberDoc(existingUidToDoc[uid].id);
      for (const uid of toAdd)    await addMemberDoc(uid);
    } else if (wasAll && !sendToAll) {
      // Switching from "All members" to specific members.
      const allDoc = docs.find(d => !d.targetUid);
      await removeMemberDoc(allDoc.id);
      for (const uid of selectedUids) await addMemberDoc(uid);
    } else {
      // Switching from specific members to "All members".
      for (const d of docs) { if (d.targetUid) await removeMemberDoc(d.id); }
      const ref = await db.collection('taskChecks').add({
        ...commonFields, sentAt: new Date().toISOString(), sentBy: 'Admin',
        targetUid: null, targetName: 'All members',
      });
      await db.collection('broadcasts').add({
        type: 'taskcheck',
        message: `📦 Task Check updated: "${title}" — please review and update your status.`,
        targetUid: null, targetName: 'All members',
        campaignId: campId || null, campaignName: campName || null,
        sentAt: new Date().toISOString(), sentBy: 'Admin', readBy: [],
        taskCheckId: ref.id,
      });
    }

    showToast(`✅ Task Check "${title}" updated.`, 'success');
    overlay.style.display = 'none';
    delete overlay.dataset.editGroupIds;
    renderRspKitList(_rspKitActiveFilter, true);
  } catch (e) {
    showError(errEl, 'Failed to save changes.');
    console.error(e);
  } finally {
    if (saveBtn) { saveBtn.textContent = prevLabel || '💾 Save Changes'; saveBtn.disabled = false; }
  }
}

// Deletes every taskCheck doc (+ responses + linked broadcast) in a group
// with a single confirmation — this is the "1 delete button" the Campaigns
// list already has, applied to RSP & Kit Checking batches.
async function deleteTaskCheckGroup(regKeyOrIds, titleIfRaw) {
  // Accepts either a registry key (normal path, from the rendered list) or
  // a raw [groupIds, title] pair (used by the legacy deleteTaskCheck shim below).
  let groupIds, title;
  if (Array.isArray(regKeyOrIds)) { groupIds = regKeyOrIds; title = titleIfRaw; }
  else {
    const entry = _rspKitGroupRegistry[regKeyOrIds];
    if (!entry) { showToast('Could not find that task check — please refresh and try again.', 'error'); return; }
    groupIds = entry.groupIds; title = entry.title;
  }

  const memberCount = groupIds.length;
  if (!confirm(`Delete the task check "${title}"?\n\nThis will permanently remove the task check for all ${memberCount} assigned member(s), their responses, and the linked broadcast message(s). This cannot be undone.`)) return;
  try {
    for (const checkId of groupIds) {
      const respSnap = await db.collection('taskCheckResponses').doc(checkId).collection('responses').get();
      const delBatch = db.batch();
      respSnap.forEach(d => delBatch.delete(d.ref));
      await delBatch.commit();

      await db.collection('taskCheckResponses').doc(checkId).delete();
      await db.collection('taskChecks').doc(checkId).delete();

      const bcastSnap = await db.collection('broadcasts').where('taskCheckId', '==', checkId).get();
      const bcastBatch = db.batch();
      bcastSnap.forEach(d => bcastBatch.delete(d.ref));
      await bcastBatch.commit();
    }

    showToast(`🗑 Task check "${title}" deleted.`, 'success');
    // Evict from cache and re-render — force a refetch, but keep showing
    // whichever status filter button was active (previously this passed
    // the literal string '__reload' as the filter itself, which doesn't
    // match any status and made the whole list vanish — looking like the
    // delete had silently failed even though the doc was actually removed).
    _rspKitCheckData = _rspKitCheckData.filter(tc => !groupIds.includes(tc.id));
    renderRspKitList(_rspKitActiveFilter, true);
    // Keep the admin dashboard "Kit & RSP Checking by Team Lead" panel in sync too
    if (document.getElementById('dash-taskcheck-panel')) renderTaskChecksInDashboard();
  } catch(e) {
    console.error(e);
    showToast('Failed to delete task check. Try again.', 'error');
  }
}

async function deleteTaskCheck(checkId, title) {
  return deleteTaskCheckGroup([checkId], title);
}

function renderAdminCalendarTab() {
  switchAdminTab('calendar');
}

// ─────────────────────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────────────────────
function showScreen(id) {
  ['login-screen', 'admin-screen', 'user-screen', 'teamlead-screen'].forEach(s => {
    const el = document.getElementById(s);
    if (!el) return;
    if (s !== id) { el.style.display = 'none'; return; }
    el.style.display = (s === 'login-screen') ? 'block' : 'flex';
  });
}

// ─────────────────────────────────────────────────────────────
//  SIDEBAR TOGGLE
// ─────────────────────────────────────────────────────────────
function toggleSidebar() {
  const sb = document.getElementById('admin-sidebar');
  if (sb) sb.classList.toggle('collapsed');
}

function toggleUserSidebar() {
  const sb = document.getElementById('user-sidebar');
  if (sb) sb.classList.toggle('collapsed');
}

function toggleTlSidebar() {
  const sb = document.getElementById('teamlead-sidebar');
  if (sb) sb.classList.toggle('collapsed');
}

// ─────────────────────────────────────────────────────────────
//  MEMBER PROGRESS IN SIDEBAR
// ─────────────────────────────────────────────────────────────
function updateUserSidebarProgress() {
  const isTl     = currentUser?.role === 'team_lead';
  const uiPrefix = isTl ? 'tl' : 'user';
  const campSrc  = isTl ? tlOwnCampaigns : campaigns;

  if (!selectedCampaignId) {
    const wrap = document.getElementById(`${uiPrefix}-sidebar-progress`);
    if (wrap) wrap.style.display = 'none';
    return;
  }
  const campData = userChecklist[selectedCampaignId] || {};
  const ids      = getCurrentValidItemIds();
  // Overall progress is based on D-1 inputs alone for every user — Done
  // and N/A are treated the same.
  const done     = countDone(campData.d1 || {}, ids);
  const entries  = getEntries();
  const total    = getTotalItems() * entries.length;
  const pct      = total > 0 ? Math.round((done / total) * 100) : 0;

  const wrap = document.getElementById(`${uiPrefix}-sidebar-progress`);
  if (wrap) wrap.style.display = 'block';

  const labelEl = document.getElementById(`${uiPrefix}-progress-label`);
  const pctEl   = document.getElementById(`${uiPrefix}-progress-pct`);
  const fillEl  = document.getElementById(`${uiPrefix}-progress-fill`);
  const campLbl = document.getElementById(`${uiPrefix}-sidebar-campaign-label`);

  if (labelEl) labelEl.textContent = `${done} / ${total} items`;
  if (pctEl)   pctEl.textContent   = `${pct}%`;
  if (fillEl)  fillEl.style.width  = `${pct}%`;
  if (campLbl) campLbl.textContent = campSrc[selectedCampaignId]?.name || '';
}

// ─────────────────────────────────────────────────────────────
//  MEMBER TEAM OVERVIEW DASHBOARD
// ─────────────────────────────────────────────────────────────
async function renderUserDashboard() {
  const statsEl     = document.getElementById('user-team-stats');
  const breakdownEl = document.getElementById('user-team-campaign-breakdown');
  if (!statsEl || !breakdownEl) return;

  const isTl = currentUser.role === 'team_lead';

  // Plain members (non-admin, non-lead, non-manager) only ever see the
  // checklist(s) assigned to THEM — never other members' progress.
  const titleEl = document.getElementById('user-dashboard-title');
  const subEl   = document.getElementById('user-dashboard-sub');
  if (titleEl) titleEl.textContent = isTl ? 'Team Overview' : 'My Checklist';
  if (subEl)   subEl.textContent   = isTl ? "Your team's checklist progress at a glance" : 'Your checklist progress at a glance';

  statsEl.innerHTML     = `<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">Loading ${isTl ? 'team' : 'your'} data…</div>`;
  breakdownEl.innerHTML = '';

  try {
    // Fetch all checklists so we can compute team-wide stats
    const checkSnap = await db.collection('checklists').get();
    const allChecklists = {};
    checkSnap.forEach(doc => { allChecklists[doc.id] = doc.data(); });

    // Only include campaigns this user can see
    // Team leads use tlCampaigns (scoped to their team); members use global campaigns
    const myCampaigns = isTl
      ? Object.values(tlCampaigns || {})
      : Object.values(campaigns);
    if (myCampaigns.length === 0) {
      statsEl.innerHTML = `<div class="empty-state" style="padding:2rem;text-align:center;color:var(--text-muted);">No campaigns assigned yet.</div>`;
      return;
    }

    // Build aggregate rows across all campaigns this user can see
    let totalRows = 0, completeRows = 0, inProgressRows = 0, notStartedRows = 0;
    let overallRspTotal = 0, overallRspDone = 0;
    const campCards = [];

    // Campaigns can use a non-default checklist template — resolve each
    // campaign's real total item count (see resolveCampaignTotalItems).
    const dashTotalItemsMap = await resolveCampaignTotalItems(myCampaigns);

    // Fetch all RSP & Kit task checks + responses once, so each campaign
    // card below can show its own entry-aware completion rate.
    let dashTaskChecks = [];
    try {
      const tcSnap = await db.collection('taskChecks').get();
      dashTaskChecks = await Promise.all(tcSnap.docs.map(async d => {
        const respSnap = await db.collection('taskCheckResponses').doc(d.id).collection('responses').get();
        const responses = {};
        respSnap.forEach(r => { responses[r.id] = r.data(); });
        return { id: d.id, ...d.data(), responses };
      }));
    } catch(e) { /* non-blocking */ }

    for (const camp of myCampaigns) {
      const allAssigned = camp.assignedUids || [];
      // Team leads see their managed members; plain members see ONLY themselves.
      const managedUids = isTl ? (currentUser.managedUids || []) : [currentUser.uid];
      const assignedUids = allAssigned.filter(uid => managedUids.includes(uid));
      if (assignedUids.length === 0) continue;
      let cTotal = 0, cComplete = 0, cInProgress = 0, cNotStarted = 0;
      let d5DoneSum = 0, d1DoneSum = 0;
      const memberRows = [];

      // RSP & Kit rate for this campaign — counted per (member × entry) for
      // checks scoped to this campaign (respecting entry targeting).
      let campRspTotal = 0, campRspDone = 0;
      const campRspChecks = dashTaskChecks.filter(tc => tc.campaignId === camp.id);

      for (const uid of assignedUids) {
        const cl = (allChecklists[uid] || {})[camp.id] || {};
        // One "row" per entry — each entry has its own full checklist, so its
        // completion is computed individually against this campaign's actual
        // total item count rather than lumped together with other entries
        // (see getEntryBreakdown — campaigns can use a non-default template).
        getEntryBreakdown(cl, dashTotalItemsMap[camp.id]?.total, dashTotalItemsMap[camp.id]?.validIds, dashTotalItemsMap[camp.id]?.hasD5).forEach(eb => {
          cTotal++;
          if (eb.overallPct === 100)  cComplete++;
          else if (eb.overallPct > 0) cInProgress++;
          else                        cNotStarted++;
          d5DoneSum += eb.d5Done;
          d1DoneSum += eb.d1Done;
          memberRows.push({ uid, d5Pct: eb.d5Pct, d1Pct: eb.d1Pct, label: eb.label, hasD5: eb.hasD5 });
        });

        const entries = (cl.entries && cl.entries.length) ? cl.entries : [{ brand: '', platform: '', region: '' }];
        const checksForUid = campRspChecks.filter(tc => rspCheckAppliesToUser(tc, uid));
        if (checksForUid.length > 0) {
          entries.forEach(entry => {
            const checksForEntry = checksForUid.filter(tc => rspCheckAppliesToEntry(tc, entry));
            if (checksForEntry.length === 0) return;
            campRspTotal++;
            const allDone = checksForEntry.every(tc => rspEntryOverallStatus(tc, tc.responses[uid], rspEntryKey(entry)) === 'done');
            if (allDone) campRspDone++;
          });
        }
      }

      totalRows      += cTotal;
      completeRows   += cComplete;
      inProgressRows += cInProgress;
      notStartedRows += cNotStarted;
      overallRspTotal += campRspTotal;
      overallRspDone  += campRspDone;

      const campRate = cTotal > 0 ? Math.round((cComplete / cTotal) * 100) : 0;
      // Campaign-level rate — D-5 and D-1 aggregated across every row
      // (member × entry) for this campaign, computed SEPARATELY. This is
      // distinct from campRate above (which is "% of rows fully done").
      const campTi   = dashTotalItemsMap[camp.id]?.total || TOTAL_ITEMS;
      const campD5Pct = cTotal > 0 ? Math.round((d5DoneSum / (campTi * cTotal)) * 100) : 0;
      const campD1Pct = cTotal > 0 ? Math.round((d1DoneSum / (campTi * cTotal)) * 100) : 0;
      const campRspPct = campRspTotal > 0 ? Math.round((campRspDone / campRspTotal) * 100) : null;
      campCards.push({ camp, cTotal, cComplete, cInProgress, cNotStarted, campRate, campD5Pct, campD1Pct, campRspPct, memberRows });
    }

    // ── Overall stat cards ──
    const overallRate = totalRows > 0 ? Math.round((completeRows / totalRows) * 100) : 0;
    const rateColor   = overallRate === 100 ? '#059669' : overallRate >= 50 ? '#D97706' : '#2563EB';
    const overallRspRate  = overallRspTotal > 0 ? Math.round((overallRspDone / overallRspTotal) * 100) : null;
    const overallRspColor = overallRspRate === null ? 'var(--text-muted)' : overallRspRate === 100 ? '#059669' : overallRspRate >= 50 ? '#D97706' : '#2563EB';
    const overallRspDisplay = overallRspRate === null ? '—' : overallRspRate + '%';
    statsEl.innerHTML = `
      <div class="stat-card">
        <div class="label">Total Checklists</div>
        <div class="value blue">${totalRows}</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:100%;background:var(--blue);"></div></div>
      </div>
      <div class="stat-card">
        <div class="label">Complete</div>
        <div class="value green">${completeRows}</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${totalRows>0?Math.round(completeRows/totalRows*100):0}%;background:#059669;"></div></div>
      </div>
      <div class="stat-card">
        <div class="label">In Progress</div>
        <div class="value amber">${inProgressRows}</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${totalRows>0?Math.round(inProgressRows/totalRows*100):0}%;background:#D97706;"></div></div>
      </div>
      <div class="stat-card">
        <div class="label">Not Started</div>
        <div class="value red">${notStartedRows}</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${totalRows>0?Math.round(notStartedRows/totalRows*100):0}%;background:#DC2626;"></div></div>
      </div>
      <div class="stat-card">
        <div class="label">Completion Rate</div>
        <div class="value" style="color:${rateColor};">${overallRate}%</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${overallRate}%;background:${rateColor};"></div></div>
      </div>
      <div class="stat-card">
        <div class="label">📦 RSP &amp; Kit Progress</div>
        <div class="value" style="color:${overallRspColor};">${overallRspDisplay}</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${overallRspRate||0}%;background:${overallRspColor};"></div></div>
      </div>
    `;

    // ── Per-campaign breakdown ──
    let breakHtml = `<div class="section-label" style="margin-bottom:12px;">Breakdown by Campaign</div>`;
    breakHtml += `<div class="user-dash-camp-grid">`;

    for (const { camp, cTotal, cComplete, cInProgress, cNotStarted, campRate, campD5Pct, campD1Pct, campRspPct, memberRows } of campCards) {
      const campD5Color = campD5Pct === 100 ? '#059669' : campD5Pct >= 50 ? '#D97706' : '#2563EB';
      const campD1Color = campD1Pct === 100 ? '#059669' : campD1Pct >= 50 ? '#D97706' : '#2563EB';
      const campRspColor = campRspPct === null ? 'var(--text-muted)' : campRspPct === 100 ? '#059669' : campRspPct >= 50 ? '#D97706' : '#2563EB';
      const deadlineStr = campDateMetaHtml(camp);

      // Team leads see anonymous mini-bars across their team; plain members
      // see bars per entry of their OWN checklist (labelled when >1 entry).
      // D-5 and D-1 are always shown as separate bars — never blended.
      const barsHtml = memberRows.map(r => {
        const d5Color = r.d5Pct === 100 ? '#059669' : r.d5Pct > 0 ? '#3B82F6' : '#E5E7EB';
        const d1Color = r.d1Pct === 100 ? '#059669' : r.d1Pct > 0 ? '#3B82F6' : '#E5E7EB';
        const labelHtml = (!isTl && r.label) ? `<div style="font-size:10px;font-weight:600;color:var(--text-muted);margin-top:6px;">${escHtml(r.label)}</div>` : '';
        return `${labelHtml}
        ${r.hasD5 !== false ? `<div class="user-dash-mini-bar-row">
          <span style="font-size:9px;color:var(--text-faint);min-width:22px;">D-5</span>
          <div class="user-dash-mini-track">
            <div style="width:${r.d5Pct}%;background:${d5Color};height:100%;border-radius:4px;transition:width .3s;"></div>
          </div>
          <span style="font-size:10px;font-family:var(--mono);color:var(--text-muted);min-width:28px;text-align:right;">${r.d5Pct}%</span>
        </div>` : ''}
        <div class="user-dash-mini-bar-row">
          <span style="font-size:9px;color:var(--text-faint);min-width:22px;">D-1</span>
          <div class="user-dash-mini-track">
            <div style="width:${r.d1Pct}%;background:${d1Color};height:100%;border-radius:4px;transition:width .3s;"></div>
          </div>
          <span style="font-size:10px;font-family:var(--mono);color:var(--text-muted);min-width:28px;text-align:right;">${r.d1Pct}%</span>
        </div>`;
      }).join('');

      breakHtml += `
        <div class="user-dash-camp-card">
          <div class="user-dash-camp-header">
            <div>
              <div class="user-dash-camp-name">${escHtml(camp.name)}</div>
              ${deadlineStr}
            </div>
            <div style="text-align:right;">
              <div style="font-size:12px;font-weight:700;color:${campD5Color};">D-5 ${campD5Pct}%</div>
              <div style="font-size:12px;font-weight:700;color:${campD1Color};margin-top:2px;">D-1 ${campD1Pct}%</div>
              ${campRspPct !== null ? `<div style="font-size:12px;font-weight:700;color:${campRspColor};margin-top:2px;">📦 RSP &amp; Kit ${campRspPct}%</div>` : ''}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;margin:8px 0 12px;">
            <div class="user-dash-camp-rate-bar" style="height:5px;">
              <div style="width:${campD5Pct}%;background:${campD5Color};height:100%;border-radius:4px;transition:width .4s;"></div>
            </div>
            <div class="user-dash-camp-rate-bar" style="height:5px;">
              <div style="width:${campD1Pct}%;background:${campD1Color};height:100%;border-radius:4px;transition:width .4s;"></div>
            </div>
            ${campRspPct !== null ? `<div class="user-dash-camp-rate-bar" style="height:5px;" title="RSP & Kit checking progress">
              <div style="width:${campRspPct}%;background:${campRspColor};height:100%;border-radius:4px;transition:width .4s;"></div>
            </div>` : ''}
          </div>
          <div class="user-dash-camp-pills">
            <span class="user-dash-pill pill-green">✓ ${cComplete} Complete</span>
            <span class="user-dash-pill pill-amber">⟳ ${cInProgress} In Progress</span>
            <span class="user-dash-pill pill-red">— ${cNotStarted} Not Started</span>
            <span class="user-dash-pill pill-blue">${cTotal} Total</span>
          </div>
          <div class="user-dash-members-label">${isTl ? 'Team progress' : 'Your progress'}</div>
          <div class="user-dash-member-bars">${barsHtml}</div>
        </div>`;
    }

    breakHtml += `</div>`;
    breakdownEl.innerHTML = breakHtml;

    // ── RSP & Kit Checks for this member ──
    await renderMemberRspKitPanel();

  } catch(e) {
    statsEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;">Failed to load ${isTl ? 'team' : 'your'} data.</div>`;
    console.error(e);
  }
}

// ── Member: RSP & Kit Checking panel on dashboard ────────────
async function renderMemberRspKitPanel() {
  // Remove existing panel if any
  const existing = document.getElementById('member-rsp-kit-panel');
  if (existing) existing.remove();

  const breakdownEl = document.getElementById('user-team-campaign-breakdown');
  if (!breakdownEl || !currentUser) return;

  try {
    // Load task checks targeted at this member or all members.
    // Only show campaign-LESS checks here — campaign-scoped checks are now
    // surfaced inline on the campaign card above (rate) and on the Checklist
    // tab banner (per brand/platform/region entry), so they're not repeated.
    const snap = await db.collection('taskChecks').orderBy('sentAt', 'desc').get();

    const myChecks = [];
    snap.forEach(doc => {
      const tc = doc.data();
      if (tc.campaignId) return;
      if (!tc.targetUid || tc.targetUid === currentUser.uid) {
        myChecks.push({ id: doc.id, ...tc });
      }
    });
    if (myChecks.length === 0) return;

    const panel = document.createElement('div');
    panel.id = 'member-rsp-kit-panel';
    panel.style.cssText = 'margin-top:28px;';

    let html = `<div class="section-label" style="margin-bottom:12px;">📦 RSP &amp; Kit Checking</div>`;

    for (const tc of myChecks) {
      // Load my response
      const respDoc = await db.collection('taskCheckResponses').doc(tc.id)
        .collection('responses').doc(currentUser.uid).get();
      const myResp = respDoc.exists ? respDoc.data() : { items: {} };

      const dt = new Date(tc.sentAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const campTag = tc.campaignName ? `<span class="bcast-tag" style="margin-left:6px;">${escHtml(tc.campaignName)}</span>` : '';

      // Overall status summary
      const statuses = tc.items.map(item => (myResp.items || {})[item.id] || 'pending');
      const allDone  = statuses.every(rspIsDoneLike);
      const anyProg  = statuses.some(s => s === 'in-progress' || rspIsDoneLike(s));
      const overallStatus = allDone ? 'done' : anyProg ? 'in-progress' : 'pending';
      const overallLbl = RSP_STATUS_LABEL[overallStatus];
      const overallCls = RSP_STATUS_CLASS[overallStatus];

      const itemsHtml = tc.items.map(item => {
        const current = (myResp.items || {})[item.id] || 'pending';
        const opts = [
          { v: 'pending',     l: '— Pending' },
          { v: 'in-progress', l: '⟳ In Progress' },
          { v: 'done',        l: '✓ Done' },
          { v: 'na',          l: 'N/A' },
        ];
        const selectHtml = opts.map(o => `<option value="${o.v}" ${current===o.v?'selected':''}>${o.l}</option>`).join('');
        return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);">
          <span style="flex:1;font-size:13px;color:var(--text);">${escHtml(item.label)}</span>
          <select class="status-sel ${statusClass(current)}" data-checkid="${tc.id}" data-itemid="${item.id}"
            onchange="onMemberDashItemChange('${tc.id}','${item.id}',this)">
            ${selectHtml}
          </select>
        </div>`;
      }).join('');

      html += `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface2);border-bottom:1px solid var(--border);">
          <div>
            <span style="font-weight:600;font-size:13px;">${escHtml(tc.title)}</span>${campTag}
            <span style="font-size:11px;color:var(--text-muted);margin-left:6px;">${dt}</span>
          </div>
          <span class="rv-status ${overallCls}" style="font-size:11px;" id="rsp-overall-${tc.id}">${overallLbl}</span>
        </div>
        <div style="padding:6px 14px 10px;">
          ${itemsHtml}
          <button class="btn-primary" style="width:auto;margin-top:10px;font-size:12px;padding:6px 16px;"
            onclick="saveMemberDashTaskCheck('${tc.id}', this)">💾 Save Status</button>
        </div>
      </div>`;
    }

    panel.innerHTML = html;
    breakdownEl.appendChild(panel);

    // Store responses in memory for quick access
    window._memberRspResponses = window._memberRspResponses || {};

  } catch(e) { console.error('RSP panel error', e); }
}

// ── Member: handle inline status change in RSP panel ─────────
async function onMemberDashItemChange(checkId, itemId, sel) {
  sel.className = `status-sel ${statusClass(sel.value)}`;
  // Recompute overall status for this check
  const allSels = document.querySelectorAll(`select[data-checkid="${checkId}"]`);
  const statuses = [...allSels].map(s => s.value);
  const allDone  = statuses.every(rspIsDoneLike);
  const anyProg  = statuses.some(s => s === 'in-progress' || rspIsDoneLike(s));
  const overall  = allDone ? 'done' : anyProg ? 'in-progress' : 'pending';
  const overallEl = document.getElementById(`rsp-overall-${checkId}`);
  if (overallEl) {
    const lbl = RSP_STATUS_LABEL[overall];
    const cls = RSP_STATUS_CLASS[overall];
    overallEl.textContent = lbl;
    overallEl.className = `rv-status ${cls}`;
  }
}

async function saveMemberDashTaskCheck(checkId, btn) {
  if (!currentUser) return;
  btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const allSels = document.querySelectorAll(`select[data-checkid="${checkId}"]`);
    const items = {};
    allSels.forEach(sel => { items[sel.dataset.itemid] = sel.value; });
    await db.collection('taskCheckResponses').doc(checkId)
      .collection('responses').doc(currentUser.uid)
      .set({ items, updatedAt: new Date().toISOString() }, { merge: true });
    showToast('✅ Status saved!', 'success');
  } catch(e) {
    showToast('Failed to save. Try again.', 'warn');
    console.error(e);
  } finally {
    btn.textContent = '💾 Save Status'; btn.disabled = false;
  }
}

function showError(el, msg) {
  el.textContent    = msg;
  el.style.display  = 'block';
}

// ── Member/TL: RSP & Kit Checking banner on the Checklist tab ────────
// Sits in the (previously empty) #user-progress-banner / #tl-progress-banner
// slot just above the entry table, broken out per brand/platform/region
// entry — same entries as the table's column headers.
async function renderEntryRspKitBanner(bannerId, entries) {
  const banner = document.getElementById(bannerId);
  if (!banner || !currentUser || !selectedCampaignId) return;
  banner.style.display = 'none';
  banner.innerHTML = '';

  const uiPrefix = bannerId.replace('-rspkit-banner', '');
  const miniEl = document.getElementById(`${uiPrefix}-kitrsp-mini`);
  const hideMini = () => { if (miniEl) miniEl.style.display = 'none'; };

  try {
    const snap = await db.collection('taskChecks')
      .where('campaignId', '==', selectedCampaignId).get();

    const checks = [];
    snap.forEach(doc => {
      const tc = doc.data();
      if (rspCheckAppliesToUser(tc, currentUser.uid)) checks.push({ id: doc.id, ...tc });
    });
    checks.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
    if (checks.length === 0) { hideMini(); return; }

    // Load my responses for each check
    const responses = {};
    await Promise.all(checks.map(async tc => {
      const respDoc = await db.collection('taskCheckResponses').doc(tc.id).collection('responses').doc(currentUser.uid).get();
      responses[tc.id] = respDoc.exists ? respDoc.data() : {};
    }));

    // Only keep checks that apply to at least one of this campaign's entries
    const relevantChecks = checks.filter(tc => entries.some(e => rspCheckAppliesToEntry(tc, e)));
    if (relevantChecks.length === 0) { hideMini(); return; }

    let html = '';
    relevantChecks.forEach((tc, idx) => {
      const dt = new Date(tc.sentAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const applicableEntries = entries.map((e, i) => ({ e, i })).filter(({ e }) => rspCheckAppliesToEntry(tc, e));

      const itemColWidth = 130;
      const itemShortLabel = (item) => /kit/i.test(item.id) || /kit/i.test(item.label) ? '📦 Kit'
        : /rsp/i.test(item.id) || /rsp/i.test(item.label) ? '📋 RSP'
        : item.label;

      // Same navy-header look as the main checklist table (.review-table),
      // so this panel feels like part of the same design system. First
      // column is now labeled "Brand" (was unlabeled before), and the
      // per-row status pill that used to sit in front of the brand name
      // has been removed — overall status is still visible from the
      // collapsed header summary above.
      const headerHtml = `<thead><tr>
        <th style="min-width:160px;">Brand</th>
        ${tc.items.map(item => `<th style="min-width:${itemColWidth}px;text-align:center;">${escHtml(itemShortLabel(item))}</th>`).join('')}
      </tr></thead>`;

      const entriesHtml = applicableEntries.map(({ e, i }) => {
        const key = rspEntryKey(e);
        const resp = responses[tc.id];
        const label = buildEntryLabel(e, i);
        const itemsHtml = tc.items.map(item => {
          const current = rspItemStatus(resp, key, item.id);
          const opts = [
            { v: 'pending', l: '— Pending' },
            { v: 'in-progress', l: '⟳ In Progress' },
            { v: 'done', l: '✓ Done' },
            { v: 'na', l: 'N/A' },
          ];
          const selectHtml = opts.map(o => `<option value="${o.v}" ${current===o.v?'selected':''}>${o.l}</option>`).join('');
          return `<td style="text-align:center;">
            <select class="status-sel ${statusClass(current)}" style="font-size:11px;padding:2px 6px;min-width:${itemColWidth - 16}px;"
              data-checkid="${tc.id}" data-entrykey="${escHtml(key)}" data-itemid="${item.id}"
              title="${escHtml(item.label)}"
              onchange="onEntryRspItemChange('${tc.id}','${escHtml(key).replace(/'/g,"\\'")}', this)">
              ${selectHtml}
            </select>
          </td>`;
        }).join('');

        return `<tr><td style="font-weight:600;">${escHtml(label)}</td>${itemsHtml}</tr>`;
      }).join('');

      // Quick summary shown in the (collapsed) header so the status is
      // visible at a glance without expanding the entry list.
      const doneCt = applicableEntries.filter(({ e, i }) => rspEntryOverallStatus(tc, responses[tc.id], rspEntryKey(e)) === 'done').length;
      const panelId = `rsp-banner-panel-${tc.id}`;

      html += `<div class="rsp-banner" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0;cursor:pointer;" onclick="toggleRspBannerPanel('${panelId}', this)" title="Click to collapse/expand">
          <div style="display:flex;align-items:center;gap:6px;min-width:0;">
            <span class="lead-completion-caret" data-panel="${panelId}" style="display:inline-block;font-size:10px;color:var(--text-muted);transition:transform .15s;transform:rotate(90deg);">▶</span>
            <span style="font-weight:600;font-size:13px;">📦 ${escHtml(tc.title)}</span>
            <span style="font-size:11px;color:var(--text-muted);">${doneCt}/${applicableEntries.length} done</span>
          </div>
          <span style="font-size:11px;color:var(--text-muted);">${dt}</span>
        </div>
        <div id="${panelId}" style="display:block;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);">
          <div class="review-table-wrap" style="max-height:none;">
            <table class="review-table" style="width:100%;">
              ${headerHtml}
              <tbody>${entriesHtml}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    });

    banner.innerHTML = html;
    banner.style.display = 'block';

    // Small Kit/RSP completion % shown right below the main checklist
    // progress banner — separate from the detailed entry table above,
    // this is just a quick at-a-glance rate. N/A counts as done, same as
    // everywhere else this rate is calculated.
    if (miniEl) {
      let kitTotal = 0, kitDone = 0, rspTotal = 0, rspDone = 0;
      relevantChecks.forEach(tc => {
        const applicableEntries = entries.filter(e => rspCheckAppliesToEntry(tc, e));
        const resp = responses[tc.id];
        applicableEntries.forEach(e => {
          const key = rspEntryKey(e);
          tc.items.forEach(item => {
            const st = rspItemStatus(resp, key, item.id);
            const isKit = /kit/i.test(item.id) || /kit/i.test(item.label || '');
            const isRsp = /rsp/i.test(item.id) || /rsp/i.test(item.label || '');
            if (isKit) { kitTotal++; if (rspIsDoneLike(st)) kitDone++; }
            else if (isRsp) { rspTotal++; if (rspIsDoneLike(st)) rspDone++; }
          });
        });
      });
      const kitPct = kitTotal > 0 ? Math.round((kitDone / kitTotal) * 100) : null;
      const rspPct = rspTotal > 0 ? Math.round((rspDone / rspTotal) * 100) : null;
      if (kitPct === null && rspPct === null) {
        miniEl.style.display = 'none';
      } else {
        miniEl.style.display = 'flex';
        miniEl.innerHTML = [
          kitPct !== null ? `<span>📦 Kit: ${kitDone}/${kitTotal} (${kitPct}%)</span>` : '',
          rspPct !== null ? `<span>📋 RSP: ${rspDone}/${rspTotal} (${rspPct}%)</span>` : '',
        ].filter(Boolean).join('');
      }
    }
  } catch(e) {
    console.error('Entry RSP banner error', e);
    hideMini();
  }
}

// Member/TL Checklist tab: expand/collapse a single Kit & RSP Check card.
function toggleRspBannerPanel(panelId, headerEl) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  const caret = headerEl.querySelector(`.lead-completion-caret[data-panel="${panelId}"]`);
  if (caret) caret.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
}

// ── Member/TL: inline status change in the Checklist-tab RSP banner ──
// Auto-saves on every change (the banner is compact, no separate save step).
async function onEntryRspItemChange(checkId, entryKey, sel) {
  sel.className = `status-sel ${statusClass(sel.value)}`;
  if (!currentUser) return;
  try {
    await db.collection('taskCheckResponses').doc(checkId)
      .collection('responses').doc(currentUser.uid)
      .set({ entries: { [entryKey]: { items: { [sel.dataset.itemid]: sel.value } } }, updatedAt: new Date().toISOString() }, { merge: true });

    // Recompute & refresh the overall status pill for this entry's row
    const row = sel.closest('.rsp-banner-entry');
    const allSels = row ? row.querySelectorAll(`select[data-checkid="${checkId}"][data-entrykey="${entryKey}"]`) : [];
    const statuses = [...allSels].map(s => s.value);
    const allDone  = statuses.every(rspIsDoneLike);
    const anyProg  = statuses.some(s => s === 'in-progress' || rspIsDoneLike(s));
    const overall  = allDone ? 'done' : anyProg ? 'in-progress' : 'pending';
    const pill = row ? row.querySelector('.rv-status') : null;
    if (pill) { pill.textContent = RSP_STATUS_LABEL[overall]; pill.className = `rv-status ${RSP_STATUS_CLASS[overall]}`; }
  } catch(e) {
    showToast('Failed to save status. Try again.', 'warn');
    console.error(e);
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Shared D-Day / Checklist Deadline meta line ─────────────────
// Used anywhere a campaign's key dates should be surfaced: the member
// "My Checklist" overview cards, the actual Checklist tab header (for
// members, team leads, and admins alike), the admin Dashboard header,
// and the team lead "Dashboard" header — so the two dates always read the
// same way everywhere instead of drifting into one-off formats.
function campDateMetaHtml(camp) {
  if (!camp) return '';
  const fmt = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const opts = iso.includes('T')
      ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
    return d.toLocaleString('en-GB', opts);
  };
  const parts = [];
  if (camp.dday)     parts.push(`<span style="font-size:11px;color:var(--text-muted);">📅 D-Day: ${fmt(camp.dday)}</span>`);
  if (camp.deadline) parts.push(`<span style="font-size:11px;color:#D97706;font-weight:600;">⏰ Checklist Deadline: ${fmt(camp.deadline)}</span>`);
  return parts.join(' &nbsp;·&nbsp; ');
}

// Compact "12 Jul, 15:30" style formatter for the checklist deadline —
// used in table cells where campDateMetaHtml's full label is too long.
function fmtDeadlineShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const opts = iso.includes('T')
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short' };
  return d.toLocaleString('en-GB', opts);
}

// ═════════════════════════════════════════════════════════════
//  BROADCAST SYSTEM
// ═════════════════════════════════════════════════════════════
let currentBroadcastType = 'shoutout';

const QUICK_MESSAGES = {
  shoutout: [
    '🏆 First to complete! Awesome work!',
    '🌟 Great hustle — checklist done ahead of schedule!',
    '🎉 Crushed it! 100% complete!',
  ],
  nudge: [
    '⏰ Friendly reminder: please complete your checklist before D-Day!',
    '📋 A few items still pending — can we wrap these up today?',
    '🚀 Almost there! Let\'s push to finish strong.',
  ],
  custom: [],
};

function openBroadcastModal() {
  const mSel = document.getElementById('broadcast-member-sel');
  mSel.innerHTML = '<option value="">All members</option>';
  Object.values(members).filter(m => m.role !== 'admin').forEach(m => {
    mSel.innerHTML += `<option value="${m.uid}">${m.name || m.username} (@${m.username})</option>`;
  });

  const cSel = document.getElementById('broadcast-campaign-sel');
  cSel.innerHTML = '<option value="">All campaigns</option>';
  Object.values(campaigns).forEach(c => {
    cSel.innerHTML += `<option value="${c.id}">${c.name}</option>`;
  });

  currentBroadcastType = 'shoutout';
  document.querySelectorAll('.btn-broadcast-type').forEach(b => b.classList.remove('selected'));
  document.querySelector('.btn-broadcast-type[data-type="shoutout"]').classList.add('selected');
  renderQuickMessages();
  document.getElementById('broadcast-message').value = '';
  document.getElementById('broadcast-error').style.display = 'none';
  document.getElementById('broadcast-overlay').style.display = 'flex';
}

function closeBroadcastModal(e) {
  if (e && e.target !== document.getElementById('broadcast-overlay')) return;
  document.getElementById('broadcast-overlay').style.display = 'none';
}

function selectBroadcastType(btn) {
  currentBroadcastType = btn.dataset.type;
  document.querySelectorAll('.btn-broadcast-type').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  renderQuickMessages();
}

function renderQuickMessages() {
  const msgs = QUICK_MESSAGES[currentBroadcastType] || [];
  const wrap = document.getElementById('broadcast-quick-msgs');
  if (msgs.length === 0) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Quick picks</div>` +
    msgs.map(m => `<button class="quick-msg-chip" onclick="useQuickMsg(this)">${m}</button>`).join('');
}

function useQuickMsg(btn) {
  document.getElementById('broadcast-message').value = btn.textContent;
}

// ── Team lead: notify selected bucket members + admin of a new/edited calendar entry ──
async function notifyCalEntryAlignment(entryData, assignedUids) {
  const leadName = currentUser?.name || currentUser?.username || 'Team Lead';
  const dateStr  = entryData.date || '';
  const _campLabel = (CAL_CAMPAIGN_TYPES.find(c => c.id === entryData.campaignType) || {}).label || entryData.type;
  const _regLabel  = entryData.region ? `[${entryData.region}] ` : '';
  const msg = `📅 ${_regLabel}${entryData.title} (${_campLabel}) on ${dateStr}`;

  const targets = [...new Set([...assignedUids, ADMIN_UID])];
  for (const uid of targets) {
    const targetName = uid === ADMIN_UID
      ? 'Admin'
      : (tlMembers[uid]?.name || tlMembers[uid]?.username || members[uid]?.name || 'member');
    try {
      await db.collection('broadcasts').add({
        type: 'calendar',
        message: uid === ADMIN_UID ? `${msg} — added by ${leadName} for alignment.` : msg,
        targetUid: uid,
        targetName,
        campaignId: entryData.campaignId || null,
        campaignName: null,
        sentAt: new Date().toISOString(),
        sentBy: leadName,
        readBy: [],
      });
    } catch (e) { console.error('notifyCalEntryAlignment failed for', uid, e); }
  }
}

async function sendBroadcast() {
  const msg    = document.getElementById('broadcast-message').value.trim();
  const uid    = document.getElementById('broadcast-member-sel').value;
  const campId = document.getElementById('broadcast-campaign-sel').value;
  const errEl  = document.getElementById('broadcast-error');
  errEl.style.display = 'none';

  if (!msg) { showError(errEl, 'Please write a message.'); return; }

  const memberName = uid
    ? (members[uid]?.name || members[uid]?.username || 'member')
    : 'everyone';
  const campName = campId ? campaigns[campId]?.name : null;

  const broadcast = {
    type:       currentBroadcastType,
    message:    msg,
    targetUid:  uid || null,
    targetName: memberName,
    campaignId: campId || null,
    campaignName: campName || null,
    sentAt:     new Date().toISOString(),
    sentBy:     currentUser?.role === 'manager' ? (currentUser.name || currentUser.username) : 'Admin',
    readBy:     [],
  };

  try {
    await db.collection('broadcasts').add(broadcast);
    document.getElementById('broadcast-overlay').style.display = 'none';
    showToast(`📣 Broadcast sent to ${memberName}!`, 'success');
  } catch(e) { showError(errEl, 'Failed to send. Try again.'); }
}

async function openBroadcastFeed() {
  document.getElementById('broadcast-feed-overlay').style.display = 'flex';
  await loadBroadcastFeed();
}

function closeBroadcastFeed(e) {
  if (e && e.target !== document.getElementById('broadcast-feed-overlay')) return;
  document.getElementById('broadcast-feed-overlay').style.display = 'none';
}

async function loadBroadcastFeed() {
  const list = document.getElementById('broadcast-feed-list');
  list.innerHTML = '<div style="padding:1rem;color:var(--text-muted);text-align:center;">Loading…</div>';

  try {
    const snap = await db.collection('broadcasts')
      .orderBy('sentAt', 'desc').limit(50).get();

    if (snap.empty) {
      list.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-muted);">No broadcasts yet.</div>';
      return;
    }

    const uid = currentUser?.uid;
    const unreadIds = [];

    let html = '';
    snap.forEach(doc => {
      const b = doc.data();
      if (b.targetUid && b.targetUid !== uid) return;
      const isUnread = !b.readBy?.includes(uid);
      if (isUnread) unreadIds.push(doc.id);

      const typeIcon  = { shoutout: '🏆', nudge: '⏰', custom: '📢', registration: '📋', taskcheck: '📦', calendar: '📅' }[b.type] || '📣';
      const typeColor = { shoutout: '#059669', nudge: '#D97706', custom: '#2563EB', registration: '#7C3AED', taskcheck: '#0F766E', calendar: '#DB2777' }[b.type] || '#64748B';
      const timeStr   = new Date(b.sentAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const campTag   = b.campaignName ? `<span class="bcast-tag">${b.campaignName}</span>` : '';
      const unreadDot = isUnread ? `<span style="width:8px;height:8px;background:#EF4444;border-radius:50%;display:inline-block;margin-left:4px;"></span>` : '';

      // Registration poll card — show a "Register Now" action button
      const regPollBtn = (b.isRegPoll && b.pollId && currentUser?.role !== 'admin' && currentUser?.role !== 'manager')
        ? `<button onclick="closeBroadcastFeedAndOpenPoll('${b.pollId}')" style="margin-top:10px;padding:7px 16px;font-size:12px;font-weight:600;background:rgba(124,58,237,0.18);border:1px solid rgba(124,58,237,0.5);color:#C4B5FD;border-radius:8px;cursor:pointer;">📋 Register Now</button>`
        : '';

      // Task check card — show "Update Status" button for members
      const taskCheckBtn = (b.type === 'taskcheck' && b.taskCheckId && currentUser?.role !== 'admin' && currentUser?.role !== 'manager')
        ? `<button onclick="closeBroadcastFeed();goToTaskCheck('${b.taskCheckId}')" style="margin-top:10px;padding:7px 16px;font-size:12px;font-weight:600;background:rgba(15,118,110,0.18);border:1px solid rgba(15,118,110,0.5);color:#5EEAD4;border-radius:8px;cursor:pointer;">📦 Update My Status</button>`
        : '';

      html += `<div class="bcast-card ${isUnread ? 'bcast-unread' : ''}">
        <div class="bcast-header">
          <span class="bcast-type-icon" style="color:${typeColor}">${typeIcon}</span>
          <span class="bcast-from">From ${escHtml(b.sentBy || 'Admin')}</span>
          ${campTag}
          ${unreadDot}
          <span class="bcast-time">${timeStr}</span>
        </div>
        <div class="bcast-msg">${escHtml(b.message)}</div>
        ${b.targetUid ? `<div class="bcast-to">To: <strong>${escHtml(b.targetName)}</strong></div>` : ''}
        ${regPollBtn}
        ${taskCheckBtn || ''}
      </div>`;
    });

    list.innerHTML = html || '<div style="padding:2rem;text-align:center;color:var(--text-muted);">No messages for you yet.</div>';

    // Mark each unread message as read individually — one failed write (e.g.
    // a permissions hiccup on a single doc) must not abort the rest of the
    // batch or leave the badge wrongly cleared while those messages remain
    // "unread" server-side and get re-counted on the next load.
    for (const docId of unreadIds) {
      try {
        await db.collection('broadcasts').doc(docId).update({
          readBy: firebase.firestore.FieldValue.arrayUnion(uid)
        });
      } catch (writeErr) {
        console.error('Failed to mark broadcast as read:', docId, writeErr);
      }
    }
    // Recompute from actual server state rather than assuming all writes
    // above succeeded, so already-read messages never linger in the count.
    await checkBroadcastBadge();
  } catch(e) { list.innerHTML = '<div style="padding:1rem;color:var(--danger);">Failed to load broadcasts.</div>'; }
}

// ─── Member: open poll from broadcast feed ───────────────────
async function closeBroadcastFeedAndOpenPoll(pollId) {
  document.getElementById('broadcast-feed-overlay').style.display = 'none';

  try {
    // Check if user already responded (settings/pollResponses flat map)
    const respDoc = await POLL_RESP_REF().get();
    const allResponses = respDoc.exists ? respDoc.data() : {};
    if (allResponses[currentUser.uid]) {
      showToast('You have already responded to this poll.', 'info');
      return;
    }

    // Load poll data from settings/activePoll
    const pollDoc = await POLL_META_REF().get();
    if (!pollDoc.exists || pollDoc.data().status !== 'open') {
      showToast('This registration poll is no longer open.', 'info');
      return;
    }

    userPendingPollId = pollDoc.data().id || 'activePoll';
    currentPollData   = { id: userPendingPollId, ...pollDoc.data() };
    openUserRegModal();
  } catch(e) {
    console.error('closeBroadcastFeedAndOpenPoll:', e);
    showToast('Could not load poll. Please try again.', 'error');
  }
}

async function checkBroadcastBadge() {
  if (!currentUser) return;
  try {
    const snap = await db.collection('broadcasts').orderBy('sentAt', 'desc').limit(50).get();
    let count = 0;
    snap.forEach(doc => {
      const b = doc.data();
      if (b.targetUid && b.targetUid !== currentUser.uid) return;
      if (!b.readBy?.includes(currentUser.uid)) count++;
    });
    updateBroadcastBadge(count);
  } catch(e) {}
}

function updateBroadcastBadge(count) {
  const badge = document.getElementById('user-broadcast-badge');
  if (badge) {
    if (count > 0) { badge.textContent = count; badge.style.display = 'block'; }
    else { badge.style.display = 'none'; }
  }
  const tlBadge = document.getElementById('tl-broadcast-badge');
  if (tlBadge) {
    if (count > 0) { tlBadge.textContent = count; tlBadge.style.display = 'block'; }
    else { tlBadge.style.display = 'none'; }
  }
  const adminBadge = document.getElementById('admin-broadcast-badge');
  if (adminBadge) {
    if (count > 0) { adminBadge.textContent = count; adminBadge.style.display = 'block'; }
    else { adminBadge.style.display = 'none'; }
  }
}

// ═════════════════════════════════════════════════════════════
//  CHECKLIST SECTION LOADER  (per-campaign template support)
// ═════════════════════════════════════════════════════════════
async function loadChecklistOverrides(campaignId, campObj) {
  try {
    // Prefer an explicitly-passed campaign object (e.g. from the review
    // modal, which can be reviewing ANY member's ANY campaign — the
    // role-based campSrc guess below is only valid for "my own selected
    // campaign" flows, not for "look up someone else's campaign").
    const camp = campObj || ((currentUser?.role === 'team_lead') ? tlOwnCampaigns : campaigns)[campaignId];
    // If a campaignId is provided and it has a template assigned, load that template
    if (campaignId && camp?.checklistTemplateId) {
      const tmplId = camp.checklistTemplateId;
      const tmplDoc = await db.collection('settings').doc('checklistTemplates').get();
      if (tmplDoc.exists) {
        const templates = tmplDoc.data().templates || [];
        const tmpl = templates.find(t => t.id === tmplId);
        if (tmpl && tmpl.sections) {
          CHECKLIST_SECTIONS.length = 0;
          tmpl.sections.forEach(s => CHECKLIST_SECTIONS.push(s));
          window._TOTAL_ITEMS_OVERRIDE = CHECKLIST_SECTIONS.reduce((sum, s) => sum + s.items.length, 0);
          window._HAS_D5_OVERRIDE = tmpl.hasD5 !== false;
          return;
        }
      }
    }
    // Fall back to global checklist override doc
    const doc = await db.collection('settings').doc('checklist').get();
    if (doc.exists && doc.data().sections) {
      const saved = doc.data().sections;
      CHECKLIST_SECTIONS.length = 0;
      saved.forEach(s => CHECKLIST_SECTIONS.push(s));
      window._TOTAL_ITEMS_OVERRIDE = CHECKLIST_SECTIONS.reduce((sum, s) => sum + s.items.length, 0);
      window._HAS_D5_OVERRIDE = true;
    } else {
      // No per-campaign template and no global override for this campaign —
      // reset to the application's true default. Without this, switching
      // from a campaign that DOES use a custom template to one that
      // doesn't would incorrectly keep showing/counting the previous
      // template (wrong items rendered, and percentages computed against
      // the wrong total).
      CHECKLIST_SECTIONS.length = 0;
      DEFAULT_CHECKLIST_SECTIONS.forEach(s => CHECKLIST_SECTIONS.push(JSON.parse(JSON.stringify(s))));
      window._TOTAL_ITEMS_OVERRIDE = null;
      window._HAS_D5_OVERRIDE = true;
    }
  } catch(e) { console.warn('Could not load checklist overrides', e); }
}

function getTotalItems() {
  return window._TOTAL_ITEMS_OVERRIDE || TOTAL_ITEMS;
}

// Whether the CURRENTLY loaded checklist template (CHECKLIST_SECTIONS) has
// a D-5 stage. Defaults true when no override has been set yet.
function getHasD5() {
  return window._HAS_D5_OVERRIDE !== false;
}

// ═════════════════════════════════════════════════════════════
//  CHECKLIST TEMPLATES  (tab + centered editor modal)
// ═════════════════════════════════════════════════════════════
let checklistTemplates    = [];   // [{ id, name, sections }]
let editingTemplateId     = null;
let templateEditorSections = [];

// ── Load / Save ──────────────────────────────────────────────
async function loadChecklistTemplates() {
  try {
    const doc = await db.collection('settings').doc('checklistTemplates').get();
    checklistTemplates = doc.exists ? (doc.data().templates || []) : [];
    // Seed "Mega Campaign Checklist" from the default if no templates yet
    if (checklistTemplates.length === 0) {
      const defaultSections = JSON.parse(JSON.stringify(CHECKLIST_SECTIONS));
      checklistTemplates = [{
        id: 'tmpl_default',
        name: 'Mega Campaign Checklist',
        sections: defaultSections,
      }];
      await saveChecklistTemplates();
    }
  } catch(e) { console.warn('Could not load checklist templates', e); }
}

async function saveChecklistTemplates() {
  await db.collection('settings').doc('checklistTemplates').set({ templates: checklistTemplates });
  invalidateChecklistSettingsCache();
}

// ── Tab render ───────────────────────────────────────────────
async function renderChecklistTab() {
  const host = document.getElementById('checklist-tab-content');
  if (!host) return;
  host.innerHTML = '<div style="padding:2rem;color:var(--text-muted);text-align:center;">Loading…</div>';
  await loadChecklistTemplates();
  renderChecklistTabContent();
}

function renderChecklistTabContent() {
  const host = document.getElementById('checklist-tab-content');
  if (!host) return;

  if (checklistTemplates.length === 0) {
    host.innerHTML = `
      <div style="padding:4rem;text-align:center;">
        <div style="font-size:48px;margin-bottom:14px;">📋</div>
        <div style="font-size:18px;font-weight:700;color:var(--navy);margin-bottom:8px;">No templates yet</div>
        <div style="color:var(--text-muted);margin-bottom:24px;">Create your first checklist template to assign to campaigns.</div>
        <button class="btn-primary" style="width:auto;padding:10px 24px;" onclick="openNewTemplateModal()">+ New Template</button>
      </div>`;
    return;
  }

  host.innerHTML = `
    <div class="tmpl-tab-grid">
      ${checklistTemplates.map((t, i) => {
        const itemCount = t.sections ? t.sections.reduce((s, sec) => s + sec.items.length, 0) : 0;
        const secCount  = t.sections ? t.sections.length : 0;
        const isDefault = t.id === 'tmpl_default';
        return `
        <div class="tmpl-card">
          <div class="tmpl-card-top">
            <div class="tmpl-card-name">${escHtml(t.name)}</div>
            ${isDefault ? '<span class="tmpl-card-badge">Default</span>' : ''}
            ${t.hasD5 === false ? '<span class="tmpl-card-badge" style="background:#FEF3C7;color:#92400E;">No D-5</span>' : ''}
          </div>
          <div class="tmpl-card-meta">${secCount} section${secCount !== 1 ? 's' : ''} · ${itemCount} item${itemCount !== 1 ? 's' : ''}</div>
          <div class="tmpl-card-sections">
            ${(t.sections || []).map(s => `<span class="tmpl-sec-chip">${escHtml(s.title)}</span>`).join('')}
          </div>
          <div class="tmpl-card-actions">
            <button class="btn-ghost-light btn-sm" onclick="openEditTemplateModal(${i})">✏️ Edit</button>
            ${!isDefault ? `<button class="btn-ghost-light btn-sm" style="color:#DC2626;border-color:#FCA5A5;" onclick="deleteTemplate(${i})">🗑 Delete</button>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

// ── Open new template modal ──────────────────────────────────
async function openNewTemplateModal() {
  await loadChecklistTemplates();
  editingTemplateId = null;
  // Pre-populate with full default sections so admin can edit from there
  templateEditorSections = JSON.parse(JSON.stringify(CHECKLIST_SECTIONS));
  document.getElementById('tmpl-name-input').value = '';
  document.getElementById('tmpl-d5-select').value = 'yes';
  document.getElementById('tmpl-editor-modal-title').textContent = '✏️ New Template';
  document.getElementById('tmpl-editor-error').style.display = 'none';
  renderTmplEditor();
  document.getElementById('tmpl-editor-overlay').style.display = 'flex';
}

// ── Open edit template modal ─────────────────────────────────
function openEditTemplateModal(idx) {
  const t = checklistTemplates[idx];
  editingTemplateId = t.id;
  // If template has no sections yet, seed from default
  templateEditorSections = JSON.parse(JSON.stringify(
    t.sections && t.sections.length > 0 ? t.sections : CHECKLIST_SECTIONS
  ));
  document.getElementById('tmpl-name-input').value = t.name;
  document.getElementById('tmpl-d5-select').value = t.hasD5 === false ? 'no' : 'yes';
  document.getElementById('tmpl-editor-modal-title').textContent = `✏️ Edit: ${t.name}`;
  document.getElementById('tmpl-editor-error').style.display = 'none';
  renderTmplEditor();
  document.getElementById('tmpl-editor-overlay').style.display = 'flex';
}

function closeTmplEditorModal(e) {
  if (e && e.target !== document.getElementById('tmpl-editor-overlay')) return;
  document.getElementById('tmpl-editor-overlay').style.display = 'none';
}

// ── Inline drag-and-drop template editor ─────────────────────

let _tmplDragType = null;   // 'section' | 'item'
let _tmplDragSecIdx = null;
let _tmplDragItemIdx = null;

function renderTmplEditor() {
  const con = document.getElementById('tmpl-sections-container');
  if (!con) return;

  // Update stats badge
  const total = templateEditorSections.reduce((s, sec) => s + sec.items.length, 0);
  const statsEl = document.getElementById('tmpl-editor-stats');
  if (statsEl) statsEl.textContent = `${templateEditorSections.length} section${templateEditorSections.length !== 1 ? 's' : ''} · ${total} item${total !== 1 ? 's' : ''}`;

  if (templateEditorSections.length === 0) {
    con.innerHTML = `<div style="text-align:center;padding:3rem;color:var(--text-muted);font-size:13px;">No sections yet. Click "+ Add Section" to get started.</div>`;
    return;
  }

  con.innerHTML = templateEditorSections.map((sec, si) => `
    <div class="tmpl-section-card"
      draggable="true"
      data-si="${si}"
      ondragstart="tmplSecDragStart(event,${si})"
      ondragover="tmplSecDragOver(event,${si})"
      ondrop="tmplSecDrop(event,${si})"
      ondragend="tmplDragEnd(event)">
      <div class="tmpl-section-hdr">
        <span class="tmpl-sec-grip" aria-hidden="true">⠿</span>
        <input class="tmpl-sec-title-input"
          value="${escHtml(sec.title)}"
          placeholder="Section name"
          onchange="templateEditorSections[${si}].title=this.value;renderTmplEditorStats()" />
        <span class="tmpl-sec-count">${sec.items.length} item${sec.items.length !== 1 ? 's' : ''}</span>
        <button class="btn-ghost-light tmpl-sec-del-btn" onclick="tmplDeleteSection(${si})">🗑</button>
      </div>
      <div class="tmpl-items-wrap">
        ${sec.items.length === 0
          ? `<div style="font-size:12px;color:var(--text-faint);padding:6px 4px;">No items yet.</div>`
          : sec.items.map((item, ii) => `
            <div class="tmpl-item-row"
              draggable="true"
              data-ii="${ii}"
              ondragstart="tmplItemDragStart(event,${si},${ii})"
              ondragover="tmplItemDragOver(event,${si},${ii})"
              ondrop="tmplItemDrop(event,${si},${ii})"
              ondragend="tmplDragEnd(event)">
              <span class="tmpl-item-grip" aria-hidden="true">⠿</span>
              <div class="tmpl-item-fields">
                <input class="tmpl-item-name-inp"
                  value="${escHtml(item.name)}"
                  placeholder="Item name…"
                  onchange="templateEditorSections[${si}].items[${ii}].name=this.value" />
                <input class="tmpl-item-guide-inp"
                  value="${escHtml(item.guide || '')}"
                  placeholder="Guide / description (optional)"
                  onchange="templateEditorSections[${si}].items[${ii}].guide=this.value" />
              </div>
              <select class="tmpl-item-type-sel" title="Answer type for this item"
                onchange="templateEditorSections[${si}].items[${ii}].type=this.value||undefined">
                <option value="" ${!item.type ? 'selected' : ''}>Status</option>
                <option value="yesno" ${item.type === 'yesno' ? 'selected' : ''}>Yes / No</option>
              </select>
              <button class="tmpl-item-del-btn" onclick="tmplDeleteItem(${si},${ii})" title="Remove item">✕</button>
            </div>`).join('')
        }
      </div>
      <button class="tmpl-add-item-btn" onclick="tmplAddItem(${si})">+ Add item</button>
    </div>
  `).join('');
}

function renderTmplEditorStats() {
  const total = templateEditorSections.reduce((s, sec) => s + sec.items.length, 0);
  const statsEl = document.getElementById('tmpl-editor-stats');
  if (statsEl) statsEl.textContent = `${templateEditorSections.length} section${templateEditorSections.length !== 1 ? 's' : ''} · ${total} item${total !== 1 ? 's' : ''}`;
}

function tmplAddSection() {
  templateEditorSections.push({ id: `sec_${Date.now()}`, title: 'New Section', items: [] });
  renderTmplEditor();
  setTimeout(() => {
    const inputs = document.querySelectorAll('.tmpl-sec-title-input');
    const last = inputs[inputs.length - 1];
    if (last) { last.focus(); last.select(); }
  }, 50);
}

function tmplAddItem(si) {
  const sec = templateEditorSections[si];
  if (!sec) return;
  sec.items.push({ id: `${sec.id || 'sec'}_${Date.now()}`, name: '', guide: '' });
  renderTmplEditor();
  setTimeout(() => {
    const wrap = document.querySelectorAll('.tmpl-section-card')[si];
    if (wrap) {
      const inputs = wrap.querySelectorAll('.tmpl-item-name-inp');
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    }
  }, 50);
}

function tmplDeleteSection(si) {
  if (!confirm(`Delete "${templateEditorSections[si].title}" and all its items?`)) return;
  templateEditorSections.splice(si, 1);
  renderTmplEditor();
}

function tmplDeleteItem(si, ii) {
  templateEditorSections[si].items.splice(ii, 1);
  renderTmplEditor();
}

// Drag — sections
function tmplSecDragStart(e, si) { _tmplDragType = 'section'; _tmplDragSecIdx = si; e.dataTransfer.effectAllowed = 'move'; }
function tmplSecDragOver(e, si)  { if (_tmplDragType === 'section' && _tmplDragSecIdx !== si) { e.preventDefault(); e.currentTarget.classList.add('drag-over-section'); } }
function tmplSecDrop(e, si) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over-section');
  if (_tmplDragType === 'section' && _tmplDragSecIdx !== si) {
    const moved = templateEditorSections.splice(_tmplDragSecIdx, 1)[0];
    templateEditorSections.splice(si, 0, moved);
    renderTmplEditor();
  }
}

// Drag — items
function tmplItemDragStart(e, si, ii) { _tmplDragType = 'item'; _tmplDragSecIdx = si; _tmplDragItemIdx = ii; e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); }
function tmplItemDragOver(e, si, ii)  { if (_tmplDragType === 'item') { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('drag-over-item'); } }
function tmplItemDrop(e, si, ii) {
  e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('drag-over-item');
  if (_tmplDragType === 'item') {
    const item = templateEditorSections[_tmplDragSecIdx].items.splice(_tmplDragItemIdx, 1)[0];
    templateEditorSections[si].items.splice(ii, 0, item);
    renderTmplEditor();
  }
}
function tmplDragEnd(e) {
  document.querySelectorAll('.drag-over-section,.drag-over-item').forEach(el => el.classList.remove('drag-over-section', 'drag-over-item'));
  _tmplDragType = null; _tmplDragSecIdx = null; _tmplDragItemIdx = null;
}

// Legacy stubs so old calls from renderTmplEditorSection don't break
function populateTmplEditorSectionSel() { /* replaced by renderTmplEditor */ }
function renderTmplEditorSection() { renderTmplEditor(); }
function addTmplRow() { /* replaced — section-specific buttons now handle this */ }
function addTmplSection() { tmplAddSection(); }
function deleteTmplSection(idx) { tmplDeleteSection(idx); }
function deleteTmplItem(si, ii) { tmplDeleteItem(si, ii); }
function moveTmplItem() { /* replaced by drag */ }
function syncItemCardTitle() { /* no-op */ }

async function deleteTemplate(idx) {
  const t = checklistTemplates[idx];
  if (!confirm(`Delete template "${t.name}"?`)) return;
  checklistTemplates.splice(idx, 1);
  await saveChecklistTemplates();
  renderChecklistTabContent();
  showToast('Template deleted.', 'success');
}

async function saveTemplate() {
  const errEl = document.getElementById('tmpl-editor-error');
  const name  = document.getElementById('tmpl-name-input').value.trim();
  const hasD5 = document.getElementById('tmpl-d5-select').value !== 'no';
  if (!name) { showError(errEl, 'Template name is required.'); return; }
  for (const sec of templateEditorSections) {
    if (!sec.title.trim()) { showError(errEl, 'All sections must have a title.'); return; }
    for (const item of sec.items) {
      if (!item.name.trim()) { showError(errEl, `Empty item name found in "${sec.title}". Please fill it in or remove it.`); return; }
    }
  }
  errEl.style.display = 'none';

  if (editingTemplateId) {
    const idx = checklistTemplates.findIndex(t => t.id === editingTemplateId);
    if (idx >= 0) {
      checklistTemplates[idx] = { ...checklistTemplates[idx], name, hasD5, sections: JSON.parse(JSON.stringify(templateEditorSections)) };
    }
  } else {
    checklistTemplates.push({ id: `tmpl_${Date.now()}`, name, hasD5, sections: JSON.parse(JSON.stringify(templateEditorSections)) });
  }

  try {
    await saveChecklistTemplates();
    document.getElementById('tmpl-editor-overlay').style.display = 'none';
    renderChecklistTabContent();
    showToast('✅ Template saved!', 'success');
  } catch(e) { showError(errEl, 'Failed to save template. Please try again.'); console.error(e); }
}

// ═════════════════════════════════════════════════════════════
//  IMPORT TEMPLATE FROM FILE
//  Any Excel/CSV with a header row → each column becomes a
//  checklist item. Admin picks which columns count as items, then
//  we hand off to the existing (manual) Template Editor pre-seeded
//  with those items — reusing its drag/reorder/rename/add/remove
//  UI rather than duplicating it here.
// ═════════════════════════════════════════════════════════════

// Identifier/allocation columns — these define WHO the entry belongs to
// and WHAT brand/platform/region it covers (the same role they play in
// Bulk Assign), not a task someone completes. Pre-unchecked by default.
const TMPL_IMPORT_IDENTIFIER_HEADERS = [
  'region', 'brand', 'brand name', 'platform', 'cdm', 'team lead', 'lead',
  'pic', 'username', 'name'
];

// Free-text/meta columns that aren't a checklist task either — pre-unchecked.
const TMPL_IMPORT_META_HEADERS = ['remarks', 'notes', 'comments'];

// Columns that are computed/derived by the tool itself rather than filled
// in by a member — also pre-unchecked by default.
const TMPL_IMPORT_AUTO_EXCLUDE_PATTERNS = [
  /auto[\s-]?update/i, /^status$/i, /date completed/i
];

let _tmplImportHeaders  = []; // [{ label, checked }] in file order
let _tmplImportFileName = '';

function openImportTemplateModal() {
  _tmplImportHeaders  = [];
  _tmplImportFileName = '';
  document.getElementById('tmpl-import-file').value = '';
  document.getElementById('tmpl-import-cols-field').style.display = 'none';
  document.getElementById('tmpl-import-name-field').style.display = 'none';
  document.getElementById('tmpl-import-section-name').value = '';
  document.getElementById('tmpl-import-cols-list').innerHTML = '';
  document.getElementById('tmpl-import-error').style.display = 'none';
  document.getElementById('tmpl-import-continue-btn').disabled = true;
  document.getElementById('tmpl-import-overlay').style.display = 'flex';
}

function closeImportTemplateModal(e) {
  if (e && e.target !== document.getElementById('tmpl-import-overlay')) return;
  document.getElementById('tmpl-import-overlay').style.display = 'none';
}

function handleImportTemplateFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const errEl = document.getElementById('tmpl-import-error');
  errEl.style.display = 'none';
  _tmplImportFileName = file.name.replace(/\.[^.]+$/, '');

  const isXlsx = /\.(xlsx|xls|xlsm)$/i.test(file.name);
  if (isXlsx) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        _parseImportTemplateRows(rows, errEl);
      } catch (err) {
        showError(errEl, 'Failed to read the file. Make sure it is a valid .xlsx or .xls file.');
        console.error(err);
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result.replace(/^\uFEFF/, '');
      const rows = text.split(/\r?\n/).filter(r => r.trim() !== '').map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
      _parseImportTemplateRows(rows, errEl);
    };
    reader.readAsText(file);
  }
}

// Finds the first row that looks like a header row: at least 2 non-empty
// cells and no purely-numeric cells (which would suggest a data row).
function _findGenericHeaderRowIndex(rows) {
  const limit = Math.min(rows.length, 10);
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] || []).map(c => String(c || '').trim());
    const nonEmpty = cells.filter(c => c !== '');
    if (nonEmpty.length < 2) continue;
    const looksNumeric = nonEmpty.every(c => !isNaN(c));
    if (!looksNumeric) return i;
  }
  return rows.length ? 0 : -1;
}

function _parseImportTemplateRows(rows, errEl) {
  if (!rows.length) { showError(errEl, 'File appears empty.'); return; }

  const headerRowIdx = _findGenericHeaderRowIndex(rows);
  if (headerRowIdx < 0) { showError(errEl, 'Could not find a header row in this file.'); return; }

  const rawHeaders = (rows[headerRowIdx] || []).map(h => String(h || '').trim()).filter(h => h !== '');
  if (rawHeaders.length === 0) { showError(errEl, 'No column headers found in this file.'); return; }

  _tmplImportHeaders = rawHeaders.map(label => {
    const norm = label.toLowerCase().trim();
    const isIdentifier = TMPL_IMPORT_IDENTIFIER_HEADERS.includes(norm);
    const isMeta = TMPL_IMPORT_META_HEADERS.includes(norm);
    const isAutoComputed = TMPL_IMPORT_AUTO_EXCLUDE_PATTERNS.some(re => re.test(label));
    return { label, checked: !isIdentifier && !isMeta && !isAutoComputed };
  });

  document.getElementById('tmpl-import-section-name').value = _tmplImportFileName || 'Imported Checklist';
  _renderImportTemplatePreview();
}

function _renderImportTemplatePreview() {
  const list = document.getElementById('tmpl-import-cols-list');
  list.innerHTML = _tmplImportHeaders.map((h, i) => {
    const norm = h.label.toLowerCase().trim();
    let tag = '';
    if (TMPL_IMPORT_IDENTIFIER_HEADERS.includes(norm)) tag = '<span style="font-size:10px;color:var(--text-faint);margin-left:6px;">allocation field</span>';
    else if (TMPL_IMPORT_META_HEADERS.includes(norm)) tag = '<span style="font-size:10px;color:var(--text-faint);margin-left:6px;">not a task</span>';
    else if (TMPL_IMPORT_AUTO_EXCLUDE_PATTERNS.some(re => re.test(h.label))) tag = '<span style="font-size:10px;color:var(--text-faint);margin-left:6px;">auto-computed</span>';
    return `
    <label style="display:flex;align-items:center;gap:8px;padding:5px 2px;font-size:13px;cursor:pointer;">
      <input type="checkbox" ${h.checked ? 'checked' : ''} onchange="_tmplImportHeaders[${i}].checked=this.checked;_updateImportContinueState()" />
      <span>${escHtml(h.label)}</span>${tag}
    </label>`;
  }).join('');
  document.getElementById('tmpl-import-cols-field').style.display = '';
  document.getElementById('tmpl-import-name-field').style.display = '';
  _updateImportContinueState();
}

function _updateImportContinueState() {
  const anyChecked = _tmplImportHeaders.some(h => h.checked);
  document.getElementById('tmpl-import-continue-btn').disabled = !anyChecked;
}

// Hands off to the existing manual Template Editor, pre-seeded with the
// checked columns as items in a single section. Admin can still rename,
// reorder, add, or remove items there using its existing drag-and-drop UI
// before saving — this import step only builds the starting point.
function confirmImportTemplate() {
  const errEl = document.getElementById('tmpl-import-error');
  const checkedHeaders = _tmplImportHeaders.filter(h => h.checked);
  if (checkedHeaders.length === 0) { showError(errEl, 'Select at least one column to use as a checklist item.'); return; }

  const sectionName = document.getElementById('tmpl-import-section-name').value.trim() || 'Imported Checklist';
  const secId = `sec_${Date.now()}`;
  const section = {
    id: secId,
    title: sectionName,
    items: checkedHeaders.map((h, i) => ({ id: `${secId}_${Date.now()}_${i}`, name: h.label, guide: '' }))
  };

  // Seed the editor exactly like openNewTemplateModal does, but with our
  // imported section instead of the default sections, and default to
  // "No D-5" since imported/flat checklists typically have a single stage.
  editingTemplateId = null;
  templateEditorSections = [section];
  document.getElementById('tmpl-name-input').value = sectionName;
  document.getElementById('tmpl-d5-select').value = 'no';
  document.getElementById('tmpl-editor-modal-title').textContent = '✏️ New Template (from file)';
  document.getElementById('tmpl-editor-error').style.display = 'none';
  renderTmplEditor();

  closeImportTemplateModal();
  document.getElementById('tmpl-editor-overlay').style.display = 'flex';
}

// ── Populate the template selector in the New Campaign modal ─
async function populateCampaignTemplateSel() {
  await populateTemplateSel('campaign-template-sel');
}

// ── Legacy stubs (kept so old calls don't break) ─────────────
function openEditorModal()  { switchAdminTab('checklist'); }
function closeEditorModal() { /* no-op — modal is gone */ }
function openTemplatesModal() { switchAdminTab('checklist'); }
function closeTemplatesModal() { /* no-op */ }
function showTemplatesListView() { /* no-op */ }
function showTemplateEditorView() { /* no-op */ }



// ═════════════════════════════════════════════════════════════
//  BRAND REGISTRATION POLL SYSTEM
// ═════════════════════════════════════════════════════════════
//
//  Firestore paths (uses existing permitted 'settings' collection):
//    /settings/activePoll          — poll metadata (name, desc, status, createdAt)
//    /settings/pollResponses       — flat map { [uid]: responseData }
//
//  Poll states: 'open' | 'closed'
//  Response states: 'registered' | 'skipped' | null (not responded)

// Helper refs — multi-poll support
// polls stored as individual docs in 'settings' collection: 'poll_{id}'
// responses stored per poll: 'pollResp_{pollId}'
const POLL_META_REF = (pollId) => db.collection('settings').doc(pollId || 'activePoll');
const POLL_RESP_REF = (pollId) => db.collection('settings').doc('pollResp_' + (pollId || 'activePoll'));
const POLLS_LIST_REF = () => db.collection('settings').doc('pollsList');

const PLATFORMS = ['Lazada', 'Shopee', 'TikTok', 'Zalora'];
const REGIONS   = ['MY', 'PH', 'SG', 'TH', 'VN', 'ID'];

let activePollId       = null;   // currently open poll (admin knows)
let currentPollData    = null;   // the poll document
let userPendingPollId  = null;   // poll the member has not yet responded to
let pollResponses      = {};     // { uid: responseDoc }
let regPollUnreadCount = 0;
let allPolls           = [];     // list of all polls [{id,name,desc,status,createdAt}]
let activePollTabId    = null;   // which poll tab is shown in admin

// ─── Admin: open "Create Registration Poll" modal ───────────
function openRegPollModal() {
  document.getElementById('reg-poll-name').value = '';
  document.getElementById('reg-poll-desc').value = '';
  document.getElementById('reg-poll-error').style.display = 'none';
  renderRegPollAdmin();
  document.getElementById('reg-poll-overlay').style.display = 'flex';
}

function closeRegPollModal(e) {
  if (e && e.target !== document.getElementById('reg-poll-overlay')) return;
  document.getElementById('reg-poll-overlay').style.display = 'none';
}

async function createRegPoll() {
  const name = document.getElementById('reg-poll-name').value.trim();
  const desc = document.getElementById('reg-poll-desc').value.trim();
  const errEl = document.getElementById('reg-poll-error');
  errEl.style.display = 'none';

  if (!name) { showError(errEl, 'Please enter a campaign name.'); return; }

  const btn = document.getElementById('reg-poll-create-btn');
  btn.textContent = 'Creating…'; btn.disabled = true;

  try {
    const pollId = 'poll_' + Date.now();
    const pollData = {
      id:        pollId,
      name, desc,
      status:    'open',
      createdAt: new Date().toISOString(),
      createdBy: ADMIN_UID,
    };

    // Save poll metadata as its own settings doc
    await POLL_META_REF(pollId).set(pollData);

    // Also update the polls list doc
    const listDoc = await POLLS_LIST_REF().get();
    const existingList = listDoc.exists ? (listDoc.data().polls || []) : [];
    existingList.unshift({ id: pollId, name, desc, status: 'open', createdAt: pollData.createdAt });
    await POLLS_LIST_REF().set({ polls: existingList });

    // Initialise empty responses doc for this poll
    await POLL_RESP_REF(pollId).set({});

    // Send "Register Now" broadcast automatically
    await db.collection('broadcasts').add({
      type:       'registration',
      message:    `📋 Registration is now open for "${name}"${desc ? '\n\n' + desc : ''}`,
      pollId:     pollId,
      targetUid:  null,
      targetName: 'everyone',
      campaignId: null,
      campaignName: null,
      sentAt:     new Date().toISOString(),
      sentBy:     'Admin',
      readBy:     [],
      isRegPoll:  true,
    });

    document.getElementById('reg-poll-overlay').style.display = 'none';
    await loadAdminData();
    switchAdminTab('registration');
  } catch(e) {
    showError(errEl, 'Failed to create poll. Try again.');
    console.error(e);
  } finally {
    btn.textContent = '📣 Create & Send'; btn.disabled = false;
  }
}

// ─── Admin: Registration tab render ─────────────────────────
async function loadAndRenderRegPollAdmin() {
  const host = document.getElementById('admin-tab-registration');
  if (!host) return;
  host.innerHTML = '<div style="padding:2rem;color:var(--text-muted);text-align:center;">Loading…</div>';

  try {
    // Load the polls list
    const listDoc = await POLLS_LIST_REF().get();
    allPolls = listDoc.exists ? (listDoc.data().polls || []) : [];

    // Legacy fallback: check old single-poll doc. Only relevant when the
    // polls-list doc has never been created at all (pre-migration data) —
    // once it exists, an empty array means the admin genuinely deleted
    // every poll, and we must NOT resurrect the old doc (it can otherwise
    // make a deleted poll like "Sample" reappear with stale counts).
    if (allPolls.length === 0 && !listDoc.exists) {
      const legacyDoc = await db.collection('settings').doc('activePoll').get();
      if (legacyDoc.exists) {
        const d = legacyDoc.data();
        allPolls = [{ id: d.id || 'activePoll', name: d.name, desc: d.desc, status: d.status, createdAt: d.createdAt }];
      }
    }

    if (allPolls.length === 0) {
      host.innerHTML = `
        <div style="padding:4rem;text-align:center;">
          <div style="font-size:56px;margin-bottom:14px;">📋</div>
          <div style="font-size:20px;font-weight:700;color:var(--navy);margin-bottom:8px;">No registration polls yet</div>
          <div style="color:var(--text-muted);margin-bottom:24px;max-width:400px;margin-left:auto;margin-right:auto;line-height:1.6;">
            Create a poll to collect brand, platform and region registrations from your team.<br>A "Register Now" broadcast is sent automatically.
          </div>
          <button class="btn-primary" style="width:auto;padding:12px 28px;font-size:15px;" onclick="openRegPollModal()">📣 Create Registration Poll</button>
          <button class="btn-outline" style="width:auto;padding:12px 28px;font-size:15px;margin-left:10px;" onclick="openBulkAssignModal()">📊 Bulk Assign via Excel</button>
        </div>`;
      return;
    }

    // Show the first (most recent) poll tab by default
    activePollTabId = activePollTabId || allPolls[0].id;
    // Ensure the selected tab poll exists
    if (!allPolls.find(p => p.id === activePollTabId)) activePollTabId = allPolls[0].id;

    await loadPollTabData(activePollTabId);
    renderRegPollAdminWithTabs();
  } catch(e) {
    console.error('loadAndRenderRegPollAdmin error:', e);
    const isPermErr = e.message && e.message.toLowerCase().includes('permission');
    host.innerHTML = `
      <div style="padding:3rem 2rem;text-align:center;max-width:540px;margin:0 auto;">
        <div style="font-size:48px;margin-bottom:14px;">${isPermErr ? '🔒' : '⚠️'}</div>
        <div style="font-size:18px;font-weight:700;color:var(--navy);margin-bottom:8px;">
          ${isPermErr ? 'Firestore permissions required' : 'Failed to load registration data'}
        </div>
        <div style="color:var(--text-muted);font-size:13px;line-height:1.7;margin-bottom:20px;">
          ${isPermErr
            ? 'Unable to load registration data. Please check your Firestore security rules allow access to the <code>settings</code> collection.'
            : e.message}
        </div>
        <button class="btn-primary" style="width:auto;padding:10px 24px;font-size:14px;" onclick="openRegPollModal()">📋 Create Registration Poll</button>
      </div>`;
  }
}

async function loadPollTabData(pollId) {
  // Load full poll metadata
  const pollDoc = await POLL_META_REF(pollId).get();
  if (!pollDoc.exists) {
    // fallback to list data
    currentPollData = allPolls.find(p => p.id === pollId) || null;
  } else {
    currentPollData = { id: pollDoc.data().id || pollId, ...pollDoc.data() };
  }
  activePollId = pollId;
  const respDoc = await POLL_RESP_REF(pollId).get();
  pollResponses = respDoc.exists ? respDoc.data() : {};
}

async function switchPollTab(pollId) {
  activePollTabId = pollId;
  await loadPollTabData(pollId);
  renderRegPollAdminWithTabs();
}

function renderRegPollAdminWithTabs() {
  const host = document.getElementById('admin-tab-registration');
  if (!host) return;

  const tabsHtml = allPolls.map(p => {
    const isActive = p.id === activePollTabId;
    const statusDot = p.status === 'open' ? '🟢' : '🔴';
    return `<button class="poll-tab-btn ${isActive ? 'active' : ''}" onclick="switchPollTab('${p.id}')">${statusDot} ${escHtml(p.name)}</button>`;
  }).join('');

  const headerHtml = `
    <div class="reg-poll-tabs-header">
      <div class="reg-poll-tabs-list">${tabsHtml}</div>
      <button class="btn-primary" style="font-size:12px;width:auto;padding:7px 16px;background:#4F46E5;flex-shrink:0;" onclick="openRegPollModal()">📋 New Poll</button>
      <button class="btn-outline" style="font-size:12px;width:auto;padding:7px 16px;flex-shrink:0;" onclick="openBulkAssignModal()">📊 Bulk Assign via Excel</button>
    </div>`;

  // Render the poll content section below the tabs
  const pollContentId = 'reg-poll-content-area';
  host.innerHTML = headerHtml + `<div id="${pollContentId}"></div>`;

  renderRegPollAdmin();
}

function renderRegPollAdmin() {
  // When tabs are shown, write to content area; otherwise write to main tab
  const host = document.getElementById('reg-poll-content-area') || document.getElementById('admin-tab-registration');
  if (!host) return;
  if (!currentPollData) { loadAndRenderRegPollAdmin(); return; }

  const poll = currentPollData;
  const isOpen = poll.status === 'open';
  const isLocked = poll.status === 'locked';

  const nonAdmins = Object.values(members).filter(m => m.role !== 'admin');
  const registered = [];
  const skipped    = [];
  const pending    = [];

  nonAdmins.forEach(m => {
    const resp = pollResponses[m.uid];
    if (!resp) { pending.push(m); return; }
    if (resp.status === 'skipped') { skipped.push({ member: m, resp }); return; }
    registered.push({ member: m, resp });
  });

  // Summarise registrations by platform
  const byPlatform = {};
  registered.forEach(({ resp }) => {
    (resp.registrations || []).forEach(r => {
      const key = r.platform;
      if (!byPlatform[key]) byPlatform[key] = 0;
      byPlatform[key]++;
    });
  });

  const totalMembers = nonAdmins.length;
  const respondedCount = registered.length + skipped.length;
  const responsePct = totalMembers > 0 ? Math.round((respondedCount / totalMembers) * 100) : 0;

  host.innerHTML = `
    <div class="reg-poll-admin-wrap">

      <!-- Poll header card -->
      <div class="reg-poll-header-card">
        <div class="reg-poll-header-left">
          <div class="reg-poll-status-pill ${poll.status === 'open' ? 'rp-open' : poll.status === 'locked' ? 'rp-locked' : 'rp-closed'}">${poll.status === 'open' ? '🟢 Open' : poll.status === 'locked' ? '🔒 Locked' : '🔴 Closed'}</div>
          <div class="reg-poll-title">${escHtml(poll.name)}</div>
          ${poll.desc ? `<div class="reg-poll-sub">${escHtml(poll.desc)}</div>` : ''}
        </div>
        <div class="reg-poll-header-right">
          ${isOpen && !isLocked ? `<button class="btn-outline" style="border-color:#FCA5A5;color:#FCA5A5;font-size:12px;" onclick="closeRegPoll()">🔒 Close Poll</button>` : ''}
          <button class="btn-outline" style="border-color:#FCA5A5;color:#DC2626;font-size:12px;background:rgba(220,38,38,0.07);" onclick="deleteRegPoll('${poll.id}')">🗑 Delete Poll</button>
        </div>
      </div>

      <!-- Stats row -->
      <div class="reg-poll-stats">
        <div class="rp-stat-card">
          <div class="rp-stat-num" style="color:var(--blue)">${totalMembers}</div>
          <div class="rp-stat-label">Total members</div>
        </div>
        <div class="rp-stat-card">
          <div class="rp-stat-num" style="color:#059669">${registered.length}</div>
          <div class="rp-stat-label">Registered</div>
        </div>
        <div class="rp-stat-card">
          <div class="rp-stat-num" style="color:#D97706">${skipped.length}</div>
          <div class="rp-stat-label">Skipped</div>
        </div>
        <div class="rp-stat-card">
          <div class="rp-stat-num" style="color:#DC2626">${pending.length}</div>
          <div class="rp-stat-label">No response</div>
        </div>
        <div class="rp-stat-card rp-stat-wide">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:12px;color:var(--text-muted);">Response rate</span>
            <span style="font-size:12px;font-weight:600;">${responsePct}%</span>
          </div>
          <div class="mini-bar" style="margin:0;"><div class="mini-track" style="height:8px;"><div class="mini-fill" style="width:${responsePct}%;height:8px;"></div></div></div>
        </div>
      </div>

      <!-- Registered brands -->
      <div class="reg-poll-section-grid">

        <div class="reg-poll-col">
          <div class="reg-poll-col-header" style="color:#059669;">
            ✅ Registered (${registered.length})
            ${registered.length > 0 ? `<button class="btn-outline" style="font-size:11px;padding:3px 10px;background:#059669;border-color:#059669;" onclick="createCampaignFromPoll()">➕ Create Campaign from Poll</button>` : ''}
          </div>
          <div class="rp-member-list">
            ${registered.length === 0 ? '<div class="rp-empty">No registrations yet.</div>' : `
              <table class="rp-reg-table">
                <thead>
                  <tr>
                    <th>CDM</th>
                    <th>Brand</th>
                    <th>Platform</th>
                    <th>Region</th>
                    <th>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  ${registered.map(({ member, resp }) =>
                    (resp.registrations || [{ brand: '', platform: '', region: '' }]).map((r, ri) => `
                      <tr>
                        ${ri === 0 ? `<td rowspan="${(resp.registrations||[{}]).length}" class="rp-cdm-cell">${escHtml(member.name || member.username)}</td>` : ''}
                        <td>${escHtml(r.brand || '—')}</td>
                        <td><span class="rp-reg-tag">${escHtml(r.platform)}</span></td>
                        <td><span class="rp-reg-tag">${escHtml(r.region)}</span></td>
                        ${ri === 0 ? `<td rowspan="${(resp.registrations||[{}]).length}" style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${resp.submittedAt ? new Date(resp.submittedAt).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : ''}</td>` : ''}
                      </tr>`
                    ).join('')
                  ).join('')}
                </tbody>
              </table>`
            }
          </div>
        </div>

        <div class="reg-poll-col">
          <div class="reg-poll-col-header" style="color:#D97706;">⏭ Skipped (${skipped.length})</div>
          <div class="rp-member-list">
            ${skipped.length === 0 ? '<div class="rp-empty">No one skipped.</div>' :
              skipped.map(({ member, resp }) => `
                <div class="rp-member-card rp-skipped">
                  <div class="rp-member-name">${escHtml(member.name || member.username)}</div>
                  ${resp.note ? `<div class="rp-note">"${escHtml(resp.note)}"</div>` : ''}
                  <div class="rp-time">${resp.submittedAt ? new Date(resp.submittedAt).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : ''}</div>
                </div>
              `).join('')
            }
          </div>

          <div class="reg-poll-col-header" style="color:#DC2626;margin-top:16px;">❓ No Response (${pending.length})
            ${pending.length > 0 ? `<button class="btn-outline" style="font-size:11px;padding:3px 10px;background:#DC2626;border-color:#DC2626;" onclick="sendPollReminder()">📣 Send Reminder</button>` : ''}
          </div>
          <div class="rp-member-list">
            ${pending.length === 0 ? '<div class="rp-empty" style="color:#059669;">🎉 Everyone responded!</div>' :
              pending.map(m => `
                <div class="rp-member-card rp-pending">
                  <div class="rp-member-name">${escHtml(m.name || m.username)}</div>
                  <div style="font-size:11px;color:var(--text-muted);">@${escHtml(m.username)} — hasn't responded yet</div>
                </div>
              `).join('')
            }
          </div>
        </div>

      </div>
    </div>
  `;
}

async function closeRegPoll() {
  if (!currentPollData || !activePollId) return;
  if (!confirm('Close this poll? Members will no longer be able to register.')) return;
  await POLL_META_REF(activePollId).set({ status: 'closed' }, { merge: true });
  currentPollData.status = 'closed';
  // Update polls list
  const listDoc = await POLLS_LIST_REF().get();
  if (listDoc.exists) {
    const polls = listDoc.data().polls || [];
    const idx = polls.findIndex(p => p.id === activePollId);
    if (idx >= 0) { polls[idx].status = 'closed'; await POLLS_LIST_REF().set({ polls }); }
  }
  allPolls = allPolls.map(p => p.id === activePollId ? { ...p, status: 'closed' } : p);
  renderRegPollAdminWithTabs();
}

// ─── Admin: Delete a poll and all its response records ───────
async function deleteRegPoll(pollId) {
  const poll = allPolls.find(p => p.id === pollId);
  if (!poll) return;
  if (!confirm(`Delete poll "${poll.name}"?\n\nThis will permanently delete the poll and ALL member responses. This cannot be undone.`)) return;
  try {
    // Delete poll metadata doc
    await POLL_META_REF(pollId).delete();
    // Delete poll responses doc
    await POLL_RESP_REF(pollId).delete();
    // Remove from the polls list doc
    const listDoc = await POLLS_LIST_REF().get();
    if (listDoc.exists) {
      const polls = (listDoc.data().polls || []).filter(p => p.id !== pollId);
      await POLLS_LIST_REF().set({ polls });
    }
    // Remove from local state and switch to next poll if needed
    allPolls = allPolls.filter(p => p.id !== pollId);

    // Legacy cleanup: older data lived in a single settings/activePoll doc
    // (used as a fallback whenever the polls list is empty — see
    // loadAndRenderRegPollAdmin). If that legacy doc's internal `id` field
    // didn't match its own document id, the delete above could miss it,
    // letting a stale poll (e.g. "Sample") and its stale response counts
    // keep reappearing once the real poll list is empty. Once there are no
    // polls left, always scrub the legacy doc directly so it can't resurface.
    if (allPolls.length === 0) {
      await db.collection('settings').doc('activePoll').delete().catch(() => {});
      await db.collection('settings').doc('pollResp_activePoll').delete().catch(() => {});
    }

    if (activePollTabId === pollId) {
      activePollTabId = allPolls.length > 0 ? allPolls[0].id : null;
      currentPollData = null;
      pollResponses = {};
    }
    if (allPolls.length > 0 && activePollTabId) {
      await loadPollTabData(activePollTabId);
      renderRegPollAdminWithTabs();
    } else {
      await loadAndRenderRegPollAdmin();
    }
    showToast('✅ Poll deleted.', 'success');
  } catch(e) {
    showToast('Failed to delete poll. Try again.', 'error');
    console.error(e);
  }
}


// ─── Admin: Send reminder to non-responders ─────────────────
async function sendPollReminder() {
  const nonAdmins = Object.values(members).filter(m => m.role !== 'admin');
  const pending = nonAdmins.filter(m => {
    const resp = pollResponses[m.uid];
    return !resp;
  });
  if (pending.length === 0) { showToast('Everyone has already responded!', 'info'); return; }
  if (!confirm(`Send a reminder to ${pending.length} member(s) who haven't responded yet?`)) return;

  try {
    await db.collection('broadcasts').add({
      type:       'nudge',
      message:    `⏰ Reminder: Please respond to the registration poll "${currentPollData?.name || ''}" — your response is needed!`,
      targetUid:  null,
      targetName: 'pending-poll',
      targetUids: pending.map(m => m.uid),
      pollId:     activePollId,
      sentAt:     new Date().toISOString(),
      sentBy:     'Admin',
      readBy:     [],
    });
    showToast(`✅ Reminder sent to ${pending.length} member(s)!`, 'success');
  } catch(e) { showToast('Failed to send reminder.', 'error'); console.error(e); }
}

// ─── Admin: Create Campaign from Poll results ────────────────
async function createCampaignFromPoll() {
  if (!currentPollData || !activePollId) return;

  const registered = Object.values(members).filter(m => {
    const resp = pollResponses[m.uid];
    return resp && resp.status === 'registered';
  });

  if (registered.length === 0) {
    showToast('No registrations to create a campaign from.', 'info');
    return;
  }

  const campName = currentPollData.name;

  // Show the campaign creation modal with poll data pre-filled
  const list = document.getElementById('member-assign-list');
  const nonAdmins = Object.values(members).filter(m => m.role !== 'admin');
  list.innerHTML = nonAdmins.map(m => {
    const resp = pollResponses[m.uid];
    const isRegistered = resp && resp.status === 'registered';
    return `<div class="member-chip ${isRegistered ? 'selected' : ''}" data-uid="${m.uid}" onclick="toggleChip(this)">${m.name || m.username}${isRegistered ? ' ✓' : ''}</div>`;
  }).join('');

  document.getElementById('new-campaign-name').value = campName;
  document.getElementById('modal-error').style.display = 'none';

  // Override the createCampaign function temporarily to also save poll prefill data
  document.getElementById('modal-overlay').dataset.pollId = activePollId;
  document.getElementById('modal-overlay').style.display = 'flex';
}


// ─── Member: check for pending registration poll ─────────────
async function checkForPendingPoll() {
  if (!currentUser || currentUser.role === 'admin') return;

  try {
    // Find the most recent open poll the user hasn't responded to
    const listDoc = await POLLS_LIST_REF().get();
    let pollsList = listDoc.exists ? (listDoc.data().polls || []) : [];

    // Legacy fallback
    if (pollsList.length === 0) {
      const legacyDoc = await db.collection('settings').doc('activePoll').get();
      if (legacyDoc.exists) {
        const d = legacyDoc.data();
        pollsList = [{ id: d.id || 'activePoll', ...d }];
      }
    }

    const openPolls = pollsList.filter(p => p.status === 'open'); // locked/closed excluded
    if (openPolls.length === 0) return;

    // Check each open poll for an unanswered one
    let pendingPoll = null;
    for (const p of openPolls) {
      const respDoc = await POLL_RESP_REF(p.id).get();
      const allResponses = respDoc.exists ? respDoc.data() : {};
      if (!allResponses[currentUser.uid]) { pendingPoll = p; break; }
    }
    if (!pendingPoll) return;

    const openPoll = pendingPoll;
    const pollId = openPoll.id;

    // If poll metadata needs full data, load it
    if (!openPoll.name) {
      const pollDoc = await POLL_META_REF(pollId).get();
      if (!pollDoc.exists) return;
      Object.assign(openPoll, pollDoc.data());
    }

    // Check if user has already responded (kept for clarity, already checked above)
    const respDoc = await POLL_RESP_REF(pollId).get();
    const allResponses = respDoc.exists ? respDoc.data() : {};
    if (allResponses[currentUser.uid]) return; // already responded

    userPendingPollId = pollId;
    currentPollData   = openPoll;

    // Mark broadcast as read + update badge
    await checkBroadcastBadge();

    // Show the register button in header so the user can open it themselves.
    // The form should NOT pop up automatically on load — it only opens when
    // the user clicks the button (or via an admin-triggered broadcast/poll prompt).
    const regBtn = document.getElementById('user-reg-poll-btn');
    if (regBtn) regBtn.style.display = 'inline-flex';
    const tlRegBtn = document.getElementById('tl-reg-poll-btn');
    if (tlRegBtn) tlRegBtn.style.display = 'inline-flex';
  } catch(e) { console.error('checkForPendingPoll:', e); }
}

// ─── Member: Registration modal ──────────────────────────────
function openUserRegModal() {
  if (!currentPollData) return;

  document.getElementById('user-reg-poll-title').textContent = currentPollData.name;
  document.getElementById('user-reg-poll-desc').textContent  = currentPollData.desc || '';
  document.getElementById('user-reg-error').style.display    = 'none';

  // Reset form
  renderUserRegForm();
  document.getElementById('user-reg-overlay').style.display = 'flex';
}

function closeUserRegModal(e) {
  if (e && e.target !== document.getElementById('user-reg-overlay')) return;
  document.getElementById('user-reg-overlay').style.display = 'none';
}

let userRegEntries = [{ platform: '', region: '', brand: '' }];

function renderUserRegForm() {
  userRegEntries = [{ platform: '', region: '', brand: '' }];
  document.getElementById('user-reg-form-body').innerHTML = buildUserRegRows();
}

function buildUserRegRows() {
  return userRegEntries.map((entry, i) => `
    <tr id="ureg-entry-${i}">
      <td style="text-align:center;color:var(--text-muted);font-size:12px;">${i + 1}</td>
      <td>
        <input type="text" placeholder="e.g. L'Oréal" value="${escHtml(entry.brand)}"
          oninput="userRegEntries[${i}].brand = this.value"
          style="font-size:13px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;width:100%;" />
      </td>
      <td>
        <select onchange="userRegEntries[${i}].platform = this.value"
          style="font-size:13px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;width:100%;">
          <option value="">Select…</option>
          ${PLATFORMS.map(p => `<option value="${p}" ${entry.platform===p?'selected':''}>${p}</option>`).join('')}
        </select>
      </td>
      <td>
        <select onchange="userRegEntries[${i}].region = this.value"
          style="font-size:13px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;width:100%;">
          <option value="">Select…</option>
          ${REGIONS.map(r => `<option value="${r}" ${entry.region===r?'selected':''}>${r}</option>`).join('')}
        </select>
      </td>
      <td style="text-align:center;">
        ${i > 0
          ? `<button onclick="removeUserRegEntry(${i})" title="Remove row"
              style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#FCA5A5;border-radius:50%;width:24px;height:24px;font-size:12px;cursor:pointer;">✕</button>`
          : `<button onclick="addUserRegEntry()" title="Add row"
              style="background:rgba(37,99,235,0.12);border:1px solid rgba(37,99,235,0.3);color:#60A5FA;border-radius:50%;width:24px;height:24px;font-size:14px;cursor:pointer;line-height:1;">+</button>`
        }
      </td>
    </tr>
  `).join('');
}

function addUserRegEntry() {
  userRegEntries.push({ platform: '', region: '', brand: '' });
  document.getElementById('user-reg-form-body').innerHTML = buildUserRegRows();
}

function removeUserRegEntry(i) {
  userRegEntries.splice(i, 1);
  document.getElementById('user-reg-form-body').innerHTML = buildUserRegRows();
}

async function submitUserRegistration() {
  const errEl = document.getElementById('user-reg-error');
  errEl.style.display = 'none';

  // Validate
  for (let i = 0; i < userRegEntries.length; i++) {
    const e = userRegEntries[i];
    if (!e.platform) { showError(errEl, `Entry ${i+1}: please select a platform.`); return; }
    if (!e.region)   { showError(errEl, `Entry ${i+1}: please select a region.`); return; }
  }

  const note = document.getElementById('user-reg-note').value.trim();
  const btn  = document.getElementById('user-reg-submit-btn');
  btn.textContent = 'Submitting…'; btn.disabled = true;

  try {
    // Write to per-poll responses doc using dot-notation field update
    await POLL_RESP_REF(userPendingPollId || activePollId).set({
      [currentUser.uid]: {
        status:        'registered',
        registrations: userRegEntries.map(e => ({
          brand:    e.brand || '',
          platform: e.platform,
          region:   e.region,
        })),
        note:        note,
        submittedAt: new Date().toISOString(),
        memberName:  currentUser.name || currentUser.username,
      }
    }, { merge: true });

    document.getElementById('user-reg-overlay').style.display = 'none';
    userPendingPollId = null;

    // Show success toast
    showToast('✅ Registration submitted!', 'success');
  } catch(e) {
    showError(errEl, 'Failed to submit. Please try again.');
    console.error(e);
  } finally {
    btn.textContent = 'Submit Registration'; btn.disabled = false;
  }
}

async function skipUserRegistration() {
  if (!userPendingPollId) return;
  const note = document.getElementById('user-reg-skip-note')?.value?.trim() || '';

  try {
    await POLL_RESP_REF(userPendingPollId || activePollId).set({
      [currentUser.uid]: {
        status:      'skipped',
        note:        note,
        submittedAt: new Date().toISOString(),
        memberName:  currentUser.name || currentUser.username,
      }
    }, { merge: true });
    document.getElementById('user-reg-overlay').style.display = 'none';
    userPendingPollId = null;
    showToast('Registration skipped.', 'info');
  } catch(e) { showToast('Failed to skip. Try again.', 'warn'); }
}



// ═════════════════════════════════════════════════════════════
//  REPORTS TAB
// ═════════════════════════════════════════════════════════════
async function renderReportTab() {
  const host = document.getElementById('report-tab-content');
  if (!host) return;
  host.innerHTML = '<div style="padding:2rem;color:var(--text-muted);text-align:center;">Loading report data…</div>';

  // Populate campaign filter (preserve current selection across re-renders —
  // rebuilding innerHTML resets .value, so it must be captured beforehand)
  const filterSel = document.getElementById('report-campaign-filter');
  const prevFilterCamp = filterSel ? filterSel.value : '';
  if (filterSel) {
    filterSel.innerHTML = '<option value="">All campaigns</option>';
    Object.values(campaigns).forEach(c => {
      filterSel.innerHTML += `<option value="${c.id}">${escHtml(c.name)}</option>`;
    });
    if (prevFilterCamp && campaigns[prevFilterCamp]) filterSel.value = prevFilterCamp;
  }
  const filterCamp = filterSel ? filterSel.value : '';

  try {
    const checkSnap = await db.collection('checklists').get();
    const allChecklists = {};
    checkSnap.forEach(doc => { allChecklists[doc.id] = doc.data(); });

    const campList = filterCamp
      ? [campaigns[filterCamp]].filter(Boolean)
      : Object.values(campaigns);

    if (campList.length === 0) {
      host.innerHTML = '<div style="padding:3rem;text-align:center;color:var(--text-muted);">No campaigns found.</div>';
      return;
    }

    window._reportData = { campList, allChecklists };

    // Campaigns can use a non-default checklist template — resolve each
    // campaign's real total item count (see resolveCampaignTotalItems).
    const reportTotalItemsMap = await resolveCampaignTotalItems(campList);
    window._reportData.totalItemsMap = reportTotalItemsMap;

    const today     = new Date(); today.setHours(0,0,0,0);
    const fmtDate   = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const daysDiff  = (isoA, isoB) => Math.ceil((new Date(isoA) - new Date(isoB)) / 86400000);

    let html = '';

    campList.forEach(camp => {
      const deadline     = camp.deadline ? new Date(camp.deadline) : null;
      const dday         = camp.dday     ? new Date(camp.dday)     : null;
      const deadlineStr  = camp.deadline ? fmtDate(camp.deadline)  : null;
      const ddayStr      = camp.dday     ? fmtDate(camp.dday)      : null;
      // Admin sets the deadline as a plain date (e.g. "2026-06-24"), which
      // JS parses as UTC midnight — in any positive UTC-offset timezone
      // that instant actually falls a few hours INTO that calendar day
      // once converted to local time. Every other date used in this
      // comparison (today, a checklist's completedAt day) is explicitly
      // zeroed to local midnight, so comparing against the raw `deadline`
      // here introduced a silent ~day's worth of drift — e.g. someone who
      // finished exactly on the deadline showed as "+1d early" instead of
      // "on time", and the same drift compounded into every "vs Deadline"
      // delta on the Reports tab. Use the zeroed version everywhere we're
      // doing date-only (not date+time) math.
      const deadlineDayOnly = deadline ? new Date(deadline) : null;
      if (deadlineDayOnly) deadlineDayOnly.setHours(0,0,0,0);
      const deadlinePast = deadlineDayOnly && deadlineDayOnly < today;
      const daysToDeadline = deadlineDayOnly ? daysDiff(deadlineDayOnly, today) : null;

      const rows = [];
      (camp.assignedUids || []).forEach(uid => {
        const member = members[uid];
        if (!member) return;
        if (member.role !== 'member') return; // Reports only shows members tagged/assigned with a checklist — team leads & admins have their own views
        const cl      = (allChecklists[uid] || {})[camp.id] || {};
        const campInfo = reportTotalItemsMap[camp.id] || { total: TOTAL_ITEMS, validIds: null, hasD5: true };
        const hasD5    = campInfo.hasD5 !== false;
        // Filter by validIds so leftover "done" flags from an item that was
        // since removed from the template don't inflate the count past 100%.
        const d5Done  = hasD5 ? countDone(cl.d5 || {}, campInfo.validIds) : 0;
        const d1Done  = countDone(cl.d1 || {}, campInfo.validIds);
        const entries = cl.entries || [];
        // Each entry has its own full set of items, so the denominator must
        // scale with entry count, AND use this campaign's actual template
        // size — never just the hardcoded default TOTAL_ITEMS (see
        // getEntryBreakdown / resolveCampaignTotalItems).
        const entryCount = entries.length || 1;
        const ti          = campInfo.total * entryCount;
        // "No D-5" checklists have no D-5 stage at all — overall completion
        // is based on D-1 alone, never divided by a phantom D-5 half.
        // Overall completion is based on D-1 inputs alone for every user.
        const overallPct  = Math.round((d1Done / ti) * 100);
        const d5Pct       = hasD5 ? Math.round((d5Done / ti) * 100) : 0;
        const d1Pct       = Math.round((d1Done / ti) * 100);
        const startedAt   = cl.startedAt   || null;
        const completedAt = cl.completedAt || null;
        const lastActive  = cl.lastActive  || null;

        // Auto-detect completion: mark completedAt if 100% and not already set
        const isComplete  = overallPct === 100;

        // Deadline analysis
        let deadlineStatus = null; // 'on-time' | 'late' | 'at-risk' | 'overdue' | null
        let deadlineDelta  = null; // days relative to deadline (negative = late)
        if (deadline) {
          if (isComplete && completedAt) {
            const completedDay = new Date(completedAt); completedDay.setHours(0,0,0,0);
            deadlineDelta = daysDiff(deadlineDayOnly, completedDay);
            deadlineStatus = deadlineDelta >= 0 ? 'on-time' : 'late';
          } else if (!isComplete) {
            if (deadlinePast) {
              deadlineStatus = 'overdue';
              deadlineDelta  = daysDiff(today, deadlineDayOnly); // positive = how many days overdue
            } else if (daysToDeadline !== null && daysToDeadline <= 3) {
              deadlineStatus = 'at-risk';
            }
          }
        }

        const status    = isComplete ? 'Complete' : overallPct > 0 ? 'In Progress' : 'Not Started';
        const statusCls = isComplete ? 'badge-done' : overallPct > 0 ? 'badge-partial' : 'badge-pending';

        rows.push({
          member, camp, cl, entries, ti,
          d5Done, d1Done, d5Pct, d1Pct, overallPct, hasD5,
          lastActive, startedAt, completedAt, isComplete,
          status, statusCls, deadlineStatus, deadlineDelta,
        });
      });

      const total       = rows.length;
      // Arrange rows by status sequence: Completed → In Progress → Pending/Not Started
      const statusOrder = { 'Complete': 0, 'In Progress': 1, 'Not Started': 2 };
      rows.sort((a, b) => (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3));
      const complete    = rows.filter(r => r.isComplete).length;
      const inProg      = rows.filter(r => r.overallPct > 0 && !r.isComplete).length;
      const notStarted  = rows.filter(r => r.overallPct === 0).length;
      const atRisk      = rows.filter(r => r.deadlineStatus === 'at-risk').length;
      const overdue     = rows.filter(r => r.deadlineStatus === 'overdue').length;
      const late        = rows.filter(r => r.deadlineStatus === 'late').length;
      const onTime      = rows.filter(r => r.deadlineStatus === 'on-time').length;
      const avgPct      = total > 0 ? Math.round(rows.reduce((s,r) => s + r.overallPct, 0) / total) : 0;

      // Deadline pill for header
      let deadlinePillHtml = '';
      if (deadlineStr) {
        const cls = deadlinePast ? 'rs-stat-red' : daysToDeadline <= 3 ? 'rs-stat-amber' : 'rs-stat-green';
        const label = deadlinePast
          ? `⚠️ Deadline passed (${deadlineStr})`
          : daysToDeadline === 0 ? `🔴 Deadline TODAY`
          : daysToDeadline === 1 ? `🔴 Deadline TOMORROW`
          : `📅 Deadline in ${daysToDeadline}d (${deadlineStr})`;
        deadlinePillHtml = `<span class="rs-stat ${cls}" style="font-size:12px;">${label}</span>`;
      }
      if (ddayStr) {
        const ddayDayOnly = new Date(dday); ddayDayOnly.setHours(0,0,0,0);
        const ddayDiff = daysDiff(ddayDayOnly, today);
        const ddayCls  = ddayDiff <= 0 ? 'rs-stat-red' : ddayDiff <= 5 ? 'rs-stat-amber' : 'rs-stat-navy';
        const ddayLabel = ddayDiff === 0 ? '🔴 D-Day TODAY' : ddayDiff < 0 ? `🔴 D-Day was ${Math.abs(ddayDiff)}d ago` : `📌 D-Day in ${ddayDiff}d (${ddayStr})`;
        deadlinePillHtml += ` <span class="rs-stat ${ddayCls}" style="font-size:12px;">${ddayLabel}</span>`;
      }

      // At-risk / overdue warning banner
      let riskBannerHtml = '';
      if (overdue > 0 || atRisk > 0) {
        riskBannerHtml = `
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;padding:10px 14px;background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.2);border-radius:var(--radius);">
            <span style="font-size:13px;font-weight:600;color:#DC2626;">⚠ Completion Issues</span>
            ${overdue > 0 ? `<span style="font-size:12px;background:#FEE2E2;color:#991B1B;padding:2px 10px;border-radius:99px;font-weight:600;">${overdue} overdue</span>` : ''}
            ${atRisk  > 0 ? `<span style="font-size:12px;background:#FEF3C7;color:#92400E;padding:2px 10px;border-radius:99px;font-weight:600;">${atRisk} at risk (≤3 days)</span>` : ''}
            ${late    > 0 ? `<span style="font-size:12px;background:#FEE2E2;color:#991B1B;padding:2px 10px;border-radius:99px;font-weight:600;">${late} completed late</span>` : ''}
          </div>`;
      }

      // Deadline status badge helper
      const deadlineBadge = (r) => {
        if (!r.deadlineStatus) return '<span style="color:var(--text-faint);font-size:11px;">—</span>';
        const map = {
          'on-time': [`background:#D1FAE5;color:#065F46`, `✅ On time${r.deadlineDelta != null ? ` (+${r.deadlineDelta}d)` : ''}`],
          'late':    [`background:#FEE2E2;color:#991B1B`, `❌ Late (${Math.abs(r.deadlineDelta)}d)`],
          'at-risk': [`background:#FEF3C7;color:#92400E`, `⚠ At risk`],
          'overdue': [`background:#FEE2E2;color:#991B1B`, `🔴 Overdue +${r.deadlineDelta}d`],
        };
        const [style, label] = map[r.deadlineStatus];
        return `<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;${style};">${label}</span>`;
      };

      html += `
        <div class="report-section">
          <div class="report-section-header">
            <div class="report-section-title">${escHtml(camp.name)}</div>
            <div class="report-section-stats" style="flex-wrap:wrap;gap:6px;">
              <span class="rs-stat rs-stat-blue">${total} members</span>
              <span class="rs-stat rs-stat-green">${complete} complete</span>
              <span class="rs-stat rs-stat-amber">${inProg} in progress</span>
              <span class="rs-stat rs-stat-red">${notStarted} not started</span>
              <span class="rs-stat rs-stat-navy">Avg ${avgPct}%</span>
              ${onTime > 0 ? `<span class="rs-stat" style="background:#D1FAE5;color:#065F46;">${onTime} on-time ✅</span>` : ''}
              ${deadlinePillHtml}
            </div>
          </div>

          <!-- Summary progress bar -->
          <div style="margin:10px 0 6px;">
            <div style="display:flex;gap:3px;height:8px;border-radius:4px;overflow:hidden;">
              <div style="width:${total>0?Math.round(complete/total*100):0}%;background:#059669;"></div>
              <div style="width:${total>0?Math.round(inProg/total*100):0}%;background:#D97706;"></div>
              <div style="width:${total>0?Math.round(notStarted/total*100):0}%;background:#DC2626;"></div>
            </div>
            <div style="display:flex;gap:14px;margin-top:5px;font-size:11px;color:var(--text-muted);">
              <span>🟢 Complete: ${total>0?Math.round(complete/total*100):0}%</span>
              <span>🟡 In Progress: ${total>0?Math.round(inProg/total*100):0}%</span>
              <span>🔴 Not Started: ${total>0?Math.round(notStarted/total*100):0}%</span>
            </div>
          </div>

          ${riskBannerHtml}

          <div class="report-table-wrap">
            <table class="report-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>D-5</th>
                  <th>D-1</th>
                  <th>Overall</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Last Active</th>
                  <th>Completed</th>
                  ${deadline ? '<th>vs Deadline</th>' : ''}
                  <th>Registrations</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length === 0
                  ? `<tr><td colspan="${deadline ? 10 : 9}" style="text-align:center;color:var(--text-muted);">No members assigned.</td></tr>`
                  : rows.map(r => {
                    const isAtRisk = r.deadlineStatus === 'at-risk' || r.deadlineStatus === 'overdue';
                    const regLines = r.entries.map(e => e.label || [e.brand,e.platform,e.region].filter(Boolean).join(' · ')).filter(Boolean);
                    const regId    = `reg-${r.member.uid}-${r.camp.id}`;
                    const regHtml  = regLines.length === 0 ? '—'
                      : regLines.length <= 2 ? regLines.join('<br>')
                      : `<div><span>${escHtml(regLines[0])}</span><span id="${regId}-more" style="display:none;">${regLines.slice(1).map(l=>'<br>'+escHtml(l)).join('')}</span><br><button onclick="toggleRegList('${regId}')" id="${regId}-btn" style="font-size:10px;color:var(--blue);background:none;border:none;cursor:pointer;padding:0;margin-top:2px;">+${regLines.length-1} more</button></div>`;
                    return `<tr data-report-status="${r.isComplete ? 'completed' : r.overallPct > 0 ? 'in-progress' : 'pending'}" style="${isAtRisk ? 'background:rgba(220,38,38,0.03);' : ''}">
                      <td>
                        <strong>${escHtml(r.member.name || r.member.username)}</strong><br>
                        <span style="font-size:11px;color:var(--text-muted)">@${escHtml(r.member.username)}</span>
                      </td>
                      <td>${r.hasD5 === false ? '<span style="color:var(--text-muted);font-size:11px;">N/A</span>' : `${miniBar(r.d5Pct)} ${r.d5Done}/${r.ti}`}</td>
                      <td>${miniBar(r.d1Pct)} ${r.d1Done}/${r.ti}</td>
                      <td><strong style="color:${r.isComplete?'#059669':r.overallPct>0?'#D97706':'#DC2626'}">${r.overallPct}%</strong></td>
                      <td><span class="badge ${r.statusCls}">${r.status}</span></td>
                      <td style="font-size:12px;color:var(--text-muted)">${r.startedAt ? fmtDate(r.startedAt) : r.overallPct > 0 ? fmtDate(r.lastActive) : '—'}</td>
                      <td style="font-size:12px;color:var(--text-muted)">${r.lastActive ? fmtDate(r.lastActive) : '—'}</td>
                      <td style="font-size:12px;">${r.isComplete ? `<span style="color:#059669;font-weight:600;">${r.completedAt ? fmtDate(r.completedAt) : '✅ Done'}</span>` : '<span style="color:var(--text-faint);">—</span>'}</td>
                      ${deadline ? `<td>${deadlineBadge(r)}</td>` : ''}
                      <td style="font-size:12px;">${regHtml}</td>
                    </tr>`;
                  }).join('')
                }
              </tbody>
            </table>
          </div>
        </div>`;
    });

    host.innerHTML = html;
    applyReportStatusFilter();

    // Auto-track completedAt: for any row that is 100% but missing completedAt, write it now
    campList.forEach(camp => {
      (camp.assignedUids || []).forEach(uid => {
        const cl = (allChecklists[uid] || {})[camp.id] || {};
        const campInfo = reportTotalItemsMap[camp.id] || { total: TOTAL_ITEMS, validIds: null };
        const d1Done = countDone(cl.d1 || {}, campInfo.validIds);
        const entryCount = (cl.entries || []).length || 1;
        // Overall completion is based on D-1 inputs alone for every user.
        const overallPct = Math.round((d1Done / (campInfo.total * entryCount)) * 100);
        if (overallPct === 100 && !cl.completedAt) {
          const updateData = {};
          updateData[`${camp.id}.completedAt`] = cl.lastActive || new Date().toISOString();
          if (!cl.startedAt) updateData[`${camp.id}.startedAt`] = cl.lastActive || new Date().toISOString();
          db.collection('checklists').doc(uid).update(updateData).catch(() => {});
        }
      });
    });

  } catch(e) {
    host.innerHTML = `<div style="padding:2rem;color:var(--text-muted);">Error loading report: ${escHtml(e.message)}</div>`;
    console.error(e);
  }
}

// ── Status filter for Reports tab ──────────
let _reportStatusFilter = 'all';

function filterReportByStatus(btn, status) {
  _reportStatusFilter = status;
  document.querySelectorAll('#report-status-filter-row .status-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  applyReportStatusFilter();
}

function applyReportStatusFilter() {
  const rows = document.querySelectorAll('#report-tab-content tr[data-report-status]');
  rows.forEach(tr => {
    const show = _reportStatusFilter === 'all' || tr.dataset.reportStatus === _reportStatusFilter;
    tr.style.display = show ? '' : 'none';
  });
}

// ── Excel/CSV export ──────────────────────────────────────────
async function exportReportToExcel() {
  const { campList, allChecklists, totalItemsMap } = window._reportData || {};
  if (!campList) { showToast('Please open the Reports tab first.', 'info'); return; }

  const today   = new Date(); today.setHours(0,0,0,0);
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB') : '';
  const daysDiff = (isoA, isoB) => Math.ceil((new Date(isoA) - new Date(isoB)) / 86400000);

  const rows = [['Campaign', 'D-Day', 'Deadline', 'Member', 'Username',
    'D-5 Done', 'D-5 Total', 'D-5 %',
    'D-1 Done', 'D-1 Total', 'D-1 %',
    'Overall %', 'Status', 'Started', 'Last Active', 'Completed',
    'vs Deadline', 'Deadline Status', 'Brand/Platform/Region']];

  campList.forEach(camp => {
    // Same normalization as the Reports tab — a date-only deadline string
    // parses as UTC midnight, which lands a few hours into the local day
    // in positive-UTC-offset timezones; zero it to local midnight before
    // doing any day-diff math so it lines up with `today`/`completedDay`.
    const deadline = camp.deadline ? new Date(camp.deadline) : null;
    if (deadline) deadline.setHours(0,0,0,0);
    (camp.assignedUids || []).forEach(uid => {
      const member = members[uid];
      if (!member) return;
      if (member.role !== 'member') return;
      const cl         = (allChecklists[uid] || {})[camp.id] || {};
      const campInfo   = (totalItemsMap && totalItemsMap[camp.id]) || { total: TOTAL_ITEMS, validIds: null, hasD5: true };
      const hasD5      = campInfo.hasD5 !== false;
      // Filter by validIds so leftover "done" flags from an item that was
      // since removed from the template don't inflate the count past 100%.
      const d5Done     = hasD5 ? countDone(cl.d5 || {}, campInfo.validIds) : 0;
      const d1Done     = countDone(cl.d1 || {}, campInfo.validIds);
      // Each entry has its own full set of items, so the denominator must
      // scale with entry count, AND use this campaign's actual template
      // size — never just the hardcoded default TOTAL_ITEMS (see
      // getEntryBreakdown / resolveCampaignTotalItems).
      const entryCount = (cl.entries || []).length || 1;
      const ti         = campInfo.total * entryCount;
      // Overall completion is based on D-1 inputs alone for every user.
      const overallPct = Math.round((d1Done / ti) * 100);
      const d5Pct      = hasD5 ? Math.round((d5Done / ti) * 100) : 0;
      const d1Pct      = Math.round((d1Done / ti) * 100);
      const status     = overallPct === 100 ? 'Complete' : overallPct > 0 ? 'In Progress' : 'Not Started';
      const entries    = (cl.entries || []).map(e => e.label || [e.brand, e.platform, e.region].filter(Boolean).join(' · ')).filter(Boolean).join(' | ');

      // Deadline analysis
      let deadlineStatus = '', vsDead = '';
      if (deadline) {
        const deadlinePast = deadline < today;
        if (overallPct === 100 && cl.completedAt) {
          const completedDay = new Date(cl.completedAt); completedDay.setHours(0,0,0,0);
          const delta = daysDiff(deadline, completedDay);
          deadlineStatus = delta >= 0 ? 'On Time' : 'Late';
          vsDead = delta >= 0 ? `+${delta}d early` : `${Math.abs(delta)}d late`;
        } else if (overallPct < 100) {
          deadlineStatus = deadlinePast ? 'Overdue' : daysDiff(deadline, today) <= 3 ? 'At Risk' : 'In Progress';
          if (deadlinePast) vsDead = `${daysDiff(today, deadline)}d overdue`;
        }
      }

      rows.push([
        camp.name, fmtDate(camp.dday), fmtDate(camp.deadline),
        member.name || member.username, member.username,
        hasD5 ? d5Done : 'N/A', hasD5 ? ti : 'N/A', hasD5 ? d5Pct + '%' : 'N/A',
        d1Done, ti, d1Pct + '%',
        overallPct + '%', status,
        fmtDate(cl.startedAt || (overallPct > 0 ? cl.lastActive : '')),
        fmtDate(cl.lastActive),
        fmtDate(cl.completedAt),
        vsDead, deadlineStatus, entries,
      ]);
    });
    rows.push([]); // blank row between campaigns
  });

  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `Trackory_Report_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('📊 Report exported!', 'success');
}

// ── Admin: Delete ALL campaigns ──
function openDeleteAllCampaignsModal() {
  document.getElementById('delete-all-camps-error').style.display = 'none';
  document.getElementById('delete-all-camps-password').value = '';
  document.getElementById('delete-all-camps-overlay').style.display = 'flex';
}

function closeDeleteAllCampaignsModal(e) {
  if (e && e.target !== document.getElementById('delete-all-camps-overlay')) return;
  document.getElementById('delete-all-camps-overlay').style.display = 'none';
}

async function confirmDeleteAllCampaigns() {
  const errEl = document.getElementById('delete-all-camps-error');
  errEl.style.display = 'none';
  const pwd = document.getElementById('delete-all-camps-password').value;
  if (pwd !== ADMIN_PASSWORD) {
    showError(errEl, 'Incorrect admin password. Please try again.');
    return;
  }
  const btn = document.getElementById('delete-all-camps-confirm-btn');
  btn.textContent = 'Deleting…'; btn.disabled = true;
  try {
    // Delete all campaigns
    const campSnap = await db.collection('campaigns').get();
    const batch1 = db.batch();
    campSnap.forEach(doc => batch1.delete(doc.ref));
    await batch1.commit();

    // Delete all checklists
    const clSnap = await db.collection('checklists').get();
    const batch2 = db.batch();
    clSnap.forEach(doc => batch2.delete(doc.ref));
    await batch2.commit();

    campaigns = {};
    userChecklist = {};
    document.getElementById('delete-all-camps-overlay').style.display = 'none';
    await loadAdminData();
    showToast('✅ All campaigns and assignments deleted.', 'success');
  } catch(e) {
    showError(errEl, 'Failed to delete campaigns. Try again.');
    console.error(e);
  } finally {
    btn.textContent = 'Delete ALL Campaigns'; btn.disabled = false;
  }
}


// ═════════════════════════════════════════════════════════════
//  CSV MEMBER IMPORT
// ═════════════════════════════════════════════════════════════
let importedMembersPreview = [];

function openImportMembersModal() {
  importedMembersPreview = [];
  document.getElementById('import-csv-file').value = '';
  document.getElementById('import-preview').innerHTML = '';
  document.getElementById('import-members-error').style.display = 'none';
  document.getElementById('import-members-overlay').style.display = 'flex';
}

function closeImportMembersModal(e) {
  if (e && e.target !== document.getElementById('import-members-overlay')) return;
  document.getElementById('import-members-overlay').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', () => {
  const fi = document.getElementById('import-csv-file');
  if (fi) fi.addEventListener('change', handleImportCsvChange);
});

// Derive a username slug from a display name (e.g. "Jane Smith" → "jane.smith")
function deriveUsername(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '.');
}

function handleImportCsvChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  const errEl = document.getElementById('import-members-error');
  errEl.style.display = 'none';
  importedMembersPreview = [];
  document.getElementById('import-preview').innerHTML = '';

  const isXlsx = /\.(xlsx|xls|xlsm)$/i.test(file.name);

  if (isXlsx) {
    // Excel path — use SheetJS
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        _parseImportRows(rows, errEl);
      } catch(err) {
        showError(errEl, 'Failed to read the file. Make sure it is a valid .xlsx or .xls file.');
        console.error(err);
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    // CSV path
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result.replace(/^\uFEFF/, ''); // strip BOM some Excel CSV exports add
      const rows = text.split(/\r?\n/).map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
      _parseImportRows(rows, errEl);
    };
    reader.readAsText(file);
  }
}

function _parseImportRows(rows, errEl) {
  if (rows.length < 2) {
    showError(errEl, 'File appears empty or has no data rows.');
    return;
  }
  const headerRowIdx = _findHeaderRowIndex(rows, [['name'], ['password']]);
  if (headerRowIdx < 0) {
    showError(errEl, 'File must have columns: Name, Password (Username is optional — auto-generated if missing). Make sure that row is the first row with those exact column headers (no title row above it).');
    return;
  }
  const headers = rows[headerRowIdx].map(h => String(h).toLowerCase().trim());
  const nIdx = headers.indexOf('name');
  const pIdx = headers.indexOf('password');
  const uIdx = headers.indexOf('username'); // optional

  document.getElementById('import-members-error').style.display = 'none';
  importedMembersPreview = [];
  rows.slice(headerRowIdx + 1).forEach(r => {
    if (r.length <= Math.max(nIdx, pIdx)) return;
    const name     = String(r[nIdx] || '').trim();
    const password = String(r[pIdx] || '').trim();
    if (!name || !password) return;
    const username = (uIdx >= 0 && String(r[uIdx] || '').trim())
      ? String(r[uIdx]).trim().toLowerCase()
      : deriveUsername(name);
    importedMembersPreview.push({ username, name, password });
  });
  const prev = document.getElementById('import-preview');
  if (importedMembersPreview.length === 0) {
    prev.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No valid rows found.</div>';
    return;
  }
  prev.innerHTML = `
    <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">${importedMembersPreview.length} members to import</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:var(--surface2);">
        <th style="padding:5px 8px;text-align:left;">Name</th>
        <th style="padding:5px 8px;text-align:left;">Username (auto)</th>
      </tr></thead>
      <tbody>${importedMembersPreview.map(m => `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:5px 8px;">${escHtml(m.name)}</td>
        <td style="padding:5px 8px;color:var(--text-muted);">@${escHtml(m.username)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

async function confirmImportMembers() {
  const errEl = document.getElementById('import-members-error');
  if (importedMembersPreview.length === 0) { showError(errEl, 'No members to import. Please upload a valid Excel or CSV file first.'); return; }
  const btn = document.getElementById('import-members-btn');
  btn.textContent = 'Importing…'; btn.disabled = true;
  let added = 0, skipped = 0;
  try {
    for (const m of importedMembersPreview) {
      if (m.username === ADMIN_USERNAME) { skipped++; continue; }
      const existing = await db.collection('users').where('username', '==', m.username).limit(1).get();
      if (!existing.empty) { skipped++; continue; }
      const ref = await db.collection('users').add({ username: m.username, name: m.name, password: m.password, role: 'member' });
      members[ref.id] = { uid: ref.id, ...m, role: 'member' };
      added++;
    }
    document.getElementById('import-members-overlay').style.display = 'none';
    await loadAdminData();
    showToast(`✅ Imported ${added} member(s)${skipped ? ', skipped '+skipped+' (already exist)' : ''}.`, 'success');
  } catch(e) {
    showError(errEl, 'Import failed. Try again.'); console.error(e);
  } finally {
    btn.textContent = '📥 Import Members'; btn.disabled = false;
  }
}

// ═════════════════════════════════════════════════════════════
//  BULK ASSIGN BRANDS VIA EXCEL  (Admin)
//  Skips the poll entirely — admin uploads CDM ↔ brand/platform/region
//  rows directly, and we auto-generate checklist entries.
// ═════════════════════════════════════════════════════════════
let bulkAssignMatched   = {}; // { uid: [{label,brand,platform,region}] }
let bulkAssignUnmatched = []; // usernames in file that don't match any member
let bulkAssignBadRegions = []; // region spellings that don't map to a known market

function openBulkAssignModal() {
  bulkAssignMatched   = {};
  bulkAssignUnmatched = [];
  bulkAssignBadRegions = [];
  document.getElementById('bulk-assign-file').value = '';
  document.getElementById('bulk-assign-preview').innerHTML = '';
  document.getElementById('bulk-assign-error').style.display = 'none';
  document.getElementById('bulk-assign-btn').disabled = true;
  document.getElementById('bulk-assign-new-name').value = '';
  const _dDate = document.getElementById('bulk-assign-deadline-date');
  const _dTime = document.getElementById('bulk-assign-deadline-time');
  if (_dDate) _dDate.value = '';
  if (_dTime) _dTime.value = '';

  const sel = document.getElementById('bulk-assign-campaign-sel');
  const activeCamps = Object.values(campaigns).sort((a, b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0));
  sel.innerHTML = '<option value="__new__">➕ Create a new campaign</option>' +
    activeCamps.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
  onBulkAssignCampaignChange();

  document.getElementById('bulk-assign-overlay').style.display = 'flex';
}

function closeBulkAssignModal(e) {
  if (e && e.target !== document.getElementById('bulk-assign-overlay')) return;
  document.getElementById('bulk-assign-overlay').style.display = 'none';
}

function onBulkAssignCampaignChange() {
  const isNew = document.getElementById('bulk-assign-campaign-sel').value === '__new__';
  document.getElementById('bulk-assign-new-name-field').style.display = isNew ? '' : 'none';
  // Deadline is only settable when creating a new campaign; existing campaigns
  // keep whatever deadline they already have.
  const dlField = document.getElementById('bulk-assign-deadline-field');
  if (dlField) dlField.style.display = isNew ? '' : 'none';
}

function downloadBulkAssignTemplate() {
  const csv = 'username,brand,platform,region\njane,Marc Jacobs,Lazada,SG\njane,Marc Jacobs,Shopee,SG\nmark,Marc Jacobs,Lazada,MY\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'bulk-assign-template.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function handleBulkAssignFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  const errEl = document.getElementById('bulk-assign-error');
  errEl.style.display = 'none';
  bulkAssignMatched = {};
  bulkAssignUnmatched = [];
  bulkAssignBadRegions = [];
  document.getElementById('bulk-assign-preview').innerHTML = '';
  document.getElementById('bulk-assign-btn').disabled = true;

  const isXlsx = /\.(xlsx|xls|xlsm)$/i.test(file.name);
  if (isXlsx) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        _parseBulkAssignRows(rows, errEl);
      } catch (err) {
        showError(errEl, 'Failed to read the file. Make sure it is a valid .xlsx or .xls file.');
        console.error(err);
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result.replace(/^\uFEFF/, ''); // strip BOM some Excel CSV exports add
      const rows = text.split(/\r?\n/).filter(r => r.trim() !== '').map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
      _parseBulkAssignRows(rows, errEl);
    };
    reader.readAsText(file);
  }
}

// Builds lookup maps so a sheet's identifier column can be matched against
// a member's username, full name, OR just their first name (best-effort —
// flags it as ambiguous if more than one member shares that first name).
function _buildMemberLookup() {
  const byUsername = {};
  const byFullName = {};
  const byFirstName = {};
  Object.values(members).forEach(m => {
    if (m.username) byUsername[m.username.toLowerCase()] = m;
    const name = (m.name || '').trim();
    if (name) {
      byFullName[name.toLowerCase()] = m;
      const first = name.split(/\s+/)[0].toLowerCase();
      if (first) {
        if (!byFirstName[first]) byFirstName[first] = [];
        byFirstName[first].push(m);
      }
    }
  });
  return { byUsername, byFullName, byFirstName };
}

// identifier: whatever string was in the sheet's Username/Name column.
// Returns { member, ambiguous } — member is null if no confident match found.
function _findMemberByIdentifier(identifier, lookup) {
  const id = String(identifier || '').trim().toLowerCase();
  if (!id) return { member: null, ambiguous: false };
  if (lookup.byUsername[id]) return { member: lookup.byUsername[id], ambiguous: false };
  if (lookup.byFullName[id]) return { member: lookup.byFullName[id], ambiguous: false };
  const firstNameId = id.split(/\s+/)[0];
  const candidates = lookup.byFirstName[firstNameId];
  if (candidates && candidates.length === 1) return { member: candidates[0], ambiguous: false };
  if (candidates && candidates.length > 1) return { member: null, ambiguous: true };
  return { member: null, ambiguous: false };
}

// Some exports have a title/instructions row above the real header row.
// Scan the first several rows for one that actually contains the required
// column names, instead of blindly assuming row 0 is the header.
function _findHeaderRowIndex(rows, requiredHeaderSets) {
  const limit = Math.min(rows.length, 10);
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] || []).map(h => String(h || '').toLowerCase().trim());
    const matchesAll = requiredHeaderSets.every(set => set.some(name => cells.includes(name)));
    if (matchesAll) return i;
  }
  return -1;
}

function _parseBulkAssignRows(rows, errEl) {
  if (rows.length < 2) { showError(errEl, 'File appears empty or has no data rows.'); return; }

  const headerRowIdx = _findHeaderRowIndex(rows, [['username', 'name'], ['brand'], ['platform'], ['region']]);
  if (headerRowIdx < 0) {
    showError(errEl, 'File must have columns: Username (or Name), Brand, Platform, Region. Make sure that row is the first row with those exact column headers (no title row above it).');
    return;
  }

  const headers = rows[headerRowIdx].map(h => String(h).toLowerCase().trim());
  const uIdx = headers.indexOf('username') >= 0 ? headers.indexOf('username') : headers.indexOf('name');
  const bIdx = headers.indexOf('brand');
  const pIdx = headers.indexOf('platform');
  const rIdx = headers.indexOf('region');

  const lookup = _buildMemberLookup();

  bulkAssignMatched = {};
  const unmatchedSet = new Set();
  const ambiguousSet = new Set();
  const badRegionSet = new Set();

  rows.slice(headerRowIdx + 1).forEach(r => {
    if (r.length <= Math.max(uIdx, bIdx, pIdx, rIdx)) return;
    const identifier = String(r[uIdx] || '').trim();
    const brand    = String(r[bIdx] || '').trim();
    const platform = String(r[pIdx] || '').trim();
    const rawRegion = String(r[rIdx] || '').trim();
    // Canonicalise so the region code matches the per-region deadline map keys
    // exactly (SG, MY, PH, VN, TH, LAZ). Unknown spellings still generate an
    // entry (kept uppercased) but are flagged — they won't join to a calendar
    // deadline and would silently never be marked overdue otherwise.
    const region   = _normalizeRegionCode(rawRegion) || rawRegion.toUpperCase();
    if (rawRegion && !_normalizeRegionCode(rawRegion)) badRegionSet.add(rawRegion);
    if (!identifier || !brand) return;

    const { member, ambiguous } = _findMemberByIdentifier(identifier, lookup);
    if (!member) {
      if (ambiguous) ambiguousSet.add(identifier); else unmatchedSet.add(identifier);
      return;
    }

    const entry = { label: [brand, platform, region].filter(Boolean).join('_'), brand, platform, region };
    if (!bulkAssignMatched[member.uid]) bulkAssignMatched[member.uid] = [];
    // Skip exact duplicates within the same upload
    if (!bulkAssignMatched[member.uid].some(en => en.brand === brand && en.platform === platform && en.region === region)) {
      bulkAssignMatched[member.uid].push(entry);
    }
  });

  bulkAssignUnmatched = [...unmatchedSet, ...[...ambiguousSet].map(n => `${n} (multiple members share this first name — use full name or username instead)`)];
  bulkAssignBadRegions = [...badRegionSet];
  // Keep a reusable roster so the calendar's per-region generator can slice it
  // later without re-uploading the sheet.
  _persistRosterFromMatched(bulkAssignMatched);
  _renderBulkAssignPreview();
}



function _renderBulkAssignPreview() {
  const prev = document.getElementById('bulk-assign-preview');
  const uids = Object.keys(bulkAssignMatched);
  const totalEntries = uids.reduce((s, uid) => s + bulkAssignMatched[uid].length, 0);

  if (uids.length === 0 && bulkAssignUnmatched.length === 0) {
    prev.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No valid rows found.</div>';
    document.getElementById('bulk-assign-btn').disabled = true;
    return;
  }

  let html = `<div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">${uids.length} CDM(s), ${totalEntries} entries to generate</div>`;
  html += uids.map(uid => {
    const m = members[uid];
    const chips = bulkAssignMatched[uid].map(en => `<span class="rp-reg-tag" style="margin:2px 4px 2px 0;display:inline-block;">${escHtml(en.label)}</span>`).join('');
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border);">
      <div style="font-size:13px;font-weight:600;">${escHtml(m?.name || m?.username || uid)}</div>
      <div style="margin-top:3px;">${chips}</div>
    </div>`;
  }).join('');

  if (bulkAssignUnmatched.length > 0) {
    html += `<div style="margin-top:10px;padding:8px 10px;background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.25);border-radius:8px;font-size:12px;color:#DC2626;">
      ⚠️ Unmatched username(s), skipped: ${bulkAssignUnmatched.map(escHtml).join(', ')}
    </div>`;
  }

  if (bulkAssignBadRegions && bulkAssignBadRegions.length > 0) {
    html += `<div style="margin-top:8px;padding:8px 10px;background:rgba(217,119,6,0.08);border:1px solid rgba(217,119,6,0.3);border-radius:8px;font-size:12px;color:#B45309;">
      ⚠️ Unrecognised region(s): ${bulkAssignBadRegions.map(escHtml).join(', ')}. These won't match a calendar deadline — use one of ${CAL_REGIONS.map(r => r.id).join(', ')}, or they'll fall back to the campaign-wide deadline.
    </div>`;
  }

  prev.innerHTML = html;
  document.getElementById('bulk-assign-btn').disabled = uids.length === 0;
}

async function confirmBulkAssign() {
  const errEl = document.getElementById('bulk-assign-error');
  errEl.style.display = 'none';
  const uids = Object.keys(bulkAssignMatched);
  if (uids.length === 0) { showError(errEl, 'No matched CDMs to assign. Upload a valid file first.'); return; }

  const sel = document.getElementById('bulk-assign-campaign-sel');
  const isNew = sel.value === '__new__';
  let campaignId = sel.value;
  let campaignName = '';

  if (isNew) {
    campaignName = document.getElementById('bulk-assign-new-name').value.trim();
    if (!campaignName) { showError(errEl, 'Please enter a name for the new campaign.'); return; }
  } else {
    const camp = campaigns[campaignId];
    if (!camp) { showError(errEl, 'Selected campaign not found.'); return; }
    campaignName = camp.name;
  }

  const btn = document.getElementById('bulk-assign-btn');
  btn.textContent = 'Generating…'; btn.disabled = true;

  // Build the per-region deadline map from the calendar for this generation.
  // Scope (month + campaign phase) is inferred from the campaign name
  // ("Mid-Month — Jul 2026" etc.); missing parts fall back to the current
  // month / all phases so it still produces a usable map.
  const _scope = inferGenScopeFromName(campaignName);
  const _now = new Date();
  const regionDeadlines = buildRegionDeadlineMap({
    year:  _scope.year  != null ? _scope.year  : _now.getFullYear(),
    month: _scope.month != null ? _scope.month : _now.getMonth(),
    campaignType: _scope.campaignType || null,
  });
  const _hasDeadlines = regionDeadlines && Object.keys(regionDeadlines).length > 0;

  // Campaign-wide checklist deadline typed into the modal (new campaigns only).
  // This is the fallback every region without its own calendar-derived deadline
  // uses, so no region is left un-deadlined (and therefore invisible in the
  // overdue/pending trace). Combine the date + time inputs into the same
  // "YYYY-MM-DDTHH:mm" / "YYYY-MM-DD" shape the rest of the app stores.
  const _campWideDeadline = (() => {
    const d = document.getElementById('bulk-assign-deadline-date')?.value || '';
    const t = document.getElementById('bulk-assign-deadline-time')?.value || '';
    if (!d) return null;
    return t ? `${d}T${t}` : d;
  })();

  // Guard: for a NEW campaign, refuse to create something where a region could
  // end up with no deadline at all. That happens only when there's no
  // campaign-wide deadline AND no per-region deadlines to fall back on.
  if (isNew && !_campWideDeadline && !_hasDeadlines) {
    showError(errEl, 'Set a Checklist Deadline (or make sure the calendar has timed events for these regions) before generating — otherwise nothing can ever be marked overdue.');
    btn.textContent = '📊 Generate Entries'; btn.disabled = false;
    return;
  }

  try {
    if (isNew) {
      const ref = await db.collection('campaigns').add({
        name: campaignName,
        assignedUids: uids,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: ADMIN_UID,
        fromPollId: null,
        checklistTemplateId: null,
        dday: null,
        deadline: _campWideDeadline,
        regionDeadlines: _hasDeadlines ? regionDeadlines : null,
      });
      campaignId = ref.id;
    } else {
      // Add any newly-assigned CDMs to the campaign's assignedUids, and refresh
      // the per-region deadline map from the calendar (calendar stays the
      // source of truth even when re-running assign on an existing campaign).
      const _update = { assignedUids: firebase.firestore.FieldValue.arrayUnion(...uids) };
      if (_hasDeadlines) _update.regionDeadlines = regionDeadlines;
      await db.collection('campaigns').doc(campaignId).update(_update);
    }

    // Merge entries into each CDM's checklist for this campaign —
    // append new ones, skip exact duplicates of brand+platform+region,
    // and never touch their existing progress/status on current entries.
    await Promise.all(uids.map(async uid => {
      const docRef = db.collection('checklists').doc(uid);
      const snap = await docRef.get();
      const existingCampData = (snap.exists && snap.data()[campaignId]) || {};
      const existingEntries = existingCampData.entries || [];
      const newOnes = bulkAssignMatched[uid].filter(en =>
        !existingEntries.some(ex => ex.brand === en.brand && ex.platform === en.platform && ex.region === en.region)
      );
      const mergedEntries = [...existingEntries, ...newOnes];
      await docRef.set({
        [campaignId]: { ...existingCampData, entries: mergedEntries, lastActive: new Date().toISOString() }
      }, { merge: true });
    }));

    await db.collection('broadcasts').add({
      type: 'custom',
      message: `🚀 Campaign "${campaignName}" — your brand assignments have been added! Go to the Checklist tab to start.`,
      targetUid: null, targetName: 'everyone',
      campaignId, campaignName,
      sentAt: new Date().toISOString(), sentBy: 'Admin', readBy: [],
    });

    document.getElementById('bulk-assign-overlay').style.display = 'none';
    await loadAdminData();
    showToast(`✅ Generated entries for ${uids.length} CDM(s) in "${campaignName}".`, 'success');
  } catch (e) {
    showError(errEl, 'Failed to generate entries. Try again.');
    console.error(e);
  } finally {
    btn.textContent = '📊 Generate Entries'; btn.disabled = false;
  }
}

// Shared parser: turns raw sheet rows into { matched: {uid:[entries]}, unmatched: [usernames] }
function parseBrandAssignmentRows(rows) {
  const result = { matched: {}, unmatched: [], error: null };
  if (rows.length < 2) { result.error = 'File appears empty or has no data rows.'; return result; }
  const headerRowIdx = _findHeaderRowIndex(rows, [['username', 'name'], ['brand'], ['platform'], ['region']]);
  if (headerRowIdx < 0) {
    result.error = 'File must have columns: Username (or Name), Brand, Platform, Region. Make sure that row is the first row with those exact column headers (no title row above it).';
    return result;
  }
  const headers = rows[headerRowIdx].map(h => String(h).toLowerCase().trim());
  const uIdx = headers.indexOf('username') >= 0 ? headers.indexOf('username') : headers.indexOf('name');
  const bIdx = headers.indexOf('brand');
  const pIdx = headers.indexOf('platform');
  const rIdx = headers.indexOf('region');

  const lookup = _buildMemberLookup();

  const unmatchedSet = new Set();
  const ambiguousSet = new Set();
  const badRegionSet = new Set(); // sheet regions that don't map to a known market
  rows.slice(headerRowIdx + 1).forEach(r => {
    if (r.length <= Math.max(uIdx, bIdx, pIdx, rIdx)) return;
    const identifier = String(r[uIdx] || '').trim();
    const brand    = String(r[bIdx] || '').trim();
    const platform = String(r[pIdx] || '').trim();
    const rawRegion = String(r[rIdx] || '').trim();
    // Canonicalise the region so its code matches the per-region deadline map's
    // keys exactly. Unknown spellings are kept as-typed (so the entry still
    // generates) but flagged, because they won't join to a calendar deadline.
    const region   = _normalizeRegionCode(rawRegion) || rawRegion.toUpperCase();
    if (rawRegion && !_normalizeRegionCode(rawRegion)) badRegionSet.add(rawRegion);
    if (!identifier || !brand) return;

    const { member, ambiguous } = _findMemberByIdentifier(identifier, lookup);
    if (!member) {
      if (ambiguous) ambiguousSet.add(identifier); else unmatchedSet.add(identifier);
      return;
    }

    const entry = { label: [brand, platform, region].filter(Boolean).join('_'), brand, platform, region };
    if (!result.matched[member.uid]) result.matched[member.uid] = [];
    if (!result.matched[member.uid].some(en => en.brand === brand && en.platform === platform && en.region === region)) {
      result.matched[member.uid].push(entry);
    }
  });

  result.unmatched = [...unmatchedSet, ...[...ambiguousSet].map(n => `${n} (multiple members share this first name — use full name or username instead)`)];
  result.badRegions = [...badRegionSet]; // regions with no known market → won't get a calendar deadline
  return result;
}

function readSheetRows(file, callback) {
  const isXlsx = /\.(xlsx|xls|xlsm)$/i.test(file.name);
  if (isXlsx) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        callback(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }), null);
      } catch (err) { callback(null, 'Failed to read the file. Make sure it is a valid .xlsx or .xls file.'); console.error(err); }
    };
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result.replace(/^\uFEFF/, ''); // strip BOM some Excel CSV exports add
      const rows = text.split(/\r?\n/).filter(r => r.trim() !== '').map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
      callback(rows, null);
    };
    reader.readAsText(file);
  }
}

function renderBrandAssignmentPreview(hostEl, matched, unmatched, compact) {
  const uids = Object.keys(matched);
  const totalEntries = uids.reduce((s, uid) => s + matched[uid].length, 0);
  if (uids.length === 0 && unmatched.length === 0) {
    hostEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No valid rows found.</div>';
    return;
  }
  let html = `<div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">${uids.length} CDM(s), ${totalEntries} entries${compact ? '' : ' to generate'}</div>`;
  html += uids.map(uid => {
    const m = members[uid];
    const chips = matched[uid].map(en => `<span class="rp-reg-tag" style="margin:2px 4px 2px 0;display:inline-block;">${escHtml(en.label)}</span>`).join('');
    return `<div style="padding:${compact ? '4px' : '6px'} 0;border-bottom:1px solid var(--border);">
      <div style="font-size:${compact ? '12px' : '13px'};font-weight:600;">${escHtml(m?.name || m?.username || uid)}</div>
      <div style="margin-top:3px;">${chips}</div>
    </div>`;
  }).join('');
  if (unmatched.length > 0) {
    html += `<div style="margin-top:10px;padding:8px 10px;background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.25);border-radius:8px;font-size:12px;color:#DC2626;">
      ⚠️ Unmatched username(s), skipped: ${unmatched.map(escHtml).join(', ')}
    </div>`;
  }
  hostEl.innerHTML = html;
}

// ── New Campaign modal: optional bulk-assign-via-Excel field ──
let newCampBulkMatched = {};

function handleNewCampBulkFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  readSheetRows(file, (rows, err) => {
    const previewEl = document.getElementById('new-camp-bulk-preview');
    if (err) { previewEl.innerHTML = `<div class="error-msg" style="display:block;">${escHtml(err)}</div>`; return; }
    const { matched, unmatched, error } = parseBrandAssignmentRows(rows);
    if (error) { previewEl.innerHTML = `<div class="error-msg" style="display:block;">${escHtml(error)}</div>`; return; }
    newCampBulkMatched = matched;
    _persistRosterFromMatched(matched);
    renderBrandAssignmentPreview(previewEl, matched, unmatched, true);
    // Auto-check matched members in the assign list above
    Object.keys(matched).forEach(uid => {
      const chip = document.querySelector(`#member-assign-list .member-chip[data-uid="${uid}"]`);
      if (chip) chip.classList.add('selected');
    });
  });
}

// ═════════════════════════════════════════════════════════════
//  MASTERLIST  (brand / platform / region / PIC reference data)
//  settings/masterlist → { items: [{brand,platform,region,pic}], updatedAt }
//  Used to map CDMs to valid brand/platform/region combos without
//  free-typing them, then feeds straight into Bulk Assign.
//  "PIC" (person in charge) is matched by name against existing members
//  so rows can be auto-assigned instead of picked manually every time.
// ═════════════════════════════════════════════════════════════
let masterlistItems = []; // [{brand, platform, region, pic}]

async function loadMasterlist() {
  try {
    const doc = await db.collection('settings').doc('masterlist').get();
    masterlistItems = doc.exists ? (doc.data().items || []) : [];
  } catch (e) { masterlistItems = []; console.error('loadMasterlist error:', e); }
  renderMasterlistSummary();
}

function renderMasterlistSummary() {
  const host = document.getElementById('masterlist-summary');
  if (!host) return;
  if (masterlistItems.length === 0) {
    host.innerHTML = `<span>No masterlist uploaded yet. Upload an Excel/CSV with columns <strong>Brand, Platform, Region, PIC</strong> to get started.</span>`;
    return;
  }
  const brandCount = new Set(masterlistItems.map(i => i.brand)).size;
  const picCount = masterlistItems.filter(i => i.pic).length;
  host.innerHTML = `
    <strong>${masterlistItems.length}</strong> brand/platform/region combo(s) across <strong>${brandCount}</strong> brand(s)
    (${picCount} with a PIC name).
    <button class="btn-ghost-light" style="font-size:11px;padding:3px 10px;margin-left:8px;color:#DC2626;" onclick="clearMasterlist()">🗑 Clear masterlist</button>`;
}

function handleMasterlistFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (masterlistItems.length > 0 && !confirm('This will replace your current masterlist. Continue?')) {
    e.target.value = '';
    return;
  }
  const readingToast = showToast(`📄 Reading "${file.name}"…`, 'info', /* persistent */ true);
  readSheetRows(file, async (rows, err) => {
    if (err) { dismissToast(readingToast); showToast(err, 'error'); return; }
    if (rows.length < 2) { dismissToast(readingToast); showToast('File appears empty or has no data rows.', 'error'); return; }
    const headerRowIdx = _findHeaderRowIndex(rows, [['brand']]);
    if (headerRowIdx < 0) { dismissToast(readingToast); showToast('File must have a "Brand" column (Platform, Region, PIC optional). Make sure that row is the first row with the column headers (no title row above it).', 'error'); return; }
    const headers = rows[headerRowIdx].map(h => String(h).toLowerCase().trim());
    const bIdx = headers.indexOf('brand');
    const pIdx = headers.indexOf('platform');
    const rIdx = headers.indexOf('region');
    const picIdx = headers.indexOf('pic');

    const seen = new Set();
    const items = [];
    rows.slice(headerRowIdx + 1).forEach(r => {
      const brand    = String(r[bIdx] || '').trim();
      const platform = pIdx >= 0 ? String(r[pIdx] || '').trim() : '';
      const region    = rIdx >= 0 ? String(r[rIdx] || '').trim() : '';
      const pic       = picIdx >= 0 ? String(r[picIdx] || '').trim() : '';
      if (!brand) return;
      const key = `${brand}|${platform}|${region}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ brand, platform, region, pic });
    });

    if (items.length === 0) { dismissToast(readingToast); showToast('No valid rows found.', 'error'); return; }

    try {
      await db.collection('settings').doc('masterlist').set({ items, updatedAt: new Date().toISOString() });
      masterlistItems = items;
      renderMasterlistSummary();
      dismissToast(readingToast);
      showToast(`✅ Masterlist uploaded — ${items.length} combo(s).`, 'success');
    } catch (err2) {
      dismissToast(readingToast);
      showToast('Failed to save masterlist. Try again.', 'error');
      console.error(err2);
    }
    e.target.value = '';
  });
}

async function clearMasterlist() {
  if (!confirm('Delete the entire masterlist? This cannot be undone.')) return;
  try {
    await db.collection('settings').doc('masterlist').delete();
    masterlistItems = [];
    renderMasterlistSummary();
    showToast('✅ Masterlist cleared.', 'success');
  } catch (e) {
    showToast('Failed to clear masterlist.', 'error'); console.error(e);
  }
}

// ─── Map Masterlist → CDM ─────────────────────────────────────
let mapWorkingRows = []; // [{uid, username, name, brand, platform, region}]

function openMapMasterlistModal() {
  if (masterlistItems.length === 0) {
    showToast('Upload a masterlist first.', 'info');
    return;
  }
  mapWorkingRows = [];
  document.getElementById('map-masterlist-error').style.display = 'none';
  document.getElementById('map-brand-filter').value = '';

  const sel = document.getElementById('map-cdm-sel');
  const nonAdmins = Object.values(members).filter(m => m.role !== 'admin')
    .sort((a, b) => (a.name || a.username || '').localeCompare(b.name || b.username || ''));
  sel.innerHTML = nonAdmins.map(m => `<option value="${m.uid}">${escHtml(m.name || m.username)} (@${escHtml(m.username)})</option>`).join('');

  renderMapBrandChecklist();
  renderMapWorkingTable();
  document.getElementById('map-masterlist-overlay').style.display = 'flex';
}

function closeMapMasterlistModal(e) {
  if (e && e.target !== document.getElementById('map-masterlist-overlay')) return;
  document.getElementById('map-masterlist-overlay').style.display = 'none';
}

function renderMapBrandChecklist(filterText) {
  const host = document.getElementById('map-brand-checklist');
  const q = (filterText || '').trim().toLowerCase();

  const grouped = {};
  masterlistItems.forEach((item, idx) => {
    if (q && !item.brand.toLowerCase().includes(q)) return;
    if (!grouped[item.brand]) grouped[item.brand] = [];
    grouped[item.brand].push({ ...item, idx });
  });

  const brands = Object.keys(grouped).sort();
  if (brands.length === 0) {
    host.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No matching brands.</div>';
    return;
  }

  host.innerHTML = brands.map(brand => `
    <div style="margin-bottom:8px;">
      <div style="font-size:12px;font-weight:700;color:var(--navy);margin-bottom:3px;">${escHtml(brand)}</div>
      ${grouped[brand].map(item => `
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;padding:2px 0 2px 8px;">
          <input type="checkbox" class="map-item-cb" data-idx="${item.idx}" style="accent-color:var(--blue);width:14px;height:14px;" />
          <span>${escHtml([item.platform, item.region].filter(Boolean).join(' · ') || '—')}</span>
          ${item.pic ? `<span style="color:var(--text-muted);font-size:11px;">— PIC: ${escHtml(item.pic)}</span>` : ''}
        </label>
      `).join('')}
    </div>
  `).join('');
}

function filterMapBrandChecklist(query) { renderMapBrandChecklist(query); }

// Normalize a name for matching: lowercase, trim, collapse whitespace.
function _normName(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

// Auto-match every masterlist row that has a PIC name to an existing member
// (matched against member.name, falling back to member.username), and add
// matches straight into the working table. Rows whose PIC can't be matched
// to any member are reported back so they can be fixed or added manually.
function autoMatchMasterlistByPic() {
  const errEl = document.getElementById('map-masterlist-error');
  errEl.style.display = 'none';

  const nameIndex = {};
  Object.values(members).forEach(m => {
    if (m.role === 'admin') return;
    nameIndex[_normName(m.name)] = m;
    nameIndex[_normName(m.username)] = m;
  });

  let added = 0;
  const unmatched = [];

  masterlistItems.forEach(item => {
    if (!item.pic) return;
    const member = nameIndex[_normName(item.pic)];
    if (!member) { unmatched.push(item); return; }
    const dup = mapWorkingRows.some(r => r.uid === member.uid && r.brand === item.brand && r.platform === item.platform && r.region === item.region);
    if (!dup) {
      mapWorkingRows.push({ uid: member.uid, username: member.username, name: member.name || member.username, brand: item.brand, platform: item.platform, region: item.region });
      added++;
    }
  });

  renderMapWorkingTable();

  if (unmatched.length > 0) {
    const names = [...new Set(unmatched.map(i => i.pic))];
    showError(errEl, `Added ${added} row(s). ${unmatched.length} row(s) couldn't be matched — no member named: ${names.join(', ')}. Check spelling or add them as members first.`);
  } else if (added === 0) {
    showToast('No new PIC matches to add — everything with a PIC is already in the list.', 'info');
  } else {
    showToast(`✅ Auto-matched ${added} row(s) by PIC name.`, 'success');
  }
}

function addMapSelectionToWorking() {
  const errEl = document.getElementById('map-masterlist-error');
  errEl.style.display = 'none';

  const uid = document.getElementById('map-cdm-sel').value;
  const member = members[uid];
  if (!member) { showError(errEl, 'Please select a CDM.'); return; }

  const checked = [...document.querySelectorAll('.map-item-cb:checked')];
  if (checked.length === 0) { showError(errEl, 'Tick at least one brand/platform/region combo.'); return; }

  checked.forEach(cb => {
    const item = masterlistItems[parseInt(cb.dataset.idx, 10)];
    if (!item) return;
    const dup = mapWorkingRows.some(r => r.uid === uid && r.brand === item.brand && r.platform === item.platform && r.region === item.region);
    if (!dup) {
      mapWorkingRows.push({ uid, username: member.username, name: member.name || member.username, brand: item.brand, platform: item.platform, region: item.region });
    }
  });

  // Reset checkboxes for the next CDM, keep the masterlist filter as-is
  document.querySelectorAll('.map-item-cb:checked').forEach(cb => cb.checked = false);
  renderMapWorkingTable();
}

function renderMapWorkingTable() {
  const host = document.getElementById('map-working-table');
  document.getElementById('map-working-count').textContent = mapWorkingRows.length;

  if (mapWorkingRows.length === 0) {
    host.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:12px;text-align:center;">No mappings added yet.</div>';
    return;
  }

  host.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:var(--surface2);position:sticky;top:0;">
        <th style="padding:5px 8px;text-align:left;">CDM</th>
        <th style="padding:5px 8px;text-align:left;">Brand</th>
        <th style="padding:5px 8px;text-align:left;">Platform</th>
        <th style="padding:5px 8px;text-align:left;">Region</th>
        <th></th>
      </tr></thead>
      <tbody>${mapWorkingRows.map((r, i) => `
        <tr style="border-bottom:1px solid var(--border);">
          <td style="padding:5px 8px;">${escHtml(r.name)}</td>
          <td style="padding:5px 8px;">${escHtml(r.brand)}</td>
          <td style="padding:5px 8px;">${escHtml(r.platform || '—')}</td>
          <td style="padding:5px 8px;">${escHtml(r.region || '—')}</td>
          <td style="padding:5px 8px;"><button class="btn-ghost-light" style="font-size:11px;padding:2px 8px;color:#DC2626;" onclick="removeMapWorkingRow(${i})">✕</button></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function removeMapWorkingRow(idx) {
  mapWorkingRows.splice(idx, 1);
  renderMapWorkingTable();
}

function clearMapWorkingRows() {
  if (mapWorkingRows.length === 0) return;
  if (!confirm('Clear the entire mapping list?')) return;
  mapWorkingRows = [];
  renderMapWorkingTable();
}

function downloadMapAsExcel() {
  if (mapWorkingRows.length === 0) { showToast('No mappings to export yet.', 'info'); return; }
  const rows = mapWorkingRows.map(r => ({ username: r.username, brand: r.brand, platform: r.platform, region: r.region }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'BulkAssign');
  XLSX.writeFile(wb, `bulk-assign-${new Date().toISOString().slice(0,10)}.xlsx`);
}

// Skips the file-upload step entirely — feeds the mapping straight into
// the existing Bulk Assign flow (same matched/unmatched shape it expects).
function useMapInBulkAssign() {
  const errEl = document.getElementById('map-masterlist-error');
  if (mapWorkingRows.length === 0) { showError(errEl, 'Add at least one mapping first.'); return; }

  const matched = {};
  mapWorkingRows.forEach(r => {
    if (!matched[r.uid]) matched[r.uid] = [];
    const entry = { label: [r.brand, r.platform, r.region].filter(Boolean).join('_'), brand: r.brand, platform: r.platform, region: r.region };
    if (!matched[r.uid].some(ex => ex.brand === entry.brand && ex.platform === entry.platform && ex.region === entry.region)) {
      matched[r.uid].push(entry);
    }
  });

  document.getElementById('map-masterlist-overlay').style.display = 'none';
  openBulkAssignModal(); // resets selects/preview, then we override with our mapping below
  bulkAssignMatched = matched;
  bulkAssignUnmatched = [];
  bulkAssignBadRegions = [];
  renderBrandAssignmentPreview(document.getElementById('bulk-assign-preview'), bulkAssignMatched, [], false);
  document.getElementById('bulk-assign-btn').disabled = Object.keys(matched).length === 0;
}

// ─── Admin: Export all members/leads' usernames to Excel ─────
// Used as a reference sheet when filling in the Bulk Assign template,
// so admins always have the correct username (not just the display name).
function exportMembersToExcel() {
  const rows = Object.values(members)
    .filter(m => m.role !== 'admin')
    .sort((a, b) => (a.name || a.username || '').localeCompare(b.name || b.username || ''))
    .map(m => ({
      Name:     m.name || '',
      Username: m.username || '',
      Role:     m.role === 'team_lead' ? 'Team Lead' : 'Member',
    }));

  if (rows.length === 0) { showToast('No members to export yet.', 'info'); return; }

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 24 }, { wch: 20 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Members');
  XLSX.writeFile(wb, `trackory-members-${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast(`✅ Exported ${rows.length} member(s).`, 'success');
}

// ─── Reports: toggle collapsible registrations ───────────────
function toggleRegList(id) {
  const more = document.getElementById(id + '-more');
  const btn  = document.getElementById(id + '-btn');
  if (!more || !btn) return;
  const isOpen = more.style.display !== 'none';
  more.style.display = isOpen ? 'none' : 'inline';
  btn.textContent = isOpen ? `+${more.querySelectorAll('br').length} more` : 'Show less';
}

// ─── Toast notification ──────────────────────────────────────
let _activeToasts = [];
function showToast(msg, type = 'info', persistent = false) {
  const toast = document.createElement('div');
  toast.className = `mc-toast mc-toast-${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  _activeToasts.push(toast);
  _repositionToasts();
  setTimeout(() => toast.classList.add('mc-toast-in'), 10);
  if (!persistent) {
    toast._autoTimer = setTimeout(() => dismissToast(toast), 3000);
  }
  return toast;
}
function dismissToast(toast) {
  if (!toast || toast._dismissed) return;
  toast._dismissed = true;
  if (toast._autoTimer) clearTimeout(toast._autoTimer);
  toast.classList.remove('mc-toast-in');
  setTimeout(() => {
    toast.remove();
    _activeToasts = _activeToasts.filter(t => t !== toast);
    _repositionToasts();
  }, 400);
}
function _repositionToasts() {
  // Stack toasts upward from the bottom so simultaneous messages don't overlap
  let offset = 24;
  for (let i = _activeToasts.length - 1; i >= 0; i--) {
    _activeToasts[i].style.bottom = offset + 'px';
    offset += 54;
  }
}




// ═════════════════════════════════════════════════════════════
//  TASK CHECK SYSTEM  (Kit & RSP Check — Admin sends, Members respond)
//  Firestore:
//    taskChecks/{checkId}   → { title, items:[{id,label}], sentAt, sentBy,
//                               targetUid, targetName, campaignId, campaignName }
//    taskCheckResponses/{checkId}/responses/{uid}
//                           → { items: { [itemId]: 'pending'|'in-progress'|'done' }, updatedAt }
// ═════════════════════════════════════════════════════════════

const DEFAULT_TASK_CHECK_ITEMS = [
  { id: 'kit_checking', label: 'Kit Checking' },
  { id: 'rsp_checking', label: 'RSP Checking' },
];

let _taskCheckItems = []; // working copy during admin modal editing
let _activeMemberTaskCheck = null; // { checkId, data, myResponse }
let _tcSelectedEntries = []; // working copy of entry chips selected in "Send Task Check" modal

// ── Shared RSP & Kit helpers: entry-level targeting & status lookup ──
// A taskCheck can optionally carry `entries: [{brand,platform,region}]`.
// - entries missing/empty  → check applies to the member's WHOLE checklist
//   for that campaign (legacy behaviour) — only valid when campaignId is set.
// - entries present        → check applies ONLY to the matching brand ×
//   platform × region entries; other entries on the same checklist are
//   unaffected.
// Responses are stored as `{ entries: { [entryKey]: { items:{...} } } }`.
// Old (pre-entry) responses used a flat `{ items:{...} }` shape — that shape
// is treated as applying to every entry, for backward compatibility.
function rspEntryKey(entry) {
  return `${(entry && entry.brand) || ''}|${(entry && entry.platform) || ''}|${(entry && entry.region) || ''}`;
}
function rspCheckAppliesToEntry(tc, entry) {
  if (!tc.entries || tc.entries.length === 0) return true;
  return tc.entries.some(ce =>
    (ce.brand || '') === (entry.brand || '') &&
    (ce.platform || '') === (entry.platform || '') &&
    (ce.region || '') === (entry.region || ''));
}
function rspCheckAppliesToUser(tc, uid) {
  return !tc.targetUid || tc.targetUid === uid;
}
function rspItemStatus(resp, entryKey, itemId) {
  if (!resp) return 'pending';
  if (resp.entries && resp.entries[entryKey]) return (resp.entries[entryKey].items || {})[itemId] || 'pending';
  if (!resp.entries && resp.items) return resp.items[itemId] || 'pending'; // legacy flat response
  return 'pending';
}
// N/A is treated the same as Done for completion/progress-rate purposes —
// it just means "this item doesn't apply", not "still outstanding".
function rspIsDoneLike(s) { return s === 'done' || s === 'na'; }
function rspEntryOverallStatus(tc, resp, entryKey) {
  const statuses = tc.items.map(it => rspItemStatus(resp, entryKey, it.id));
  const allDone = statuses.every(rspIsDoneLike);
  const anyProg = statuses.some(s => s === 'in-progress' || rspIsDoneLike(s));
  return allDone ? 'done' : anyProg ? 'in-progress' : 'pending';
}
const RSP_STATUS_LABEL = { done: '✓ Completed', 'in-progress': '⟳ In Progress', pending: '— Pending', na: 'N/A' };
const RSP_STATUS_CLASS = { done: 'rv-done', 'in-progress': 'rv-progress', pending: 'rv-pending', na: 'rv-na' };

// ── Admin: Open "Send Task Check" modal ──────────────────────
function openTaskCheckModal() {
  // Make sure we're in "create" mode, not left over from an Edit flow
  const overlay = document.getElementById('taskcheck-overlay');
  if (overlay) delete overlay.dataset.editGroupIds;
  const titleEl = document.getElementById('taskcheck-modal-title');
  if (titleEl) titleEl.textContent = '📦 Send Task Check';
  const subtitleEl = document.getElementById('taskcheck-modal-subtitle');
  if (subtitleEl) subtitleEl.textContent = 'Members will see this as an interactive checklist they can update their status on.';
  const saveBtn = document.getElementById('taskcheck-save-btn');
  if (saveBtn) { saveBtn.textContent = '📦 Send Task Check'; saveBtn.setAttribute('onclick', 'sendTaskCheck()'); }

  // Reset items to defaults
  _taskCheckItems = DEFAULT_TASK_CHECK_ITEMS.map(i => ({ ...i }));
  renderTaskCheckItemsList();

  // Populate campaigns dropdown
  const campSel = document.getElementById('tc-campaign-sel');
  campSel.innerHTML = '<option value="">All campaigns</option>';
  Object.values(campaigns).forEach(c => {
    campSel.innerHTML += `<option value="${c.id}">${escHtml(c.name)}</option>`;
  });

  // Populate member chips (multi-select)
  const chipWrap = document.getElementById('tc-member-chips');
  const nonAdmins = Object.values(members).filter(m => m.role !== 'admin');
  chipWrap.innerHTML = nonAdmins.length === 0
    ? '<div style="color:var(--text-muted);font-size:13px;">No members yet.</div>'
    : nonAdmins.map(m =>
        `<div class="member-chip" data-uid="${m.uid}" onclick="toggleChip(this)" title="@${escHtml(m.username)}">${escHtml(m.name || m.username)}</div>`
      ).join('');
  // Reset select-all btn label
  const saBtn = document.getElementById('tc-select-all-btn');
  if (saBtn) saBtn.textContent = 'Select All';

  document.getElementById('tc-title').value = 'Kit & RSP Check';
  document.getElementById('tc-error').style.display = 'none';

  // Reset entry targeting (campaign-specific brand/platform/region) field
  _tcSelectedEntries = [];
  const entriesField = document.getElementById('tc-entries-field');
  if (entriesField) entriesField.style.display = 'none';
  const entriesChips = document.getElementById('tc-entries-chips');
  if (entriesChips) entriesChips.innerHTML = '';

  // Auto-update title + reload entry chips when campaign changes
  document.getElementById('tc-campaign-sel').onchange = function() {
    const campName = this.options[this.selectedIndex].text;
    const base = 'Kit & RSP Check';
    document.getElementById('tc-title').value = this.value ? `${base} — ${campName}` : base;
    tcLoadEntriesForCampaign(this.value);
  };

  document.getElementById('taskcheck-overlay').style.display = 'flex';
}

// ── Admin: load distinct brand/platform/region entries used by members'
//    checklists for the chosen campaign, so the admin can optionally target
//    the RSP & Kit check to specific entries only ────────────────────────
async function tcLoadEntriesForCampaign(campId) {
  const field = document.getElementById('tc-entries-field');
  const chipWrap = document.getElementById('tc-entries-chips');
  _tcSelectedEntries = [];
  if (!field || !chipWrap) return;

  if (!campId) { field.style.display = 'none'; chipWrap.innerHTML = ''; return; }

  field.style.display = 'block';
  chipWrap.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Loading entries…</div>';

  try {
    const camp = campaigns[campId];
    const assignedUids = (camp?.assignedUids) || [];
    const uniqueEntries = [];
    for (const uid of assignedUids) {
      const clDoc = await db.collection('checklists').doc(uid).get();
      const cl = clDoc.exists ? (clDoc.data()[campId] || {}) : {};
      const entries = (cl.entries && cl.entries.length) ? cl.entries : [{ brand: '', platform: '', region: '' }];
      entries.forEach(e => {
        const label = buildEntryLabel(e, uniqueEntries.length);
        if (!uniqueEntries.some(ex => rspEntryKey(ex) === rspEntryKey(e))) {
          uniqueEntries.push({ brand: e.brand || '', platform: e.platform || '', region: e.region || '', label });
        }
      });
    }

    if (uniqueEntries.length === 0) {
      chipWrap.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No brand/platform/region entries found for this campaign yet.</div>';
      return;
    }

    chipWrap.innerHTML = uniqueEntries.map((e, i) => {
      const safe = escHtml(e.label || [e.brand, e.platform, e.region].filter(Boolean).join(' · ') || `Entry ${i + 1}`);
      return `<div class="member-chip" data-brand="${escHtml(e.brand)}" data-platform="${escHtml(e.platform)}" data-region="${escHtml(e.region)}"
        onclick="tcToggleEntryChip(this)" title="${safe}">${safe}</div>`;
    }).join('');
  } catch(e) {
    chipWrap.innerHTML = '<div style="color:var(--danger);font-size:12px;">Failed to load entries.</div>';
    console.error(e);
  }
}

function tcToggleEntryChip(el) {
  el.classList.toggle('selected');
  _tcSelectedEntries = [...document.querySelectorAll('#tc-entries-chips .member-chip.selected')].map(c => ({
    brand: c.dataset.brand || '', platform: c.dataset.platform || '', region: c.dataset.region || '',
  }));
}

function tcToggleAllEntries() {
  const chips = document.querySelectorAll('#tc-entries-chips .member-chip');
  const allSelected = [...chips].every(c => c.classList.contains('selected'));
  chips.forEach(c => allSelected ? c.classList.remove('selected') : c.classList.add('selected'));
  _tcSelectedEntries = allSelected ? [] : [...chips].map(c => ({
    brand: c.dataset.brand || '', platform: c.dataset.platform || '', region: c.dataset.region || '',
  }));
}

function tcToggleAllMembers() {
  const chips = document.querySelectorAll('#tc-member-chips .member-chip');
  const allSelected = [...chips].every(c => c.classList.contains('selected'));
  chips.forEach(c => allSelected ? c.classList.remove('selected') : c.classList.add('selected'));
  const btn = document.getElementById('tc-select-all-btn');
  if (btn) btn.textContent = allSelected ? 'Select All' : 'Deselect All';
}

function closeTaskCheckModal(e) {
  if (e && e.target !== document.getElementById('taskcheck-overlay')) return;
  document.getElementById('taskcheck-overlay').style.display = 'none';
}

function renderTaskCheckItemsList() {
  const el = document.getElementById('tc-items-list');
  if (!el) return;
  el.innerHTML = _taskCheckItems.map((item, i) => `
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-size:13px;color:var(--text-muted);min-width:18px;">${i+1}.</span>
      <input type="text" value="${escHtml(item.label)}"
        oninput="_taskCheckItems[${i}].label = this.value"
        style="flex:1;font-size:13px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);" />
      <button onclick="removeTaskCheckItem(${i})"
        style="background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.3);color:#DC2626;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;">✕</button>
    </div>`).join('');
}

function addTaskCheckItem() {
  _taskCheckItems.push({ id: `custom_${Date.now()}`, label: '' });
  renderTaskCheckItemsList();
  // Focus last input
  const inputs = document.querySelectorAll('#tc-items-list input[type="text"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function removeTaskCheckItem(i) {
  _taskCheckItems.splice(i, 1);
  renderTaskCheckItemsList();
}

async function sendTaskCheck() {
  const title   = document.getElementById('tc-title').value.trim();
  const campId  = document.getElementById('tc-campaign-sel').value;
  const errEl   = document.getElementById('tc-error');
  errEl.style.display = 'none';

  if (!title) { showError(errEl, 'Please enter a title.'); return; }
  const validItems = _taskCheckItems.filter(i => i.label.trim());
  if (validItems.length === 0) { showError(errEl, 'Please add at least one check item.'); return; }

  // Collect selected member chips; empty selection = send to all
  const selectedChips = [...document.querySelectorAll('#tc-member-chips .member-chip.selected')];
  const selectedUids  = selectedChips.map(c => c.dataset.uid);
  const sendToAll     = selectedUids.length === 0;

  const btn = document.querySelector('#taskcheck-overlay .btn-primary');
  btn.textContent = 'Sending…'; btn.disabled = true;

  try {
    const campName = campId ? campaigns[campId]?.name : null;
    // Entry targeting only makes sense when a campaign is selected; entries
    // selected for a different campaign (left over in memory) are ignored.
    const targetEntries = campId ? _tcSelectedEntries : [];

    if (sendToAll) {
      // Single task check for everyone
      const memberName = 'All members';
      const checkData = {
        title, items: validItems,
        sentAt: new Date().toISOString(), sentBy: 'Admin',
        targetUid: null, targetName: memberName,
        campaignId: campId || null, campaignName: campName || null,
        entries: targetEntries,
      };
      const ref = await db.collection('taskChecks').add(checkData);
      await db.collection('broadcasts').add({
        type: 'taskcheck',
        message: `📦 New Task Check sent: "${title}" — please review and update your status.`,
        targetUid: null, targetName: memberName,
        campaignId: campId || null, campaignName: campName || null,
        sentAt: new Date().toISOString(), sentBy: 'Admin', readBy: [],
        taskCheckId: ref.id,
      });
      showToast(`📦 Task Check "${title}" sent to All members!`, 'success');
    } else {
      // One task check per selected member, but tagged with a shared
      // batchId so the admin list can group them back into a single row
      // (with a single Delete button) instead of one row per member.
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      for (const uid of selectedUids) {
        const m = members[uid];
        if (!m) continue;
        const memberName = m.name || m.username;
        const checkData = {
          title, items: validItems,
          sentAt: new Date().toISOString(), sentBy: 'Admin',
          targetUid: uid, targetName: memberName,
          campaignId: campId || null, campaignName: campName || null,
          entries: targetEntries,
          batchId,
        };
        const ref = await db.collection('taskChecks').add(checkData);
        await db.collection('broadcasts').add({
          type: 'taskcheck',
          message: `📦 New Task Check sent: "${title}" — please review and update your status.`,
          targetUid: uid, targetName: memberName,
          campaignId: campId || null, campaignName: campName || null,
          sentAt: new Date().toISOString(), sentBy: 'Admin', readBy: [],
          taskCheckId: ref.id,
        });
      }
      const names = selectedChips.map(c => c.textContent.trim()).join(', ');
      showToast(`📦 Task Check "${title}" sent to ${selectedUids.length} member${selectedUids.length !== 1 ? 's' : ''}: ${names}`, 'success');
    }

    document.getElementById('taskcheck-overlay').style.display = 'none';
    // Switch to Checklist tab after sending
    switchAdminTab('checklist');
  } catch(e) {
    showError(errEl, 'Failed to send. Please try again.');
    console.error(e);
  } finally {
    btn.textContent = '📦 Send Task Check'; btn.disabled = false;
  }
}

// ── Admin: View task check responses (tracker modal) ─────────
async function openTaskCheckTracker(checkId) {
  document.getElementById('taskcheck-tracker-overlay').style.display = 'flex';
  const content = document.getElementById('tc-tracker-content');
  content.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--text-muted);">Loading responses…</div>';

  try {
    const checkDoc = await db.collection('taskChecks').doc(checkId).get();
    if (!checkDoc.exists) { content.innerHTML = '<div style="color:var(--text-muted);">Task check not found.</div>'; return; }
    const check = checkDoc.data();
    document.getElementById('tc-tracker-title').textContent = `📦 ${check.title}`;

    const respSnap = await db.collection('taskCheckResponses').doc(checkId).collection('responses').get();
    const responses = {};
    respSnap.forEach(doc => { responses[doc.id] = doc.data(); });

    // Determine which members to show
    const targetMembers = check.targetUid
      ? [members[check.targetUid]].filter(Boolean)
      : Object.values(members).filter(m => m.role !== 'admin');

    const sentStr = new Date(check.sentAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    const campTag = check.campaignName ? `<span class="bcast-tag" style="margin-left:6px;">${escHtml(check.campaignName)}</span>` : '';
    const entriesTag = (check.entries && check.entries.length)
      ? `<span class="bcast-tag" style="margin-left:6px;" title="Only these brand/platform/region entries were targeted">🎯 ${check.entries.length} entr${check.entries.length===1?'y':'ies'}</span>`
      : '';

    let html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:16px;">Sent ${sentStr} ${campTag}${entriesTag} · ${targetMembers.length} member${targetMembers.length!==1?'s':''}</div>`;

    // Summary pills
    let cDone = 0, cProg = 0, cPend = 0;
    targetMembers.forEach(m => {
      const r = responses[m.uid] || {};
      const statuses = check.items.map(item => (r.items || {})[item.id] || 'pending');
      const allDone  = statuses.every(rspIsDoneLike);
      const anyProg  = statuses.some(s => s === 'in-progress' || rspIsDoneLike(s));
      if (allDone)       cDone++;
      else if (anyProg)  cProg++;
      else               cPend++;
    });

    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px;">
      <span class="ac-pill ac-green">✓ ${cDone} Complete</span>
      <span class="ac-pill ac-amber">⟳ ${cProg} In Progress</span>
      <span class="ac-pill ac-red">— ${cPend} Pending</span>
    </div>`;

    // Per-member table
    html += `<div style="display:flex;flex-direction:column;gap:10px;">`;
    targetMembers.forEach(m => {
      const r    = responses[m.uid] || {};
      const upd  = r.updatedAt ? `Updated ${new Date(r.updatedAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}` : 'No response yet';
      const itemsHtml = check.items.map(item => {
        const st    = (r.items || {})[item.id] || 'pending';
        const stLbl = RSP_STATUS_LABEL[st] || '— Pending';
        const stCls = RSP_STATUS_CLASS[st] || 'rv-pending';
        return `<div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border);">
          <span style="color:var(--text);">${escHtml(item.label)}</span>
          <span class="rv-status ${stCls}" style="font-size:10px;">${stLbl}</span>
        </div>`;
      }).join('');

      html += `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div>
            <span style="font-weight:600;font-size:13px;">${escHtml(m.name || m.username)}</span>
            <span style="font-size:11px;color:var(--text-muted);margin-left:6px;">@${escHtml(m.username)}</span>
          </div>
          <span style="font-size:10px;color:var(--text-faint);">${upd}</span>
        </div>
        ${itemsHtml}
      </div>`;
    });
    html += `</div>`;
    content.innerHTML = html;
  } catch(e) {
    content.innerHTML = '<div style="color:var(--danger);">Failed to load responses.</div>';
    console.error(e);
  }
}

function closeTaskCheckTracker(e) {
  if (e && e.target !== document.getElementById('taskcheck-tracker-overlay')) return;
  document.getElementById('taskcheck-tracker-overlay').style.display = 'none';
}

// ── Member: See task check in broadcast feed ─────────────────
// In loadBroadcastFeed, we inject a "Respond" button for taskcheck type
// This is handled by patching the broadcast render — see below

// ── Member: Open task check response modal ───────────────────
// ── Member/TL: jump straight to where the RSP & Kit check actually lives ──
// Campaign-scoped checks now live on the Checklist tab (per-entry banner),
// so route there instead of the old flat popup. Checks with no campaign
// (legacy / "All campaigns") have no entries to show, so the flat popup is
// still the right place for those.
async function goToTaskCheck(checkId) {
  try {
    const checkDoc = await db.collection('taskChecks').doc(checkId).get();
    if (!checkDoc.exists) { openMemberTaskCheck(checkId); return; }
    const check = checkDoc.data();

    if (!check.campaignId) { openMemberTaskCheck(checkId); return; }

    const isTl = currentUser?.role === 'team_lead';
    if (isTl) {
      const dashView = document.getElementById('tl-dashboard-view');
      const calView  = document.getElementById('tl-calendar-view');
      const clView   = document.getElementById('tl-checklist-view');
      if (dashView) dashView.style.display = 'none';
      if (calView)  calView.style.display  = 'none';
      if (clView)   clView.style.display   = 'block';
      ['dashboard','calendar','checklist'].forEach(t => {
        const btn = document.getElementById('tl-navbtn-' + t);
        if (btn) btn.classList.toggle('active', t === 'checklist');
      });
      await enterTlChecklistTab();
      const sel = document.getElementById('tl-campaign-select');
      if (sel && tlOwnCampaigns[check.campaignId]) {
        sel.value = check.campaignId;
        await loadTlChecklist();
      }
    } else {
      showUserTab('checklist');
      const sel = document.getElementById('user-campaign-select');
      if (sel) {
        sel.value = check.campaignId;
        await loadUserChecklist();
      }
    }
    showToast('📦 Update your RSP & Kit status in the banner above the checklist', 'success');
  } catch(e) {
    console.error(e);
    openMemberTaskCheck(checkId);
  }
}

async function openMemberTaskCheck(checkId) {
  _activeMemberTaskCheck = null;
  document.getElementById('member-taskcheck-overlay').style.display = 'flex';
  document.getElementById('mtc-items-list').innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:1rem 0;">Loading…</div>';

  try {
    const checkDoc = await db.collection('taskChecks').doc(checkId).get();
    if (!checkDoc.exists) { closeMemberTaskCheck(); return; }
    const check = checkDoc.data();

    // Load existing response
    const respDoc = await db.collection('taskCheckResponses').doc(checkId)
      .collection('responses').doc(currentUser.uid).get();
    const myResponse = respDoc.exists ? respDoc.data() : { items: {} };

    _activeMemberTaskCheck = { checkId, check, myResponse };

    document.getElementById('mtc-title').textContent = `📦 ${check.title}`;
    document.getElementById('mtc-subtitle').textContent = check.campaignName
      ? `Campaign: ${check.campaignName}`
      : `Sent by Admin · ${new Date(check.sentAt).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}`;

    renderMemberTaskCheckItems();
  } catch(e) {
    document.getElementById('mtc-items-list').innerHTML = '<div style="color:var(--danger);">Failed to load. Try again.</div>';
    console.error(e);
  }
}

function renderMemberTaskCheckItems() {
  if (!_activeMemberTaskCheck) return;
  const { check, myResponse } = _activeMemberTaskCheck;
  const el = document.getElementById('mtc-items-list');
  if (!el) return;

  el.innerHTML = check.items.map((item, i) => {
    const current = (myResponse.items || {})[item.id] || 'pending';
    const opts = [
      { v: 'pending',     l: '— Pending',     cls: 's-pending' },
      { v: 'in-progress', l: '⟳ In Progress', cls: 's-progress' },
      { v: 'done',        l: '✓ Done',         cls: 's-done' },
      { v: 'na',          l: 'N/A',            cls: 's-na' },
    ];
    const selectHtml = opts.map(o => `<option value="${o.v}" ${current===o.v?'selected':''}>${o.l}</option>`).join('');
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:12px;color:var(--text-muted);min-width:18px;">${i+1}.</span>
      <span style="flex:1;font-size:13px;color:var(--text);">${escHtml(item.label)}</span>
      <select class="status-sel ${statusClass(current)}" id="mtc-sel-${item.id}"
        onchange="onMemberTaskItemChange('${item.id}', this)">
        ${selectHtml}
      </select>
    </div>`;
  }).join('');
}

function onMemberTaskItemChange(itemId, sel) {
  if (!_activeMemberTaskCheck) return;
  sel.className = `status-sel ${statusClass(sel.value)}`;
  if (!_activeMemberTaskCheck.myResponse.items) _activeMemberTaskCheck.myResponse.items = {};
  _activeMemberTaskCheck.myResponse.items[itemId] = sel.value;
}

async function saveMemberTaskCheck() {
  if (!_activeMemberTaskCheck || !currentUser) return;
  const { checkId, myResponse } = _activeMemberTaskCheck;
  const btn = document.querySelector('#member-taskcheck-overlay .btn-primary');
  btn.textContent = 'Saving…'; btn.disabled = true;

  try {
    // Read current values from selects (in case onchange missed any)
    const { check } = _activeMemberTaskCheck;
    check.items.forEach(item => {
      const sel = document.getElementById(`mtc-sel-${item.id}`);
      if (sel) {
        if (!myResponse.items) myResponse.items = {};
        myResponse.items[item.id] = sel.value;
      }
    });

    await db.collection('taskCheckResponses').doc(checkId)
      .collection('responses').doc(currentUser.uid)
      .set({ items: myResponse.items || {}, updatedAt: new Date().toISOString() }, { merge: true });

    document.getElementById('member-taskcheck-overlay').style.display = 'none';
    showToast('✅ Task check status saved!', 'success');
  } catch(e) {
    showToast('Failed to save. Try again.', 'warn');
    console.error(e);
  } finally {
    btn.textContent = '💾 Save Status'; btn.disabled = false;
  }
}

function closeMemberTaskCheck(e) {
  if (e && e.target !== document.getElementById('member-taskcheck-overlay')) return;
  document.getElementById('member-taskcheck-overlay').style.display = 'none';
}

// ── Admin dashboard: load & show recent task checks ──────────
// Mirrors the "Completion by team lead" widget: collapsible lead groups,
// an overall Kit/RSP progress rate per lead, and per-member rows with
// Kit-progress / RSP-progress bars (instead of D-5/D-1, since this panel
// is specifically about Kit & RSP Check completion).
async function renderTaskChecksInDashboard(force) {
  // Called from renderDashboardWidgets – shows a compact list below stats
  const el = document.getElementById('dash-taskcheck-panel');
  if (!el) return;

  // Scope to the campaign currently selected on the dashboard (sidebar
  // filter, or by clicking a campaign in the "Active Checklists" panel) —
  // same filter that already drives "Checklist Progress by Team Lead",
  // so both panels change together when a campaign is selected.
  const filterCampId = document.getElementById('admin-campaign-filter')?.value || '';

  try {
    // Reuses the same shared cache renderAdminView() just loaded (no second
    // full refetch of taskChecks/checklists/responses on every click).
    await loadAdminDashboardCache(force);
    if (_dashCache.taskChecks.length === 0) { el.style.display = 'none'; return; }

    let checks = _dashCache.taskChecks;
    if (filterCampId) checks = checks.filter(tc => tc.campaignId === filterCampId);
    if (checks.length === 0) { el.style.display = 'none'; return; }

    // Need each member's checklist entries to resolve entry-scoped checks
    // (a check can target specific brand×platform×region entries only).
    const allChecklists = _dashCache.checklists;
    const respByCheck = _dashCache.taskCheckResponses;

    // Map a member uid -> their team lead's uid/name (or the member
    // themself, if they ARE a team lead). Falls back to "Unassigned".
    const leadOf = (uid) => {
      const m = members[uid];
      if (!m) return null;
      if (m.role === 'team_lead') return { uid: m.uid, name: m.name || m.username };
      const lead = Object.values(members).find(t => t.role === 'team_lead' && (t.managedUids || []).includes(uid));
      return lead ? { uid: lead.uid, name: lead.name || lead.username } : { uid: '_unassigned', name: 'Unassigned (no team lead)' };
    };

    const isKitItem = (item) => /kit/i.test(item.id) || /kit/i.test(item.label || '');
    const isRspItem = (item) => /rsp/i.test(item.id) || /rsp/i.test(item.label || '');

    // memberStats: uid -> { uid, name, isLead, kitDone, kitTotal, rspDone, rspTotal }
    const memberStats = {};
    const ensureStat = (m) => {
      if (!memberStats[m.uid]) memberStats[m.uid] = { uid: m.uid, name: m.name || m.username, isLead: m.role === 'team_lead', kitDone: 0, kitTotal: 0, rspDone: 0, rspTotal: 0 };
      return memberStats[m.uid];
    };

    checks.forEach(tc => {
      const responses = respByCheck[tc.id] || {};
      const targetMembers = tc.targetUid
        ? [members[tc.targetUid]].filter(Boolean)
        : Object.values(members).filter(m => m.role !== 'admin');

      targetMembers.forEach(m => {
        const r = responses[m.uid];
        const stat = ensureStat(m);
        const tally = (item, status) => {
          if (isKitItem(item)) { stat.kitTotal++; if (rspIsDoneLike(status)) stat.kitDone++; }
          else if (isRspItem(item)) { stat.rspTotal++; if (rspIsDoneLike(status)) stat.rspDone++; }
        };

        if (tc.campaignId) {
          const cl = (allChecklists[m.uid] || {})[tc.campaignId] || {};
          const entries = (cl.entries && cl.entries.length) ? cl.entries : [{ brand: '', platform: '', region: '' }];
          entries.forEach(entry => {
            if (!rspCheckAppliesToEntry(tc, entry)) return;
            const key = rspEntryKey(entry);
            tc.items.forEach(item => tally(item, rspItemStatus(r, key, item.id)));
          });
        } else {
          tc.items.forEach(item => tally(item, ((r && r.items) || {})[item.id] || 'pending'));
        }
      });
    });

    const memberList = Object.values(memberStats);
    if (memberList.length === 0) { el.style.display = 'none'; return; }
    memberList.forEach(s => {
      s.kitPct = s.kitTotal > 0 ? Math.round((s.kitDone / s.kitTotal) * 100) : 0;
      s.rspPct = s.rspTotal > 0 ? Math.round((s.rspDone / s.rspTotal) * 100) : 0;
    });

    // Group members under their team lead — a lead's own row sits inside
    // their own group (tagged "Team Lead"), same as "Completion by team lead".
    const groupsMap = {};
    memberList.forEach(s => {
      const g = s.isLead ? { uid: s.uid, name: s.name } : leadOf(s.uid);
      if (!g) return;
      if (!groupsMap[g.uid]) groupsMap[g.uid] = { uid: g.uid, name: g.name, members: [] };
      groupsMap[g.uid].members.push(s);
    });

    const groupList = Object.values(groupsMap).map(g => {
      const kitDone = g.members.reduce((s, m) => s + m.kitDone, 0);
      const kitTotal = g.members.reduce((s, m) => s + m.kitTotal, 0);
      const rspDone = g.members.reduce((s, m) => s + m.rspDone, 0);
      const rspTotal = g.members.reduce((s, m) => s + m.rspTotal, 0);
      const hasOwnChecklist = g.members.some(m => m.isLead);
      const memberCount = g.members.filter(m => !m.isLead).length;
      return {
        ...g,
        kitPct: kitTotal > 0 ? Math.round((kitDone / kitTotal) * 100) : 0,
        rspPct: rspTotal > 0 ? Math.round((rspDone / rspTotal) * 100) : 0,
        memberCount, hasOwnChecklist,
        memberList: g.members.slice().sort((a, b) => (b.kitPct + b.rspPct) - (a.kitPct + a.rspPct)),
      };
    });
    groupList.sort((a, b) => (b.kitPct + b.rspPct) - (a.kitPct + a.rspPct));

    if (groupList.length === 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const barColor = pct => pct === 100 ? '#059669' : pct >= 50 ? '#D97706' : pct > 0 ? '#3B82F6' : '#D1D5DB';

    const html = groupList.map((g, idx) => {
      const panelId = `taskcheck-lead-panel-${idx}`;
      const memberRowsHtml = g.memberList.map(m => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);">
          <div style="flex:1.4;font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(m.name)}${m.isLead ? ' <span style="font-size:9px;color:var(--text-muted);font-weight:400;">(Team Lead)</span>' : ''}</div>
          <div style="font-size:10px;color:var(--text-muted);width:26px;">Kit</div>
          <div style="flex:1;background:#F3F4F6;border-radius:4px;height:6px;overflow:hidden;"><div style="width:${m.kitPct}%;background:${barColor(m.kitPct)};height:100%;border-radius:4px;"></div></div>
          <div style="font-size:11px;font-family:var(--mono);color:var(--text-muted);width:32px;text-align:right;">${m.kitPct}%</div>
          <div style="font-size:10px;color:var(--text-muted);width:26px;">RSP</div>
          <div style="flex:1;background:#F3F4F6;border-radius:4px;height:6px;overflow:hidden;"><div style="width:${m.rspPct}%;background:${barColor(m.rspPct)};height:100%;border-radius:4px;"></div></div>
          <div style="font-size:11px;font-family:var(--mono);color:var(--text-muted);width:32px;text-align:right;">${m.rspPct}%</div>
        </div>`).join('') || '<div style="font-size:12px;color:var(--text-muted);padding:6px 0;">No members.</div>';

      return `<div class="completion-member-block" style="margin-bottom:10px;border:1px solid var(--border);border-radius:10px;padding:10px 12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;cursor:pointer;" onclick="toggleLeadCompletionPanel('${panelId}', this)" title="Click to view individual members' Kit & RSP progress">
          <div style="display:flex;align-items:center;gap:6px;min-width:0;">
            <span class="lead-completion-caret" data-panel="${panelId}" style="display:inline-block;font-size:10px;color:var(--text-muted);transition:transform .15s;">▶</span>
            <span class="completion-name" style="width:auto;font-weight:600;">${escHtml(g.name)}</span>
            <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;">(${g.memberCount} member${g.memberCount !== 1 ? 's' : ''}${g.hasOwnChecklist ? ' + lead' : ''})</span>
          </div>
        </div>
        <div class="completion-bar-row" style="margin-bottom:3px;">
          <div class="completion-name" style="width:32px;font-size:10px;color:var(--text-muted);">Kit</div>
          <div class="completion-track"><div class="completion-fill" style="width:${g.kitPct}%;background:${barColor(g.kitPct)};"></div></div>
          <div class="completion-pct">${g.kitPct}%</div>
        </div>
        <div class="completion-bar-row">
          <div class="completion-name" style="width:32px;font-size:10px;color:var(--text-muted);">RSP</div>
          <div class="completion-track"><div class="completion-fill" style="width:${g.rspPct}%;background:${barColor(g.rspPct)};"></div></div>
          <div class="completion-pct">${g.rspPct}%</div>
        </div>
        <div id="${panelId}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);">
          ${memberRowsHtml}
        </div>
      </div>`;
    }).join('');

    const subtitleHtml = filterCampId
      ? `<div style="font-size:11px;color:var(--blue);font-weight:600;margin-top:2px;">📁 ${escHtml(campaigns[filterCampId]?.name || '')}</div>`
      : '';
    el.innerHTML = `<div class="dash-card-header" style="margin-bottom:8px;"><div><div class="dash-card-title">Kit & RSP Checking by Team Lead</div>${subtitleHtml}</div></div>` + html;
  } catch(e) { el.style.display = 'none'; console.error('Task check dashboard error', e); }
}


// ═════════════════════════════════════════════════════════════
//  TEAM LEAD — DATA, VIEW, MODAL
// ═════════════════════════════════════════════════════════════

let tlCampaigns = {};
let tlMembers   = {};
let tlOwnCampaigns = {};   // campaigns the team lead is PERSONALLY assigned to (their own checklist)

async function loadTeamLeadData() {
  const managedUids = currentUser.managedUids || [];
  tlMembers   = {};
  tlCampaigns = {};

  // Load managed members
  const usersSnap = await db.collection('users').get();
  usersSnap.forEach(doc => {
    if (managedUids.includes(doc.id))
      tlMembers[doc.id] = { ...doc.data(), uid: doc.id };
  });

  // Load all campaigns; keep those with at least one managed member
  // (archived campaigns are excluded from team-lead views entirely)
  const campsSnap = await db.collection('campaigns').orderBy('createdAt', 'desc').get();
  campsSnap.forEach(doc => {
    const camp = { ...doc.data(), id: doc.id };
    if (camp.archived) return;
    if ((camp.assignedUids || []).some(uid => managedUids.includes(uid)))
      tlCampaigns[doc.id] = camp;
  });

  // Load campaigns the team lead is PERSONALLY assigned to (their own checklist)
  tlOwnCampaigns = {};
  campsSnap.forEach(doc => {
    const camp = { ...doc.data(), id: doc.id };
    if (camp.archived) return;
    if ((camp.assignedUids || []).includes(currentUser.uid))
      tlOwnCampaigns[doc.id] = camp;
  });

  // Load the team lead's own checklist progress
  const checkSnap = await db.collection('checklists').doc(currentUser.uid).get();
  userChecklist = checkSnap.exists ? checkSnap.data() : {};
  populateTlCampaignSelect();

  // Populate campaign filter
  const sel = document.getElementById('tl-campaign-filter');
  if (sel) {
    sel.innerHTML = '<option value="">All campaigns</option>' +
      Object.values(tlCampaigns).map(c =>
        `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
  }

  // Load shared calendar, broadcast badge, and registration poll status
  await loadCalendarEntries();
  await loadPersonalCalendarEntries(currentUser.uid);
  await checkBroadcastBadge();
  await checkForPendingPoll();

  showTlTab('dashboard');
  if (managedUids.length === 0) {
    const tbody = document.getElementById('tl-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:3rem;">No members assigned to you yet. Contact the admin.</td></tr>';
  }
}

async function loadTeamLeadView() {
  await loadTeamLeadData();
}

// ─────────────────────────────────────────────────────────────
//  TEAM LEAD — OWN CHECKLIST (reuses the same renderUserChecklist /
//  updateUserProgress engine as the member checklist; those functions
//  branch on currentUser.role to target the 'tl-' prefixed DOM ids)
// ─────────────────────────────────────────────────────────────
function populateTlCampaignSelect() {
  const sel = document.getElementById('tl-campaign-select');
  if (!sel) return;
  const prevVal = sel.value;
  sel.innerHTML = '<option value="">Select campaign…</option>';
  Object.values(tlOwnCampaigns).forEach(c => {
    sel.innerHTML += `<option value="${c.id}">${escHtml(c.name)}</option>`;
  });
  // Preserve selection across re-populates (e.g. switching tabs) if still valid
  if (prevVal && tlOwnCampaigns[prevVal]) sel.value = prevVal;
}

async function loadTlChecklist() {
  const sel = document.getElementById('tl-campaign-select');
  selectedCampaignId = sel.value;

  if (!selectedCampaignId) {
    document.getElementById('tl-no-campaign').style.display = 'block';
    document.getElementById('tl-checklist').style.display   = 'none';
    const banner = document.getElementById('tl-progress-banner');
    if (banner) banner.style.display = 'none';
    const rspBanner = document.getElementById('tl-rspkit-banner');
    if (rspBanner) rspBanner.style.display = 'none';
    const sideWrap = document.getElementById('tl-sidebar-progress');
    if (sideWrap) sideWrap.style.display = 'none';
    const tlCampSub = document.getElementById('tl-campaign-sub');
    if (tlCampSub) tlCampSub.textContent = 'Select a campaign to begin';
    return;
  }

  document.getElementById('tl-campaign-name').textContent = tlOwnCampaigns[selectedCampaignId]?.name || 'My Checklist';
  const tlCampSub = document.getElementById('tl-campaign-sub');
  if (tlCampSub) tlCampSub.innerHTML = campDateMetaHtml(tlOwnCampaigns[selectedCampaignId]) || 'Fill out your checklist below';
  document.getElementById('tl-no-campaign').style.display  = 'none';
  document.getElementById('tl-checklist').style.display    = 'block';

  // Load the correct checklist sections for this campaign's template
  await loadChecklistOverrides(selectedCampaignId);

  ensureEntries();
  renderUserChecklist();
  updateUserProgress();
}

// Called when the team lead opens the "My Checklist" tab — refreshes their
// own assignments from Firestore so anything an admin just changed (or any
// state merged in by openTlReviewModal) can't leak into this picker.
async function enterTlChecklistTab() {
  try {
    const campsSnap = await db.collection('campaigns')
      .where('assignedUids', 'array-contains', currentUser.uid)
      .orderBy('createdAt', 'desc')
      .get();
    tlOwnCampaigns = {};
    campsSnap.forEach(doc => {
      const camp = doc.data();
      if (camp.archived) return;
      tlOwnCampaigns[doc.id] = { ...camp, id: doc.id };
    });
  } catch (e) { console.warn('Could not refresh personal campaigns', e); }

  populateTlCampaignSelect();

  if (selectedCampaignId && tlOwnCampaigns[selectedCampaignId]) {
    document.getElementById('tl-campaign-select').value = selectedCampaignId;
    await loadTlChecklist();
  } else {
    selectedCampaignId = null;
    document.getElementById('tl-no-campaign').style.display = 'block';
    document.getElementById('tl-checklist').style.display   = 'none';
  }
}

async function renderTeamLeadView() {
  const tbody = document.getElementById('tl-tbody');
  const statsEl = document.getElementById('tl-stats');
  if (!tbody) return;
  const filterCampId = (document.getElementById('tl-campaign-filter') || {}).value || '';
  const managedUids  = currentUser.managedUids || [];

  const tlDashLabel = document.getElementById('tl-dashboard-campaign-label');
  if (tlDashLabel) {
    if (!filterCampId) { tlDashLabel.textContent = 'Checklist progress for your assigned members'; }
    else {
      const camp = tlCampaigns[filterCampId];
      const meta = campDateMetaHtml(camp);
      tlDashLabel.innerHTML = meta || 'Checklist progress for your assigned members';
    }
  }

  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:2rem;">Loading…</td></tr>';

  if (managedUids.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:3rem;">No members assigned to you yet. Contact the admin.</td></tr>';
    if (statsEl) statsEl.innerHTML = '';
    return;
  }

  const campsToShow = filterCampId
    ? (tlCampaigns[filterCampId] ? [tlCampaigns[filterCampId]] : [])
    : Object.values(tlCampaigns);

  if (campsToShow.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:3rem;">No campaigns found for your team.</td></tr>';
    if (statsEl) statsEl.innerHTML = '';
    return;
  }

  // Load checklists for all managed members AND the team lead's own
  // checklist — a lead's team-wide stats should include their own status
  // alongside everyone they manage (e.g. "Total Members" + their checklist).
  const checklistData = {};
  await Promise.all(managedUids.map(async uid => {
    const snap = await db.collection('checklists').doc(uid).get();
    checklistData[uid] = snap.exists ? snap.data() : {};
  }));
  const ownClSnap = await db.collection('checklists').doc(currentUser.uid).get();
  checklistData[currentUser.uid] = ownClSnap.exists ? ownClSnap.data() : {};
  const teamUids = [...managedUids, currentUser.uid];

  // Campaigns can use a non-default checklist template — resolve each
  // campaign's real total item count (see resolveCampaignTotalItems).
  const tlTotalItemsMap = await resolveCampaignTotalItems(campsToShow);

  // ── Build one row PER ENTRY (mirrors the admin dashboard table) ──
  let allRows = [];
  campsToShow.forEach(camp => {
    (camp.assignedUids || []).filter(uid => teamUids.includes(uid)).forEach(uid => {
      const member = tlMembers[uid] || (uid === currentUser.uid ? currentUser : null);
      if (!member) return;
      const cl = (checklistData[uid] || {})[camp.id] || {};
      const info = tlTotalItemsMap[camp.id] || { total: TOTAL_ITEMS, validIds: null, hasD5: true };
      getEntryBreakdown(cl, info.total, info.validIds, info.hasD5).forEach(eb => {
        allRows.push({
          member, camp,
          entryLabel: eb.label,
          entryRegion: (eb.region || '').toUpperCase(),
          d5Done: eb.d5Done, d1Done: eb.d1Done, overallDone: eb.d1Pct,
          d5Pct: eb.d5Pct, d1Pct: eb.d1Pct, totalItems: eb.totalItems, hasD5: eb.hasD5,
          lastActive: cl.lastActive || null,
        });
      });
    });
  });
  window._tlAllRows = allRows;

  // ── Sort ──
  const sortSel = document.getElementById('tl-table-sort');
  const sortVal = sortSel ? sortSel.value : 'name';
  allRows.sort((a, b) => {
    if (sortVal === 'name') return (a.member.name || a.member.username).localeCompare(b.member.name || b.member.username);
    if (sortVal === 'overall_desc') return b.overallDone - a.overallDone;
    if (sortVal === 'overall_asc')  return a.overallDone - b.overallDone;
    if (sortVal === 'lastactive') {
      const aT = a.lastActive ? new Date(a.lastActive).getTime() : 0;
      const bT = b.lastActive ? new Date(b.lastActive).getTime() : 0;
      return bT - aT;
    }
    return 0;
  });

  // ── Summary stat cards (includes the lead's own checklist) ──
  const totalMembers   = allRows.length;
  const totalComplete  = allRows.filter(r => r.overallDone === 100).length;
  const totalInProg    = allRows.filter(r => r.overallDone > 0 && r.overallDone < 100).length;
  const totalPending   = allRows.filter(r => r.overallDone === 0).length;
  const completeRate   = totalMembers > 0 ? Math.round((totalComplete / totalMembers) * 100) : 0;
  const inProgRate     = totalMembers > 0 ? Math.round((totalInProg / totalMembers) * 100) : 0;
  const pendingRate    = totalMembers > 0 ? Math.round((totalPending / totalMembers) * 100) : 0;
  let d1DoneSum = 0, d1TotalSum = 0;
  allRows.forEach(r => { d1DoneSum += r.d1Done; d1TotalSum += r.totalItems; });
  const checklistCompletionRate = d1TotalSum > 0 ? Math.round((d1DoneSum / d1TotalSum) * 100) : 0;
  const checklistRateColor = checklistCompletionRate === 100 ? '#16a34a' : checklistCompletionRate >= 50 ? '#d97706' : '#2563eb';

  // RSP & Kit completion rate for team lead's members (entry-aware for
  // campaign-scoped checks, same logic as the admin dashboard).
  let tlRspTotal = 0, tlRspComplete = 0;
  try {
    const tcSnap = await db.collection('taskChecks').get();
    for (const tcDoc of tcSnap.docs) {
      const tc = { id: tcDoc.id, ...tcDoc.data() };
      if (filterCampId && tc.campaignId !== filterCampId) continue;
      const targetMembers = tc.targetUid
        ? (managedUids.includes(tc.targetUid) ? [tlMembers[tc.targetUid]].filter(Boolean) : [])
        : Object.values(tlMembers);
      if (targetMembers.length === 0) continue;
      const respSnap = await db.collection('taskCheckResponses').doc(tcDoc.id).collection('responses').get();
      const responses = {};
      respSnap.forEach(d => { responses[d.id] = d.data(); });
      targetMembers.forEach(m => {
        const r = responses[m.uid];
        if (tc.campaignId) {
          const cl = (checklistData[m.uid] || {})[tc.campaignId] || {};
          const entries = (cl.entries && cl.entries.length) ? cl.entries : [{ brand: '', platform: '', region: '' }];
          entries.forEach(entry => {
            if (!rspCheckAppliesToEntry(tc, entry)) return;
            tlRspTotal++;
            if (rspEntryOverallStatus(tc, r, rspEntryKey(entry)) === 'done') tlRspComplete++;
          });
        } else {
          tlRspTotal++;
          const allDone = tc.items.every(item => rspIsDoneLike(((r && r.items) || {})[item.id]));
          if (allDone) tlRspComplete++;
        }
      });
    }
  } catch(e) { /* non-blocking */ }
  const tlRspRate = tlRspTotal > 0 ? Math.round((tlRspComplete / tlRspTotal) * 100) : null;
  const tlRspColor = tlRspRate === null ? '#6b7280' : tlRspRate === 100 ? '#16a34a' : tlRspRate >= 50 ? '#d97706' : '#2563eb';
  const tlRspDisplay = tlRspRate === null ? '—' : tlRspRate + '%';

  if (statsEl) statsEl.innerHTML = `
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:24px;">
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 18px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:var(--navy);">${totalMembers}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Total Checklists <span style="opacity:.7;">(incl. you)</span></div>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:#16a34a;">${totalComplete}</div>
      <div style="font-size:11px;color:#16a34a;margin-top:2px;">✓ Completed <span style="opacity:.75;">(${completeRate}%)</span></div>
    </div>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px 18px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:#2563eb;">${totalInProg}</div>
      <div style="font-size:11px;color:#2563eb;margin-top:2px;">⟳ In Progress <span style="opacity:.75;">(${inProgRate}%)</span></div>
    </div>
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:#d97706;">${totalPending}</div>
      <div style="font-size:11px;color:#d97706;margin-top:2px;">— Pending <span style="opacity:.75;">(${pendingRate}%)</span></div>
    </div>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px 18px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:${tlRspColor};">${tlRspDisplay}</div>
      <div style="font-size:11px;color:#2563eb;margin-top:2px;">📦 RSP &amp; Kit Rate</div>
    </div>
    <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:10px;padding:14px 18px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:${checklistRateColor};">${checklistCompletionRate}%</div>
      <div style="font-size:11px;color:#7c3aed;margin-top:2px;">📋 Checklist Completion Rate</div>
    </div>
  </div>`;

  // ── Table rows ──
  if (allRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:2rem;">No checklist data yet for your team.</td></tr>';
    return;
  }

  tbody.innerHTML = allRows.map(r => {
    const badge  = r.overallDone === 100 ? 'badge-done">Complete'
                 : r.overallDone === 0   ? 'badge-pending">Not started'
                 :                         'badge-partial">In progress';
    const lastStr = r.lastActive
      ? new Date(r.lastActive).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : '—';
    const isSelf = r.member.uid === currentUser.uid;
    return `<tr>
      <td><strong>${escHtml(r.member.name || r.member.username)}</strong>${isSelf ? ' <span style="font-size:10px;background:#eff6ff;color:#2563eb;border-radius:4px;padding:1px 6px;margin-left:2px;">You</span>' : ''}<br><span style="font-size:11px;color:var(--text-muted)">@${escHtml(r.member.username)}</span></td>
      <td>${escHtml(r.camp.name)}${r.entryRegion ? ` <span style="font-size:10px;font-weight:700;background:#EEF2FF;color:#4338CA;border-radius:4px;padding:1px 6px;margin-left:2px;">${escHtml(r.entryRegion)}</span>` : ''}${r.entryLabel ? ` <span style="font-size:11px;color:var(--text-muted);">· ${escHtml(r.entryLabel)}</span>` : ''}${r.rowDeadline ? `<br><span style="font-size:10px;color:${r.dueState === 'overdue' ? '#DC2626' : '#D97706'};font-weight:600;">⏰ ${fmtDeadlineShort(r.rowDeadline)}</span>` : ''}</td>
      <td>${r.hasD5 === false ? '<span style="color:var(--text-muted);font-size:11px;">N/A</span>' : `${miniBar(r.d5Pct)} ${r.d5Done}/${r.totalItems}`}</td>
      <td>${miniBar(r.d1Pct)} ${r.d1Done}/${r.totalItems}</td>
      <td><span class="badge ${badge}</span>${
        r.overallDone < 100 && r.dueState === 'overdue'
          ? '<br><span class="deadline-pill dp-red" style="margin-top:3px;display:inline-block;">⚠ Overdue</span>'
          : (r.overallDone < 100 && r.dueState === 'not_due' && r.rowDeadline)
            ? '<br><span class="deadline-pill ac-notdue" style="margin-top:3px;display:inline-block;" title="This region\u2019s deadline hasn\u2019t passed yet">Not due yet</span>'
            : ''
      }</td>
      <td style="font-size:12px;color:var(--text-muted)">${lastStr}</td>
      <td style="white-space:nowrap;">
        <button class="btn-link" onclick="openTlReviewModal('${r.member.uid}','${r.camp.id}')">Review</button>
      </td>
    </tr>`;
  }).join('');

  filterTlProgressTable();
}

// ── Status filter for team-lead "Dashboard" progress table ──────
let _tlStatusFilter = 'all';

function filterTlByStatus(btn, status) {
  _tlStatusFilter = status;
  document.querySelectorAll('#tl-status-filter-row .status-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  filterTlProgressTable();
}

function filterTlProgressTable() {
  const q = (document.getElementById('tl-table-search')?.value || '').toLowerCase();
  const rows = document.querySelectorAll('#tl-tbody tr');
  rows.forEach(tr => {
    const matchesSearch = !q || tr.textContent.toLowerCase().includes(q);
    let matchesStatus = true;
    if (_tlStatusFilter && _tlStatusFilter !== 'all') {
      const badgeEl = tr.querySelector('.badge');
      const txt = badgeEl ? badgeEl.textContent.trim().toLowerCase() : '';
      const isPending    = txt.includes('not started');
      const isInProgress = txt.includes('in progress');
      const isCompleted  = txt.includes('complete');
      if (_tlStatusFilter === 'pending'     && !isPending)    matchesStatus = false;
      if (_tlStatusFilter === 'in-progress' && !isInProgress) matchesStatus = false;
      if (_tlStatusFilter === 'completed'   && !isCompleted)  matchesStatus = false;
    }
    tr.classList.toggle('table-hidden', !(matchesSearch && matchesStatus));
  });
}

// Jump from the "Dashboard" straight into a specific campaign on the Checklist tab
function switchToTlChecklistTab(campId) {
  selectedCampaignId = campId;
  showTlTab('checklist');
}

// Open the existing review modal in read-only mode for team leads
async function openTlReviewModal(uid, campId) {
  // Merge tl data into global maps so openReviewModal can find them.
  // Also include the team lead's own record — rows in "Dashboard" can be
  // the lead's own checklist (the "You" row), and without this, clicking
  // Review on that row throws (members[uid] is undefined) and silently
  // fails because the lead's own uid is never in tlMembers (tlMembers is
  // built only from managedUids, not the lead themselves).
  Object.assign(members,   tlMembers);
  if (!members[currentUser.uid]) members[currentUser.uid] = currentUser;
  Object.assign(campaigns, tlCampaigns);

  // Hide delete button — team leads are read-only
  const deleteBtn = document.getElementById('review-delete-btn');
  if (deleteBtn) deleteBtn.style.display = 'none';

  await openReviewModal(uid, campId);
}

// ── Admin: open Add Team Lead modal ──
function openTeamLeadModal() {
  const nonAdmins = Object.values(members)
    .filter(m => m.role === 'member')
    .sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));

  window._tlMembersSorted = nonAdmins; // cache for filtering
  window._tlSelectedUids  = new Set(); // reset selections

  renderTlMemberList(nonAdmins);

  const searchEl = document.getElementById('tl-member-search');
  if (searchEl) searchEl.value = '';

  document.getElementById('new-tl-username').value = '';
  document.getElementById('new-tl-name').value     = '';
  document.getElementById('new-tl-password').value = '';
  document.getElementById('teamlead-modal-error').style.display = 'none';
  document.getElementById('teamlead-modal-overlay').style.display = 'flex';
}

// Track selected UIDs for Add Team Lead modal
window._tlSelectedUids = new Set();

function renderTlMemberList(memberList) {
  const list = document.getElementById('tl-member-assign-list');
  list.innerHTML = memberList.length === 0
    ? '<div style="color:var(--text-muted);font-size:13px;">No members found.</div>'
    : memberList.map(m => {
        const checked = window._tlSelectedUids.has(m.uid) ? 'checked' : '';
        return `
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;padding:4px 0;border-radius:6px;">
          <input type="checkbox" value="${m.uid}" ${checked}
            onchange="toggleTlMemberSelection('${m.uid}', this.checked)"
            style="accent-color:var(--blue);width:15px;height:15px;" />
          <span>${escHtml(m.name || m.username)}</span>
          <span style="color:var(--text-muted);font-size:11px;">@${escHtml(m.username)}</span>
        </label>`;
      }).join('');
}

function toggleTlMemberSelection(uid, checked) {
  if (checked) window._tlSelectedUids.add(uid);
  else window._tlSelectedUids.delete(uid);
}

function filterTlMemberList(query) {
  const q = query.trim().toLowerCase();
  const filtered = (window._tlMembersSorted || []).filter(m =>
    !q || (m.name || '').toLowerCase().includes(q) || m.username.toLowerCase().includes(q)
  );
  renderTlMemberList(filtered);
}

function closeTeamLeadModal(e) {
  if (e && e.target !== document.getElementById('teamlead-modal-overlay')) return;
  document.getElementById('teamlead-modal-overlay').style.display = 'none';
}

async function addTeamLead() {
  const username = document.getElementById('new-tl-username').value.trim().toLowerCase();
  const name     = document.getElementById('new-tl-name').value.trim();
  const password = document.getElementById('new-tl-password').value.trim();
  const errEl    = document.getElementById('teamlead-modal-error');
  errEl.style.display = 'none';

  if (!username || !name || !password) { showError(errEl, 'All fields are required.'); return; }
  if (username === ADMIN_USERNAME)      { showError(errEl, 'That username is reserved.'); return; }

  const managedUids = [...(window._tlSelectedUids || new Set())];

  const existing = await db.collection('users').where('username', '==', username).limit(1).get();
  if (!existing.empty) { showError(errEl, 'Username already taken.'); return; }

  try {
    const ref = await db.collection('users').add({ username, name, password, role: 'team_lead', managedUids });
    members[ref.id] = { uid: ref.id, username, name, password, role: 'team_lead', managedUids };
    document.getElementById('teamlead-modal-overlay').style.display = 'none';
    showToast(`Team lead "${name}" added!`, 'success');
    refreshMembersTabIfOpen();
  } catch (e) {
    showError(errEl, 'Failed to add team lead. Try again.');
    console.error(e);
  }
}

// ── Admin: Edit Team Lead members ──────────────────────────────
let _editTlUid = null;
window._editTlSelectedUids = new Set();

function openEditTlModal(uid) {
  const lead = members[uid];
  if (!lead) return;
  _editTlUid = uid;

  // Pre-populate selection from existing managedUids
  window._editTlSelectedUids = new Set(lead.managedUids || []);

  // Info banner
  document.getElementById('edit-tl-info').textContent =
    `${lead.name || lead.username} (@${lead.username})`;

  // Build member list (only non-admin, non-team-lead members)
  const eligible = Object.values(members)
    .filter(m => m.role === 'member')
    .sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));

  window._editTlMembersSorted = eligible;

  const searchEl = document.getElementById('edit-tl-member-search');
  if (searchEl) searchEl.value = '';

  renderEditTlMemberList(eligible);
  document.getElementById('edit-tl-modal-error').style.display = 'none';
  document.getElementById('edit-tl-modal-overlay').style.display = 'flex';
}

function renderEditTlMemberList(memberList) {
  const list = document.getElementById('edit-tl-member-assign-list');
  if (!list) return;
  if (memberList.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No members found.</div>';
    return;
  }
  list.innerHTML = memberList.map(m => {
    const checked = window._editTlSelectedUids.has(m.uid) ? 'checked' : '';
    return `
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;padding:4px 0;border-radius:6px;">
        <input type="checkbox" value="${m.uid}" ${checked}
          onchange="toggleEditTlMember('${m.uid}', this.checked)"
          style="accent-color:var(--blue);width:15px;height:15px;" />
        <span>${escHtml(m.name || m.username)}</span>
        <span style="color:var(--text-muted);font-size:11px;">@${escHtml(m.username)}</span>
      </label>`;
  }).join('');
}

function toggleEditTlMember(uid, checked) {
  if (checked) window._editTlSelectedUids.add(uid);
  else window._editTlSelectedUids.delete(uid);
}

function filterEditTlMemberList(query) {
  const q = query.trim().toLowerCase();
  const filtered = (window._editTlMembersSorted || []).filter(m =>
    !q || (m.name || '').toLowerCase().includes(q) || m.username.toLowerCase().includes(q)
  );
  renderEditTlMemberList(filtered);
}

function closeEditTlModal(e) {
  if (e && e.target !== document.getElementById('edit-tl-modal-overlay')) return;
  document.getElementById('edit-tl-modal-overlay').style.display = 'none';
}

async function saveEditTlMembers() {
  const errEl = document.getElementById('edit-tl-modal-error');
  errEl.style.display = 'none';
  if (!_editTlUid) return;

  const managedUids = [...window._editTlSelectedUids];
  const btn = document.querySelector('#edit-tl-modal-overlay .btn-primary');
  btn.textContent = 'Saving…'; btn.disabled = true;

  try {
    await db.collection('users').doc(_editTlUid).update({ managedUids });
    members[_editTlUid].managedUids = managedUids;
    document.getElementById('edit-tl-modal-overlay').style.display = 'none';
    const lead = members[_editTlUid];
    showToast(`✅ Members updated for "${lead.name || lead.username}"!`, 'success');
    renderDataTab();
    refreshMembersTabIfOpen();
  } catch(e) {
    showError(errEl, 'Failed to save changes. Try again.');
    console.error(e);
  } finally {
    btn.textContent = '💾 Save Changes'; btn.disabled = false;
  }
}

// ── Admin: open Add Manager modal ──────────────────────────────
function openManagerModal() {
  const teamLeadOptions = Object.values(members)
    .filter(m => m.role === 'team_lead')
    .sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));

  window._mgrTlsSorted = teamLeadOptions; // cache for filtering
  window._mgrSelectedUids = new Set(); // reset selections

  renderMgrTlList(teamLeadOptions);

  const searchEl = document.getElementById('mgr-tl-search');
  if (searchEl) searchEl.value = '';

  document.getElementById('new-mgr-username').value = '';
  document.getElementById('new-mgr-name').value     = '';
  document.getElementById('new-mgr-password').value = '';
  document.getElementById('manager-modal-error').style.display = 'none';
  document.getElementById('manager-modal-overlay').style.display = 'flex';
}

// Track selected team-lead UIDs for Add Manager modal
window._mgrSelectedUids = new Set();

function renderMgrTlList(tlList) {
  const list = document.getElementById('mgr-tl-assign-list');
  list.innerHTML = tlList.length === 0
    ? '<div style="color:var(--text-muted);font-size:13px;">No team leads yet — add one first.</div>'
    : tlList.map(tl => {
        const checked = window._mgrSelectedUids.has(tl.uid) ? 'checked' : '';
        const cnt = (tl.managedUids || []).length;
        return `
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;padding:4px 0;border-radius:6px;">
          <input type="checkbox" value="${tl.uid}" ${checked}
            onchange="toggleMgrTlSelection('${tl.uid}', this.checked)"
            style="accent-color:var(--blue);width:15px;height:15px;" />
          <span>${escHtml(tl.name || tl.username)}</span>
          <span style="color:var(--text-muted);font-size:11px;">@${escHtml(tl.username)} · ${cnt} member${cnt !== 1 ? 's' : ''}</span>
        </label>`;
      }).join('');
}

function toggleMgrTlSelection(uid, checked) {
  if (checked) window._mgrSelectedUids.add(uid);
  else window._mgrSelectedUids.delete(uid);
}

function filterMgrTlList(query) {
  const q = query.trim().toLowerCase();
  const filtered = (window._mgrTlsSorted || []).filter(tl =>
    !q || (tl.name || '').toLowerCase().includes(q) || tl.username.toLowerCase().includes(q)
  );
  renderMgrTlList(filtered);
}

function closeManagerModal(e) {
  if (e && e.target !== document.getElementById('manager-modal-overlay')) return;
  document.getElementById('manager-modal-overlay').style.display = 'none';
}

async function addManager() {
  const username = document.getElementById('new-mgr-username').value.trim().toLowerCase();
  const name     = document.getElementById('new-mgr-name').value.trim();
  const password = document.getElementById('new-mgr-password').value.trim();
  const errEl    = document.getElementById('manager-modal-error');
  errEl.style.display = 'none';

  if (!username || !name || !password) { showError(errEl, 'All fields are required.'); return; }
  if (username === ADMIN_USERNAME)      { showError(errEl, 'That username is reserved.'); return; }

  const managedUids = [...(window._mgrSelectedUids || new Set())];

  const existing = await db.collection('users').where('username', '==', username).limit(1).get();
  if (!existing.empty) { showError(errEl, 'Username already taken.'); return; }

  try {
    const ref = await db.collection('users').add({ username, name, password, role: 'manager', managedUids });
    members[ref.id] = { uid: ref.id, username, name, password, role: 'manager', managedUids };
    document.getElementById('manager-modal-overlay').style.display = 'none';
    showToast(`Manager "${name}" added!`, 'success');
    refreshMembersTabIfOpen();
  } catch (e) {
    showError(errEl, 'Failed to add manager. Try again.');
    console.error(e);
  }
}

// ── Admin: Edit Manager's assigned team leads ──────────────────
let _editMgrUid = null;
window._editMgrSelectedUids = new Set();

function openEditMgrModal(uid) {
  const mgr = members[uid];
  if (!mgr) return;
  _editMgrUid = uid;

  window._editMgrSelectedUids = new Set(mgr.managedUids || []);

  document.getElementById('edit-mgr-info').textContent =
    `${mgr.name || mgr.username} (@${mgr.username})`;

  const eligible = Object.values(members)
    .filter(m => m.role === 'team_lead')
    .sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));

  window._editMgrTlsSorted = eligible;

  const searchEl = document.getElementById('edit-mgr-tl-search');
  if (searchEl) searchEl.value = '';

  renderEditMgrTlList(eligible);
  document.getElementById('edit-mgr-modal-error').style.display = 'none';
  document.getElementById('edit-mgr-modal-overlay').style.display = 'flex';
}

function renderEditMgrTlList(tlList) {
  const list = document.getElementById('edit-mgr-tl-assign-list');
  if (!list) return;
  if (tlList.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No team leads found.</div>';
    return;
  }
  list.innerHTML = tlList.map(tl => {
    const checked = window._editMgrSelectedUids.has(tl.uid) ? 'checked' : '';
    const cnt = (tl.managedUids || []).length;
    return `
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;padding:4px 0;border-radius:6px;">
        <input type="checkbox" value="${tl.uid}" ${checked}
          onchange="toggleEditMgrTl('${tl.uid}', this.checked)"
          style="accent-color:var(--blue);width:15px;height:15px;" />
        <span>${escHtml(tl.name || tl.username)}</span>
        <span style="color:var(--text-muted);font-size:11px;">@${escHtml(tl.username)} · ${cnt} member${cnt !== 1 ? 's' : ''}</span>
      </label>`;
  }).join('');
}

function toggleEditMgrTl(uid, checked) {
  if (checked) window._editMgrSelectedUids.add(uid);
  else window._editMgrSelectedUids.delete(uid);
}

function filterEditMgrTlList(query) {
  const q = query.trim().toLowerCase();
  const filtered = (window._editMgrTlsSorted || []).filter(tl =>
    !q || (tl.name || '').toLowerCase().includes(q) || tl.username.toLowerCase().includes(q)
  );
  renderEditMgrTlList(filtered);
}

function closeEditMgrModal(e) {
  if (e && e.target !== document.getElementById('edit-mgr-modal-overlay')) return;
  document.getElementById('edit-mgr-modal-overlay').style.display = 'none';
}

async function saveEditMgrTeamLeads() {
  const errEl = document.getElementById('edit-mgr-modal-error');
  errEl.style.display = 'none';
  if (!_editMgrUid) return;

  const managedUids = [...window._editMgrSelectedUids];
  const btn = document.querySelector('#edit-mgr-modal-overlay .btn-primary');
  btn.textContent = 'Saving…'; btn.disabled = true;

  try {
    await db.collection('users').doc(_editMgrUid).update({ managedUids });
    members[_editMgrUid].managedUids = managedUids;
    document.getElementById('edit-mgr-modal-overlay').style.display = 'none';
    const mgr = members[_editMgrUid];
    showToast(`✅ Team leads updated for "${mgr.name || mgr.username}"!`, 'success');
    renderDataTab();
    refreshMembersTabIfOpen();
  } catch(e) {
    showError(errEl, 'Failed to save changes. Try again.');
    console.error(e);
  } finally {
    btn.textContent = '💾 Save Changes'; btn.disabled = false;
  }
}

function openChangePasswordModal() {
  document.getElementById('cp-current').value = '';
  document.getElementById('cp-new').value     = '';
  document.getElementById('cp-confirm').value = '';
  document.getElementById('cp-error').style.display = 'none';
  document.getElementById('change-password-overlay').style.display = 'flex';
}

function closeChangePasswordModal(e) {
  if (e && e.target !== document.getElementById('change-password-overlay')) return;
  document.getElementById('change-password-overlay').style.display = 'none';
}

async function changePassword() {
  const current = document.getElementById('cp-current').value;
  const newPwd  = document.getElementById('cp-new').value.trim();
  const confirm = document.getElementById('cp-confirm').value.trim();
  const errEl   = document.getElementById('cp-error');
  errEl.style.display = 'none';

  if (!current || !newPwd || !confirm) { showError(errEl, 'All fields are required.'); return; }
  if (newPwd.length < 6)               { showError(errEl, 'New password must be at least 6 characters.'); return; }
  if (newPwd !== confirm)              { showError(errEl, 'New passwords do not match.'); return; }

  try {
    const snap = await db.collection('users').doc(currentUser.uid).get();
    if (!snap.exists) { showError(errEl, 'User not found.'); return; }
    if (snap.data().password !== current) { showError(errEl, 'Current password is incorrect.'); return; }

    await db.collection('users').doc(currentUser.uid).update({ password: newPwd });
    document.getElementById('change-password-overlay').style.display = 'none';
    showToast('✅ Password updated successfully!', 'success');
  } catch (e) {
    showError(errEl, 'Failed to update password. Try again.');
    console.error(e);
  }
}

// ─────────────────────────────────────────────────────────────
//  ADMIN RESET PASSWORD  (Admin resets any member's password)
// ─────────────────────────────────────────────────────────────
let _resetTargetUid = null;

function openAdminResetPassword(uid, displayName) {
  _resetTargetUid = uid;
  document.getElementById('rp-member-info').textContent = `Resetting password for: ${displayName}`;
  document.getElementById('rp-new').value     = '';
  document.getElementById('rp-confirm').value = '';
  document.getElementById('rp-error').style.display = 'none';
  document.getElementById('reset-password-overlay').style.display = 'flex';
}

function closeResetPasswordModal(e) {
  if (e && e.target !== document.getElementById('reset-password-overlay')) return;
  document.getElementById('reset-password-overlay').style.display = 'none';
}

async function confirmResetPassword() {
  const newPwd  = document.getElementById('rp-new').value.trim();
  const confirm = document.getElementById('rp-confirm').value.trim();
  const errEl   = document.getElementById('rp-error');
  errEl.style.display = 'none';

  if (!newPwd || !confirm)  { showError(errEl, 'Both fields are required.'); return; }
  if (newPwd.length < 6)    { showError(errEl, 'Password must be at least 6 characters.'); return; }
  if (newPwd !== confirm)   { showError(errEl, 'Passwords do not match.'); return; }
  if (!_resetTargetUid)     { showError(errEl, 'No user selected.'); return; }

  try {
    await db.collection('users').doc(_resetTargetUid).update({ password: newPwd });
    if (members[_resetTargetUid]) members[_resetTargetUid].password = newPwd;
    document.getElementById('reset-password-overlay').style.display = 'none';
    showToast('✅ Password reset successfully!', 'success');
  } catch (e) {
    showError(errEl, 'Failed to reset password. Try again.');
    console.error(e);
  }
}
