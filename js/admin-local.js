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
  setItemReceivedQuantity,
  consolidateByProduct,
  consolidateByUser,
} from './db.js';
import { formatPrice, escapeHtml, receiptDiffClass, formatPeriod } from './pure.js';
import { buildHistStatEl } from './ui.js';
import { state } from './admin-local-state.js';
import { setupCatalog, renderCategoryOptions, renderProductList } from './admin-local-catalog.js';
import { setupTeam, renderInviteList, renderUserList } from './admin-local-team.js';
import {
  downloadOrderTxt,
  downloadOrderXlsx,
  openProviderExportModal,
  setupProviderExportModal,
} from './admin-local-export.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase-init.js';

const STATUS_LABEL = {
  draft: 'Abierto para agregar',
  reviewing: 'En revisión por administración',
  completed: 'Pedido enviado a proveedor',
};

let consolidatedView = 'byProduct'; // 'byProduct' | 'byUser'
let unsubItems = null;
let unsubAdjustments = null;
let unsubHistory = null;
let historyLimit = 10;

init();

async function init() {
  const auth = await requireRole(['local_admin']);
  state.user = auth.user;
  state.profile = auth.profile;

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await logout();
    window.location.href = 'index.html';
  });

  setupNav();
  setupPeriodModal();
  setupCatalog();
  setupProviderExportModal();
  setupTeam();

  const salonSnap = await getDoc(doc(db, 'salons', state.profile.salonId));
  if (salonSnap.exists()) document.getElementById('salonName').textContent = salonSnap.data().name;

  listenCategories(state.profile.salonId, (cats) => {
    state.categories = cats;
    renderCategoryOptions();
    renderDashboard();
  });

  listenAllProducts(state.profile.salonId, (prods) => {
    state.products = prods;
    renderProductList();
    renderDashboard();
  });

  listenCurrentOrder(state.profile.salonId, (currentOrder) => {
    state.order = currentOrder;
    if (unsubItems) unsubItems();
    if (unsubAdjustments) unsubAdjustments();
    state.items = [];
    state.adjustments = [];
    if (state.order) {
      unsubItems = listenOrderItems(state.profile.salonId, state.order.id, (its) => {
        state.items = its;
        renderDashboard();
      });
      unsubAdjustments = listenAdjustments(state.profile.salonId, state.order.id, (adjs) => {
        state.adjustments = adjs;
        renderDashboard();
      });
    }
    renderDashboard();
    maybeAutoCloseDraft();
  });

  subscribeHistory();
  listenUsersOfSalon(state.profile.salonId, (list) => {
    state.users = list;
    renderUserList(list);
    renderDashboard();
  });
  listenInvitesOfSalon(state.profile.salonId, renderInviteList);

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
  document.getElementById('noOrderCard').classList.toggle('hidden', !!state.order);
  document.getElementById('orderCard').classList.toggle('hidden', !state.order);
  document.getElementById('consolidatedSection').classList.toggle('hidden', !state.order);
  document.getElementById('draftHint').classList.toggle('hidden', !state.order || state.order.status !== 'draft');

  renderActionsBar();

  if (!state.order) return;

  document.getElementById('periodLabel').textContent =
    formatPeriod(state.order, { includeYear: true }) +
    (state.order.status === 'draft' && state.order.periodEndTime ? ` · cierra ${state.order.periodEndTime}` : '');
  const badge = document.getElementById('statusBadge');
  badge.textContent = STATUS_LABEL[state.order.status];
  badge.className = `badge badge-${state.order.status}`;
  updateAutoCloseCountdown();

  const groups = consolidateByProduct(state.items, state.products, state.categories, state.adjustments);
  const totalProducts = groups.reduce((s, g) => s + g.items.length, 0);
  const totalUnits = groups.reduce((s, g) => s + g.items.reduce((s2, i) => s2 + i.totalQuantity, 0), 0);
  const totalUsers = new Set(state.items.map((i) => i.userId)).size;
  document.getElementById('statProducts').textContent = String(totalProducts);
  document.getElementById('statUnits').textContent = String(totalUnits);
  document.getElementById('statUsers').textContent = String(totalUsers);

  renderByProductView(groups);
  renderByUserView(consolidateByUser(state.items, state.products));
}

function renderActionsBar() {
  const bar = document.getElementById('actionsBar');
  bar.innerHTML = '';
  if (!state.order) return;

  if (state.order.status === 'draft') {
    bar.appendChild(makeButton('Cerrar período de solicitud', 'btn-secondary', handleStartReview));
  }

  if (state.order.status === 'reviewing') {
    bar.appendChild(makeButton('Generar PDF de orden', 'btn-secondary', () => window.print()));
    bar.appendChild(makeButton('Descargar TXT', 'btn-secondary', () => downloadOrderTxt()));
    bar.appendChild(makeButton('Descargar Excel', 'btn-secondary', () => downloadOrderXlsx()));
    bar.appendChild(makeButton('Descargar por proveedor', 'btn-secondary', () => openProviderExportModal()));
    bar.appendChild(makeButton('Reabrir para agregar insumos', 'btn-secondary', handleReopenDraft));
    bar.appendChild(makeButton('Cerrar período y enviar', 'btn-accent', handleCloseFortnight));
  }
}

