import { requireRole, logout } from './auth.js';
import {
  listenSalons,
  listenLocalAdmins,
  createSalon,
  createInvite,
  setSalonActive,
  updateSalonName,
  setUserStatus,
  updateUserName,
  reassignLocalAdminSalon,
} from './db.js';
import { escapeHtml } from './pure.js';

let user, profile;
let salons = [];
let localAdmins = [];
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
    try {
      await createSalon(name, user.uid);
      input.value = '';
    } catch (err) {
      console.error(err);
      alert('No se pudo crear el salón. Probá de nuevo.');
    }
  });

  setupInviteModal();

  // Se dibuja de nuevo cada vez que cambia CUALQUIERA de las dos listas
  // (salones o admins locales), porque cada fila de salón muestra sus
  // propios admins.
  listenSalons((list) => {
    salons = list;
    renderSalons();
  });
  listenLocalAdmins((list) => {
    localAdmins = list;
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
    try {
      await createInvite(email, 'local_admin', inviteTargetSalonId, user.uid);
      modal.hidden = true;
      document.getElementById('inviteAdminEmail').value = '';
    } catch (err) {
      console.error(err);
      alert('No se pudo invitar al administrador. Probá de nuevo.');
    }
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
    container.appendChild(buildSalonRow(salon));
  }
}

function buildSalonRow(salon) {
  const active = salon.active !== false;
  const admins = localAdmins.filter((a) => a.salonId === salon.id);
  const createdDate = salon.createdAt?.toDate ? salon.createdAt.toDate().toLocaleDateString('es') : '—';

  const row = document.createElement('div');
  row.className = 'list-row';
  row.style.flexDirection = 'column';
  row.style.alignItems = 'stretch';
  row.style.gap = '10px';

  const head = document.createElement('div');
  head.style.display = 'flex';
  head.style.justifyContent = 'space-between';
  head.style.alignItems = 'center';
  head.style.flexWrap = 'wrap';
  head.style.gap = '10px';
  head.innerHTML = `
    <div>
      <p class="list-row-title">${escapeHtml(salon.name)}${!active ? ' <span class="pill pill-warning">De baja</span>' : ''}</p>
      <p class="list-row-sub">Creado el ${createdDate}</p>
    </div>
  `;

  const headActions = document.createElement('div');
  headActions.style.display = 'flex';
  headActions.style.gap = '8px';
  headActions.style.flexWrap = 'wrap';

  const renameBtn = document.createElement('button');
  renameBtn.className = 'btn btn-ghost btn-sm';
  renameBtn.textContent = 'Renombrar';
  renameBtn.addEventListener('click', async () => {
    const newName = prompt('Nuevo nombre para el salón:', salon.name);
    if (newName === null) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === salon.name) return;
    try {
      await updateSalonName(salon.id, trimmed);
    } catch (err) {
      console.error(err);
      alert('No se pudo renombrar el salón. Probá de nuevo.');
    }
  });
  headActions.appendChild(renameBtn);

  const toggleSalonBtn = document.createElement('button');
  toggleSalonBtn.className = 'btn btn-ghost btn-sm';
  if (active) {
    toggleSalonBtn.textContent = 'Dar de baja salón';
    toggleSalonBtn.addEventListener('click', async () => {
      if (
        confirm(
          `¿Dar de baja "${salon.name}"? El equipo no va a poder seguir usando la app (catálogo, pedidos), pero no se borra ningún dato y podés reactivarlo cuando quieras.`
        )
      ) {
        try {
          await setSalonActive(salon.id, false);
        } catch (err) {
          console.error(err);
          alert('No se pudo dar de baja el salón. Probá de nuevo.');
        }
      }
    });
  } else {
    toggleSalonBtn.textContent = 'Reactivar salón';
    toggleSalonBtn.addEventListener('click', async () => {
      try {
        await setSalonActive(salon.id, true);
      } catch (err) {
        console.error(err);
        alert('No se pudo reactivar el salón. Probá de nuevo.');
      }
    });
  }
  headActions.appendChild(toggleSalonBtn);

  const inviteBtn = document.createElement('button');
  inviteBtn.className = 'btn btn-secondary btn-sm';
  inviteBtn.textContent = 'Invitar admin local';
  inviteBtn.addEventListener('click', () => openInviteModal(salon));
  headActions.appendChild(inviteBtn);

  head.appendChild(headActions);
  row.appendChild(head);

  const adminsWrap = document.createElement('div');
  adminsWrap.style.display = 'flex';
  adminsWrap.style.flexDirection = 'column';
  adminsWrap.style.gap = '6px';
  if (admins.length === 0) {
    const p = document.createElement('p');
    p.className = 'list-row-sub';
    p.textContent = 'Sin administrador local todavía.';
    adminsWrap.appendChild(p);
  } else {
    for (const admin of admins) {
      adminsWrap.appendChild(buildAdminRow(admin, salon));
    }
  }
  row.appendChild(adminsWrap);

  return row;
}

