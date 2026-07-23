// ---------------------------------------------------------------------------
// Estado compartido entre admin-local.js y sus módulos (catalog/team/export).
// Es un único objeto mutable a propósito: cada módulo lee state.x y siempre
// ve el valor actual, sin tener que pasarlo como parámetro en cada llamada
// ni duplicar la suscripción a Firestore que lo mantiene actualizado.
// ---------------------------------------------------------------------------

export const state = {
  user: null,
  profile: null,
  categories: [],
  products: [],
  users: [],
  order: null,
  items: [],
  adjustments: [],
};
