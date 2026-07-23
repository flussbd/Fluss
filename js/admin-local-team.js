// ---------------------------------------------------------------------------
// Equipo (invitaciones + usuarios)
// ---------------------------------------------------------------------------
import { createInvite, updateUserName, setUserStatus } from './db.js';
import { escapeHtml } from './pure.js';
import { state } from './admin-local-state.js';
import { doc, deleteDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase-init.js';

export function setupTeam() {
  document.getElementById('inviteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('inviteEmail');
    const email = input.value.trim().toLowerCase();
    if (!email) return;
    try {
      await createInvite(email, 'basic', state.profile.salonId, state.user.uid);
      input.value = '';
    } catch (err) {
      console.error(err);
      alert('No se pudo invitar al usuario. Probá de nuevo.');
    }
  });
}

export function renderInviteList(invites) {
  const container = document.getElementById('inviteList');
  container.innerHTML = '';
  if (invites.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay invitaciones pendientes.</div>';
    return;
  }
  for (const inv of invites) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div>
        <p class="list-row-title">${escapeHtml(inv.id)}</p>
        <p class="list-row-sub">Invitación pendiente</p>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = 'Cancelar';
    btn.addEventListener('click', async () => {
      if (confirm('¿Cancelar esta invitación?')) await deleteDoc(doc(db, 'invites', inv.id));
    });
    row.appendChild(btn);
    container.appendChild(row);
  }
}

// Etiqueta y tono del estado de un usuario básico (no se usa para admins
// locales — a esos solo los gestiona el admin de plataforma).
const USER_STATUS_LABEL = { blocked: 'Bloqueado', inactive: 'De baja' };

export function renderUserList(users) {
  const container = document.getElementById('userList');
  container.innerHTML = '';
  if (users.length === 0) {
    container.innerHTML = '<div class="empty-state">Todavía no hay nadie en el equipo.</div>';
    return;
  }
  for (const u of users) {
    const status = u.status || 'active';
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div>
        <p class="list-row-title">${escapeHtml(u.name)}</p>
        <p class="list-row-sub">${escapeHtml(u.email)}</p>
      </div>
    `;
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';
    actions.style.gap = '10px';

    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = u.role === 'local_admin' ? 'Admin local' : 'Básico';
    actions.appendChild(pill);

    if (status !== 'active' && USER_STATUS_LABEL[status]) {
      const statusPill = document.createElement('span');
      statusPill.className = 'pill pill-warning';
      statusPill.textContent = USER_STATUS_LABEL[status];
      actions.appendChild(statusPill);
    }

    // Un admin local solo puede gestionar (editar nombre, bloquear, dar de
    // baja) a usuarios BÁSICOS de su salón — a otros admins locales los
    // gestiona el admin de plataforma (ver firestore.rules). Se ocultan los
    // controles acá en vez de mostrarlos y que fallen en silencio.
    if (u.role === 'basic') {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-ghost btn-sm';
      editBtn.textContent = 'Editar nombre';
      editBtn.addEventListener('click', async () => {
        const newName = prompt('Nuevo nombre para este usuario:', u.name);
        if (newName === null) return;
        const trimmed = newName.trim();
        if (!trimmed || trimmed === u.name) return;
        try {
          await updateUserName(u.id, trimmed);
        } catch (err) {
          console.error(err);
          alert('No se pudo renombrar al usuario. Probá de nuevo.');
        }
      });
      actions.appendChild(editBtn);

      const blockBtn = document.createElement('button');
      blockBtn.className = 'btn btn-ghost btn-sm';
      if (status === 'blocked') {
        blockBtn.textContent = 'Desbloquear';
        blockBtn.addEventListener('click', async () => {
          try {
            await setUserStatus(u.id, 'active');
          } catch (err) {
            console.error(err);
            alert('No se pudo desbloquear al usuario. Probá de nuevo.');
          }
        });
      } else {
        blockBtn.textContent = 'Bloquear';
        blockBtn.addEventListener('click', async () => {
          if (!confirm(`¿Bloquear a "${u.name}"? No va a poder entrar a la app hasta que lo desbloquees.`)) return;
          try {
            await setUserStatus(u.id, 'blocked');
          } catch (err) {
            console.error(err);
            alert('No se pudo bloquear al usuario. Probá de nuevo.');
          }
        });
      }
      actions.appendChild(blockBtn);

      const deactivateBtn = document.createElement('button');
      deactivateBtn.className = 'btn btn-ghost btn-sm';
      if (status === 'inactive') {
        deactivateBtn.textContent = 'Reactivar';
        deactivateBtn.addEventListener('click', async () => {
          try {
            await setUserStatus(u.id, 'active');
          } catch (err) {
            console.error(err);
            alert('No se pudo reactivar al usuario. Probá de nuevo.');
          }
        });
      } else {
        deactivateBtn.textContent = 'Dar de baja';
        deactivateBtn.addEventListener('click', async () => {
          if (!confirm(`¿Dar de baja a "${u.name}"? Deja de tener acceso a la app. Podés reactivarlo después.`)) return;
          try {
            await setUserStatus(u.id, 'inactive');
          } catch (err) {
            console.error(err);
            alert('No se pudo dar de baja al usuario. Probá de nuevo.');
          }
        });
      }
      actions.appendChild(deactivateBtn);
    }

    row.appendChild(actions);
    container.appendChild(row);
  }
}
