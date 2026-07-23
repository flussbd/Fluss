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
  reopenDraft,
  finalizeReception,
  closeOrder,
  setAdjustment,
  addCategory,
  addProduct,
  updateProduct,
  deactivateProduct,
  activateProduct,
  setItemReceivedQuantity,
  createInvite,
  updateUserName,
  setUserStatus,
  consolidateByProduct,
  consolidateByUser,
  compareProductsByShade,
} from './db.js';
import { formatPrice, escapeHtml, receiptDiffClass } from './pure.js';
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
let providerExportContext = null;
let consolidatedView = 'byProduct'; // 'byProduct' | 'byUser'
let unsubItems = null;
let unsubAdjustments = null;
let unsubHistory = null;
let historyLimit = 10;

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
  setupProductEditModal();
  setupProviderExportModal();
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
    maybeAutoCloseDraft();
  });

  subscribeHistory();
  listenUsersOfSalon(profile.salonId, (list) => {
    users = list;
    renderUserList(list);
    renderDashboard();
  });
  listenInvitesOfSalon(profile.salonId, renderInviteList);

  startAutoCloseTicker();
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

  document.getElementById('periodLabel').textContent =
    formatPeriod(order) + (order.status === 'draft' && order.periodEndTime ? ` · cierra ${order.periodEndTime}` : '');
  const badge = document.getElementById('statusBadge');
  badge.textContent = STATUS_LABEL[order.status];
  badge.className = `badge badge-${order.status}`;
  updateAutoCloseCountdown();

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
    bar.appendChild(makeButton('Descargar Excel', 'btn-secondary', () => downloadOrderXlsx()));
    bar.appendChild(makeButton('Descargar por proveedor', 'btn-secondary', () => openProviderExportModal()));
    bar.appendChild(makeButton('Reabrir para agregar insumos', 'btn-secondary', handleReopenDraft));
    bar.appendChild(makeButton('Cerrar período y enviar', 'btn-accent', handleCloseFortnight));
  }
}

async function handleReopenDraft() {
  const endOfPeriod = getPeriodEndDate(order);
  const pastDeadline = endOfPeriod && new Date() > endOfPeriod;
  const warn = pastDeadline
    ? '\n\nOjo: la fecha/hora de cierre de este período ya pasó, así que se va a volver a cerrar solo apenas alguien tenga el panel abierto unos segundos (o lo vuelva a abrir).'
    : '';
  if (!confirm(`¿Reabrir este período para que el equipo pueda seguir agregando o corrigiendo insumos?${warn}`)) return;
  try {
    await reopenDraft(profile.salonId, order.id);
  } catch (err) {
    console.error(err);
    alert('No se pudo reabrir el período. Probá de nuevo.');
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
    let userTotal = 0;
    let anyPriceKnown = false;
    for (const it of group.items) {
      const li = document.createElement('li');
      const noteSuffix = it.notes ? ` — ${it.notes}` : '';
      const label = [categoryById.get(it.product.categoryId)?.name, it.product.brand, it.product.name]
        .filter(Boolean)
        .join(' · ');
      const price = typeof it.product.price === 'number' ? it.product.price : null;
      const qtyText = price !== null ? `${it.quantity} unidades · ${formatPrice(price)} c/u` : `${it.quantity} unidades`;
      if (price !== null) {
        userTotal += it.quantity * price;
        anyPriceKnown = true;
      }
      li.innerHTML = `<span>${escapeHtml(label)}${escapeHtml(noteSuffix)}</span><span>${escapeHtml(qtyText)}</span>`;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);

    if (anyPriceKnown) {
      // Es de solo lectura a propósito: acá no se puede tocar la
      // cantidad, eso solo se ajusta desde la vista Consolidado.
      const totalRow = document.createElement('div');
      totalRow.className = 'order-total mt-4';
      totalRow.innerHTML = `<span>Total</span><span class="order-total-value">${escapeHtml(formatPrice(userTotal))}</span>`;
      wrap.appendChild(totalRow);
    }

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
    const endTime = document.getElementById('periodEndTimeInput').value || '10:00';
    if (!start || !end) {
      alert('Completá las dos fechas.');
      return;
    }
    if (end < start) {
      alert('La fecha "Hasta" no puede ser anterior a "Desde".');
      return;
    }
    await createOrder(profile.salonId, start, end, endTime);
    modal.hidden = true;
  });
}

