// Mi actividad: línea de tiempo combinada de movimientos de fichas y generaciones, y su paginación (src/features/activity/timeline.ts).
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const T = await import('../src/features/activity/timeline.ts');
const { buildTimeline, dedupe, visibleWindow, BOUNDARY_MARGIN_MS } = T;

const BASE = Date.parse('2026-11-01T00:00:00Z');
const at = (min) => new Date(BASE + min * 60_000).toISOString();
const tx = (id, min, type, genId = null, extra = {}) => ({ id, type, createdAt: at(min), referenceType: genId ? 'Generation' : null, referenceId: genId, ...extra });
const gen = (id, min, extra = {}) => ({ id, createdAt: at(min), creditsCost: 5, status: 'COMPLETED', ...extra });

/** Simula las páginas del servidor (más reciente primero). */
function paginate(all, pageSize) {
  const sorted = [...all].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { page: (n) => sorted.slice((n - 1) * pageSize, n * pageSize), pages: Math.max(1, Math.ceil(sorted.length / pageSize)) };
}

/** Simula a un usuario que pulsa «Ver más» hasta el final: devuelve la lista visible en cada paso. */
function run({ txSets, gens, txPage = 3, genPage = 3 }) {
  const txSrc = txSets.map((items) => ({ ...paginate(items, txPage), loaded: 1 }));
  const genSrc = gens ? { ...paginate(gens, genPage), loaded: 1 } : null;
  const loadedItems = (s) => Array.from({ length: s.loaded }, (_, k) => s.page(k + 1)).flat();
  const view = () => buildTimeline({
    tx: txSrc.map((s, i) => ({ id: `tx${i}`, items: loadedItems(s), hasMore: s.loaded < s.pages })),
    generations: genSrc ? { id: 'gen', items: loadedItems(genSrc), hasMore: genSrc.loaded < genSrc.pages } : null,
  });
  const steps = [view()];
  for (let guard = 0; steps[steps.length - 1].hasMore && guard < 100; guard += 1) {
    const last = steps[steps.length - 1];
    for (const id of last.binding) {
      if (id === 'gen') genSrc.loaded += 1;
      else txSrc[Number(id.slice(2))].loaded += 1;
    }
    steps.push(view());
  }
  return steps;
}

/* ───────── Relación y no duplicación ───────── */

test('un débito y su reintegro siguen siendo dos filas reales; la generación NO se repite como fila propia', () => {
  const g = gen('g1', 10, { status: 'FAILED' });
  const out = buildTimeline({
    tx: [{ id: 'tx0', hasMore: false, items: [tx('r1', 11, 'GENERATION_REFUND', 'g1'), tx('d1', 10, 'GENERATION_DEBIT', 'g1')] }],
    generations: { id: 'gen', hasMore: false, items: [g] },
  });
  assert.deepEqual(out.entries.map((e) => e.key), ['tx:r1', 'tx:d1']);
  assert.equal(out.entries[1].generation.id, 'g1');
  assert.equal(out.entries[1].refundEvidence, true, 'hay reintegro cargado de ESA generación');
});

test('sin el reintegro cargado no se afirma ninguna devolución', () => {
  const out = buildTimeline({
    tx: [{ id: 'tx0', hasMore: false, items: [tx('d1', 10, 'GENERATION_DEBIT', 'g1')] }],
    generations: { id: 'gen', hasMore: false, items: [gen('g1', 10, { status: 'FAILED' })] },
  });
  assert.equal(out.entries[0].refundEvidence, false);
});

test('el reintegro de OTRA generación no cuenta como evidencia', () => {
  const out = buildTimeline({
    tx: [{ id: 'tx0', hasMore: false, items: [tx('r2', 12, 'GENERATION_REFUND', 'g2'), tx('d1', 10, 'GENERATION_DEBIT', 'g1')] }],
    generations: { id: 'gen', hasMore: false, items: [gen('g1', 10, { status: 'FAILED' }), gen('g2', 11, { status: 'FAILED' })] },
  });
  assert.equal(out.entries.find((e) => e.key === 'tx:d1').refundEvidence, false);
});

test('una generación sin ningún movimiento (p. ej. una fallida sin cobro) sigue apareciendo', () => {
  const out = buildTimeline({
    tx: [{ id: 'tx0', hasMore: false, items: [tx('d1', 10, 'GENERATION_DEBIT', 'g1')] }],
    generations: { id: 'gen', hasMore: false, items: [gen('g1', 10), gen('g0', 20, { status: 'FAILED', creditsCost: 0 })] },
  });
  assert.deepEqual(out.entries.map((e) => e.key), ['gen:g0', 'tx:d1']);
});

