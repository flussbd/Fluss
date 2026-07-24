# Fluss — gestión de insumos para salones (v1 HTML + Firebase)

Primera versión de Fluss: HTML/CSS/JavaScript plano (sin build step, sin framework) con Firebase Authentication + Firestore como backend. Multi-salón: varios salones independientes comparten la misma app, cada uno con su catálogo, equipo y pedidos separados.

> Actualización: a diferencia de lo que decía esta nota antes, sí se pudo probar bastante. Los tests de lógica pura (`npm test`) y de `firestore.rules` contra el Firebase Emulator Suite (`npm run test:rules`) corren y pasan (24 y 40 casos respectivamente), y la app se levantó con un servidor estático local para confirmar que las cuatro páginas cargan sin errores de consola. Lo que **no** se hizo es un login real de punta a punta contra el proyecto de Firebase de producción (crear un pedido, invitar gente, cargar una recepción) — eso, y sobre todo la vista de recepción del Historial (`js/admin-local-history.js`, la más grande y la única sin ningún test automatizado), conviene probarlas a mano antes de invitar usuarios reales.

## Roles

| Rol | Alcance | Qué puede hacer |
|---|---|---|
| `basic` (usuario básico) | Un salón | Ver el catálogo (sin escribir, solo tocando +/-, sin ver el proveedor), armar su pedido del período actual, agregar notas opcionales, y opcionalmente "cerrar" su propio pedido antes de que cierre el período general (una vez cerrado, sus insumos quedan fijos y recién ahí cuentan para el consolidado y el Historial del admin) |
| `local_admin` (administrador local) | Un salón | Definir las fechas de cada período (con sugerencia automática de la siguiente al cerrar una), ver el consolidado y la vista por usuario, ajustar cantidades finales, cerrar el período de solicitud y el período completo, exportar a TXT/Excel/PDF (general o por proveedor), gestionar catálogo (categorías/productos, import masivo), invitar/bloquear/dar de baja usuarios básicos, y cargar la recepción de mercadería por proveedor en el Historial (con candado: una vez guardada o con el período "recepción finalizada", no se puede volver a tocar) |
| `platform_admin` (administrador plataforma) | Toda la plataforma | Crear salones, darlos de baja/reactivar, e invitar/dar de baja/reasignar administradores locales |

## Cómo se resuelve el login y el rol (sin backend propio)

1. La persona entra con **Google** o crea una cuenta con **email/contraseña** (Firebase Authentication).
2. La app busca su perfil en `/users/{uid}`. Si existe, la redirige según su rol.
3. Si no existe, busca una invitación en `/invites/{email}`. Si la encuentra (y, para email/contraseña, si ya verificó el email), crea el perfil con el rol y salón de esa invitación y borra la invitación.
4. Si no hay perfil ni invitación, ve una pantalla de "cuenta pendiente" — necesita que un administrador la invite primero.

Esto es un patrón intencional para no necesitar Cloud Functions ni Admin SDK (o sea, ninguna pieza de backend propia): la validación de que el rol/salón asignado coincide exactamente con la invitación vive en `firestore.rules` (usa `get()` para comparar contra el documento de invitación al momento de crear el perfil).

**Bootstrap del primer administrador plataforma**: como nadie puede invitar al primer `platform_admin` (no hay quién lo invite), esa cuenta se crea a mano: la persona inicia sesión una vez en Fluss (queda en "pendiente"), ustedes copian su `uid` desde Firebase Console → Authentication, y crean manualmente el documento `/users/{uid}` en Firestore con `{ role: 'platform_admin', salonId: null, name, email }`.

## Modelo de datos (Firestore)

