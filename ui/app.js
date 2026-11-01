'use strict';
/* Punchlist Manager – all screens. Data lives in SQLite via the Rust side. */

// ================= backend bridge =================
const invoke = (cmd, args = {}) =>
  window.__TAURI__ ? window.__TAURI__.core.invoke(cmd, args) : window.__mockInvoke(cmd, args);
const q = (sql, params = []) => invoke('db_query', { sql, params });
const ex = (sql, params = []) => invoke('db_execute', { sql, params });
const one = async (sql, params = []) => (await q(sql, params))[0] || null;

// ================= constants =================
const KINDS = ['Punchlist Inspection', 'Re-inspection', 'Acceptance', 'Turnover', 'Other'];
const SCHED_STATUS = ['Scheduled', 'Done', 'Rescheduled', 'Cancelled', 'No-show'];
const CATEGORIES = ['Civil / Masonry', 'Painting', 'Carpentry', 'Plumbing', 'Electrical', 'Doors & Windows',
  'Tiles / Flooring', 'Ceiling', 'Roofing', 'Cleaning', 'Others'];
const SEVERITY = ['Minor', 'Major', 'Critical'];
const PUNCH_STATUS = ['Open', 'Fixed', 'Not Applicable'];
const REPAIR_STATUS = ['Open', 'In Progress', 'Done'];
const AREAS = ['Living Room', 'Dining', 'Kitchen', 'Master Bedroom', 'Bedroom 2', 'Bedroom 3', 'Toilet & Bath',
  'Laundry', 'Stairs', 'Balcony', 'Garage / Carport', 'Facade / Exterior', 'Roof', 'Whole House'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SCHED_SELECT = `SELECT s.*, h.name, h.unit, h.project, h.phone
  FROM schedules s JOIN homeowners h ON h.id = s.homeowner_id`;
const REPAIR_SELECT = `SELECT r.*, h.name, h.unit, h.project, p.area AS area
  FROM repairs r JOIN homeowners h ON h.id = r.homeowner_id
  LEFT JOIN punch_items p ON p.id = r.punch_item_id`;
const PUNCH_SELECT = `SELECT p.*, h.name, h.unit,
  (SELECT r.id FROM repairs r WHERE r.punch_item_id = p.id ORDER BY r.id DESC LIMIT 1) AS repair_id,
  (SELECT r.status FROM repairs r WHERE r.punch_item_id = p.id ORDER BY r.id DESC LIMIT 1) AS repair_status,
  (SELECT r.target_date FROM repairs r WHERE r.punch_item_id = p.id ORDER BY r.id DESC LIMIT 1) AS repair_target
  FROM punch_items p JOIN homeowners h ON h.id = p.homeowner_id`;
// "Open items" = punchlist items not yet fixed + repairs not linked to a punchlist item that are not done.
const OPEN_ITEMS_EXPR = `((SELECT COUNT(*) FROM punch_items p WHERE p.homeowner_id = h.id AND p.status = 'Open')
  + (SELECT COUNT(*) FROM repairs r WHERE r.homeowner_id = h.id AND r.punch_item_id IS NULL AND r.status != 'Done'))`;
const OVERDUE_COND = `r.status != 'Done' AND r.target_date IS NOT NULL AND r.target_date != '' AND r.target_date < ?`;

let settings = {
  company_name: '',
  company_address: '',
  timezone: 'Asia/Manila',
  default_repair_days: '14',
  default_duration: '60',
};

const state = {
  view: 'dashboard',
  homeownerId: null,
  hoSearch: '',
  schedFilter: 'upcoming',
  punchHo: '',
  punchStatus: 'Open',
  repFilter: 'open',
  repAssigned: '',
};

// ================= utilities =================
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const fmtDate = (s) => { if (!s) return ''; const d = parseYmd(s); return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
const fmtTime = (t) => {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad(m)} ${ap}`;
};
const nowStamp = () => { const d = new Date(); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const opts = (list, sel) => list.map((o) => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const nz = (v) => { const t = (v ?? '').toString().trim(); return t === '' ? null : t; };

function formData(form) {
  const o = {};
  for (const [k, v] of new FormData(form).entries()) if (!k.endsWith('[]')) o[k] = typeof v === 'string' ? v.trim() : v;
  return o;
}

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstElementChild.remove();
  box.appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3500);
}

/** Generic modal. Resolves with onOk's return value (or true), or null if cancelled. */
function openModal({ title, body, okText = 'Save', cancelText = 'Cancel', wide = false, onOk, onOpen, danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head">${esc(title)}</div>
      <form class="modal-body" novalidate>${body}
        <div class="modal-foot">
          ${cancelText ? `<button type="button" class="btn ghost" data-cancel>${esc(cancelText)}</button>` : ''}
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(okText)}</button>
        </div>
      </form></div>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    let busy = false;
    const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape' && document.body.lastElementChild === wrap) close(null); };
    document.addEventListener('keydown', onKey);
    const cancelBtn = wrap.querySelector('[data-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => close(null));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      try {
        const r = onOk ? await onOk(form) : true;
        if (r !== false) close(r === undefined ? true : r);
      } catch (err) {
        toast(String(err && err.message ? err.message : err), 'err');
      } finally {
        busy = false;
      }
    });
    if (onOpen) onOpen(form);
    const first = form.querySelector('input:not([type=hidden]):not([type=checkbox]),select,textarea');
    if (first) first.focus();
  });
}

const confirmBox = (html, okText = 'OK', title = 'Please confirm', danger = false) =>
  openModal({ title, body: `<div>${html}</div>`, okText, danger });

// ================= domain helpers =================
async function loadSettings() {
  const rows = await q('SELECT key, value FROM settings');
  for (const r of rows) settings[r.key] = r.value ?? '';
  $('#brand-company').textContent = settings.company_name || '';
}

async function openItemCount(hid) {
  const r = await one(`SELECT ${OPEN_ITEMS_EXPR} AS n FROM homeowners h WHERE h.id = ?`, [hid]);
  return r ? r.n : 0;
}

function isOverdue(r) {
  return r.status !== 'Done' && r.target_date && r.target_date < today();
}

function repairFlag(r) {
  if (r.status === 'Done') return `<span class="badge green">Done</span>`;
  if (isOverdue(r)) {
    const late = daysBetween(r.target_date, today());
    return `<span class="flag">OVERDUE · ${plural(late, 'day')} late</span>`;
  }
  if (!r.target_date) return `<span class="badge">${esc(r.status)}</span> <span class="muted small">no target date</span>`;
  const left = daysBetween(today(), r.target_date);
  return `<span class="badge ${r.status === 'In Progress' ? 'blue' : ''}">${esc(r.status)}</span>
    <span class="muted small">${left === 0 ? 'due today' : `${plural(left, 'day')} left`}</span>`;
}

function kindBadge(k) {
  const cls = { 'Punchlist Inspection': 'blue', 'Re-inspection': 'purple', Acceptance: 'green', Turnover: 'amber' }[k] || '';
  return `<span class="badge ${cls}">${esc(k)}</span>`;
}

function schedStatusBadge(s) {
  const cls = { Scheduled: 'blue', Done: 'green', Cancelled: 'red', 'No-show': 'red', Rescheduled: 'amber' }[s] || '';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

function punchStatusBadge(s) {
  return `<span class="badge ${s === 'Fixed' ? 'green' : s === 'Open' ? 'amber' : ''}">${esc(s)}</span>`;
}

function hoLink(id, name) {
  return `<a class="link" data-act="openHo" data-id="${id}">${esc(name)}</a>`;
}

async function refreshOverdueBadge() {
  const r = await one(`SELECT COUNT(*) AS n FROM repairs r WHERE ${OVERDUE_COND}`, [today()]);
  const b = $('#nav-overdue');
  if (r && r.n > 0) { b.textContent = r.n; b.classList.remove('hidden'); } else b.classList.add('hidden');
}

// ================= Google Calendar =================
function gcalUrl(s, openCount) {
  const tz = settings.timezone || 'Asia/Manila';
  const [y, m, d] = s.date.split('-').map(Number);
  let dates;
  if (s.start_time) {
    const [hh, mm] = s.start_time.split(':').map(Number);
    const st = new Date(y, m - 1, d, hh, mm);
    const en = new Date(st.getTime() + (Number(s.duration_min) || 60) * 60000);
    const f = (x) => `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
    dates = `${f(st)}/${f(en)}`;
  } else {
    dates = `${s.date.replace(/-/g, '')}/${addDays(s.date, 1).replace(/-/g, '')}`;
  }
  const title = `${s.kind} – ${s.name}${s.unit ? ` (${s.unit})` : ''}`;
  const details = [
    `Schedule: ${s.kind}`,
    `Homeowner: ${s.name}`,
    s.unit ? `Unit / Address: ${s.unit}` : null,
    s.project ? `Project: ${s.project}` : null,
    s.phone ? `Contact: ${s.phone}` : null,
    openCount != null ? `Open punchlist / repair items: ${openCount}` : null,
    s.notes ? `Notes: ${s.notes}` : null,
    settings.company_name ? `— ${settings.company_name}` : null,
  ].filter(Boolean).join('\n');
  const p = { action: 'TEMPLATE', text: title, dates, details, location: s.unit || '', ctz: tz };
  return 'https://calendar.google.com/calendar/render?' +
    Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function addToGcal(id) {
  const s = await one(SCHED_SELECT + ' WHERE s.id = ?', [id]);
  if (!s) return;
  const n = await openItemCount(s.homeowner_id);
  await invoke('open_url', { url: gcalUrl(s, n) });
  const ok = await openModal({
    title: 'Add to Google Calendar',
    body: `<p>Google Calendar has opened in your browser with this event already filled in:</p>
      <p><b>${esc(s.kind)} – ${esc(s.name)}</b><br>${fmtDate(s.date)} ${fmtTime(s.start_time)}</p>
      <p>Click <b>Save</b> in Google Calendar. Did you save it?</p>`,
    okText: 'Yes, mark as added',
    cancelText: 'Not yet',
  });
  if (ok) {
    await ex('UPDATE schedules SET gcal_added = 1 WHERE id = ?', [id]);
    toast('Marked as added to Google Calendar');
    render();
  }
}

function gcalCell(s) {
  if (s.status === 'Cancelled') return `<span class="muted small">—</span>`;
  if (s.gcal_added) {
    return `<span class="badge green">✓ In Google</span>
      <button class="btn small ghost" data-act="gcal" data-id="${s.id}" title="Open again in Google Calendar">Re-add</button>`;
  }
  return `<button class="btn small gcal" data-act="gcal" data-id="${s.id}">+ Google Calendar</button>`;
}

// ================= navigation =================
const VIEWS = {};
async function render() {
  document.querySelectorAll('#nav button').forEach((b) => {
    const v = state.view === 'homeowner' ? 'homeowners' : state.view;
    b.classList.toggle('active', b.dataset.view === v);
  });
  const main = $('#main');
  try {
    await VIEWS[state.view](main);
  } catch (e) {
    main.innerHTML = `<div class="banner red">Something went wrong: ${esc(e)}</div>`;
    console.error(e);
  }
  refreshOverdueBadge().catch(() => {});
}
function go(view, extra = {}) {
  Object.assign(state, { view }, extra);
  $('#main').scrollTop = 0;
  render();
}

// ================= table renderers =================
function schedTable(rows, { showHo = true } = {}) {
  if (!rows.length) return `<div class="empty">No schedules.</div>`;
  return `<div class="table-wrap"><table class="list"><thead><tr>
      <th>Date</th><th>Time</th><th>Type</th>${showHo ? '<th>Homeowner</th><th>Unit / Address</th>' : ''}
      <th>Status</th><th>Google Calendar</th><th></th></tr></thead><tbody>
    ${rows.map((s) => `<tr>
      <td class="nowrap"><b>${fmtDate(s.date)}</b>${s.date === today() ? ' <span class="badge amber">Today</span>' : ''}</td>
      <td class="nowrap">${fmtTime(s.start_time) || '<span class="muted">—</span>'}</td>
      <td>${kindBadge(s.kind)}</td>
      ${showHo ? `<td>${hoLink(s.homeowner_id, s.name)}</td><td>${esc(s.unit)}</td>` : ''}
      <td>${schedStatusBadge(s.status)}</td>
      <td class="nowrap">${gcalCell(s)}</td>
      <td class="nowrap">
        <button class="btn small" data-act="editSched" data-id="${s.id}">Edit</button>
        <button class="btn small danger" data-act="delSched" data-id="${s.id}">Delete</button>
      </td></tr>`).join('')}
    </tbody></table></div>`;
}

function repairTable(rows, { showHo = true } = {}) {
  if (!rows.length) return `<div class="empty">No repairs.</div>`;
  return `<div class="table-wrap"><table class="list"><thead><tr>
      <th>Flag / Status</th>${showHo ? '<th>Homeowner</th>' : ''}<th>Area</th><th>Repair</th><th>Assigned to</th>
      <th>Started</th><th>Target date</th><th>Done</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${isOverdue(r) ? 'overdue' : ''}">
      <td>${repairFlag(r)}</td>
      ${showHo ? `<td>${hoLink(r.homeowner_id, r.name)}<div class="muted small">${esc(r.unit)}</div></td>` : ''}
      <td>${esc(r.area)}</td>
      <td class="desc">${esc(r.description)}${r.notes ? `<div class="muted small">${esc(r.notes)}</div>` : ''}</td>
      <td>${esc(r.assigned_to)}</td>
      <td class="nowrap">${fmtDate(r.date_started)}</td>
      <td class="nowrap"><b>${fmtDate(r.target_date)}</b></td>
      <td class="nowrap">${fmtDate(r.date_done)}</td>
      <td class="nowrap">
        ${r.status !== 'Done' ? `<button class="btn small" data-act="repDone" data-id="${r.id}">Mark done</button>` : ''}
        <button class="btn small" data-act="editRep" data-id="${r.id}">Edit</button>
        <button class="btn small danger" data-act="delRep" data-id="${r.id}">Delete</button>
      </td></tr>`).join('')}
    </tbody></table></div>`;
}

function punchTable(rows, { showHo = true } = {}) {
  if (!rows.length) return `<div class="empty">No punchlist items.</div>`;
  return `<div class="table-wrap"><table class="list"><thead><tr>
      <th>Recorded</th>${showHo ? '<th>Homeowner</th>' : ''}<th>Area</th><th>Defect / Item</th><th>Category</th>
      <th>Severity</th><th>Status</th><th>Repair</th><th></th></tr></thead><tbody>
    ${rows.map((p) => {
      const rep = p.repair_id
        ? (p.repair_status === 'Done'
          ? `<span class="badge green">Repaired</span>`
          : (p.repair_target && p.repair_target < today()
            ? `<span class="flag">OVERDUE</span>`
            : `<span class="badge blue">${esc(p.repair_status)}</span> <span class="muted small">due ${fmtDate(p.repair_target)}</span>`))
        : (p.status === 'Open' ? `<button class="btn small" data-act="punchToRepair" data-id="${p.id}">Create repair</button>` : '');
      return `<tr>
      <td class="nowrap">${fmtDate(p.recorded_date)}</td>
      ${showHo ? `<td>${hoLink(p.homeowner_id, p.name)}<div class="muted small">${esc(p.unit)}</div></td>` : ''}
      <td>${esc(p.area)}</td>
      <td>${esc(p.defect)}${p.notes ? `<div class="muted small">${esc(p.notes)}</div>` : ''}</td>
      <td>${esc(p.category)}</td>
      <td><span class="badge ${p.severity === 'Critical' ? 'red' : p.severity === 'Major' ? 'amber' : ''}">${esc(p.severity)}</span></td>
      <td>${punchStatusBadge(p.status)}</td>
      <td class="nowrap">${rep}</td>
      <td class="nowrap">
        <button class="btn small" data-act="editPunch" data-id="${p.id}">Edit</button>
        <button class="btn small danger" data-act="delPunch" data-id="${p.id}">Delete</button>
      </td></tr>`;
    }).join('')}
    </tbody></table></div>`;
}

// ================= VIEW: dashboard =================
VIEWS.dashboard = async (el) => {
  const t = today();
  const wk = addDays(t, 6);
  const c = await one(`SELECT
      (SELECT COUNT(*) FROM homeowners) AS ho,
      (SELECT COUNT(*) FROM repairs WHERE status != 'Done') AS open_rep,
      (SELECT COUNT(*) FROM repairs r WHERE ${OVERDUE_COND}) AS overdue,
      (SELECT COUNT(*) FROM schedules WHERE status = 'Scheduled' AND date BETWEEN ? AND ?) AS week,
      (SELECT COUNT(*) FROM punch_items WHERE status = 'Open') AS open_punch,
      (SELECT COUNT(*) FROM schedules WHERE status = 'Scheduled' AND date >= ? AND gcal_added = 0) AS not_gcal`,
  [t, t, wk, t]);
  const upcoming = await q(SCHED_SELECT + ` WHERE s.status = 'Scheduled' AND s.date >= ? ORDER BY s.date, s.start_time LIMIT 10`, [t]);
  const overdue = await q(REPAIR_SELECT + ` WHERE ${OVERDUE_COND} ORDER BY r.target_date LIMIT 10`, [t]);
  // acceptance schedules with open items
  const accWarn = await q(`SELECT s.id, s.date, h.id AS hid, h.name, ${OPEN_ITEMS_EXPR} AS open_n
      FROM schedules s JOIN homeowners h ON h.id = s.homeowner_id
      WHERE s.kind = 'Acceptance' AND s.status = 'Scheduled' AND s.date >= ? ORDER BY s.date`, [t]);
  const accOpen = accWarn.filter((a) => a.open_n > 0);

  el.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><div class="sub">${fmtDate(t)}</div></div>
      <div class="actions">
        <button class="btn" data-act="newHo">+ Homeowner</button>
        <button class="btn" data-act="newSched">+ Schedule</button>
        <button class="btn primary" data-act="recordPunch">+ Record Punchlist</button>
      </div></div>
    <div class="stats">
      <div class="stat ${c.overdue ? 'red' : ''}" data-act="nav" data-view="repairs" data-filter="overdue">
        <div class="num">${c.overdue}</div><div class="lbl">Repairs past target date</div></div>
      <div class="stat" data-act="nav" data-view="repairs" data-filter="open"><div class="num">${c.open_rep}</div><div class="lbl">Open repairs</div></div>
      <div class="stat" data-act="nav" data-view="punchlist"><div class="num">${c.open_punch}</div><div class="lbl">Open punchlist items</div></div>
      <div class="stat" data-act="nav" data-view="schedules"><div class="num">${c.week}</div><div class="lbl">Schedules in the next 7 days</div></div>
      <div class="stat" data-act="nav" data-view="homeowners"><div class="num">${c.ho}</div><div class="lbl">Homeowners</div></div>
    </div>
    ${c.not_gcal ? `<div class="banner warn">${plural(c.not_gcal, 'upcoming schedule')} not yet added to Google Calendar.
      <a class="link" data-act="nav" data-view="schedules" data-filter="nogcal">Show them</a></div>` : ''}
    ${accOpen.map((a) => `<div class="banner red">⚠️ Acceptance for ${hoLink(a.hid, a.name)} on <b>${fmtDate(a.date)}</b>
      but ${plural(a.open_n, 'item')} still open.</div>`).join('')}
    <div>
      <div class="card"><h2>Upcoming schedules <a class="link small" data-act="nav" data-view="schedules">View all</a></h2>
        ${schedTable(upcoming)}</div>
      <div class="card"><h2>Repairs past target date <a class="link small" data-act="nav" data-view="repairs" data-filter="overdue">View all</a></h2>
        ${overdue.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Flag</th><th>Homeowner</th><th>Repair</th><th>Assigned</th><th>Target</th></tr></thead><tbody>
          ${overdue.map((r) => `<tr class="overdue"><td>${repairFlag(r)}</td><td>${hoLink(r.homeowner_id, r.name)}</td>
            <td>${esc(r.description)}</td><td>${esc(r.assigned_to)}</td><td class="nowrap">${fmtDate(r.target_date)}</td></tr>`).join('')}
          </tbody></table></div>` : `<div class="empty">✓ No overdue repairs.</div>`}
      </div>
    </div>`;
};

// ================= VIEW: homeowners =================
VIEWS.homeowners = async (el) => {
  el.innerHTML = `
    <div class="page-head"><div><h1>Homeowners</h1><div class="sub">Click a name to see schedules, punchlist and repairs.</div></div>
      <div class="actions"><button class="btn" data-act="exportHo">Export to Excel</button>
      <button class="btn primary" data-act="newHo">+ Add Homeowner</button></div></div>
    <div class="card">
      <div class="filters"><input type="search" id="ho-search" placeholder="Search name, unit, project, contact…" value="${esc(state.hoSearch)}"></div>
      <div id="ho-table"></div>
    </div>`;
  const input = $('#ho-search');
  input.addEventListener('input', () => { state.hoSearch = input.value; loadHoTable(); });
  await loadHoTable();
};

async function loadHoTable() {
  const s = `%${state.hoSearch.trim()}%`;
  const t = today();
  const rows = await q(`SELECT h.*, ${OPEN_ITEMS_EXPR} AS open_n,
      (SELECT COUNT(*) FROM repairs r WHERE r.homeowner_id = h.id AND ${OVERDUE_COND}) AS overdue_n,
      (SELECT s.kind || '|' || s.date FROM schedules s WHERE s.homeowner_id = h.id AND s.status = 'Scheduled' AND s.date >= ?
        ORDER BY s.date, s.start_time LIMIT 1) AS next_sched
    FROM homeowners h
    WHERE h.name LIKE ? OR IFNULL(h.unit,'') LIKE ? OR IFNULL(h.project,'') LIKE ? OR IFNULL(h.phone,'') LIKE ?
    ORDER BY h.name COLLATE NOCASE`, [t, t, s, s, s, s]);
  const box = $('#ho-table');
  if (!box) return;
  box.innerHTML = rows.length ? `<div class="table-wrap"><table class="list"><thead><tr>
      <th>Name</th><th>Unit / Address</th><th>Project</th><th>Contact</th><th>Open items</th><th>Overdue</th><th>Next schedule</th></tr></thead><tbody>
    ${rows.map((h) => {
      const [k, d] = (h.next_sched || '').split('|');
      return `<tr>
        <td>${hoLink(h.id, h.name)}</td><td>${esc(h.unit)}</td><td>${esc(h.project)}</td>
        <td>${esc(h.phone)}${h.email ? `<div class="muted small">${esc(h.email)}</div>` : ''}</td>
        <td>${h.open_n ? `<span class="badge amber">${h.open_n}</span>` : '<span class="badge green">0</span>'}</td>
        <td>${h.overdue_n ? `<span class="flag">${h.overdue_n}</span>` : ''}</td>
        <td>${h.next_sched ? `${kindBadge(k)} <span class="small">${fmtDate(d)}</span>` : '<span class="muted">—</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>`
    : `<div class="empty">${state.hoSearch ? 'No match.' : 'No homeowners yet. Click “+ Add Homeowner”.'}</div>`;
}

// ================= VIEW: single homeowner =================
VIEWS.homeowner = async (el) => {
  const id = state.homeownerId;
  const h = await one('SELECT * FROM homeowners WHERE id = ?', [id]);
  if (!h) { go('homeowners'); return; }
  const t = today();
  const scheds = await q(SCHED_SELECT + ' WHERE s.homeowner_id = ? ORDER BY s.date DESC, s.start_time DESC', [id]);
  const punch = await q(PUNCH_SELECT + ' WHERE p.homeowner_id = ? ORDER BY p.recorded_date DESC, p.id', [id]);
  const reps = await q(REPAIR_SELECT + ` WHERE r.homeowner_id = ? ORDER BY (r.status = 'Done'), r.target_date`, [id]);
  const openN = await openItemCount(id);
  const overdueN = reps.filter(isOverdue).length;
  const nextAcc = scheds.filter((s) => s.kind === 'Acceptance' && s.status === 'Scheduled' && s.date >= t)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  el.innerHTML = `
    <div class="page-head"><div><a class="link small" data-act="nav" data-view="homeowners">← All homeowners</a>
      <h1>${esc(h.name)}</h1><div class="sub">${esc(h.unit)}${h.project ? ' · ' + esc(h.project) : ''}</div></div>
      <div class="actions">
        <button class="btn" data-act="printPunchForm" data-id="${id}">Print Punchlist</button>
        <button class="btn" data-act="printAcceptance" data-id="${id}">Print Acceptance Summary</button>
        <button class="btn" data-act="editHo" data-id="${id}">Edit</button>
        <button class="btn danger" data-act="delHo" data-id="${id}">Delete</button>
      </div></div>
    ${nextAcc && openN ? `<div class="banner red">⚠️ Acceptance is set for <b>${fmtDate(nextAcc.date)}</b> but ${plural(openN, 'item')} still open.</div>` : ''}
    ${overdueN ? `<div class="banner red">${plural(overdueN, 'repair')} past target date.</div>` : ''}
    ${!openN && punch.length ? `<div class="banner ok">✓ All punchlist items are fixed — ready for acceptance.</div>` : ''}
    <div class="card"><div class="info-grid">
      <div><div class="k">Contact number</div><div class="v">${esc(h.phone) || '—'}</div></div>
      <div><div class="k">Email</div><div class="v">${esc(h.email) || '—'}</div></div>
      <div><div class="k">Open items</div><div class="v">${openN}</div></div>
      <div><div class="k">Notes</div><div class="v">${esc(h.notes) || '—'}</div></div>
    </div></div>
    <div class="card"><h2>Schedules <button class="btn small primary" data-act="newSched" data-hid="${id}">+ Schedule</button></h2>
      ${schedTable(scheds, { showHo: false })}</div>
    <div class="card"><h2>Punchlist <button class="btn small primary" data-act="recordPunch" data-hid="${id}">+ Record Punchlist</button></h2>
      ${punchTable(punch, { showHo: false })}</div>
    <div class="card"><h2>Repairs <button class="btn small primary" data-act="newRep" data-hid="${id}">+ Repair</button></h2>
      ${repairTable(reps, { showHo: false })}</div>`;
};

// ================= VIEW: schedules =================
VIEWS.schedules = async (el) => {
  const t = today();
  const f = state.schedFilter;
  let where = '', params = [], order = 's.date, s.start_time';
  if (f === 'upcoming') { where = `WHERE s.status = 'Scheduled' AND s.date >= ?`; params = [t]; }
  else if (f === 'week') { where = `WHERE s.date BETWEEN ? AND ?`; params = [t, addDays(t, 6)]; }
  else if (f === 'nogcal') { where = `WHERE s.status = 'Scheduled' AND s.date >= ? AND s.gcal_added = 0`; params = [t]; }
  else if (f === 'acceptance') { where = `WHERE s.kind = 'Acceptance' AND s.status = 'Scheduled' AND s.date >= ?`; params = [t]; }
  else if (f === 'past') { where = `WHERE s.date < ?`; params = [t]; order = 's.date DESC, s.start_time DESC'; }
  else order = 's.date DESC, s.start_time DESC';
  const rows = await q(`${SCHED_SELECT} ${where} ORDER BY ${order}`, params);
  el.innerHTML = `
    <div class="page-head"><div><h1>Schedules</h1><div class="sub">Punchlist inspections, re-inspections and acceptance dates.</div></div>
      <div class="actions"><button class="btn" data-act="exportSched">Export to Excel</button>
      <button class="btn" data-act="printSchedules">Print</button>
      <button class="btn primary" data-act="newSched">+ Add Schedule</button></div></div>
    <div class="card">
      <div class="filters"><select id="sched-filter">
        ${[['upcoming', 'Upcoming'], ['week', 'Next 7 days'], ['acceptance', 'Upcoming acceptance'], ['nogcal', 'Not yet in Google Calendar'], ['past', 'Past'], ['all', 'All']]
          .map(([v, l]) => `<option value="${v}" ${v === f ? 'selected' : ''}>${l}</option>`).join('')}
      </select><span class="muted small">${plural(rows.length, 'schedule')}</span></div>
      ${schedTable(rows)}
    </div>`;
  $('#sched-filter').addEventListener('change', (e) => { state.schedFilter = e.target.value; render(); });
};

// ================= VIEW: punchlist =================
VIEWS.punchlist = async (el) => {
  const hos = await q('SELECT id, name, unit FROM homeowners ORDER BY name COLLATE NOCASE');
  const cond = [], params = [];
  if (state.punchHo) { cond.push('p.homeowner_id = ?'); params.push(Number(state.punchHo)); }
  if (state.punchStatus) { cond.push('p.status = ?'); params.push(state.punchStatus); }
  const rows = await q(`${PUNCH_SELECT} ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY p.recorded_date DESC, h.name, p.id`, params);
  el.innerHTML = `
    <div class="page-head"><div><h1>Punchlist</h1><div class="sub">Items recorded during homeowner inspections.</div></div>
      <div class="actions"><button class="btn" data-act="exportPunch">Export to Excel</button>
      <button class="btn primary" data-act="recordPunch">+ Record Punchlist</button></div></div>
    <div class="card">
      <div class="filters">
        <select id="punch-ho"><option value="">All homeowners</option>
          ${hos.map((h) => `<option value="${h.id}" ${String(h.id) === String(state.punchHo) ? 'selected' : ''}>${esc(h.name)}${h.unit ? ' – ' + esc(h.unit) : ''}</option>`).join('')}</select>
        <select id="punch-status"><option value="">All statuses</option>${opts(PUNCH_STATUS, state.punchStatus)}</select>
        <span class="muted small">${plural(rows.length, 'item')}</span>
      </div>
      ${punchTable(rows)}
    </div>`;
  $('#punch-ho').addEventListener('change', (e) => { state.punchHo = e.target.value; render(); });
  $('#punch-status').addEventListener('change', (e) => { state.punchStatus = e.target.value; render(); });
};

// ================= VIEW: repairs =================
function repairWhere() {
  const cond = [], params = [];
  const f = state.repFilter;
  if (f === 'open') cond.push(`r.status != 'Done'`);
  else if (f === 'overdue') { cond.push(OVERDUE_COND); params.push(today()); }
  else if (f === 'done') cond.push(`r.status = 'Done'`);
  if (state.repAssigned) { cond.push('r.assigned_to = ?'); params.push(state.repAssigned); }
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', params };
}

VIEWS.repairs = async (el) => {
  const { where, params } = repairWhere();
  const rows = await q(`${REPAIR_SELECT} ${where}
    ORDER BY (r.status = 'Done'), (CASE WHEN r.target_date IS NULL OR r.target_date = '' THEN 1 ELSE 0 END), r.target_date, h.name`, params);
  const people = await q(`SELECT DISTINCT assigned_to AS a FROM repairs WHERE IFNULL(assigned_to,'') != '' ORDER BY a COLLATE NOCASE`);
  const overdueN = rows.filter(isOverdue).length;
  el.innerHTML = `
    <div class="page-head"><div><h1>Repairs</h1><div class="sub">Rows turn <b style="color:var(--red)">red</b> when a repair is past its target date.</div></div>
      <div class="actions"><button class="btn" data-act="exportRep">Export to Excel</button>
      <button class="btn" data-act="printRepairs">Print report</button>
      <button class="btn primary" data-act="newRep">+ Add Repair</button></div></div>
    ${overdueN ? `<div class="banner red"><b>${plural(overdueN, 'repair')}</b> past target date in this list.</div>` : ''}
    <div class="card">
      <div class="filters">
        <select id="rep-filter">${[['open', 'Not done (open + in progress)'], ['overdue', 'Past target date only'], ['done', 'Done'], ['all', 'All']]
          .map(([v, l]) => `<option value="${v}" ${v === state.repFilter ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="rep-assigned"><option value="">Everyone</option>
          ${people.map((p) => `<option ${p.a === state.repAssigned ? 'selected' : ''}>${esc(p.a)}</option>`).join('')}</select>
        <span class="muted small">${plural(rows.length, 'repair')}</span>
      </div>
      ${repairTable(rows)}
    </div>`;
  $('#rep-filter').addEventListener('change', (e) => { state.repFilter = e.target.value; render(); });
  $('#rep-assigned').addEventListener('change', (e) => { state.repAssigned = e.target.value; render(); });
};

// ================= VIEW: reports =================
VIEWS.reports = async (el) => {
  const hos = await q('SELECT id, name, unit FROM homeowners ORDER BY name COLLATE NOCASE');
  const hoOpts = hos.map((h) => `<option value="${h.id}">${esc(h.name)}${h.unit ? ' – ' + esc(h.unit) : ''}</option>`).join('');
  const t = today();
  el.innerHTML = `
    <div class="page-head"><div><h1>Print &amp; Export</h1>
      <div class="sub">Print opens the print window — choose your printer, or <b>“Save as PDF”</b> / <b>“Microsoft Print to PDF”</b> to download a PDF.</div></div></div>
    <div class="grid-2">
      <div class="card"><h2>Punchlist Form (per homeowner)</h2>
        <label class="field"><span>Homeowner</span><select id="r-ho1">${hoOpts}</select></label>
        <label class="field"><span>Items</span><select id="r-items"><option value="all">All items</option><option value="open">Open items only</option></select></label>
        <button class="btn primary" data-act="printPunchForm" data-from="r-ho1" ${hos.length ? '' : 'disabled'}>Print / Save PDF</button></div>
      <div class="card"><h2>Blank Punchlist Form</h2>
        <p class="muted">An empty form to fill in by hand during the walkthrough.</p>
        <label class="field"><span>Number of rows</span><input id="r-blank" type="number" min="5" max="40" value="20"></label>
        <button class="btn primary" data-act="printBlank">Print / Save PDF</button></div>
      <div class="card"><h2>Repair Status Report</h2>
        <label class="field"><span>Include</span><select id="r-rep"><option value="open">Not done (overdue listed first)</option>
          <option value="overdue">Past target date only</option><option value="all">All repairs</option></select></label>
        <button class="btn primary" data-act="printRepairs" data-from="r-rep">Print / Save PDF</button></div>
      <div class="card"><h2>Acceptance Summary (per homeowner)</h2>
        <p class="muted">Shows whether all items are fixed and the acceptance schedule.</p>
        <label class="field"><span>Homeowner</span><select id="r-ho2">${hoOpts}</select></label>
        <button class="btn primary" data-act="printAcceptance" data-from="r-ho2" ${hos.length ? '' : 'disabled'}>Print / Save PDF</button></div>
      <div class="card"><h2>Schedule List</h2>
        <div class="row2"><label class="field"><span>From</span><input id="r-from" type="date" value="${t}"></label>
          <label class="field"><span>To</span><input id="r-to" type="date" value="${addDays(t, 30)}"></label></div>
        <button class="btn primary" data-act="printSchedules" data-from="range">Print / Save PDF</button></div>
      <div class="card"><h2>Export to Excel</h2>
        <p class="muted">Downloads a .xlsx file you can open in Excel or Google Sheets.</p>
        <div class="actions">
          <button class="btn" data-act="exportHo">Homeowners</button>
          <button class="btn" data-act="exportSched">Schedules</button>
          <button class="btn" data-act="exportPunch">Punchlist items</button>
          <button class="btn" data-act="exportRep">Repairs</button></div></div>
    </div>`;
};

// ================= VIEW: settings =================
VIEWS.settings = async (el) => {
  const info = await invoke('app_info');
  el.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="grid-2">
      <div class="card"><h2>Company &amp; defaults</h2>
        <form id="settings-form">
          <label class="field"><span>Company name (shown on printouts)</span><input name="company_name" value="${esc(settings.company_name)}"></label>
          <label class="field"><span>Company address / contact (printouts)</span><input name="company_address" value="${esc(settings.company_address)}"></label>
          <div class="row3">
            <label class="field"><span>Default repair days</span><input name="default_repair_days" type="number" min="1" value="${esc(settings.default_repair_days)}"></label>
            <label class="field"><span>Default schedule length (min)</span><input name="default_duration" type="number" min="15" step="15" value="${esc(settings.default_duration)}"></label>
            <label class="field"><span>Google Calendar time zone</span><input name="timezone" value="${esc(settings.timezone)}"></label>
          </div>
          <p class="muted small">Default repair days sets the target date automatically when you create a repair (you can still change it).</p>
          <button class="btn primary" type="submit">Save settings</button>
        </form></div>
      <div class="card"><h2>Data &amp; backup</h2>
        <p>Your data is saved automatically in:</p>
        <p><code>${esc(info.dataDir)}</code></p>
        <p class="muted small">Keep this folder together with the app when you copy it to another PC or USB drive.</p>
        <div class="actions">
          <button class="btn primary" data-act="backup">Back up now</button>
          <button class="btn" data-act="openData">Open data folder</button></div>
        <p class="muted small" style="margin-top:14px">Version ${esc(info.version)}</p></div>
    </div>`;
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    for (const [k, v] of Object.entries(d)) {
      await ex('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);
    }
    await loadSettings();
    toast('Settings saved');
  });
};

// ================= forms: homeowner =================
async function editHomeowner(id) {
  const h = id ? await one('SELECT * FROM homeowners WHERE id = ?', [id]) : {};
  const res = await openModal({
    title: id ? 'Edit Homeowner' : 'Add Homeowner',
    body: `
      <label class="field"><span>Full name *</span><input name="name" value="${esc(h.name)}" required></label>
      <div class="row2">
        <label class="field"><span>Unit / Address (e.g. Blk 5 Lot 12)</span><input name="unit" value="${esc(h.unit)}"></label>
        <label class="field"><span>Project / Phase</span><input name="project" value="${esc(h.project)}"></label></div>
      <div class="row2">
        <label class="field"><span>Contact number</span><input name="phone" value="${esc(h.phone)}"></label>
        <label class="field"><span>Email</span><input name="email" type="email" value="${esc(h.email)}"></label></div>
      <label class="field"><span>Notes</span><textarea name="notes">${esc(h.notes)}</textarea></label>`,
    onOk: async (form) => {
      const d = formData(form);
      if (!d.name) throw new Error('Name is required');
      const vals = [d.name, nz(d.unit), nz(d.project), nz(d.phone), nz(d.email), nz(d.notes)];
      if (id) {
        await ex('UPDATE homeowners SET name=?, unit=?, project=?, phone=?, email=?, notes=? WHERE id=?', [...vals, id]);
        return id;
      }
      const r = await ex('INSERT INTO homeowners (name, unit, project, phone, email, notes) VALUES (?,?,?,?,?,?)', vals);
      return r.lastId;
    },
  });
  if (res) { toast('Homeowner saved'); go('homeowner', { homeownerId: res }); }
}

// ================= forms: schedule =================
function timesOverlap(a, b) {
  if (!a.start_time || !b.start_time) return false;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const a1 = toMin(a.start_time), a2 = a1 + (Number(a.duration_min) || 60);
  const b1 = toMin(b.start_time), b2 = b1 + (Number(b.duration_min) || 60);
  return a1 < b2 && b1 < a2;
}

async function editSchedule(id, presetHid) {
  const s = id ? await one('SELECT * FROM schedules WHERE id = ?', [id]) : null;
  const hos = await q('SELECT id, name, unit FROM homeowners ORDER BY name COLLATE NOCASE');
  if (!hos.length) { toast('Add a homeowner first', 'err'); return; }
  const cur = s || { homeowner_id: presetHid || '', kind: 'Punchlist Inspection', date: today(), start_time: '09:00',
    duration_min: settings.default_duration || 60, status: 'Scheduled', notes: '' };

  const res = await openModal({
    title: id ? 'Edit Schedule' : 'Add Schedule',
    body: `
      <label class="field"><span>Homeowner *</span><select name="homeowner_id"><option value="">— choose —</option>
        ${hos.map((h) => `<option value="${h.id}" ${String(h.id) === String(cur.homeowner_id) ? 'selected' : ''}>${esc(h.name)}${h.unit ? ' – ' + esc(h.unit) : ''}</option>`).join('')}</select></label>
      <div class="row2">
        <label class="field"><span>Type *</span><select name="kind">${opts(KINDS, cur.kind)}</select></label>
        <label class="field"><span>Status</span><select name="status">${opts(SCHED_STATUS, cur.status)}</select></label></div>
      <div class="row3">
        <label class="field"><span>Date *</span><input type="date" name="date" value="${esc(cur.date)}"></label>
        <label class="field"><span>Time (blank = whole day)</span><input type="time" name="start_time" value="${esc(cur.start_time)}"></label>
        <label class="field"><span>Length (minutes)</span><input type="number" name="duration_min" min="15" step="15" value="${esc(cur.duration_min)}"></label></div>
      <label class="field"><span>Notes</span><textarea name="notes">${esc(cur.notes)}</textarea></label>`,
    onOk: async (form) => {
      const d = formData(form);
      if (!d.homeowner_id) throw new Error('Please choose a homeowner');
      if (!d.date) throw new Error('Please enter a date');
      const hid = Number(d.homeowner_id);
      d.duration_min = Number(d.duration_min) || 60;

      // ---- warnings (user can still save) ----
      const warnings = [];
      if (d.status === 'Scheduled') {
        const sameDay = await q(SCHED_SELECT + ` WHERE s.date = ? AND s.status = 'Scheduled' AND s.id != ?`, [d.date, id || 0]);
        const clash = sameDay.filter((o) => timesOverlap(d, o));
        if (clash.length) {
          warnings.push(`<b>Time conflict</b> with: <ul>${clash.map((c) =>
            `<li>${esc(c.kind)} – ${esc(c.name)} at ${fmtTime(c.start_time)}</li>`).join('')}</ul>`);
        }
        if (d.date < today()) warnings.push('This date is <b>in the past</b>.');
      }
      if (d.kind === 'Acceptance' && d.status === 'Scheduled') {
        const n = await openItemCount(hid);
        if (n > 0) {
          warnings.push(`This homeowner still has <b>${plural(n, 'open punchlist / repair item')}</b>.
            Acceptance is usually set after all items are fixed.`);
        }
      }
      if (warnings.length) {
        const ok = await confirmBox(warnings.map((w) => `<p>⚠️ ${w}</p>`).join('') + '<p>Save anyway?</p>',
          'Save anyway', 'Warning');
        if (!ok) return false;
      }

      const changedWhen = s && (s.date !== d.date || (s.start_time || '') !== (d.start_time || '')
        || Number(s.duration_min) !== d.duration_min || s.kind !== d.kind || Number(s.homeowner_id) !== hid);
      let gcal = s ? s.gcal_added : 0;
      let note = s ? '' : 'new';
      if (s && s.gcal_added && changedWhen && d.status !== 'Cancelled') { gcal = 0; note = 'moved'; }
      if (s && s.gcal_added && d.status === 'Cancelled' && s.status !== 'Cancelled') note = 'cancelled';

      const vals = [hid, d.kind, d.date, nz(d.start_time), d.duration_min, d.status, nz(d.notes), gcal];
      let sid = id;
      if (id) {
        await ex(`UPDATE schedules SET homeowner_id=?, kind=?, date=?, start_time=?, duration_min=?, status=?, notes=?, gcal_added=? WHERE id=?`, [...vals, id]);
      } else {
        const r = await ex(`INSERT INTO schedules (homeowner_id, kind, date, start_time, duration_min, status, notes, gcal_added) VALUES (?,?,?,?,?,?,?,?)`, vals);
        sid = r.lastId;
      }
      return { sid, note, status: d.status };
    },
  });
  if (!res) return;
  toast('Schedule saved');
  await render();
  if (res.note === 'new' && res.status === 'Scheduled') {
    const go2 = await confirmBox('<p>Add this schedule to Google Calendar now?</p>', 'Add to Google Calendar', 'Google Calendar');
    if (go2) await addToGcal(res.sid);
  } else if (res.note === 'moved') {
    const go2 = await confirmBox(`<p>You changed the date/time of a schedule that was already in Google Calendar.</p>
      <p>1. Open Google Calendar and <b>delete the old event</b>.<br>2. Then add the new one.</p>`,
    'Add new event to Google Calendar', 'Update Google Calendar');
    if (go2) await addToGcal(res.sid);
  } else if (res.note === 'cancelled') {
    await openModal({ title: 'Google Calendar', body: '<p>This schedule was in Google Calendar. Please <b>delete the event</b> there too.</p>', okText: 'OK', cancelText: '' });
  }
}

// ================= forms: punchlist =================
function punchRowHtml() {
  return `<tr>
    <td><input name="area[]" list="areas" placeholder="Area / room"></td>
    <td><input name="defect[]" placeholder="Defect / item to fix"></td>
    <td><select name="category[]">${opts(CATEGORIES, '')}</select></td>
    <td><select name="severity[]">${opts(SEVERITY, 'Minor')}</select></td>
    <td><input name="pnotes[]" placeholder="Notes"></td>
    <td><button type="button" class="btn small ghost" data-rowdel title="Remove row">✕</button></td></tr>`;
}

async function recordPunchlist(presetHid) {
  const hos = await q('SELECT id, name, unit FROM homeowners ORDER BY name COLLATE NOCASE');
  if (!hos.length) { toast('Add a homeowner first', 'err'); return; }
  const people = await q(`SELECT DISTINCT assigned_to AS a FROM repairs WHERE IFNULL(assigned_to,'') != '' ORDER BY a COLLATE NOCASE`);
  const t = today();
  const res = await openModal({
    title: 'Record Punchlist',
    wide: true,
    okText: 'Save punchlist',
    body: `
      <datalist id="areas">${AREAS.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
      <datalist id="people">${people.map((p) => `<option value="${esc(p.a)}">`).join('')}</datalist>
      <div class="row2">
        <label class="field"><span>Homeowner *</span><select name="homeowner_id"><option value="">— choose —</option>
          ${hos.map((h) => `<option value="${h.id}" ${String(h.id) === String(presetHid) ? 'selected' : ''}>${esc(h.name)}${h.unit ? ' – ' + esc(h.unit) : ''}</option>`).join('')}</select></label>
        <label class="field"><span>Inspection date</span><input type="date" name="recorded_date" value="${t}"></label></div>
      <table class="entry"><thead><tr><th style="width:17%">Area</th><th>Defect / item *</th><th style="width:15%">Category</th>
        <th style="width:10%">Severity</th><th style="width:20%">Notes</th><th></th></tr></thead>
        <tbody id="punch-rows">${punchRowHtml().repeat(5)}</tbody></table>
      <button type="button" class="btn small" id="add-row" style="margin-top:6px">+ Add row</button>
      <div class="card" style="margin-top:14px; background:#f8fafc">
        <label class="check"><input type="checkbox" name="make_repairs" checked> Also create a repair for each item (so it can be tracked and flagged)</label>
        <div class="row2">
          <label class="field"><span>Assigned to</span><input name="assigned_to" list="people" placeholder="Contractor / worker"></label>
          <label class="field"><span>Target date *</span><input type="date" name="target_date" value="${addDays(t, Number(settings.default_repair_days) || 14)}"></label></div>
      </div>`,
    onOpen: (form) => {
      const body = form.querySelector('#punch-rows');
      form.querySelector('#add-row').addEventListener('click', () => {
        body.insertAdjacentHTML('beforeend', punchRowHtml());
        body.lastElementChild.querySelector('input').focus();
      });
      body.addEventListener('click', (e) => {
        if (e.target.matches('[data-rowdel]') && body.children.length > 1) e.target.closest('tr').remove();
      });
    },
    onOk: async (form) => {
      const d = formData(form);
      const fd = new FormData(form);
      if (!d.homeowner_id) throw new Error('Please choose a homeowner');
      const areas = fd.getAll('area[]'), defects = fd.getAll('defect[]'), cats = fd.getAll('category[]'),
        sevs = fd.getAll('severity[]'), notes = fd.getAll('pnotes[]');
      const items = defects.map((def, i) => ({ area: areas[i], defect: String(def).trim(), category: cats[i], severity: sevs[i], notes: notes[i] }))
        .filter((x) => x.defect);
      if (!items.length) throw new Error('Enter at least one defect / item');
      const makeRep = fd.get('make_repairs') === 'on';
      if (makeRep && !d.target_date) throw new Error('Please set a target date for the repairs');
      const hid = Number(d.homeowner_id);
      const rdate = d.recorded_date || today();
      for (const it of items) {
        const r = await ex(`INSERT INTO punch_items (homeowner_id, recorded_date, area, defect, category, severity, notes, status)
          VALUES (?,?,?,?,?,?,?, 'Open')`, [hid, rdate, nz(it.area), it.defect, nz(it.category), it.severity, nz(it.notes)]);
        if (makeRep) {
          await ex(`INSERT INTO repairs (homeowner_id, punch_item_id, description, assigned_to, date_started, target_date, status)
            VALUES (?,?,?,?,?,?, 'Open')`, [hid, r.lastId, it.defect, nz(d.assigned_to), rdate, d.target_date]);
        }
      }
      return { hid, n: items.length };
    },
  });
  if (res) { toast(`${plural(res.n, 'item')} saved`); go('homeowner', { homeownerId: res.hid }); }
}

async function editPunchItem(id) {
  const p = await one('SELECT * FROM punch_items WHERE id = ?', [id]);
  if (!p) return;
  const res = await openModal({
    title: 'Edit Punchlist Item',
    body: `
      <datalist id="areas">${AREAS.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
      <div class="row2">
        <label class="field"><span>Area</span><input name="area" list="areas" value="${esc(p.area)}"></label>
        <label class="field"><span>Inspection date</span><input type="date" name="recorded_date" value="${esc(p.recorded_date)}"></label></div>
      <label class="field"><span>Defect / item *</span><input name="defect" value="${esc(p.defect)}"></label>
      <div class="row3">
        <label class="field"><span>Category</span><select name="category">${opts(CATEGORIES, p.category)}</select></label>
        <label class="field"><span>Severity</span><select name="severity">${opts(SEVERITY, p.severity)}</select></label>
        <label class="field"><span>Status</span><select name="status">${opts(PUNCH_STATUS, p.status)}</select></label></div>
      <label class="field"><span>Notes</span><textarea name="notes">${esc(p.notes)}</textarea></label>`,
    onOk: async (form) => {
      const d = formData(form);
      if (!d.defect) throw new Error('Defect is required');
      await ex('UPDATE punch_items SET area=?, recorded_date=?, defect=?, category=?, severity=?, status=?, notes=? WHERE id=?',
        [nz(d.area), nz(d.recorded_date), d.defect, nz(d.category), d.severity, d.status, nz(d.notes), id]);
      return true;
    },
  });
  if (res) { toast('Item saved'); render(); }
}

// ================= forms: repair =================
async function editRepair(id, { hid, punchId } = {}) {
  let r;
  if (id) r = await one('SELECT * FROM repairs WHERE id = ?', [id]);
  else {
    let desc = '';
    if (punchId) {
      const p = await one('SELECT * FROM punch_items WHERE id = ?', [punchId]);
      if (p) { desc = p.defect; hid = p.homeowner_id; }
    }
    r = { homeowner_id: hid || '', punch_item_id: punchId || null, description: desc, assigned_to: '',
      date_started: today(), target_date: addDays(today(), Number(settings.default_repair_days) || 14), status: 'Open', date_done: '', notes: '' };
  }
  const hos = await q('SELECT id, name, unit FROM homeowners ORDER BY name COLLATE NOCASE');
  if (!hos.length) { toast('Add a homeowner first', 'err'); return; }
  const people = await q(`SELECT DISTINCT assigned_to AS a FROM repairs WHERE IFNULL(assigned_to,'') != '' ORDER BY a COLLATE NOCASE`);
  const res = await openModal({
    title: id ? 'Edit Repair' : 'Add Repair',
    body: `
      <datalist id="people">${people.map((p) => `<option value="${esc(p.a)}">`).join('')}</datalist>
      <label class="field"><span>Homeowner *</span><select name="homeowner_id" ${r.punch_item_id ? 'disabled' : ''}><option value="">— choose —</option>
        ${hos.map((h) => `<option value="${h.id}" ${String(h.id) === String(r.homeowner_id) ? 'selected' : ''}>${esc(h.name)}${h.unit ? ' – ' + esc(h.unit) : ''}</option>`).join('')}</select></label>
      <label class="field"><span>Repair description *</span><input name="description" value="${esc(r.description)}"></label>
      <div class="row2">
        <label class="field"><span>Assigned to</span><input name="assigned_to" list="people" value="${esc(r.assigned_to)}"></label>
        <label class="field"><span>Status</span><select name="status">${opts(REPAIR_STATUS, r.status)}</select></label></div>
      <div class="row3">
        <label class="field"><span>Date started</span><input type="date" name="date_started" value="${esc(r.date_started)}"></label>
        <label class="field"><span>Target date *</span><input type="date" name="target_date" value="${esc(r.target_date)}"></label>
        <label class="field"><span>Date done</span><input type="date" name="date_done" value="${esc(r.date_done)}"></label></div>
      <label class="field"><span>Notes</span><textarea name="notes">${esc(r.notes)}</textarea></label>`,
    onOk: async (form) => {
      const d = formData(form);
      const homeowner = r.punch_item_id ? Number(r.homeowner_id) : Number(d.homeowner_id);
      if (!homeowner) throw new Error('Please choose a homeowner');
      if (!d.description) throw new Error('Description is required');
      if (!d.target_date) throw new Error('Target date is required (used for the overdue flag)');
      const done = d.status === 'Done' ? (d.date_done || today()) : null;
      const vals = [homeowner, d.description, nz(d.assigned_to), nz(d.date_started), d.target_date, d.status, done, nz(d.notes)];
      if (id) {
        await ex('UPDATE repairs SET homeowner_id=?, description=?, assigned_to=?, date_started=?, target_date=?, status=?, date_done=?, notes=? WHERE id=?', [...vals, id]);
      } else {
        await ex('INSERT INTO repairs (homeowner_id, description, assigned_to, date_started, target_date, status, date_done, notes, punch_item_id) VALUES (?,?,?,?,?,?,?,?,?)',
          [...vals, r.punch_item_id || null]);
      }
      if (r.punch_item_id) await syncPunchFromRepair(r.punch_item_id, d.status);
      return true;
    },
  });
  if (res) { toast('Repair saved'); render(); }
}

async function syncPunchFromRepair(punchId, repStatus) {
  if (repStatus === 'Done') await ex(`UPDATE punch_items SET status = 'Fixed' WHERE id = ?`, [punchId]);
  else await ex(`UPDATE punch_items SET status = 'Open' WHERE id = ? AND status = 'Fixed'`, [punchId]);
}

async function markRepairDone(id) {
  const r = await one('SELECT * FROM repairs WHERE id = ?', [id]);
  if (!r) return;
  await ex(`UPDATE repairs SET status = 'Done', date_done = ? WHERE id = ?`, [today(), id]);
  if (r.punch_item_id) await syncPunchFromRepair(r.punch_item_id, 'Done');
  toast('Repair marked as done');
  render();
}

// ================= printing =================
function docHeader(title) {
  return `<div class="doc-head"><div><div class="doc-company">${esc(settings.company_name || 'Punchlist Manager')}</div>
      ${settings.company_address ? `<div class="doc-addr">${esc(settings.company_address)}</div>` : ''}</div>
    <div><div class="doc-title">${esc(title)}</div><div class="doc-date">Printed ${esc(nowStamp())}</div></div></div>`;
}

function printDoc(html) {
  const area = $('#print-area');
  area.innerHTML = `<div class="doc">${html}</div>`;
  const done = () => { area.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 60);
}

function hoInfoBlock(h, extra = '') {
  return `<div class="doc-info">
    <div><b>Homeowner:</b> ${esc(h.name)}</div><div><b>Unit / Address:</b> ${esc(h.unit)}</div>
    <div><b>Project:</b> ${esc(h.project)}</div><div><b>Contact:</b> ${esc(h.phone)}${h.email ? ' · ' + esc(h.email) : ''}</div>
    ${extra}</div>`;
}

async function printPunchForm(hid, which = 'all') {
  const h = await one('SELECT * FROM homeowners WHERE id = ?', [hid]);
  if (!h) return;
  const items = await q(PUNCH_SELECT + ` WHERE p.homeowner_id = ? ${which === 'open' ? `AND p.status = 'Open'` : ''} ORDER BY p.recorded_date, p.id`, [hid]);
  const insp = await one(`SELECT date FROM schedules WHERE homeowner_id = ? AND kind IN ('Punchlist Inspection','Re-inspection') ORDER BY date DESC LIMIT 1`, [hid]);
  const acc = await one(`SELECT date, start_time FROM schedules WHERE homeowner_id = ? AND kind = 'Acceptance' AND status = 'Scheduled' ORDER BY date LIMIT 1`, [hid]);
  printDoc(`${docHeader('Punchlist Form')}
    ${hoInfoBlock(h, `<div><b>Inspection date:</b> ${items.length ? fmtDate(items.map((p) => p.recorded_date || '').sort().pop()) : (insp ? fmtDate(insp.date) : '')}</div>
      <div><b>Acceptance schedule:</b> ${acc ? fmtDate(acc.date) + ' ' + fmtTime(acc.start_time) : '—'}</div>`)}
    <table><thead><tr><th style="width:4%">#</th><th style="width:14%">Area</th><th>Defect / Item</th><th style="width:13%">Category</th>
      <th style="width:8%">Severity</th><th style="width:9%">Status</th><th style="width:12%">Repair target</th><th style="width:15%">Remarks</th></tr></thead><tbody>
      ${items.length ? items.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.area)}</td><td>${esc(p.defect)}${p.notes ? `<br><i>${esc(p.notes)}</i>` : ''}</td>
        <td>${esc(p.category)}</td><td>${esc(p.severity)}</td><td>${esc(p.status)}</td>
        <td class="${p.repair_status !== 'Done' && p.repair_target && p.repair_target < today() ? 'overdue-cell' : ''}">${fmtDate(p.repair_target)}</td><td></td></tr>`).join('')
        : '<tr><td colspan="8">No items.</td></tr>'}
    </tbody></table>
    <div class="summary">Total items: <b>${items.length}</b> · Open: <b>${items.filter((p) => p.status === 'Open').length}</b> · Fixed: <b>${items.filter((p) => p.status === 'Fixed').length}</b></div>`);
}

function printBlank(rows) {
  const n = Math.min(Math.max(Number(rows) || 20, 5), 40);
  printDoc(`${docHeader('Punchlist Form')}
    <div class="doc-info">
      <div><b>Homeowner:</b> <span class="fill"></span></div><div><b>Unit / Address:</b> <span class="fill"></span></div>
      <div><b>Project:</b> <span class="fill"></span></div><div><b>Contact:</b> <span class="fill"></span></div>
      <div><b>Inspection date:</b> <span class="fill"></span></div><div><b>Inspected by:</b> <span class="fill"></span></div></div>
    <table><thead><tr><th style="width:4%">#</th><th style="width:16%">Area</th><th>Defect / Item</th><th style="width:14%">Category</th>
      <th style="width:9%">Severity</th><th style="width:18%">Remarks</th></tr></thead><tbody>
      ${Array.from({ length: n }, (_, i) => `<tr class="blank-row"><td>${i + 1}</td><td></td><td></td><td></td><td></td><td></td></tr>`).join('')}
    </tbody></table>`);
}

async function printRepairs(which) {
  const filter = which || state.repFilter;
  const saved = state.repFilter;
  state.repFilter = filter === 'all' ? 'all' : filter;
  const { where, params } = repairWhere();
  state.repFilter = saved;
  const rows = await q(`${REPAIR_SELECT} ${where}
    ORDER BY (r.status = 'Done'), (CASE WHEN r.status != 'Done' AND r.target_date < '${today()}' THEN 0 ELSE 1 END), r.target_date, h.name`, params);
  const overdue = rows.filter(isOverdue).length;
  const label = { open: 'Not done', overdue: 'Past target date', done: 'Done', all: 'All repairs' }[filter] || '';
  printDoc(`${docHeader('Repair Status Report')}
    <div class="summary">Showing: <b>${label}</b>${state.repAssigned && !which ? ` · Assigned to: <b>${esc(state.repAssigned)}</b>` : ''} ·
      Total: <b>${rows.length}</b> · Past target date: <b>${overdue}</b></div>
    <table><thead><tr><th style="width:11%">Flag</th><th style="width:15%">Homeowner / Unit</th><th style="width:10%">Area</th><th>Repair</th>
      <th style="width:12%">Assigned</th><th style="width:10%">Started</th><th style="width:10%">Target</th><th style="width:10%">Status</th></tr></thead><tbody>
      ${rows.length ? rows.map((r) => {
        const od = isOverdue(r);
        return `<tr><td class="${od ? 'overdue-cell' : ''}">${od ? `OVERDUE<br>${plural(daysBetween(r.target_date, today()), 'day')} late` : ''}</td>
          <td>${esc(r.name)}<br>${esc(r.unit)}</td><td>${esc(r.area)}</td><td>${esc(r.description)}</td><td>${esc(r.assigned_to)}</td>
          <td>${fmtDate(r.date_started)}</td><td class="${od ? 'overdue-cell' : ''}">${fmtDate(r.target_date)}</td>
          <td>${esc(r.status)}${r.date_done ? `<br>${fmtDate(r.date_done)}` : ''}</td></tr>`;
      }).join('') : '<tr><td colspan="8">No repairs.</td></tr>'}
    </tbody></table>`);
}

async function printAcceptance(hid) {
  const h = await one('SELECT * FROM homeowners WHERE id = ?', [hid]);
  if (!h) return;
  const items = await q(PUNCH_SELECT + ' WHERE p.homeowner_id = ? ORDER BY p.recorded_date, p.id', [hid]);
  const extraReps = await q(`SELECT * FROM repairs WHERE homeowner_id = ? AND punch_item_id IS NULL ORDER BY target_date`, [hid]);
  const repDone = await q(`SELECT punch_item_id, MAX(date_done) AS d FROM repairs WHERE homeowner_id = ? AND punch_item_id IS NOT NULL GROUP BY punch_item_id`, [hid]);
  const doneMap = Object.fromEntries(repDone.map((r) => [r.punch_item_id, r.d]));
  const scheds = await q(`SELECT * FROM schedules WHERE homeowner_id = ? ORDER BY date, start_time`, [hid]);
  const acc = scheds.filter((s) => s.kind === 'Acceptance' && s.status !== 'Cancelled').pop();
  const openN = await openItemCount(hid);
  printDoc(`${docHeader('Acceptance Summary')}
    ${hoInfoBlock(h, `<div><b>Acceptance schedule:</b> ${acc ? `${fmtDate(acc.date)} ${fmtTime(acc.start_time)} (${esc(acc.status)})` : '—'}</div><div></div>`)}
    <div class="status-box">${openN ? `NOT YET READY — ${plural(openN, 'item')} still open`
      : (items.length || extraReps.length ? 'READY FOR ACCEPTANCE — all items fixed' : 'NO PUNCHLIST ITEMS RECORDED YET')}</div>
    <h3>Punchlist items</h3>
    <table><thead><tr><th style="width:4%">#</th><th style="width:15%">Area</th><th>Defect / Item</th><th style="width:12%">Recorded</th>
      <th style="width:11%">Status</th><th style="width:13%">Date fixed</th></tr></thead><tbody>
      ${items.length ? items.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.area)}</td><td>${esc(p.defect)}</td><td>${fmtDate(p.recorded_date)}</td>
        <td>${esc(p.status)}</td><td>${fmtDate(doneMap[p.id])}</td></tr>`).join('') : '<tr><td colspan="6">No items recorded.</td></tr>'}
    </tbody></table>
    ${extraReps.length ? `<h3>Other repairs</h3><table><thead><tr><th>Repair</th><th style="width:14%">Target</th><th style="width:12%">Status</th><th style="width:14%">Date done</th></tr></thead><tbody>
      ${extraReps.map((r) => `<tr><td>${esc(r.description)}</td><td>${fmtDate(r.target_date)}</td><td>${esc(r.status)}</td><td>${fmtDate(r.date_done)}</td></tr>`).join('')}</tbody></table>` : ''}
    <h3>Schedule history</h3>
    <table><thead><tr><th style="width:18%">Date</th><th style="width:12%">Time</th><th>Type</th><th style="width:15%">Status</th></tr></thead><tbody>
      ${scheds.length ? scheds.map((s) => `<tr><td>${fmtDate(s.date)}</td><td>${fmtTime(s.start_time)}</td><td>${esc(s.kind)}</td><td>${esc(s.status)}</td></tr>`).join('') : '<tr><td colspan="4">None</td></tr>'}
    </tbody></table>`);
}

