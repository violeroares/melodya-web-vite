// Reacciones de Comunidad (Me gusta / No me gusta): actualización optimista de las cachés con un QueryClient REAL (@tanstack/query-core).
// Regresión del bug: «No pudimos registrar tu reacción — Cannot read properties of undefined (reading 'map')». Una consulta bajo
// ['community','feed',…] con forma { items } (authorsPool de Descubrir) hacía fallar `onMutate` y, con eso, el POST ni se enviaba.
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QueryClient, MutationObserver } from '@tanstack/query-core';

const { applyReaction, updateSongInCaches, communityReactionOptions } = await import('../src/features/community/reaction-cache.ts');

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/* ───────────── fixtures ───────────── */

const SONG = (id, over = {}) => ({ id, title: id, likesCount: 3, dislikesCount: 1, viewerReaction: null, ...over });
const detail = (id, over = {}) => ({ ...SONG(id, over), allowComments: true, comments: { items: [] } });
const infinite = (...pages) => ({ pages: pages.map((items) => ({ items, pagination: { page: 1, pages: 1, total: items.length } })), pageParams: pages.map((_, i) => i + 1) });
const keys = {
  detail: (id = 'A') => ['community', 'song', id],
  feed: ['community', 'feed', { sort: 'newest' }],
  rail: ['community', 'feed', { rail: 'most_liked' }],
  authorsPool: ['community', 'feed', { authorsPool: 50 }], // forma { items }: la que rompía la actualización
  userSongs: ['community', 'user', 'u1', 'songs'],
};

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
}

/**
 * Armado idéntico al de `useCommunityReaction`: las opciones REALES (`communityReactionOptions`) y un «backend» que se comporta como el toggle de
 * POST /songs/:id/react. Devuelve lo que pasó (pedidos, avisos, estado del servidor).
 */
function harness(qc, { failWith = null } = {}) {
  const calls = [];
  const toasts = [];
  let server = null; // reacción registrada para el usuario
  const react = async (id, type) => {
    calls.push(`${id}:${type}`);
    if (failWith) throw failWith;
    server = server === type ? null : type;
    return { reaction: server };
  };
  const observer = new MutationObserver(qc, communityReactionOptions(qc, react, (err) => toasts.push(err)));
  const tap = async (type, id = 'A') => {
    try { await observer.mutate({ id, type }); return 'ok'; } catch (err) { return err; }
  };
  return { calls, toasts, tap, server: () => server };
}

/* ───────────── applyReaction (puro) ───────────── */

test('applyReaction: primera reacción, quitar, cambiar de tipo y contadores que nunca bajan de 0', () => {
  const base = SONG('A', { likesCount: 3, dislikesCount: 1 });
  const liked = applyReaction(base, 'LIKE');
  assert.deepEqual([liked.viewerReaction, liked.likesCount, liked.dislikesCount], ['LIKE', 4, 1]);
  const unliked = applyReaction(liked, 'LIKE');
  assert.deepEqual([unliked.viewerReaction, unliked.likesCount, unliked.dislikesCount], [null, 3, 1], 'repetir el mismo tipo lo quita');
  const switched = applyReaction(liked, 'DISLIKE');
  assert.deepEqual([switched.viewerReaction, switched.likesCount, switched.dislikesCount], ['DISLIKE', 3, 2], 'cambiar de tipo mueve el contador');
  const floor = applyReaction(SONG('A', { likesCount: 0, viewerReaction: 'LIKE' }), 'LIKE');
  assert.equal(floor.likesCount, 0, 'no baja de 0');
  assert.equal(base.likesCount, 3, 'no muta la canción original');
});

/* ───────────── 1 · caché vacía ───────────── */

test('caché vacía: la mutación envía el POST, no falla y no inventa datos', async () => {
  const qc = newClient();
  const h = harness(qc);
  assert.equal(await h.tap('LIKE'), 'ok');
  assert.deepEqual(h.calls, ['A:LIKE']);
  assert.deepEqual(h.toasts, []);
  assert.equal(qc.getQueryCache().getAll().length, 0);
});

/* ───────────── 2-3 · feed infinito y lista simple ───────────── */

