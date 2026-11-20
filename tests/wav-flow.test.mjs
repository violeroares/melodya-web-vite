// Descarga WAV bajo demanda continua (lib/wav-flow): pedir → esperar → descargar la versión elegida, sin repetir la acción.
// Ejecutar: node --test "tests/*.test.mjs"  (sin dependencias nuevas; Node 24 carga .ts directamente). Todo con dobles: no hay red, ni SunoAPI, ni React.
import test from 'node:test';
import assert from 'node:assert/strict';

const F = await import('../src/lib/wav-flow.ts');
const { createWavFlow, wavStatusText, WAV_WAIT_LIMIT_MS, WAV_STALL_LIMIT_MS } = F;

const wav = (status, extra = {}) => ({ status, retryable: status === 'FAILED', ...extra });
const tick = () => new Promise((r) => setImmediate(r));

/** Doble del servidor + descarga + avisos; cada llamada queda registrada. */
function harness({ requestWav, download, now, visible } = {}) {
  const log = { requests: [], downloads: [], events: [], repaints: 0, timers: [] };
  let clock = 1_000_000;
  const flow = createWavFlow({
    // Vigilante de espera con un doble: nunca hay temporizadores reales; `fire()` ejecuta el vigente.
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; log.timers.push(t); return () => { t.cancelled = true; }; },
    visible,
    requestWav: async (songId, versionId) => { log.requests.push([songId, versionId]); return requestWav ? requestWav(songId, versionId) : wav('PENDING'); },
    download: async (input) => { log.downloads.push(input); return download ? download(input) : { filename: `${input.title}.wav`, replayed: false }; },
    onChange: () => { log.repaints += 1; },
    report: (e) => log.events.push(e),
    now: now ?? (() => clock),
  });
  const live = () => log.timers.filter((t) => !t.cancelled);
  return { flow, log, advance: (ms) => { clock += ms; }, live, fire: () => { const t = live().at(-1); assert.ok(t, 'no hay temporizador vigente'); t.cancelled = true; t.fn(); } };
}
const ask = (flow, over = {}) => flow.request({ songId: 's1', versionId: 'v1', versionNumber: 1, title: 'Mi canción', wav: wav('NONE'), ...over });
const types = (log) => log.events.map((e) => e.type);

test('versión SIN WAV: se pide una vez, el indicador queda activo durante toda la preparación y NO se descarga hasta que el servidor confirma', async () => {
  const { flow, log } = harness();
  const p = ask(flow);
  assert.equal(flow.get('v1').phase, 'requesting', 'el indicador arranca con el clic');
  await p;
  assert.equal(flow.get('v1').phase, 'preparing', 'sigue activo después de la solicitud inicial (antes se apagaba acá)');
  assert.deepEqual(log.requests, [['s1', 'v1']]);
  assert.deepEqual(types(log), ['preparing']);
  // Sondeos del servidor mientras convierte: sigue esperando, sin pedir ni descargar nada.
  for (const status of ['PENDING', 'PROCESSING', 'PROCESSING']) { flow.onVersions('s1', [{ id: 'v1', wav: wav(status) }]); await tick(); }
  assert.equal(flow.get('v1').phase, 'preparing');
  assert.equal(log.downloads.length, 0);
  assert.equal(log.requests.length, 1);
});

test('descarga automática al completarse: baja el WAV de ESA versión sin volver a abrir el menú; el indicador se mantiene hasta recibir el archivo', async () => {
  let release;
  const { flow, log } = harness({ download: () => new Promise((r) => { release = r; }) });
  await ask(flow);
  flow.onVersions('s1', [{ id: 'v1', wav: wav('COMPLETED') }]);
  await tick();
  assert.deepEqual(log.downloads, [{ songId: 's1', versionId: 'v1', title: 'Mi canción', format: 'wav' }]);
  assert.equal(flow.get('v1').phase, 'downloading', 'recibiendo el archivo: el indicador sigue');
  assert.equal(types(log).includes('started'), false, 'todavía no se afirma nada');
  release({ filename: 'Mi canción.wav', replayed: false });
  await tick(); await tick();
  assert.equal(flow.get('v1'), undefined, 'al terminar desaparece el indicador');
  assert.deepEqual(types(log), ['preparing', 'started'], 'se informa «inicio de descarga», no «guardado»');
  assert.equal(log.events.at(-1).filename, 'Mi canción.wav');
  assert.equal(log.requests.length, 1);
});