```
/users/{uid}                          role, salonId (null si es platform_admin), name, email, photoURL,
                                       status: active|blocked|inactive (default active)
/invites/{email}                      role, salonId, invitedBy, createdAt   (doc id = email en minúsculas)
/salons/{salonId}                     name, createdBy, createdAt, active (default true),
                                       currentOrderId (id del pedido draft/reviewing actual, o null)
  /categories/{categoryId}            name, sortOrder
  /products/{productId}               name, categoryId, brand, line, shadeCode, format, supplierName,
                                       productCode, price, active
  /orders/{orderId}                   status: draft|reviewing|completed, periodStart, periodEnd, periodEndTime,
                                       closedAt, closedBy, receptionFinalized, receptionFinalizedAt, receptionFinalizedBy,
                                       receptionReopenedAt, receptionReopenedBy
    /items/{uid_productId}            productId, userId, userName, quantity, notes,
                                       receivedQuantity, receivedUnitPrice, receivedUpdatedBy, receivedUpdatedAt
    /adjustments/{productId}          adjustedQuantity, updatedBy, updatedAt
    /submissions/{uid}                submittedAt   (existe solo si esa persona ya "cerró" su propio pedido)
```

Los `items` usan como id `${uid}_${productId}` a propósito: así cada persona tiene como máximo una línea por producto (el +/- hace `setDoc`/`deleteDoc` sobre ese mismo documento) sin necesitar una consulta para evitar duplicados. Los mismos docs guardan, más adelante, cuánto le llegó a esa persona de ese producto (`receivedQuantity`/etc., cargado por el admin desde el Historial) — no hay una colección aparte para la recepción.

Los `adjustments` guardan el ajuste final del admin **separado** de lo que pidió cada persona (`items`), para poder mostrar ambos números sin perder el detalle original — es una decisión de diseño mía, revísenla si prefieren otro criterio de auditoría.

`salons/{salonId}.currentOrderId` es un puntero denormalizado (no un dato "real" del negocio) que mantiene sincronizado `createOrder`/`closeOrder` en `db.js` dentro de una transacción/batch. Existe para que `firestore.rules` pueda impedir de verdad que se abra un segundo período mientras el primero sigue abierto — sin este puntero, una regla no tiene forma de preguntar "¿ya existe otro pedido con status=draft en esta colección?", porque solo puede leer documentos por su path, no correr una consulta.

## Estructura de archivos

```
fluss/
├── index.html              # login (Google + email/contraseña)
├── pending.html            # cuenta sin invitación / email sin verificar
├── basic.html               # usuario básico: catálogo + mi pedido
├── admin-local.html         # administrador local: dashboard/catálogo/equipo/historial
├── admin-plataforma.html    # administrador plataforma: salones
├── css/styles.css
├── js/
│   ├── firebase-config.js   # ← completar con las credenciales de su proyecto
│   ├── firebase-init.js     # initializeApp/getAuth/getFirestore
│   ├── auth.js               # login, logout, reclamo de invitación, guard de rol
│   ├── db.js                  # helpers de Firestore + consolidación (funciones puras)
│   ├── ui.js                   # helpers de UI compartidos entre vistas (sí tocan el DOM)
│   ├── basic.js
│   ├── admin-local.js            # orquestador: login, nav, suscripciones a Firestore (solo eso)
│   ├── admin-local-state.js      # estado compartido (profile/categories/products/order/...) entre los módulos de admin-local
│   ├── admin-local-dashboard.js  # Pedido actual en vivo: consolidado/por usuario, modal de período, auto-cierre
│   ├── admin-local-history.js    # Historial: períodos archivados + vista de recepción (por proveedor)
│   ├── admin-local-catalog.js    # catálogo (categorías/productos, import masivo) + modal editar producto
│   ├── admin-local-team.js       # equipo (invitaciones + usuarios, bloquear/dar de baja)
│   ├── admin-local-export.js     # descargar pedido consolidado (TXT/Excel) + modal proveedor
│   └── admin-plataforma.js
├── firestore.rules
└── README.md
```

## Puesta en marcha

