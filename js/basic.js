import { requireRole, logout } from './auth.js';
import {
  listenCategories,
  listenProducts,
  listenAllProducts,
  listenCurrentOrder,
  listenOrderItems,
  listenCompletedOrders,
  listenMySubmission,
  submitMyOrder,
  unsubmitMyOrder,
  getOrderDetail,
  setMyItem,
  compareProductsByShade,
} from './db.js';

const STATUS_LABEL = {
  draft: 'Abierto para agregar',
  reviewing: 'En revisión por administración',
  completed: 'Pedido enviado a proveedor',
};

const categoryFilterEl = document.getElementById('categoryFilter');
const brandFilterEl = document.getElementById('brandFilter');
const productGridEl = document.getElementById('productGrid');
const emptyProductsEl = document.getElementById('emptyProducts');
const myOrderGridEl = document.getElementById('myOrderGrid');
const emptyMyOrderEl = document.getElementById('emptyMyOrder');
const catalogViewEl = document.getElementById('catalogView');
const myOrderViewEl = document.getElementById('myOrderView');
const historyViewEl = document.getElementById('historyView');
const statusBadgeEl = document.getElementById('statusBadge');
const periodLabelEl = document.getElementById('periodLabel');
const closedAlertEl = document.getElementById('closedAlert');
const noOrderAlertEl = document.getElementById('noOrderAlert');
const navCatalogBtn = document.getElementById('navCatalog');
const navMyOrderBtn = document.getElementById('navMyOrder');
const navHistoryBtn = document.getElementById('navHistory');
const myOrderBadgeEl = document.getElementById('myOrderBadge');
const submitBarEl = document.getElementById('submitBar');
const submitStatusEl = document.getElementById('submitStatus');
const submitOrderBtnEl = document.getElementById('submitOrderBtn');
const myHistoryListEl = document.getElementById('myHistoryList');
const emptyMyHistoryEl = document.getElementById('emptyMyHistory');
const template = document.getElementById('productCardTemplate');

let categories = [];
let products = [];
let allProducts = [];
let order = null;
let myItems = {}; // productId -> { quantity, notes }
let mySubmission = null;
let activeCategory = 'all';
let activeBrand = 'all';
let activeView = 'catalog';
let itemsUnsub = null;
let submissionUnsub = null;

let user, profile;

init();

async function init() {
  const auth = await requireRole(['basic']);
  user = auth.user;
  profile = auth.profile;

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await logout();
    window.location.href = 'index.html';
  });

  navCatalogBtn.addEventListener('click', () => setView('catalog'));
  navMyOrderBtn.addEventListener('click', () => setView('myOrder'));
  navHistoryBtn.addEventListener('click', () => setView('history'));

  submitOrderBtnEl.addEventListener('click', handleSubmitToggle);

  categoryFilterEl.addEventListener('change', () => {
    activeCategory = categoryFilterEl.value;
    activeBrand = 'all';
    renderBrandFilter();
    renderCatalog();
  });
  brandFilterEl.addEventListener('change', () => {
    activeBrand = brandFilterEl.value;
    renderCatalog();
  });

  listenCategories(profile.salonId, (cats) => {
    categories = cats;
    renderCategoryFilter();
    renderCatalog();
  });

  listenProducts(profile.salonId, (prods) => {
    products = prods;
    renderBrandFilter();
    renderCatalog();
  });

  listenAllProducts(profile.salonId, (prods) => {
    allProducts = prods;
  });

  listenCompletedOrders(profile.salonId, (orders) => {
    renderMyHistory(orders);
  });

  listenCurrentOrder(profile.salonId, (currentOrder) => {
    order = currentOrder;
    updateOrderUI();

    if (itemsUnsub) itemsUnsub();
    if (submissionUnsub) submissionUnsub();
    myItems = {};
    mySubmission = null;
    if (order) {
      itemsUnsub = listenOrderItems(profile.salonId, order.id, (items) => {
        myItems = {};
        for (const item of items) {
          if (item.userId === user.uid) myItems[item.productId] = { quantity: item.quantity, notes: item.notes };
        }
        renderCatalog();
        renderMyOrder();
        updateBadge();
      });
      submissionUnsub = listenMySubmission(profile.salonId, order.id, user.uid, (sub) => {
        mySubmission = sub;
        renderCatalog();
        renderMyOrder();
        updateSubmitBar();
      });
    } else {
      renderCatalog();
      renderMyOrder();
      updateBadge();
    }
    updateSubmitBar();
  });
}

