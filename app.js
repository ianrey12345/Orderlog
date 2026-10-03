/* Firebase — Order Log. No prices anywhere: only product names and quantities. */
const firebaseConfig = {
  apiKey: "AIzaSyBb81pd2Nfc1LTeXU4t6B-CTjcRV5Pvzks",
  authDomain: "sym-inventoryyy.firebaseapp.com",
  projectId: "sym-inventoryyy",
  storageBucket: "sym-inventoryyy.firebasestorage.app",
  messagingSenderId: "191024177709",
  appId: "1:191024177709:web:0d7938a51f4113602acea4",
  measurementId: "G-3BTJ2XLR5M"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
db.settings({ ignoreUndefinedProperties: true });
const auth = firebase.auth();
// Second, separate Firebase connection used ONLY to check the admin password for a void,
// so the current staff login is never switched or signed out.
const verifyAuth = firebase.initializeApp(firebaseConfig, 'verify').auth();
verifyAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);

// Accounts (create both in Firebase Console → Authentication):
// admin@solymar.app and staff@solymar.app. Both have full access.
const ACCOUNT_DOMAIN = '@solymar.app';
const ROLES = { admin: { label: 'Admin' }, staff: { label: 'Staff' } };
const DEPTS = { bar: { label: 'Bar', icon: '🍹' }, kitchen: { label: 'Kitchen', icon: '🍽️' } };
const DEPT_KEYS = ['bar', 'kitchen'];
const $ = id => document.getElementById(id);

function getDateKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// orderlog/{date}/orders/{id} — one order can hold bar AND kitchen items
const ordersCol = key => db.collection('orderlog').doc(key || getDateKey()).collection('orders');
const voidsCol = key => db.collection('orderlog').doc(key || getDateKey()).collection('voids');
const productsDoc = dept => db.collection('orderlog_products').doc(dept); // { names: [...] } per department

/* ── state ── */
let role = null, editMode = false;
let currentView = 'new';
let draft = {};                 // { "bar::Mojito": { name, dept, qty } }
let deptFilter = 'all', pickerFilter = '';
let shellBuilt = false;
let todayOrders = [];
let knownProducts = { bar: [], kitchen: [] };
let unsubOrders = null, unsubVoids = null, activeDateKey = null, unsubProducts = {};
let voidsToday = [];
let modal = { key: '', qty: 1, mode: 'add' };

const makeKey = (dept, name) => dept + '::' + name;
function parseKey(key) { const i = key.indexOf('::'); return { dept: key.slice(0, i), name: key.slice(i + 2) }; }

let toastTimer;
function showToast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setView(view) {
  currentView = view; shellBuilt = false;
  $('vt-new').classList.toggle('active', view === 'new');
  $('vt-summary').classList.toggle('active', view === 'summary');
  renderMain();
}