function buildAdminRow(admin, salon) {
  const isInactive = (admin.status || 'active') !== 'active';

  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.justifyContent = 'space-between';
  wrap.style.alignItems = 'center';
  wrap.style.flexWrap = 'wrap';
  wrap.style.gap = '8px';
  wrap.style.padding = '8px 10px';
  wrap.style.background = 'var(--accent-soft)';
  wrap.style.borderRadius = '10px';

  const info = document.createElement('div');
  info.innerHTML = `
    <p class="list-row-title" style="font-size:14px">${escapeHtml(admin.name)}${
    isInactive ? ' <span class="pill pill-warning">De baja</span>' : ''
  }</p>
    <p class="list-row-sub">${escapeHtml(admin.email)}</p>
  `;
  wrap.appendChild(info);

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '6px';
  actions.style.alignItems = 'center';
  actions.style.flexWrap = 'wrap';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-ghost btn-sm';
  editBtn.textContent = 'Editar nombre';
  editBtn.addEventListener('click', async () => {
    const newName = prompt('Nuevo nombre para este admin:', admin.name);
    if (newName === null) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === admin.name) return;
    try {
      await updateUserName(admin.id, trimmed);
    } catch (err) {
      console.error(err);
      alert('No se pudo renombrar al administrador. Probá de nuevo.');
    }
  });
  actions.appendChild(editBtn);

  // Reasignar a otro salón: un <select> con el resto de los salones.
  if (salons.length > 1) {
    const select = document.createElement('select');
    select.className = 'input';
    select.style.width = 'auto';
    select.style.padding = '4px 8px';
    select.style.fontSize = '13px';
    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = 'Reasignar a...';
    select.appendChild(placeholderOpt);
    for (const s of salons) {
      if (s.id === salon.id) continue;
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      select.appendChild(opt);
    }
    select.addEventListener('change', async () => {
      const newSalonId = select.value;
      if (!newSalonId) return;
      const targetSalon = salons.find((s) => s.id === newSalonId);
      const ok = confirm(`¿Mover a "${admin.name}" al salón "${targetSalon?.name || newSalonId}"?`);
      select.value = '';
      if (!ok) return;
      try {
        await reassignLocalAdminSalon(admin.id, newSalonId);
      } catch (err) {
        console.error(err);
        alert('No se pudo reasignar al administrador. Probá de nuevo.');
      }
    });
    actions.appendChild(select);
  }

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn btn-ghost btn-sm';
  if (isInactive) {
    toggleBtn.textContent = 'Reactivar';
    toggleBtn.addEventListener('click', async () => {
      try {
        await setUserStatus(admin.id, 'active');
      } catch (err) {
        console.error(err);
        alert('No se pudo reactivar al administrador. Probá de nuevo.');
      }
    });
  } else {
    toggleBtn.textContent = 'Dar de baja';
    toggleBtn.addEventListener('click', async () => {
      if (!confirm(`¿Dar de baja a "${admin.name}"? Deja de poder entrar a la app. Podés reactivarlo después.`)) return;
      try {
        await setUserStatus(admin.id, 'inactive');
      } catch (err) {
        console.error(err);
        alert('No se pudo dar de baja al administrador. Probá de nuevo.');
      }
    });
  }
  actions.appendChild(toggleBtn);

  wrap.appendChild(actions);
  return wrap;
}
