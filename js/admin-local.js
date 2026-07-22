import { requireRole, logout } from './auth.js';
import {
  listenCategories,
  listenAllProducts,
  listenCurrentOrder,
  listenOrderItems,
  listenAdjustments,
  getOrderDetail,
  listenCompletedOrders,
  listenUsersOfSalon,
  listenInvitesOfSalon,
  createOrder,
  startReview,
  closeOrder,
  setAdjustment,
  addCategory,
  addProduct,
  deactivateProduct,
  activateProduct,
  createInvite,
  updateUserName,
  consolidateByProduct,
  consolidateByUser,
} from './db.js';
import { doc, getDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase-init.js';

const STATUS_LABEL = {
  draft: 'Abierto para agregar',
  reviewing: 'En revisión por administración',
  completed: 'Pedido enviado a proveedor',
};

let user, profile;
let categories = [];
let products = [];
let users = [];
let order = null;
let items = [];
let adjustments = [];
let consolidatedView = 'byProduct'; // 'byProduct' | 'byUser'
let unsubItems = null;
let unsubAdjustments = null;

init();

async function init() {
  const auth = await requireRole(['local_admin']);
  user = auth.user;
  profile = auth.profile;

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await logout();
    window.location.href = 'index.html';
  });

  setupNav();
  setupPeriodModal();
  setupCatalogForms();
  setupInviteForm();

  const salonSnap = await getDoc(doc(db, 'salons', profile.salonId));
  if (salonSnap.exists()) document.getElementById('salonName').textContent = salonSnap.data().name;

  listenCategories(profile.salonId, (cats) => {
    categories = cats;
    renderCategoryOptions();
    renderDashboard();
  });

  listenAllProducts(profile.salonId, (prods) => {
    products = prods;
    renderProductList();
    renderDashboard();
  });

  listenCurrentOrder(profile.salonId, (currentOrder) => {
    order = currentOrder;
    if (unsubItems) unsubItems();
    if (unsubAdjustments) unsubAdjustments();
    items = [];
    adjustments = [];
    if (order) {
      unsubItems = listenOrderItems(profile.salonId, order.id, (its) => {
        items = its;
        renderDashboard();
      });
      unsubAdjustments = listenAdjustments(profile.salonId, order.id, (adjs) => {
        adjustments = adjs;
        renderDashboard();
      });
    }
    renderDashboard();
  });

  listenCompletedOrders(profile.salonId, renderHistory);
  listenUsersOfSalon(profile.salonId, (list) => {
    users = list;
    renderUserList(list);
    renderDashboard();
  });
  listenInvitesOfSalon(profile.salonId, renderInviteList);
}

// ---------------------------------------------------------------------------
// Navegación entre paneles
// ---------------------------------------------------------------------------
function setupNav() {
  document.querySelectorAll('.nav-link').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
      document.getElementById(`panel-${btn.dataset.panel}`).classList.remove('hidden');
    });
  });
}

// ---------------------------------------------------------------------------
// Dashboard: pedido actual, consolidado / por usuario
// ---------------------------------------------------------------------------
function renderDashboard() {
  document.getElementById('noOrderCard').classList.toggle('hidden', !!order);
  document.getElementById('orderCard').classList.toggle('hidden', !order);
  document.getElementById('consolidatedSection').classList.toggle('hidden', !order);
  document.getElementById('draftHint').classList.toggle('hidden', !order || order.status !== 'draft');

  renderActionsBar();

  if (!order) return;

  document.getElementById('periodLabel').textContent = formatPeriod(order);
  const badge = document.getElementById('statusBadge');
  badge.textContent = STATUS_LABEL[order.status];
  badge.className = `badge badge-${order.status}`;

  const groups = consolidateByProduct(items, products, categories, adjustments);
  const totalProducts = groups.reduce((s, g) => s + g.items.length, 0);
  const totalUnits = groups.reduce((s, g) => s + g.items.reduce((s2, i) => s2 + i.totalQuantity, 0), 0);
  const totalUsers = new Set(items.map((i) => i.userId)).size;
  document.getElementById('statProducts').textContent = String(totalProducts);
  document.getElementById('statUnits').textContent = String(totalUnits);
  document.getElementById('statUsers').textContent = String(totalUsers);

  renderByProductView(groups);
  renderByUserView(consolidateByUser(items, products));
}