/* ── product catalog (one combined list, each product belongs to Bar or Kitchen) ── */
function addProductToCatalog(name, dept) {
  name = name.trim(); if (!name) return;
  productsDoc(dept).set({ names: firebase.firestore.FieldValue.arrayUnion(name) }, { merge: true })
    .catch(e => showToast('❌ ' + e.message));
}
function removeProductFromCatalog(key) {
  const { dept, name } = parseKey(key);
  if (!confirm(`Remove "${name}" (${DEPTS[dept].label}) from the product list? Past orders aren't affected.`)) return;
  productsDoc(dept).set({ names: firebase.firestore.FieldValue.arrayRemove(name) }, { merge: true })
    .catch(e => showToast('❌ ' + e.message));
}
function allProducts() {
  const q = pickerFilter.toLowerCase();
  const out = [];
  DEPT_KEYS.forEach(dept => {
    if (deptFilter !== 'all' && deptFilter !== dept) return;
    (knownProducts[dept] || []).forEach(name => {
      if (name.toLowerCase().includes(q)) out.push({ name, dept, key: makeKey(dept, name) });
    });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ── quantity picker ── */
function openQty(key, qty, mode) {
  const { dept, name } = parseKey(key);
  modal = { key, qty: qty || 1, mode };
  $('qm-name').textContent = DEPTS[dept].icon + ' ' + name;
  $('qm-sub').textContent = mode === 'add' && draft[key] ? `Already in list: ${draft[key].qty} — this adds more` : 'How many?';
  $('qm-ok').textContent = mode === 'set' ? 'Update' : 'Add to list';
  paintQty();
  $('qty-modal').classList.add('show');
}
function paintQty() {
  $('qm-val').textContent = modal.qty;
  [...$('qm-quick').children].forEach(b => b.classList.toggle('sel', +b.dataset.q === modal.qty));
}
function closeQty() { $('qty-modal').classList.remove('show'); }
function confirmQty() {
  const { key, qty, mode } = modal;
  const { dept, name } = parseKey(key);
  draft[key] = { name, dept, qty: mode === 'set' ? qty : ((draft[key] && draft[key].qty) || 0) + qty };
  closeQty(); renderDraft(); renderGrid();
}

/* ── current order ── */
function removeDraftItem(key) { delete draft[key]; renderDraft(); renderGrid(); }
function clearDraft() {
  if (!Object.keys(draft).length) return;
  if (!confirm('Clear the whole list?')) return;
  draft = {}; renderDraft(); renderGrid();
}
function completeOrder() {
  const staff = $('staff-input').value.trim();
  if (!staff) { showToast('⚠️ Enter your name first'); $('staff-input').focus(); return; }
  const items = Object.values(draft).map(({ name, dept, qty }) => ({ name, dept, qty }));
  if (!items.length) { showToast('⚠️ Add at least one product'); return; }
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  $('complete-btn').disabled = true;
  ordersCol().add({ staff, items, time, createdAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(() => { draft = {}; showToast('✅ Order completed — added to summary'); renderDraft(); renderGrid(); })
    .catch(e => { showToast('❌ ' + e.message); renderDraft(); });
}
function deleteOrder(id) {
  if (!confirm('Delete this order? This cannot be undone.')) return;
  ordersCol(activeDateKey).doc(id).delete().then(() => showToast('🗑️ Order deleted')).catch(e => showToast('❌ ' + e.message));
}

/* ── realtime ── */
function subscribeOrders() {
  if (unsubOrders) unsubOrders();
  if (unsubVoids) unsubVoids();
  activeDateKey = getDateKey();
  unsubOrders = ordersCol(activeDateKey).orderBy('createdAt', 'desc').onSnapshot(snap => {
    todayOrders = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    if (currentView === 'summary') renderMain();
  }, e => showToast('❌ Sync error: ' + e.message));
  unsubVoids = voidsCol(activeDateKey).orderBy('createdAt', 'desc').onSnapshot(snap => {
    voidsToday = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    if (currentView === 'summary') renderMain();
  }, e => showToast('❌ Sync error: ' + e.message));
}
function subscribeProducts(dept) {
  if (unsubProducts[dept]) return;
  unsubProducts[dept] = productsDoc(dept).onSnapshot(snap => {
    knownProducts[dept] = ((snap.exists && snap.data().names) || []).slice().sort((a, b) => a.localeCompare(b));
    if (currentView === 'new') { renderGrid(); renderManageList(); }
  }, e => showToast('❌ Sync error: ' + e.message));
}
// If the tablet stays open past midnight, move to the new day's orders.
setInterval(() => { if (role && getDateKey() !== activeDateKey) { draft = {}; subscribeOrders(); renderMain(); } }, 60000);

/* ── render ── */
function renderMain() {
  $('topbar-date').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  if (!role) return;
  if (currentView === 'new') {
    if (!shellBuilt) buildNewShell();
    renderGrid(); renderManageList(); renderDraft();
  } else renderSummary();
}

/* New Order screen: built once so typing in the search box never loses focus */
function buildNewShell() {
  $('main').innerHTML = `
    <div class="pos">
      <div class="card">
        <h2>Products</h2>
        <div class="card-sub">Tap a product, choose the quantity, and it's added to the list.</div>
        ${editMode ? `<div class="manage-panel open">
          <div class="manage-title">✏️ Edit products</div>
          <div class="manage-add-row">
            <input type="text" id="manage-add-input" placeholder="New product name…">
            <select id="manage-add-dept"><option value="bar">🍹 Bar</option><option value="kitchen">🍽️ Kitchen</option></select>
            <button class="btn btn-ghost btn-small" id="manage-add-btn">Add</button>
          </div>
          <div class="manage-list" id="manage-list"></div>
        </div>` : ''}
        <input type="text" class="picker-search" id="picker-search" placeholder="Search products…" value="${escapeHtml(pickerFilter)}">
        <div class="filter-chips" id="filter-chips">
          <button data-f="all">All</button><button data-f="bar">🍹 Bar</button><button data-f="kitchen">🍽️ Kitchen</button>
        </div>
        <div class="product-grid" id="grid"></div>
      </div>
      <div class="card order-panel">
        <h2>Current order</h2>
        <div class="card-sub" id="draft-sub"></div>
        <div id="draft-list"></div>
        <button class="btn btn-primary" id="complete-btn">✅ Complete Order</button>
        <button class="btn btn-ghost btn-clear" id="clear-btn">Clear list</button>
      </div>
    </div>`;
  $('picker-search').addEventListener('input', e => { pickerFilter = e.target.value; renderGrid(); });
  $('filter-chips').addEventListener('click', e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    deptFilter = b.dataset.f; paintChips(); renderGrid();
  });
  if (editMode) {
    const submitAdd = () => {
      const i = $('manage-add-input');
      addProductToCatalog(i.value, $('manage-add-dept').value); i.value = '';
    };
    $('manage-add-btn').addEventListener('click', submitAdd);
    $('manage-add-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitAdd(); });
    $('manage-list').addEventListener('click', e => {
      const b = e.target.closest('[data-remove]'); if (b) removeProductFromCatalog(b.dataset.remove);
    });
  }
  $('complete-btn').addEventListener('click', completeOrder);
  $('clear-btn').addEventListener('click', clearDraft);
  $('grid').addEventListener('click', e => {
    const t = e.target.closest('[data-key]'); if (t) openQty(t.dataset.key, 1, 'add');
  });
  $('draft-list').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { e.stopPropagation(); return removeDraftItem(rm.dataset.rm); }
    const row = e.target.closest('[data-edit]'); if (row) openQty(row.dataset.edit, draft[row.dataset.edit].qty, 'set');
  });
  paintChips();
  shellBuilt = true;
}
function paintChips() {
  [...$('filter-chips').children].forEach(b => b.classList.toggle('active', b.dataset.f === deptFilter));
}

function renderGrid() {
  const el = $('grid'); if (!el) return;
  const products = allProducts();
  let html = '';
  if (!products.length) {
    const none = !(knownProducts.bar.length + knownProducts.kitchen.length);
    html = `<div class="picker-empty">${none ? 'No products yet — turn on Edit mode in the ☰ menu to add some.' : 'No products match.'}</div>`;
  }
  products.forEach(p => {
    const d = draft[p.key];
    html += `<button class="product-tile d-${p.dept}${d ? ' in-draft' : ''}" data-key="${escapeHtml(p.key)}"><span class="tile-dept">${DEPTS[p.dept].icon}</span>${escapeHtml(p.name)}${d ? `<span class="badge">${d.qty}</span>` : ''}</button>`;
  });
  el.innerHTML = html;
}
function renderManageList() {
  const el = $('manage-list'); if (!el) return;
  const items = DEPT_KEYS.flatMap(dept => (knownProducts[dept] || []).map(name => ({ dept, name, key: makeKey(dept, name) })))
    .sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = items.length
    ? items.map(p => `<span class="manage-chip">${DEPTS[p.dept].icon} ${escapeHtml(p.name)} <button data-remove="${escapeHtml(p.key)}" title="Remove">✕</button></span>`).join('')
    : `<span class="picker-empty">Nothing in the list yet.</span>`;
}
function renderDraft() {
  const el = $('draft-list'); if (!el) return;
  const rows = Object.entries(draft);
  const total = rows.reduce((s, [, v]) => s + v.qty, 0);
  $('draft-sub').textContent = rows.length ? `${rows.length} product${rows.length === 1 ? '' : 's'} · ${total} total — tap a row to change qty` : 'Nothing added yet';
  el.innerHTML = rows.length
    ? rows.map(([key, v]) => `<div class="draft-row" data-edit="${escapeHtml(key)}"><div class="draft-name">${DEPTS[v.dept].icon} ${escapeHtml(v.name)}</div><div class="draft-qty">${v.qty}</div><button class="row-remove" data-rm="${escapeHtml(key)}" title="Remove">✕</button></div>`).join('')
    : `<div class="draft-empty">Tap a product to start the order.</div>`;
  $('complete-btn').disabled = !rows.length;
}

/* ── summary: separate Bar and Kitchen, each printed on its own ── */
function aggregate(dept) {
  const ordered = {}, voided = {};
  todayOrders.forEach(o => o.items.forEach(it => { if (it.dept === dept) ordered[it.name] = (ordered[it.name] || 0) + it.qty; }));
  voidsToday.forEach(v => { if (v.dept === dept) voided[v.name] = (voided[v.name] || 0) + v.qty; });
  return Object.keys(ordered).sort((a, b) => a.localeCompare(b)).map(name => {
    const v = voided[name] || 0;
    return { name, ordered: ordered[name], voided: v, qty: Math.max(0, ordered[name] - v) };
  });
}
function renderSummary() {
  let html = '';
  DEPT_KEYS.forEach(dept => {
    const d = DEPTS[dept], rows = aggregate(dept);
    const grand = rows.reduce((s, r) => s + r.qty, 0);
    const orders = todayOrders.filter(o => o.items.some(i => i.dept === dept)).length;
    html += `<div class="card"><h2>${d.icon} ${d.label} — Summary</h2>
      <div class="card-sub">Today's ${d.label.toLowerCase()} totals. Print at closing, then encode into the Inventory app.</div>
      <div class="summary-stats">
        <div class="stat-box"><div class="n">${orders}</div><div class="l">Orders</div></div>
        <div class="stat-box"><div class="n">${rows.length}</div><div class="l">Products</div></div>
        <div class="stat-box"><div class="n">${grand}</div><div class="l">Total items</div></div>
      </div>`;
    if (!rows.length) html += `<div class="empty-state">No ${d.label.toLowerCase()} items ordered yet today.</div>`;
    else {
      html += `<table class="summary-table"><thead><tr><th>Product</th><th>Qty</th><th></th></tr></thead><tbody>`;
      rows.forEach(r => {
        html += `<tr><td>${escapeHtml(r.name)}${r.voided ? `<div class="void-note">voided ${r.voided}</div>` : ''}</td><td>${r.qty}</td>
          <td>${r.qty > 0 ? `<button class="btn-void" data-void-dept="${dept}" data-void-name="${escapeHtml(r.name)}">Void</button>` : ''}</td></tr>`;
      });
      html += `</tbody></table>`;
    }
    html += `<button class="btn btn-primary" onclick="printDeptSummary('${dept}')" ${grand ? '' : 'disabled'}>🖨️ Print ${d.label} Summary</button></div>`;
  });

  if (voidsToday.length) {
    html += `<div class="card"><h2>Voids today</h2><div class="card-sub">Every void is recorded and can't be removed.</div>`;
    voidsToday.forEach(v => {
      html += `<div class="void-log-row"><div><div>${DEPTS[v.dept].icon} ${escapeHtml(v.name)}</div><div class="meta">${escapeHtml(v.by)} · ${escapeHtml(v.time)}</div></div><div class="q">−${v.qty}</div></div>`;
    });
    html += `</div>`;
  }

  html += `<div class="card"><h2>Completed orders</h2><div class="card-sub">Tap an order to view or print its Bar / Kitchen slip.</div>`;
  if (!todayOrders.length) html += `<div class="empty-state">None yet.</div>`;
  todayOrders.forEach(o => {
    const t = o.items.reduce((s, it) => s + it.qty, 0);
    const depts = DEPT_KEYS.filter(k => o.items.some(i => i.dept === k));
    html += `
      <div class="order-item" id="order-${o.id}">
        <div class="order-item-head" onclick="document.getElementById('order-${o.id}').classList.toggle('open')">
          <span><strong>${escapeHtml(o.staff)}</strong> — ${escapeHtml(o.time)}</span>
          <span class="order-item-count">${o.items.length} item${o.items.length === 1 ? '' : 's'} · ${t} total</span>
        </div>
        <div class="order-item-body">
          ${o.items.map(it => `<div class="line"><span>${DEPTS[it.dept].icon} ${escapeHtml(it.name)}</span><span>${it.qty}</span></div>`).join('')}
          <div class="order-item-actions">
            ${depts.map(k => `<button class="btn-print-small" onclick="printOrderSlip('${o.id}','${k}')">🖨️ ${DEPTS[k].icon} ${DEPTS[k].label}</button>`).join('')}
            ${editMode ? `<button class="btn-del-small" onclick="deleteOrder('${o.id}')">🗑️ Delete</button>` : ''}
          </div>
        </div>
      </div>`;
  });
  html += `</div>`;
  $('main').innerHTML = html;
}

/* ── void: needs the admin password ── */
let voidState = { dept: '', name: '', max: 0, qty: 1 };
function openVoid(dept, name) {
  const row = aggregate(dept).find(r => r.name === name);
  if (!row || row.qty <= 0) return;
  voidState = { dept, name, max: row.qty, qty: row.qty };
  $('vm-name').textContent = DEPTS[dept].icon + ' ' + name;
  $('vm-sub').textContent = `Currently out: ${row.qty} — choose how many to void`;
  $('vm-pw').value = ''; $('vm-err').textContent = '';
  paintVoid(); $('void-modal').classList.add('show');
}
function paintVoid() { $('vm-val').textContent = voidState.qty; }
function closeVoid() { $('void-modal').classList.remove('show'); $('vm-pw').value = ''; }
async function confirmVoid() {
  const pw = $('vm-pw').value;
  if (!pw) { $('vm-err').textContent = 'Enter the admin password'; return; }
  $('vm-ok').disabled = true; $('vm-err').textContent = '';
  try {
    await verifyAuth.signInWithEmailAndPassword('admin' + ACCOUNT_DOMAIN, pw);
    await verifyAuth.signOut();
  } catch (e) {
    const bad = ['auth/wrong-password', 'auth/invalid-credential', 'auth/user-not-found', 'auth/invalid-login-credentials'];
    $('vm-err').textContent = bad.includes(e.code) ? 'Wrong admin password' : e.message;
    $('vm-ok').disabled = false; return;
  }
  const { dept, name, qty } = voidState;
  const row = aggregate(dept).find(r => r.name === name);
  if (!row || qty > row.qty) { $('vm-err').textContent = 'Quantity changed — try again'; $('vm-ok').disabled = false; return; }
  try {
    await voidsCol(activeDateKey).add({
      dept, name, qty,
      by: $('staff-input').value.trim() || ROLES[role].label,
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    closeVoid(); showToast(`↩️ Voided ${qty} × ${name}`);
  } catch (e) { $('vm-err').textContent = e.message; }
  $('vm-ok').disabled = false;
}

/* ── receipts (80mm) — "product  out -qty" ── */
const fmtDate = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = d => d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
function receiptHead(dept, when, extra) {
  return `<div class="r-center r-dept">${DEPTS[dept].label.toUpperCase()}</div>
    <div class="r-center r-sub">${fmtDate(when)} ${fmtTime(when)}${extra || ''}</div>
    <div class="r-rule"></div>`;
}
function receiptLines(rows) {
  return rows.map(r => `<div class="r-line"><span class="r-item">${escapeHtml(r.name)}</span><span>out -${r.qty}</span></div>`).join('');
}
function printHtml(html) { $('print-area').innerHTML = html; window.print(); }
function printOrderSlip(id, dept) {
  const o = todayOrders.find(x => x.id === id); if (!o) return;
  const items = o.items.filter(i => i.dept === dept); if (!items.length) return;
  const when = (o.createdAt && o.createdAt.toDate) ? o.createdAt.toDate() : new Date();
  printHtml(receiptHead(dept, when, ` · ${escapeHtml(o.staff)}`) + receiptLines(items));
}
function printDeptSummary(dept) {
  const rows = aggregate(dept).filter(r => r.qty > 0); if (!rows.length) return;
  printHtml(receiptHead(dept, new Date()) + receiptLines(rows));
}

/* ── accounts / session ── */
let loginAcct = 'admin';
function loginError(msg) { $('login-err').textContent = msg || ''; }
function roleFromUser(u) {
  const name = ((u && u.email) || '').split('@')[0];
  return ROLES[name] ? name : null;
}
async function doLogin() {
  const pw = $('login-pw').value;
  if (!pw) return loginError('Enter the password');
  $('login-btn').disabled = true; loginError('');
  try {
    await auth.signInWithEmailAndPassword(loginAcct + ACCOUNT_DOMAIN, pw);
    $('login-pw').value = '';
  } catch (e) {
    const bad = ['auth/wrong-password', 'auth/invalid-credential', 'auth/user-not-found', 'auth/invalid-login-credentials'];
    loginError(bad.includes(e.code) ? 'Wrong password' : e.message);
  }
  $('login-btn').disabled = false;
}
function startSession(u) {
  const r = roleFromUser(u);
  if (!r) { auth.signOut(); loginError('This account is not set up for the Order Log.'); return; }
  role = r; editMode = false; draft = {}; shellBuilt = false;
  $('login').classList.remove('show');
  $('drawer-user').textContent = ROLES[r].label + ' account';
  updateEditUI();
  DEPT_KEYS.forEach(subscribeProducts);
  subscribeOrders();
  renderMain();
}
function endSession() {
  if (unsubOrders) { unsubOrders(); unsubOrders = null; }
  if (unsubVoids) { unsubVoids(); unsubVoids = null; }
  voidsToday = []; closeVoid();
  Object.values(unsubProducts).forEach(f => f()); unsubProducts = {};
  role = null; editMode = false; draft = {}; todayOrders = []; shellBuilt = false;
  knownProducts = { bar: [], kitchen: [] };
  $('main').innerHTML = '';
  closeDrawer(); updateEditUI(); closeQty();
  $('login').classList.add('show');
}
function logout() { endSession(); auth.signOut(); }

/* burger menu + edit mode */
function openDrawer() { $('drawer').classList.add('show'); $('drawer-backdrop').classList.add('show'); }
function closeDrawer() { $('drawer').classList.remove('show'); $('drawer-backdrop').classList.remove('show'); }
function updateEditUI() {
  $('edit-switch').classList.toggle('on', editMode);
  $('edit-pill').style.display = editMode ? '' : 'none';
}
function toggleEditMode() {
  editMode = !editMode;
  updateEditUI(); closeDrawer();
  shellBuilt = false; renderMain();
  showToast(editMode ? '✏️ Edit mode on' : 'Edit mode off');
}

/* ── boot ── */
(function init() {
  $('staff-input').value = localStorage.getItem('orderlog-staff') || '';
  $('staff-input').addEventListener('input', e => localStorage.setItem('orderlog-staff', e.target.value));
  document.querySelectorAll('.view-tab').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

  // quantity modal
  $('qm-quick').innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button data-q="${n}">${n}</button>`).join('');
  $('qm-quick').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) { modal.qty = +b.dataset.q; paintQty(); } });
  $('qm-minus').addEventListener('click', () => { modal.qty = Math.max(1, modal.qty - 1); paintQty(); });
  $('qm-plus').addEventListener('click', () => { modal.qty = Math.min(999, modal.qty + 1); paintQty(); });
  $('qm-cancel').addEventListener('click', closeQty);
  $('qm-ok').addEventListener('click', confirmQty);
  $('qty-modal').addEventListener('click', e => { if (e.target.id === 'qty-modal') closeQty(); });

  // void modal
  $('main').addEventListener('click', e => {
    const b = e.target.closest('[data-void-name]'); if (b) openVoid(b.dataset.voidDept, b.dataset.voidName);
  });
  $('vm-minus').addEventListener('click', () => { voidState.qty = Math.max(1, voidState.qty - 1); paintVoid(); });
  $('vm-plus').addEventListener('click', () => { voidState.qty = Math.min(voidState.max, voidState.qty + 1); paintVoid(); });
  $('vm-all').addEventListener('click', () => { voidState.qty = voidState.max; paintVoid(); });
  $('vm-cancel').addEventListener('click', closeVoid);
  $('vm-ok').addEventListener('click', confirmVoid);
  $('vm-pw').addEventListener('keydown', e => { if (e.key === 'Enter') confirmVoid(); });
  $('void-modal').addEventListener('click', e => { if (e.target.id === 'void-modal') closeVoid(); });

  // burger menu
  $('burger').addEventListener('click', openDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  $('edit-toggle').addEventListener('click', toggleEditMode);
  $('logout-btn').addEventListener('click', logout);

  // login
  $('acct-pick').addEventListener('click', e => {
    const b = e.target.closest('[data-acct]'); if (!b) return;
    loginAcct = b.dataset.acct;
    [...$('acct-pick').children].forEach(x => x.classList.toggle('active', x === b));
  });
  $('login-btn').addEventListener('click', doLogin);
  $('login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // everything runs only once Firebase confirms who is signed in
  auth.onAuthStateChanged(u => u ? startSession(u) : endSession());
})();