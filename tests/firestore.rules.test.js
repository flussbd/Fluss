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
// OTRO salón), los casos de permisos más sensibles (alta de usuarios vía
// invitación, escritura de items/submissions de un pedido), y que un usuario
// básico no pueda tocar los campos de recepción (receivedQuantity/etc.) que
// ahora viven en el mismo doc de item que su propio pedido.
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

describe('recepción (receivedQuantity guardado directo en items/{itemId})', () => {
  it('el local_admin puede cargar receivedQuantity en el item de un usuario, aunque no esté en draft', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1`), { status: 'reviewing' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), {
        userId: 'basicA',
        productId: 'p1',
        quantity: 5,
      });
    });
    const db = ctxFor('adminA').firestore();
    await assertSucceeds(
      updateDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), {
        receivedQuantity: 3,
        receivedUnitPrice: 4500,
        receivedUpdatedBy: 'adminA',
      })
    );
  });

  it('un usuario básico NO puede cargarse receivedQuantity a sí mismo, ni siquiera en su propio item en draft', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1`), { status: 'draft' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), {
        userId: 'basicA',
        productId: 'p1',
        quantity: 5,
      });
    });
    const db = ctxFor('basicA').firestore();
    await assertFails(
      updateDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), { receivedQuantity: 999 })
    );
  });

  it('un usuario básico NO puede incluir receivedQuantity al crear su propio item', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1`), { status: 'draft' });
    });
    const db = ctxFor('basicA').firestore();
    await assertFails(
      setDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), {
        userId: 'basicA',
        productId: 'p1',
        quantity: 2,
        receivedQuantity: 999,
      })
    );
  });

  it('un usuario básico SÍ puede seguir editando la cantidad de su item aunque ya tenga receivedQuantity cargado (no lo borra ni lo toca)', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1`), { status: 'draft' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), {
        userId: 'basicA',
        productId: 'p1',
        quantity: 5,
        receivedQuantity: 3,
        receivedUnitPrice: 4500,
      });
    });
    const db = ctxFor('basicA').firestore();
    // merge:true — como hace setMyItem en db.js: no reenvía receivedQuantity,
    // así que el diff de campos afectados no lo incluye y la regla lo permite.
    await assertSucceeds(
      setDoc(
        doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`),
        { userId: 'basicA', productId: 'p1', quantity: 7 },
        { merge: true }
      )
    );
  });

  it('cualquier miembro del salón puede LEER el item (para ver si le llegó)', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`), {
        userId: 'basicA',
        productId: 'p1',
        quantity: 5,
        receivedQuantity: 3,
      });
    });
    const db = ctxFor('basicA').firestore();
    await assertSucceeds(getDoc(doc(db, `salons/${SALON_A}/orders/o1/items/basicA_p1`)));
  });
});

