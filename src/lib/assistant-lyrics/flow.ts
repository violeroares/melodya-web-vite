/**
 * MELODYA WEB — Lógica PURA del flujo de letras del asistente (POST /assistant/lyrics).
 *
 * Contrato del backend (E9, melodya.backend f7082ca):
 *  • 200 → letra lista. 202 → operación SIN resultado todavía (en curso o incierta): NO trae title ni lyrics.
 *  • Idempotency-Key (8–128 caracteres) por usuario: repetir la MISMA clave devuelve la MISMA operación
 *    (200 / 202 / 409); la misma clave con otros parámetros → 422 IDEMPOTENCY_KEY_REUSED.
 *  • Un error HTTP, un timeout o un corte de red NO prueban que la operación terminó: se recupera repitiendo con
 *    exactamente la misma clave, o con GET /generations/{operation.id} cuando el id ya se conoce.
 *
 * Este archivo no importa nada (ni React, ni axios, ni alias '@/'): se prueba con `node --test`.
 */

export const PENDING_STORAGE_KEY = 'melodya.assistant-lyrics.pending';

/** Consultas automáticas máximas por operación pendiente (después queda la consulta manual). */
export const POLL_MAX_ATTEMPTS = 40;

/* -------------------------------------------------------------------------- */
/* Huella del payload y clave de idempotencia                                   */
/* -------------------------------------------------------------------------- */

/** JSON con claves ordenadas y sin `undefined`: mismo contenido ⇒ mismo texto. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** Hash no criptográfico de 53 bits (cyrb53). Solo sirve para comparar igualdad; no es reversible en la práctica. */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Huella del payload (no incluye el texto): se guarda en lugar de la idea o la letra. */
export function fingerprintPayload(payload: unknown): string {
  const text = stableStringify(payload);
  return `fp1:${cyrb53(text).toString(16)}:${text.length.toString(16)}`;
}

/** Clave nueva: `mly-<uuid>` (40 caracteres; el contrato exige 8–128). */
export function newIdempotencyKey(randomUUID: () => string): string {
  return `mly-${randomUUID()}`;
}

/* -------------------------------------------------------------------------- */
/* Persistencia mínima (sessionStorage)                                         */
/* -------------------------------------------------------------------------- */

export interface StoredAttempt {
  v: 1;
  userId: string;
  key: string;
  fingerprint: string;
  operationId?: string;
  /**
   * El backend informó que no pudo confirmar el cierre de esta operación (NO_LYRICS_PROVIDER posterior a crearla): puede
   * seguir PROCESSING con su débito. Se persiste (solo cuando es true) para que sobreviva a las consultas y a una recarga;
   * desaparece junto con la solicitud (forget) cuando se confirma un estado final.
   */
  closeUncertain?: boolean;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Interpreta un registro persistido. Los campos ESENCIALES (v, userId, key, fingerprint y, si está, operationId) se validan
 * cada uno por separado: si alguno es inválido el registro no se puede reanudar con seguridad y se descarta entero (no se
 * inventa ni se repara ninguna clave, huella u operationId). `closeUncertain` es solo una señal informativa: vale únicamente
 * si es exactamente `true`; ausente o con cualquier otro valor se ignora SIN descartar el resto del registro.
 */
function parseStoredAttempt(x: unknown): StoredAttempt | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const validVersion = o.v === 1;
  const validUser = typeof o.userId === 'string' && o.userId.length > 0;
  const validKey = typeof o.key === 'string' && o.key.length >= 8 && o.key.length <= 128;
  const validFingerprint = typeof o.fingerprint === 'string' && o.fingerprint.length > 0;
  const validOperation = o.operationId === undefined || (typeof o.operationId === 'string' && o.operationId.length > 0);
  if (!(validVersion && validUser && validKey && validFingerprint && validOperation)) return null;
  return {
    v: 1,
    userId: o.userId as string,
    key: o.key as string,
    fingerprint: o.fingerprint as string,
    ...(typeof o.operationId === 'string' ? { operationId: o.operationId } : {}),
    ...(o.closeUncertain === true ? { closeUncertain: true } : {}),
  };
}

/** Lee el intento guardado SOLO si es válido y pertenece a `userId`; un registro ajeno o corrupto se elimina. */
export function loadAttempt(storage: KeyValueStorage | null, userId: string | null): StoredAttempt | null {
  if (!storage || !userId) return null;
  try {
    const raw = storage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const attempt = parseStoredAttempt(parsed);
    if (attempt && attempt.userId === userId) return attempt;
    storage.removeItem(PENDING_STORAGE_KEY);
  } catch {
    try { storage.removeItem(PENDING_STORAGE_KEY); } catch { /* storage no disponible */ }
  }
  return null;
}

