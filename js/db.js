// Helpers de Firestore: lecturas en tiempo real (onSnapshot) para catálogo y
// pedido, escrituras para cada acción, y funciones puras de consolidación.
import {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase-init.js';

// ---------------------------------------------------------------------------
// Referencias
// ---------------------------------------------------------------------------
const salonRef = (salonId) => doc(db, 'salons', salonId);
const categoriesCol = (salonId) => collection(db, 'salons', salonId, 'categories');
const productsCol = (salonId) => collection(db, 'salons', salonId, 'products');
const ordersCol = (salonId) => collection(db, 'salons', salonId, 'orders');
const orderRef = (salonId, orderId) => doc(db, 'salons', salonId, 'orders', orderId);
const itemsCol = (salonId, orderId) => collection(db, 'salons', salonId, 'orders', orderId, 'items');
const itemRef = (salonId, orderId, uid, productId) =>
  doc(db, 'salons', salonId, 'orders', orderId, 'items', `${uid}_${productId}`);
const adjustmentsCol = (salonId, orderId) => collection(db, 'salons', salonId, 'orders', orderId, 'adjustments');
const adjustmentRef = (salonId, orderId, productId) =>
  doc(db, 'salons', salonId, 'orders', orderId, 'adjustments', productId);
const submissionRef = (salonId, orderId, uid) => doc(db, 'salons', salonId, 'orders', orderId, 'submissions', uid);
const receivedCol = (salonId, orderId) => collection(db, 'salons', salonId, 'orders', orderId, 'received');
const receivedRef = (salonId, orderId, productId) =>
  doc(db, 'salons', salonId, 'orders', orderId, 'received', productId);

// ---------------------------------------------------------------------------
// Suscripciones en tiempo real (catálogo se ve "sin escribir": categorías +
// productos siempre visibles, actualizados solos si el admin agrega algo).
// ---------------------------------------------------------------------------
export function listenCategories(salonId, cb) {
  return onSnapshot(query(categoriesCol(salonId), orderBy('sortOrder')), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export function listenProducts(salonId, cb) {
  return onSnapshot(query(productsCol(salonId), where('active', '==', true)), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

/** Todos los productos (activos e inactivos) — para el panel de Catálogo del admin. */
export function listenAllProducts(salonId, cb) {
  return onSnapshot(productsCol(salonId), (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

/** Pedido "actual" = el único en draft o reviewing. Si no hay ninguno, cb(null). */
export function listenCurrentOrder(salonId, cb) {
  return onSnapshot(query(ordersCol(salonId), where('status', 'in', ['draft', 'reviewing'])), (snap) => {
    if (snap.empty) return cb(null);
    const d = snap.docs[0];
    cb({ id: d.id, ...d.data() });
  });
}

export function listenOrderItems(salonId, orderId, cb) {
  return onSnapshot(itemsCol(salonId, orderId), (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

/** Trae una sola vez los ítems, ajustes y recepción de un pedido ya cerrado (para el detalle del historial). */
export async function getOrderDetail(salonId, orderId) {
  const [itemsSnap, adjustmentsSnap, receivedSnap] = await Promise.all([
    getDocs(itemsCol(salonId, orderId)),
    getDocs(adjustmentsCol(salonId, orderId)),
    getDocs(receivedCol(salonId, orderId)),
  ]);
  return {
    items: itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    adjustments: adjustmentsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    received: receivedSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
}

/** Registra cuánto llegó realmente de un producto para un pedido ya archivado. */
export function setReceivedQuantity(salonId, orderId, productId, quantity, adminUid) {
  return setDoc(receivedRef(salonId, orderId, productId), {
    receivedQuantity: quantity,
    updatedBy: adminUid,
    updatedAt: serverTimestamp(),
  });
}

export function listenAdjustments(salonId, orderId, cb) {
  return onSnapshot(adjustmentsCol(salonId, orderId), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export function listenCompletedOrders(salonId, cb) {
  return onSnapshot(
    query(ordersCol(salonId), where('status', '==', 'completed'), orderBy('closedAt', 'desc')),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export function listenUsersOfSalon(salonId, cb) {
  return onSnapshot(query(collection(db, 'users'), where('salonId', '==', salonId)), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export function listenInvitesOfSalon(salonId, cb) {
  return onSnapshot(query(collection(db, 'invites'), where('salonId', '==', salonId)), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export function listenSalons(cb) {
  return onSnapshot(query(collection(db, 'salons'), orderBy('createdAt', 'desc')), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

// ---------------------------------------------------------------------------
// Escrituras — usuario básico
// ---------------------------------------------------------------------------
export async function setMyItem(salonId, orderId, uid, userName, productId, quantity, notes) {
  const ref = itemRef(salonId, orderId, uid, productId);
  if (quantity <= 0) {
    await deleteDoc(ref);
    return;
  }
  await setDoc(ref, {
    productId,
    userId: uid,
    userName,
    quantity,
    notes: notes || null,
    updatedAt: serverTimestamp(),
  });
}

/** Existe o no un doc en submissions/{uid}: existe = esa persona ya "cerró" su pedido. */
export function listenMySubmission(salonId, orderId, uid, cb) {
  return onSnapshot(submissionRef(salonId, orderId, uid), (snap) => cb(snap.exists() ? snap.data() : null));
}

export function submitMyOrder(salonId, orderId, uid) {
  return setDoc(submissionRef(salonId, orderId, uid), { submittedAt: serverTimestamp() });
}

export function unsubmitMyOrder(salonId, orderId, uid) {
  return deleteDoc(submissionRef(salonId, orderId, uid));
}

// ---------------------------------------------------------------------------
// Escrituras — administrador local
// ---------------------------------------------------------------------------
export async function createOrder(salonId, periodStart, periodEnd) {
  return addDoc(ordersCol(salonId), {
    status: 'draft',
    periodStart, // string 'YYYY-MM-DD', la define el admin local
    periodEnd,
    closedAt: null,
    closedBy: null,
    createdAt: serverTimestamp(),
  });
}

export function startReview(salonId, orderId) {
  return updateDoc(orderRef(salonId, orderId), { status: 'reviewing' });
}

export function closeOrder(salonId, orderId, adminUid) {
  return updateDoc(orderRef(salonId, orderId), {
    status: 'completed',
    closedAt: serverTimestamp(),
    closedBy: adminUid,
  });
}

export function setAdjustment(salonId, orderId, productId, quantity, adminUid) {
  return setDoc(adjustmentRef(salonId, orderId, productId), {
    adjustedQuantity: quantity,
    updatedBy: adminUid,
    updatedAt: serverTimestamp(),
  });
}

export function addCategory(salonId, name, sortOrder) {
  return addDoc(categoriesCol(salonId), { name, sortOrder });
}

export function addProduct(salonId, { name, categoryId, brand, line, shadeCode, format, supplierName, productCode, price }) {
  return addDoc(productsCol(salonId), {
    name,
    categoryId,
    brand: brand || '',
    line: line || '',
    shadeCode: shadeCode || '',
    format: format || '',
    supplierName: supplierName || '',
    productCode: productCode || '',
    price: typeof price === 'number' && !Number.isNaN(price) ? price : null,
    active: true,
  });
}

export function deactivateProduct(salonId, productId) {
  return updateDoc(doc(productsCol(salonId), productId), { active: false });
}

export function activateProduct(salonId, productId) {
  return updateDoc(doc(productsCol(salonId), productId), { active: true });
}

export function updateProductPrice(salonId, productId, price) {
  return updateDoc(doc(productsCol(salonId), productId), {
    price: typeof price === 'number' && !Number.isNaN(price) ? price : null,
  });
}

export function updateUserName(uid, name) {
  return updateDoc(doc(db, 'users', uid), { name });
}

export function createInvite(email, role, salonId, invitedBy) {
  return setDoc(doc(db, 'invites', email.toLowerCase()), {
    role,
    salonId,
    invitedBy,
    createdAt: serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// Escrituras — administrador plataforma
// ---------------------------------------------------------------------------
export async function createSalon(name, createdBy) {
  return addDoc(collection(db, 'salons'), { name, createdBy, createdAt: serverTimestamp() });
}

// ---------------------------------------------------------------------------
// Orden "natural" por tono/código (ej: 5/0, 7NN, 10GI) en vez de alfabético.
// ---------------------------------------------------------------------------

/** Compara dos productos por shadeCode (número de tono) y usa el nombre como desempate. */
export function compareProductsByShade(a, b) {
  const ca = a?.shadeCode || '';
  const cb = b?.shadeCode || '';
  if (ca && cb) {
    const cmp = ca.localeCompare(cb, 'es', { numeric: true, sensitivity: 'base' });
    if (cmp !== 0) return cmp;
  } else if (Boolean(ca) !== Boolean(cb)) {
    // Los que tienen tono definido van primero, los que no quedan al final.
    return ca ? -1 : 1;
  }
  return (a?.name || '').localeCompare(b?.name || '', 'es', { sensitivity: 'base' });
}

// ---------------------------------------------------------------------------
// Consolidación (funciones puras, sin dependencia de Firestore)
// ---------------------------------------------------------------------------

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
    .sort((a, b) => a.sortOrder - b.sortOrder)
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
