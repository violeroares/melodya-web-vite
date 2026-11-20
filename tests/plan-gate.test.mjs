// Funcionalidades fuera del plan (corona + plan mínimo + aviso de upgrade): lógica pura, estado del aviso y garantías estáticas de cada entrada comercial.
// No hay renderizado de componentes en este repositorio (no hay jsdom ni testing-library): el comportamiento de cada pantalla se asegura sobre el código fuente.
// Ejecutar: node --test "tests/*.test.mjs"  (Node 24 carga .ts directamente).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const G = await import('../src/lib/plan-gate.ts');
const C = await import('../src/lib/capabilities.ts');
const { useUpgradePrompt } = await import('../src/stores/upgrade-prompt.ts');
const { plansIncluding, requiredPlan, upgradeCopy } = G;
const { isLocked, isPlanExcluded, downloadState, limitExceeded, limitExceededMessage, capabilityDenial } = C;
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** Código sin comentarios (los comentarios mencionan lo que el archivo NO hace). */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* El catálogo de pruebas refleja lo que devuelve GET /plans (cada plan con sus capacidades). La interfaz no lo conoce de antemano. */
const ent = (...keys) => Object.fromEntries(keys.map((k) => [k, { enabled: true }]));
const FREE = { code: 'free', name: 'Free', isDefault: true, isActive: true, priceCents: 0, sortOrder: 0, entitlements: ent('COVER_ART') };
const CREATOR = {
  code: 'creator', name: 'Creator', isDefault: false, isActive: true, priceCents: 999, sortOrder: 1,
  entitlements: ent('COVER_ART', 'LYRICS_AI', 'LYRIC_PERSONAS', 'PRODUCTION_CONTROLS', 'DOWNLOAD_AUDIO', 'AUDIO_REFERENCE'),
};
const PRO = {
  code: 'pro', name: 'Pro', isDefault: false, isActive: true, priceCents: 1999, sortOrder: 2,
  entitlements: ent('COVER_ART', 'LYRICS_AI', 'LYRIC_PERSONAS', 'PRODUCTION_CONTROLS', 'DOWNLOAD_AUDIO', 'AUDIO_REFERENCE', 'CREATIVITY_SETTINGS', 'VOICE_CLONING', 'VOICE_COVER'),
};
const CATALOG = [PRO, FREE, CREATOR]; // desordenado a propósito

/* Capacidades efectivas que informa GET /users/me (con `enforced: true`, como con entitlements.mode = enforce). */
const effective = (plan) => Object.fromEntries(
  ['COVER_ART', 'LYRICS_AI', 'LYRIC_PERSONAS', 'PRODUCTION_CONTROLS', 'DOWNLOAD_AUDIO', 'AUDIO_REFERENCE', 'CREATIVITY_SETTINGS', 'VOICE_CLONING', 'VOICE_COVER']
    .map((k) => [k, { enabled: plan.entitlements[k]?.enabled === true, enforced: true }]),
);
const lockedKeys = (plan) => Object.keys(effective(plan)).filter((k) => isLocked(effective(plan), k)).sort();

test('el plan requerido sale del catálogo: el más barato que incluye la capacidad (Creator o Pro), sin importar el orden de la lista', () => {
  assert.equal(requiredPlan('LYRICS_AI', CATALOG).code, 'creator');
  assert.equal(requiredPlan('PRODUCTION_CONTROLS', CATALOG).code, 'creator');
  assert.equal(requiredPlan('VOICE_CLONING', CATALOG).code, 'pro');
  assert.equal(requiredPlan('AUDIO_REFERENCE', CATALOG).code, 'creator', 'la referencia de audio está en Creator y Pro: el mínimo es Creator');
  assert.deepEqual(plansIncluding('AUDIO_REFERENCE', CATALOG).map((p) => p.code), ['creator', 'pro']);
  assert.equal(requiredPlan('CREATIVITY_SETTINGS', CATALOG).code, 'pro');
  assert.deepEqual(plansIncluding('LYRICS_AI', CATALOG).map((p) => p.code), ['creator', 'pro']);
});