function setView(view) {
  activeView = view;
  catalogViewEl.classList.toggle('hidden', view !== 'catalog');
  myOrderViewEl.classList.toggle('hidden', view !== 'myOrder');
  historyViewEl.classList.toggle('hidden', view !== 'history');
  navCatalogBtn.classList.toggle('active', view === 'catalog');
  navMyOrderBtn.classList.toggle('active', view === 'myOrder');
  navHistoryBtn.classList.toggle('active', view === 'history');
}

function updateOrderUI() {
  if (!order) {
    noOrderAlertEl.classList.remove('hidden');
    closedAlertEl.classList.add('hidden');
    statusBadgeEl.classList.add('hidden');
    periodLabelEl.textContent = 'Sin pedido activo';
    return;
  }
  noOrderAlertEl.classList.add('hidden');
  statusBadgeEl.classList.remove('hidden');
  statusBadgeEl.textContent = STATUS_LABEL[order.status];
  statusBadgeEl.className = `badge badge-${order.status}`;
  periodLabelEl.textContent = `Período: ${formatPeriod(order)}`;
  closedAlertEl.classList.toggle('hidden', order.status === 'draft');
}

function formatPeriod(o) {
  if (!o.periodStart || !o.periodEnd) return '';
  const opts = { day: 'numeric', month: 'short' };
  const start = new Date(o.periodStart + 'T00:00:00').toLocaleDateString('es', opts);
  const end = new Date(o.periodEnd + 'T00:00:00').toLocaleDateString('es', opts);
  return `${start} — ${end}`;
}

function renderCategoryFilter() {
  categoryFilterEl.innerHTML = '';
  categoryFilterEl.appendChild(makeOption('Todas las categorías', 'all'));
  for (const c of categories) categoryFilterEl.appendChild(makeOption(c.name, c.id));
  categoryFilterEl.value = activeCategory;
}

