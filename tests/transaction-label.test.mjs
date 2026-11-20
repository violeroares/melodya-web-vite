// Texto de cara al usuario de los movimientos de fichas (src/features/billing/transaction-label.ts) y su uso en PricingView.
// Las filas de ejemplo reproducen las formas reales vistas en la base de desarrollo (solo lectura) y las del código del backend.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { describeTransaction } = await import('../src/features/billing/transaction-label.ts');

const debit = (components, reason = 'Generación (TEXT_PROMPT) con Suno V6') => ({
  type: 'GENERATION_DEBIT',
  reason,
  metadata: components === undefined ? undefined : { breakdown: { v: 1, total: 0, components } },
});
const music = (generationType) => ({ type: 'MUSIC', credits: 10, providerModelId: 'm1', generationType });
const lyrics = { type: 'LYRICS', credits: 1, providerModelId: 'm2', generationType: 'LYRICS' };

const LEAK = /suno|\bv6\b|text_prompt|voice_cover|melody_ref|beatbox_rhythm|\blyrics\b|\bmusic\b/i;

test('débito: solo música → «Creación de canción»', () => {
  assert.deepEqual(describeTransaction(debit([music('TEXT_PROMPT')])), { title: 'Creación de canción', detail: null });
});

test('débito: música + componente de letra → «Creación de canción y letra»', () => {
  assert.deepEqual(describeTransaction(debit([lyrics, music('TEXT_PROMPT')])), { title: 'Creación de canción y letra', detail: null });
});

test('débito: ritmo de referencia (confirmado por el desglose), con y sin letra', () => {
  assert.deepEqual(describeTransaction(debit([lyrics, music('BEATBOX_RHYTHM')])), {
    title: 'Canción con ritmo de referencia',
    detail: 'Incluye la creación de la letra',
  });
  assert.deepEqual(describeTransaction(debit([music('BEATBOX_RHYTHM')])), { title: 'Canción con ritmo de referencia', detail: null });
});

test('débito: voz propia confirmada por el desglose, sola y con letra', () => {
  assert.deepEqual(describeTransaction(debit([music('VOICE_COVER')])), { title: 'Canción con tu voz', detail: null });
  assert.deepEqual(describeTransaction(debit([lyrics, music('VOICE_COVER')])), {
    title: 'Canción con tu voz',
    detail: 'Incluye la creación de la letra',
  });
});

test('débito: melodía de referencia confirmada por el desglose, sola y con letra', () => {
  assert.deepEqual(describeTransaction(debit([music('MELODY_REF')])), { title: 'Canción con melodía de referencia', detail: null });
  assert.deepEqual(describeTransaction(debit([lyrics, music('MELODY_REF')])), {
    title: 'Canción con melodía de referencia',
    detail: 'Incluye la creación de la letra',
  });
});

test('débito: el reason por sí solo no confirma la melodía de referencia', () => {
  const reason = 'Generación (TEXT_PROMPT+MELODY_REF) con Suno V6';
  assert.equal(describeTransaction(debit([music('TEXT_PROMPT')], reason)).title, 'Creación de canción');
  assert.equal(describeTransaction(debit([lyrics, music('TEXT_PROMPT')], reason)).title, 'Creación de canción y letra');
  assert.equal(describeTransaction(debit(undefined, reason)).title, 'Creación de canción');
  assert.equal(describeTransaction({ type: 'GENERATION_DEBIT', reason, metadata: { breakdown: { components: 'x' } } }).title, 'Creación de canción');
});

// Forma real (assistant-operation.service): metadata { source:'assistant', breakdown con un único componente LYRICS }.
const assistantDebit = (extra = {}, components = [lyrics], reason = 'Generación de letras (asistente)') => ({
  type: 'GENERATION_DEBIT',
  reason,
  metadata: { source: 'assistant', breakdown: { v: 1, total: 1, components }, ...extra },
});
const ASSISTANT = { title: 'Creación de letra con el asistente', detail: 'Generación de letras para tu canción' };