test('no hay asociaciones fijas: si el catálogo cambia, cambia el plan requerido (y los planes inactivos o el plan base no cuentan)', () => {
  const moved = [{ ...CREATOR, entitlements: ent('COVER_ART') }, PRO, FREE]; // el asistente solo en Pro
  assert.equal(requiredPlan('LYRICS_AI', moved).code, 'pro');
  const withInactive = [{ ...CREATOR, isActive: false }, PRO, FREE];
  assert.equal(requiredPlan('LYRICS_AI', withInactive).code, 'pro', 'un plan inactivo no se ofrece');
  assert.deepEqual(plansIncluding('COVER_ART', [FREE]), [], 'el plan base nunca es «el plan que hay que contratar»');
  assert.equal(requiredPlan('LYRICS_AI', []), null);
  assert.equal(requiredPlan('LYRICS_AI', undefined), null);
});

test('Free ve bloqueadas las capacidades de Creator y de Pro; Creator solo las exclusivas de Pro; Pro ninguna', () => {
  assert.deepEqual(lockedKeys(FREE), ['AUDIO_REFERENCE', 'CREATIVITY_SETTINGS', 'DOWNLOAD_AUDIO', 'LYRICS_AI', 'LYRIC_PERSONAS', 'PRODUCTION_CONTROLS', 'VOICE_CLONING', 'VOICE_COVER']);
  assert.deepEqual(lockedKeys(CREATOR), ['CREATIVITY_SETTINGS', 'VOICE_CLONING', 'VOICE_COVER'], 'Creator tiene la referencia de audio');
  assert.deepEqual(lockedKeys(PRO), [], 'Pro no ve bloqueos en lo que tiene habilitado');
  assert.equal(isLocked(effective(FREE), 'COVER_ART'), false, 'COVER_ART está habilitada en los tres planes');
});

test('la etiqueta de plan solo corresponde a lo bloqueado: con la capacidad habilitada o sin exigencia del servidor no hay bloqueo', () => {
  assert.equal(isLocked({ LYRICS_AI: { enabled: true, enforced: true } }, 'LYRICS_AI'), false);
  assert.equal(isLocked({ LYRICS_AI: { enabled: false, enforced: false } }, 'LYRICS_AI'), false, 'entitlements.mode off/shadow: no se bloquea');
  assert.equal(isLocked(null, 'LYRICS_AI'), false, 'sin datos decide el servidor');
});

test('el aviso: un plan que la incluye → «forma parte de Melodya X»; varios → «disponible en Creator y Pro»; sin catálogo → genérico, sin inventar plan', () => {
  const pro = upgradeCopy('VOICE_CLONING', CATALOG);
  assert.deepEqual([pro.planLabel, pro.title], ['Pro', 'Disponible en Melodya Pro']);
  assert.equal(pro.message, 'Clonar tu voz forma parte de Melodya Pro. Descubrí todo lo que podés crear con este plan.');

  const assistant = upgradeCopy('LYRICS_AI', CATALOG);
  assert.deepEqual([assistant.planLabel, assistant.planNames], ['Creator', ['Creator', 'Pro']]);
  assert.equal(assistant.message, 'El Asistente de Melodya está disponible en Creator y Pro. Elegí el plan que mejor se adapte a tu forma de crear.');

  const none = upgradeCopy('LYRICS_AI', []);
  assert.equal(none.planLabel, null);
  assert.doesNotMatch(none.message, /Creator|Pro\b/);
});

test('cupo agotado ≠ capacidad no incluida: las descargas distinguen el tratamiento y el mensaje de límite no es el de upgrade', () => {
  const dl = (over) => ({ period: { kind: 'subscription', resetsAt: '2026-12-01T00:00:00Z' }, downloads: { included: true, limit: 20, used: 5, remaining: 15, enforced: true, ...over } });
  // Free: la capacidad de descarga no está incluida → upgrade.
  const free = downloadState({ DOWNLOAD_AUDIO: { enabled: false, enforced: true } }, null);
  assert.deepEqual([free.allowed, free.lock], [false, 'capability']);
  // Creator con el cupo agotado: tiene la capacidad, no se le ofrece upgrade (es un límite del período).
  const full = downloadState({ DOWNLOAD_AUDIO: { enabled: true, enforced: true } }, dl({ used: 20, remaining: 0 }));
  assert.deepEqual([full.allowed, full.lock], [false, 'quota']);
  assert.match(full.reason, /Usaste las 20 descargas/);
  // Con cupo disponible no hay bloqueo.
  assert.equal(downloadState({ DOWNLOAD_AUDIO: { enabled: true, enforced: true } }, dl({})).lock, null);
  // Y el rechazo del servidor por límite tiene su propio mensaje, distinto del de «no incluido».
  const limit = limitExceeded({ status: 403, details: { code: 'LIMIT_EXCEEDED', capability: 'SONGS_PER_PERIOD', limit: 15, used: 15, resetsAt: '2026-12-01T00:00:00Z' } });
  assert.match(limitExceededMessage(limit), /Alcanzaste las 15 canciones de tu plan/);
  assert.ok(capabilityDenial({ status: 403, details: { code: 'CAPABILITY_NOT_IN_PLAN', capability: 'LYRICS_AI' } }));
  assert.equal(capabilityDenial({ status: 403, details: { code: 'LIMIT_EXCEEDED', capability: 'SONGS_PER_PERIOD', limit: 15, used: 15 } }), null);
});