async function printSchedules(from, to) {
  let rows, label;
  if (from && to) {
    rows = await q(SCHED_SELECT + ' WHERE s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time', [from, to]);
    label = `${fmtDate(from)} to ${fmtDate(to)}`;
  } else {
    rows = await q(SCHED_SELECT + ` WHERE s.status = 'Scheduled' AND s.date >= ? ORDER BY s.date, s.start_time`, [today()]);
    label = 'Upcoming';
  }
  printDoc(`${docHeader('Schedule List')}
    <div class="summary">${esc(label)} · ${plural(rows.length, 'schedule')}</div>
    <table><thead><tr><th style="width:14%">Date</th><th style="width:10%">Time</th><th style="width:16%">Type</th><th>Homeowner</th>
      <th style="width:18%">Unit / Address</th><th style="width:12%">Contact</th><th style="width:10%">Status</th></tr></thead><tbody>
      ${rows.length ? rows.map((s) => `<tr><td>${fmtDate(s.date)}</td><td>${fmtTime(s.start_time)}</td><td>${esc(s.kind)}</td><td>${esc(s.name)}</td>
        <td>${esc(s.unit)}</td><td>${esc(s.phone)}</td><td>${esc(s.status)}</td></tr>`).join('') : '<tr><td colspan="7">No schedules.</td></tr>'}
    </tbody></table>`);
}

