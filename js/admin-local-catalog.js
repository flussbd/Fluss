// ---------------------------------------------------------------------------
// Catálogo (categorías + productos, import masivo) y su modal de edición.
// ---------------------------------------------------------------------------
import { addCategory, addProduct, updateProduct, deactivateProduct, activateProduct, compareProductsByShade } from './db.js';
import { formatPrice, escapeHtml } from './pure.js';
import { state } from './admin-local-state.js';

export function setupCatalog() {
  setupProductEditModal();
  setupCatalogForms();
}

// ---------------------------------------------------------------------------
// Modal: editar producto (todos los campos, no solo el precio)
// ---------------------------------------------------------------------------
function setupProductEditModal() {
  const modal = document.getElementById('productEditModal');

  document.getElementById('productEditCancelBtn').addEventListener('click', () => {
    modal.hidden = true;
  });

  document.getElementById('productEditSaveBtn').addEventListener('click', async () => {
    const productId = modal.dataset.productId;
    if (!productId) return;

    const name = document.getElementById('editProductName').value.trim();
    const brand = document.getElementById('editProductBrand').value.trim();
    const line = document.getElementById('editProductLine').value.trim();
    const categoryId = document.getElementById('editProductCategory').value;
    const shadeCode = document.getElementById('editProductShade').value.trim();
    const format = document.getElementById('editProductFormat').value.trim();
    const supplierName = document.getElementById('editProductSupplier').value.trim();
    const productCode = document.getElementById('editProductCode').value.trim();
    const priceRaw = document.getElementById('editProductPrice').value.trim();
    const price = priceRaw ? Number(priceRaw) : null;

    if (!name || !brand || !categoryId) {
      alert('Completá al menos nombre, marca y categoría.');
      return;
    }
    if (priceRaw && Number.isNaN(price)) {
      alert('Ingresá un precio válido.');
      return;
    }

    try {
      await updateProduct(state.profile.salonId, productId, {
        name,
        categoryId,
        brand,
        line,
        shadeCode,
        format,
        supplierName,
        productCode,
        price,
      });
      modal.hidden = true;
    } catch (err) {
      console.error(err);
      alert('No se pudo guardar el producto. Probá de nuevo.');
    }
  });
}