test('pulsar algo bloqueado abre el aviso de esa capacidad y se puede cerrar; no hay ningún otro estado', () => {
  const st = useUpgradePrompt;
  assert.equal(st.getState().capability, null);
  st.getState().show('LYRICS_AI');
  assert.equal(st.getState().capability, 'LYRICS_AI');
  st.getState().show('VOICE_CLONING');
  assert.equal(st.getState().capability, 'VOICE_CLONING', 'el último pedido reemplaza al anterior (un solo diálogo)');
  st.getState().close();
  assert.equal(st.getState().capability, null);
});

test('el aviso es único, lleva a «Planes y fichas» (ruta existente) y no inicia ningún checkout', () => {
  assert.match(read('../src/components/layout/AppShell.tsx'), /<UpgradeDialog \/>/);
  const dlg = read('../src/components/common/PlanGate.tsx');
  assert.match(dlg, /navigate\('\/plans'\)/);
  assert.match(dlg, /Ver planes y fichas/);
  assert.doesNotMatch(code('../src/components/common/PlanGate.tsx'), /mockCheckout|billingApi\.|checkout/i);
  assert.match(read('../src/lib/router.tsx'), /'\/plans'/, 'la ruta /plans ya existe');
  // Ningún plan «Creator»/«Pro» escrito en los componentes del patrón: sale del catálogo.
  for (const f of ['../src/components/common/PlanGate.tsx', '../src/hooks/use-plan-gate.ts', '../src/lib/plan-gate.ts']) {
    assert.doesNotMatch(read(f), /'(Creator|Pro)'|"(Creator|Pro)"|`(Creator|Pro)`/, `${f}: sin planes fijos`);
  }
});

test('el plan que cuenta es el efectivo vigente: el patrón usa las capacidades de GET /users/me y no mira cambios programados', () => {
  const hook = read('../src/hooks/use-plan-gate.ts');
  assert.match(hook, /useEntitlements\(\)/);
  assert.match(hook, /isLocked\(entitlements, key\)/);
  assert.doesNotMatch(hook, /scheduledChange|pendingPlan|subscription\b/);
});