1. Creen un proyecto en [Firebase Console](https://console.firebase.google.com/).
2. **Authentication** → Sign-in method → habiliten **Google** y **Email/contraseña**.
3. **Firestore Database** → creen la base en modo producción.
4. Copien la configuración del proyecto (Configuración del proyecto → sus apps → SDK setup) en `js/firebase-config.js`.
5. Publiquen las reglas de `firestore.rules` (Firestore → Reglas, pegar y publicar; o con la CLI: `firebase deploy --only firestore:rules`).
6. Sirvan la carpeta con un servidor estático — **no abran los .html directamente con doble clic**: los `import` de ES modules y los flujos de Firebase Auth necesitan `http://` o `https://`, no `file://`. Por ejemplo:
   ```
   npx serve .
   # o
   python3 -m http.server 8080
   ```
7. Agreguen ese origen (`http://localhost:puerto`) a Authentication → Settings → Authorized domains si Firebase no lo detecta solo.
8. Entren, hagan login, y sigan el bootstrap del primer `platform_admin` descripto arriba.

## Cosas para revisar antes de confiar en esto

- **Reglas de Firestore: ahora sí probadas, pero solo con casos sintéticos**: `tests/firestore.rules.test.js` corre 40 casos contra el Firebase Emulator Suite (`npm run test:rules`) — incluye el patrón `get()` para validar invitaciones, aislamiento entre salones, los estados bloqueado/inactivo, el candado de recepción (`receivedFieldsLocked`) y que no se pueda abrir un segundo período mientras uno ya está abierto (`salonHasOpenOrder`). Sigue siendo buena idea probarlas a mano contra un proyecto de prueba antes de invitar gente real: los tests cubren los casos que se nos ocurrieron, no necesariamente todos los que importan.
- **Qué SÍ y qué NO enforce `firestore.rules` (para no asumir de más)**: además del aislamiento entre salones y roles, las reglas impiden que se sobrescriba `receivedQuantity`/etc. una vez que el período tiene `receptionFinalized: true` (deshacible con `reopenReception`, para corregir un error), y que se cree un segundo pedido mientras hay uno abierto. Ojo: mientras la recepción NO está finalizada, sí se puede corregir una línea ya guardada (a propósito — el botón "Editar" del Historial depende de esto; el candado "una vez guardada, nunca más" era solo protección contra un click accidental, no una regla de negocio real). Lo que sigue siendo solo una convención de la UI, sin barrera a nivel de reglas: por ejemplo, que el admin no pueda editar cantidades pedidas fuera de draft/reviewing más allá de lo que ya cubre la regla general de `items`. Si agregan una operación sensible nueva, conviene preguntarse explícitamente si necesita su propia regla o alcanza con la UI.
- **Sin tests de UI**: los tests existentes cubren lógica pura (`tests/pure.test.js`) y reglas de Firestore, pero ninguna vista tiene cobertura automatizada. `js/admin-local-history.js` (Historial + vista de recepción) es el módulo más grande y el que mezcla más renderizado, cálculo y escrituras — es el que más conviene revisar a mano.
- **Índice compuesto probable**: la consulta del historial (`listenCompletedOrders`, filtra por `status` y ordena por `closedAt`) puede pedirles crear un índice compuesto la primera vez que la corran — Firestore muestra un link en la consola del navegador para crearlo con un clic.
- **Versión del SDK de Firebase**: uso `10.12.2` fijo en las URLs de CDN. No tengo forma de confirmar si es la última disponible hoy — revisen https://firebase.google.com/docs/web/setup.
- **Generar PDF**: usa el diálogo de impresión del navegador sobre la vista consolidada, no una librería. Si quieren un archivo PDF sin ese diálogo, habría que sumar algo como `jsPDF` — revisen su documentación vigente antes de fijar la integración.
- **Sin Cloud Functions**: todo corre desde el navegador con las reglas de Firestore como única barrera de seguridad (ver el punto de arriba sobre qué cubren). Es razonable para una v1, pero para producción con datos sensibles conviene evaluar si algunas operaciones (ej. invitar administradores) deberían pasar por una función server-side en vez de confiar solo en reglas de cliente.
- **Sin íconos/PWA todavía**: pidieron explícitamente "primero versión html", así que no agregué manifest ni service worker esta vez — se puede sumar después si quieren instalarla como PWA.
