// ---------------------------------------------------------------------------
// admin-local.js / Pedido actual: dashboard en vivo (consolidado / por
// usuario), modal de fechas del período, y el cierre automático por fecha
// límite. Todo lo que pasa MIENTRAS un período está draft/reviewing.
// El Historial (períodos ya archivados) vive en admin-local-history.js.
// ---------------------------------------------------------------------------
import {
  createOrder,
  startReview,
  reopenDraft,
  closeOrder,
  setAdjustment,
  consolidateByProduct,
  consolidateByUser,
} from './db.js';
import { formatPrice, escapeHtml, formatPeriod, suggestNextPeriod } from './pure.js';
import { state } from './admin-local-state.js';
import { downloadOrderTxt, downloadOrderXlsx, openProviderExportModal } from './admin-local-export.js';

const STATUS_LABEL = {
  draft: 'Abierto para agregar',
  reviewing: 'En revisión por administración',
  completed: 'Pedido enviado a proveedor',
};

let consolidatedView = 'byProduct'; // 'byProduct' | 'byUser'
let autoCloseTicker = null;

/** Wiring que solo hace falta una vez: modal de período, switch de vista, reloj de auto-cierre. */
export function setupDashboard() {
  setupPeriodModal();
  document.getElementById('viewConsolidatedBtn').addEventListener('click', () => switchConsolidatedView('byProduct'));
  document.getElementById('viewByUserBtn').addEventListener('click', () => switchConsolidatedView('byUser'));
  startAutoCloseTicker();
}

// ---------------------------------------------------------------------------
// Dashboard: pedido actual, consolidado / por usuario
// ---------------------------------------------------------------------------
export function renderDashboard() {
  document.getElementById('noOrderCard').classList.toggle('hidden', !!state.order);
  document.getElementById('orderCard').classList.toggle('hidden', !state.order);
  document.getElementById('consolidatedSection').classList.toggle('hidden', !state.order);
  document.getElementById('draftHint').classList.toggle('hidden', !state.order || state.order.status !== 'draft');

  renderActionsBar();

  if (!state.order) {
    updatePendingSubmissionsHint(0);
    return;
  }

  document.getElementById('periodLabel').textContent =
    formatPeriod(state.order, { includeYear: true }) +
    (state.order.status === 'draft' && state.order.periodEndTime ? ` · cierra ${state.order.periodEndTime}` : '');
  const badge = document.getElementById('statusBadge');
  badge.textContent = STATUS_LABEL[state.order.status];
  badge.className = `badge badge-${state.order.status}`;
  updateAutoCloseCountdown();

  // Igual que en el Historial: hasta que alguien no cierre su propio pedido
  // (submissions/{uid}), lo que tenga cargado en el carrito no se le
  // muestra al admin — ni acá en el consolidado en vivo, ni en las
  // estadísticas de arriba.
  const submittedSet = new Set(state.submittedUserIds);
  const visibleItems = state.items.filter((i) => submittedSet.has(i.userId));
  const pendingCount = new Set(state.items.filter((i) => !submittedSet.has(i.userId)).map((i) => i.userId)).size;
  updatePendingSubmissionsHint(pendingCount);

  const groups = consolidateByProduct(visibleItems, state.products, state.categories, state.adjustments);
  const totalProducts = groups.reduce((s, g) => s + g.items.length, 0);
  const totalUnits = groups.reduce((s, g) => s + g.items.reduce((s2, i) => s2 + i.totalQuantity, 0), 0);
  const totalUsers = new Set(visibleItems.map((i) => i.userId)).size;
  document.getElementById('statProducts').textContent = String(totalProducts);
  document.getElementById('statUnits').textContent = String(totalUnits);
  document.getElementById('statUsers').textContent = String(totalUsers);

  renderByProductView(groups);
  renderByUserView(consolidateByUser(visibleItems, state.products));
}

/** Aviso de cuánta gente agregó insumos pero todavía no cerró su propio pedido (por eso no se ve arriba). */
function updatePendingSubmissionsHint(pendingCount) {
  const el = document.getElementById('pendingSubmissionsHint');
  if (!el) return;
  if (!state.order || pendingCount === 0) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.textContent =
    pendingCount === 1
      ? 'Hay 1 persona que agregó insumos pero todavía no cerró su pedido — sus insumos no se muestran acá hasta que lo cierre.'
      : `Hay ${pendingCount} personas que agregaron insumos pero todavía no cerraron su pedido — sus insumos no se muestran acá hasta que lo cierren.`;
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
    openPeriodModal();
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
    try {
      await createOrder(state.profile.salonId, start, end, endTime);
      modal.hidden = true;
    } catch (err) {
      console.error(err);
      // "Ya hay un período abierto..." es nuestro propio error (ver
      // createOrder en db.js) — pasa, por ejemplo, si alguien tenía dos
      // pestañas abiertas y confirmó en ambas. El resto son errores
      // genéricos (red, permisos).
      alert(err?.message?.startsWith('Ya hay un período abierto') ? err.message : 'No se pudo abrir el período. Probá de nuevo.');
    }
  });
}

/**
 * Abre el modal de "nuevo período". Con `prefill` (usado al cerrar un
 * período: ver handleCloseFortnight) carga fechas SUGERIDAS — el admin
 * igual tiene que revisarlas y confirmar, no se crea nada solo.
 */
function openPeriodModal(prefill = null) {
  document.getElementById('periodModalHint').textContent = prefill
    ? 'Sugerimos estas fechas (mismo largo que el período que acabás de cerrar) — revisalas y confirmá, o cambialas.'
    : 'Definí el rango de fechas para este pedido.';
  if (prefill) {
    document.getElementById('periodStartInput').value = prefill.start;
    document.getElementById('periodEndInput').value = prefill.end;
    document.getElementById('periodEndTimeInput').value = prefill.endTime;
  }
  document.getElementById('periodModal').hidden = false;
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

export function maybeAutoCloseDraft() {
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
  const justClosed = state.order;
  try {
    await closeOrder(state.profile.salonId, justClosed.id, state.user.uid);
  } catch (err) {
    console.error(err);
    alert('No se pudo cerrar el período. Probá de nuevo.');
    return;
  }
  // Como solo puede haber un período abierto a la vez, apenas se cierra
  // este le sugerimos al admin las fechas del próximo (arranca hoy, dura
  // lo mismo que el que acaba de cerrar) — pero tiene que confirmarlas
  // (o cambiarlas) él mismo: no se abre nada solo, sin que lo revise.
  openPeriodModal(suggestNextPeriod(justClosed));
}
