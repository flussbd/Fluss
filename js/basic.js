import { requireRole, logout } from './auth.js';
import {
  listenCategories,
  listenProducts,
  listenAllProducts,
  listenCurrentOrder,
  listenOrderItems,
  listenCompletedOrders,
  getCompletedOrdersInMonth,
  getMostRecentCompletedOrder,
  listenMySubmission,
  submitMyOrder,
  unsubmitMyOrder,
  getOrderDetail,
  setMyItem,
  compareProductsByShade,
} from './db.js';
import { formatPrice, escapeHtml, formatPeriod, formatDateTime, lineCost, APP_VERSION } from './pure.js';
import { buildHistStatEl } from './ui.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase-init.js';

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
let historyUnsub = null;
let historyLimit = 10;
// Mientras haya un mes elegido en el filtro, "Mi historial" muestra solo los
// períodos de ese mes (ver renderMonthSummary) — el listener en vivo sigue
// corriendo en segundo plano pero no pisa esa vista (ver subscribeHistory).
let activeMonthFilter = null; // 'YYYY-MM' o null

let user, profile;

init();

async function init() {
  document.getElementById('appVersion').textContent = APP_VERSION;

  const auth = await requireRole(['basic']);
  user = auth.user;
  profile = auth.profile;

  const salonSnap = await getDoc(doc(db, 'salons', profile.salonId));
  if (salonSnap.exists()) document.getElementById('salonName').textContent = salonSnap.data().name;

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

  let productsLoadedOnce = false;
  listenAllProducts(profile.salonId, (prods) => {
    allProducts = prods;
    // Recién con productos cargados tiene sentido calcular el resumen
    // mensual por defecto (necesita el precio de cada producto).
    if (!productsLoadedOnce) {
      productsLoadedOnce = true;
      initDefaultHistoryMonth();
    }
  });

  subscribeHistory();
  setupHistoryMonthFilter();

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
  periodLabelEl.textContent =
    `Período: ${formatPeriod(order)}` + (order.status === 'draft' && order.periodEndTime ? ` · cierra ${order.periodEndTime}` : '');
  closedAlertEl.classList.toggle('hidden', order.status === 'draft');
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
// Paginado: solo se leen los últimos `historyLimit` períodos (no el
// historial completo del salón cada vez que se abre esta pestaña).
// "Cargar más" agranda el límite y vuelve a suscribirse.
function subscribeHistory() {
  if (historyUnsub) historyUnsub();
  historyUnsub = listenCompletedOrders(
    profile.salonId,
    (orders) => {
      if (activeMonthFilter) return;
      renderMyHistory(orders);
    },
    historyLimit
  );
}

// Si la persona ya tocó el selector a mano, no le pisamos la elección con el
// default automático (ver initDefaultHistoryMonth).
let userTouchedMonthFilter = false;

/** Wire del selector "Resumen de un mes" de Mi historial — se llama una vez desde init(). */
function setupHistoryMonthFilter() {
  const input = document.getElementById('historyMonthInput');
  const clearBtn = document.getElementById('historyMonthClearBtn');
  if (!input) return;
  input.addEventListener('change', () => {
    userTouchedMonthFilter = true;
    activeMonthFilter = input.value || null;
    if (activeMonthFilter) {
      clearBtn.classList.remove('hidden');
      renderMonthSummary(activeMonthFilter);
    } else {
      clearBtn.classList.add('hidden');
      document.getElementById('historyMonthSummary').classList.add('hidden');
      subscribeHistory();
    }
  });
  clearBtn.addEventListener('click', () => {
    userTouchedMonthFilter = true;
    input.value = '';
    activeMonthFilter = null;
    clearBtn.classList.add('hidden');
    document.getElementById('historyMonthSummary').classList.add('hidden');
    subscribeHistory();
  });
}

/**
 * Precarga el selector con el mes en curso — o, si ese mes todavía no tiene
 * ningún período cerrado, con el mes del último período cerrado que exista
 * (mismo criterio que en el Historial del admin, ver admin-local-history.js).
 * Se llama recién cuando llega el primer snapshot de productos (ver
 * listenAllProducts en init()) — antes de eso, calcular el resumen daría
 * "sin precios cargados" de pura carrera, no porque realmente falten.
 */
function initDefaultHistoryMonth() {
  if (userTouchedMonthFilter) return;
  const input = document.getElementById('historyMonthInput');
  const clearBtn = document.getElementById('historyMonthClearBtn');
  if (!input) return;
  selectDefaultMonth(input, clearBtn);
}

async function selectDefaultMonth(input, clearBtn) {
  const now = new Date();
  const currentMonthValue = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let defaultValue = currentMonthValue;
  try {
    const [year, month] = currentMonthValue.split('-').map(Number);
    const currentOrders = await getCompletedOrdersInMonth(profile.salonId, year, month);
    if (currentOrders.length === 0) {
      const recent = await getMostRecentCompletedOrder(profile.salonId);
      const recentDate = recent?.closedAt?.toDate ? recent.closedAt.toDate() : null;
      if (recentDate) defaultValue = `${recentDate.getFullYear()}-${String(recentDate.getMonth() + 1).padStart(2, '0')}`;
    }
  } catch (err) {
    console.error(err);
  }
  if (input.value) return;
  input.value = defaultValue;
  activeMonthFilter = defaultValue;
  clearBtn.classList.remove('hidden');
  renderMonthSummary(defaultValue);
}

/**
 * Resumen de UN mes calendario para MI propio historial: trae todos los
 * períodos cerrados ese mes (sin el límite de paginación normal) y muestra
 * mi total personal arriba, seguido de la misma lista expandible de
 * períodos de siempre, acotada a ese mes. A diferencia del resumen del
 * admin, acá no hay desglose por proveedor (el usuario básico no ve
 * proveedores en ningún otro lado de la app).
 */
async function renderMonthSummary(monthValue) {
  const summaryEl = document.getElementById('historyMonthSummary');
  summaryEl.classList.remove('hidden');
  summaryEl.innerHTML = '<p class="text-sm text-muted">Cargando resumen del mes…</p>';
  myHistoryListEl.innerHTML = '<p class="text-sm text-muted">Cargando…</p>';
  emptyMyHistoryEl.classList.add('hidden');

  const [year, month] = monthValue.split('-').map(Number);
  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('es', { month: 'long', year: 'numeric' });

  try {
    const orders = await getCompletedOrdersInMonth(profile.salonId, year, month);
    if (orders.length === 0) {
      summaryEl.innerHTML = `<p class="text-sm text-muted">No hay períodos cerrados en ${escapeHtml(monthLabel)}.</p>`;
      renderMyHistory([]);
      return;
    }

    const productById = new Map(allProducts.map((p) => [p.id, p]));
    let myTotal = 0;
    let anyPriceKnown = false;

    for (const o of orders) {
      const { items: rawItems } = await getOrderDetail(profile.salonId, o.id);
      for (const item of rawItems) {
        if (item.userId !== user.uid) continue;
        const product = productById.get(item.productId);
        const cost = lineCost(item, product);
        if (cost === null) continue;
        anyPriceKnown = true;
        myTotal += cost;
      }
    }

    summaryEl.innerHTML = '';
    const title = document.createElement('h3');
    title.style.marginTop = '0';
    title.textContent = `Resumen de ${monthLabel}`;
    summaryEl.appendChild(title);

    const countNote = document.createElement('p');
    countNote.className = 'text-sm text-muted';
    countNote.textContent = `${orders.length} período${orders.length === 1 ? '' : 's'} cerrado${orders.length === 1 ? '' : 's'} ese mes.`;
    summaryEl.appendChild(countNote);

    if (anyPriceKnown) {
      const totalRow = document.createElement('section');
      totalRow.className = 'order-total mt-4';
      totalRow.innerHTML = `<span>Mi total del mes</span><span class="order-total-value">${escapeHtml(formatPrice(myTotal))}</span>`;
      summaryEl.appendChild(totalRow);
    } else {
      const note = document.createElement('p');
      note.className = 'text-sm text-muted';
      note.textContent = 'Todavía no hay precios cargados para lo que pediste este mes.';
      summaryEl.appendChild(note);
    }

    renderMyHistory(orders);
  } catch (err) {
    console.error(err);
    summaryEl.innerHTML = '<p class="text-sm text-muted">No se pudo cargar el resumen del mes. Probá de nuevo.</p>';
    myHistoryListEl.innerHTML = '';
  }
}

function renderMyHistory(orders) {
  myHistoryListEl.innerHTML = '';
  emptyMyHistoryEl.classList.toggle('hidden', orders.length > 0);
  const productById = new Map(allProducts.map((p) => [p.id, p]));

  for (const o of orders) {
    const row = document.createElement('div');
    row.className = 'consolidated-row';
    const closedDate = formatDateTime(o.closedAt?.toDate ? o.closedAt.toDate() : null);
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
        const { items: histItems } = await getOrderDetail(profile.salonId, o.id);
        const mine = histItems
          .filter((i) => i.userId === user.uid)
          .map((i) => ({ item: i, product: productById.get(i.productId) }))
          .filter((e) => e.product)
          .sort((a, b) => compareProductsByShade(a.product, b.product));
        detail.innerHTML = '';
        if (mine.length === 0) {
          detail.innerHTML = '<p class="text-sm text-muted">No pediste insumos en este período.</p>';
          return;
        }

        // La recepción ahora se carga directo en cada línea de pedido
        // (item.receivedQuantity), así que ya no hay un estado intermedio de
        // "pendiente de asignación": o está cargada, o no.
        const mineWithStatus = mine.map(({ item, product }) => {
          const hasReceived = typeof item.receivedQuantity === 'number';
          const complete = hasReceived && item.receivedQuantity >= item.quantity;
          return { item, product, hasReceived, complete };
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
          statusLine.textContent = '⚠ Llegó incompleto: te faltó algún producto.';
        }
        detail.appendChild(statusLine);

        if (histItems.some((i) => typeof i.receivedQuantity === 'number')) {
          const note = document.createElement('p');
          note.className = 'text-sm text-muted';
          note.textContent = 'El precio y tus totales son los de ese momento, aunque hayan cambiado después.';
          detail.appendChild(note);
        }

        // Filtro por proveedor: solo tiene sentido mostrarlo si pedí de más
        // de uno en este período — si no, es un selector con una sola
        // opción que no filtra nada. Filtra la LISTA de líneas de acá abajo
        // (no los períodos del historial en sí, ver renderMonthSummary para
        // el resumen mensual).
        const providerNames = Array.from(
          new Set(mineWithStatus.map((e) => e.product.supplierName || 'Sin proveedor'))
        ).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
        let providerFilter = 'all';

        if (providerNames.length > 1) {
          const filterWrap = document.createElement('div');
          filterWrap.className = 'field mt-4';
          filterWrap.style.margin = '10px 0 0';
          const filterLabel = document.createElement('label');
          filterLabel.textContent = 'Filtrar por proveedor';
          const select = document.createElement('select');
          select.className = 'input';
          const allOpt = document.createElement('option');
          allOpt.value = 'all';
          allOpt.textContent = 'Todos los proveedores';
          select.appendChild(allOpt);
          for (const name of providerNames) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
          }
          select.addEventListener('click', (e) => e.stopPropagation());
          select.addEventListener('change', (e) => {
            e.stopPropagation();
            providerFilter = select.value;
            renderRows();
          });
          filterWrap.appendChild(filterLabel);
          filterWrap.appendChild(select);
          detail.appendChild(filterWrap);
        }

        // Total del período: lo que efectivamente me llegó a mí (no lo
        // pedido — eso ya lo muestra la columna "Pedido" de cada línea). Va
        // arriba de la lista (no al final) para no tener que scrollear si
        // pedí muchas cosas — arranca oculto y se completa después. Si se
        // filtra por proveedor, pasa a ser el total de SOLO ese proveedor
        // (ver renderRows) — la etiqueta se actualiza para que quede claro.
        const totalWrap = document.createElement('section');
        totalWrap.className = 'order-total mt-4 hidden';
        totalWrap.innerHTML = `<span class="order-total-label">Total</span><span class="order-total-value"></span>`;
        detail.appendChild(totalWrap);

        const rowsContainer = document.createElement('div');
        detail.appendChild(rowsContainer);

        function renderRows() {
          rowsContainer.innerHTML = '';
          const visible =
            providerFilter === 'all'
              ? mineWithStatus
              : mineWithStatus.filter((e) => (e.product.supplierName || 'Sin proveedor') === providerFilter);

          let myPeriodTotalLlegado = 0;
          let myPeriodTotalKnown = false;

          for (const { item, product, hasReceived, complete } of visible) {
            // Ojo: <section>, no <div> — esto se inserta dentro de
            // .consolidated-row-detail, y esa regla le pone display:flex a
            // CUALQUIER <div> hijo (rompía el layout: nombre y stats quedaban
            // en la misma línea en vez de uno debajo del otro).
            const row = document.createElement('section');
            row.className = 'hist-item';
            const meta = [product.brand, product.format].filter(Boolean).join(' · ');
            const noteSuffix = item.notes ? ` — ${item.notes}` : '';

            const nameEl = document.createElement('p');
            nameEl.className = 'hist-item-name';
            nameEl.textContent = `${product.name}${meta ? ' — ' + meta : ''}${noteSuffix}`;
            row.appendChild(nameEl);

            const statsEl = document.createElement('section');
            statsEl.className = 'hist-item-stats';

            statsEl.appendChild(buildHistStat('Pedido', String(item.quantity)));

            if (hasReceived) {
              statsEl.appendChild(
                buildHistStat('Llegó', `${item.receivedQuantity}${complete ? ' ✓' : ' ⚠'}`, complete ? 'ok' : 'warn')
              );
            } else {
              statsEl.appendChild(buildHistStat('Llegó', '—', 'muted'));
            }

            if (typeof item.receivedUnitPrice === 'number') {
              statsEl.appendChild(buildHistStat('Precio', formatPrice(item.receivedUnitPrice)));
              myPeriodTotalKnown = true;

              if (hasReceived) {
                const myArrivedCost = item.receivedQuantity * item.receivedUnitPrice;
                myPeriodTotalLlegado += myArrivedCost;
                statsEl.appendChild(buildHistStat('Mi total', formatPrice(myArrivedCost), complete ? 'ok' : 'warn'));
              } else {
                statsEl.appendChild(buildHistStat('Mi total', '—', 'muted'));
              }
            } else {
              statsEl.appendChild(buildHistStat('Precio', '—', 'muted'));
              statsEl.appendChild(buildHistStat('Mi total', '—', 'muted'));
            }

            row.appendChild(statsEl);
            rowsContainer.appendChild(row);
          }

          totalWrap.querySelector('.order-total-label').textContent =
            providerFilter === 'all' ? 'Total' : `Total (${providerFilter})`;
          if (myPeriodTotalKnown) {
            totalWrap.classList.remove('hidden');
            totalWrap.querySelector('.order-total-value').textContent = formatPrice(myPeriodTotalLlegado);
          } else {
            totalWrap.classList.add('hidden');
          }
        }

        renderRows();
      } catch (err) {
        console.error(err);
        detail.innerHTML = '<p class="text-sm text-muted">No se pudo cargar el detalle.</p>';
      }
    });

    myHistoryListEl.appendChild(row);
  }

  // Solo aparece si puede haber más períodos viejos sin cargar.
  if (orders.length >= historyLimit) {
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'btn btn-secondary btn-sm mt-4';
    moreBtn.textContent = 'Cargar más períodos';
    moreBtn.addEventListener('click', () => {
      historyLimit += 10;
      subscribeHistory();
    });
    myHistoryListEl.appendChild(moreBtn);
  }
}