function renderBrandFilter() {
  const inCategory = activeCategory === 'all' ? products : products.filter((p) => p.categoryId === activeCategory);
  const brands = Array.from(new Set(inCategory.map((p) => p.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  brandFilterEl.innerHTML = '';
  brandFilterEl.appendChild(makeOption('Todas las marcas', 'all'));
  for (const brand of brands) brandFilterEl.appendChild(makeOption(brand, brand));
  if (!brands.includes(activeBrand)) activeBrand = 'all';
  brandFilterEl.value = activeBrand;
}

function makeOption(label, value) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  return opt;
}

function disabledNow() {
  return !order || order.status !== 'draft' || !!mySubmission;
}

// ---------------------------------------------------------------------------
// Cierre individual: cada persona puede "cerrar" su propio pedido antes de
// que cierre todo el período. Mientras esté cerrado, no puede modificar sus
// insumos (ver disabledNow) aunque el período siga abierto para el resto.
// ---------------------------------------------------------------------------
function updateSubmitBar() {
  if (!order) {
    submitBarEl.classList.add('hidden');
    return;
  }
  submitBarEl.classList.remove('hidden');
  if (mySubmission) {
    submitStatusEl.textContent = 'Cerraste tu pedido. Ya no se puede modificar.';
    submitOrderBtnEl.textContent = 'Reabrir mi pedido';
    submitOrderBtnEl.disabled = order.status !== 'draft';
  } else {
    submitStatusEl.textContent =
      order.status === 'draft'
        ? 'Cuando termines de agregar insumos, podés cerrar tu pedido.'
        : 'El período ya está cerrado para agregar insumos.';
    submitOrderBtnEl.textContent = 'Cerrar mi pedido';
    submitOrderBtnEl.disabled = order.status !== 'draft';
  }
}

async function handleSubmitToggle() {
  if (!order) return;
  if (mySubmission) {
    try {
      await unsubmitMyOrder(profile.salonId, order.id, user.uid);
    } catch (err) {
      console.error(err);
      alert(explainSubmitError(err));
    }
    return;
  }
  if (!confirm('¿Cerrar tu pedido? No vas a poder modificarlo salvo que lo reabras antes de que cierre el período.')) {
    return;
  }
  try {
    await submitMyOrder(profile.salonId, order.id, user.uid);
  } catch (err) {
    console.error(err);
    alert(explainSubmitError(err));
  }
}

function explainSubmitError(err) {
  if (err?.code === 'permission-denied') {
    return 'No se pudo cerrar el pedido: el servidor todavía no tiene el permiso actualizado para esto. Avisale a quien administra Fluss.';
  }
  return 'No se pudo cerrar el pedido. Probá de nuevo en un momento.';
}

// ---------------------------------------------------------------------------
// Historial: pedidos de períodos ya archivados, filtrado a lo que pedí yo.
// ---------------------------------------------------------------------------
function renderMyHistory(orders) {
  myHistoryListEl.innerHTML = '';
  emptyMyHistoryEl.classList.toggle('hidden', orders.length > 0);
  const productById = new Map(allProducts.map((p) => [p.id, p]));

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
        const { items: histItems, received: histReceived } = await getOrderDetail(profile.salonId, o.id);
        const mine = histItems
          .filter((i) => i.userId === user.uid)
          .map((i) => ({ item: i, product: productById.get(i.productId) }))
          .filter((e) => e.product)
          .sort((a, b) => compareProductsByShade(a.product, b.product));
        const receivedByProduct = new Map(
          histReceived.map((r) => [r.id, { receivedQuantity: r.receivedQuantity, unitPrice: r.unitPrice ?? null }])
        );
        // Cantidad total pedida por producto entre TODO el equipo (no solo yo),
        // para saber si lo que llegó alcanza a cubrir también lo que pedí.
        const totalRequestedByProduct = new Map();
        for (const i of histItems) {
          totalRequestedByProduct.set(i.productId, (totalRequestedByProduct.get(i.productId) || 0) + i.quantity);
        }
        detail.innerHTML = '';
        if (mine.length === 0) {
          detail.innerHTML = '<p class="text-sm text-muted">No pediste insumos en este período.</p>';
          return;
        }

        const mineWithStatus = mine.map(({ item, product }) => {
          const received = receivedByProduct.get(item.productId);
          const hasReceived = !!received && typeof received.receivedQuantity === 'number';
          const totalRequested = totalRequestedByProduct.get(item.productId) || item.quantity;
          const complete = hasReceived && received.receivedQuantity >= totalRequested;
          return { item, product, received, hasReceived, complete };
        });
        const anyReceived = mineWithStatus.some((e) => e.hasReceived);
        const allComplete = anyReceived && mineWithStatus.every((e) => e.complete);

        const statusLine = document.createElement('p');
        statusLine.className = 'text-sm mt-4';
        if (!anyReceived) {
          statusLine.classList.add('status-line-pending');
          statusLine.textContent = 'Todavía no se registró la recepción de este período.';
        } else if (allComplete) {
          statusLine.classList.add('status-line-ok');
          statusLine.textContent = '✓ Llegó todo lo que pediste.';
        } else {
          statusLine.classList.add('status-line-warn');
          statusLine.textContent = '⚠ Llegó incompleto: falta algún producto por recibir.';
        }
        detail.appendChild(statusLine);

        if (histReceived.length > 0) {
          const note = document.createElement('p');
          note.className = 'text-sm text-muted';
          note.textContent = 'Recibido y costo son el total del pedido de todo el equipo, no solo lo tuyo. El precio es el de ese momento, aunque haya cambiado después.';
          detail.appendChild(note);
        }
        for (const { item, product, received, hasReceived, complete } of mineWithStatus) {
          const line = document.createElement('div');
          line.className = 'receipt-line';
          const meta = [product.brand, product.format].filter(Boolean).join(' · ');
          const noteSuffix = item.notes ? ` — ${item.notes}` : '';

          const nameEl = document.createElement('span');
          nameEl.className = 'receipt-name';
          nameEl.textContent = `${product.name}${meta ? ' — ' + meta : ''}${noteSuffix}`;

          const statsEl = document.createElement('span');
          statsEl.className = 'receipt-stats';

          const pedidoEl = document.createElement('span');
          pedidoEl.className = 'receipt-pedido';
          pedidoEl.textContent = `Pedido: ${item.quantity}`;
          statsEl.appendChild(pedidoEl);

          if (hasReceived) {
            const receivedEl = document.createElement('span');
            receivedEl.className = `receipt-diff ${complete ? 'receipt-diff-ok' : 'receipt-diff-short'}`;
            receivedEl.textContent = `Llegó: ${received.receivedQuantity}${complete ? ' ✓' : ' ⚠'}`;
            statsEl.appendChild(receivedEl);

            if (typeof received.unitPrice === 'number') {
              const priceEl = document.createElement('span');
              priceEl.className = 'receipt-pedido';
              priceEl.textContent = `${formatPrice(received.unitPrice)} c/u`;
              statsEl.appendChild(priceEl);

              const costEl = document.createElement('span');
              costEl.className = `receipt-diff ${complete ? 'receipt-diff-ok' : 'receipt-diff-short'}`;
              costEl.textContent = formatPrice(received.receivedQuantity * received.unitPrice);
              statsEl.appendChild(costEl);
            }
          } else {
            const pendingEl = document.createElement('span');
            pendingEl.className = 'receipt-diff receipt-diff-pending';
            pendingEl.textContent = 'Sin registrar';
            statsEl.appendChild(pendingEl);
          }

          line.appendChild(nameEl);
          line.appendChild(statsEl);
          detail.appendChild(line);
        }
      } catch (err) {
        console.error(err);
        detail.innerHTML = '<p class="text-sm text-muted">No se pudo cargar el detalle.</p>';
      }
    });

    myHistoryListEl.appendChild(row);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatPrice(price) {
  if (typeof price !== 'number' || Number.isNaN(price)) return '';
  return price.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0 });
}