test('WAV ya disponible: descarga inmediata, SIN pedir ninguna conversión', async () => {
  const { flow, log } = harness();
  await ask(flow, { wav: wav('COMPLETED') });
  assert.equal(log.requests.length, 0, 'no se llama al pedido de conversión');
  assert.equal(log.downloads.length, 1);
  assert.deepEqual(types(log), ['started']);
  assert.equal(flow.get('v1'), undefined);
});

test('WAV pendiente o en procesamiento: se espera la existente (sin pedir otra) y se descarga solo al completarse', async () => {
  for (const status of ['PENDING', 'PROCESSING']) {
    const { flow, log } = harness();
    await ask(flow, { wav: wav(status) });
    assert.equal(log.requests.length, 0, `${status}: no se crea otra tarea`);
    assert.equal(flow.get('v1').phase, 'preparing');
    flow.onVersions('s1', [{ id: 'v1', wav: wav('COMPLETED') }]);
    await tick(); await tick();
    assert.deepEqual([log.requests.length, log.downloads.length], [0, 1], status);
  }
});

test('si el servidor responde «ya está listo» al pedirlo, se descarga enseguida', async () => {
  const { flow, log } = harness({ requestWav: () => wav('COMPLETED') });
  await ask(flow);
  assert.deepEqual([log.requests.length, log.downloads.length], [1, 1]);
});

test('doble clic y datos repetidos del servidor: un solo pedido y UNA sola descarga', async () => {
  let release;
  const { flow, log } = harness({ download: () => new Promise((r) => { release = r; }) });
  await Promise.all([ask(flow), ask(flow), ask(flow)]);
  assert.equal(log.requests.length, 1, 'tres clics, un pedido');
  await ask(flow); // un clic más con el intento ya en preparación
  assert.equal(log.requests.length, 1);
  for (let i = 0; i < 4; i += 1) flow.onVersions('s1', [{ id: 'v1', wav: wav('COMPLETED') }]); // el mismo dato llega varias veces
  await tick();
  assert.equal(log.downloads.length, 1, 'una sola descarga');
  await ask(flow, { wav: wav('COMPLETED') }); // clic durante la descarga
  assert.equal(log.downloads.length, 1);
  release({ filename: 'x.wav', replayed: false });
  await tick(); await tick();
  assert.equal(types(log).filter((t) => t === 'started').length, 1);
});

test('aislamiento entre versiones: cada intento descarga SU versión; terminar una no toca a la otra', async () => {
  const { flow, log } = harness();
  await ask(flow, { versionId: 'v1', versionNumber: 1, title: 'Uno' });
  await ask(flow, { versionId: 'v2', versionNumber: 2, title: 'Dos' });
  assert.deepEqual(log.requests, [['s1', 'v1'], ['s1', 'v2']]);
  flow.onVersions('s1', [{ id: 'v1', wav: wav('PROCESSING') }, { id: 'v2', wav: wav('COMPLETED') }]);
  await tick(); await tick();
  assert.deepEqual(log.downloads.map((d) => d.versionId), ['v2'], 'solo la que quedó lista');
  assert.equal(flow.get('v1').phase, 'preparing', 'la otra sigue esperando');
  assert.equal(flow.get('v2'), undefined);
  flow.onVersions('s1', [{ id: 'v1', wav: wav('COMPLETED') }, { id: 'v2', wav: wav('COMPLETED') }]);
  await tick(); await tick();
  assert.deepEqual(log.downloads.map((d) => d.versionId), ['v2', 'v1'], 'v2 no se vuelve a descargar');
});