/** Construye una columna label+valor para la grilla de detalle del Historial. */
function buildHistStat(label, value, tone = null) {
  return buildHistStatEl(label, value, tone).wrap;
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
  node.querySelector('.product-meta').textContent = [product.brand, product.line, product.shadeCode, product.format]
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
  const previous = myItems[productId];
  myItems[productId] = { quantity: clamped, notes: notes || null };
  renderCatalog();
  renderMyOrder();
  updateBadge();
  persistItem(productId, clamped, notes, previous, true);
}

/** Actualiza solo la nota sin volver a dibujar la grilla (evita perder el foco del input). */
function changeNotesOnly(productId, quantity, notes) {
  const previous = myItems[productId];
  myItems[productId] = { quantity, notes: notes || null };
  updateBadge();
  persistItem(productId, quantity, notes, previous, false);
}

function persistItem(productId, quantity, notes, previous, rerenderOnError) {
  setMyItem(profile.salonId, order.id, user.uid, profile.name, productId, quantity, notes || null).catch((err) => {
    console.error('No se pudo guardar el cambio:', err);
    if (previous) {
      myItems[productId] = previous;
    } else {
      delete myItems[productId];
    }
    updateBadge();
    if (rerenderOnError) {
      renderCatalog();
      renderMyOrder();
    }
    alert('No se pudo guardar el cambio. Probá de nuevo.');
  });
}
