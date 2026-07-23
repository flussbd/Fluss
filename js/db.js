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
  limit,
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

// ---------------------------------------------------------------------------
// Suscripciones en tiempo real (catálogo se ve "sin escribir": categorías +
// productos siempre visibles, actualizados solos si el admin agrega algo).
// ---------------------------------------------------------------------------
export function listenCategories(salonId, cb) {
  return onSnapshot(categoriesCol(salonId), (snap) => {
    const cats = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cats.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es', { sensitivity: 'base' }));
    cb(cats);
  });
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

/** Trae una sola vez los ítems y ajustes de un pedido ya cerrado (para el detalle del historial). */
export async function getOrderDetail(salonId, orderId) {
  const [itemsSnap, adjustmentsSnap] = await Promise.all([
    getDocs(itemsCol(salonId, orderId)),
    getDocs(adjustmentsCol(salonId, orderId)),
  ]);
  return {
    items: itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    adjustments: adjustmentsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
}

/**
 * Registra cuánto le llegó realmente a UNA persona de UN producto, directo
 * en su línea de pedido (items/{uid}_{productId}). Reemplaza el viejo
 * esquema de una colección "received" aparte por producto + un mapa de
 * asignación manual: ahora la recepción se carga por persona desde el
 * vamos, así que nunca hace falta "repartir" un número después.
 * Guarda también el precio unitario vigente en ESE momento (congelado): como
 * el precio del producto puede cambiar después, esto fija cuánto costó ese
 * pedido puntual en vez de recalcularlo con el precio actualizado.
 * merge:true para no pisar el resto del documento (productId/userId/etc.).
 */
export function setItemReceivedQuantity(salonId, orderId, uid, productId, quantity, adminUid, unitPrice = null) {
  return setDoc(
    itemRef(salonId, orderId, uid, productId),
    {
      receivedQuantity: quantity,
      receivedUnitPrice: typeof unitPrice === 'number' && !Number.isNaN(unitPrice) ? unitPrice : null,
      receivedUpdatedBy: adminUid,
      receivedUpdatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export function listenAdjustments(salonId, orderId, cb) {
  return onSnapshot(adjustmentsCol(salonId, orderId), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

/**
 * Períodos archivados, del más nuevo al más viejo. Paginado con `limit`
 * (por defecto los últimos 10): sin esto, cada apertura del Historial leía
 * TODOS los períodos que existan para siempre, y ese costo solo crece con
 * el tiempo. Llamar de nuevo con un `maxResults` más grande (re-suscribiendo)
 * para "cargar más".
 */
export function listenCompletedOrders(salonId, cb, maxResults = 10) {
  return onSnapshot(
    query(ordersCol(salonId), where('status', '==', 'completed'), orderBy('closedAt', 'desc'), limit(maxResults)),
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
  // merge:true: si el admin reabrió un borrador después de haber cargado
  // recepción (receivedQuantity), editar la cantidad acá no debe borrarla.
  await setDoc(
    ref,
    {
      productId,
      userId: uid,
      userName,
      quantity,
      notes: notes || null,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
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
export async function createOrder(salonId, periodStart, periodEnd, periodEndTime = '10:00') {
  return addDoc(ordersCol(salonId), {
    status: 'draft',
    periodStart, // string 'YYYY-MM-DD', la define el admin local
    periodEnd,
    periodEndTime: periodEndTime || '10:00', // string 'HH:MM', hora del cierre automático (editable en el modal)
    closedAt: null,
    closedBy: null,
    createdAt: serverTimestamp(),
  });
}

export function startReview(salonId, orderId) {
  return updateDoc(orderRef(salonId, orderId), { status: 'reviewing' });
}

/** Vuelve un pedido "en revisión" a borrador, por si faltó agregar algo antes del cierre final. */
export function reopenDraft(salonId, orderId) {
  return updateDoc(orderRef(salonId, orderId), { status: 'draft' });
}

/**
 * Cierra el "lazo": una vez que el admin revisó que la recepción de este
 * período está bien, la marca como finalizada. Desde ahí las cantidades
 * recibidas y las asignaciones por usuario quedan de solo lectura, para que
 * no se sigan editando después de haber cerrado el tema con el proveedor.
 */
export function finalizeReception(salonId, orderId, adminUid) {
  return updateDoc(orderRef(salonId, orderId), {
    receptionFinalized: true,
    receptionFinalizedAt: serverTimestamp(),
    receptionFinalizedBy: adminUid,
  });
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

/** Edición completa: el admin puede tocar cualquier campo de un producto ya cargado. */
export function updateProduct(salonId, productId, { name, categoryId, brand, line, shadeCode, format, supplierName, productCode, price }) {
  return updateDoc(doc(productsCol(salonId), productId), {
    name,
    categoryId,
    brand: brand || '',
    line: line || '',
    shadeCode: shadeCode || '',
    format: format || '',
    supplierName: supplierName || '',
    productCode: productCode || '',
    price: typeof price === 'number' && !Number.isNaN(price) ? price : null,
  });
}

export function updateUserName(uid, name) {
  return updateDoc(doc(db, 'users', uid), { name });
}

/**
 * Cambia el estado de un usuario: 'active' | 'blocked' | 'inactive'.
 * - El admin local solo puede usar esto con usuarios básicos de su salón
 *   (lo hace cumplir firestore.rules, no esta función).
 * - El admin de plataforma la usa para dar de baja/reactivar un admin local.
 */
export function setUserStatus(uid, status) {
  return updateDoc(doc(db, 'users', uid), { status });
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

/** Da de baja o reactiva un salón (campo "active"). No borra ningún dato. */
export function setSalonActive(salonId, active) {
  return updateDoc(salonRef(salonId), { active });
}

export function updateSalonName(salonId, name) {
  return updateDoc(salonRef(salonId), { name });
}

/** Reasigna un admin local a otro salón (solo admin de plataforma, ver firestore.rules). */
export function reassignLocalAdminSalon(uid, newSalonId) {
  return updateDoc(doc(db, 'users', uid), { salonId: newSalonId });
}

/** Todos los admins locales (de cualquier salón), para la vista del admin de plataforma. */
export function listenLocalAdmins(cb) {
  return onSnapshot(query(collection(db, 'users'), where('role', '==', 'local_admin')), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

// ---------------------------------------------------------------------------
// Funciones puras (comparación, consolidación): viven en pure.js para poder
// testearlas con Vitest sin depender de Firebase. Se re-exportan acá para
// que el resto del código (que ya hace `import { consolidateByProduct, ... }
// from './db.js'`) no tenga que cambiar nada.
// ---------------------------------------------------------------------------
export { compareProductsByShade, consolidateByProduct, consolidateByUser } from './pure.js';