test('letras del asistente: se identifican por metadata.source, no por el reason', () => {
  assert.deepEqual(describeTransaction(assistantDebit()), ASSISTANT);
  assert.deepEqual(describeTransaction(assistantDebit({}, [lyrics], null)), ASSISTANT);
  assert.deepEqual(describeTransaction(assistantDebit({}, [lyrics], 'otro texto')), ASSISTANT);
  // con la marca y sin desglose utilizable sigue siendo una operación del asistente
  assert.deepEqual(describeTransaction({ type: 'GENERATION_DEBIT', reason: null, metadata: { source: 'assistant' } }), ASSISTANT);
});

test('letras del asistente: el reason por sí solo no lo confirma', () => {
  const r = describeTransaction({ type: 'GENERATION_DEBIT', reason: 'Generación de letras (asistente)', metadata: null });
  assert.deepEqual(r, { title: 'Uso de fichas', detail: null });
  const withBreakdown = { type: 'GENERATION_DEBIT', reason: 'Generación de letras (asistente)', metadata: { breakdown: { components: [lyrics] } } };
  assert.deepEqual(describeTransaction(withBreakdown), { title: 'Creación de letra', detail: null });
});

test('letras del asistente: no se confunde con el componente LYRICS de una generación musical', () => {
  assert.equal(describeTransaction(debit([lyrics, music('TEXT_PROMPT')])).title, 'Creación de canción y letra');
  assert.equal(describeTransaction(debit([lyrics, music('VOICE_COVER')])).title, 'Canción con tu voz');
  assert.equal(describeTransaction(debit([lyrics, music('MELODY_REF')])).title, 'Canción con melodía de referencia');
  assert.equal(describeTransaction(debit([lyrics, music('BEATBOX_RHYTHM')])).title, 'Canción con ritmo de referencia');
  // si una fila trajera la marca y a la vez un componente de música, manda la música
  assert.equal(describeTransaction(assistantDebit({}, [lyrics, music('TEXT_PROMPT')])).title, 'Creación de canción y letra');
  assert.equal(describeTransaction(assistantDebit({ source: 'otra' })).title, 'Creación de letra');
});

test('débito: la voz no se infiere del reason si el desglose no la confirma', () => {
  const reason = 'Generación (TEXT_PROMPT+VOICE_COVER) con Suno V6';
  assert.equal(describeTransaction(debit([music('TEXT_PROMPT')], reason)).title, 'Creación de canción');
  assert.equal(describeTransaction(debit([lyrics, music('TEXT_PROMPT')], reason)).title, 'Creación de canción y letra');
  assert.equal(describeTransaction(debit(undefined, reason)).title, 'Creación de canción');
});

test('débito: modalidades desconocidas se comunican como canción (no se afirma más)', () => {
  for (const g of ['ALGO_NUEVO', 'constructor', '__proto__', null, undefined]) {
    assert.equal(describeTransaction(debit([music(g)])).title, 'Creación de canción', String(g));
    assert.equal(describeTransaction(debit([lyrics, music(g)])).title, 'Creación de canción y letra', String(g));
  }
});

test('débito: solo componente de letra → «Creación de letra»', () => {
  assert.deepEqual(describeTransaction(debit([lyrics])), { title: 'Creación de letra', detail: null });
});

test('débito: componentes de tipo desconocido se ignoran si hay un MUSIC válido', () => {
  assert.equal(describeTransaction(debit([music('TEXT_PROMPT'), { type: 'OTRO', credits: 1 }])).title, 'Creación de canción');
});

test('débito: el reason con el modelo y los códigos nunca se usa para inferir modalidad', () => {
  const r = describeTransaction(debit([music('TEXT_PROMPT')], 'Generación (TEXT_PROMPT+VOICE_COVER+BEATBOX_RHYTHM) con Suno V6'));
  assert.deepEqual(r, { title: 'Creación de canción', detail: null });
});

test('portada: sin metadata, el respaldo es el comienzo del motivo', () => {
  const tx = { type: 'GENERATION_DEBIT', reason: 'Generación de portada (Suno V6)', metadata: null };
  assert.deepEqual(describeTransaction(tx), { title: 'Creación de portada', detail: null });
});

