import { requireRole, logout } from './auth.js';
import { listenCategories, listenProducts, listenCurrentOrder, listenOrderItems, setMyItem } from './db.js';

const STATUS_LABEL = {
  draft: 'Abierto para agregar',
  reviewing: 'En revisión por administración',
  completed: 'Pedido enviado a proveedor',
};

const tabsEl = document.getElementById('tabs');
const productGridEl = document.getElementById('productGrid');
const emptyProductsEl = document.getElementById('emptyProducts');
const myOrderGridEl = document.getElementById('myOrderGrid');
const emptyMyOrderEl = document.getElementById('emptyMyOrder');
const catalogViewEl = document.getElementById('catalogView');
const myOrderViewEl = document.getElementById('myOrderView');
const statusBadgeEl = document.getElementById('statusBadge');
const periodLabelEl = document.getElementById('periodLabel');
const closedAlertEl = document.getElementById('closedAlert');
const noOrderAlertEl = document.getElementById('noOrderAlert');
const navCatalogBtn = document.getElementById('navCatalog');
const navMyOrderBtn = document.getElementById('navMyOrder');
const myOrderBadgeEl = document.getElementById('myOrderBadge');
const template = document.getElementById('productCardTemplate');

let categories = [];
let products = [];
let order = null;
let myItems = {}; // productId -> { quantity, notes }
let activeCategory = 'all';
let activeView = 'catalog';
let itemsUnsub = null;

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

  listenCategories(profile.salonId, (cats) => {
    categories = cats;
    renderTabs();
    renderCatalog();
  });

  listenProducts(profile.salonId, (prods) => {
    products = prods;
    renderCatalog();
  });

  listenCurrentOrder(profile.salonId, (currentOrder) => {
    order = currentOrder;
    updateOrderUI();

    if (itemsUnsub) itemsUnsub();
    myItems = {};
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
    } else {
      renderCatalog();
      renderMyOrder();
      updateBadge();
    }
  });
}

function setView(view) {
  activeView = view;
  catalogViewEl.classList.toggle('hidden', view !== 'catalog');
  myOrderViewEl.classList.toggle('hidden', view !== 'myOrder');
  navCatalogBtn.classList.toggle('active', view === 'catalog');
  navMyOrderBtn.classList.toggle('active', view === 'myOrder');
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

function renderTabs() {
  tabsEl.innerHTML = '';
  tabsEl.appendChild(makeTab('Todos', 'all'));
  for (const c of categories) tabsEl.appendChild(makeTab(c.name, c.id));
}

function makeTab(label, value) {
  const btn = document.createElement('button');
  btn.className = 'tab' + (activeCategory === value ? ' active' : '');
  btn.textContent = label;
  btn.addEventListener('click', () => {
    activeCategory = value;
    renderTabs();
    renderCatalog();
  });
  return btn;
}

function disabledNow() {
  return !order || order.status !== 'draft';
}

function renderCatalog() {
  const visible = activeCategory === 'all' ? products : products.filter((p) => p.categoryId === activeCategory);
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
  for (const [productId, local] of entries) {
    const product = productById.get(productId);
    if (!product) continue;
    myOrderGridEl.appendChild(buildProductCard(product, local));
  }
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
