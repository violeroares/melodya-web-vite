/**
 * MELODYA WEB — Decisiones puras del flujo «Crear voz» (sesiones de Suno Voice).
 *
 * Concentra lo que el diálogo y la Biblioteca de voces deben decidir a partir de la sesión que devuelve el backend, para
 * que no queden repartidas dentro de efectos de React y se puedan probar sin DOM:
 *
 *  • creationOutcome / phraseOutcome: una voz solo está lista con `READY` (y la frase solo existe con `PHRASE_READY` y texto
 *    válido). Agotar los intentos de un sondeo NUNCA equivale a éxito.
 *  • sessionErrorMessage: extrae de `session.error` (tipado `unknown`) un mensaje seguro para mostrar, o `null`.
 *  • resolveDurationSec: duración de una muestra a enviar a POST /samples (`durationSec`, número positivo ≤ 600).
 *  • pollSession: sondeo acotado que devuelve el ÚLTIMO estado visto (la decisión la toman las funciones de arriba).
 *
 * Sin React ni alias de módulos.
 */

export interface SessionLike {
  status: string;
  phrase?: string | null;
  error?: unknown;
  verifyTaskId?: string | null;
}

/** Estado de la fase «creando la voz». */
export type CreationOutcome = 'ready' | 'failed' | 'pending';

export function creationOutcome(session: SessionLike | null | undefined): CreationOutcome {
  if (session?.status === 'READY') return 'ready';
  if (session?.status === 'FAILED') return 'failed';
  return 'pending';
}

/**
 * Estado de la fase «frase de verificación».
 *  • ready: PHRASE_READY con una frase no vacía (único caso en que se muestra el panel de grabación).
 *  • pending: PHRASE_PENDING, la frase todavía se prepara.
 *  • failed: FAILED (fallo definitivo informado por el backend).
 *  • unavailable: cualquier otra combinación (p. ej. PHRASE_READY sin texto): no hay frase que grabar ni verificar.
 */
export type PhraseOutcome = 'ready' | 'pending' | 'failed' | 'unavailable';

export function validPhrase(phrase: unknown): phrase is string {
  return typeof phrase === 'string' && phrase.trim().length > 0;
}

export function phraseOutcome(session: SessionLike | null | undefined): PhraseOutcome {
  if (!session) return 'unavailable';
  if (session.status === 'FAILED') return 'failed';
  if (session.status === 'PHRASE_PENDING') return 'pending';
  if (session.status === 'PHRASE_READY' && validPhrase(session.phrase)) return 'ready';
  return 'unavailable';
}

/** ¿Falló la sesión antes de crear la voz (no hubo envío de la grabación)? */
export function failedBeforeVoice(session: SessionLike | null | undefined): boolean {
  return !session?.verifyTaskId;
}

