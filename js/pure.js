// ---------------------------------------------------------------------------
// Funciones puras de Fluss: sin Firebase, sin DOM, sin `window`. Reciben
// datos y devuelven datos. Viven en su propio archivo a propósito para
// poder testearlas con Vitest sin tener que levantar Firebase ni un
// navegador — antes estaban repartidas (y hasta duplicadas) entre db.js,
// admin-local.js y basic.js.
// ---------------------------------------------------------------------------

/** Compara dos productos por shadeCode (número de tono) y usa el nombre como desempate. */
export function compareProductsByShade(a, b) {
  // Nombre primero (con números incluidos comparados numéricamente: "5/0"
  // antes que "10/1"), y el código de tono como desempate si dos productos
  // tienen el mismo nombre.
  const na = a?.name || '';
  const nb = b?.name || '';
  const nameCmp = na.localeCompare(nb, 'es', { numeric: true, sensitivity: 'base' });
  if (nameCmp !== 0) return nameCmp;
  const ca = a?.shadeCode || '';
  const cb = b?.shadeCode || '';
  return ca.localeCompare(cb, 'es', { numeric: true, sensitivity: 'base' });
}

/**
 * Agrupa las líneas de pedido por producto y por categoría. Aplica el
 * ajuste final del admin (si existe) por encima de lo solicitado.
 */
export function consolidateByProduct(items, products, categories, adjustments = []) {
  const productById = new Map(products.map((p) => [p.id, p]));
  const adjustmentByProduct = new Map(adjustments.map((a) => [a.id, a.adjustedQuantity]));

  const byProduct = new Map();
  for (const item of items) {
    const product = productById.get(item.productId);
    if (!product) continue;
    const entry = byProduct.get(product.id) || {
      product,
      requestedQuantity: 0,
      totalQuantity: 0,
      breakdown: [],
    };
    entry.requestedQuantity += item.quantity;
    entry.totalQuantity += item.quantity;
    entry.breakdown.push({
      userId: item.userId,
      userName: item.userName,
      quantity: item.quantity,
      notes: item.notes,
    });
    byProduct.set(product.id, entry);
  }

  for (const entry of byProduct.values()) {
    if (adjustmentByProduct.has(entry.product.id)) {
      entry.totalQuantity = adjustmentByProduct.get(entry.product.id);
    }
  }

  const byCategory = new Map();
  for (const entry of byProduct.values()) {
    const list = byCategory.get(entry.product.categoryId) || [];
    list.push(entry);
    byCategory.set(entry.product.categoryId, list);
  }

  return categories
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es', { sensitivity: 'base' }))
    .map((category) => ({
      category,
      items: (byCategory.get(category.id) || []).sort((a, b) => compareProductsByShade(a.product, b.product)),
    }))
    .filter((group) => group.items.length > 0);
}

/** Agrupa las líneas de pedido por usuario ("vista por peluquero" del admin). */
export function consolidateByUser(items, products) {
  const productById = new Map(products.map((p) => [p.id, p]));
  const byUser = new Map();
  for (const item of items) {
    const product = productById.get(item.productId);
    if (!product) continue;
    const entry = byUser.get(item.userId) || { userId: item.userId, userName: item.userName, items: [] };
    entry.items.push({ product, quantity: item.quantity, notes: item.notes });
    byUser.set(item.userId, entry);
  }
  return Array.from(byUser.values())
    .map((u) => ({ ...u, items: u.items.sort((a, b) => compareProductsByShade(a.product, b.product)) }))
    .sort((a, b) => a.userName.localeCompare(b.userName));
}

/** Formatea un precio en pesos argentinos, sin decimales. '' si no es un número válido. */
export function formatPrice(price) {
  if (typeof price !== 'number' || Number.isNaN(price)) return '';
  return price.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0 });
}

/** Escapa HTML antes de insertarlo con innerHTML (evita inyección de HTML desde nombres/notas). */
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Clasifica la diferencia recibido-pedido para colorearla (ver .receipt-diff-* en styles.css). */
export function receiptDiffClass(hasReceived, diff) {
  if (!hasReceived) return 'receipt-diff-pending';
  if (diff === 0) return 'receipt-diff-ok';
  return diff < 0 ? 'receipt-diff-short' : 'receipt-diff-over';
}

/**
 * Cuánto de un producto le llegó a UN usuario puntual (no al equipo). La
 * recepción se registra por producto para todo el equipo, así que:
 * - si nadie registró recepción todavía → 'none'.
 * - si llegó >= lo que pidió TODO el equipo → seguro que llegó lo suyo entero.
 * - si esa persona era la única que lo pidió → lo que llegó es, por descarte, todo suyo.
 * - si llegó menos y lo pidió más de una persona → hace falta que el admin
 *   asigne a mano cuánto le toca a cada quien (allocations); hasta que lo
 *   haga, queda 'pending' (no se inventa un número).
 */
export function resolveMyArrived(received, myQuantity, totalRequested, requesterCount, myUid) {
  if (!received || typeof received.receivedQuantity !== 'number') return { state: 'none' };
  if (received.receivedQuantity >= totalRequested) return { state: 'known', quantity: myQuantity };
  if (requesterCount <= 1) return { state: 'known', quantity: received.receivedQuantity };
  const allocations = received.allocations || {};
  if (typeof allocations[myUid] === 'number') return { state: 'known', quantity: allocations[myUid] };
  return { state: 'pending' };
}