// ================= Excel exports =================
async function exportXlsx(name, sheet, headers, rows) {
  const path = await invoke('export_xlsx', { defaultName: `${name} ${today()}.xlsx`, sheetName: sheet, headers, rows });
  if (path) toast('Saved: ' + path);
}

const EXPORTS = {
  exportHo: async () => {
    const r = await q(`SELECT h.*, ${OPEN_ITEMS_EXPR} AS open_n FROM homeowners h ORDER BY h.name COLLATE NOCASE`);
    await exportXlsx('Homeowners', 'Homeowners', ['Name', 'Unit / Address', 'Project', 'Contact', 'Email', 'Open items', 'Notes'],
      r.map((h) => [h.name, h.unit, h.project, h.phone, h.email, h.open_n, h.notes]));
  },
  exportSched: async () => {
    const r = await q(SCHED_SELECT + ' ORDER BY s.date, s.start_time');
    await exportXlsx('Schedules', 'Schedules', ['Date', 'Time', 'Type', 'Homeowner', 'Unit / Address', 'Contact', 'Status', 'In Google Calendar', 'Notes'],
      r.map((s) => [s.date, fmtTime(s.start_time), s.kind, s.name, s.unit, s.phone, s.status, s.gcal_added ? 'Yes' : 'No', s.notes]));
  },
  exportPunch: async () => {
    const r = await q(PUNCH_SELECT + ' ORDER BY h.name, p.recorded_date, p.id');
    await exportXlsx('Punchlist', 'Punchlist', ['Recorded', 'Homeowner', 'Unit / Address', 'Area', 'Defect / Item', 'Category', 'Severity', 'Status', 'Repair status', 'Repair target', 'Notes'],
      r.map((p) => [p.recorded_date, p.name, p.unit, p.area, p.defect, p.category, p.severity, p.status, p.repair_status, p.repair_target, p.notes]));
  },
  exportRep: async () => {
    const r = await q(REPAIR_SELECT + ` ORDER BY (r.status = 'Done'), r.target_date`);
    await exportXlsx('Repairs', 'Repairs', ['Overdue', 'Days late', 'Homeowner', 'Unit / Address', 'Area', 'Repair', 'Assigned to', 'Started', 'Target date', 'Status', 'Date done', 'Notes'],
      r.map((x) => [isOverdue(x) ? 'OVERDUE' : '', isOverdue(x) ? daysBetween(x.target_date, today()) : null, x.name, x.unit, x.area, x.description,
        x.assigned_to, x.date_started, x.target_date, x.status, x.date_done, x.notes]));
  },
};

