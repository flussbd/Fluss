import { requireRole, logout } from './auth.js';
import { listenSalons, createSalon, createInvite } from './db.js';
import { escapeHtml } from './pure.js';

let user, profile;
let salons = [];
let inviteTargetSalonId = null;

init();

async function init() {
  const auth = await requireRole(['platform_admin']);
  user = auth.user;
  profile = auth.profile;

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await logout();
    window.location.href = 'index.html';
  });

  document.getElementById('salonForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('salonNameInput');
    const name = input.value.trim();
    if (!name) return;
    await createSalon(name, user.uid);
    input.value = '';
  });

  setupInviteModal();

  listenSalons((list) => {
    salons = list;
    renderSalons();
  });
}

function setupInviteModal() {
  const modal = document.getElementById('inviteModal');
  document.getElementById('inviteCancelBtn').addEventListener('click', () => {
    modal.hidden = true;
  });
  document.getElementById('inviteConfirmBtn').addEventListener('click', async () => {
    const email = document.getElementById('inviteAdminEmail').value.trim().toLowerCase();
    if (!email || !inviteTargetSalonId) return;
    await createInvite(email, 'local_admin', inviteTargetSalonId, user.uid);
    modal.hidden = true;
    document.getElementById('inviteAdminEmail').value = '';
  });
}

function openInviteModal(salon) {
  inviteTargetSalonId = salon.id;
  document.getElementById('inviteModalSalon').textContent = `Para el salón "${salon.name}"`;
  document.getElementById('inviteModal').hidden = false;
}

function renderSalons() {
  document.getElementById('platformStats').innerHTML = `<span class="stat">${salons.length} salón(es) registrados</span>`;

  const container = document.getElementById('salonList');
  container.innerHTML = '';
  if (salons.length === 0) {
    container.innerHTML = '<div class="empty-state">Todavía no creaste ningún salón.</div>';
    return;
  }
  for (const salon of salons) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const createdDate = salon.createdAt?.toDate ? salon.createdAt.toDate().toLocaleDateString('es') : '—';
    row.innerHTML = `
      <div>
        <p class="list-row-title">${escapeHtml(salon.name)}</p>
        <p class="list-row-sub">Creado el ${createdDate}</p>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = 'Invitar admin local';
    btn.addEventListener('click', () => openInviteModal(salon));
    row.appendChild(btn);
    container.appendChild(row);
  }
}