test('feed infinito: actualiza solo la canción pedida, en todas las páginas, y conserva pageParams', async () => {
  const qc = newClient();
  qc.setQueryData(keys.feed, infinite([SONG('A'), SONG('B')], [SONG('C'), SONG('A')]));
  qc.setQueryData(keys.rail, infinite([SONG('A')]));
  const h = harness(qc);
  assert.equal(await h.tap('LIKE'), 'ok');
  const feed = qc.getQueryData(keys.feed);
  assert.deepEqual(feed.pages.map((p) => p.items.map((s) => [s.id, s.viewerReaction, s.likesCount])), [[['A', 'LIKE', 4], ['B', null, 3]], [['C', null, 3], ['A', 'LIKE', 4]]]);
  assert.deepEqual(feed.pageParams, [1, 2]);
  assert.equal(feed.pages[0].pagination.total, 2, 'conserva el resto de la página');
  assert.equal(qc.getQueryData(keys.rail).pages[0].items[0].viewerReaction, 'LIKE');
});

test('lista simple del creador (perfil público): se actualiza y conserva el resto', async () => {
  const qc = newClient();
  qc.setQueryData(keys.userSongs, { items: [SONG('A'), SONG('B')], pagination: { page: 1, pages: 1, total: 2 } });
  const h = harness(qc);
  assert.equal(await h.tap('DISLIKE'), 'ok');
  const list = qc.getQueryData(keys.userSongs);
  assert.deepEqual(list.items.map((s) => [s.id, s.viewerReaction, s.dislikesCount]), [['A', 'DISLIKE', 2], ['B', null, 1]]);
  assert.equal(list.pagination.total, 2);
});

/* ───────────── 4 · authorsPool { items } (el caso del bug) ───────────── */

test('authorsPool { items } bajo la clave del feed: no rompe la mutación y su lista también se actualiza', async () => {
  const qc = newClient();
  qc.setQueryData(keys.detail(), detail('A'));
  qc.setQueryData(keys.authorsPool, { items: [SONG('A'), SONG('B')] });
  qc.setQueryData(keys.feed, infinite([SONG('A')]));
  const h = harness(qc);
  assert.equal(await h.tap('LIKE'), 'ok');
  assert.deepEqual(h.toasts, [], 'sin aviso de error');
  assert.deepEqual(qc.getQueryData(keys.authorsPool).items.map((s) => [s.id, s.viewerReaction]), [['A', 'LIKE'], ['B', null]]);
  assert.equal(qc.getQueryData(keys.detail()).viewerReaction, 'LIKE');
  assert.equal(qc.getQueryData(keys.detail()).likesCount, 4);
  assert.equal(qc.getQueryData(keys.feed).pages[0].items[0].viewerReaction, 'LIKE', 'las demás cachés también quedan consistentes');
});

/* ───────────── 5-6 · datos inesperados ───────────── */

test('datos undefined, formas desconocidas y páginas sin items: se dejan como están y la mutación sigue', async () => {
  const qc = newClient();
  qc.setQueryData(keys.detail(), detail('A'));
  qc.setQueryData(['community', 'feed', { sort: 'sin-datos' }], undefined);
  qc.setQueryData(['community', 'feed', { sort: 'forma-rara' }], { total: 3 });
  qc.setQueryData(['community', 'feed', { sort: 'null' }], null);
  qc.setQueryData(['community', 'feed', { sort: 'pages-vacias' }], { pages: [], pageParams: [] });
  qc.setQueryData(['community', 'feed', { sort: 'sin-items' }], { pages: [{ pagination: { page: 1 } }, null, { items: undefined }, { items: [SONG('A')] }], pageParams: [1, 2, 3, 4] });
  qc.setQueryData(['community', 'user', 'u1', 'songs'], { pagination: {} }); // lista sin items
  qc.setQueryData(['community', 'user', 'u1', 'songs', 'x'], undefined);
  const before = JSON.stringify([
    qc.getQueryData(['community', 'feed', { sort: 'forma-rara' }]),
    qc.getQueryData(['community', 'feed', { sort: 'pages-vacias' }]),
    qc.getQueryData(['community', 'user', 'u1', 'songs']),
  ]);
  const h = harness(qc);
  assert.equal(await h.tap('LIKE'), 'ok');
  assert.deepEqual(h.calls, ['A:LIKE']);
  assert.deepEqual(h.toasts, []);
  assert.equal(JSON.stringify([
    qc.getQueryData(['community', 'feed', { sort: 'forma-rara' }]),
    qc.getQueryData(['community', 'feed', { sort: 'pages-vacias' }]),
    qc.getQueryData(['community', 'user', 'u1', 'songs']),
  ]), before, 'las formas desconocidas se devuelven sin modificar');
  assert.equal(qc.getQueryData(['community', 'feed', { sort: 'sin-items' }]).pages[3].items[0].viewerReaction, 'LIKE', 'las páginas válidas se actualizan igual');
  assert.equal(qc.getQueryData(keys.detail()).viewerReaction, 'LIKE');
});

