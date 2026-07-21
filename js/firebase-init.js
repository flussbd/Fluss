// Punto único de inicialización de Firebase (SDK modular vía CDN, sin build step).
//
// Nota de versión: uso la 10.12.2 porque es una versión estable que puedo
// confirmar que existió — no tengo certeza de cuál es la última disponible
// hoy (mi conocimiento llega a mayo 2025 y probablemente haya versiones más
// nuevas). Antes de usar esto en serio, revisen la versión vigente en
// https://firebase.google.com/docs/web/setup y actualicen las tres URLs de
// abajo si corresponde (los especificadores de un `import` estático tienen
// que ser un literal fijo, no se puede armar la URL con una variable).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