// Cierre automático del período de solicitud: como Fluss no tiene servidor
// propio (solo Firestore + hosting estático), esto se revisa cada vez que el
// admin abre su panel — si ya pasó la fecha de fin y el pedido sigue en
// borrador, se cierra solo (mismo efecto que el botón manual). No archiva ni
// envía el pedido: eso sigue siendo una acción manual del admin.
/** Fecha/hora exacta de cierre: el admin la define al abrir el pedido (por defecto 23:59). */
function getPeriodEndDate(o) {
  if (!o?.periodEnd) return null;
  const time = /^\d{2}:\d{2}$/.test(o.periodEndTime || '') ? o.periodEndTime : '23:59';
  const d = new Date(`${o.periodEnd}T${time}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function maybeAutoCloseDraft() {
  if (!order || order.status !== 'draft') return;
  const endOfPeriod = getPeriodEndDate(order);
  if (!endOfPeriod) return;
  if (new Date() > endOfPeriod) {
    startReview(profile.salonId, order.id).catch(console.error);
  }
}

// Reloj de cierre automático: mientras este panel esté abierto en el
// navegador, revisamos cada 15 segundos si ya se cumplió la fecha límite
// (en vez de esperar a que alguien recargue la página) y mostramos una
// cuenta regresiva. Ojo: esto SOLO corre si hay una pestaña de Fluss
// abierta en ese momento — sin servidor propio no hay forma de cerrar el
// período si nadie tiene la app abierta cuando se cumple la hora; en ese
// caso se cierra igual, apenas alguien vuelva a entrar al panel.
let autoCloseTicker = null;
function startAutoCloseTicker() {
  if (autoCloseTicker) return;
  autoCloseTicker = setInterval(() => {
    maybeAutoCloseDraft();
    updateAutoCloseCountdown();
  }, 15000);
}

function updateAutoCloseCountdown() {
  const el = document.getElementById('autoCloseCountdown');
  if (!el) return;
  if (!order || order.status !== 'draft') {
    el.classList.add('hidden');
    return;
  }
  const endOfPeriod = getPeriodEndDate(order);
  if (!endOfPeriod) {
    el.classList.add('hidden');
    return;
  }
  const remaining = endOfPeriod.getTime() - Date.now();
  el.classList.remove('hidden');
  if (remaining <= 0) {
    el.textContent = 'Ya se cumplió la fecha límite: cerrando el período automáticamente…';
  } else {
    el.textContent = `Se cierra automáticamente en ${formatCountdown(remaining)} (mientras esta pestaña siga abierta), o apenas alguien vuelva a entrar al panel.`;
  }
}

function formatCountdown(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days} d`);
  if (days > 0 || hours > 0) parts.push(`${hours} h`);
  parts.push(`${minutes} min`);
  return parts.join(' ');
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

const collateEs = (a, b) => (a || '').localeCompare(b || '', 'es', { numeric: true, sensitivity: 'base' });

/**
 * Aplana los grupos por categoría en una lista de productos (uno por
 * producto), ordenada por marca, categoría, línea, producto, tono y formato.
 */
function flattenProductGroups(groups) {
  const flat = [];
  for (const group of groups) {
    for (const item of group.items) {
      flat.push({ product: item.product, categoryName: group.category.name, totalQuantity: item.totalQuantity });
    }
  }
  flat.sort(
    (a, b) =>
      collateEs(a.product.brand, b.product.brand) ||
      collateEs(a.categoryName, b.categoryName) ||
      collateEs(a.product.line, b.product.line) ||
      collateEs(a.product.name, b.product.name) ||
      collateEs(a.product.shadeCode, b.product.shadeCode) ||
      collateEs(a.product.format, b.product.format)
  );
  return flat;
}

/**
 * Arma las filas (header + datos + fila de totales) del detalle de
 * productos: precio, cantidad pedida, total, cantidad recibida (si ya se
 * cargó en el Historial) y la diferencia/costo entre ambas.
 */
function buildProductSheetRows(flatItems, receivedByProduct) {
  const header = [
    'Marca',
    'Categoria',
    'Linea',
    'Producto',
    'Tono',
    'Formato',
    'Proveedor',
    'Precio unitario',
    'Pedido',
    'Total',
    'Recibido',
    'Diferencia',
    'Costo recibido',
  ];
  const rows = [header];
  let totalPedido = 0;
  let totalTotal = 0;
  let totalRecibido = 0;
  let totalCosto = 0;

  for (const { product, categoryName, totalQuantity } of flatItems) {
    const received = receivedByProduct.get(product.id);
    const hasReceived = !!received && typeof received.receivedQuantity === 'number';
    const receivedRaw = hasReceived ? received.receivedQuantity : null;
    // Si ya se registró la recepción, usamos el precio "congelado" en ese
    // momento (no el precio actual del producto, que puede haber cambiado).
    const price = hasReceived && typeof received.unitPrice === 'number'
      ? received.unitPrice
      : typeof product.price === 'number'
        ? product.price
        : null;
    const total = price !== null ? totalQuantity * price : '';
    const cost = hasReceived && price !== null ? receivedRaw * price : '';

    totalPedido += totalQuantity;
    if (typeof total === 'number') totalTotal += total;
    if (hasReceived) totalRecibido += receivedRaw;
    if (typeof cost === 'number') totalCosto += cost;

    rows.push([
      product.brand || '',
      categoryName,
      product.line || '',
      product.name,
      product.shadeCode || '',
      product.format || '',
      product.supplierName || '',
      price !== null ? price : '',
      totalQuantity,
      total,
      hasReceived ? receivedRaw : '',
      hasReceived ? receivedRaw - totalQuantity : '',
      cost,
    ]);
  }

  rows.push(['', '', '', '', '', '', '', 'TOTAL', totalPedido, totalTotal, totalRecibido, totalRecibido - totalPedido, totalCosto]);
  return rows;
}

/**
 * Crea la hoja a partir de las filas: les da a las columnas indicadas en
 * `numericCols` (0-based) formato numérico sin decimales y con separador de
 * miles, y ajusta el ancho de todas las columnas al contenido.
 */
function finalizeSheet(rows, numericCols) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  for (let r = 1; r < rows.length; r++) {
    for (const c of numericCols) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (cell && typeof cell.v === 'number') cell.z = '#,##0';
    }
  }
  ws['!cols'] = rows[0].map((_, c) => {
    let max = 0;
    for (const row of rows) {
      const v = row[c];
      const len = v === null || v === undefined ? 0 : String(v).length;
      if (len > max) max = len;
    }
    return { wch: Math.min(Math.max(max + 2, 8), 42) };
  });
  return ws;
}

/** Nombre de hoja válido para Excel: máx. 31 caracteres, sin \ / ? * [ ] : y sin repetirse. */
function sanitizeSheetName(name, used) {
  const base = String(name || 'Sin nombre').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sin nombre';
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${i})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    i++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Genera un .xlsx real (vía SheetJS, cargado como script global en admin-local.html)
 * con una hoja "Total" (consolidado por producto) y una hoja adicional por
 * cada persona del equipo, con lo que esa persona pidió.
 */