test('débito histórico sin desglose: texto genérico veraz, sin códigos', () => {
  const old = { type: 'GENERATION_DEBIT', reason: 'Generación (TEXT_PROMPT+VOICE_COVER) con Suno V6' };
  assert.deepEqual(describeTransaction(old), { title: 'Creación de canción', detail: null });
  assert.deepEqual(describeTransaction({ type: 'GENERATION_DEBIT', reason: null }), { title: 'Uso de fichas', detail: null });
  assert.deepEqual(describeTransaction({ type: 'GENERATION_DEBIT', reason: 'algo que no conozco' }), { title: 'Uso de fichas', detail: null });
});

test('metadata ausente o mal formada: no rompe y cae al respaldo', () => {
  const reason = 'Generación (TEXT_PROMPT) con Suno V6';
  const malformed = [
    undefined, null, 'texto', 42, [], {},
    { breakdown: null }, { breakdown: 'x' }, { breakdown: [] }, { breakdown: {} },
    { breakdown: { components: 'x' } }, { breakdown: { components: [] } },
    { breakdown: { components: [null] } }, { breakdown: { components: ['MUSIC'] } },
    { breakdown: { components: [{ credits: 3 }] } }, { breakdown: { components: [{ type: 7 }] } },
    // duplicados: el desglose real nunca los genera → se trata como inválido, no se adivina
    { breakdown: { components: [music('TEXT_PROMPT'), music('MELODY_REF')] } },
    { breakdown: { components: [lyrics, lyrics] } },
  ];
  for (const metadata of malformed) {
    const r = describeTransaction({ type: 'GENERATION_DEBIT', reason, metadata });
    assert.deepEqual(r, { title: 'Creación de canción', detail: null }, JSON.stringify(metadata));
  }
});

test('componentes con generationType no string se toleran', () => {
  const r = describeTransaction(debit([{ type: 'MUSIC', credits: 10, generationType: 123 }]));
  assert.equal(r.title, 'Creación de canción');
});

test('reintegros: motivo comprensible cuando se puede determinar', () => {
  const refund = (reason, metadata) => describeTransaction({ type: 'GENERATION_REFUND', reason, metadata });
  const meta = { scope: 'total', debited: 11, requested: 11, alreadyRefunded: 0 };
  assert.deepEqual(refund('Generación fallida', meta), { title: 'Devolución de fichas', detail: 'La generación no se completó' });
  assert.deepEqual(refund('Generación cancelada por el usuario', null), { title: 'Devolución de fichas', detail: 'Cancelaste la generación' });
  assert.deepEqual(refund('Reintegro por letras no generadas', { component: 'LYRICS' }), { title: 'Devolución de fichas', detail: 'La letra no se generó' });
  assert.equal(refund('otro motivo', { component: 'LYRICS' }).detail, 'La letra no se generó');
  assert.deepEqual(refund('motivo desconocido', meta), { title: 'Devolución de fichas', detail: null });
  assert.deepEqual(refund(null, undefined), { title: 'Devolución de fichas', detail: null });
});

test('planes: «Fichas de tu plan», con renovación cuando corresponde', () => {
  const grant = (reason, metadata) => describeTransaction({ type: 'PLAN_GRANT', reason, metadata });
  assert.deepEqual(grant('Plan Pro (período inicial)', { mock: true }), { title: 'Fichas de tu plan', detail: 'Plan Pro' });
  assert.deepEqual(grant('Plan Pro (renovación 30d)', { lazyRenewal: true }), { title: 'Fichas de tu plan', detail: 'Plan Pro · Renovación' });
  assert.deepEqual(grant('Plan Pro (renovación 30d)', null), { title: 'Fichas de tu plan', detail: 'Plan Pro · Renovación' });
  assert.deepEqual(grant('texto raro', { lazyRenewal: true }), { title: 'Fichas de tu plan', detail: 'Renovación' });
  assert.deepEqual(grant(null, undefined), { title: 'Fichas de tu plan', detail: null });
});

test('paquetes: «Compra de fichas» con el nombre comercial del paquete', () => {
  const pack = (reason) => describeTransaction({ type: 'PACKAGE_PURCHASE', reason, metadata: { mock: true, credits: 100, bonus: 0 } });
  assert.deepEqual(pack('Paquete 100 fichas'), { title: 'Compra de fichas', detail: 'Paquete 100 fichas' });
  assert.deepEqual(pack('algo distinto'), { title: 'Compra de fichas', detail: null });
  assert.deepEqual(pack(null), { title: 'Compra de fichas', detail: null });
});