test('una versión que NO se pidió nunca se descarga sola, aunque otras queden listas (p. ej. al cambiar la versión activa)', async () => {
  const { flow, log } = harness();
  await ask(flow, { versionId: 'v1' });
  flow.onVersions('s1', [{ id: 'v1', wav: wav('PROCESSING') }, { id: 'v3', wav: wav('COMPLETED') }]);
  await tick();
  assert.equal(log.downloads.length, 0);
  flow.onVersions('s1', [{ id: 'v1', wav: wav('COMPLETED') }, { id: 'v3', wav: wav('COMPLETED') }]);
  await tick(); await tick();
  assert.deepEqual(log.downloads.map((d) => d.versionId), ['v1']);
});

test('cambio de canción: un dato de OTRA canción descarta el intento sin descargar nada ni avisar', async () => {
  const { flow, log } = harness();
  await ask(flow);
  flow.onVersions('otra-cancion', [{ id: 'v1', wav: wav('COMPLETED') }]);
  await tick();
  assert.equal(flow.get('v1'), undefined);
  assert.equal(log.downloads.length, 0);
  assert.deepEqual(types(log), ['preparing']);
});

test('conversión fallida: se detiene el indicador, se informa y se indica si se puede reintentar (reglas del servidor); sin descarga', async () => {
  const a = harness();
  await ask(a.flow);
  a.flow.onVersions('s1', [{ id: 'v1', wav: wav('FAILED', { message: 'No pudimos preparar el WAV.' }) }]);
  assert.equal(a.flow.get('v1'), undefined);
  assert.deepEqual(a.log.events.at(-1), { type: 'failed', versionId: 'v1', versionNumber: 1, message: 'No pudimos preparar el WAV.', retryable: true });
  assert.equal(a.log.downloads.length, 0);

  const b = harness();
  await ask(b.flow);
  b.flow.onVersions('s1', [{ id: 'v1', wav: { status: 'FAILED', retryable: false, message: 'Contactá a soporte.' } }]);
  assert.equal(b.log.events.at(-1).retryable, false);

  const c = harness({ requestWav: () => wav('FAILED', { message: 'Muy grande.' }) }); // falla ya al pedirlo
  await ask(c.flow, { wav: wav('FAILED') });
  assert.equal(c.flow.get('v1'), undefined);
  assert.deepEqual(types(c.log), ['failed']);
});

test('errores del pedido o de la descarga (red, cupo, permisos): se detiene el indicador y se informa; un clic posterior vuelve a empezar', async () => {
  const boom = new Error('sin red');
  const a = harness({ requestWav: () => { throw boom; } });
  await ask(a.flow);
  assert.equal(a.flow.get('v1'), undefined);
  assert.deepEqual([a.log.events[0].type, a.log.events[0].error], ['error', boom]);

  const b = harness({ download: () => { throw Object.assign(new Error('cupo'), { status: 403 }); } });
  await ask(b.flow, { wav: wav('COMPLETED') });
  assert.equal(b.flow.get('v1'), undefined);
  assert.equal(b.log.events[0].type, 'error');
  await ask(b.flow, { wav: wav('COMPLETED') });
  assert.equal(b.log.downloads.length, 2, 'se puede reintentar');

  const c = harness({ requestWav: () => wav('NONE') }); // el servidor no registró la conversión
  await ask(c.flow);
  assert.equal(c.log.events[0].type, 'error');
  assert.equal(c.flow.get('v1'), undefined);
});

test('la conversión desaparece del servidor o la versión ya no existe: se detiene sin descargar', async () => {
  const a = harness();
  await ask(a.flow);
  a.flow.onVersions('s1', [{ id: 'v1', wav: wav('NONE') }]);
  assert.equal(a.flow.get('v1'), undefined);
  assert.equal(a.log.events.at(-1).type, 'error');
  const b = harness();
  await ask(b.flow);
  b.flow.onVersions('s1', [{ id: 'otra' }]);
  assert.equal(b.flow.get('v1'), undefined);
  assert.equal(b.log.downloads.length, 0);
});