function downloadOrderXlsx(
  o = order,
  groups = consolidateByProduct(items, products, categories, adjustments),
  receivedByProduct = new Map(),
  userGroups = consolidateByUser(items, products),
  categoryById = new Map(categories.map((c) => [c.id, c]))
) {
  if (typeof XLSX === 'undefined') {
    alert('No se pudo cargar el generador de Excel (revisá tu conexión a internet e intentá de nuevo).');
    return;
  }
  const wb = XLSX.utils.book_new();
  const usedNames = new Set();

  const totalRows = buildProductSheetRows(flattenProductGroups(groups), receivedByProduct);
  // Columnas numéricas de la hoja Total/proveedor: Precio unitario, Pedido,
  // Total, Recibido, Diferencia, Costo recibido (índices 7 a 12).
  XLSX.utils.book_append_sheet(wb, finalizeSheet(totalRows, [7, 8, 9, 10, 11, 12]), sanitizeSheetName('Total', usedNames));

  const userHeader = ['Marca', 'Categoria', 'Linea', 'Producto', 'Tono', 'Formato', 'Cantidad', 'Precio unitario', 'Total'];
  for (const u of userGroups) {
    const sorted = u.items.slice().sort(
      (a, b) =>
        collateEs(a.product.brand, b.product.brand) ||
        collateEs(categoryById.get(a.product.categoryId)?.name, categoryById.get(b.product.categoryId)?.name) ||
        collateEs(a.product.line, b.product.line) ||
        collateEs(a.product.name, b.product.name) ||
        collateEs(a.product.shadeCode, b.product.shadeCode) ||
        collateEs(a.product.format, b.product.format)
    );
    const rows = [userHeader];
    let totalQty = 0;
    let totalCost = 0;
    for (const { product, quantity } of sorted) {
      const received = receivedByProduct.get(product.id);
      const price = received && typeof received.unitPrice === 'number'
        ? received.unitPrice
        : typeof product.price === 'number'
          ? product.price
          : null;
      const total = price !== null ? quantity * price : '';
      totalQty += quantity;
      if (typeof total === 'number') totalCost += total;
      rows.push([
        product.brand || '',
        categoryById.get(product.categoryId)?.name || '',
        product.line || '',
        product.name,
        product.shadeCode || '',
        product.format || '',
        quantity,
        price !== null ? price : '',
        total,
      ]);
    }
    rows.push(['', '', '', '', '', 'TOTAL', totalQty, '', totalCost]);
    // Columnas numéricas de la hoja por usuario: Cantidad, Precio unitario, Total.
    XLSX.utils.book_append_sheet(wb, finalizeSheet(rows, [6, 7, 8]), sanitizeSheetName(u.userName, usedNames));
  }

  XLSX.writeFile(wb, `pedido-${o.periodStart}-a-${o.periodEnd}.xlsx`);
}

/**
 * Agrupa los productos del pedido por proveedor (clave = nombre del
 * proveedor, o "Sin proveedor" si no tiene). Útil tanto para armar el modal
 * de selección como para generar el propio archivo.
 */
function groupFlatItemsByProvider(groups) {
  const flat = flattenProductGroups(groups);
  const byProvider = new Map();
  for (const entry of flat) {
    const key = entry.product.supplierName || 'Sin proveedor';
    const list = byProvider.get(key) || [];
    list.push(entry);
    byProvider.set(key, list);
  }
  return byProvider;
}

/**
 * Genera un .xlsx por proveedor: si `onlyProvider` es null, arma una hoja
 * por cada proveedor (y "Sin proveedor" si aplica); si se pasa un nombre de
 * proveedor puntual, el archivo trae solo esa hoja con lo suyo.
 */
function downloadOrderXlsxByProvider(
  o = order,
  groups = consolidateByProduct(items, products, categories, adjustments),
  receivedByProduct = new Map(),
  onlyProvider = null
) {
  if (typeof XLSX === 'undefined') {
    alert('No se pudo cargar el generador de Excel (revisá tu conexión a internet e intentá de nuevo).');
    return;
  }
  const byProvider = groupFlatItemsByProvider(groups);
  let providerNames = Array.from(byProvider.keys()).sort((a, b) => collateEs(a, b));
  if (onlyProvider) {
    providerNames = providerNames.filter((name) => name === onlyProvider);
    if (providerNames.length === 0) {
      alert('Ese proveedor no tiene productos en este pedido.');
      return;
    }
  }

  const wb = XLSX.utils.book_new();
  const usedNames = new Set();
  for (const providerName of providerNames) {
    const rows = buildProductSheetRows(byProvider.get(providerName), receivedByProduct);
    XLSX.utils.book_append_sheet(wb, finalizeSheet(rows, [7, 8, 9, 10, 11, 12]), sanitizeSheetName(providerName, usedNames));
  }
  const suffix = onlyProvider ? `-${onlyProvider.replace(/[\\/:*?"<>|]/g, ' ').trim()}` : '';
  XLSX.writeFile(wb, `pedido-por-proveedor${suffix}-${o.periodStart}-a-${o.periodEnd}.xlsx`);
}

// ---------------------------------------------------------------------------
// Modal: elegir proveedor antes de descargar
// ---------------------------------------------------------------------------
function setupProviderExportModal() {
  const modal = document.getElementById('providerExportModal');

  document.getElementById('providerExportCancelBtn').addEventListener('click', () => {
    modal.hidden = true;
  });

  document.getElementById('providerExportConfirmBtn').addEventListener('click', () => {
    if (!providerExportContext) return;
    const { o, groups, receivedByProduct } = providerExportContext;
    const selected = document.getElementById('providerExportSelect').value;
    downloadOrderXlsxByProvider(o, groups, receivedByProduct, selected || null);
    modal.hidden = true;
  });
}

function openProviderExportModal(
  o = order,
  groups = consolidateByProduct(items, products, categories, adjustments),
  receivedByProduct = new Map()
) {
  providerExportContext = { o, groups, receivedByProduct };

  const providerNames = Array.from(groupFlatItemsByProvider(groups).keys()).sort((a, b) => collateEs(a, b));
  const select = document.getElementById('providerExportSelect');
  select.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'Todos los proveedores (una hoja por cada uno)';
  select.appendChild(allOpt);
  for (const name of providerNames) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }

  document.getElementById('providerExportModal').hidden = false;
}

