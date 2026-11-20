/**
 * MELODYA WEB — Capacidades del plan (E5). Lógica pura, sin React ni dependencias de la aplicación.
 *
 * La fuente de verdad es el backend: `GET /users/me` devuelve `entitlements` con `enabled` (¿el plan efectivo la incluye?) y
 * `enforced` (¿el servidor rechaza hoy la operación sin ella?). Son TRES cosas distintas y no se mezclan:
 *   1. INCLUIDA en el plan  → `enabled`.
 *   2. RESTRICCIÓN aplicada → `enforced` (depende de `entitlements.mode`): solo entonces la interfaz bloquea la acción (`isLocked`: `enforced && !enabled`),
 *      así lo que se bloquea coincide con lo que el servidor va a rechazar.
 *   3. INDICACIÓN visual    → `isPlanExcluded` (`!enabled`): la corona avisa que la función requiere otro plan, con el modo en `off`, `shadow` o `enforce`.
 *      No bloquea nada: en `shadow` la acción sigue permitida y el backend registra lo que habría denegado.
 * Es solo experiencia de usuario: el rechazo real es el 403 CAPABILITY_NOT_IN_PLAN del backend.
 */

export interface EntitlementView {
  enabled: boolean;
  limit?: number;
  /** El servidor exige esta capacidad hoy. Ausente en un backend anterior a E5: se trata como no exigida. */
  enforced?: boolean;
}
export type Entitlements = Record<string, EntitlementView | undefined>;

export type CapabilityKey =
  | 'VOICE_CLONING' | 'VOICE_COVER' | 'AUDIO_REFERENCE' | 'PRODUCTION_CONTROLS' | 'CREATIVITY_SETTINGS'
  | 'LYRICS_AI' | 'LYRIC_PERSONAS' | 'COVER_ART' | 'DOWNLOAD_AUDIO' | 'DOWNLOAD_WAV' | 'SONG_REMIX';

/** ¿Está bloqueada para este usuario? Sin datos (sesión sin cargar o backend anterior) nunca bloquea: decide el servidor. */
export function isLocked(entitlements: Entitlements | null | undefined, key: CapabilityKey): boolean {
  const entry = entitlements?.[key];
  return Boolean(entry && entry.enforced === true && entry.enabled === false);
}

/**
 * ¿El plan efectivo NO incluye la capacidad? Solo la indicación visual (corona y plan mínimo): no depende de `enforced` ni bloquea la acción.
 * Sin datos (sesión sin cargar, perfil sin capacidades o clave desconocida) NO se asume nada: devuelve false, para no mostrar coronas incorrectas.
 */
export function isPlanExcluded(entitlements: Entitlements | null | undefined, key: CapabilityKey): boolean {
  const entry = entitlements?.[key];
  return Boolean(entry && entry.enabled === false);
}

/** Texto que explica el bloqueo sin escribir códigos de plan en la interfaz (los planes los informa el backend en el 403). */
export const LOCK_REASON: Record<CapabilityKey, string> = {
  VOICE_CLONING: 'Tu plan no incluye clonar tu voz. Mejorá tu plan para crear voces propias.',
  VOICE_COVER: 'Tu plan no incluye cantar con una voz clonada. Mejorá tu plan para usarla.',
  AUDIO_REFERENCE: 'Tu plan no incluye subir audios de referencia. Mejorá tu plan para usarlos.',
  PRODUCTION_CONTROLS: 'Tu plan no incluye el planeta Producción. Mejorá tu plan para elegir la duración y lo que querés evitar.',
  CREATIVITY_SETTINGS: 'Tu plan no incluye el planeta Creatividad. Mejorá tu plan para ajustar rareza, influencia del estilo y variedad.',
  LYRICS_AI: 'Tu plan no incluye el asistente de letras. Podés escribir tu propia letra o crear una pieza instrumental.',
  LYRIC_PERSONAS: 'Tu plan no incluye letristas personalizados. Mejorá tu plan para crearlos.',
  COVER_ART: 'Tu plan no incluye generar portadas.',
  DOWNLOAD_AUDIO: 'Tu plan no incluye descargar canciones. Mejorá tu plan para bajar tus canciones en MP3.',
  DOWNLOAD_WAV: 'Tu plan no incluye descargar canciones en WAV. Mejorá tu plan para bajarlas en máxima calidad.',
  SONG_REMIX: 'Tu plan no incluye hacer remixes. Mejorá tu plan para crear canciones nuevas a partir de otras.',
};