test('espera máxima: pasado el tope (evaluada con cada dato nuevo) deja de acompañar y NO descarga más tarde por su cuenta', async () => {
  const { flow, log, advance } = harness();
  await ask(flow);
  advance(WAV_WAIT_LIMIT_MS - 1000);
  flow.onVersions('s1', [{ id: 'v1', wav: wav('PROCESSING') }]);
  assert.ok(flow.get('v1'), 'dentro del tope sigue esperando');
  advance(2000);
  flow.onVersions('s1', [{ id: 'v1', wav: wav('PROCESSING') }]);
  assert.equal(flow.get('v1'), undefined);
  assert.equal(log.events.at(-1).type, 'gave-up');
  flow.onVersions('s1', [{ id: 'v1', wav: wav('COMPLETED') }]); // listo mucho después: ya no hay intento
  await tick();
  assert.equal(log.downloads.length, 0, 'nunca se descarga algo que el usuario ya no está esperando');
});

test('limpieza (cambio de canción o cierre de la pantalla): dispose cancela todo; no hay descarga, aviso ni repintado posterior', async () => {
  let release;
  const { flow, log } = harness({ download: () => new Promise((r) => { release = r; }) });
  await ask(flow, { versionId: 'v1' });
  await ask(flow, { versionId: 'v2' });
  flow.onVersions('s1', [{ id: 'v1', wav: wav('COMPLETED') }, { id: 'v2', wav: wav('PROCESSING') }]);
  await tick();
  assert.equal(log.downloads.length, 1);
  const repaints = log.repaints;
  const events = log.events.length;
  flow.dispose();
  assert.equal(flow.active, false, 'sin intentos');
  release({ filename: 'x.wav', replayed: false });
  flow.onVersions('s1', [{ id: 'v2', wav: wav('COMPLETED') }]);
  await ask(flow, { versionId: 'v3', wav: wav('COMPLETED') });
  await tick(); await tick();
  assert.equal(log.downloads.length, 1, 'ninguna descarga nueva');
  assert.equal(log.requests.length, 2, 'ningún pedido nuevo');
  assert.equal(log.repaints, repaints, 'sin repintados');
  assert.equal(log.events.length, events, 'sin avisos');
});

test('dispose durante el pedido inicial: la respuesta tardía no inicia nada', async () => {
  let resolve;
  const { flow, log } = harness({ requestWav: () => new Promise((r) => { resolve = r; }) });
  const p = ask(flow);
  await tick();
  flow.dispose();
  resolve(wav('COMPLETED'));
  await p;
  assert.equal(log.downloads.length, 0);
  assert.equal(log.events.length, 0);
});

test('textos de estado: distinguen pedir, preparar y recibir el archivo; sin intento no hay texto', () => {
  assert.equal(wavStatusText('requesting'), 'Pidiendo el WAV…');
  assert.match(wavStatusText('preparing'), /Preparando tu WAV.*demorar unos minutos.*solo/);
  assert.equal(wavStatusText('downloading'), 'Iniciando la descarga del WAV…');
  assert.equal(wavStatusText(null), null);
  assert.equal(wavStatusText(undefined), null);
});

/* ───────── el indicador nunca queda activo indefinidamente: vigilante de espera ───────── */

test('el seguimiento se detiene (sin red, sondeo parado o con error): tras WAV_STALL_LIMIT_MS sin datos se corta el indicador, se avisa y NO se descarga después', async () => {
  const { flow, log, advance, live, fire } = harness();
  await ask(flow);
  assert.equal(live().length, 1, 'un solo vigilante mientras se espera');
  assert.ok(live()[0].ms >= 1000 && live()[0].ms <= WAV_STALL_LIMIT_MS, 'vence a lo sumo al límite de datos detenidos');
  advance(WAV_STALL_LIMIT_MS + 1000); // ningún dato nuevo del servidor
  fire();
  assert.equal(flow.get('v1'), undefined, 'el indicador se apaga');
  assert.deepEqual(types(log), ['preparing', 'stalled']);
  assert.equal(log.downloads.length, 0);
  assert.equal(live().length, 0, 'sin intentos, sin vigilante');
  // La red vuelve y la conversión ya terminó: no hay intento, así que no se descarga nada por sorpresa.
  flow.onVersions('s1', [{ id: 'v1', wav: wav('COMPLETED') }]);
  await tick();
  assert.equal(log.downloads.length, 0);
});