/** Guarda SOLO { v, userId, key, fingerprint, operationId?, closeUncertain? }. Nunca letras, prompts ni tokens. */
export function saveAttempt(storage: KeyValueStorage | null, attempt: StoredAttempt): void {
  if (!storage) return;
  const minimal: StoredAttempt = {
    v: 1,
    userId: attempt.userId,
    key: attempt.key,
    fingerprint: attempt.fingerprint,
    ...(attempt.operationId ? { operationId: attempt.operationId } : {}),
    ...(attempt.closeUncertain === true ? { closeUncertain: true } : {}),
  };
  try { storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(minimal)); } catch { /* storage lleno/bloqueado */ }
}

export function clearAttempt(storage: KeyValueStorage | null): void {
  if (!storage) return;
  try { storage.removeItem(PENDING_STORAGE_KEY); } catch { /* storage no disponible */ }
}

/**
 * Decide la clave de una acción:
 *  • misma persona + misma huella del payload ⇒ se REUTILIZA exactamente la misma clave (y su operationId);
 *  • payload distinto, otro usuario o sin intento previo ⇒ acción nueva: clave nueva.
 * Nunca se reutiliza una clave con parámetros diferentes (el backend respondería 422 IDEMPOTENCY_KEY_REUSED).
 */
export function resolveAttempt(args: {
  stored: StoredAttempt | null;
  userId: string;
  fingerprint: string;
  makeKey: () => string;
}): { attempt: StoredAttempt; reused: boolean } {
  const { stored, userId, fingerprint, makeKey } = args;
  if (stored && stored.userId === userId && stored.fingerprint === fingerprint) {
    return { attempt: stored, reused: true };
  }
  return { attempt: { v: 1, userId, key: makeKey(), fingerprint }, reused: false };
}

/* -------------------------------------------------------------------------- */
/* Respuestas del POST                                                          */
/* -------------------------------------------------------------------------- */

export type ClassifiedResponse =
  | { kind: 'completed'; title: string; lyrics: string; tags: string[]; operationId?: string }
  | { kind: 'pending'; operationId: string; uncertain: boolean; replayed: boolean; message?: string }
  | { kind: 'invalid'; reason: string; operationId?: string };