test('asistente de letras: ninguna entrada lo abre sin LYRICS_AI (creador en modo idea y en modo letra, biblioteca «Crear» y «Mejorar»)', () => {
  const wizard = read('../src/features/creator/CreatorWizard.tsx');
  assert.match(wizard, /const lyricsGate = usePlanGate\('LYRICS_AI'\)/);
  assert.match(wizard, /onOpenStudio=\{\(\) => \(lyricsGate\.locked \? lyricsGate\.prompt\(\) : setStudioOpen\(true\)\)\}/);
  const editors = read('../src/features/creator/PlanetEditors.tsx');
  assert.equal((editors.match(/<RequiredPlanBadge capability="LYRICS_AI"/g) ?? []).length, 3, 'los accesos del creador (Sugerime una idea, Crear o mejorar y Escribila ahora) llevan corona y plan');
  const lib = read('../src/features/library/LyricsTab.tsx');
  assert.match(lib, /const lyricsGate = usePlanGate\('LYRICS_AI'\)/);
  assert.match(lib, /const openStudio = [^\n]*\n\s+if \(lyricsGate\.locked\) \{\n\s+lyricsGate\.prompt\(\);\n\s+return;\n\s+\}/, 'openStudio no abre el estudio si está bloqueado');
  assert.equal((lib.match(/<RequiredPlanBadge capability="LYRICS_AI"/g) ?? []).length, 2, '«Crear» y «Mejorar» con corona');
  // Respaldo dentro del estudio: nunca llama al asistente sin la capacidad.
  assert.match(read('../src/features/creator/LyricsStudio.tsx'), /if \(lyricsAiLocked\) \{\n\s+showUpgrade\('LYRICS_AI'\)/);
});

test('planetas Producción, Creatividad y Referencia de audio: visibles, con corona y plan, y al pulsar muestran el aviso en lugar de agregarse', () => {
  const w = read('../src/features/creator/CreatorWizard.tsx');
  assert.match(w, /reference: 'AUDIO_REFERENCE'/);
  assert.match(w, /production: 'PRODUCTION_CONTROLS'/);
  assert.match(w, /creativity: 'CREATIVITY_SETTINGS'/);
  assert.match(w, /const planLocked = !present && cap !== undefined && isLocked\(entitlements, cap\)/);
  assert.match(w, /onClick=\{\(\) => \(planLocked && cap \? promptPlanetUpgrade\(cap\) : addFromCatalog\(def\.id\)\)\}/);
  assert.match(w, /const planExcluded = !present && cap !== undefined && isPlanExcluded\(entitlements, cap\)/, 'la corona del planeta sale de «no incluido», no del bloqueo');
  assert.match(w, /\{planExcluded && cap && <RequiredPlanBadge capability=\{cap\} \/>\}/);
  assert.match(w, /const disabled = !available && !planLocked;/, 'el planeta bloqueado por plan no está deshabilitado: se puede pulsar para ver el aviso');
});

test('clonación de voz, letristas, portadas, descargas y cola: cada entrada muestra el aviso cuando falta la capacidad', () => {
  assert.match(read('../src/features/creator/CreatorWizard.tsx'), /onRecordVoice=\{\(\) => \{ if \(cloneGate\.locked\) \{ cloneGate\.prompt\(\); return; \} setRecreateVoiceId\(null\); setVoiceCloneOpen\(true\); \}\}/);
  // Recrear una voz caducada es una clonación: pasa por la misma guardia.
  assert.match(read('../src/features/creator/CreatorWizard.tsx'), /const openRecreateVoice = \(sampleId: string\) => \{\n\s+if \(cloneGate\.locked\) \{ cloneGate\.prompt\(\); return; \}/);
  const voices = read('../src/features/library/VoicesTab.tsx');
  assert.match(voices, /const startClone = async \(sample: UserSample\) => \{\n\s+if \(cloneLocked\) \{\n\s+cloneGate\.prompt\(\);/);
  assert.match(voices, /<RequiredPlanBadge capability="VOICE_CLONING"/);
  const writers = read('../src/features/library/SongwritersTab.tsx');
  assert.match(writers, /personasLocked \? personasGate\.prompt\(\) : setCreating\(true\)/);
  assert.match(writers, /<RequiredPlanBadge capability="LYRIC_PERSONAS"/);
  const samples = read('../src/features/library/SamplesTab.tsx');
  assert.match(samples, /<RequiredPlanBadge capability=\{gateCapability\}/);
  const detail = read('../src/features/song/SongDetailView.tsx');
  assert.match(detail, /if \(downloadGate\.locked\) \{\n\s+downloadGate\.prompt\(\);\n\s+return;/);
  assert.match(detail, /if \(coverGate\.locked\) \{\n\s+coverGate\.prompt\(\);\n\s+return;/);
  const player = read('../src/components/player/ExpandedPlayer.tsx');
  assert.match(player, /if \(downloadGate\.locked && ownDownloadable\) \{\n\s+downloadGate\.prompt\(\);\n\s+return;/);
  assert.match(read('../src/components/player/PlayerBar.tsx'), /saveQueueLocked \? saveQueueGate\.prompt\(\) : setExportOpen\(true\)/);
});

test('las capacidades habilitadas siguen como antes: la rama sin bloqueo ejecuta la acción original y no se muestra etiqueta', () => {
  // Cada guardia termina en la acción original cuando NO está bloqueado.
  assert.match(read('../src/features/creator/CreatorWizard.tsx'), /: setStudioOpen\(true\)\)/);
  assert.match(read('../src/features/library/SongwritersTab.tsx'), /: setCreating\(true\)\)/);
  // RequiredPlanBadge no renderiza nada si el plan incluye la capacidad (la corona sale de `excluded`, no de `locked`).
  assert.match(read('../src/components/common/PlanGate.tsx'), /if \(!gate\.excluded\) return null;/);
  // Los cupos agotados de canciones conservan su tratamiento propio (medidor + LIMIT_EXCEEDED), no el aviso de upgrade.
  assert.match(read('../src/features/creator/CreatorWizard.tsx'), /songsMeterText\(usage\)/);
  assert.doesNotMatch(code('../src/components/common/PlanGate.tsx'), /LIMIT_EXCEEDED|limitExceeded/);
});

test('Biblioteca → Voces: TODAS las entradas de clonación (Crear voz, estado vacío, retomar una sesión y «Clonar mi voz») muestran el aviso y llevan corona', () => {
  const voices = read('../src/features/library/VoicesTab.tsx');
  // El encabezado y el estado vacío pasan por la misma guardia.
  assert.match(voices, /const openCreate = \(\) => \{\n\s+if \(cloneLocked\) \{\n\s+cloneGate\.prompt\(\);\n\s+return;\n\s+\}\n\s+setResumeSession\(null\);\n\s+setRecreateSampleId\(null\);\n\s+setCreateOpen\(true\);/);
  // Recrear una voz caducada también exige la capacidad.
  assert.match(voices, /const openRecreate = \(sample: UserSample\) => \{\n\s+if \(cloneLocked\) \{\n\s+cloneGate\.prompt\(\);\n\s+return;\n\s+\}/);
  assert.match(voices, /onClick=\{openCreate\}/);
  assert.match(voices, /onAction=\{openCreate\}/);
  // Retomar una sesión de clonación también exige la capacidad (el servidor la exige al verificar).
  assert.match(voices, /const openResume = \(session: VoiceSession\) => \{\n\s+if \(cloneLocked\) \{\n\s+cloneGate\.prompt\(\);/);
  // Ningún acceso abre el diálogo de clonación sin pasar por la guardia.
  const opens = voices.split('\n').filter((l) => l.includes('setCreateOpen(true)'));
  assert.equal(opens.length, 3, 'solo openCreate, openResume y openRecreate (todas con la guardia) abren el flujo');
  // Corona y plan en los tres botones visibles.
  assert.equal((voices.match(/<RequiredPlanBadge capability="VOICE_CLONING"/g) ?? []).length, 3);
});

/* ───────── Corona (plan no incluye) separada del bloqueo (el servidor la exige) ───────── */

const MODES = { off: false, shadow: false, enforce: true }; // `enforced` que informa GET /users/me según entitlements.mode
const asProfile = (plan, enforced) => Object.fromEntries(
  ['LYRICS_AI', 'LYRIC_PERSONAS', 'PRODUCTION_CONTROLS', 'DOWNLOAD_AUDIO', 'AUDIO_REFERENCE', 'CREATIVITY_SETTINGS', 'VOICE_CLONING', 'VOICE_COVER', 'COVER_ART']
    .map((k) => [k, { enabled: plan.entitlements[k]?.enabled === true, enforced }]),
);
const excludedKeys = (e) => Object.keys(e).filter((k) => isPlanExcluded(e, k)).sort();
const lockedOf = (e) => Object.keys(e).filter((k) => isLocked(e, k)).sort();

test('Free en shadow: corona en lo que no incluye y NINGÚN bloqueo (la acción sigue permitida)', () => {
  const e = asProfile(FREE, MODES.shadow);
  assert.deepEqual(excludedKeys(e), ['AUDIO_REFERENCE', 'CREATIVITY_SETTINGS', 'DOWNLOAD_AUDIO', 'LYRICS_AI', 'LYRIC_PERSONAS', 'PRODUCTION_CONTROLS', 'VOICE_CLONING', 'VOICE_COVER']);
  assert.equal(isPlanExcluded(e, 'LYRIC_PERSONAS'), true, 'letristas: corona');
  assert.deepEqual(lockedOf(e), [], 'shadow no bloquea nada');
  assert.equal(isPlanExcluded(e, 'COVER_ART'), false, 'Free incluye portadas: sin corona');
});

test('Free en off: la corona es la misma que en shadow y tampoco bloquea', () => {
  assert.deepEqual(excludedKeys(asProfile(FREE, MODES.off)), excludedKeys(asProfile(FREE, MODES.shadow)));
  assert.deepEqual(lockedOf(asProfile(FREE, MODES.off)), []);
});

test('Free en enforce: corona Y bloqueo en lo mismo (se ofrece el upgrade)', () => {
  const e = asProfile(FREE, MODES.enforce);
  assert.deepEqual(lockedOf(e), excludedKeys(e), 'todo lo que tiene corona está bloqueado');
  assert.equal(isLocked(e, 'LYRIC_PERSONAS'), true);
  assert.equal(upgradeCopy('LYRIC_PERSONAS', CATALOG).planLabel, 'Creator', 'el plan mínimo sale del catálogo');
});

test('Creator con capacidades de Pro: corona (en cualquier modo); lo que Creator incluye no la lleva', () => {
  for (const enforced of Object.values(MODES)) {
    const e = asProfile(CREATOR, enforced);
    assert.deepEqual(excludedKeys(e), ['CREATIVITY_SETTINGS', 'VOICE_CLONING', 'VOICE_COVER']);
    assert.equal(isPlanExcluded(e, 'AUDIO_REFERENCE'), false);
    assert.equal(isPlanExcluded(e, 'LYRIC_PERSONAS'), false);
  }
  assert.equal(upgradeCopy('VOICE_CLONING', CATALOG).planLabel, 'Pro');
});

test('Pro con todo incluido: sin coronas ni bloqueos, en cualquier modo', () => {
  for (const enforced of Object.values(MODES)) {
    const e = asProfile(PRO, enforced);
    assert.deepEqual(excludedKeys(e), []);
    assert.deepEqual(lockedOf(e), []);
  }
});

test('sesión sin cargar o sin datos de la capacidad: no se asume nada (ni corona ni bloqueo)', () => {
  assert.equal(isPlanExcluded(null, 'LYRIC_PERSONAS'), false);
  assert.equal(isPlanExcluded(undefined, 'LYRIC_PERSONAS'), false);
  assert.equal(isPlanExcluded({}, 'LYRIC_PERSONAS'), false, 'clave ausente');
  assert.equal(isPlanExcluded({ LYRIC_PERSONAS: undefined }, 'LYRIC_PERSONAS'), false);
  assert.equal(isPlanExcluded({ LYRIC_PERSONAS: { enabled: true } }, 'LYRIC_PERSONAS'), false);
  assert.equal(isLocked(null, 'LYRIC_PERSONAS'), false);
});

test('el bloqueo implica la corona, nunca al revés: locked ⊆ excluded para cualquier combinación', () => {
  for (const enabled of [true, false]) for (const enforced of [true, false, undefined]) {
    const e = { LYRICS_AI: { enabled, enforced } };
    if (isLocked(e, 'LYRICS_AI')) assert.equal(isPlanExcluded(e, 'LYRICS_AI'), true, JSON.stringify(e));
  }
});

test('estático: usePlanGate expone excluded y locked; la corona usa excluded y las acciones siguen usando locked', () => {
  const gate = code('../src/hooks/use-plan-gate.ts');
  assert.match(gate, /excluded: boolean;/);
  assert.match(gate, /locked: boolean;/);
  assert.match(gate, /const excluded = isPlanExcluded\(entitlements, key\);/);
  assert.match(gate, /const locked = isLocked\(entitlements, key\);/);
  assert.match(gate, /return \{ excluded, locked, copy, prompt \};/);
  assert.match(gate, /upgradeCopy\(key, plans\)\) : null\), \[excluded,|\(excluded \? upgradeCopy\(key, plans\) : null\)/, 'el plan mínimo se calcula con la capacidad fuera del plan');
  // Las acciones: el bloqueo (locked) sigue mandando; la corona (excluded) nunca decide si se ejecuta.
  const guarded = ['../src/features/library/SongwritersTab.tsx', '../src/features/library/VoicesTab.tsx', '../src/features/song/RemixMenu.tsx', '../src/features/library/LyricsTab.tsx'];
  for (const p of guarded) assert.doesNotMatch(code(p), /\.excluded \? [a-zA-Z.]*prompt\(\)|if \([a-zA-Z]+Gate\.excluded\)/, p + ': una acción no se bloquea por «excluded»');
  assert.match(read('../src/features/library/SongwritersTab.tsx'), /personasLocked \? personasGate\.prompt\(\) : setCreating\(true\)/);
  // La corona del botón vacío de Voces sale de «excluded» (no del bloqueo).
  assert.match(read('../src/features/library/VoicesTab.tsx'), /actionIcon=\{cloneGate\.excluded \? <RequiredPlanBadge capability="VOICE_CLONING" \/> : undefined\}/);
});