describe('status de usuario (blocked/inactive)', () => {
  it('un usuario básico bloqueado no puede leer nada, ni siquiera de su propio salón', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), {
        role: 'basic',
        salonId: SALON_A,
        email: 'basicA@fluss.test',
        status: 'blocked',
      });
      await setDoc(doc(db, `salons/${SALON_A}/products/p1`), { name: 'Tinte', categoryId: 'c1' });
    });
    const db = ctxFor('basicA').firestore();
    await assertFails(getDoc(doc(db, `salons/${SALON_A}/products/p1`)));
  });

  it('un usuario básico bloqueado no puede escribir (crear su propio item de pedido)', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/basicA'), {
        role: 'basic',
        salonId: SALON_A,
        email: 'basicA@fluss.test',
        status: 'blocked',
      });
      await setDoc(doc(db, `salons/${SALON_A}/orders/o1`), { status: 'draft' });
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

  it('un admin local dado de baja (status inactive) pierde el acceso igual que uno bloqueado', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/adminA'), {
        role: 'local_admin',
        salonId: SALON_A,
        email: 'adminA@fluss.test',
        status: 'inactive',
      });
      await setDoc(doc(db, `salons/${SALON_A}/products/p1`), { name: 'Tinte', categoryId: 'c1' });
    });
    const db = ctxFor('adminA').firestore();
    await assertFails(getDoc(doc(db, `salons/${SALON_A}/products/p1`)));
    await assertFails(setDoc(doc(db, `salons/${SALON_A}/products/p2`), { name: 'Otro', categoryId: 'c1' }));
  });

  it('el local_admin puede bloquear y dar de baja a un usuario básico de su salón', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
    });
    const db = ctxFor('adminA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'users/basicA'), { status: 'blocked' }));
    await assertSucceeds(updateDoc(doc(db, 'users/basicA'), { status: 'inactive' }));
  });

  it('el local_admin NO puede tocar (ni bloquear ni cambiar el rol) a otro admin local de su mismo salón', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
      await setDoc(doc(db, 'users/adminA2'), { role: 'local_admin', salonId: SALON_A, email: 'adminA2@fluss.test' });
    });
    const db = ctxFor('adminA').firestore();
    await assertFails(updateDoc(doc(db, 'users/adminA2'), { status: 'inactive' }));
    await assertFails(deleteDoc(doc(db, 'users/adminA2')));
  });

  it('el local_admin NO puede ascender a un usuario básico a admin local', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
    });
    const db = ctxFor('adminA').firestore();
    await assertFails(updateDoc(doc(db, 'users/basicA'), { role: 'local_admin' }));
  });

  it('el admin de plataforma puede dar de baja (y reactivar) a un admin local de cualquier salón', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/plat1'), { role: 'platform_admin', salonId: null, email: 'plat1@fluss.test' });
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
    });
    const db = ctxFor('plat1').firestore();
    await assertSucceeds(updateDoc(doc(db, 'users/adminA'), { status: 'inactive' }));
    await assertSucceeds(updateDoc(doc(db, 'users/adminA'), { status: 'active', salonId: SALON_B }));
  });
});

describe('salón activo/inactivo', () => {
  it('solo el admin de plataforma puede dar de baja un salón; el admin local no, aunque pueda editar otros campos', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}`), { name: 'Salón A', active: true });
    });
    const db = ctxFor('adminA').firestore();
    await assertFails(updateDoc(doc(db, `salons/${SALON_A}`), { active: false }));
    await assertSucceeds(updateDoc(doc(db, `salons/${SALON_A}`), { name: 'Salón A renombrado' }));
  });

  it('el admin de plataforma puede dar de baja y reactivar un salón', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/plat1'), { role: 'platform_admin', salonId: null, email: 'plat1@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}`), { name: 'Salón A', active: true });
    });
    const db = ctxFor('plat1').firestore();
    await assertSucceeds(updateDoc(doc(db, `salons/${SALON_A}`), { active: false }));
    await assertSucceeds(updateDoc(doc(db, `salons/${SALON_A}`), { active: true }));
  });

  it('un salón dado de baja sigue siendo LEÍBLE por su equipo, pero nadie del salón puede escribir ahí', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/adminA'), { role: 'local_admin', salonId: SALON_A, email: 'adminA@fluss.test' });
      await setDoc(doc(db, 'users/basicA'), { role: 'basic', salonId: SALON_A, email: 'basicA@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}`), { name: 'Salón A', active: false });
      await setDoc(doc(db, `salons/${SALON_A}/products/p1`), { name: 'Tinte', categoryId: 'c1' });
    });
    const adminDb = ctxFor('adminA').firestore();
    const basicDb = ctxFor('basicA').firestore();

    await assertSucceeds(getDoc(doc(adminDb, `salons/${SALON_A}/products/p1`)));
    await assertSucceeds(getDoc(doc(basicDb, `salons/${SALON_A}/products/p1`)));

    await assertFails(setDoc(doc(adminDb, `salons/${SALON_A}/products/p2`), { name: 'Otro', categoryId: 'c1' }));
  });

  it('el admin de plataforma puede seguir escribiendo en un salón dado de baja', async () => {
    await seed(async (db) => {
      await setDoc(doc(db, 'users/plat1'), { role: 'platform_admin', salonId: null, email: 'plat1@fluss.test' });
      await setDoc(doc(db, `salons/${SALON_A}`), { name: 'Salón A', active: false });
    });
    const db = ctxFor('plat1').firestore();
    await assertSucceeds(setDoc(doc(db, `salons/${SALON_A}/products/p1`), { name: 'Tinte', categoryId: 'c1' }));
  });
});