function asRecord(x: unknown): Record<string, unknown> | null {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function operationOf(data: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(data?.operation);
}

/**
 * 200 solo es éxito si trae una letra no vacía; 202 es SIEMPRE pendiente (aunque trajera texto, el contrato dice
 * que no hay letra todavía); cualquier otra cosa es inválida (el llamador la trata como resultado desconocido).
 */
export function classifyAssistantResponse(status: number, body: unknown): ClassifiedResponse {
  const data = asRecord(body);
  const op = operationOf(data);
  const opId = typeof op?.id === 'string' && op.id ? op.id : undefined;

  if (status === 202) {
    if (!opId) return { kind: 'invalid', reason: 'El 202 no trajo operation.id' };
    return {
      kind: 'pending',
      operationId: opId,
      uncertain: op?.uncertain === true,
      replayed: op?.replayed === true,
      ...(typeof op?.message === 'string' ? { message: op.message } : {}),
    };
  }

  if (status === 200) {
    const lyrics = typeof data?.lyrics === 'string' ? data.lyrics : '';
    if (!lyrics.trim()) return { kind: 'invalid', reason: 'La respuesta no trajo una letra válida', ...(opId ? { operationId: opId } : {}) };
    const title = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : 'Sin título';
    const tags = Array.isArray(data?.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : [];
    return { kind: 'completed', title, lyrics, tags, ...(opId ? { operationId: opId } : {}) };
  }

  return { kind: 'invalid', reason: `Estado HTTP inesperado (${status})` };
}

/* -------------------------------------------------------------------------- */
/* Errores del POST                                                             */
/* -------------------------------------------------------------------------- */

export interface ErrorLike {
  status?: number;
  code?: string;
  details?: unknown;
  message?: string;
}

export type ClassifiedError =
  /** ESTA respuesta prueba que no se creó una operación. La clave puede venir de un intento anterior: lo decide el controlador. */
  | { kind: 'not-started'; reason: 'insufficient-credits' | 'rate-limited' | 'validation' | 'key-conflict' | 'pricing-not-configured' | 'no-lyrics-provider' }
  /** La operación de esa clave ya terminó sin letra (o se descartó): terminal. */
  | { kind: 'failed'; reason: 'operation-failed' | 'not-active'; operationId?: string }
  /**
   * El backend rechazó DESPUÉS de crear la operación (p. ej. NO_LYRICS_PROVIDER durante la ejecución) y la identificó con
   * `details.operationId`: la operación existe y pudo haber un débito. Se recupera por GET /generations/{id}; no se reenvía el POST.
   * `closeUncertain`: el backend no pudo confirmar el cierre de la operación.
   */
  | { kind: 'operation-exists'; reason: 'no-lyrics-provider'; operationId: string; closeUncertain: boolean }
  /** Cualquier otra cosa (5xx, 4xx reenviados, timeout, corte de red): NO prueba que la operación terminó. */
  | { kind: 'unknown' };

function detailsCode(details: unknown): string | undefined {
  const d = asRecord(details);
  return typeof d?.code === 'string' ? d.code : undefined;
}

function detailsOperationId(details: unknown): string | undefined {
  const d = asRecord(details);
  return typeof d?.operationId === 'string' ? d.operationId : undefined;
}

/** Máximo contractual de `existingLyrics` (modo Mejorar) en POST /assistant/lyrics; el backend lo mide sobre el texto sin espacios en los extremos. */
export const ASSISTANT_EXISTING_LYRICS_MAX = 5000;

/** true si la letra a mejorar supera el máximo y NO debe enviarse (nunca se recorta: la decide la persona). */
export function improveLyricsTooLong(lyrics: string): boolean {
  return lyrics.trim().length > ASSISTANT_EXISTING_LYRICS_MAX;
}

/** Motivos de un VALIDATION_ERROR (`details.issues[].message`), sin repetidos; undefined si no hay ninguno utilizable. */
export function validationIssuesMessage(details: unknown): string | undefined {
  const issues = asRecord(details)?.issues;
  if (!Array.isArray(issues)) return undefined;
  const messages = [...new Set(issues.map((i) => asRecord(i)?.message).filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim()))];
  return messages.length ? messages.join(' ') : undefined;
}

/**
 * Interpreta un error por el CÓDIGO y los DETALLES reales del backend, no por el status HTTP aislado: el
 * manejador global puede reenviar el estado HTTP de la excepción del proveedor (incluso un 4xx).
 */
export function classifyAssistantError(err: ErrorLike): ClassifiedError {
  const status = err.status ?? 0;
  const sub = detailsCode(err.details);

  if (status === 409 && sub === 'ASSISTANT_OPERATION_FAILED') return { kind: 'failed', reason: 'operation-failed', operationId: detailsOperationId(err.details) };
  if (status === 409 && sub === 'ASSISTANT_OPERATION_NOT_ACTIVE') return { kind: 'failed', reason: 'not-active', operationId: detailsOperationId(err.details) };
  // LYRICS_EMPTY: el backend cierra la operación como FAILED, pero si ese cierre falla lo registra y IGUAL responde
  // 422 (assistant.service.js closeAsFailed). El 422 solo no prueba el estado final: se conserva la clave, y repetir con
  // la misma devuelve 409 ASSISTANT_OPERATION_FAILED (terminal confirmado) o 202 si siguiera en curso.
  if (status === 422 && sub === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'not-started', reason: 'key-conflict' };
  if (status === 422 && sub === 'INVALID_IDEMPOTENCY_KEY') return { kind: 'not-started', reason: 'validation' };
  // El middleware de validación del backend responde code UNPROCESSABLE con details.code VALIDATION_ERROR; el ZodError directo, code VALIDATION_ERROR.
  if (status === 422 && (err.code === 'VALIDATION_ERROR' || sub === 'VALIDATION_ERROR')) return { kind: 'not-started', reason: 'validation' };
  if (status === 402 && err.code === 'INSUFFICIENT_CREDITS') return { kind: 'not-started', reason: 'insufficient-credits' };
  // El backend resuelve proveedor/modelo y precio ANTES de crear la operación (y después de comprobar si la clave ya existe):
  // estos dos 422 prueban que esa clave no tiene ninguna operación. Solo estos códigos, no cualquier 422.
  if (status === 422 && sub === 'PRICING_NOT_CONFIGURED') return { kind: 'not-started', reason: 'pricing-not-configured' };
  if (status === 422 && sub === 'NO_LYRICS_PROVIDER') {
    // Con operationId el error es POSTERIOR a crear la operación (puede haber débito y reintegro pendiente); sin él, anterior.
    const operationId = detailsOperationId(err.details);
    if (operationId) return { kind: 'operation-exists', reason: 'no-lyrics-provider', operationId, closeUncertain: asRecord(err.details)?.closeUncertain === true };
    return { kind: 'not-started', reason: 'no-lyrics-provider' };
  }
  if (status === 429 && err.code === 'RATE_LIMITED') return { kind: 'not-started', reason: 'rate-limited' };
  return { kind: 'unknown' };
}

/** Mensaje de un rechazo: en validación, los motivos del backend; si no hay, el mensaje del error. */
function rejectedMessage(reason: string, e: ErrorLike & { message?: string }): string | undefined {
  return (reason === 'validation' ? validationIssuesMessage(e?.details) : undefined) ?? e?.message;
}

/* -------------------------------------------------------------------------- */
/* Recuperación por operation.id (GET /generations/{id})                        */
/* -------------------------------------------------------------------------- */

export interface OperationSnapshot {
  status?: string;
  jobs?: Array<{
    task?: string;
    status?: string;
    result?: unknown;
    uncertainSince?: string | null;
  }> | null;
}

export type InterpretedOperation =
  | { kind: 'completed'; title: string; lyrics: string; tags: string[] }
  | { kind: 'pending'; uncertain: boolean }
  | { kind: 'failed'; reason: 'failed' | 'canceled' }
  /** COMPLETED sin una letra utilizable, o un estado desconocido: no se muestra como éxito. */
  | { kind: 'invalid'; reason: string };

/**
 * `PROCESSING` NO implica que la operación esté marcada como incierta: `uncertainSince` solo aparece cuando el
 * backend marca esa condición. Mientras no haya un estado final, sigue siendo pendiente.
 */
export function interpretOperationSnapshot(snapshot: OperationSnapshot | null | undefined): InterpretedOperation {
  const status = snapshot?.status;
  const lyricsJob = snapshot?.jobs?.find((j) => j?.task === 'LYRICS') ?? snapshot?.jobs?.[0];

  if (status === 'COMPLETED') {
    const result = asRecord(lyricsJob?.result);
    const lyrics = typeof result?.lyrics === 'string' ? result.lyrics : '';
    if (!lyrics.trim()) return { kind: 'invalid', reason: 'La operación figura completada pero no trae una letra' };
    const title = typeof result?.title === 'string' && result.title.trim() ? result.title.trim() : 'Sin título';
    const tags = Array.isArray(result?.tags) ? result.tags.filter((t): t is string => typeof t === 'string') : [];
    return { kind: 'completed', title, lyrics, tags };
  }
  if (status === 'FAILED') return { kind: 'failed', reason: 'failed' };
  if (status === 'CANCELED') return { kind: 'failed', reason: 'canceled' };
  if (status === 'PENDING' || status === 'PROCESSING') {
    return { kind: 'pending', uncertain: Boolean(lyricsJob?.uncertainSince) };
  }
  return { kind: 'invalid', reason: `Estado desconocido (${String(status)})` };
}

/** Espera creciente entre consultas: 2 s, 3 s, 5 s, 8 s, 12 s y luego 15 s. */
export function pollDelayMs(attempt: number): number {
  const steps = [2000, 3000, 5000, 8000, 12000];
  return attempt < steps.length ? steps[Math.max(0, attempt)] : 15000;
}

export function shouldContinuePolling(attempt: number): boolean {
  return attempt < POLL_MAX_ATTEMPTS;
}

/* -------------------------------------------------------------------------- */
/* Protección contra doble clic / envíos concurrentes                           */
/* -------------------------------------------------------------------------- */

/**
 * Candado SÍNCRONO (no depende de un re-render de React): mientras haya un envío en curso, `tryAcquire()` devuelve
 * false. Dos clics seguidos antes de que el estado de la UI se actualice no generan dos POST.
 */
export function createSubmitGate(): { tryAcquire: () => boolean; release: () => void; isBusy: () => boolean } {
  let busy = false;
  return {
    tryAcquire: () => {
      if (busy) return false;
      busy = true;
      return true;
    },
    release: () => {
      busy = false;
    },
    isBusy: () => busy,
  };
}

/* -------------------------------------------------------------------------- */
/* Orquestación (sin React): una solicitud pendiente, su clave y su recuperación */
/* -------------------------------------------------------------------------- */

/**
 * Reglas que garantiza este controlador (las usa LyricsStudio y las prueban los tests con dependencias simuladas):
 *  • UNA sola solicitud sin resolver a la vez. Mientras exista (posiblemente creada en el servidor) no se acepta otro
 *    payload y su clave / operationId NUNCA se reemplazan ni se borran en una rama ambigua.
 *  • La clave solo se descarta con evidencia: letra recibida, 409 terminal, GET con estado final, rechazo previo a
 *    crear nada de un intento que jamás pudo llegar al servicio, o descarte explícito del usuario.
 *  • Ningún error provoca un POST nuevo: el reintento es siempre una acción explícita con la misma clave.
 *  • Con operationId conocido se consulta GET /generations/{id}; no se vuelve a enviar el POST.
 */

export interface LyricsOutcome {
  title: string;
  lyrics: string;
}

export type PendingCause = 'accepted' | 'unknown' | 'restored' | 'rate-limited';

export interface PendingView {
  operationId: string | null;
  /** true solo si el backend informó/marcó la operación como incierta. */
  uncertain: boolean;
  /** El backend no pudo confirmar el cierre de la operación (puede conservar su débito): no se sabe si hubo reintegro. */
  closeUncertain: boolean;
  cause: PendingCause;
  /** Consulta automática activa (la UI la sostiene con runPolling). */
  polling: boolean;
  checking: boolean;
  lastCheckFailed: boolean;
  /** Hay un body en memoria para reenviar EXACTAMENTE la misma solicitud. */
  canRetry: boolean;
}

/**
 * Texto del aviso de solicitud pendiente según el estado REAL de la vista. Nunca afirma que la letra terminó ni que las fichas
 * se devolvieron (nada de eso está confirmado mientras la operación sigue pendiente), y solo dice que se «sigue consultando»
 * si la consulta automática está activa: si se detuvo (límite de intentos, 403/404), lo dice y ofrece consultar de nuevo.
 */
export function describePending(p: PendingView): { title: string; text: string } {
  if (p.cause === 'rate-limited') {
    return {
      title: 'Llegaste al límite de solicitudes',
      text: 'Tu solicitud anterior sigue sin confirmar y la conservamos. Reintentá más tarde: recuperamos la misma, no se crea otra.',
    };
  }
  if (p.cause === 'restored' && !p.operationId) {
    return {
      title: 'Hay una solicitud anterior sin confirmar',
      text: 'Si volvés a generar con los mismos datos, recuperamos esa misma solicitud en lugar de crear otra. Con datos distintos no se envía nada hasta resolverla.',
    };
  }
  if (p.operationId) {
    const follow = p.polling
      ? 'Seguimos consultando el estado.'
      : 'La consulta automática se detuvo: usá «Consultar ahora» para revisar el estado de nuevo.';
    if (p.closeUncertain) {
      return {
        title: 'Tu solicitud está pendiente de confirmación',
        text: `No pudimos confirmar el cierre de esta operación, así que todavía no sabemos si se descontaron o se devolvieron fichas ni si la letra se generó. No la pedimos de nuevo por tu cuenta. ${follow}`,
      };
    }
    if (p.uncertain) {
      return {
        title: 'El resultado está pendiente de confirmación',
        text: `Todavía no sabemos si el proveedor completó la letra. No la pedimos de nuevo por tu cuenta. ${follow}`,
      };
    }
    if (p.polling) {
      return { title: 'Tu letra todavía no está lista', text: 'Seguimos consultando el estado. No hace falta que vuelvas a generarla.' };
    }
    return {
      title: 'Tu solicitud sigue pendiente de confirmación',
      text: `Todavía no sabemos si la letra terminó. ${follow} Mientras siga pendiente no enviamos una solicitud nueva.`,
    };
  }
  return {
    title: 'No pudimos confirmar el resultado',
    text: 'La solicitud pudo haber llegado a Melodya. Si la reintentás desde acá, recuperamos la misma solicitud en lugar de crear otra.',
  };
}

export interface ControllerSnapshot {
  pending: PendingView | null;
  /** Letra recuperada que NO se aplicó porque el editor cambió: espera una aceptación explícita. */
  recovered: LyricsOutcome | null;
  busy: boolean;
  /** Sube cada vez que se pide reanudar la consulta (reinicia el ciclo de polling aunque `polling` ya fuera true). */
  pollEpoch: number;
}

export interface LyricsControllerDeps {
  /** POST /assistant/lyrics con Idempotency-Key. Rechaza con { status, code, details } ante un error. */
  post(body: unknown, idempotencyKey: string): Promise<{ status: number; data: unknown }>;
  /** GET /generations/{id}. */
  getOperation(id: string): Promise<OperationSnapshot>;
  getStorage(): KeyValueStorage | null;
  makeKey(): string;
}

export type SubmitOutcome =
  | { kind: 'unauthenticated' }
  | { kind: 'busy' }
  | { kind: 'no-request' }
  /** Hay una solicitud sin resolver con OTRO payload: no se envió nada. */
  | { kind: 'blocked'; operationId: string | null }
  /** Mismo payload y operación conocida: no se envía POST; la UI debe consultar el estado. */
  | { kind: 'resume'; operationId: string }
  /** `editorChanged`: el editor cambió desde que empezó la solicitud (o no hay línea base fiable): la letra NO se aplica sola, queda en `snapshot.recovered`. */
  | { kind: 'completed'; title: string; lyrics: string; tags: string[]; model?: string; editorChanged: boolean }
  /** El resultado ya lo entregó otro camino (consulta por GET) o la solicitud se descartó: no hay nada que aplicar. */
  | { kind: 'superseded' }
  | { kind: 'pending'; operationId: string | null; uncertain: boolean; cause: 'accepted' | 'unknown' }
  /** 429 propio del backend. `kept` = la clave de un intento anterior se conserva. */
  | { kind: 'rate-limited'; kept: boolean }
  | { kind: 'rejected'; reason: 'insufficient-credits' | 'validation' | 'key-conflict' | 'pricing-not-configured' | 'no-lyrics-provider'; kept: boolean; message?: string }
  | { kind: 'failed'; reason: 'operation-failed' | 'not-active' };

export type CheckOutcome =
  | { kind: 'none' }
  | { kind: 'completed'; title: string; lyrics: string; editorChanged: boolean }
  | { kind: 'failed'; reason: 'failed' | 'canceled' }
  | { kind: 'pending'; uncertain: boolean }
  | { kind: 'invalid'; reason: string }
  | { kind: 'error'; status: number | undefined; stop: boolean };

interface Attempt extends StoredAttempt {
  /** La operación pudo haberse creado en el servidor (se envió algo cuyo resultado se desconoce). */
  mayExist: boolean;
  /** Firma del editor cuando empezó la solicitud (en memoria; nunca se persiste). */
  baseline: string | null;
  /** La letra recuperada ya se entregó a la UI (evita aplicarla dos veces si dos consultas terminan a la vez). */
  claimed?: boolean;
}

/** Firma estable del contenido editable: para saber si el usuario lo modificó mientras la operación estaba pendiente. */
export function editorSignature(outcome: LyricsOutcome | null | undefined): string {
  return outcome ? `${outcome.title}\u0000${outcome.lyrics}` : '';
}

export function createLyricsController(deps: LyricsControllerDeps) {
  const gate = createSubmitGate();
  let attempt: Attempt | null = null;
  let lastBody: unknown = null;
  let snapshot: ControllerSnapshot = { pending: null, recovered: null, busy: false, pollEpoch: 0 };
  const listeners = new Set<() => void>();

  const update = (patch: Partial<ControllerSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((l) => l());
  };
  const updatePending = (patch: Partial<PendingView>) => {
    if (snapshot.pending) update({ pending: { ...snapshot.pending, ...patch } });
  };
  const persist = () => {
    if (attempt) saveAttempt(deps.getStorage(), { v: 1, userId: attempt.userId, key: attempt.key, fingerprint: attempt.fingerprint, operationId: attempt.operationId, closeUncertain: attempt.closeUncertain });
  };
  const forget = () => {
    attempt = null;
    lastBody = null;
    clearAttempt(deps.getStorage());
    update({ pending: null, recovered: null });
  };
  const pendingView = (cause: PendingCause, extra: Partial<PendingView> = {}): PendingView => ({
    operationId: attempt?.operationId ?? null,
    // La señal de cierre incierto de la solicitud vigente se conserva en todas las vistas (consultas, reanudaciones, recarga).
    uncertain: attempt?.closeUncertain === true,
    closeUncertain: attempt?.closeUncertain === true,
    cause,
    polling: Boolean(attempt?.operationId),
    checking: false,
    lastCheckFailed: false,
    canRetry: lastBody !== null && !attempt?.operationId,
    ...extra,
  });

  async function submit(body: unknown, userId: string | null, baseline: string | null, getEditorSignature: () => string): Promise<SubmitOutcome> {
    if (!userId) return { kind: 'unauthenticated' };
    if (!gate.tryAcquire()) return { kind: 'busy' };
    update({ busy: true });
    try {
      const storage = deps.getStorage();
      const fingerprint = fingerprintPayload(body);
      let current: Attempt | null = attempt;
      if (!current) {
        const stored = loadAttempt(storage, userId);
        current = stored ? { ...stored, mayExist: true, baseline: null } : null;
      }
      if (current && current.userId !== userId) current = null; // solicitud de otra identidad: no se reutiliza

      // Con una solicitud sin resolver, otro payload NO la reemplaza (no se pierde su clave ni su operationId).
      if (current && current.mayExist && current.fingerprint !== fingerprint) {
        attempt = current;
        return { kind: 'blocked', operationId: current.operationId ?? null };
      }

      lastBody = body;
      if (current && current.fingerprint === fingerprint) {
        attempt = { ...current, baseline: baseline ?? current.baseline };
        // Operación conocida: se consulta el estado; no se vuelve a enviar el POST.
        if (attempt.operationId) {
          update({
            pending: pendingView(snapshot.pending?.cause ?? 'unknown', { polling: true, canRetry: false }),
            pollEpoch: snapshot.pollEpoch + 1,
          });
          return { kind: 'resume', operationId: attempt.operationId };
        }
      } else {
        attempt = { v: 1, userId, key: deps.makeKey(), fingerprint, mayExist: false, baseline };
      }
      persist(); // antes del POST: si se corta o se recarga, la clave sigue disponible
      const sent = attempt;

      try {
        const { status, data } = await deps.post(body, sent.key);
        const res = classifyAssistantResponse(status, data);
        if (res.kind === 'completed') {
          const model = (data as { resolvedProvider?: { model?: unknown } } | null)?.resolvedProvider?.model;
          const extra = typeof model === 'string' && model ? { model } : {};
          // Otro camino ya entregó este resultado, o la solicitud se descartó mientras tanto: no se aplica dos veces.
          if (attempt !== sent || sent.claimed) return { kind: 'superseded' };
          // Mismo criterio que la recuperación por GET: sin línea base fiable o con el editor modificado, no se pisa.
          const editorChanged = sent.baseline === null || getEditorSignature() !== sent.baseline;
          if (!editorChanged) {
            forget();
            return { kind: 'completed', title: res.title, lyrics: res.lyrics, tags: res.tags, editorChanged: false, ...extra };
          }
          const operationId = res.operationId ?? sent.operationId;
          attempt = { ...sent, mayExist: true, claimed: true, ...(operationId ? { operationId } : {}) };
          persist(); // si se recarga antes de aceptarla, se vuelve a recuperar por GET
          update({ pending: null, recovered: { title: res.title, lyrics: res.lyrics } });
          return { kind: 'completed', title: res.title, lyrics: res.lyrics, tags: res.tags, editorChanged: true, ...extra };
        }
        // 202 (en curso / incierta) o 200 sin letra válida: NO es un resultado. Se conserva la solicitud.
        const operationId = res.kind === 'pending' ? res.operationId : res.operationId ?? sent.operationId;
        attempt = { ...sent, mayExist: true, ...(operationId ? { operationId } : {}) };
        persist();
        const uncertain = res.kind === 'pending' ? res.uncertain : false;
        const cause = res.kind === 'pending' ? 'accepted' : 'unknown';
        update({ pending: pendingView(cause, { uncertain }) });
        return { kind: 'pending', operationId: operationId ?? null, uncertain, cause };
      } catch (err) {
        const e = err as ErrorLike;
        const info = classifyAssistantError({ status: e?.status, code: e?.code, details: e?.details });

        if (info.kind === 'failed') {
          // Evidencia contractual de que la operación de ESTA clave terminó sin letra (o se descartó).
          forget();
          return { kind: 'failed', reason: info.reason };
        }

        if (info.kind === 'operation-exists') {
          // La operación existe: se conserva la clave y se guarda su id para consultarla (GET autenticado). Ningún POST nuevo.
          attempt = { ...sent, mayExist: true, operationId: info.operationId, ...(info.closeUncertain ? { closeUncertain: true } : {}) };
          persist();
          update({ pending: pendingView('accepted') });
          return { kind: 'pending', operationId: info.operationId, uncertain: info.closeUncertain, cause: 'accepted' };
        }

        if (info.kind === 'not-started') {
          if (info.reason === 'pricing-not-configured' || info.reason === 'no-lyrics-provider') {
            // Rechazo definitivo previo a la operación: no hay nada pendiente que recuperar ni que reintentar con esta clave.
            // (Una operación ya conocida no llega acá: con operationId se consulta por GET y no se vuelve a enviar el POST; y una
            // clave existente se resuelve en el backend como 200/202/409 antes de llegar a estos errores.)
            forget();
            return { kind: 'rejected', reason: info.reason, kept: false, message: e?.message };
          }
          if (info.reason === 'key-conflict') {
            // La clave pertenece a otros parámetros (no a esta acción): se descarta; esta acción nunca se envió.
            forget();
            return { kind: 'rejected', reason: 'key-conflict', kept: false, message: e?.message };
          }
          // La respuesta prueba que ESTE envío no creó nada, pero la clave puede venir de un intento anterior cuyo
          // resultado se desconoce (p. ej. un 429 del límite de frecuencia llega antes de resolver la repetición).
          // Solo se descarta si ese intento jamás pudo llegar al servicio.
          if (!sent.mayExist) {
            forget();
            return info.reason === 'rate-limited'
              ? { kind: 'rate-limited', kept: false }
              : { kind: 'rejected', reason: info.reason, kept: false, message: rejectedMessage(info.reason, e) };
          }
          attempt = sent;
          update({ pending: pendingView(info.reason === 'rate-limited' ? 'rate-limited' : 'unknown') });
          return info.reason === 'rate-limited'
            ? { kind: 'rate-limited', kept: true }
            : { kind: 'rejected', reason: info.reason, kept: true, message: rejectedMessage(info.reason, e) };
        }

        // Timeout, corte de red, 5xx, 4xx reenviado…: no prueba nada. Se conserva la clave (y el operationId, si había).
        attempt = { ...sent, mayExist: true };
        persist();
        update({ pending: pendingView('unknown') });
        return { kind: 'pending', operationId: attempt.operationId ?? null, uncertain: false, cause: 'unknown' };
      }
    } finally {
      gate.release();
      update({ busy: false });
    }
  }

  /** Reintento EXPLÍCITO de la última solicitud: mismo body ⇒ misma huella ⇒ misma clave. */
  function retry(userId: string | null, baseline: string | null, getEditorSignature: () => string): Promise<SubmitOutcome> {
    return lastBody === null ? Promise.resolve({ kind: 'no-request' } as SubmitOutcome) : submit(lastBody, userId, baseline, getEditorSignature);
  }

  /** Recupera, tras una recarga o al hidratarse el usuario, la solicitud guardada de ESTA identidad. */
  function restore(userId: string | null, baseline: string | null): void {
    if (!userId) {
      // Sin sesión: se limpia solo lo que está en memoria; el registro persistido queda para el mismo usuario.
      if (attempt) {
        attempt = null;
        lastBody = null;
        update({ pending: null, recovered: null });
      }
      return;
    }
    if (attempt && attempt.userId !== userId) {
      attempt = null;
      lastBody = null;
      update({ pending: null, recovered: null });
    }
    if (attempt) return;
    const stored = loadAttempt(deps.getStorage(), userId);
    if (!stored) return;
    attempt = { ...stored, mayExist: true, baseline };
    update({ pending: pendingView('restored', { canRetry: false }) });
  }

  /** Una consulta GET /generations/{id}. No crea nada y NO borra la clave salvo con un estado final confirmado. */
  async function checkOnce(getEditorSignature: () => string): Promise<CheckOutcome> {
    const current = attempt;
    if (!current?.operationId) return { kind: 'none' };
    updatePending({ checking: true });
    try {
      const snap = await deps.getOperation(current.operationId);
      if (attempt !== current) return { kind: 'none' }; // mientras tanto se descartó o cambió la solicitud
      const result = interpretOperationSnapshot(snap);
      if (result.kind === 'completed') {
        if (current.claimed) return { kind: 'none' };
        current.claimed = true;
        updatePending({ checking: false, polling: false });
        // Sin línea base conocida no se puede afirmar que el editor no cambió: se espera una aceptación explícita.
        const editorChanged = current.baseline === null || getEditorSignature() !== current.baseline;
        return { kind: 'completed', title: result.title, lyrics: result.lyrics, editorChanged };
      }
      if (result.kind === 'failed') {
        forget();
        return { kind: 'failed', reason: result.reason };
      }
      if (result.kind === 'invalid') {
        updatePending({ checking: false, polling: false });
        return { kind: 'invalid', reason: result.reason };
      }
      // Un PROCESSING sin marca de incertidumbre en el job NO borra la señal de cierre incierto del propio intento.
      updatePending({ checking: false, uncertain: result.uncertain || current.closeUncertain === true, lastCheckFailed: false });
      return { kind: 'pending', uncertain: result.uncertain };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const stop = status === 403 || status === 404;
      if (attempt === current) updatePending({ checking: false, lastCheckFailed: true, ...(stop ? { polling: false } : {}) });
      return { kind: 'error', status, stop };
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    submit,
    retry,
    restore,
    checkOnce,
    /** La letra recuperada se aplicó al editor (o el usuario conservó la suya): recién ahora se olvida la solicitud. */
    finishRecovered: () => forget(),
    /** El editor cambió: la letra recuperada queda en espera de aceptación explícita (la solicitud sigue guardada). */
    holdRecovered: (outcome: LyricsOutcome) => update({ recovered: outcome }),
    /** Detiene SOLO la consulta automática; clave, operationId y registro persistido quedan intactos. */
    pausePolling: () => updatePending({ polling: false, checking: false }),
    /** Reanuda la consulta de la operación conocida (no envía ningún POST). */
    resumePolling: () => {
      if (!attempt?.operationId || !snapshot.pending) return;
      update({ pending: { ...snapshot.pending, polling: true, lastCheckFailed: false }, pollEpoch: snapshot.pollEpoch + 1 });
    },
    /** Descarte EXPLÍCITO de la referencia local (la UI debe haber advertido que la operación puede seguir en el servidor). */
    discard: () => forget(),
  };
}

export type LyricsController = ReturnType<typeof createLyricsController>;

/**
 * Ciclo de consulta acotado (espera creciente, máximo POLL_MAX_ATTEMPTS). Al agotarse o cancelarse solo se detiene
 * la consulta: la solicitud, su clave y su operationId no se tocan.
 */
export async function runPolling(args: {
  controller: LyricsController;
  getEditorSignature: () => string;
  sleep: (ms: number) => Promise<void>;
  isCancelled: () => boolean;
  onOutcome: (outcome: CheckOutcome) => void;
}): Promise<'done' | 'exhausted' | 'cancelled'> {
  const { controller, getEditorSignature, sleep, isCancelled, onOutcome } = args;
  let attempts = 0;
  while (!isCancelled()) {
    const outcome = await controller.checkOnce(getEditorSignature);
    // Un resultado final se entrega aunque se haya cancelado el ciclo mientras esperaba la respuesta.
    if (outcome.kind === 'completed' || outcome.kind === 'failed') {
      onOutcome(outcome);
      return 'done';
    }
    if (isCancelled()) return 'cancelled';
    onOutcome(outcome);
    if (outcome.kind === 'none' || outcome.kind === 'invalid' || (outcome.kind === 'error' && outcome.stop)) return 'done';
    attempts += 1;
    if (!shouldContinuePolling(attempts)) {
      controller.pausePolling();
      return 'exhausted';
    }
    await sleep(pollDelayMs(attempts));
  }
  return 'cancelled';
}
