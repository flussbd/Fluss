import { readFileSync } from 'fs';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

// ---------------------------------------------------------------------------
// Tests de firestore.rules contra el Firebase Emulator Suite.
//
// Corren con: npm run test:rules
// (eso levanta el emulador de Firestore vía `firebase emulators:exec` y
// dentro corre este archivo con Vitest — requiere Java instalado).
//
// Modelo de roles: platform_admin | local_admin | basic, ver comentarios en
// firestore.rules. Estos tests cubren el aislamiento entre salones (un
// local_admin o basic de un salón NO debe poder leer/escribir datos de
// OTRO salón) y los casos de permisos más sensibles: alta de usuarios vía
// invitación, y escritura de items/received/submissions de un pedido.
// ---------------------------------------------------------------------------

let testEnv;

const SALON_A = 'salonA';
const SALON_B = 'salonB';

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-fluss',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

/** Contexto de Firestore con las reglas de seguridad activas, para un usuario dado (o sin loguear si uid es null). */
function ctxFor(uid, extraClaims = {}) {
  return uid
    ? testEnv.authenticatedContext(uid, { email: `${uid}@fluss.test`, email_verified: true, ...extraClaims })
    : testEnv.unauthenticatedContext();
}

/** Escribe datos directamente salteando las reglas (para armar el estado inicial del test). */
async function seed(fn) {
  await testEnv.withSecurityRulesDisabled(async (adminCtx) => {
    await fn(adminCtx.firestore());
  });
}

describe('users', () => {
  it('un usuario no logueado no puede leer perfiles', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/admin1'), { role: 'local_admin', salonId: SALON_A, email: 'admin1@fluss.test' });
    });
    const db = ctxFor(null).firestore();
    await assertFails(getDoc(doc(db, 'users/admin1')));
  });

  it('un local_admin puede leer perfiles de SU salón pero no de otro', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/admin1'), { role: 'local_admin', salonId: SALON_A, email: 'admin1@fluss.test' });
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, 'users/basicB'), { role: 'basic', salonId: SALON_B, email: 'basicB@fluss.test' });
    });
    const db = ctxFor('admin1').firestore();
    await assertSucceeds(getDoc(doc(db, 'users/basicA')));
    await assertFails(getDoc(doc(db, 'users/basicB')));
  });

  it('crear el propio perfil solo funciona si coincide EXACTO con la invitación pendiente', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'invites/nueva@fluss.test'), { role: 'basic', salonId: SALON_A });
    });
    const db = ctxFor('nueva').firestore();

    // Rol distinto al de la invitación: falla.
    await assertFails(
      setDoc(doc(db, 'users/nueva'), {
        role: 'local_admin',
        salonId: SALON_A,
        email: 'nueva@fluss.test',
      })
    );

    // Coincide exacto con la invitación: funciona.
    await assertSucceeds(
      setDoc(doc(db, 'users/nueva'), {
        role: 'basic',
        salonId: SALON_A,
        email: 'nueva@fluss.test',
      })
    );
  });

  it('un usuario básico no puede cambiarse el rol a sí mismo', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
    });
    const db = ctxFor('basicA').firestore();
    await assertFails(updateDoc(doc(db, 'users/basicA'), { role: 'local_admin' }));
    await assertSucceeds(updateDoc(doc(db, 'users/basicA'), { name: 'Nuevo nombre' }));
  });
});

describe('aislamiento entre salones (categories/products/orders)', () => {
  it('un local_admin de salonA no puede escribir productos de salonB', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
    });
    const db = ctxFor('adminA').firestore();
    await assertFails(setDoc(doc(db, `salons/${SALON_B}/products/p1`), { name: 'Tinte', categoryId: 'c1' }));
    await assertSucceeds(setDoc(doc(db, `salons/${SALON_A}/products/p1`), { name: 'Tinte', categoryId: 'c1' }));
  });

  it('un usuario básico no puede escribir productos (solo lectura)', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
    });
    const db = ctxFor('basicA').firestore();
    await assertFails(setDoc(doc(db, `salons/${SALON_A}/products/p1`), { name: 'Tinte', categoryId: 'c1' }));
  });

  it('platform_admin puede escribir en cualquier salón', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/plat1'), { role: 'platform_admin', salonId: null, email: 'plat1@fluss.test' });
    });
    const db = ctxFor('plat1').firestore();
    await assertSucceeds(setDoc(doc(db, `salons/${SALON_A}/products/p1`), { name: 'Tinte', categoryId: 'c1' }));
    await assertSucceeds(setDoc(doc(db, `salons/${SALON_B}/products/p1`), { name: 'Tinte', categoryId: 'c1' }));
  });
});

describe('order items', () => {
  async function seedOrderDraft() {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, 'users/basicA2'), { role: 'basic', salonId: SALON_A, email: 'basicA2@fluss.test' });
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1`), { status: 'draft' });
    });
  }

  it('un usuario puede crear/editar su propio item mientras el pedido está en borrador', async () => {
    await seedOrderDraft();
    const db = ctxFor('basicA').firestore();
    await assertSucceeds(
      setDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), {
        userId: 'basicA',
        productId: 'p1',
        quantity: 2,
      })
    );
  });

  it('un usuario NO puede crear un item a nombre de otro usuario', async () => {
    await seedOrderDraft();
    const db = ctxFor('basicA').firestore();
    await assertFails(
      setDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA2_p1`), {
        userId: 'basicA2',
        productId: 'p1',
        quantity: 2,
      })
    );
  });

  it('un usuario NO puede tocar sus items una vez que el pedido ya no está en borrador', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1`), { status: 'reviewing' });
    });
    const db = ctxFor('basicA').firestore();
    await assertFails(
      setDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), {
        userId: 'basicA',
        productId: 'p1',
        quantity: 2,
      })
    );
  });

  it('un usuario NO puede tocar sus items después de haber cerrado su propio pedido (submission)', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1`), { status: 'draft' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1/submissions/basicA`), { submittedAt: new Date() });
    });
    const db = ctxFor('basicA').firestore();
    await assertFails(
      setDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), {
        userId: 'basicA',
        productId: 'p1',
        quantity: 2,
      })
    );
  });

  it('el local_admin puede editar items de cualquier usuario del salón, aunque no esté en draft', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1`), { status: 'reviewing' });
    });
    const db = ctxFor('adminA').firestore();
    await assertSucceeds(
      setDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), {
        userId: 'basicA',
        productId: 'p1',
        quantity: 5,
      })
    );
  });
});

describe('received (recepción de mercadería)', () => {
  it('solo el local_admin (o platform_admin) puede escribir recepción, no un usuario básico', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1`), { status: 'reviewing' });
    });
    const basicDb = ctxFor('basicA').firestore();
    await assertFails(
      setDoc(doc(basicDb, `salons/${SALON_A}/orders/o1/received/p1`), { receivedQuantity: 3 })
    );
    const adminDb = ctxFor('adminA').firestore();
    await assertSucceeds(
      setDoc(doc(adminDb, `salons/${SALON_A}/orders/o1/received/p1`), { receivedQuantity: 3 })
    );
  });

  it('cualquier miembro del salón puede LEER la recepción (para ver si les llegó)', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1/received/p1`), { receivedQuantity: 3 });
    });
    const db = ctxFor('basicA').firestore();
    await assertSucceeds(getDoc(doc(db, `salons/${SALON_A}/orders/o1/received/p1`)));
  });
});