test('compras y ajustes no se tocan; un débito cuya generación no está en la lista (letras del asistente) queda como fila normal', () => {
  const out = buildTimeline({
    tx: [{ id: 'tx0', hasMore: false, items: [tx('p1', 5, 'PACKAGE_PURCHASE'), tx('d9', 4, 'GENERATION_DEBIT', 'asistente')] }],
    generations: { id: 'gen', hasMore: false, items: [] },
  });
  assert.equal(out.entries.length, 2);
  assert.ok(out.entries.every((e) => e.kind === 'tx' && e.generation === null));
});

test('sin fuente de generaciones (Compras, Devoluciones) la lista son solo los movimientos', () => {
  const out = buildTimeline({ tx: [{ id: 'tx0', hasMore: false, items: [tx('p1', 5, 'PACKAGE_PURCHASE')] }], generations: null });
  assert.equal(out.entries.length, 1);
  assert.equal(out.hasMore, false);
});

test('dedupe conserva la primera aparición y el orden', () => {
  assert.deepEqual(dedupe([{ id: 'a', v: 1 }, { id: 'b' }, { id: 'a', v: 2 }]).map((x) => x.v ?? x.id), [1, 'b']);
});

/* ───────── Paginación combinada ───────── */

function dataset() {
  const txs = [];
  const gens = [];
  // 12 generaciones, una por hora; las pares fallan y se reintegran; cada 5.ª no tiene movimiento (sin costo)
  for (let i = 0; i < 12; i += 1) {
    const min = 1000 - i * 60;
    const failed = i % 2 === 0;
    const free = i % 5 === 4;
    gens.push(gen(`g${i}`, min, { status: failed ? 'FAILED' : 'COMPLETED', creditsCost: free ? 0 : 5, retriedBy: failed && i % 4 === 0 ? `g${i}r` : null }));
    if (!free) {
      txs.push(tx(`d${i}`, min, 'GENERATION_DEBIT', `g${i}`));
      if (failed) txs.push(tx(`r${i}`, min + 1, 'GENERATION_REFUND', `g${i}`));
    }
  }
  for (let i = 0; i < 5; i += 1) txs.push(tx(`p${i}`, 990 - i * 130, i % 2 ? 'PACKAGE_PURCHASE' : 'PLAN_GRANT'));
  return { txs, gens };
}

test('paginación combinada (Todas): sin duplicados, sin omitidos y con el mismo resultado que cargar todo', () => {
  const { txs, gens } = dataset();
  for (const [txPage, genPage] of [[3, 3], [2, 5], [10, 1], [4, 7]]) {
    const steps = run({ txSets: [txs], gens, txPage, genPage });
    const final = steps[steps.length - 1];
    const keys = final.entries.map((e) => e.key);
    assert.equal(new Set(keys).size, keys.length, `sin duplicados (${txPage}/${genPage})`);
    const everything = buildTimeline({ tx: [{ id: 'tx0', hasMore: false, items: txs }], generations: { id: 'gen', hasMore: false, items: gens } });
    assert.deepEqual(keys, everything.entries.map((e) => e.key), `no omite ni reordena (${txPage}/${genPage})`);
    assert.equal(keys.filter((k) => k.startsWith('tx:')).length, txs.length);
    assert.equal(keys.filter((k) => k.startsWith('gen:')).length, gens.filter((g) => !txs.some((t) => t.referenceId === g.id)).length);
  }
});

test('paginación combinada: cada paso solo AGREGA al final (sin saltos cronológicos) y el orden es siempre descendente', () => {
  const { txs, gens } = dataset();
  const steps = run({ txSets: [txs], gens, txPage: 3, genPage: 4 });
  for (let i = 1; i < steps.length; i += 1) {
    const prev = steps[i - 1].entries.map((e) => e.key);
    const next = steps[i].entries.map((e) => e.key);
    assert.deepEqual(next.slice(0, prev.length), prev, `el paso ${i} conserva lo ya mostrado`);
  }
  for (const s of steps) for (let i = 1; i < s.entries.length; i += 1) assert.ok(s.entries[i - 1].at >= s.entries[i].at, 'orden descendente');
  assert.ok(steps.length > 2, 'hizo falta paginar');
});