/** Lo que el plan del usuario no permite en el creador de canciones. Cada valor es el motivo visible (ausente = permitido). */
export interface CapabilityLocks {
  /** Planetas que no se pueden agregar (por id de planeta: reference, production, creativity). */
  planets: Partial<Record<string, string>>;
  /** Cantar con una voz clonada (VOICE_COVER). */
  customVoice?: string;
  /** Grabar o clonar una voz nueva (VOICE_CLONING). */
  voiceCloning?: string;
  /**
   * Asistente de letras de Melodya (LYRICS_AI): crear, generar, formatear y preparar letras en el estudio de letras. NO bloquea crear una canción a
   * partir de una idea y estilos, ni con una letra propia: esos son flujos generales de generación que cualquier plan puede usar.
   */
  lyricsAi?: string;
  /** Hacer un remix (SONG_REMIX). Versionar (Cover) además necesita AUDIO_REFERENCE (`planets.reference`). */
  remix?: string;
}

export function creatorLocks(entitlements: Entitlements | null | undefined): CapabilityLocks {
  const locks: CapabilityLocks = { planets: {} };
  if (isLocked(entitlements, 'AUDIO_REFERENCE')) locks.planets.reference = LOCK_REASON.AUDIO_REFERENCE;
  if (isLocked(entitlements, 'PRODUCTION_CONTROLS')) locks.planets.production = LOCK_REASON.PRODUCTION_CONTROLS;
  if (isLocked(entitlements, 'CREATIVITY_SETTINGS')) locks.planets.creativity = LOCK_REASON.CREATIVITY_SETTINGS;
  if (isLocked(entitlements, 'VOICE_COVER')) locks.customVoice = LOCK_REASON.VOICE_COVER;
  if (isLocked(entitlements, 'VOICE_CLONING')) locks.voiceCloning = LOCK_REASON.VOICE_CLONING;
  if (isLocked(entitlements, 'LYRICS_AI')) locks.lyricsAi = LOCK_REASON.LYRICS_AI;
  if (isLocked(entitlements, 'SONG_REMIX')) locks.remix = LOCK_REASON.SONG_REMIX;
  return locks;
}

/* ───────────── Cupos (E6) ───────────── */

export interface UsageMeterLike { included: boolean; limit: number | null; used: number | null; remaining: number | null; enforced: boolean }
export interface UsageLike { period: { kind: string; resetsAt: string }; songs: UsageMeterLike }

/** «1 de diciembre». El mes calendario del plan base vence a medianoche UTC: se muestra en UTC para no adelantar el día. */
export function formatRenewal(resetsAt: string, kind: string): string {
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', ...(kind === 'calendar' ? { timeZone: 'UTC' } : {}) });
}

/**
 * Texto del medidor de canciones del creador. `null` si no hay nada que mostrar (el plan no tiene tope).
 * `exhausted`: el servidor rechazaría la próxima canción (cupo lleno y exigido).
 */
export function songsMeterText(usage: UsageLike | null | undefined): { text: string; exhausted: boolean } | null {
  const s = usage?.songs;
  if (!usage || !s || !s.included || s.limit === null || s.used === null) return null;
  const when = formatRenewal(usage.period.resetsAt, usage.period.kind);
  const renews = when ? ` Se renueva el ${when}.` : '';
  if (s.remaining === 0) {
    return { text: `Usaste las ${s.limit} canciones de tu plan en este período.${renews}`, exhausted: s.enforced };
  }
  const left = s.remaining ?? Math.max(s.limit - s.used, 0);
  return { text: `Te ${left === 1 ? 'queda' : 'quedan'} ${left} de ${s.limit} canciones en este período.${renews}`, exhausted: false };
}

export interface DownloadsUsageLike { downloads: UsageMeterLike; period: { kind: string; resetsAt: string } }

/**
 * ¿Puede el usuario pedir una descarga ahora? Solo bloquea lo que el servidor rechazaría (capacidad o cupo exigidos); el resto lo decide el
 * servidor. `hint` es el medidor («Te quedan 15 de 20 descargas…») cuando hay tope.
 */
