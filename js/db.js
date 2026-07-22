// Helpers de Firestore: lecturas en tiempo real (onSnapshot) para catálogo y
// pedido, escrituras para cada acción, y funciones puras de consolidación.
import {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
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

export function addProduct(salonId, { name, categoryId, brand, line, shadeCode, format, supplierName, productCode }) {
  return addDoc(productsCol(salonId), {
    name,
    categoryId,
    brand: brand || '',
    line: line || '',
    shadeCode: shadeCode || '',
    format: format || '',
    supplierName: supplierName || '',
    productCode: productCode || '',
    active: true,
  });
}

export function deactivateProduct(salonId, productId) {
  return updateDoc(doc(productsCol(salonId), productId), { active: false });
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
      items: (byCategory.get(category.id) || []).sort((a, b) => a.product.name.localeCompare(b.product.name)),
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
    .map((u) => ({ ...u, items: u.items.sort((a, b) => a.product.name.localeCompare(b.product.name)) }))
    .sort((a, b) => a.userName.localeCompare(b.userName));
}