/* ───────────── 7-8 · Like, Unlike y Dislike consecutivos ───────────── */

test('Like → Unlike → Dislike → Like: cada toque envía su POST y los contadores y viewerReaction siguen al servidor (con todas las cachés a la vez)', async () => {
  const qc = newClient();
  const seed = () => {
    qc.setQueryData(keys.detail(), detail('A', { likesCount: 5, dislikesCount: 2 }));
    qc.setQueryData(keys.feed, infinite([SONG('A', { likesCount: 5, dislikesCount: 2 })]));
    qc.setQueryData(keys.authorsPool, { items: [SONG('A', { likesCount: 5, dislikesCount: 2 })] });
    qc.setQueryData(keys.userSongs, { items: [SONG('A', { likesCount: 5, dislikesCount: 2 })] });
  };
  seed();
  const h = harness(qc);
  const snap = () => {
    const d = qc.getQueryData(keys.detail());
    return [d.viewerReaction, d.likesCount, d.dislikesCount];
  };
  const everywhere = () => {
    const states = [
      qc.getQueryData(keys.detail()),
      qc.getQueryData(keys.feed).pages[0].items[0],
      qc.getQueryData(keys.authorsPool).items[0],
      qc.getQueryData(keys.userSongs).items[0],
    ].map((s) => [s.viewerReaction, s.likesCount, s.dislikesCount]);
    assert.ok(states.every((s) => JSON.stringify(s) === JSON.stringify(states[0])), `cachés inconsistentes: ${JSON.stringify(states)}`);
  };
  // El «backend» no invalida de verdad en este arnés (no hay observadores activos): se comprueba el estado optimista.
  await h.tap('LIKE'); assert.deepEqual(snap(), ['LIKE', 6, 2]); everywhere(); assert.equal(h.server(), 'LIKE');
  await h.tap('LIKE'); assert.deepEqual(snap(), [null, 5, 2]); everywhere(); assert.equal(h.server(), null, 'el segundo toque quita (Unlike)');
  await h.tap('DISLIKE'); assert.deepEqual(snap(), ['DISLIKE', 5, 3]); everywhere(); assert.equal(h.server(), 'DISLIKE');
  await h.tap('LIKE'); assert.deepEqual(snap(), ['LIKE', 6, 2], 'cambiar de tipo mueve el contador'); everywhere(); assert.equal(h.server(), 'LIKE');
  assert.deepEqual(h.calls, ['A:LIKE', 'A:LIKE', 'A:DISLIKE', 'A:LIKE']);
  assert.deepEqual(h.toasts, []);
});

test('la reacción de una canción no toca a las demás ni al detalle de otra canción', async () => {
  const qc = newClient();
  qc.setQueryData(keys.detail('A'), detail('A'));
  qc.setQueryData(keys.detail('B'), detail('B'));
  qc.setQueryData(keys.authorsPool, { items: [SONG('A'), SONG('B')] });
  const h = harness(qc);
  await h.tap('LIKE', 'A');
  assert.equal(qc.getQueryData(keys.detail('B')).viewerReaction, null);
  assert.equal(qc.getQueryData(keys.authorsPool).items[1].viewerReaction, null);
});

/* ───────────── 9 · el POST se ejecuta aun con authorsPool en caché ───────────── */

test('REGRESIÓN: con authorsPool en caché el POST /songs/:id/react SE ENVÍA (antes onMutate lanzaba y el Me gusta nunca llegaba al backend)', async () => {
  const qc = newClient();
  qc.setQueryData(keys.detail(), detail('A'));
  qc.setQueryData(keys.authorsPool, { items: [SONG('A')] });
  const h = harness(qc);
  const outcome = await h.tap('LIKE');
  assert.equal(outcome, 'ok', `la mutación no debe lanzar: ${outcome?.message}`);
  assert.deepEqual(h.calls, ['A:LIKE'], 'el pedido salió');
  assert.equal(h.server(), 'LIKE', 'quedó registrada en el servidor');
  assert.deepEqual(h.toasts, [], 'sin «No pudimos registrar tu reacción»');
});