function openProductEditModal(p) {
  const modal = document.getElementById('productEditModal');
  modal.dataset.productId = p.id;

  document.getElementById('editProductName').value = p.name || '';
  document.getElementById('editProductBrand').value = p.brand || '';
  document.getElementById('editProductLine').value = p.line || '';
  document.getElementById('editProductShade').value = p.shadeCode || '';
  document.getElementById('editProductFormat').value = p.format || '';
  document.getElementById('editProductSupplier').value = p.supplierName || '';
  document.getElementById('editProductCode').value = p.productCode || '';
  document.getElementById('editProductPrice').value = typeof p.price === 'number' ? p.price : '';

  const select = document.getElementById('editProductCategory');
  select.innerHTML = '';
  for (const c of state.categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
  select.value = p.categoryId;

  modal.hidden = false;
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------
function setupCatalogForms() {
  document.getElementById('categoryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('categoryName');
    const name = input.value.trim();
    if (!name) return;
    try {
      await addCategory(state.profile.salonId, name, state.categories.length);
      input.value = '';
    } catch (err) {
      console.error(err);
      alert('No se pudo crear la categoría. Probá de nuevo.');
    }
  });

  document.getElementById('productForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('productName').value.trim();
    const brand = document.getElementById('productBrand').value.trim();
    const line = document.getElementById('productLine').value.trim();
    const categoryId = document.getElementById('productCategory').value;
    const shadeCode = document.getElementById('productShade').value.trim();
    const format = document.getElementById('productFormat').value.trim();
    const supplierName = document.getElementById('productSupplier').value.trim();
    const productCode = document.getElementById('productCode').value.trim();
    const priceRaw = document.getElementById('productPrice').value.trim();
    const price = priceRaw ? Number(priceRaw) : null;
    if (!name || !brand || !categoryId) return;
    try {
      await addProduct(state.profile.salonId, { name, brand, line, categoryId, shadeCode, format, supplierName, productCode, price });
      e.target.reset();
    } catch (err) {
      console.error(err);
      alert('No se pudo agregar el producto. Probá de nuevo.');
    }
  });

  document.getElementById('bulkImportBtn').addEventListener('click', async () => {
    const textarea = document.getElementById('bulkImportInput');
    const resultEl = document.getElementById('bulkImportResult');
    const text = textarea.value;
    if (!text.trim()) return;

    const btn = document.getElementById('bulkImportBtn');
    btn.disabled = true;
    resultEl.textContent = 'Cargando…';

    try {
      const result = await bulkImportCatalog(text);
      resultEl.textContent = `Listo: ${result.categories} categoría(s) nueva(s) y ${result.products} producto(s) agregados.`;
      textarea.value = '';
    } catch (err) {
      console.error(err);
      const partial = err.partialProgress;
      resultEl.textContent =
        partial && (partial.categories || partial.products)
          ? `Hubo un error a mitad de camino: alcanzaron a cargarse ${partial.categories} categoría(s) y ${partial.products} producto(s) antes de la falla. Revisá el catálogo antes de reintentar, para no duplicar lo que ya se guardó (F12 para más detalle).`
          : 'Hubo un error, revisá la consola del navegador (F12) para más detalle.';
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * Parsea un texto tipo:
 *   # Categoría
 *   Producto; marca; línea; tono; formato; proveedor; código
 * y crea las categorías/productos que no existan todavía (compara nombres
 * sin importar mayúsculas/minúsculas para no duplicar categorías). Solo el
 * nombre del producto es obligatorio; el resto se puede dejar vacío.
 */
async function bulkImportCatalog(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const categoryIdByName = new Map(state.categories.map((c) => [c.name.toLowerCase(), c.id]));
  let sortOrder = state.categories.length;
  let currentCategoryId = null;
  const created = { categories: 0, products: 0 };

  try {
    for (const rawLine of lines) {
      if (rawLine.startsWith('#')) {
        const name = rawLine.slice(1).trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (categoryIdByName.has(key)) {
          currentCategoryId = categoryIdByName.get(key);
        } else {
          const ref = await addCategory(state.profile.salonId, name, sortOrder++);
          currentCategoryId = ref.id;
          categoryIdByName.set(key, ref.id);
          created.categories++;
        }
      } else {
        if (!currentCategoryId) continue; // producto listado antes de cualquier "# Categoría": se ignora
        const parts = rawLine.split(';').map((s) => s.trim());
        const [name, brand, productLine, shadeCode, format, supplierName, productCode, priceRaw] = parts;
        if (!name) continue;
        // Si pegan un precio inválido o negativo (typo), no lo guardamos tal
        // cual: lo dejamos en null (negativo) o lo ignoramos (no numérico).
        const priceParsed = priceRaw ? Number(priceRaw) : null;
        const price = priceParsed !== null && !Number.isNaN(priceParsed) ? Math.max(0, priceParsed) : null;
        await addProduct(state.profile.salonId, {
          name,
          categoryId: currentCategoryId,
          brand: brand || '',
          line: productLine || '',
          shadeCode: shadeCode || '',
          format: format || '',
          supplierName: supplierName || '',
          productCode: productCode || '',
          price,
        });
        created.products++;
      }
    }
  } catch (err) {
    err.partialProgress = created;
    throw err;
  }

  return created;
}

export function renderCategoryOptions() {
  const select = document.getElementById('productCategory');
  const current = select.value;
  select.innerHTML = '<option value="" disabled selected>Elegí una categoría</option>';
  for (const c of state.categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
  if (current) select.value = current;
}

export function renderProductList() {
  const container = document.getElementById('productList');
  container.innerHTML = '';
  const categoryById = new Map(state.categories.map((c) => [c.id, c]));

  if (state.products.length === 0) {
    container.innerHTML = '<div class="empty-state">Todavía no cargaste productos.</div>';
    return;
  }

  const activeProducts = state.products.filter((p) => p.active).sort(compareProductsByShade);
  const inactiveProducts = state.products.filter((p) => !p.active).sort(compareProductsByShade);

  if (activeProducts.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay productos activos.</div>';
  } else {
    for (const p of activeProducts) container.appendChild(buildProductRow(p, categoryById, false));
  }

  if (inactiveProducts.length > 0) {
    const title = document.createElement('h2');
    title.className = 'category-title';
    title.textContent = 'Productos desactivados';
    container.appendChild(title);
    for (const p of inactiveProducts) container.appendChild(buildProductRow(p, categoryById, true));
  }
}

function buildProductRow(p, categoryById, isInactive) {
  const row = document.createElement('div');
  row.className = 'list-row';
  // El código de tono se muestra aparte, como una "ficha de color" (chip
  // monoespaciado) en vez de perderse mezclado con el resto del texto.
  const metaParts = [
    categoryById.get(p.categoryId)?.name || '—',
    p.brand,
    p.line,
    p.format,
    p.supplierName,
    formatPrice(p.price),
  ].filter(Boolean);
  row.innerHTML = `
    <div>
      <div class="product-name-row">
        <p class="list-row-title">${escapeHtml(p.name)}</p>
        ${p.shadeCode ? `<span class="shade-chip">${escapeHtml(p.shadeCode)}</span>` : ''}
      </div>
      <p class="list-row-sub">${escapeHtml(metaParts.join(' · '))}</p>
    </div>
  `;

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '6px';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-ghost btn-sm';
  editBtn.textContent = 'Editar';
  editBtn.addEventListener('click', () => openProductEditModal(p));
  actions.appendChild(editBtn);

  const btn = document.createElement('button');
  btn.className = 'btn btn-ghost btn-sm';
  if (isInactive) {
    btn.textContent = 'Reactivar';
    btn.addEventListener('click', async () => {
      try {
        await activateProduct(state.profile.salonId, p.id);
      } catch (err) {
        console.error(err);
        alert('No se pudo reactivar el producto. Probá de nuevo.');
      }
    });
  } else {
    btn.textContent = 'Desactivar';
    btn.addEventListener('click', async () => {
      if (!confirm(`¿Quitar "${p.name}" del catálogo?`)) return;
      try {
        await deactivateProduct(state.profile.salonId, p.id);
      } catch (err) {
        console.error(err);
        alert('No se pudo quitar el producto del catálogo. Probá de nuevo.');
      }
    });
  }
  actions.appendChild(btn);
  row.appendChild(actions);
  return row;
}
