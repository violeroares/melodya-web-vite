/**
 * Voces clonadas TEMPORALES (Suno Voice): decisiones puras sobre su caducidad, sin DOM ni React.
 *
 * Una voz clonada puede caducar en horas y no se puede renovar: hay que volver a crearla (nueva frase y nueva grabación) a partir de la
 * muestra original, que Melodya conserva. Caducar NO es un problema de contenido: nunca se le pide al usuario que cambie su letra.
 */

export const VOICE_EXPIRED = 'VOICE_EXPIRED';

export const VOICE_EXPIRED_TITLE = 'Tu voz clonada caducó';
export const VOICE_EXPIRED_TEXT =
  'Las voces clonadas son temporales. Recreala con tu grabación original: solo tenés que grabar una frase nueva. Tus canciones y tus datos no se tocan.';

/** ¿El fallo de una generación (campo `error` de la API) es una voz caducada? Solo por `reasonCode`, nunca por el texto. */
export function isVoiceExpiredFailure(error?: { reasonCode?: unknown } | null): boolean {
  return error?.reasonCode === VOICE_EXPIRED;
}

type ErrorLike = { status?: unknown; details?: unknown };

/**
 * ¿El rechazo de `POST /generations` es «voz caducada» (422 VOICE_EXPIRED, antes de cobrar)? Devuelve la muestra afectada
 * (`details.sampleId`, o null si el backend no la informa), o `undefined` si el error es otro.
 */
export function voiceExpiredSample(err: unknown): string | null | undefined {
  const e = err as ErrorLike | null;
  if (!e || typeof e !== 'object') return undefined;
  const details = e.details as { code?: unknown; sampleId?: unknown } | undefined;
  if (!details || typeof details !== 'object' || details.code !== VOICE_EXPIRED) return undefined;
  return typeof details.sampleId === 'string' && details.sampleId ? details.sampleId : null;
}

export type VoiceAvailabilityState = 'expired' | 'available' | 'unknown';

/**
 * Estado de disponibilidad para la interfaz. SOLO `available === false` es «caducada»: `null`/ausente (red, timeout, Suno inactivo,
 * sin sesión que respalde la voz) es «desconocida» y no debe presentarse nunca como caducada.
 */
export function availabilityState(res?: { available?: boolean | null } | null): VoiceAvailabilityState {
  if (res?.available === false) return 'expired';
  if (res?.available === true) return 'available';
  return 'unknown';
}

export type VoiceCardStatus = 'checking' | 'available' | 'expired' | 'unverified';

/**
 * Estado que muestra la tarjeta de «Mis voces». Solo una confirmación explícita (`available: true` / `false`) da «Lista» / «Caducada»;
 * mientras se consulta es «checking» (nunca se muestra «Lista» provisoriamente) y un error o un `null` (red, timeout, Suno inactivo,
 * voz sin sesión READY que la respalde) es «unverified»: no se asume ni disponible ni caducada.
 */
export function voiceCardStatus(q: { data?: { available?: boolean | null } | null; isError?: boolean }): VoiceCardStatus {
  if (q.data) {
    const s = availabilityState(q.data);
    return s === 'unknown' ? 'unverified' : s;
  }
  if (q.isError) return 'unverified';
  return 'checking';
}

/** Máximo de consultas a `check-voice` en vuelo a la vez desde la interfaz (varias tarjetas se montan juntas). */
export const VOICE_AVAILABILITY_MAX_CONCURRENT = 5;

/** Limitador de concurrencia: ejecuta como mucho `max` tareas a la vez y encola el resto en orden de llegada. */
export function createConcurrencyLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    while (active < max && queue.length) queue.shift()!();
  };
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task().then(resolve, reject).finally(() => { active--; next(); });
      });
      next();
    });
  };
}

/** Muestra de la voz usada en una generación (input VOICE_SAMPLE), para ofrecer recrearla desde la pantalla de fallo. */
export function voiceSampleIdOf(gen?: { inputs?: Array<{ field?: string; sampleId?: string | null }> } | null): string | null {
  return gen?.inputs?.find((i) => i.field === 'VOICE_SAMPLE' && i.sampleId)?.sampleId ?? null;
}

/** La disponibilidad se cachea 2 minutos en el backend; la interfaz no pregunta más seguido que eso. */
export const VOICE_AVAILABILITY_STALE_MS = 2 * 60 * 1000;