function renderCatalog() {
  let visible = activeCategory === 'all' ? products : products.filter((p) => p.categoryId === activeCategory);
  if (activeBrand !== 'all') visible = visible.filter((p) => p.brand === activeBrand);
  visible = visible.slice().sort(compareProductsByShade);
  productGridEl.innerHTML = '';
  emptyProductsEl.classList.toggle('hidden', visible.length > 0);
  for (const product of visible) {
    const local = myItems[product.id] || { quantity: 0, notes: null };
    productGridEl.appendChild(buildProductCard(product, local));
  }
}

function renderMyOrder() {
  const entries = Object.entries(myItems).filter(([, v]) => v.quantity > 0);
  myOrderGridEl.innerHTML = '';
  emptyMyOrderEl.classList.toggle('hidden', entries.length > 0);
  const productById = new Map(products.map((p) => [p.id, p]));
  const sorted = entries
    .map(([productId, local]) => ({ productId, local, product: productById.get(productId) }))
    .filter((e) => e.product)
    .sort((a, b) => compareProductsByShade(a.product, b.product));
  for (const { product, local } of sorted) {
    myOrderGridEl.appendChild(buildProductCard(product, local));
  }

  let total = 0;
  let missingPrice = false;
  for (const { product, local } of sorted) {
    if (typeof product.price === 'number') total += product.price * local.quantity;
    else missingPrice = true;
  }
  const totalWrapEl = document.getElementById('myOrderTotal');
  const totalValueEl = document.getElementById('myOrderTotalValue');
  const totalNoteEl = document.getElementById('myOrderTotalNote');
  if (totalWrapEl && totalValueEl) {
    totalWrapEl.classList.toggle('hidden', sorted.length === 0);
    totalValueEl.textContent = formatPrice(total) + (missingPrice ? ' *' : '');
  }
  if (totalNoteEl) totalNoteEl.classList.toggle('hidden', !(sorted.length > 0 && missingPrice));
}