async function handleStartReview() {
  try {
    await startReview(state.profile.salonId, state.order.id);
  } catch (err) {
    console.error(err);
    alert('No se pudo cerrar el período de solicitud. Probá de nuevo.');
  }
}

async function handleReopenDraft() {
  const endOfPeriod = getPeriodEndDate(state.order);
  const pastDeadline = endOfPeriod && new Date() > endOfPeriod;
  const warn = pastDeadline
    ? '\n\nOjo: la fecha/hora de cierre de este período ya pasó, así que se va a volver a cerrar solo apenas alguien tenga el panel abierto unos segundos (o lo vuelva a abrir).'
    : '';
  if (!confirm(`¿Reabrir este período para que el equipo pueda seguir agregando o corrigiendo insumos?${warn}`)) return;
  try {
    await reopenDraft(state.profile.salonId, state.order.id);
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
  const editable = state.order.status === 'draft' || state.order.status === 'reviewing';
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
        setAdjustment(state.profile.salonId, state.order.id, item.product.id, value, state.user.uid).catch(console.error);
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
  const categoryById = new Map(state.categories.map((c) => [c.id, c]));
  const userById = new Map(state.users.map((u) => [u.id, u]));
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
    await createOrder(state.profile.salonId, start, end, endTime);
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
  if (!state.order || state.order.status !== 'draft') return;
  const endOfPeriod = getPeriodEndDate(state.order);
  if (!endOfPeriod) return;
  if (new Date() > endOfPeriod) {
    startReview(state.profile.salonId, state.order.id).catch(console.error);
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
  if (!state.order || state.order.status !== 'draft') {
    el.classList.add('hidden');
    return;
  }
  const endOfPeriod = getPeriodEndDate(state.order);
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
  await closeOrder(state.profile.salonId, state.order.id, state.user.uid);
  // El admin define las fechas del próximo pedido explícitamente desde
  // "No hay un pedido abierto" → no se abre uno automático.
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
// Paginado: solo se leen los últimos `historyLimit` períodos (no todo el
// historial completo cada vez que se abre el panel). "Cargar más" agranda
// el límite y vuelve a suscribirse.
function subscribeHistory() {
  if (unsubHistory) unsubHistory();
  unsubHistory = listenCompletedOrders(state.profile.salonId, renderHistory, historyLimit);
}

function renderHistory(orders) {
  const container = document.getElementById('historyList');
  container.innerHTML = '';
  if (orders.length === 0) {
    container.innerHTML = '<div class="empty-state">Todavía no hay períodos archivados.</div>';
    return;
  }
  const categoryById = new Map(state.categories.map((c) => [c.id, c]));
  const userById = new Map(state.users.map((u) => [u.id, u]));

  for (const o of orders) {
    const row = document.createElement('div');
    row.className = 'consolidated-row';
    const closedDate = o.closedAt?.toDate ? o.closedAt.toDate().toLocaleDateString('es') : '—';
    row.innerHTML = `
      <div class="consolidated-row-head">
        <div>
          <p class="product-name">${escapeHtml(formatPeriod(o, { includeYear: true }))}</p>
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
        const { items: histItems, adjustments: histAdjustments } = await getOrderDetail(state.profile.salonId, o.id);
        const productGroups = consolidateByProduct(histItems, state.products, state.categories, histAdjustments);
        const userGroups = consolidateByUser(histItems, state.products);
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
          const ctx = o.receptionFinalized ? null : { salonId: state.profile.salonId, orderId: o.id, adminUid: state.user.uid };
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
              await finalizeReception(state.profile.salonId, o.id, state.user.uid);
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
            const previousValue = b.receivedQuantity ?? '';
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
              .catch((err) => {
                console.error(err);
                input.value = previousValue;
                alert('No se pudo guardar lo recibido. Probá de nuevo.');
              });
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
              const previousValue = b.receivedQuantity ?? '';
              const unitPrice = typeof item.product.price === 'number' ? item.product.price : null;
              setItemReceivedQuantity(ctx.salonId, ctx.orderId, b.userId, item.product.id, value, ctx.adminUid, unitPrice)
                .then(() => {
                  b.receivedQuantity = value;
                  b.receivedUnitPrice = unitPrice;
                  setReceivedMetaText(metaEl, ctx.adminUid, new Date(), userById);
                  refreshAggregate();
                })
                .catch((err) => {
                  console.error(err);
                  input.value = previousValue;
                  alert('No se pudo guardar lo recibido. Probá de nuevo.');
                });
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

