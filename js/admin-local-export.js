// ---------------------------------------------------------------------------
// Descargar pedido consolidado (TXT / Excel) + modal para elegir proveedor.
// Sin escrituras a Firestore: solo transforma datos y genera el archivo.
// ---------------------------------------------------------------------------
import { consolidateByProduct, consolidateByUser } from './db.js';
import { formatPeriod } from './pure.js';
import { state } from './admin-local-state.js';

let providerExportContext = null;

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

export function downloadOrderTxt(
  o = state.order,
  groups = consolidateByProduct(state.items, state.products, state.categories, state.adjustments)
) {
  const lines = [`Pedido del período — ${formatPeriod(o, { includeYear: true })}`, ''];
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
export function downloadOrderXlsx(
  o = state.order,
  groups = consolidateByProduct(state.items, state.products, state.categories, state.adjustments),
  receivedByProduct = new Map(),
  userGroups = consolidateByUser(state.items, state.products),
  categoryById = new Map(state.categories.map((c) => [c.id, c]))
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
export function downloadOrderXlsxByProvider(
  o = state.order,
  groups = consolidateByProduct(state.items, state.products, state.categories, state.adjustments),
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
export function setupProviderExportModal() {
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

export function openProviderExportModal(
  o = state.order,
  groups = consolidateByProduct(state.items, state.products, state.categories, state.adjustments),
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
