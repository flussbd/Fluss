# Fluss — gestión de insumos para salones (v1 HTML + Firebase)

Primera versión de Fluss: HTML/CSS/JavaScript plano (sin build step, sin framework) con Firebase Authentication + Firestore como backend. Multi-salón: varios salones independientes comparten la misma app, cada uno con su catálogo, equipo y pedidos separados.

> Actualización: a diferencia de lo que decía esta nota antes, sí se pudo probar bastante. Los tests de lógica pura (`npm test`) y de `firestore.rules` contra el Firebase Emulator Suite (`npm run test:rules`) corren y pasan (16 y 28 casos respectivamente), y la app se levantó con un servidor estático local para confirmar que las cuatro páginas cargan sin errores de consola. Lo que **no** se hizo es un login real de punta a punta contra el proyecto de Firebase de producción (crear un pedido, invitar gente, cargar una recepción) — eso, y sobre todo la sección de Historial de `admin-local.js` (la más grande y la única sin ningún test automatizado), conviene probarlas a mano antes de invitar usuarios reales.

## Roles

| Rol | Alcance | Qué puede hacer |
|---|---|---|
| `basic` (usuario básico) | Un salón | Ver el catálogo (sin escribir, solo tocando +/-), armar su pedido de la quincena actual, agregar notas opcionales |
| `local_admin` (administrador local) | Un salón | Definir las fechas de cada pedido quincenal, ver el consolidado y la vista por usuario, ajustar cantidades finales, cerrar el período de solicitud y la quincena, exportar a WhatsApp/PDF, gestionar catálogo (categorías/productos) e invitar usuarios básicos |
| `platform_admin` (administrador plataforma) | Toda la plataforma | Crear salones e invitar administradores locales para cada uno |

## Cómo se resuelve el login y el rol (sin backend propio)

1. La persona entra con **Google** o crea una cuenta con **email/contraseña** (Firebase Authentication).
2. La app busca su perfil en `/users/{uid}`. Si existe, la redirige según su rol.
3. Si no existe, busca una invitación en `/invites/{email}`. Si la encuentra (y, para email/contraseña, si ya verificó el email), crea el perfil con el rol y salón de esa invitación y borra la invitación.
4. Si no hay perfil ni invitación, ve una pantalla de "cuenta pendiente" — necesita que un administrador la invite primero.

Esto es un patrón intencional para no necesitar Cloud Functions ni Admin SDK (o sea, ninguna pieza de backend propia): la validación de que el rol/salón asignado coincide exactamente con la invitación vive en `firestore.rules` (usa `get()` para comparar contra el documento de invitación al momento de crear el perfil).

**Bootstrap del primer administrador plataforma**: como nadie puede invitar al primer `platform_admin` (no hay quién lo invite), esa cuenta se crea a mano: la persona inicia sesión una vez en Fluss (queda en "pendiente"), ustedes copian su `uid` desde Firebase Console → Authentication, y crean manualmente el documento `/users/{uid}` en Firestore con `{ role: 'platform_admin', salonId: null, name, email }`.

## Modelo de datos (Firestore)

```
/users/{uid}                          role, salonId (null si es platform_admin), name, email, photoURL
/invites/{email}                      role, salonId, invitedBy, createdAt   (doc id = email en minúsculas)
/salons/{salonId}                     name, createdBy, createdAt
  /categories/{categoryId}            name, sortOrder
  /products/{productId}               name, categoryId, defaultUnit, supplierName, active
  /orders/{orderId}                   status: draft|reviewing|completed, periodStart, periodEnd, closedAt, closedBy
    /items/{uid_productId}            productId, userId, userName, quantity, notes
    /adjustments/{productId}          adjustedQuantity, updatedBy, updatedAt
```

Los `items` usan como id `${uid}_${productId}` a propósito: así cada persona tiene como máximo una línea por producto (el +/- hace `setDoc`/`deleteDoc` sobre ese mismo documento) sin necesitar una consulta para evitar duplicados.

Los `adjustments` guardan el ajuste final del admin **separado** de lo que pidió cada persona (`items`), para poder mostrar ambos números sin perder el detalle original — es una decisión de diseño mía, revísenla si prefieren otro criterio de auditoría.

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
│   ├── admin-local.js          # orquestador: init, dashboard, período/auto-cierre, historial
│   ├── admin-local-state.js    # estado compartido (profile/categories/products/order/...) entre los módulos de admin-local
│   ├── admin-local-catalog.js  # catálogo (categorías/productos, import masivo) + modal editar producto
│   ├── admin-local-team.js     # equipo (invitaciones + usuarios)
│   ├── admin-local-export.js   # descargar pedido consolidado (TXT/Excel) + modal proveedor
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

- **Reglas de Firestore: ahora sí probadas, pero solo con casos sintéticos**: `tests/firestore.rules.test.js` corre 28 casos contra el Firebase Emulator Suite (`npm run test:rules`) — incluye el patrón `get()` para validar invitaciones, aislamiento entre salones, y los estados bloqueado/inactivo. Sigue siendo buena idea probarlas a mano contra un proyecto de prueba antes de invitar gente real: los tests cubren los casos que se nos ocurrieron, no necesariamente todos los que importan.
- **Sin tests de UI**: los tests existentes cubren lógica pura (`tests/pure.test.js`) y reglas de Firestore, pero ninguna vista tiene cobertura automatizada. La sección de Historial en `admin-local.js` es la más grande (~600 líneas) y la que mezcla más renderizado, cálculo y escrituras — es la que más conviene revisar a mano.
- **Índice compuesto probable**: la consulta del historial (`listenCompletedOrders`, filtra por `status` y ordena por `closedAt`) puede pedirles crear un índice compuesto la primera vez que la corran — Firestore muestra un link en la consola del navegador para crearlo con un clic.
- **Versión del SDK de Firebase**: uso `10.12.2` fijo en las URLs de CDN. No tengo forma de confirmar si es la última disponible hoy — revisen https://firebase.google.com/docs/web/setup.
- **Generar PDF**: usa el diálogo de impresión del navegador sobre la vista consolidada, no una librería. Si quieren un archivo PDF sin ese diálogo, habría que sumar algo como `jsPDF` — revisen su documentación vigente antes de fijar la integración.
- **Sin Cloud Functions**: todo corre desde el navegador con las reglas de Firestore como única barrera de seguridad. Es razonable para una v1, pero para producción con datos sensibles conviene evaluar si algunas operaciones (ej. invitar administradores) deberían pasar por una función server-side en vez de confiar solo en reglas de cliente.
- **Sin página de detalle del historial**: el historial de `admin-local.html` muestra período y fecha de cierre, pero no el desglose completo de esa quincena (quedó fuera de esta v1, igual que en el proyecto anterior).
- **Sin íconos/PWA todavía**: pidieron explícitamente "primero versión html", así que no agregué manifest ni service worker esta vez — se puede sumar después si quieren instalarla como PWA.
