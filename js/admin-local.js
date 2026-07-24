// ---------------------------------------------------------------------------
// admin-local.js: orquestador del panel de administrador local. Solo hace
// login/nav/suscripciones a Firestore — el resto vive en los módulos que
// importa: admin-local-dashboard.js (Pedido actual, en vivo),
// admin-local-history.js (Historial, períodos archivados),
// admin-local-catalog.js, admin-local-team.js, admin-local-export.js.
// ---------------------------------------------------------------------------
import { requireRole, logout } from './auth.js';
import {
  listenCategories,
  listenAllProducts,
  listenCurrentOrder,
  listenOrderItems,
  listenAdjustments,
  listenOrderSubmissions,
  listenUsersOfSalon,
  listenInvitesOfSalon,
} from './db.js';
import { state } from './admin-local-state.js';
import { setupCatalog, renderCategoryOptions, renderProductList } from './admin-local-catalog.js';
import { setupTeam, renderInviteList, renderUserList } from './admin-local-team.js';
import { setupProviderExportModal } from './admin-local-export.js';
import { setupDashboard, renderDashboard, maybeAutoCloseDraft } from './admin-local-dashboard.js';
import { subscribeHistory } from './admin-local-history.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase-init.js';

let unsubItems = null;
let unsubAdjustments = null;
let unsubSubmissions = null;

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
  setupDashboard();
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
    if (unsubSubmissions) unsubSubmissions();
    state.items = [];
    state.adjustments = [];
    state.submittedUserIds = [];
    if (state.order) {
      unsubItems = listenOrderItems(state.profile.salonId, state.order.id, (its) => {
        state.items = its;
        renderDashboard();
      });
      unsubAdjustments = listenAdjustments(state.profile.salonId, state.order.id, (adjs) => {
        state.adjustments = adjs;
        renderDashboard();
      });
      // Igual que en el Historial (ver admin-local-history.js): mientras
      // alguien no cierre su propio pedido, sus líneas no cuentan acá
      // tampoco — ni en el consolidado en vivo, ni en las estadísticas.
      unsubSubmissions = listenOrderSubmissions(state.profile.salonId, state.order.id, (uids) => {
        state.submittedUserIds = uids;
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