test('paginación combinada: la lista avanza en cada paso y termina', () => {
  const { txs, gens } = dataset();
  const steps = run({ txSets: [txs], gens, txPage: 3, genPage: 3 });
  assert.equal(steps[steps.length - 1].hasMore, false);
  for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i].entries.length >= steps[i - 1].entries.length);
});

test('las acciones de la generación no desaparecen al cargar más páginas', () => {
  const { txs, gens } = dataset();
  const steps = run({ txSets: [txs], gens, txPage: 3, genPage: 3 });
  const attached = new Map();
  for (const s of steps) {
    for (const e of s.entries) if (e.kind === 'tx' && e.tx.type === 'GENERATION_DEBIT' && e.generation) attached.set(e.key, e.generation.id);
    for (const e of s.entries) if (e.kind === 'tx' && attached.has(e.key)) assert.equal(e.generation?.id, attached.get(e.key), `${e.key} conserva su generación`);
  }
  const last = steps[steps.length - 1];
  for (const e of last.entries) if (e.kind === 'tx' && e.tx.type === 'GENERATION_DEBIT') assert.ok(e.generation, e.key);
});

test('una generación nunca aparece como fila propia para duplicarse después con su débito', () => {
  const { txs, gens } = dataset();
  const steps = run({ txSets: [txs], gens, txPage: 2, genPage: 6 }); // las generaciones se cargan mucho antes que los movimientos
  for (const s of steps) {
    for (const e of s.entries) if (e.kind === 'generation') assert.ok(!txs.some((t) => t.referenceId === e.generation.id), `gen ${e.generation.id}`);
  }
});

test('Compras (dos fuentes por tipo): sin saltos cronológicos aunque cada tipo tenga fechas muy distintas', () => {
  const a = [0, 1, 2, 3, 4, 5].map((i) => tx(`a${i}`, 500 - i * 10, 'PACKAGE_PURCHASE'));
  const b = [0, 1, 2, 3].map((i) => tx(`b${i}`, 100 - i * 10, 'PLAN_GRANT'));
  const steps = run({ txSets: [a, b], gens: null, txPage: 2 });
  for (let i = 1; i < steps.length; i += 1) {
    const prev = steps[i - 1].entries.map((e) => e.key);
    assert.deepEqual(steps[i].entries.map((e) => e.key).slice(0, prev.length), prev);
  }
  const final = steps[steps.length - 1].entries.map((e) => e.key);
  assert.deepEqual(final, [...a, ...b].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt)).map((x) => `tx:${x.id}`));
});

test('ventana: el borde lo marca la fuente con páginas pendientes más reciente, con margen para la diferencia débito/generación', () => {
  const w = visibleWindow([
    { id: 'tx0', hasMore: true, items: [tx('x', 100, 'GENERATION_DEBIT')] },
    { id: 'gen', hasMore: true, items: [gen('g', 300)] },
    { id: 'done', hasMore: false, items: [gen('h', 1)] },
  ]);
  // con una sola fila cargada el borde es esa fila (el margen nunca supera lo más nuevo cargado)
  assert.equal(w.cutoff, Date.parse(at(300)));
  const wide = visibleWindow([{ id: 'x', hasMore: true, items: [gen('a', 300), gen('b', 100)] }]);
  assert.equal(wide.cutoff, Date.parse(at(100)) + BOUNDARY_MARGIN_MS, 'con filas separadas, el margen protege el borde');
  assert.deepEqual(w.binding, ['gen']);
  assert.equal(visibleWindow([{ id: 'a', hasMore: false, items: [] }]).cutoff, null);
});

test('una página entera dentro del margen (filas del mismo instante) igual muestra lo más nuevo, sin dejar la lista vacía', () => {
  const same = [0, 1, 2, 3].map((i) => ({ ...tx(`s${i}`, 500, 'GENERATION_DEBIT', `g${i}`), createdAt: new Date(BASE + 500 * 60_000 + i * 10).toISOString() }));
  const out = buildTimeline({ tx: [{ id: 'tx0', hasMore: true, items: same }], generations: null });
  assert.ok(out.entries.length >= 1, 'no queda vacía');
  assert.equal(out.entries[0].key, 'tx:s3');
  assert.equal(out.hasMore, true);
  // al cargar una página más vieja el borde baja y aparece todo lo anterior
  const older = [tx('o1', 100, 'GENERATION_DEBIT', 'go1')];
  const next = buildTimeline({ tx: [{ id: 'tx0', hasMore: false, items: [...same, ...older] }], generations: null });
  assert.equal(next.entries.length, 5);
});

