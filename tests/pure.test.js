import { describe, it, expect } from 'vitest';
import {
  compareProductsByShade,
  consolidateByProduct,
  consolidateByUser,
  formatPrice,
  escapeHtml,
  receiptDiffClass,
} from '../js/pure.js';

describe('formatPrice', () => {
  it('formatea un número como pesos chilenos sin decimales', () => {
    // Normalizamos espacios (algunos motores ICU insertan un espacio o
    // espacio-fino entre el símbolo y el número) para no acoplar el test
    // al detalle de tipografía del entorno donde corre.
    expect(formatPrice(1000).replace(/\s/g, '')).toBe('$1.000');
    expect(formatPrice(0).replace(/\s/g, '')).toBe('$0');
  });

  it('devuelve "" para valores inválidos', () => {
    expect(formatPrice(null)).toBe('');
    expect(formatPrice(undefined)).toBe('');
    expect(formatPrice('abc')).toBe('');
    expect(formatPrice(NaN)).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapa caracteres peligrosos', () => {
    expect(escapeHtml('<script>alert("hi")</script>')).toBe(
      '&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;'
    );
  });

  it('maneja & y comillas simples', () => {
    expect(escapeHtml(`Tono & Reflejo's`)).toBe('Tono &amp; Reflejo&#39;s');
  });

  it('convierte null/undefined a string vacío', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('compareProductsByShade', () => {
  it('ordena por nombre numéricamente (5/0 antes que 10/1)', () => {
    const a = { name: 'Tinte 5/0', shadeCode: '5.0' };
    const b = { name: 'Tinte 10/1', shadeCode: '10.1' };
    expect(compareProductsByShade(a, b)).toBeLessThan(0);
    expect(compareProductsByShade(b, a)).toBeGreaterThan(0);
  });

  it('usa shadeCode como desempate si el nombre es igual', () => {
    const a = { name: 'Tinte', shadeCode: '5.0' };
    const b = { name: 'Tinte', shadeCode: '10.0' };
    expect(compareProductsByShade(a, b)).toBeLessThan(0);
  });
});

describe('receiptDiffClass', () => {
  it('devuelve pending si todavía no se registró recepción', () => {
    expect(receiptDiffClass(false, 0)).toBe('receipt-diff-pending');
  });

  it('devuelve ok si la diferencia es 0', () => {
    expect(receiptDiffClass(true, 0)).toBe('receipt-diff-ok');
  });

  it('devuelve short si llegó menos de lo pedido', () => {
    expect(receiptDiffClass(true, -2)).toBe('receipt-diff-short');
  });

  it('devuelve over si llegó más de lo pedido', () => {
    expect(receiptDiffClass(true, 3)).toBe('receipt-diff-over');
  });
});

describe('consolidateByProduct', () => {
  const products = [
    { id: 'p1', name: 'Tinte 5.0', shadeCode: '5.0', categoryId: 'c1' },
    { id: 'p2', name: 'Tinte 6.0', shadeCode: '6.0', categoryId: 'c1' },
  ];
  const categories = [{ id: 'c1', name: 'Tintes' }];

  it('agrupa por producto sumando cantidades de distintos usuarios', () => {
    const items = [
      { productId: 'p1', userId: 'u1', userName: 'Ana', quantity: 2, notes: '' },
      { productId: 'p1', userId: 'u2', userName: 'Bea', quantity: 3, notes: '' },
      { productId: 'p2', userId: 'u1', userName: 'Ana', quantity: 1, notes: '' },
    ];
    const result = consolidateByProduct(items, products, categories);
    expect(result).toHaveLength(1);
    expect(result[0].category.id).toBe('c1');
    const p1Entry = result[0].items.find((e) => e.product.id === 'p1');
    expect(p1Entry.totalQuantity).toBe(5);
    expect(p1Entry.breakdown).toHaveLength(2);
  });

  it('cada línea del breakdown trae los datos de recepción (null si no se cargó)', () => {
    const items = [
      {
        productId: 'p1',
        userId: 'u1',
        userName: 'Ana',
        quantity: 2,
        notes: '',
        receivedQuantity: 2,
        receivedUnitPrice: 4500,
        receivedUpdatedBy: 'admin1',
        receivedUpdatedAt: 'timestamp-fake',
      },
      { productId: 'p1', userId: 'u2', userName: 'Bea', quantity: 3, notes: '' },
    ];
    const result = consolidateByProduct(items, products, categories);
    const p1Entry = result[0].items.find((e) => e.product.id === 'p1');
    const ana = p1Entry.breakdown.find((b) => b.userId === 'u1');
    const bea = p1Entry.breakdown.find((b) => b.userId === 'u2');
    expect(ana.receivedQuantity).toBe(2);
    expect(ana.receivedUnitPrice).toBe(4500);
    expect(ana.receivedUpdatedBy).toBe('admin1');
    expect(ana.receivedUpdatedAt).toBe('timestamp-fake');
    expect(bea.receivedQuantity).toBeNull();
    expect(bea.receivedUnitPrice).toBeNull();
    expect(bea.receivedUpdatedBy).toBeNull();
    expect(bea.receivedUpdatedAt).toBeNull();
  });

  it('aplica el ajuste del admin por encima de lo solicitado', () => {
    const items = [{ productId: 'p1', userId: 'u1', userName: 'Ana', quantity: 2, notes: '' }];
    const adjustments = [{ id: 'p1', adjustedQuantity: 10 }];
    const result = consolidateByProduct(items, products, categories, adjustments);
    const p1Entry = result[0].items.find((e) => e.product.id === 'p1');
    expect(p1Entry.requestedQuantity).toBe(2);
    expect(p1Entry.totalQuantity).toBe(10);
  });

  it('ignora items de productos que ya no existen', () => {
    const items = [{ productId: 'ghost', userId: 'u1', userName: 'Ana', quantity: 2, notes: '' }];
    const result = consolidateByProduct(items, products, categories);
    expect(result).toHaveLength(0);
  });
});

describe('consolidateByUser', () => {
  const products = [
    { id: 'p1', name: 'Tinte 5.0', shadeCode: '5.0' },
    { id: 'p2', name: 'Tinte 6.0', shadeCode: '6.0' },
  ];

  it('agrupa por usuario y ordena por nombre', () => {
    const items = [
      { productId: 'p1', userId: 'u2', userName: 'Bea', quantity: 1, notes: '' },
      { productId: 'p2', userId: 'u1', userName: 'Ana', quantity: 2, notes: '' },
    ];
    const result = consolidateByUser(items, products);
    expect(result.map((u) => u.userName)).toEqual(['Ana', 'Bea']);
    expect(result[0].items[0].quantity).toBe(2);
  });
});