// ---------------------------------------------------------------------------
// Modal: editar producto (todos los campos, no solo el precio)
// ---------------------------------------------------------------------------
function setupProductEditModal() {
  const modal = document.getElementById('productEditModal');

  document.getElementById('productEditCancelBtn').addEventListener('click', () => {
    modal.hidden = true;
  });

  document.getElementById('productEditSaveBtn').addEventListener('click', async () => {
    const productId = modal.dataset.productId;
    if (!productId) return;

    const name = document.getElementById('editProductName').value.trim();
    const brand = document.getElementById('editProductBrand').value.trim();
    const line = document.getElementById('editProductLine').value.trim();
    const categoryId = document.getElementById('editProductCategory').value;
    const shadeCode = document.getElementById('editProductShade').value.trim();
    const format = document.getElementById('editProductFormat').value.trim();
    const supplierName = document.getElementById('editProductSupplier').value.trim();
    const productCode = document.getElementById('editProductCode').value.trim();
    const priceRaw = document.getElementById('editProductPrice').value.trim();
    const price = priceRaw ? Number(priceRaw) : null;

    if (!name || !brand || !categoryId) {
      alert('Completá al menos nombre, marca y categoría.');
      return;
    }
    if (priceRaw && Number.isNaN(price)) {
      alert('Ingresá un precio válido.');
      return;
    }

    try {
      await updateProduct(profile.salonId, productId, {
        name,
        categoryId,
        brand,
        line,
        shadeCode,
        format,
        supplierName,
        productCode,
        price,
      });
      modal.hidden = true;
    } catch (err) {
      console.error(err);
      alert('No se pudo guardar el producto. Probá de nuevo.');
    }
  });
}