function updateBadge() {
  const count = Object.values(myItems).filter((v) => v.quantity > 0).length;
  myOrderBadgeEl.textContent = String(count);
  myOrderBadgeEl.classList.toggle('hidden', count === 0);
}

function buildProductCard(product, local) {
  const node = template.content.firstElementChild.cloneNode(true);
  const disabled = disabledNow();

  node.classList.toggle('selected', local.quantity > 0);
  node.querySelector('.product-name').textContent = product.name;
  node.querySelector('.product-meta').textContent = [product.brand, product.line, product.shadeCode, product.format, product.supplierName]
    .filter(Boolean)
    .join(' · ');
  const priceEl = node.querySelector('.product-price');
  if (priceEl) priceEl.textContent = typeof product.price === 'number' ? `Precio: ${formatPrice(product.price)}` : '';

  const valueEl = node.querySelector('.stepper-value');
  valueEl.textContent = String(local.quantity);

  const minusBtn = node.querySelector('.stepper-btn.minus');
  const plusBtn = node.querySelector('.stepper-btn.plus');
  minusBtn.disabled = disabled || local.quantity === 0;
  plusBtn.disabled = disabled;

  minusBtn.addEventListener('click', () => changeQuantity(product.id, local.quantity - 1, local.notes));
  plusBtn.addEventListener('click', () => changeQuantity(product.id, local.quantity + 1, local.notes));

  const noteToggle = node.querySelector('.note-toggle');
  const noteInput = node.querySelector('.note-input');
  if (local.quantity > 0) {
    if (local.notes) {
      noteToggle.classList.add('hidden');
      noteInput.classList.remove('hidden');
      noteInput.value = local.notes;
    } else {
      noteToggle.classList.remove('hidden');
    }
    noteToggle.addEventListener('click', () => {
      noteToggle.classList.add('hidden');
      noteInput.classList.remove('hidden');
      noteInput.focus();
    });
    noteInput.disabled = disabled;
    let debounceTimer;
    noteInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      // Solo actualiza la nota: a propósito NO vuelve a dibujar la grilla acá,
      // para no perder el foco del input mientras la persona sigue escribiendo.
      debounceTimer = setTimeout(() => changeNotesOnly(product.id, local.quantity, noteInput.value), 400);
    });
  } else {
    noteToggle.classList.add('hidden');
    noteInput.classList.add('hidden');
  }

  return node;
}

function changeQuantity(productId, quantity, notes) {
  const clamped = Math.max(0, quantity);
  myItems[productId] = { quantity: clamped, notes: notes || null };
  renderCatalog();
  renderMyOrder();
  updateBadge();
  persistItem(productId, clamped, notes);
}

/** Actualiza solo la nota sin volver a dibujar la grilla (evita perder el foco del input). */
function changeNotesOnly(productId, quantity, notes) {
  myItems[productId] = { quantity, notes: notes || null };
  updateBadge();
  persistItem(productId, quantity, notes);
}

function persistItem(productId, quantity, notes) {
  setMyItem(profile.salonId, order.id, user.uid, profile.name, productId, quantity, notes || null).catch((err) => {
    console.error('No se pudo guardar el cambio:', err);
  });
}