export function downloadState(entitlements: Entitlements | null | undefined, usage: DownloadsUsageLike | null | undefined): { allowed: boolean; reason: string | null; hint: string | null; lock: 'capability' | 'quota' | null } {
  if (isLocked(entitlements, 'DOWNLOAD_AUDIO')) return { allowed: false, reason: LOCK_REASON.DOWNLOAD_AUDIO, hint: null, lock: 'capability' };
  const d = usage?.downloads;
  if (!usage || !d) return { allowed: true, reason: null, hint: null, lock: null };
  const when = formatRenewal(usage.period.resetsAt, usage.period.kind);
  const renews = when ? ` Se renueva el ${when}.` : '';
  if (d.enforced && !d.included) return { allowed: false, reason: 'Tu plan no incluye descargas.', hint: null, lock: 'capability' };
  if (d.limit === null || d.used === null) return { allowed: true, reason: null, hint: null, lock: null };
  if (d.remaining === 0) {
    const reason = `Usaste las ${d.limit} descargas de tu plan en este período.${renews}`;
    return d.enforced ? { allowed: false, reason, hint: null, lock: 'quota' } : { allowed: true, reason: null, hint: reason, lock: null };
  }
  const left = d.remaining ?? Math.max(d.limit - d.used, 0);
  return { allowed: true, reason: null, hint: `Te ${left === 1 ? 'queda' : 'quedan'} ${left} de ${d.limit} descargas en este período.${renews}`, lock: null };
}

/* ───────────── Descarga en WAV ───────────── */

