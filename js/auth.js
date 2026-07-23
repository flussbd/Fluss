// Autenticación (Google + email/contraseña) y resolución de rol/salón.
//
// Patrón de alta sin backend propio: un admin (plataforma o local) crea un
// documento en /invites/{email}. La primera vez que esa persona inicia
// sesión, el propio cliente busca la invitación con su email y crea su
// perfil en /users/{uid} con el rol y salonId que indica la invitación
// (firestore.rules valida que coincidan exactamente). Si no hay perfil ni
// invitación, se la manda a pending.html.
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { auth, db } from './firebase-init.js';

export { auth };

export function loginWithGoogle() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export async function signUpWithEmail(email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await sendEmailVerification(cred.user);
  return cred;
}

export function loginWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

/** Manda el email de "restablecer contraseña" de Firebase a esa dirección. */
export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

/** Reenvía el email de verificación de Firebase a la cuenta ya logueada (pantalla "cuenta pendiente"). */
export function resendVerificationEmail(user) {
  return sendEmailVerification(user);
}

export function logout() {
  return signOut(auth);
}

/**
 * Devuelve el perfil (/users/{uid}) de la persona logueada. Si no existe
 * pero hay una invitación pendiente para su email, la reclama y crea el
 * perfil. Si no hay ni perfil ni invitación, devuelve null (cuenta pendiente
 * de aprobación).
 */
export async function resolveProfile(user) {
  const profileRef = doc(db, 'users', user.uid);
  const profileSnap = await getDoc(profileRef);
  if (profileSnap.exists()) return { id: profileSnap.id, ...profileSnap.data() };

  const email = (user.email || '').toLowerCase();
  const inviteRef = doc(db, 'invites', email);
  const inviteSnap = await getDoc(inviteRef);
  if (!inviteSnap.exists()) return null;

  // Para altas por email/contraseña exigimos el email verificado antes de
  // reclamar la invitación (Google ya viene verificado por Google).
  if (user.providerData.some((p) => p.providerId === 'password') && !user.emailVerified) {
    return { pendingEmailVerification: true };
  }

  const invite = inviteSnap.data();
  const newProfile = {
    name: user.displayName || email,
    email: user.email,
    role: invite.role,
    salonId: invite.salonId,
    status: 'active',
    photoURL: user.photoURL || null,
    createdAt: serverTimestamp(),
  };
  await setDoc(profileRef, newProfile);
  await deleteDoc(inviteRef);
  return { id: user.uid, ...newProfile };
}

const ROLE_HOME = {
  platform_admin: 'admin-plataforma.html',
  local_admin: 'admin-local.html',
  basic: 'basic.html',
};

export function homeForRole(role) {
  return ROLE_HOME[role] || 'pending.html';
}

/**
 * Chequea si un perfil YA resuelto puede entrar a la app: no bloqueado, no
 * dado de baja, y (si no es admin de plataforma) su salón sigue activo.
 * Se comparte entre requireRole() (guardia normal de cada página) y
 * pending.html (botón "reintentar"), para no repetir la misma lógica dos
 * veces y que se puedan desincronizar con el tiempo.
 */
export async function checkAccountAccess(profile) {
  // Usuario bloqueado (reversible, admin local) o dado de baja (admin de
  // plataforma): pierde el acceso aunque su perfil siga existiendo.
  const status = profile.status || 'active';
  if (status === 'blocked') return { ok: false, reason: 'blocked' };
  if (status === 'inactive') return { ok: false, reason: 'inactive' };

  // Admin de plataforma no depende de ningún salón puntual. Para el resto,
  // si el admin de plataforma dio de baja el salón, no se puede seguir
  // usando la app (aunque el historial siga siendo legible por otro lado).
  if (profile.role !== 'platform_admin' && profile.salonId) {
    const salonSnap = await getDoc(doc(db, 'salons', profile.salonId));
    const salonActive = !salonSnap.exists() || salonSnap.data().active !== false;
    if (!salonActive) return { ok: false, reason: 'salon-inactive' };
  }
  return { ok: true };
}

/**
 * Guardia de página: exige sesión + rol permitido. Si no cumple, redirige.
 * Uso típico al principio de cada page-script:
 *   const profile = await requireRole(['local_admin']);
 */
export function requireRole(allowedRoles) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = 'index.html';
        return;
      }
      const profile = await resolveProfile(user);
      if (!profile || profile.pendingEmailVerification) {
        window.location.href = 'pending.html';
        return;
      }
      const access = await checkAccountAccess(profile);
      if (!access.ok) {
        window.location.href = `pending.html?reason=${access.reason}`;
        return;
      }
      if (!allowedRoles.includes(profile.role)) {
        window.location.href = homeForRole(profile.role);
        return;
      }
      resolve({ user, profile });
    });
  });
}