/* ───────── Cableado ───────── */

test('Planes y fichas ya no tiene el historial y enlaza a Mi actividad; Perfil usa el historial unificado', () => {
  const pricing = fs.readFileSync(new URL('../src/features/billing/PricingView.tsx', import.meta.url), 'utf8');
  assert.ok(!pricing.includes('Tu actividad de fichas'));
  assert.ok(!pricing.includes('function TransactionRow'));
  assert.match(pricing, /navigate\('\/profile\/activity'\)/);
  assert.match(pricing, /Ver mi actividad/);
  // una compra sigue refrescando el historial: ahora por el mecanismo central (lib/commercial-state invalida ['transactions'])
  assert.match(pricing, /useRefreshCommercialState()/, 'una compra sigue refrescando el historial');
  assert.match(fs.readFileSync(new URL('../src/lib/commercial-state.ts', import.meta.url), 'utf8'), /['transactions']/);
  const hist = fs.readFileSync(new URL('../src/features/activity/ActivityHistory.tsx', import.meta.url), 'utf8');
  assert.match(hist, /queryKey: \['transactions', 'activity'/, 'prefijo invalidable por una compra');
  assert.match(hist, /byId\[id\]\?\.fetchNextPage\(\)/, 'Ver más pide la página a la fuente que define el borde');
});

/* ───────── Filas a pocos milisegundos y con createdAt idénticos ───────── */

const msAt = (ms) => new Date(BASE + ms).toISOString();
/** n generaciones separadas `spacing` ms; cada débito `skew` ms después de su generación (negativo = antes); las pares fallan y se reintegran. */
function denseDataset({ n = 14, spacing, skew = 0 }) {
  const txs = [];
  const gens = [];
  for (let i = 0; i < n; i += 1) {
    const id = String(i).padStart(3, '0');
    const t = 1_000_000 - i * spacing;
    gens.push({ id: `g${id}`, createdAt: msAt(t), creditsCost: 5, status: i % 2 ? 'COMPLETED' : 'FAILED' });
    txs.push({ id: `d${id}`, type: 'GENERATION_DEBIT', createdAt: msAt(t + skew), referenceType: 'Generation', referenceId: `g${id}` });
    if (i % 2 === 0) txs.push({ id: `r${id}`, type: 'GENERATION_REFUND', createdAt: msAt(t + skew + 1), referenceType: 'Generation', referenceId: `g${id}` });
  }
  return { txs, gens };
}

/** «Ver más» hasta el final con el servidor ordenando solo por createdAt: los empates salen en el orden `tie` (asc o desc por id). */
function runDense({ txs, gens, txPage, genPage, tie }) {
  const server = (all) => [...all].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (tie === 'desc' ? (a.id < b.id ? 1 : -1) : (a.id < b.id ? -1 : 1)));
  const T = server(txs);
  const G = server(gens);
  const tPages = Math.ceil(T.length / txPage);
  const gPages = Math.ceil(G.length / genPage);
  let tl = 1;
  let gl = 1;
  const view = () => buildTimeline({
    tx: [{ id: 'tx0', items: T.slice(0, tl * txPage), hasMore: tl < tPages }],
    generations: { id: 'gen', items: G.slice(0, gl * genPage), hasMore: gl < gPages },
  });
  const steps = [view()];
  for (let guard = 0; steps.at(-1).hasMore && guard < 300; guard += 1) {
    for (const id of steps.at(-1).binding) { if (id === 'gen') gl += 1; else tl += 1; }
    steps.push(view());
  }
  return steps;
}

const fullView = ({ txs, gens }) => buildTimeline({ tx: [{ id: 'tx0', items: txs, hasMore: false }], generations: { id: 'gen', items: gens, hasMore: false } });
const SPACINGS = [0, 1, 3, 4_000, 60_000];
const SKEWS = [0, -2, 2];
const PAGES = [[3, 3], [4, 7], [10, 10], [2, 5]];

