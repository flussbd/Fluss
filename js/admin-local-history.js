// ---------------------------------------------------------------------------
// admin-local.js / Historial: períodos ya archivados (status 'completed').
// Acá vive la vista de recepción — organizada por PROVEEDOR (así llega la
// mercadería, no por categoría de catálogo): un solo botón "Guardar" por
// proveedor guarda de una todas las líneas pendientes de ESE proveedor, con
// el campo "Recibido" prefilled con lo pedido para que alcance con corregir
// las líneas que llegaron distinto. El dashboard en vivo ("Pedido actual")
// vive en admin-local-dashboard.js.
// ---------------------------------------------------------------------------
import {
  listenCompletedOrders,
  getOrderDetail,
  getOrderSubmittedUserIds,
  setItemReceivedQuantity,
  finalizeReception,
  reopenReception,
  consolidateByProduct,
  consolidateByUser,
} from './db.js';
import { formatPrice, escapeHtml, receiptDiffClass, formatPeriod, formatDateTime } from './pure.js';
import { buildHistStatEl } from './ui.js';
import { state } from './admin-local-state.js';
import { downloadOrderTxt, downloadOrderXlsx, openProviderExportModal } from './admin-local-export.js';

let unsubHistory = null;
let historyLimit = 10;

// Paginado: solo se leen los últimos `historyLimit` períodos (no todo el
// historial completo cada vez que se abre el panel). "Cargar más" agranda
// el límite y vuelve a suscribirse.
export function subscribeHistory() {
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
    const closedDate = formatDateTime(o.closedAt?.toDate ? o.closedAt.toDate() : null);
    const closedByName = o.closedBy ? userById.get(o.closedBy)?.name || 'alguien' : null;
    const closedText = `Cerrado el ${closedDate}${closedByName ? ` por ${closedByName}` : ''}`;
    row.innerHTML = `
      <div class="consolidated-row-head">
        <div>
          <p class="product-name">${escapeHtml(formatPeriod(o, { includeYear: true }))}</p>
          <p class="product-meta">${escapeHtml(closedText)}</p>
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
        const [{ items: rawItems, adjustments: histAdjustments }, submittedUserIds] = await Promise.all([
          getOrderDetail(state.profile.salonId, o.id),
          getOrderSubmittedUserIds(state.profile.salonId, o.id),
        ]);
        // Si alguien agregó cosas al carrito pero nunca cerró/envió su
        // propio pedido (submissions/{uid}), esa línea no cuenta acá aunque
        // el admin haya cerrado todo el período — no fue una decisión final
        // de esa persona.
        const submittedSet = new Set(submittedUserIds);
        const histItems = rawItems.filter((i) => submittedSet.has(i.userId));
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

            // Por si se equivocaron en algo y ya habían finalizado: esto
            // vuelve a dejar todo editable (ver reopenReception en db.js).
            const reopenBtn = document.createElement('button');
            reopenBtn.type = 'button';
            reopenBtn.className = 'btn btn-ghost btn-sm mt-4';
            reopenBtn.textContent = 'Reabrir recepción para corregir';
            reopenBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              if (!confirm('¿Reabrir la recepción de este período para corregir algo? Vas a poder volver a editar las cantidades recibidas.')) return;
              reopenBtn.disabled = true;
              try {
                await reopenReception(state.profile.salonId, o.id, state.user.uid);
                o.receptionFinalized = false;
                renderFinalizeControl();
                renderDetailViews();
              } catch (err) {
                console.error(err);
                alert('No se pudo reabrir la recepción. Probá de nuevo.');
                reopenBtn.disabled = false;
              }
            });
            finalizeWrap.appendChild(reopenBtn);
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

/** "Cargado por X el 24/7/2026, 10:05" — quién y cuándo se registró la recepción de una línea puntual. */
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
  el.textContent = `Cargado por ${name} el ${formatDateTime(when)}`;
}

/** Mapea (hasReceived, diff) a un tono visual — mismo criterio en toda la vista. */
function diffToneFor(hasReceived, diff) {
  return { 'receipt-diff-ok': 'ok', 'receipt-diff-short': 'warn', 'receipt-diff-over': 'warn', 'receipt-diff-pending': 'muted' }[
    receiptDiffClass(hasReceived, diff)
  ];
}

/**
 * Le agrega un botón "Editar" a una línea que YA se había guardado — por si
 * el admin se equivocó al cargarla y necesita corregirla, sin tener que
 * reabrir toda la recepción del período ni volver a guardar el resto del
 * proveedor. Al confirmar la corrección vuelve a mostrar "Editar" por si
 * hace falta tocarla de nuevo.
 */
function attachEditControl(holderEl, input, ctx, { userId, productId, unitPrice, onSaved }) {
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn-ghost btn-sm';
  editBtn.textContent = 'Editar';
  holderEl.appendChild(editBtn);

  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    input.disabled = false;
    input.focus();
    editBtn.remove();

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-secondary btn-sm';
    saveBtn.textContent = 'Guardar corrección';
    holderEl.appendChild(saveBtn);

    saveBtn.addEventListener('click', async (e2) => {
      e2.stopPropagation();
      const raw = input.value.trim();
      if (raw === '') {
        alert('Ingresá una cantidad recibida.');
        return;
      }
      const value = Math.max(0, Number(raw) || 0);
      saveBtn.disabled = true;
      try {
        await setItemReceivedQuantity(ctx.salonId, ctx.orderId, userId, productId, value, ctx.adminUid, unitPrice);
        onSaved(value);
        saveBtn.remove();
        attachEditControl(holderEl, input, ctx, { userId, productId, unitPrice, onSaved });
      } catch (err) {
        console.error(err);
        saveBtn.disabled = false;
        alert('No se pudo guardar la corrección. Probá de nuevo.');
      }
    });
  });
}

/**
 * Guarda de una todas las líneas pendientes de UN proveedor (ver
 * renderHistProductView). Si alguna falla, las que sí se guardaron quedan
 * bloqueadas normalmente y las que fallaron se quedan en `pendingLines` para
 * poder reintentar solo esas con un segundo click, sin perder lo que ya
 * quedó guardado.
 */
async function saveProviderBatch(pendingLines, saveBtn, ctx) {
  const parsed = [];
  for (const line of pendingLines) {
    const raw = line.input.value.trim();
    if (raw === '') {
      alert('Completá el campo "Recibido" de todas las líneas antes de guardar (podés dejar 0 si no llegó nada de ese producto).');
      return;
    }
    parsed.push(Math.max(0, Number(raw) || 0));
  }

  saveBtn.disabled = true;
  const originalLabel = saveBtn.textContent;
  saveBtn.textContent = 'Guardando…';

  const results = await Promise.allSettled(
    pendingLines.map((line, i) =>
      setItemReceivedQuantity(ctx.salonId, ctx.orderId, line.userId, line.productId, parsed[i], ctx.adminUid, line.unitPrice)
    )
  );

  const stillPending = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      pendingLines[i].onSaved(parsed[i]);
    } else {
      console.error(r.reason);
      stillPending.push(pendingLines[i]);
    }
  });

  if (stillPending.length > 0) {
    pendingLines.length = 0;
    pendingLines.push(...stillPending);
    saveBtn.disabled = false;
    saveBtn.textContent = originalLabel;
    alert(
      stillPending.length === 1
        ? 'No se pudo guardar 1 línea — quedó habilitada para reintentar.'
        : `No se pudieron guardar ${stillPending.length} líneas — quedaron habilitadas para reintentar.`
    );
  } else {
    saveBtn.remove();
  }
}

/**
 * La recepción se guarda directo en cada línea de pedido (item.breakdown[].
 * receivedQuantity), no en una colección aparte. Se organiza por PROVEEDOR
 * (product.supplierName, "Sin proveedor" para los que no tienen) — así llega
 * la mercadería — con un solo botón "Guardar recepción de [Proveedor]" que
 * guarda de una todas las líneas pendientes de ese proveedor. El campo
 * "Recibido" arranca prefilled con lo pedido (alcanza con corregir las
 * líneas que llegaron distinto). Si un producto lo pidió una sola persona es
 * un input; si lo pidieron varias, un input por persona.
 */
function renderHistProductView(container, groups, categoryById, userById = new Map(), ctx = null) {
  container.innerHTML = '';
  const allItems = groups.flatMap((g) => g.items);
  if (allItems.length === 0) {
    container.innerHTML = '<p class="text-sm text-muted">Nadie agregó insumos en este período.</p>';
    return;
  }

  const byProvider = new Map();
  for (const item of allItems) {
    const providerName = item.product.supplierName || 'Sin proveedor';
    if (!byProvider.has(providerName)) byProvider.set(providerName, []);
    byProvider.get(providerName).push(item);
  }
  const providerNames = Array.from(byProvider.keys()).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));

  // Total pedido (precio × cantidad pedida) y total recibido (precio ×
  // cantidad recibida) de TODO el equipo, sumando todos los proveedores.
  // Va ARRIBA de todo (no al final): con muchos proveedores/productos, nadie
  // quiere scrollear hasta el final solo para ver el total. Arranca oculto
  // (recién sabemos si hay algún precio conocido después de recorrer todo) y
  // se recalcula cada vez que se guarda una tanda de recepción.
  const totalWrap = document.createElement('section');
  totalWrap.className = 'order-total mt-4 hidden';
  totalWrap.style.flexDirection = 'column';
  totalWrap.style.alignItems = 'stretch';
  totalWrap.style.gap = '6px';

  const pedidoRow = document.createElement('div');
  const pedidoLabel = document.createElement('span');
  pedidoLabel.textContent = 'Total pedido';
  const totalPedidoValueEl = document.createElement('span');
  totalPedidoValueEl.className = 'order-total-value';
  pedidoRow.appendChild(pedidoLabel);
  pedidoRow.appendChild(totalPedidoValueEl);

  const recibidoRow = document.createElement('div');
  const recibidoLabel = document.createElement('span');
  recibidoLabel.textContent = 'Total recibido';
  const totalRecibidoValueEl = document.createElement('span');
  totalRecibidoValueEl.className = 'order-total-value';
  recibidoRow.appendChild(recibidoLabel);
  recibidoRow.appendChild(totalRecibidoValueEl);

  totalWrap.appendChild(pedidoRow);
  totalWrap.appendChild(recibidoRow);
  container.appendChild(totalWrap);

  const costEntries = [];
  let anyPriceKnown = false;
  function recomputeTotals() {
    let totalPedido = 0;
    let totalRecibido = 0;
    for (const e of costEntries) {
      totalPedido += e.pedidoCost;
      totalRecibido += e.recibidoCost;
    }
    totalPedidoValueEl.textContent = formatPrice(totalPedido);
    totalRecibidoValueEl.textContent = formatPrice(totalRecibido);
  }

  for (const providerName of providerNames) {
    // El botón "Guardar" de este proveedor se arma más abajo (recién ahí
    // sabemos si quedó alguna línea pendiente), pero se inserta ACÁ, al
    // lado del nombre — por eso el header ya queda armado como fila flex
    // desde el principio y el botón se agrega adentro al final.
    const providerHeader = document.createElement('div');
    providerHeader.style.display = 'flex';
    providerHeader.style.flexWrap = 'wrap';
    providerHeader.style.justifyContent = 'space-between';
    providerHeader.style.alignItems = 'center';
    providerHeader.style.gap = '8px';
    providerHeader.style.marginTop = '14px';

    const providerTitle = document.createElement('p');
    providerTitle.className = 'text-sm';
    providerTitle.style.fontWeight = '600';
    providerTitle.style.margin = '0';
    providerTitle.textContent = providerName;
    providerHeader.appendChild(providerTitle);
    container.appendChild(providerHeader);

    // Líneas de ESTE proveedor que todavía no se guardaron — el botón de
    // abajo las guarda todas juntas (ver saveProviderBatch).
    const pendingLines = [];

    for (const item of byProvider.get(providerName)) {
      // <section>, no <div>: esto cuelga de .consolidated-row-detail (ver
      // notas más arriba). Reusa la misma grilla de 4 columnas fijas que
      // el Historial del usuario básico, para que Pedido/Precio/Recibido/
      // Diferencia queden siempre alineados sin importar el largo del
      // nombre del producto o de los valores.
      const row = document.createElement('section');
      row.className = 'hist-item';
      const meta = [categoryById.get(item.product.categoryId)?.name, item.product.brand, item.product.format]
        .filter(Boolean)
        .join(' · ');

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
      const unitPrice = typeof item.product.price === 'number' ? item.product.price : null;

      if (singlePerson) {
        const b = item.breakdown[0];
        const alreadySaved = typeof b.receivedQuantity === 'number';
        const recibidoWrap = document.createElement('section');
        recibidoWrap.className = 'hist-stat';
        const recibidoLabelEl = document.createElement('span');
        recibidoLabelEl.className = 'hist-stat-label';
        recibidoLabelEl.textContent = 'Recibido';
        const input = document.createElement('input');
        input.className = 'input receipt-input';
        input.type = 'number';
        input.min = '0';
        // Prefilled con lo pedido: en el caso más común (llegó todo) alcanza
        // con guardar tal cual; si llegó distinto, se corrige el número.
        input.value = alreadySaved ? b.receivedQuantity : item.totalQuantity;
        input.disabled = !ctx || alreadySaved;
        input.addEventListener('click', (e) => e.stopPropagation());
        recibidoWrap.appendChild(recibidoLabelEl);
        recibidoWrap.appendChild(input);
        statsEl.appendChild(recibidoWrap);

        const hasReceived = alreadySaved;
        const diff = hasReceived ? b.receivedQuantity - item.totalQuantity : 0;
        const diffText = hasReceived ? (diff > 0 ? `+${diff}` : String(diff)) : '—';
        const { wrap: diffWrap, valueEl: diffValueEl } = buildHistStatEl('Diferencia', diffText, diffToneFor(hasReceived, diff));
        statsEl.appendChild(diffWrap);

        costEntry.recibidoCost = knownPrice !== null && hasReceived ? b.receivedQuantity * knownPrice : 0;

        const lineQty = hasReceived ? b.receivedQuantity : item.totalQuantity;
        const lineTotal = knownPrice !== null ? lineQty * knownPrice : null;
        const { wrap: totalWrap, valueEl: totalValueEl } = buildHistStatEl(
          'Total',
          lineTotal !== null ? formatPrice(lineTotal) : '—',
          lineTotal === null ? 'muted' : null
        );
        statsEl.appendChild(totalWrap);

        const metaEl = receivedMetaEl(
          b.receivedUpdatedBy,
          b.receivedUpdatedAt?.toDate ? b.receivedUpdatedAt.toDate() : null,
          userById
        );
        row.appendChild(statsEl);
        row.appendChild(metaEl);
        container.appendChild(row);

        const onSavedSingle = (value) => {
          b.receivedQuantity = value;
          b.receivedUnitPrice = unitPrice;
          input.value = value;
          input.disabled = true;
          const d = value - item.totalQuantity;
          diffValueEl.className = `hist-stat-value hist-stat-${d === 0 ? 'ok' : 'warn'}`;
          diffValueEl.textContent = d > 0 ? `+${d}` : String(d);
          setReceivedMetaText(metaEl, ctx.adminUid, new Date(), userById);
          totalValueEl.textContent = unitPrice !== null ? formatPrice(value * unitPrice) : '—';
          totalValueEl.className = `hist-stat-value${unitPrice === null ? ' hist-stat-muted' : ''}`;
          if (unitPrice !== null) {
            costEntry.pedidoCost = item.totalQuantity * unitPrice;
            costEntry.recibidoCost = value * unitPrice;
            recomputeTotals();
          }
        };

        if (ctx && !alreadySaved) {
          pendingLines.push({ input, userId: b.userId, productId: item.product.id, unitPrice, onSaved: onSavedSingle });
        } else if (ctx && alreadySaved) {
          // Ya se había guardado: en vez de un input editable de entrada,
          // ofrecemos "Editar" para corregir un error puntual sin tener que
          // reabrir toda la recepción del período.
          attachEditControl(row, input, ctx, { userId: b.userId, productId: item.product.id, unitPrice, onSaved: onSavedSingle });
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

        const initialQty = anyReceived() ? sumReceived() : item.totalQuantity;
        const initialTotal = knownPrice !== null ? initialQty * knownPrice : null;
        const { wrap: totalWrap, valueEl: totalValueEl } = buildHistStatEl(
          'Total',
          initialTotal !== null ? formatPrice(initialTotal) : '—',
          initialTotal === null ? 'muted' : null
        );
        statsEl.appendChild(totalWrap);

        function refreshAggregate() {
          const has = anyReceived();
          const sum = sumReceived();
          recibidoValueEl.textContent = has ? String(sum) : '—';
          recibidoValueEl.className = `hist-stat-value${has ? '' : ' hist-stat-muted'}`;
          const diff = has ? sum - item.totalQuantity : 0;
          diffValueEl.textContent = has ? (diff > 0 ? `+${diff}` : String(diff)) : '—';
          diffValueEl.className = `hist-stat-value hist-stat-${diffToneFor(has, diff)}`;
          costEntry.recibidoCost = knownPrice !== null && has ? sum * knownPrice : 0;
          const qty = has ? sum : item.totalQuantity;
          const total = knownPrice !== null ? qty * knownPrice : null;
          totalValueEl.textContent = total !== null ? formatPrice(total) : '—';
          totalValueEl.className = `hist-stat-value${total === null ? ' hist-stat-muted' : ''}`;
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
          const alreadySaved = typeof b.receivedQuantity === 'number';
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
          // Prefilled con lo pedido por esa persona.
          input.value = alreadySaved ? b.receivedQuantity : b.quantity;
          input.disabled = !ctx || alreadySaved;
          input.addEventListener('click', (e) => e.stopPropagation());
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

          const onSavedPerson = (value) => {
            b.receivedQuantity = value;
            b.receivedUnitPrice = unitPrice;
            input.value = value;
            input.disabled = true;
            setReceivedMetaText(metaEl, ctx.adminUid, new Date(), userById);
            refreshAggregate();
          };

          if (ctx && !alreadySaved) {
            pendingLines.push({ input, userId: b.userId, productId: item.product.id, unitPrice, onSaved: onSavedPerson });
          } else if (ctx && alreadySaved) {
            attachEditControl(personRow, input, ctx, { userId: b.userId, productId: item.product.id, unitPrice, onSaved: onSavedPerson });
          }
        }
        container.appendChild(peopleWrap);
        continue; // ya insertamos row y peopleWrap arriba, no repetir abajo
      }
    }

    if (ctx && pendingLines.length > 0) {
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-secondary btn-sm';
      saveBtn.textContent = `Guardar recepción de ${providerName}`;
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        saveProviderBatch(pendingLines, saveBtn, ctx);
      });
      providerHeader.appendChild(saveBtn);
    }
  }

  if (anyPriceKnown) {
    totalWrap.classList.remove('hidden');
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

    // Total arriba de la lista de productos — si pidió muchas cosas, no hay
    // que scrollear para verlo. Arranca oculto y se completa después.
    // <section>, no <div>: conserva el padding/borde de .order-total (un
    // <div> acá quedaría aplastado por la regla de .consolidated-row-detail).
    const totalRow = document.createElement('section');
    totalRow.className = 'order-total mt-4 hidden';
    totalRow.innerHTML = `<span>Total</span><span class="order-total-value"></span>`;
    wrap.appendChild(totalRow);

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
      totalRow.classList.remove('hidden');
      totalRow.querySelector('.order-total-value').textContent = formatPrice(userTotal);
    }

    container.appendChild(wrap);
  }
}