test('REGRESIÓN: varios toques seguidos con authorsPool en caché no fallan (antes fallaban todos, uno tras otro)', async () => {
  const qc = newClient();
  qc.setQueryData(keys.detail(), detail('A'));
  qc.setQueryData(keys.authorsPool, { items: [SONG('A')] });
  const h = harness(qc);
  for (const type of ['LIKE', 'LIKE', 'DISLIKE']) assert.equal(await h.tap(type), 'ok', type);
  assert.deepEqual(h.calls, ['A:LIKE', 'A:LIKE', 'A:DISLIKE']);
  assert.equal(h.server(), 'DISLIKE');
});

/* ───────────── 10 · error del backend: el comportamiento no empeora ───────────── */

test('error del backend: se avisa una vez, el POST se intentó y el estado optimista queda igual que antes (sin rollback nuevo)', async () => {
  const boom = new Error('Error del backend');
  const qc = newClient();
  qc.setQueryData(keys.detail(), detail('A'));
  qc.setQueryData(keys.feed, infinite([SONG('A')]));
  const h = harness(qc, { failWith: boom });
  const outcome = await h.tap('LIKE');
  assert.equal(outcome, boom);
  assert.deepEqual(h.calls, ['A:LIKE']);
  assert.deepEqual(h.toasts, [boom], 'un solo aviso, con el error original');
  assert.equal(qc.getQueryData(keys.detail()).viewerReaction, 'LIKE', 'sin rollback: lo repone la invalidación de onSettled (igual que hoy)');
  assert.equal(h.server(), null, 'el backend no registró nada');
});

test('error del backend con authorsPool en caché: mismo comportamiento (aviso del backend, no el TypeError) y la lista de authorsPool también queda optimista', async () => {
  const boom = new Error('Error del backend');
  const qc = newClient();
  qc.setQueryData(keys.detail(), detail('A'));
  qc.setQueryData(keys.authorsPool, { items: [SONG('A')] });
  const h = harness(qc, { failWith: boom });
  assert.equal(await h.tap('LIKE'), boom);
  assert.deepEqual(h.calls, ['A:LIKE']);
  assert.deepEqual(h.toasts, [boom], "el aviso es por el backend, no por «reading 'map'»");
  assert.equal(qc.getQueryData(keys.authorsPool).items[0].viewerReaction, 'LIKE');
});

test('onSettled invalida la familia [community] (también tras un error) para re-sincronizar los contadores reales', async () => {
  for (const failWith of [null, new Error('x')]) {
    const qc = newClient();
    qc.setQueryData(keys.detail(), detail('A'));
    qc.setQueryData(keys.authorsPool, { items: [SONG('A')] });
    const h = harness(qc, { failWith });
    await h.tap('LIKE');
    for (const key of [keys.detail(), keys.authorsPool]) assert.equal(qc.getQueryState(key).isInvalidated, true, `${failWith ? 'con error' : 'ok'} · ${JSON.stringify(key)}`);
  }
});

/* ───────────── updateSongInCaches directo ───────────── */

test('updateSongInCaches: no lanza con ninguna forma bajo [community,…] y devuelve las desconocidas sin tocar', () => {
  const qc = newClient();
  const weird = [undefined, null, {}, [], { pages: 'x' }, { pages: [{ items: 'x' }] }, { items: 'x' }, { items: [] }, 42];
  weird.forEach((value, i) => qc.setQueryData(['community', 'feed', { w: i }], value));
  weird.forEach((value, i) => qc.setQueryData(['community', 'user', 'u', 'songs', i], value));
  assert.doesNotThrow(() => updateSongInCaches(qc, 'A', (s) => ({ ...s, likesCount: 99 })));
});

/* ───────────── estructura ───────────── */

test('el hook usa las opciones puras y CommunityView ya no actualiza cachés con .pages.map a ciegas', () => {
  const view = read('src/features/community/CommunityView.tsx');
  assert.match(view, /communityReactionOptions\(qc, \(id, type\) => songsApi\.react\(id, type\)/);
  assert.equal(view.includes('old.pages.map'), false);
  assert.equal(view.includes('function updateSongInCaches'), false);
  const mod = read('src/features/community/reaction-cache.ts');
  assert.equal(/from 'react'|from "react"|\.tsx/.test(mod), false, 'sin React ni componentes');
  assert.match(mod, /Array\.isArray\(old\.pages\)/);
  assert.match(mod, /Array\.isArray\(old\.items\)/);
  // la clave de authorsPool no se cambió (decisión: la guardia es la corrección)
  assert.match(read('src/features/community/CommunityDiscover.tsx'), /queryKey: \['community', 'feed', \{ authorsPool: AUTHORS_POOL \}\]/);
});
