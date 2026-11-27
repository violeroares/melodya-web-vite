// Entrada a Melodya Store con la sesión de Web (código de un solo uso). Se lee VITE_STORE_URL. Ejecutar: node --test "tests/store-link.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { storeBaseUrl } = await import('../src/lib/store-link.ts');

test('storeBaseUrl: solo https (o http en localhost); sin barra final; lo demás se descarta', () => {
  assert.equal(storeBaseUrl('https://tienda.melodya.com.ar/'), 'https://tienda.melodya.com.ar');
  assert.equal(storeBaseUrl('http://localhost:3100'), 'http://localhost:3100');
  assert.equal(storeBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  for (const bad of [undefined, null, '', '   ', 'http://tienda.melodya.com.ar', 'javascript:alert(1)', 'tienda.melodya.com.ar', 'ftp://x.example']) {
    assert.equal(storeBaseUrl(bad), null, String(bad));
  }
});

const { packBuyMode } = await import('../src/lib/store-link.ts');

test('packBuyMode: los paquetes nunca se compran por el checkout simulado: sin sesión → ingresar; sin Store configurada → aviso; con Store → abrir Store', () => {
  assert.equal(packBuyMode({ loggedIn: false, storeUrl: 'http://localhost:3002' }), 'login');
  assert.equal(packBuyMode({ loggedIn: false, storeUrl: null }), 'login');
  assert.equal(packBuyMode({ loggedIn: true, storeUrl: 'http://localhost:3002' }), 'open-store');
  assert.equal(packBuyMode({ loggedIn: true, storeUrl: 'https://tienda.melodya.com.ar' }), 'open-store');
  for (const bad of [undefined, null, '', 'http://tienda.melodya.com.ar', 'javascript:alert(1)']) assert.equal(packBuyMode({ loggedIn: true, storeUrl: bad }), 'store-not-configured', String(bad));
});

test('storeBaseUrl: ninguna IP de red local se acepta por http (ni en desarrollo): solo localhost / 127.0.0.1', () => {
  for (const other of ['http://192.168.1.37:3002', 'http://192.168.1.38:3002', 'http://10.0.0.5:3002', 'http://172.16.0.9:3002']) assert.equal(storeBaseUrl(other), null, other);
  assert.equal(storeBaseUrl('http://localhost:3002'), 'http://localhost:3002');
});

const { storeProductParam } = await import('../src/lib/store-link.ts');

test('C5: storeProductParam conserva el plan o paquete elegido y descarta ids con formato inválido', () => {
  assert.deepEqual(storeProductParam({ kind: 'plan', id: 'plan_abc12345' }), ['plan', 'plan_abc12345']);
  assert.deepEqual(storeProductParam({ kind: 'pack', id: 'cd5e7a1b-22aa-4c33-9d10-0123456789ab' }), ['pack', 'cd5e7a1b-22aa-4c33-9d10-0123456789ab']);
  for (const bad of [null, undefined, { kind: 'plan', id: '' }, { kind: 'plan', id: 'corto' }, { kind: 'plan', id: 'a/b/c/d/e/f/g' }, { kind: 'plan', id: 'x'.repeat(65) }, { kind: 'plan', id: 'abc12345&pack=zzzzzzzz' }, { kind: 'other', id: 'plan_abc12345' }, { kind: 'plan', id: 12345678 }]) {
    assert.equal(storeProductParam(bad), null, JSON.stringify(bad));
  }
});