function renderActionsBar() {
  const bar = document.getElementById('actionsBar');
  bar.innerHTML = '';
  if (!order) return;

  if (order.status === 'draft') {
    bar.appendChild(makeButton('Cerrar período de solicitud', 'btn-secondary', () => startReview(profile.salonId, order.id)));
  }

  if (order.status === 'reviewing') {
    bar.appendChild(makeButton('Generar PDF de orden', 'btn-secondary', () => window.print()));
    bar.appendChild(makeButton('Descargar TXT', 'btn-secondary', () => downloadOrderTxt()));
    bar.appendChild(makeButton('Descargar CSV', 'btn-secondary', () => downloadOrderCsv()));
    bar.appendChild(makeButton('Cerrar período y enviar', 'btn-accent', handleCloseFortnight));
  }
}

function makeButton(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.className = `btn ${cls}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

document.getElementById('viewConsolidatedBtn').addEventListener('click', () => switchConsolidatedView('byProduct'));
document.getElementById('viewByUserBtn').addEventListener('click', () => switchConsolidatedView('byUser'));

function switchConsolidatedView(view) {
  consolidatedView = view;
  document.getElementById('viewConsolidatedBtn').classList.toggle('active', view === 'byProduct');
  document.getElementById('viewByUserBtn').classList.toggle('active', view === 'byUser');
  document.getElementById('byProductView').classList.toggle('hidden', view !== 'byProduct');
  document.getElementById('byUserView').classList.toggle('hidden', view !== 'byUser');
}

function renderByProductView(groups) {
  const container = document.getElementById('byProductView');
  container.innerHTML = '';
  if (groups.length === 0) {
    container.innerHTML = '<div class="empty-state">Todavía nadie agregó insumos a este período.</div>';
    return;
  }
  const editable = order.status === 'draft' || order.status === 'reviewing';
  const template = document.getElementById('consolidatedRowTemplate');

  for (const group of groups) {
    const title = document.createElement('h2');
    title.className = 'category-title';
    title.textContent = group.category.name;
    container.appendChild(title);

    for (const item of group.items) {
      const row = template.content.firstElementChild.cloneNode(true);
      row.querySelector('.product-name').textContent = item.product.name;
      row.querySelector('.product-meta').textContent = [`${item.breakdown.length} persona(s)`, item.product.brand, item.product.format]
        .filter(Boolean)
        .join(' · ');

      const qtyInput = row.querySelector('.qty-input');
      qtyInput.value = item.totalQuantity;
      qtyInput.disabled = !editable;
      qtyInput.addEventListener('click', (e) => e.stopPropagation());
      qtyInput.addEventListener('change', () => {
        const value = Math.max(0, Number(qtyInput.value) || 0);
        setAdjustment(profile.salonId, order.id, item.product.id, value, user.uid).catch(console.error);
      });

      const detail = row.querySelector('.consolidated-row-detail');
      for (const b of item.breakdown) {
        const line = document.createElement('div');
        const noteSuffix = b.notes ? ` — ${b.notes}` : '';
        line.innerHTML = `<span>${escapeHtml(b.userName)}${escapeHtml(noteSuffix)}</span><span>${b.quantity}</span>`;
        detail.appendChild(line);
      }

      row.querySelector('.consolidated-row-head').addEventListener('click', () => row.classList.toggle('expanded'));
      container.appendChild(row);
    }
  }
}

function renderByUserView(userGroups) {
  const container = document.getElementById('byUserView');
  container.innerHTML = '';
  if (userGroups.length === 0) {
    container.innerHTML = '<div class="empty-state">Todavía nadie agregó insumos a este período.</div>';
    return;
  }
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const userById = new Map(users.map((u) => [u.id, u]));
  for (const group of userGroups) {
    const wrap = document.createElement('div');
    wrap.className = 'user-group';
    const h3 = document.createElement('h3');
    h3.textContent = userById.get(group.userId)?.name || group.userName;
    wrap.appendChild(h3);
    const ul = document.createElement('ul');
    for (const it of group.items) {
      const li = document.createElement('li');
      const noteSuffix = it.notes ? ` — ${it.notes}` : '';
      const label = [categoryById.get(it.product.categoryId)?.name, it.product.brand, it.product.name]
        .filter(Boolean)
        .join(' · ');
      li.innerHTML = `<span>${escapeHtml(label)}${escapeHtml(noteSuffix)}</span><span>${it.quantity} unidades</span>`;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    container.appendChild(wrap);
  }
}

// ---------------------------------------------------------------------------
// Modal: definir fechas y abrir pedido
// ---------------------------------------------------------------------------
function setupPeriodModal() {
  const modal = document.getElementById('periodModal');
  document.getElementById('openOrderBtn').addEventListener('click', () => {
    modal.hidden = false;
  });
  document.getElementById('periodCancelBtn').addEventListener('click', () => {
    modal.hidden = true;
  });
  document.getElementById('periodConfirmBtn').addEventListener('click', async () => {
    const start = document.getElementById('periodStartInput').value;
    const end = document.getElementById('periodEndInput').value;
    if (!start || !end) {
      alert('Completá las dos fechas.');
      return;
    }
    if (end < start) {
      alert('La fecha "Hasta" no puede ser anterior a "Desde".');
      return;
    }
    await createOrder(profile.salonId, start, end);
    modal.hidden = true;
  });
}

async function handleCloseFortnight() {
  if (!confirm('¿Cerrar este período y archivarlo? Esta acción no se puede deshacer.')) return;
  await closeOrder(profile.salonId, order.id, user.uid);
  // El admin define las fechas del próximo pedido explícitamente desde
  // "No hay un pedido abierto" → no se abre uno automático.
}

// ---------------------------------------------------------------------------
// Descargar pedido consolidado (TXT / CSV)
// ---------------------------------------------------------------------------
function downloadTextFile(filename, content, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadOrderTxt(o = order, groups = consolidateByProduct(items, products, categories, adjustments)) {
  const lines = [`Pedido del período — ${formatPeriod(o)}`, ''];
  for (const group of groups) {
    lines.push(group.category.name.toUpperCase());
    for (const item of group.items) {
      const notes = item.breakdown.filter((b) => b.notes).map((b) => b.notes);
      const meta = [item.product.brand, item.product.format].filter(Boolean).join(' · ');
      const suffix = notes.length ? ` (${notes.join('; ')})` : '';
      lines.push(`- ${item.product.name}${meta ? ' [' + meta + ']' : ''}: ${item.totalQuantity} unidades${suffix}`);
    }
    lines.push('');
  }
  downloadTextFile(`pedido-${o.periodStart}-a-${o.periodEnd}.txt`, lines.join('\n'), 'text/plain');
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function downloadOrderCsv(o = order, groups = consolidateByProduct(items, products, categories, adjustments)) {
  const rows = [['Categoria', 'Marca', 'Linea', 'Producto', 'Tono', 'Formato', 'Cantidad', 'Proveedor']];
  for (const group of groups) {
    for (const item of group.items) {
      rows.push([
        group.category.name,
        item.product.brand || '',
        item.product.line || '',
        item.product.name,
        item.product.shadeCode || '',
        item.product.format || '',
        item.totalQuantity,
        item.product.supplierName || '',
      ]);
    }
  }
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  // El BOM al inicio ayuda a que Excel detecte UTF-8 y muestre bien tildes/ñ.
  downloadTextFile(`pedido-${o.periodStart}-a-${o.periodEnd}.csv`, '\uFEFF' + csv, 'text/csv');
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------
function setupCatalogForms() {
  document.getElementById('categoryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('categoryName');
    const name = input.value.trim();
    if (!name) return;
    await addCategory(profile.salonId, name, categories.length);
    input.value = '';
  });

  document.getElementById('productForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('productName').value.trim();
    const brand = document.getElementById('productBrand').value.trim();
    const line = document.getElementById('productLine').value.trim();
    const categoryId = document.getElementById('productCategory').value;
    const shadeCode = document.getElementById('productShade').value.trim();
    const format = document.getElementById('productFormat').value.trim();
    const supplierName = document.getElementById('productSupplier').value.trim();
    const productCode = document.getElementById('productCode').value.trim();
    if (!name || !brand || !categoryId) return;
    await addProduct(profile.salonId, { name, brand, line, categoryId, shadeCode, format, supplierName, productCode });
    e.target.reset();
  });

  document.getElementById('bulkImportBtn').addEventListener('click', async () => {
    const textarea = document.getElementById('bulkImportInput');
    const resultEl = document.getElementById('bulkImportResult');
    const text = textarea.value;
    if (!text.trim()) return;

    const btn = document.getElementById('bulkImportBtn');
    btn.disabled = true;
    resultEl.textContent = 'Cargando…';

    try {
      const result = await bulkImportCatalog(text);
      resultEl.textContent = `Listo: ${result.categories} categoría(s) nueva(s) y ${result.products} producto(s) agregados.`;
      textarea.value = '';
    } catch (err) {
      console.error(err);
      resultEl.textContent = 'Hubo un error, revisá la consola del navegador (F12) para más detalle.';
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * Parsea un texto tipo:
 *   # Categoría
 *   Producto; marca; línea; tono; formato; proveedor; código
 * y crea las categorías/productos que no existan todavía (compara nombres
 * sin importar mayúsculas/minúsculas para no duplicar categorías). Solo el
 * nombre del producto es obligatorio; el resto se puede dejar vacío.
 */
async function bulkImportCatalog(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const categoryIdByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  let sortOrder = categories.length;
  let currentCategoryId = null;
  const created = { categories: 0, products: 0 };

  for (const rawLine of lines) {
    if (rawLine.startsWith('#')) {
      const name = rawLine.slice(1).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (categoryIdByName.has(key)) {
        currentCategoryId = categoryIdByName.get(key);
      } else {
        const ref = await addCategory(profile.salonId, name, sortOrder++);
        currentCategoryId = ref.id;
        categoryIdByName.set(key, ref.id);
        created.categories++;
      }
    } else {
      if (!currentCategoryId) continue; // producto listado antes de cualquier "# Categoría": se ignora
      const parts = rawLine.split(';').map((s) => s.trim());
      const [name, brand, productLine, shadeCode, format, supplierName, productCode] = parts;
      if (!name) continue;
      await addProduct(profile.salonId, {
        name,
        categoryId: currentCategoryId,
        brand: brand || '',
        line: productLine || '',
        shadeCode: shadeCode || '',
        format: format || '',
        supplierName: supplierName || '',
        productCode: productCode || '',
      });
      created.products++;
    }
  }

  return created;
}

function renderCategoryOptions() {
  const select = document.getElementById('productCategory');
  const current = select.value;
  select.innerHTML = '<option value="" disabled selected>Elegí una categoría</option>';
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
  if (current) select.value = current;
}

function renderProductList() {
  const container = document.getElementById('productList');
  container.innerHTML = '';
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  if (products.length === 0) {
    container.innerHTML = '<div class="empty-state">Todavía no cargaste productos.</div>';
    return;
  }

  const activeProducts = products.filter((p) => p.active);
  const inactiveProducts = products.filter((p) => !p.active);

  if (activeProducts.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay productos activos.</div>';
  } else {
    for (const p of activeProducts) container.appendChild(buildProductRow(p, categoryById, false));
  }

  if (inactiveProducts.length > 0) {
    const title = document.createElement('h2');
    title.className = 'category-title';
    title.textContent = 'Productos desactivados';
    container.appendChild(title);
    for (const p of inactiveProducts) container.appendChild(buildProductRow(p, categoryById, true));
  }
}

function buildProductRow(p, categoryById, isInactive) {
  const row = document.createElement('div');
  row.className = 'list-row';
  const metaParts = [
    categoryById.get(p.categoryId)?.name || '—',
    p.brand,
    p.line,
    p.shadeCode,
    p.format,
    p.supplierName,
  ].filter(Boolean);
  row.innerHTML = `
    <div>
      <p class="list-row-title">${escapeHtml(p.name)}</p>
      <p class="list-row-sub">${escapeHtml(metaParts.join(' · '))}</p>
    </div>
  `;
  const btn = document.createElement('button');
  btn.className = 'btn btn-ghost btn-sm';
  if (isInactive) {
    btn.textContent = 'Reactivar';
    btn.addEventListener('click', async () => {
      await activateProduct(profile.salonId, p.id);
    });
  } else {
    btn.textContent = 'Desactivar';
    btn.addEventListener('click', async () => {
      if (confirm(`¿Quitar "${p.name}" del catálogo?`)) await deactivateProduct(profile.salonId, p.id);
    });
  }
  row.appendChild(btn);
  return row;
}

// ---------------------------------------------------------------------------
// Equipo (invitaciones + usuarios)
// ---------------------------------------------------------------------------
function setupInviteForm() {
  document.getElementById('inviteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('inviteEmail');
    const email = input.value.trim().toLowerCase();
    if (!email) return;
    await createInvite(email, 'basic', profile.salonId, user.uid);
    input.value = '';
  });
}

function renderInviteList(invites) {
  const container = document.getElementById('inviteList');
  container.innerHTML = '';
  if (invites.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay invitaciones pendientes.</div>';
    return;
  }
  for (const inv of invites) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div>
        <p class="list-row-title">${escapeHtml(inv.id)}</p>
        <p class="list-row-sub">Invitación pendiente</p>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = 'Cancelar';
    btn.addEventListener('click', async () => {
      if (confirm('¿Cancelar esta invitación?')) await deleteDoc(doc(db, 'invites', inv.id));
    });
    row.appendChild(btn);
    container.appendChild(row);
  }
}

function renderUserList(users) {
  const container = document.getElementById('userList');
  container.innerHTML = '';
  if (users.length === 0) {
    container.innerHTML = '<div class="empty-state">Todavía no hay nadie en el equipo.</div>';
    return;
  }
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div>
        <p class="list-row-title">${escapeHtml(u.name)}</p>
        <p class="list-row-sub">${escapeHtml(u.email)}</p>
      </div>
      <span class="pill">${u.role === 'local_admin' ? 'Admin local' : 'Básico'}</span>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = 'Editar nombre';
    btn.addEventListener('click', async () => {
      const newName = prompt('Nuevo nombre para este usuario:', u.name);
      if (newName === null) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === u.name) return;
      await updateUserName(u.id, trimmed);
    });
    row.appendChild(btn);
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
function renderHistory(orders) {
  const container = document.getElementById('historyList');
  container.innerHTML = '';
  if (orders.length === 0) {
    container.innerHTML = '<div class="empty-state">Todavía no hay períodos archivados.</div>';
    return;
  }
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const userById = new Map(users.map((u) => [u.id, u]));

  for (const o of orders) {
    const row = document.createElement('div');
    row.className = 'consolidated-row';
    const closedDate = o.closedAt?.toDate ? o.closedAt.toDate().toLocaleDateString('es') : '—';
    row.innerHTML = `
      <div class="consolidated-row-head">
        <div>
          <p class="product-name">${escapeHtml(formatPeriod(o))}</p>
          <p class="product-meta">Cerrado el ${escapeHtml(closedDate)}</p>
        </div>
        <span class="chevron">▾</span>
      </div>
      <div class="consolidated-row-detail"></div>
    `;

    const head = row.querySelector('.consolidated-row-head');
    const detail = row.querySelector('.consolidated-row-detail');
    let loaded = false;

    head.addEventListener('click', async () => {
      row.classList.toggle('expanded');
      if (!row.classList.contains('expanded') || loaded) return;
      loaded = true;
      detail.innerHTML = '<p class="text-sm text-muted">Cargando…</p>';
      try {
        const { items: histItems, adjustments: histAdjustments } = await getOrderDetail(profile.salonId, o.id);
        const productGroups = consolidateByProduct(histItems, products, categories, histAdjustments);
        const userGroups = consolidateByUser(histItems, products);
        detail.innerHTML = '';

        const topBar = document.createElement('section');
        topBar.style.display = 'flex';
        topBar.style.flexWrap = 'wrap';
        topBar.style.justifyContent = 'space-between';
        topBar.style.alignItems = 'center';
        topBar.style.gap = '8px';
        topBar.style.marginBottom = '10px';

        const switchWrap = document.createElement('section');
        switchWrap.className = 'view-switch';
        const btnTotal = document.createElement('button');
        btnTotal.type = 'button';
        btnTotal.textContent = 'Total';
        btnTotal.className = 'active';
        const btnUser = document.createElement('button');
        btnUser.type = 'button';
        btnUser.textContent = 'Por usuario';
        switchWrap.appendChild(btnTotal);
        switchWrap.appendChild(btnUser);

        const downloadWrap = document.createElement('div');
        downloadWrap.style.display = 'flex';
        downloadWrap.style.gap = '8px';
        const btnTxt = document.createElement('button');
        btnTxt.type = 'button';
        btnTxt.className = 'btn btn-ghost btn-sm';
        btnTxt.textContent = 'Descargar TXT';
        btnTxt.addEventListener('click', (e) => {
          e.stopPropagation();
          downloadOrderTxt(o, productGroups);
        });
        const btnCsv = document.createElement('button');
        btnCsv.type = 'button';
        btnCsv.className = 'btn btn-ghost btn-sm';
        btnCsv.textContent = 'Descargar CSV';
        btnCsv.addEventListener('click', (e) => {
          e.stopPropagation();
          downloadOrderCsv(o, productGroups);
        });
        downloadWrap.appendChild(btnTxt);
        downloadWrap.appendChild(btnCsv);

        topBar.appendChild(switchWrap);
        topBar.appendChild(downloadWrap);
        detail.appendChild(topBar);

        const productSection = document.createElement('section');
        const userSection = document.createElement('section');
        userSection.classList.add('hidden');
        detail.appendChild(productSection);
        detail.appendChild(userSection);

        renderHistProductView(productSection, productGroups, categoryById);
        renderHistUserView(userSection, userGroups, categoryById, userById);

        btnTotal.addEventListener('click', (e) => {
          e.stopPropagation();
          btnTotal.classList.add('active');
          btnUser.classList.remove('active');
          productSection.classList.remove('hidden');
          userSection.classList.add('hidden');
        });
        btnUser.addEventListener('click', (e) => {
          e.stopPropagation();
          btnUser.classList.add('active');
          btnTotal.classList.remove('active');
          userSection.classList.remove('hidden');
          productSection.classList.add('hidden');
        });
      } catch (err) {
        console.error(err);
        detail.innerHTML = '<p class="text-sm text-muted">No se pudo cargar el detalle. Revisá la consola (F12).</p>';
      }
    });

    container.appendChild(row);
  }
}

function renderHistProductView(container, groups, categoryById) {
  container.innerHTML = '';
  if (groups.length === 0) {
    container.innerHTML = '<p class="text-sm text-muted">Nadie agregó insumos en este período.</p>';
    return;
  }
  for (const group of groups) {
    const catTitle = document.createElement('p');
    catTitle.className = 'text-sm';
    catTitle.style.fontWeight = '600';
    catTitle.style.marginTop = '10px';
    catTitle.textContent = categoryById.get(group.category.id)?.name || group.category.name;
    container.appendChild(catTitle);
    for (const item of group.items) {
      const line = document.createElement('div');
      const meta = [item.product.brand, item.product.format].filter(Boolean).join(' · ');
      line.innerHTML = `<span>${escapeHtml(item.product.name)}${meta ? ' — ' + escapeHtml(meta) : ''}</span><span>${item.totalQuantity} unidades</span>`;
      container.appendChild(line);
    }
  }
}

function renderHistUserView(container, userGroups, categoryById, userById) {
  container.innerHTML = '';
  if (userGroups.length === 0) {
    container.innerHTML = '<p class="text-sm text-muted">Nadie agregó insumos en este período.</p>';
    return;
  }
  for (const group of userGroups) {
    const userTitle = document.createElement('p');
    userTitle.className = 'text-sm';
    userTitle.style.fontWeight = '600';
    userTitle.style.marginTop = '10px';
    userTitle.textContent = userById.get(group.userId)?.name || group.userName;
    container.appendChild(userTitle);
    for (const it of group.items) {
      const line = document.createElement('div');
      const noteSuffix = it.notes ? ` — ${it.notes}` : '';
      const label = [categoryById.get(it.product.categoryId)?.name, it.product.brand, it.product.name]
        .filter(Boolean)
        .join(' · ');
      line.innerHTML = `<span>${escapeHtml(label)}${escapeHtml(noteSuffix)}</span><span>${it.quantity} unidades</span>`;
      container.appendChild(line);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function formatPeriod(o) {
  if (!o.periodStart || !o.periodEnd) return '';
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  const start = new Date(o.periodStart + 'T00:00:00').toLocaleDateString('es', opts);
  const end = new Date(o.periodEnd + 'T00:00:00').toLocaleDateString('es', opts);
  return `${start} — ${end}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}