test('bienvenida y ajustes administrativos', () => {
  assert.deepEqual(describeTransaction({ type: 'WELCOME_GRANT', reason: 'Bienvenida a Melodya' }), { title: 'Regalo de bienvenida', detail: null });
  assert.deepEqual(describeTransaction({ type: 'ADMIN_ADJUSTMENT', reason: '  regalito ' }), { title: 'Ajuste de Melodya', detail: 'regalito' });
  assert.deepEqual(describeTransaction({ type: 'ADMIN_ADJUSTMENT', reason: 'Regalo de Melodya' }), { title: 'Ajuste de Melodya', detail: 'Regalo de Melodya' });
  assert.deepEqual(describeTransaction({ type: 'ADMIN_ADJUSTMENT', reason: '   ' }), { title: 'Ajuste de Melodya', detail: null });
  assert.deepEqual(describeTransaction({ type: 'ADMIN_ADJUSTMENT', reason: null }), { title: 'Ajuste de Melodya', detail: null });
});

test('tipo desconocido: texto genérico, sin mostrar el código', () => {
  assert.deepEqual(describeTransaction({ type: 'NUEVO_TIPO_X', reason: 'lo que sea' }), { title: 'Movimiento de fichas', detail: null });
});

test('ninguna etiqueta de generación, devolución, plan o paquete expone modelos ni códigos internos', () => {
  const dirty = 'Generación (TEXT_PROMPT+VOICE_COVER+MELODY_REF+BEATBOX_RHYTHM) con Suno V6';
  const rows = [
    debit([music('TEXT_PROMPT')], dirty),
    debit([lyrics, music('MELODY_REF')], dirty),
    debit([lyrics, music('VOICE_COVER')], dirty),
    debit([lyrics, music('BEATBOX_RHYTHM')], dirty),
    debit([lyrics], dirty),
    assistantDebit({}, [lyrics], dirty),
    debit(undefined, dirty),
    { type: 'GENERATION_DEBIT', reason: 'Generación de portada (Suno V6)' },
    { type: 'GENERATION_DEBIT', reason: 'Suno V6 TEXT_PROMPT' },
    { type: 'GENERATION_DEBIT', reason: null, metadata: { breakdown: { components: [{ type: 'MUSIC', generationType: 'VOICE_COVER' }] } } },
    { type: 'GENERATION_REFUND', reason: 'Generación fallida' },
    { type: 'GENERATION_REFUND', reason: 'Reintegro Suno V6 TEXT_PROMPT' },
    { type: 'PLAN_GRANT', reason: 'Plan Pro (renovación 30d)' },
    { type: 'PACKAGE_PURCHASE', reason: 'Paquete 100 fichas' },
    { type: 'WELCOME_GRANT', reason: 'Suno V6' },
    { type: 'TIPO_RARO_LYRICS', reason: 'Suno V6' },
  ];
  for (const tx of rows) {
    const { title, detail } = describeTransaction(tx);
    assert.doesNotMatch(title, LEAK, JSON.stringify(tx));
    assert.doesNotMatch(detail ?? '', LEAK, JSON.stringify(tx));
  }
});

const view = fs.readFileSync(new URL('../src/features/activity/ActivityHistory.tsx', import.meta.url), 'utf8');
const row = view.slice(view.indexOf('function TransactionRow'), view.indexOf('/** Generación sin movimientos'));

test('Mi actividad: TransactionRow usa describeTransaction, no interpola el reason ni usa efectos', () => {
  assert.match(view, /import \{ describeTransaction \} from '\.\.\/billing\/transaction-label';/);
  assert.match(row, /describeTransaction\(tx\)/);
  assert.doesNotMatch(row, /tx\.reason/);
  assert.doesNotMatch(row, /useEffect|useState/);
  assert.match(row, /formatRelative\(tx\.createdAt\)/);
  assert.match(row, /Math\.abs\(tx\.amount\)/);
  assert.match(row, /Saldo \{fmtInt\(tx\.balanceAfter\)\}/);
});