export interface WavStateLike { status: 'NONE' | 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'; retryable?: boolean; message?: string }
export type WavMenuKind = 'locked' | 'ready' | 'quota' | 'preparing' | 'downloading' | 'waitable' | 'failed' | 'missing' | 'unknown';
export interface WavMenuState {
  kind: WavMenuKind;
  label: string;
  /** El ítem no se puede accionar (el bloqueo comercial NO es «disabled»: sigue siendo clicable para mostrar el aviso de upgrade). */
  disabled: boolean;
  /** Hay actividad en curso para esta versión (pidiendo, preparando o iniciando la descarga): se muestra el indicador de progreso. */
  busy: boolean;
  title: string;
}

/**
 * Qué ofrece el menú de descarga para el WAV de UNA versión. Orden de las reglas:
 *  1. capacidad no incluida (y exigida por el servidor) → bloqueado con el aviso de upgrade, igual que el MP3: no se ofrece descargar;
 *  2. el usuario ya eligió el WAV de esta versión (`intent`: pidiendo / preparando / iniciando la descarga) → progreso, sin acción (evita el doble clic);
 *  3. WAV guardado → descargar (si el cupo de descargas está agotado y se exige, deshabilitado con su motivo);
 *  4. conversión en curso que el usuario no pidió en esta pantalla → «descargar cuando esté listo» (espera la existente, no pide otra);
 *  5. falló → reintentar (solo si el servidor lo permite); nunca existió → preparar.
 * Con `wav` indefinido el estado de las versiones todavía no se cargó: no se ofrece nada hasta saberlo.
 */
export function wavMenuState(
  entitlements: Entitlements | null | undefined,
  wav: WavStateLike | null | undefined,
  downloads?: { allowed: boolean; reason: string | null; lock: 'capability' | 'quota' | null } | null,
  intent?: 'requesting' | 'preparing' | 'downloading' | null,
): WavMenuState {
  if (isLocked(entitlements, 'DOWNLOAD_WAV')) return { kind: 'locked', label: 'Descargar WAV', disabled: false, busy: false, title: LOCK_REASON.DOWNLOAD_WAV };
  if (intent === 'requesting') return { kind: 'preparing', label: 'Pidiendo el WAV…', disabled: true, busy: true, title: 'Estamos pidiendo el WAV de esta versión.' };
  if (intent === 'preparing') return { kind: 'preparing', label: 'Preparando WAV…', disabled: true, busy: true, title: 'Estamos preparando el WAV. Puede demorar unos minutos y se descargará solo cuando esté listo.' };
  if (intent === 'downloading') return { kind: 'downloading', label: 'Descargando WAV…', disabled: true, busy: true, title: 'Estamos iniciando la descarga del WAV.' };
  if (!wav) return { kind: 'unknown', label: 'Descargar WAV', disabled: true, busy: false, title: 'Cargando el estado del WAV…' };
  switch (wav.status) {
    case 'COMPLETED':
      if (downloads && !downloads.allowed && downloads.lock === 'quota') return { kind: 'quota', label: 'Descargar WAV', disabled: true, busy: false, title: downloads.reason ?? 'Alcanzaste el límite de descargas de tu plan.' };
      return { kind: 'ready', label: 'Descargar WAV', disabled: false, busy: false, title: 'Baja el audio de esta versión en WAV' };
    case 'PENDING':
    case 'PROCESSING':
      return { kind: 'waitable', label: 'Descargar WAV cuando esté listo', disabled: false, busy: false, title: 'Ya estamos preparando el WAV de esta versión. Tocá y se descargará solo cuando esté listo.' };
    case 'FAILED':
      // Sin reintento posible (retryable false: el servidor sabe que repetir fallaría igual) no se ofrece «Reintentar»: se informa el motivo.
      if (wav.retryable === false) return { kind: 'failed', label: 'WAV no disponible', disabled: true, busy: false, title: wav.message ?? 'No pudimos preparar el WAV de esta versión. Contactá a soporte.' };
      return { kind: 'failed', label: 'Reintentar WAV', disabled: false, busy: false, title: wav.message ?? 'No pudimos preparar el WAV de esta versión. Podés reintentarlo.' };
    default:
      return { kind: 'missing', label: 'Preparar WAV', disabled: false, busy: false, title: 'Convertimos esta versión a WAV la primera vez que lo pedís y puede demorar unos minutos. Después lo descargás cuando quieras.' };
  }
}

/** ¿Alguna versión tiene una conversión a WAV en curso? Mientras sea así conviene volver a consultar el listado. */
export function hasWavInProgress(versions: ReadonlyArray<{ wav?: { status: string } | null }> | null | undefined): boolean {
  return Boolean(versions?.some((v) => v.wav?.status === 'PENDING' || v.wav?.status === 'PROCESSING'));
}

/** Versiones cuyo WAV pasó de «en preparación» a «listo» entre dos consultas (para avisar al usuario una sola vez). */
export function newlyReadyWavs<T extends { id: string; wav?: { status: string } | null }>(prev: ReadonlyMap<string, string>, versions: readonly T[]): T[] {
  return versions.filter((v) => v.wav?.status === 'COMPLETED' && (prev.get(v.id) === 'PENDING' || prev.get(v.id) === 'PROCESSING'));
}

export interface LimitExceeded {
  capability: string;
  limit: number;
  used: number;
  resetsAt: string;
}

/** Si el error es el rechazo por cupo agotado (403 LIMIT_EXCEEDED), devuelve su detalle. */
export function limitExceeded(err: unknown): LimitExceeded | null {
  const e = err as { status?: unknown; details?: unknown } | null;
  if (!e || typeof e !== 'object' || e.status !== 403) return null;
  const d = e.details as { code?: string; capability?: string; limit?: number; used?: number; resetsAt?: string } | undefined;
  if (!d || d.code !== 'LIMIT_EXCEEDED' || typeof d.capability !== 'string' || typeof d.limit !== 'number') return null;
  return { capability: d.capability, limit: d.limit, used: typeof d.used === 'number' ? d.used : d.limit, resetsAt: String(d.resetsAt ?? '') };
}

export function limitExceededMessage(l: LimitExceeded): string {
  const when = l.resetsAt ? formatRenewal(l.resetsAt, 'subscription') : '';
  const what = l.capability === 'SONGS_PER_PERIOD' ? `las ${l.limit} canciones de tu plan`
    : l.capability === 'DOWNLOADS_PER_PERIOD' ? `las ${l.limit} descargas de tu plan` : `el límite de ${l.limit}`;
  return `Alcanzaste ${what} en este período.${when ? ` Se renueva el ${when}.` : ''}`;
}

export interface CapabilityDenial {
  capability: string;
  capabilityName?: string;
  includedInPlans: Array<{ code: string; name: string }>;
}

/** Si el error es el rechazo del servidor por capacidad (403 CAPABILITY_NOT_IN_PLAN), devuelve su detalle. */
export function capabilityDenial(err: unknown): CapabilityDenial | null {
  const e = err as { status?: unknown; details?: unknown } | null;
  if (!e || typeof e !== 'object' || e.status !== 403) return null;
  const d = e.details as { code?: string; capability?: string; capabilityName?: string; includedInPlans?: unknown } | undefined;
  if (!d || d.code !== 'CAPABILITY_NOT_IN_PLAN' || typeof d.capability !== 'string') return null;
  const plans = Array.isArray(d.includedInPlans)
    ? d.includedInPlans.filter((p): p is { code: string; name: string } => Boolean(p) && typeof (p as { name?: unknown }).name === 'string')
    : [];
  return { capability: d.capability, capabilityName: d.capabilityName, includedInPlans: plans };
}

/** Mensaje para el 403 por capacidad: qué falta y qué planes lo incluyen. */
export function capabilityDenialMessage(denial: CapabilityDenial): string {
  const what = denial.capabilityName ? `«${denial.capabilityName}»` : 'esta función';
  const names = denial.includedInPlans.map((p) => p.name);
  if (names.length === 0) return `Tu plan actual no incluye ${what}.`;
  if (names.length === 1) return `Tu plan actual no incluye ${what}. Lo incluye el plan ${names[0]}.`;
  return `Tu plan actual no incluye ${what}. Lo incluyen los planes ${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}.`;
}

/* ───────────── Consumo del período por capacidad (GET /users/me/usage → meters) ───────────── */

export interface UsageMeterItemLike {
  key: string;
  name: string;
  unit: string | null;
  status: string;
  limit: number | null;
  used: number;
  remaining: number | null;
  resetsAt: string;
}
export interface UsageMetersLike { period: { kind: string; start: string; end: string; resetsAt: string }; meters?: UsageMeterItemLike[] | null }

export type UsageLineState = 'bar' | 'reached' | 'not-included' | 'unlimited';
export interface UsageLine { key: string; name: string; state: UsageLineState; /** 0–100 (solo con barra). */ percent: number; value: string; detail: string }

const fmtInt = (n: number): string => n.toLocaleString('es-AR');
/** DD/MM/AAAA del período; el mes calendario del plan base se muestra en UTC para no adelantar el día. */
function periodDate(iso: string, kind: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', ...(kind === 'calendar' ? { timeZone: 'UTC' } : {}) });
}

/**
 * Líneas del resumen de uso. El servidor decide el estado de cada medidor (`status`): la interfaz solo lo presenta.
 *  - límite > 0: «consumido / total», barra y cuánto queda; con el consumo igual al límite la barra va completa y se dice que se alcanzó el límite;
 *  - límite 0: «No incluido», sin barra; sin tope: «Ilimitado», sin barra.
 * Un medidor con un estado desconocido no se muestra (no se inventa nada).
 */
export function usageMeterLines(usage: UsageMetersLike | null | undefined): UsageLine[] {
  const kind = usage?.period?.kind ?? 'subscription';
  const lines: UsageLine[] = [];
  for (const m of usage?.meters ?? []) {
    if (m.status === 'NOT_INCLUDED') {
      lines.push({ key: m.key, name: m.name, state: 'not-included', percent: 0, value: 'No incluido', detail: '' });
    } else if (m.status === 'UNLIMITED') {
      lines.push({ key: m.key, name: m.name, state: 'unlimited', percent: 0, value: 'Ilimitado', detail: '' });
    } else if ((m.status === 'AVAILABLE' || m.status === 'REACHED') && typeof m.limit === 'number' && m.limit > 0) {
      const reached = m.status === 'REACHED';
      const when = m.resetsAt ? periodDate(m.resetsAt, kind) : '';
      const renews = when ? ` Se renueva el ${when}.` : '';
      const left = m.remaining ?? Math.max(m.limit - m.used, 0);
      lines.push({
        key: m.key,
        name: m.name,
        state: reached ? 'reached' : 'bar',
        percent: reached ? 100 : Math.min(100, Math.max(0, Math.round((m.used / m.limit) * 100))),
        value: `${fmtInt(m.used)} / ${fmtInt(m.limit)}`,
        detail: reached
          ? `Alcanzaste el límite de tu plan en este período.${renews}`
          : `${left === 1 ? 'Te queda 1 disponible' : `Te quedan ${fmtInt(left)}${m.unit ? ` ${m.unit}` : ''}`} en este período.${renews}`,
      });
    }
  }
  return lines;
}

/** «Período actual: 01/11/2026 al 01/12/2026» (vacío si no hay medidores que lo justifiquen). */
export function usagePeriodText(usage: UsageMetersLike | null | undefined): string {
  if (!usage?.meters?.length) return '';
  const a = periodDate(usage.period.start, usage.period.kind);
  const b = periodDate(usage.period.end, usage.period.kind);
  return a && b ? `Período actual: ${a} al ${b}` : '';
}
