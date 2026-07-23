// ---------------------------------------------------------------------------
// Helpers de UI compartidos entre vistas (basic.js, admin-local.js). A
// diferencia de pure.js, estos SÍ tocan el DOM.
// ---------------------------------------------------------------------------

/** Construye un bloque label+valor para las estadísticas del historial (ej. "Pedido", "Recibido"). */
export function buildHistStatEl(label, value, tone = null) {
  const wrap = document.createElement('section');
  wrap.className = 'hist-stat';
  const labelEl = document.createElement('span');
  labelEl.className = 'hist-stat-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = `hist-stat-value${tone ? ' hist-stat-' + tone : ''}`;
  valueEl.textContent = value;
  wrap.appendChild(labelEl);
  wrap.appendChild(valueEl);
  return { wrap, valueEl };
}