test('con el sondeo vivo (datos cada 8 s) el vigilante no corta la espera: cada dato renueva el plazo', async () => {
  const { flow, log, advance, fire } = harness();
  await ask(flow);
  for (let i = 0; i < 5; i += 1) {
    advance(WAV_STALL_LIMIT_MS - 5000); // casi vence…
    flow.onVersions('s1', [{ id: 'v1', wav: wav('PROCESSING') }]); // …pero llega un dato
    fire(); // el vigilante despierta
    assert.ok(flow.get('v1'), `ciclo ${i}: sigue esperando`);
  }
  assert.deepEqual(types(log), ['preparing']);
  flow.onVersions('s1', [{ id: 'v1', wav: wav('COMPLETED') }]);
  await tick(); await tick();
  assert.deepEqual(types(log), ['preparing', 'started'], 'y al completarse se descarga');
});

test('pestaña oculta: el sondeo del navegador se pausa y NO cuenta como falla; al volver hay un margen nuevo (touch)', async () => {
  let visible = false;
  const { flow, log, advance, fire } = harness({ visible: () => visible });
  await ask(flow);
  advance(5 * WAV_STALL_LIMIT_MS);
  fire();
  assert.ok(flow.get('v1'), 'oculta: no se corta (solo se renueva el margen)');
  visible = true;
  flow.touch(); // visibilitychange → visible
  advance(WAV_STALL_LIMIT_MS - 5000);
  fire();
  assert.ok(flow.get('v1'), 'recién vuelta: todavía dentro del margen');
  advance(10_000); // el sondeo siguió sin responder estando visible
  fire();
  assert.equal(flow.get('v1'), undefined);
  assert.equal(log.events.at(-1).type, 'stalled');
});

test('el vigilante también acota la espera total aunque lleguen datos (conversión que nunca termina)', async () => {
  const { flow, log, advance, fire } = harness();
  await ask(flow);
  let elapsed = 0;
  while (elapsed < WAV_WAIT_LIMIT_MS) { // el sondeo responde siempre «procesando»
    advance(8_000); elapsed += 8_000;
    flow.onVersions('s1', [{ id: 'v1', wav: wav('PROCESSING') }]);
  }
  advance(1000);
  fire();
  assert.equal(flow.get('v1'), undefined);
  assert.equal(log.events.at(-1).type, 'gave-up');
  assert.equal(log.downloads.length, 0);
});

test('vigilante: solo mientras hay un intento en preparación, uno solo a la vez, y dispose lo cancela', async () => {
  const { flow, log, live, fire, advance } = harness();
  assert.equal(live().length, 0, 'sin intentos no hay vigilante');
  await ask(flow, { versionId: 'v1' });
  await ask(flow, { versionId: 'v2', versionNumber: 2 });
  assert.equal(live().length, 1, 'dos intentos, un solo vigilante');
  flow.onVersions('s1', [{ id: 'v1', wav: wav('FAILED') }, { id: 'v2', wav: wav('PROCESSING') }]);
  assert.equal(live().length, 1, 'queda el de la que sigue esperando');
  flow.onVersions('s1', [{ id: 'v2', wav: wav('FAILED') }]);
  assert.equal(live().length, 0, 'sin intentos en preparación: se cancela');
  await ask(flow, { versionId: 'v3', versionNumber: 3 });
  assert.equal(live().length, 1);
  const armed = live()[0];
  flow.dispose();
  assert.equal(armed.cancelled, true, 'dispose cancela el vigilante');
  advance(10 * WAV_STALL_LIMIT_MS);
  armed.fn(); // aunque se dispare por error, no hace nada
  assert.deepEqual(log.events.filter((e) => e.type === 'stalled' || e.type === 'gave-up'), []);
});