function openProductEditModal(p) {
  const modal = document.getElementById('productEditModal');
  modal.dataset.productId = p.id;

  document.getElementById('editProductName').value = p.name || '';
  document.getElementById('editProductBrand').value = p.brand || '';
  document.getElementById('editProductLine').value = p.line || '';
  document.getElementById('editProductShade').value = p.shadeCode || '';
  document.getElementById('editProductFormat').value = p.format || '';
  document.getElementById('editProductSupplier').value = p.supplierName || '';
  document.getElementById('editProductCode').value = p.productCode || '';
  document.getElementById('editProductPrice').value = typeof p.price === 'number' ? p.price : '';

  const select = document.getElementById('editProductCategory');
  select.innerHTML = '';
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
  select.value = p.categoryId;

  modal.hidden = false;
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
    const priceRaw = document.getElementById('productPrice').value.trim();
    const price = priceRaw ? Number(priceRaw) : null;
    if (!name || !brand || !categoryId) return;
    await addProduct(profile.salonId, { name, brand, line, categoryId, shadeCode, format, supplierName, productCode, price });
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
      const [name, brand, productLine, shadeCode, format, supplierName, productCode, priceRaw] = parts;
      if (!name) continue;
      const price = priceRaw ? Number(priceRaw) : null;
      await addProduct(profile.salonId, {
        name,
        categoryId: currentCategoryId,
        brand: brand || '',
        line: productLine || '',
        shadeCode: shadeCode || '',
        format: format || '',
        supplierName: supplierName || '',
        productCode: productCode || '',
        price: price !== null && !Number.isNaN(price) ? price : null,
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

  const activeProducts = products.filter((p) => p.active).sort(compareProductsByShade);
  const inactiveProducts = products.filter((p) => !p.active).sort(compareProductsByShade);

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
    formatPrice(p.price),
  ].filter(Boolean);
  row.innerHTML = `
    <div>
      <p class="list-row-title">${escapeHtml(p.name)}</p>
      <p class="list-row-sub">${escapeHtml(metaParts.join(' · '))}</p>
    </div>
  `;

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '6px';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-ghost btn-sm';
  editBtn.textContent = 'Editar';
  editBtn.addEventListener('click', () => openProductEditModal(p));
  actions.appendChild(editBtn);

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
  actions.appendChild(btn);
  row.appendChild(actions);
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

// Etiqueta y tono del estado de un usuario básico (no se usa para admins
// locales — a esos solo los gestiona el admin de plataforma).
const USER_STATUS_LABEL = { blocked: 'Bloqueado', inactive: 'De baja' };

function renderUserList(users) {
  const container = document.getElementById('userList');
  container.innerHTML = '';
  if (users.length === 0) {
    container.innerHTML = '<div class="empty-state">Todavía no hay nadie en el equipo.</div>';
    return;
  }
  for (const u of users) {
    const status = u.status || 'active';
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div>
        <p class="list-row-title">${escapeHtml(u.name)}</p>
        <p class="list-row-sub">${escapeHtml(u.email)}</p>
      </div>
    `;
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';
    actions.style.gap = '10px';

    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = u.role === 'local_admin' ? 'Admin local' : 'Básico';
    actions.appendChild(pill);

    if (status !== 'active' && USER_STATUS_LABEL[status]) {
      const statusPill = document.createElement('span');
      statusPill.className = 'pill pill-warning';
      statusPill.textContent = USER_STATUS_LABEL[status];
      actions.appendChild(statusPill);
    }

    // Un admin local solo puede gestionar (editar nombre, bloquear, dar de
    // baja) a usuarios BÁSICOS de su salón — a otros admins locales los
    // gestiona el admin de plataforma (ver firestore.rules). Se ocultan los
    // controles acá en vez de mostrarlos y que fallen en silencio.
    if (u.role === 'basic') {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-ghost btn-sm';
      editBtn.textContent = 'Editar nombre';
      editBtn.addEventListener('click', async () => {
        const newName = prompt('Nuevo nombre para este usuario:', u.name);
        if (newName === null) return;
        const trimmed = newName.trim();
        if (!trimmed || trimmed === u.name) return;
        await updateUserName(u.id, trimmed);
      });
      actions.appendChild(editBtn);

      const blockBtn = document.createElement('button');
      blockBtn.className = 'btn btn-ghost btn-sm';
      if (status === 'blocked') {
        blockBtn.textContent = 'Desbloquear';
        blockBtn.addEventListener('click', async () => {
          await setUserStatus(u.id, 'active');
        });
      } else {
        blockBtn.textContent = 'Bloquear';
        blockBtn.addEventListener('click', async () => {
          if (confirm(`¿Bloquear a "${u.name}"? No va a poder entrar a la app hasta que lo desbloquees.`)) {
            await setUserStatus(u.id, 'blocked');
          }
        });
      }
      actions.appendChild(blockBtn);

      const deactivateBtn = document.createElement('button');
      deactivateBtn.className = 'btn btn-ghost btn-sm';
      if (status === 'inactive') {
        deactivateBtn.textContent = 'Reactivar';
        deactivateBtn.addEventListener('click', async () => {
          await setUserStatus(u.id, 'active');
        });
      } else {
        deactivateBtn.textContent = 'Dar de baja';
        deactivateBtn.addEventListener('click', async () => {
          if (confirm(`¿Dar de baja a "${u.name}"? Deja de tener acceso a la app. Podés reactivarlo después.`)) {
            await setUserStatus(u.id, 'inactive');
          }
        });
      }
      actions.appendChild(deactivateBtn);
    }

    row.appendChild(actions);
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
// Paginado: solo se leen los últimos `historyLimit` períodos (no todo el
// historial completo cada vez que se abre el panel). "Cargar más" agranda
// el límite y vuelve a suscribirse.
function subscribeHistory() {
  if (unsubHistory) unsubHistory();
  unsubHistory = listenCompletedOrders(profile.salonId, renderHistory, historyLimit);
}

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
        // La recepción ya no vive en una colección aparte: se deriva sumando
        // receivedQuantity de cada línea (item.breakdown, que ya viene con
        // ese dato desde consolidateByProduct). Mismo formato {receivedQuantity,
        // unitPrice} que antes, para no tocar las funciones de exportar a Excel.
        const receivedByProduct = buildReceivedByProductMap(productGroups);
        const anyReceived = histItems.some((i) => typeof i.receivedQuantity === 'number');
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
        const btnXlsx = document.createElement('button');
        btnXlsx.type = 'button';
        btnXlsx.className = 'btn btn-ghost btn-sm';
        btnXlsx.textContent = 'Descargar Excel';
        btnXlsx.addEventListener('click', (e) => {
          e.stopPropagation();
          downloadOrderXlsx(o, productGroups, receivedByProduct, userGroups, categoryById);
        });
        const btnXlsxProvider = document.createElement('button');
        btnXlsxProvider.type = 'button';
        btnXlsxProvider.className = 'btn btn-ghost btn-sm';
        btnXlsxProvider.textContent = 'Descargar por proveedor';
        btnXlsxProvider.addEventListener('click', (e) => {
          e.stopPropagation();
          openProviderExportModal(o, productGroups, receivedByProduct);
        });
        downloadWrap.appendChild(btnTxt);
        downloadWrap.appendChild(btnXlsx);
        downloadWrap.appendChild(btnXlsxProvider);

        topBar.appendChild(switchWrap);
        topBar.appendChild(downloadWrap);
        detail.appendChild(topBar);

        // "Lazo cerrado": una vez que el admin confirma que revisó la
        // recepción, la finaliza y los campos quedan de solo lectura (no
        // se puede seguir editando cantidades recibidas ni asignaciones).
        const finalizeWrap = document.createElement('section');
        finalizeWrap.className = 'mt-4';
        detail.appendChild(finalizeWrap);

        const productSection = document.createElement('section');
        const userSection = document.createElement('section');
        userSection.classList.add('hidden');
        detail.appendChild(productSection);
        detail.appendChild(userSection);

        function renderDetailViews() {
          const ctx = o.receptionFinalized ? null : { salonId: profile.salonId, orderId: o.id, adminUid: user.uid };
          renderHistProductView(productSection, productGroups, categoryById, userById, ctx);
          renderHistUserView(userSection, userGroups, categoryById, userById, receivedByProduct);
        }

        function renderFinalizeControl() {
          finalizeWrap.innerHTML = '';
          if (!anyReceived && !o.receptionFinalized) return; // nada que finalizar todavía
          if (o.receptionFinalized) {
            const badge = document.createElement('p');
            badge.className = 'text-sm status-line-ok';
            const finalizedDate = o.receptionFinalizedAt?.toDate
              ? ` el ${o.receptionFinalizedAt.toDate().toLocaleDateString('es')}`
              : '';
            badge.textContent = `✓ Recepción finalizada${finalizedDate}. Ya no se puede modificar.`;
            finalizeWrap.appendChild(badge);
            return;
          }
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn btn-accent btn-sm';
          btn.textContent = 'Finalizar recepción';
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (
              !confirm(
                '¿Marcar la recepción de este período como finalizada? Ya no se van a poder editar las cantidades recibidas ni las asignaciones por usuario.'
              )
            )
              return;
            btn.disabled = true;
            try {
              await finalizeReception(profile.salonId, o.id, user.uid);
              o.receptionFinalized = true;
              renderFinalizeControl();
              renderDetailViews();
            } catch (err) {
              console.error(err);
              alert('No se pudo finalizar la recepción. Probá de nuevo.');
              btn.disabled = false;
            }
          });
          finalizeWrap.appendChild(btn);
        }

        renderFinalizeControl();
        renderDetailViews();

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

  // Solo aparece si puede haber más períodos viejos sin cargar (llegamos
  // justo al límite pedido); si no, no tiene sentido mostrarlo.
  if (orders.length >= historyLimit) {
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'btn btn-secondary btn-sm mt-4';
    moreBtn.textContent = 'Cargar más períodos';
    moreBtn.addEventListener('click', () => {
      historyLimit += 10;
      subscribeHistory();
    });
    container.appendChild(moreBtn);
  }
}

/** Construye una columna label+valor (mismo estilo que el Historial del usuario básico). */
function buildHistStatEl(label, value, tone = null) {
  const wrap = document.createElement('section');
  wrap.className = 'hist-stat';
  const labelEl = document.createElement('span');
  labelEl.className = 'hist-stat-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = `hist-stat-value${tone ? ' hist-stat-' + tone : ''}`;
  valueEl.textContent = value;
  wrap.appendChild(labelEl);
  wrap.appendChild(valueEl);
  return { wrap, valueEl };
}

/**
 * Deriva, a partir de item.breakdown[].receivedQuantity (que ya trae cada
 * línea desde consolidateByProduct), un mapa productId -> {receivedQuantity,
 * unitPrice} con el total del equipo. Mismo formato que antes usaba la
 * colección "received" aparte, para que las funciones de exportar a Excel y
 * la vista "Por usuario" del Historial no tengan que cambiar.
 */
function buildReceivedByProductMap(groups) {
  const map = new Map();
  for (const group of groups) {
    for (const item of group.items) {
      let sum = 0;
      let any = false;
      let unitPrice = null;
      for (const b of item.breakdown) {
        if (typeof b.receivedQuantity === 'number') {
          sum += b.receivedQuantity;
          any = true;
          if (unitPrice === null && typeof b.receivedUnitPrice === 'number') unitPrice = b.receivedUnitPrice;
        }
      }
      if (any) map.set(item.product.id, { receivedQuantity: sum, unitPrice });
    }
  }
  return map;
}

/** "Cargado por X el 12 jul." — quién y cuándo se registró la recepción de una línea puntual. */
function receivedMetaEl(uid, when, userById) {
  const p = document.createElement('p');
  p.className = 'text-sm text-muted';
  setReceivedMetaText(p, uid, when, userById);
  return p;
}

function setReceivedMetaText(el, uid, when, userById) {
  if (!uid) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const name = userById.get(uid)?.name || 'alguien';
  const dateText = when ? when.toLocaleDateString('es') : 'recién';
  el.textContent = `Cargado por ${name} el ${dateText}`;
}

/** Mapea (hasReceived, diff) a un tono visual — mismo criterio en toda la vista. */
function diffToneFor(hasReceived, diff) {
  return { 'receipt-diff-ok': 'ok', 'receipt-diff-short': 'warn', 'receipt-diff-over': 'warn', 'receipt-diff-pending': 'muted' }[
    receiptDiffClass(hasReceived, diff)
  ];
}

/**
 * La recepción se guarda directo en cada línea de pedido (item.breakdown[].
 * receivedQuantity), no más en una colección aparte por producto. Si un
 * producto lo pidió una sola persona, es un solo input (igual que antes).
 * Si lo pidieron varias, se ve un input por persona siempre — no hay un
 * paso separado de "cuánto llegó en total" y después repartirlo: cargar
 * cuánto le llegó a cada quien ES la acción, así que nunca queda un estado
 * intermedio de "pendiente de asignación".
 */
function renderHistProductView(container, groups, categoryById, userById = new Map(), ctx = null) {
  container.innerHTML = '';
  if (groups.length === 0) {
    container.innerHTML = '<p class="text-sm text-muted">Nadie agregó insumos en este período.</p>';
    return;
  }

  // Total pedido (precio × cantidad pedida) y total recibido (precio ×
  // cantidad recibida) de TODO el equipo, sumando todos los productos.
  // Se recalcula cada vez que se edita un campo "Recibido".
  const costEntries = [];
  let anyPriceKnown = false;
  let totalPedidoValueEl = null;
  let totalRecibidoValueEl = null;
  function recomputeTotals() {
    if (!totalPedidoValueEl) return;
    let totalPedido = 0;
    let totalRecibido = 0;
    for (const e of costEntries) {
      totalPedido += e.pedidoCost;
      totalRecibido += e.recibidoCost;
    }
    totalPedidoValueEl.textContent = formatPrice(totalPedido);
    totalRecibidoValueEl.textContent = formatPrice(totalRecibido);
  }

  for (const group of groups) {
    const catTitle = document.createElement('p');
    catTitle.className = 'text-sm';
    catTitle.style.fontWeight = '600';
    catTitle.style.marginTop = '10px';
    catTitle.textContent = categoryById.get(group.category.id)?.name || group.category.name;
    container.appendChild(catTitle);
    for (const item of group.items) {
      // <section>, no <div>: esto cuelga de .consolidated-row-detail (ver
      // notas más arriba). Reusa la misma grilla de 4 columnas fijas que
      // el Historial del usuario básico, para que Pedido/Precio/Recibido/
      // Diferencia queden siempre alineados sin importar el largo del
      // nombre del producto o de los valores.
      const row = document.createElement('section');
      row.className = 'hist-item';
      const meta = [item.product.brand, item.product.format].filter(Boolean).join(' · ');

      const nameEl = document.createElement('p');
      nameEl.className = 'hist-item-name';
      nameEl.textContent = `${item.product.name}${meta ? ' — ' + meta : ''}`;
      row.appendChild(nameEl);

      const statsEl = document.createElement('section');
      statsEl.className = 'hist-item-stats';

      statsEl.appendChild(buildHistStatEl('Pedido', String(item.totalQuantity)).wrap);

      // Precio "congelado" apenas alguna línea ya tenga recepción registrada;
      // si no, el precio actual del producto (mismo criterio que usa el Excel).
      const frozen = item.breakdown.find((b) => typeof b.receivedUnitPrice === 'number');
      const knownPrice = frozen
        ? frozen.receivedUnitPrice
        : typeof item.product.price === 'number'
          ? item.product.price
          : null;
      if (knownPrice !== null) anyPriceKnown = true;
      statsEl.appendChild(buildHistStatEl('Precio', knownPrice !== null ? formatPrice(knownPrice) : '—', knownPrice === null ? 'muted' : null).wrap);

      const costEntry = { pedidoCost: knownPrice !== null ? item.totalQuantity * knownPrice : 0, recibidoCost: 0 };
      costEntries.push(costEntry);

      const sumReceived = () =>
        item.breakdown.reduce((s, b) => s + (typeof b.receivedQuantity === 'number' ? b.receivedQuantity : 0), 0);
      const anyReceived = () => item.breakdown.some((b) => typeof b.receivedQuantity === 'number');

      const singlePerson = item.breakdown.length === 1;

      if (singlePerson) {
        const b = item.breakdown[0];
        const recibidoWrap = document.createElement('section');
        recibidoWrap.className = 'hist-stat';
        const recibidoLabelEl = document.createElement('span');
        recibidoLabelEl.className = 'hist-stat-label';
        recibidoLabelEl.textContent = 'Recibido';
        const input = document.createElement('input');
        input.className = 'input receipt-input';
        input.type = 'number';
        input.min = '0';
        input.placeholder = '0';
        if (typeof b.receivedQuantity === 'number') input.value = b.receivedQuantity;
        input.disabled = !ctx;
        recibidoWrap.appendChild(recibidoLabelEl);
        recibidoWrap.appendChild(input);
        statsEl.appendChild(recibidoWrap);

        const hasReceived = typeof b.receivedQuantity === 'number';
        const diff = hasReceived ? b.receivedQuantity - item.totalQuantity : 0;
        const diffText = hasReceived ? (diff > 0 ? `+${diff}` : String(diff)) : '—';
        const { wrap: diffWrap, valueEl: diffValueEl } = buildHistStatEl('Diferencia', diffText, diffToneFor(hasReceived, diff));
        statsEl.appendChild(diffWrap);

        costEntry.recibidoCost = knownPrice !== null && hasReceived ? b.receivedQuantity * knownPrice : 0;

        const metaEl = receivedMetaEl(
          b.receivedUpdatedBy,
          b.receivedUpdatedAt?.toDate ? b.receivedUpdatedAt.toDate() : null,
          userById
        );
        row.appendChild(statsEl);
        row.appendChild(metaEl);
        container.appendChild(row);

        if (ctx) {
          input.addEventListener('click', (e) => e.stopPropagation());
          input.addEventListener('change', () => {
            const value = input.value.trim() === '' ? null : Math.max(0, Number(input.value) || 0);
            if (value === null) return;
            // Se guarda el precio ACTUAL del producto como precio "congelado"
            // de esta recepción, para que no cambie si después se edita el
            // precio del producto en el catálogo.
            const unitPrice = typeof item.product.price === 'number' ? item.product.price : null;
            setItemReceivedQuantity(ctx.salonId, ctx.orderId, b.userId, item.product.id, value, ctx.adminUid, unitPrice)
              .then(() => {
                b.receivedQuantity = value;
                b.receivedUnitPrice = unitPrice;
                const d = value - item.totalQuantity;
                diffValueEl.className = `hist-stat-value hist-stat-${d === 0 ? 'ok' : 'warn'}`;
                diffValueEl.textContent = d > 0 ? `+${d}` : String(d);
                setReceivedMetaText(metaEl, ctx.adminUid, new Date(), userById);
                if (unitPrice !== null) {
                  costEntry.pedidoCost = item.totalQuantity * unitPrice;
                  costEntry.recibidoCost = value * unitPrice;
                  recomputeTotals();
                }
              })
              .catch(console.error);
          });
        }
        continue; // ya insertamos row arriba, no repetir abajo
      } else {
        // Varias personas pidieron este producto: "Recibido"/"Diferencia"
        // acá arriba son de solo lectura, la suma de lo que se cargue por
        // persona en la lista de abajo.
        const { wrap: recibidoWrap, valueEl: recibidoValueEl } = buildHistStatEl(
          'Recibido',
          anyReceived() ? String(sumReceived()) : '—',
          anyReceived() ? null : 'muted'
        );
        statsEl.appendChild(recibidoWrap);
        const initialDiff = anyReceived() ? sumReceived() - item.totalQuantity : 0;
        const { wrap: diffWrap, valueEl: diffValueEl } = buildHistStatEl(
          'Diferencia',
          anyReceived() ? (initialDiff > 0 ? `+${initialDiff}` : String(initialDiff)) : '—',
          diffToneFor(anyReceived(), initialDiff)
        );
        statsEl.appendChild(diffWrap);
        costEntry.recibidoCost = knownPrice !== null && anyReceived() ? sumReceived() * knownPrice : 0;

        function refreshAggregate() {
          const has = anyReceived();
          const sum = sumReceived();
          recibidoValueEl.textContent = has ? String(sum) : '—';
          recibidoValueEl.className = `hist-stat-value${has ? '' : ' hist-stat-muted'}`;
          const diff = has ? sum - item.totalQuantity : 0;
          diffValueEl.textContent = has ? (diff > 0 ? `+${diff}` : String(diff)) : '—';
          diffValueEl.className = `hist-stat-value hist-stat-${diffToneFor(has, diff)}`;
          costEntry.recibidoCost = knownPrice !== null && has ? sum * knownPrice : 0;
          recomputeTotals();
        }

        row.appendChild(statsEl);
        container.appendChild(row);

        // <section>, no <div>: cuelga de .consolidated-row-detail.
        const peopleWrap = document.createElement('section');
        peopleWrap.className = 'alloc-panel';
        const peopleLabel = document.createElement('p');
        peopleLabel.className = 'text-sm text-muted';
        peopleLabel.textContent = 'Recibido por persona:';
        peopleWrap.appendChild(peopleLabel);
        for (const b of item.breakdown) {
          // <div> a propósito: dentro de .consolidated-row-detail cualquier
          // <div> hijo recibe display:flex + justify-content:space-between,
          // que es justo el layout label/input que queremos acá.
          const personRow = document.createElement('div');
          personRow.className = 'alloc-row';
          const label = document.createElement('span');
          label.textContent = `${b.userName} (pidió ${b.quantity})`;
          const input = document.createElement('input');
          input.type = 'number';
          input.min = '0';
          input.className = 'input alloc-input';
          if (typeof b.receivedQuantity === 'number') input.value = b.receivedQuantity;
          input.disabled = !ctx;
          personRow.appendChild(label);
          personRow.appendChild(input);
          peopleWrap.appendChild(personRow);

          const metaEl = receivedMetaEl(
            b.receivedUpdatedBy,
            b.receivedUpdatedAt?.toDate ? b.receivedUpdatedAt.toDate() : null,
            userById
          );
          metaEl.style.marginTop = '-4px';
          peopleWrap.appendChild(metaEl);

          if (ctx) {
            input.addEventListener('click', (e) => e.stopPropagation());
            input.addEventListener('change', () => {
              const value = input.value.trim() === '' ? null : Math.max(0, Number(input.value) || 0);
              if (value === null) return;
              const unitPrice = typeof item.product.price === 'number' ? item.product.price : null;
              setItemReceivedQuantity(ctx.salonId, ctx.orderId, b.userId, item.product.id, value, ctx.adminUid, unitPrice)
                .then(() => {
                  b.receivedQuantity = value;
                  b.receivedUnitPrice = unitPrice;
                  setReceivedMetaText(metaEl, ctx.adminUid, new Date(), userById);
                  refreshAggregate();
                })
                .catch(console.error);
            });
          }
        }
        container.appendChild(peopleWrap);
        continue; // ya insertamos row y peopleWrap arriba, no repetir abajo
      }
    }
  }

  if (anyPriceKnown) {
    // <section>, no <div>: esto se inserta dentro de .consolidated-row-detail,
    // que le fuerza display:flex a cualquier <div> hijo.
    const totalWrap = document.createElement('section');
    totalWrap.className = 'order-total mt-4';
    totalWrap.style.flexDirection = 'column';
    totalWrap.style.alignItems = 'stretch';
    totalWrap.style.gap = '6px';

    const pedidoRow = document.createElement('div');
    const pedidoLabel = document.createElement('span');
    pedidoLabel.textContent = 'Total pedido';
    totalPedidoValueEl = document.createElement('span');
    totalPedidoValueEl.className = 'order-total-value';
    pedidoRow.appendChild(pedidoLabel);
    pedidoRow.appendChild(totalPedidoValueEl);

    const recibidoRow = document.createElement('div');
    const recibidoLabel = document.createElement('span');
    recibidoLabel.textContent = 'Total recibido';
    totalRecibidoValueEl = document.createElement('span');
    totalRecibidoValueEl.className = 'order-total-value';
    recibidoRow.appendChild(recibidoLabel);
    recibidoRow.appendChild(totalRecibidoValueEl);

    totalWrap.appendChild(pedidoRow);
    totalWrap.appendChild(recibidoRow);
    container.appendChild(totalWrap);
    recomputeTotals();
  }
}

function renderHistUserView(container, userGroups, categoryById, userById, receivedByProduct = new Map()) {
  container.innerHTML = '';
  if (userGroups.length === 0) {
    container.innerHTML = '<p class="text-sm text-muted">Nadie agregó insumos en este período.</p>';
    return;
  }
  // Misma tarjeta con borde que la vista "Por usuario" del pedido actual
  // (.user-group). Importante: el wrapper va en un <section>, no un <div>,
  // porque esto se inserta dentro de .consolidated-row-detail y esa regla
  // le pone display:flex a CUALQUIER <div> hijo (rompía el layout de la tarjeta).
  for (const group of userGroups) {
    const wrap = document.createElement('section');
    wrap.className = 'user-group';
    const h3 = document.createElement('h3');
    h3.textContent = userById.get(group.userId)?.name || group.userName;
    wrap.appendChild(h3);
    const ul = document.createElement('ul');
    let userTotal = 0;
    let anyPriceKnown = false;
    for (const it of group.items) {
      const li = document.createElement('li');
      const noteSuffix = it.notes ? ` — ${it.notes}` : '';
      const label = [categoryById.get(it.product.categoryId)?.name, it.product.brand, it.product.name]
        .filter(Boolean)
        .join(' · ');
      // Precio congelado al momento de la recepción si ya se registró; si
      // no, el precio actual del producto (mismo criterio que el resto).
      const received = receivedByProduct.get(it.product.id);
      const price = typeof received?.unitPrice === 'number'
        ? received.unitPrice
        : typeof it.product.price === 'number'
          ? it.product.price
          : null;
      const qtyText = price !== null ? `${it.quantity} unidades · ${formatPrice(price)} c/u` : `${it.quantity} unidades`;
      if (price !== null) {
        userTotal += it.quantity * price;
        anyPriceKnown = true;
      }
      li.innerHTML = `<span>${escapeHtml(label)}${escapeHtml(noteSuffix)}</span><span>${escapeHtml(qtyText)}</span>`;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);

    if (anyPriceKnown) {
      // <section>, no <div>: conserva el padding/borde de .order-total
      // (un <div> acá quedaría aplastado por la regla de .consolidated-row-detail).
      const totalRow = document.createElement('section');
      totalRow.className = 'order-total mt-4';
      totalRow.innerHTML = `<span>Total</span><span class="order-total-value">${escapeHtml(formatPrice(userTotal))}</span>`;
      wrap.appendChild(totalRow);
    }

    container.appendChild(wrap);
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