test('milisegundos y empates: sin duplicados, sin omisiones, orden descendente y el mismo resultado final que cargar todo (con cualquier tamaño de página y orden de empates)', () => {
  for (const spacing of SPACINGS) {
    for (const skew of SKEWS) {
      const ds = denseDataset({ spacing, skew });
      const full = fullView(ds).entries.map((e) => e.key);
      assert.equal(new Set(full).size, full.length);
      for (const [txPage, genPage] of PAGES) {
        for (const tie of ['asc', 'desc']) {
          const steps = runDense({ ...ds, txPage, genPage, tie });
          const label = `espaciado ${spacing} ms, desfase ${skew} ms, páginas ${txPage}/${genPage}, empates ${tie}`;
          const final = steps.at(-1);
          const keys = final.entries.map((e) => e.key);
          assert.equal(final.hasMore, false, `${label}: termina`);
          assert.equal(new Set(keys).size, keys.length, `${label}: sin duplicados`);
          assert.deepEqual(keys, full, `${label}: sin omisiones y en el mismo orden que cargando todo`);
          for (const s of steps) for (let i = 1; i < s.entries.length; i += 1) assert.ok(s.entries[i - 1].at >= s.entries[i].at, `${label}: orden descendente`);
          // ninguna generación se muestra sola en ningún paso: todas tienen su débito en los datos
          for (const s of steps) assert.ok(!s.entries.some((e) => e.kind === 'generation'), `${label}: no hay filas de generación duplicadas`);
          // «Ver más» siempre avanza: lo visible nunca disminuye y no hace falta más de un paso por página
          for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i].entries.length >= steps[i - 1].entries.length, `${label}: lo visible no disminuye`);
          assert.ok(steps.length <= Math.ceil(ds.txs.length / txPage) + Math.ceil(ds.gens.length / genPage), `${label}: cada «Ver más» carga una página nueva`);
        }
      }
    }
  }
});

test('milisegundos: una vez mostrada, ninguna fila desaparece al pedir más (ni pierde su generación asociada)', () => {
  for (const spacing of SPACINGS) {
    for (const skew of SKEWS) {
      const ds = denseDataset({ spacing, skew });
      for (const [txPage, genPage] of PAGES) {
        const steps = runDense({ ...ds, txPage, genPage, tie: 'asc' });
        const seen = new Map();
        for (const s of steps) {
          for (const e of s.entries) if (e.kind === 'tx') seen.set(e.key, e.generation?.id ?? null);
          const keys = new Set(s.entries.map((e) => e.key));
          for (const k of seen.keys()) assert.ok(keys.has(k), `${k} no desaparece (${spacing}/${skew}/${txPage}/${genPage})`);
          for (const e of s.entries) if (e.kind === 'tx' && seen.get(e.key)) assert.equal(e.generation?.id, seen.get(e.key));
        }
      }
    }
  }
});

test('primera vista: si ya hay movimientos cargados, nunca queda vacía (aunque el débito sea unos ms anterior a su generación)', () => {
  for (const spacing of SPACINGS) {
    for (const skew of SKEWS) {
      const ds = denseDataset({ spacing, skew });
      for (const [txPage, genPage] of PAGES) {
        const first = runDense({ ...ds, txPage, genPage, tie: 'asc' })[0];
        assert.ok(first.entries.length > 0, `espaciado ${spacing} ms, desfase ${skew} ms, páginas ${txPage}/${genPage}: la primera vista no está vacía`);
      }
    }
  }
});

test('createdAt idénticos en TODAS las filas: se muestra lo cargado, «Ver más» llega al final y el orden final no depende de cómo se pagine', () => {
  const same = { txs: [], gens: [] };
  for (let i = 0; i < 9; i += 1) {
    const id = String(i).padStart(3, '0');
    same.gens.push({ id: `g${id}`, createdAt: msAt(500), creditsCost: 5, status: 'FAILED' });
    same.txs.push({ id: `d${id}`, type: 'GENERATION_DEBIT', createdAt: msAt(500), referenceType: 'Generation', referenceId: `g${id}` });
  }
  const full = fullView(same).entries.map((e) => e.key);
  assert.equal(full.length, 9);
  const finals = new Set();
  for (const [txPage, genPage] of PAGES) {
    for (const tie of ['asc', 'desc']) {
      const steps = runDense({ ...same, txPage, genPage, tie });
      assert.ok(steps[0].entries.length > 0, 'no queda vacía');
      assert.equal(steps.at(-1).hasMore, false);
      finals.add(steps.at(-1).entries.map((e) => e.key).join(','));
    }
  }
  assert.deepEqual([...finals], [full.join(',')], 'el orden final es el mismo con cualquier paginación');
});