const MAX_ERROR_MESSAGE = 200;
// Nada que parezca una URL (firmada), un token, una cabecera o una traza interna.
const UNSAFE_MESSAGE = [/https?:\/\//i, /\bst=/i, /bearer\s/i, /\beyJ[\w-]{8,}/, /[\w./\\-]+\.[cm]?[jt]sx?:\d+(?::\d+)?/, /\n\s+at\s/, /api[_-]?key/i, /\bsk-[\w-]{8,}/i];

/**
 * Mensaje de error seguro de `session.error` (el backend guarda `{ code, providerCode?, message }`). Devuelve `null` si
 * no hay un mensaje de texto utilizable o si parece contener algo que no debe mostrarse.
 */
export function sessionErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const raw = (error as { message?: unknown }).message;
  if (typeof raw !== 'string') return null;
  const message = raw.replace(/\s+/g, ' ').trim();
  if (!message || UNSAFE_MESSAGE.some((re) => re.test(raw))) return null;
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE - 1)}…` : message;
}

/** POST /samples admite `durationSec` > 0 y ≤ 600. Cualquier otro valor se omite (no se inventa ni se recorta). */
export const MAX_SAMPLE_DURATION_SEC = 600;

export function sanitizeDurationSec(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_SAMPLE_DURATION_SEC) return undefined;
  return Math.round(value * 10) / 10;
}

/** Duración medida del archivo; si no se pudo medir, la que informó la grabadora (si la hay); si no, ninguna. */
export function resolveDurationSec(measured: unknown, recorded?: unknown): number | undefined {
  return sanitizeDurationSec(measured) ?? sanitizeDurationSec(recorded);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Consulta `fetchOnce` hasta que `isDone` se cumpla o se agoten `attempts` esperas. Devuelve el último valor visto
 * (cumpla o no): quien llama decide qué significa. `isCancelled` corta el sondeo sin más consultas.
 */
export async function pollSession<T>(
  fetchOnce: () => Promise<T>,
  isDone: (value: T) => boolean,
  attempts: number,
  intervalMs: number,
  options: { sleep?: (ms: number) => Promise<void>; isCancelled?: () => boolean } = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  let last = await fetchOnce();
  for (let i = 0; i < attempts && !isDone(last); i++) {
    if (options.isCancelled?.()) return last;
    await sleep(intervalMs);
    if (options.isCancelled?.()) return last;
    last = await fetchOnce();
  }
  return last;
}

/** Resultado de esperar la frase de verificación. `session` es siempre el último estado visto. */
export type PhraseStep = { kind: 'ready' | 'failed' | 'timeout'; session: SessionLike };

/** Sondea hasta que la frase esté lista o la sesión falle; agotar los intentos es `timeout` (no un fallo ni un éxito). */
export async function awaitPhrase<T extends SessionLike>(
  fetchOnce: () => Promise<T>,
  attempts: number,
  intervalMs: number,
  options: { sleep?: (ms: number) => Promise<void>; isCancelled?: () => boolean } = {},
): Promise<{ kind: PhraseStep['kind']; session: T }> {
  const session = await pollSession(fetchOnce, (s) => phraseOutcome(s) !== 'pending', attempts, intervalMs, options);
  const outcome = phraseOutcome(session);
  return { kind: outcome === 'pending' ? 'timeout' : outcome === 'ready' ? 'ready' : 'failed', session };
}

export interface PhraseReadingDeps {
  readDuration: (file: File) => Promise<unknown>;
  createSample: (file: File, meta: { type: 'VOICE'; name: string; durationSec?: number; purpose: 'VOICE_VERIFICATION' }) => Promise<{ id: string }>;
}

/**
 * Sube la lectura de la frase como sample VOICE. Solo procede con la sesión que el diálogo tiene en estado (debe tener una
 * frase válida): si no, devuelve `blocked` para que quien llama lo muestre, nunca un retorno silencioso.
 */
export async function uploadPhraseReading(
  session: SessionLike | null | undefined,
  file: File,
  recordedSec: number | undefined,
  name: string,
  deps: PhraseReadingDeps,
): Promise<{ status: 'blocked' } | { status: 'uploaded'; sampleId: string }> {
  if (phraseOutcome(session) !== 'ready') return { status: 'blocked' };
  const durationSec = resolveDurationSec(await deps.readDuration(file), recordedSec);
  // `purpose` marca la grabación como audio auxiliar de la verificación: el backend no la lista como muestra de la biblioteca.
  const reading = await deps.createSample(file, { type: 'VOICE', name, purpose: 'VOICE_VERIFICATION', ...(durationSec ? { durationSec } : {}) });
  return { status: 'uploaded', sampleId: reading.id };
}

/** Estados de una sesión que todavía puede avanzar (no terminales). */
const ACTIVE_STATUSES = ['PHRASE_PENDING', 'PHRASE_READY', 'VERIFYING', 'VOICE_PENDING'];

/** Sesión en curso (reanudable) de una muestra: si existe, retomarla en vez de pedir otra a Suno (POST /voice-sessions no es idempotente). */
export function findActiveSession<T extends SessionLike & { id?: string; voiceSampleId?: string | null }>(
  sessions: readonly T[],
  sampleId: string,
  /** Sesión a ignorar (la propia tarjeta): su estado en la lista puede estar desactualizado y se vería a sí misma como «otra». */
  excludeId?: string,
): T | undefined {
  return sessions.find((s) => s.id !== excludeId && s.voiceSampleId === sampleId && ACTIVE_STATUSES.includes(s.status));
}

/**
 * Aviso al cerrar el diálogo cuando ya hay una sesión creada en el backend (cerrar NO la borra). `null` si no hay nada que
 * avisar. Las fases con una petición en curso no llegan acá: el diálogo no se cierra mientras `busy`.
 */
export function closeNotice(phase: string, hasSession: boolean): string | null {
  if (!hasSession) return null;
  if (phase === 'phrase' || phase === 'details') return 'Tu clonación quedó en curso: retomala desde Biblioteca › Voces, en «Clonación de voz».';
  if (phase === 'creating' || phase === 'stillCreating') return 'Tu voz sigue creándose: seguila desde Biblioteca › Voces.';
  return null;
}

/** ¿Hay una toma válida (terminada, con archivo y de la duración mínima) todavía sin enviar? Es lo único que se pierde al cerrar. */
export function isRecordingPending(state: string, hasFile: boolean, elapsedSec: number, minSec: number): boolean {
  return state === 'ready' && hasFile && elapsedSec >= minSec;
}

/** La página de sesiones sin la eliminada (para que la tarjeta desaparezca al instante, antes del refetch). Sin página, la devuelve igual. */
export function withoutSession<T extends { items: Array<{ id: string }> }>(page: T | undefined, id: string): T | undefined {
  return page ? { ...page, items: page.items.filter((s) => s.id !== id) } : page;
}

/** Fase del asistente en la que se retoma una sesión en curso (null = no se puede retomar: terminada o desconocida). */
export type ResumePhase = 'phrase' | 'creating';

export function resumePhase(status: string | null | undefined): ResumePhase | null {
  switch (status) {
    case 'PHRASE_PENDING':
    case 'PHRASE_READY':
      return 'phrase';
    case 'VERIFYING':
    case 'VOICE_PENDING':
      return 'creating';
    default:
      return null;
  }
}

/**
 * Textos de la frase de verificación, UNA sola fuente para todas las pantallas. Suno recomienda cantarla («singing is
 * recommended», docs.sunoapi.org › Suno Voice › Create Custom Voice); la frase en sí es la que devuelve el proveedor y no se altera.
 */
export const PHRASE_INSTRUCTION = 'Cantá esta frase con tu voz, tal cual está escrita:';
export const PHRASE_HINT = 'Cantala completa, de una sola vez.';
export const PHRASE_RETRY_TIP = 'Probá cantando la frase en un lugar tranquilo, tal cual está escrita y con el micrófono cerca.';

/**
 * Qué hacer al pedir «clonar» una muestra: si ya hay una sesión en curso para ella se RETOMA (POST /voice-sessions no es
 * idempotente: cada llamada crea otra sesión y pide otra frase a Suno); solo sin sesión en curso se crea una nueva.
 */
export function nextCloneAction<T extends SessionLike & { id?: string; voiceSampleId?: string | null }>(
  sessions: readonly T[],
  sampleId: string,
): { action: 'resume'; session: T } | { action: 'create' } {
  const active = findActiveSession(sessions, sampleId);
  return active ? { action: 'resume', session: active } : { action: 'create' };
}

/** Nivel de experiencia vocal elegido en el asistente. `''` = «Omitir»: no se envía nivel alguno. */
export type SkillChoice = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'PROFESSIONAL' | '';

/**
 * Opciones del paso «Detalles». Los cuatro valores son el enum de Melodya (el backend los pasa a minúsculas para Suno:
 * beginner | intermediate | advanced | professional); «Omitir» queda con valor vacío y nunca se reemplaza por un nivel.
 */
export const SKILL_CHOICES: ReadonlyArray<{ value: SkillChoice; title: string; hint: string }> = [
  { value: 'BEGINNER', title: 'Principiante', hint: 'Todavía estoy encontrando mi voz' },
  { value: 'INTERMEDIATE', title: 'Intermedio', hint: 'Puedo cantar afinado' },
  { value: 'ADVANCED', title: 'Avanzado', hint: 'La gente lo nota' },
  { value: 'PROFESSIONAL', title: 'Profesional', hint: 'Me dedico a esto' },
  { value: '', title: 'Omitir', hint: 'No indicar nivel de experiencia' },
];

/** Aviso prudente de «Omitir»: lo único que se afirma es lo que Melodya hace; lo que Suno haga con el campo ausente no está documentado. */
export const SKILL_SKIP_NOTE = 'Si omitís esta pregunta, no enviaremos un nivel de experiencia. Melodya puede aplicar su valor predeterminado.';

/**
 * Cuerpo de `POST /voice-sessions/:id/verify`. `singerSkillLevel` solo está presente si el usuario eligió un nivel:
 * con «Omitir» (`''`) la propiedad no existe (no se sustituye por `BEGINNER` ni por ningún otro valor).
 */
export function buildVerifyBody(input: {
  sampleId: string;
  name: string;
  description: string;
  tagsInput: string;
  skill: SkillChoice;
}): {
  sampleId: string;
  name?: string;
  description?: string;
  style?: string;
  singerSkillLevel?: Exclude<SkillChoice, ''>;
} {
  const tags = input.tagsInput.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8);
  const name = input.name.trim();
  const description = input.description.trim();
  return {
    sampleId: input.sampleId,
    ...(name ? { name: name.slice(0, 100) } : {}),
    ...(description ? { description: description.slice(0, 500) } : {}),
    ...(tags.length ? { style: tags.join(', ') } : {}),
    ...(input.skill ? { singerSkillLevel: input.skill } : {}),
  };
}

/**
 * ¿La sesión requiere una acción del usuario? Se muestran en «Biblioteca › Voces» solo las que se pueden retomar (en curso) o
 * reintentar/descartar (FAILED). Una sesión READY ya terminó: su resultado es la voz de «Mis voces» y no se vuelve a mostrar.
 */
export function sessionNeedsAction(status: string | null | undefined): boolean {
  return resumePhase(status) !== null || status === 'FAILED';
}