// ================= click actions =================
const ACTIONS = {
  nav: (d) => {
    const extra = {};
    if (d.view === 'repairs' && d.filter) extra.repFilter = d.filter;
    if (d.view === 'schedules') extra.schedFilter = d.filter || 'upcoming';
    go(d.view, extra);
  },
  openHo: (d) => go('homeowner', { homeownerId: Number(d.id) }),
  newHo: () => editHomeowner(null),
  editHo: (d) => editHomeowner(Number(d.id)),
  delHo: async (d) => {
    const h = await one('SELECT name FROM homeowners WHERE id = ?', [Number(d.id)]);
    const ok = await confirmBox(`<p>Delete <b>${esc(h.name)}</b> and all their schedules, punchlist items and repairs?</p><p>This cannot be undone.</p>`, 'Delete', 'Delete homeowner', true);
    if (ok) { await ex('DELETE FROM homeowners WHERE id = ?', [Number(d.id)]); toast('Homeowner deleted'); go('homeowners'); }
  },
  newSched: (d) => editSchedule(null, d.hid ? Number(d.hid) : null),
  editSched: (d) => editSchedule(Number(d.id)),
  delSched: async (d) => {
    const s = await one('SELECT gcal_added FROM schedules WHERE id = ?', [Number(d.id)]);
    const ok = await confirmBox(`<p>Delete this schedule?</p>${s && s.gcal_added ? '<p>It is in Google Calendar — remember to delete it there too.</p>' : ''}`, 'Delete', 'Delete schedule', true);
    if (ok) { await ex('DELETE FROM schedules WHERE id = ?', [Number(d.id)]); toast('Schedule deleted'); render(); }
  },
  gcal: (d) => addToGcal(Number(d.id)),
  recordPunch: (d) => recordPunchlist(d.hid ? Number(d.hid) : null),
  editPunch: (d) => editPunchItem(Number(d.id)),
  delPunch: async (d) => {
    const ok = await confirmBox('<p>Delete this punchlist item? Its linked repair (if any) will be kept but unlinked.</p>', 'Delete', 'Delete item', true);
    if (ok) { await ex('DELETE FROM punch_items WHERE id = ?', [Number(d.id)]); toast('Item deleted'); render(); }
  },
  punchToRepair: (d) => editRepair(null, { punchId: Number(d.id) }),
  newRep: (d) => editRepair(null, { hid: d.hid ? Number(d.hid) : null }),
  editRep: (d) => editRepair(Number(d.id)),
  repDone: (d) => markRepairDone(Number(d.id)),
  delRep: async (d) => {
    const ok = await confirmBox('<p>Delete this repair?</p>', 'Delete', 'Delete repair', true);
    if (ok) { await ex('DELETE FROM repairs WHERE id = ?', [Number(d.id)]); toast('Repair deleted'); render(); }
  },
  printPunchForm: (d) => {
    if (d.from) printPunchForm(Number($('#' + d.from).value), $('#r-items').value);
    else printPunchForm(Number(d.id), 'all');
  },
  printAcceptance: (d) => printAcceptance(Number(d.from ? $('#' + d.from).value : d.id)),
  printBlank: () => printBlank($('#r-blank').value),
  printRepairs: (d) => printRepairs(d.from ? $('#' + d.from).value : null),
  printSchedules: (d) => (d.from === 'range' ? printSchedules($('#r-from').value, $('#r-to').value) : printSchedules()),
  backup: async () => {
    const d = new Date();
    const name = `punchlist-backup-${ymd(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`;
    const path = await invoke('backup_db', { fileName: name });
    toast('Backup saved: ' + path);
  },
  openData: () => invoke('open_data_folder'),
  ...EXPORTS,
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  try { await fn(el.dataset, el); } catch (err) { toast(String(err && err.message ? err.message : err), 'err'); console.error(err); }
});

// ================= start =================
(async function start() {
  try {
    await loadSettings();
    await render();
  } catch (e) {
    $('#main').innerHTML = `<div class="banner red">Could not start: ${esc(e)}</div>`;
  }
})();
