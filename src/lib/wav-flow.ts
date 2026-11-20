/**
 * MELODYA WEB — Descarga WAV bajo demanda como UNA experiencia continua: pedir → esperar la conversión → descargar el archivo de ESA versión.
 *
 * Lógica pura y sin React (la interfaz solo la conecta; ver features/song/useWavFlow). Reutiliza lo que ya existe y no agrega mecanismos:
 *  • el pedido es `POST /songs/:id/versions/:versionId/wav/retry` (idempotente en el servidor: no crea otra tarea si ya hay una);
 *  • el seguimiento es el listado de versiones que la pantalla ya consulta cada 8 s mientras haya un WAV en preparación (`wav.status`);
 *  • la descarga es `downloadSongAudio` (POST …/download autenticado → archivo → descarga del navegador).
 *
 * Cada versión tiene a lo sumo UN intento del usuario (`WavIntent`). Fases visibles (no se confunden):
 *   requesting  → se le pide al servidor (o se consulta su estado);
 *   preparing   → el servidor está convirtiendo: el usuario espera, no hace falta ninguna acción;
 *   downloading → el WAV está listo y se está recibiendo el archivo.
 * Al terminar la fase `downloading` el navegador YA recibió el archivo y se le inició la descarga («started»): guardar el archivo en disco no es
 * observable desde la página, así que nunca se afirma que terminó de guardarse.
 *
 * Garantías (todas probadas en tests/wav-flow.test.mjs):
 *  • un solo intento por versión (doble clic, otra pestaña de la misma pantalla o varios datos del servidor no duplican pedidos ni descargas);
 *  • solo se pide al servidor si no hay conversión en curso ni terminada; un WAV listo se baja directo y uno en curso se espera sin pedir otro;
 *  • las versiones están aisladas: el WAV que se baja es siempre el de la versión que el usuario eligió, aunque cambie la versión activa;
 *  • `dispose()` (cambio de canción o cierre de la pantalla) cancela todo: no queda ningún intento, ni descarga automática, ni notificación;
 *  • el indicador nunca queda activo indefinidamente: un vigilante (UN solo temporizador, sin pedir nada al servidor, que no es otro sondeo) corta la espera si no llegan
 *    datos nuevos durante WAV_STALL_LIMIT_MS (sin red, el sondeo se detuvo o falla) o si se supera WAV_WAIT_LIMIT_MS; con la pestaña oculta el sondeo del navegador se pausa
 *    y eso no cuenta como falla. Se cancela en `dispose()`.
 */
import type { WavStateLike } from '@/lib/capabilities';

export type WavPhase = 'requesting' | 'preparing' | 'downloading';

export interface WavIntent {
  songId: string;
  versionId: string;
  versionNumber: number;
  title: string | null;
  phase: WavPhase;
  /** Cuándo empezó el intento (ms): acota la espera total. */
  since: number;
  /** Último dato del servidor recibido (ms): detecta que el seguimiento se detuvo. */
  lastSeen: number;
}

/** Cuánto se espera a la conversión antes de dejar de acompañarla (sigue en el servidor: se descarga desde el menú cuando esté lista). */
export const WAV_WAIT_LIMIT_MS = 10 * 60_000;
/** Sin ningún dato nuevo del servidor durante este tiempo (el sondeo es cada 8 s) se deja de mostrar «preparando»: no se puede saber el estado. */
export const WAV_STALL_LIMIT_MS = 60_000;

/** Texto breve de estado de la versión mientras hay un intento en curso (null si no lo hay). Distingue preparación, recepción e inicio de descarga. */
export function wavStatusText(phase: WavPhase | null | undefined): string | null {
  if (phase === 'requesting') return 'Pidiendo el WAV…';
  if (phase === 'preparing') return 'Preparando tu WAV… puede demorar unos minutos. Se descargará solo.';
  if (phase === 'downloading') return 'Iniciando la descarga del WAV…';
  return null;
}

export type WavFlowEvent =
  | { type: 'preparing'; versionId: string; versionNumber: number }
  | { type: 'started'; versionId: string; versionNumber: number; filename: string }
  | { type: 'failed'; versionId: string; versionNumber: number; message: string | null; retryable: boolean }
  | { type: 'gave-up'; versionId: string; versionNumber: number }
  | { type: 'stalled'; versionId: string; versionNumber: number }
  | { type: 'error'; versionId: string; versionNumber: number; error: unknown };

export interface WavFlowDeps {
  /** Pide (o reabre) la conversión: devuelve el estado REAL del servidor. En la interfaz también lo escribe en la consulta de versiones. */
  requestWav: (songId: string, versionId: string) => Promise<WavStateLike>;
  /** Descarga el WAV de esa versión (resuelve cuando el navegador recibió el archivo y se inició la descarga). */
  download: (input: { songId: string; versionId: string; title: string | null; format: 'wav' }) => Promise<{ filename: string; replayed: boolean }>;
  /** Avisa a la interfaz que cambió el estado de algún intento (para volver a dibujar). */
  onChange: () => void;
  /** Eventos para los avisos al usuario (la redacción vive en la interfaz). */
  report: (event: WavFlowEvent) => void;
  now?: () => number;
  /** Programa UN aviso diferido (vigilante de espera) y devuelve cómo cancelarlo. Por omisión setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** ¿La pestaña está visible? Oculta, el navegador pausa el sondeo: no se toma como falla. Por omisión `document.visibilityState`. */
  visible?: () => boolean;
}

export interface WavRequestInput {
  songId: string;
  versionId: string;
  versionNumber: number;
  title?: string | null;
  /** Estado actual conocido de esa versión (listado de versiones). */
  wav?: WavStateLike | null;
}

type VersionLike = { id: string; wav?: WavStateLike | null };

const inProgress = (status: string | undefined) => status === 'PENDING' || status === 'PROCESSING';

export function createWavFlow(deps: WavFlowDeps) {
  const intents = new Map<string, WavIntent>();
  let disposed = false;
  const now = () => (deps.now ?? Date.now)();
  const emit = () => { if (!disposed) deps.onChange(); };
  const report = (e: WavFlowEvent) => { if (!disposed) deps.report(e); };
  const schedule = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    (id as unknown as { unref?: () => void }).unref?.(); // en Node (pruebas) el vigilante no mantiene vivo el proceso; en el navegador no aplica
    return () => clearTimeout(id);
  });
  const isVisible = deps.visible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  let cancelTimer: (() => void) | null = null;

  /** Vigilante: un solo temporizador hacia el próximo vencimiento entre los intentos en preparación (ninguno → sin temporizador). */
  function rearm() {
    cancelTimer?.();
    cancelTimer = null;
    if (disposed) return;
    let next = Infinity;
    for (const i of intents.values()) if (i.phase === 'preparing') next = Math.min(next, i.since + WAV_WAIT_LIMIT_MS, i.lastSeen + WAV_STALL_LIMIT_MS);
    if (next !== Infinity) cancelTimer = schedule(watchdog, Math.max(next - now(), 1000));
  }
  const finish = (versionId: string) => { intents.delete(versionId); emit(); rearm(); };

  function watchdog() {
    cancelTimer = null;
    if (disposed) return;
    const t = now();
    const visible = isVisible();
    for (const intent of [...intents.values()]) {
      if (intent.phase !== 'preparing') continue;
      if (t - intent.since > WAV_WAIT_LIMIT_MS) { finish(intent.versionId); report({ type: 'gave-up', ...ids(intent) }); }
      else if (!visible) intent.lastSeen = t; // pestaña oculta: el sondeo se pausa solo; no es una falla
      else if (t - intent.lastSeen >= WAV_STALL_LIMIT_MS) { finish(intent.versionId); report({ type: 'stalled', ...ids(intent) }); }
    }
    rearm();
  }
  const ids = (i: WavIntent) => ({ versionId: i.versionId, versionNumber: i.versionNumber });

  /** Fase `downloading`: se marca ANTES de esperar, así ningún otro dato del servidor ni clic vuelve a iniciarla. */
  async function beginDownload(intent: WavIntent): Promise<void> {
    if (disposed || intents.get(intent.versionId) !== intent || intent.phase === 'downloading') return;
    intent.phase = 'downloading';
    emit();
    try {
      const out = await deps.download({ songId: intent.songId, versionId: intent.versionId, title: intent.title, format: 'wav' });
      report({ type: 'started', ...ids(intent), filename: out.filename });
    } catch (error) {
      report({ type: 'error', ...ids(intent), error });
    } finally {
      if (intents.get(intent.versionId) === intent) finish(intent.versionId);
    }
  }

  return {
    /** Estado del intento de una versión (o undefined). */
    get: (versionId: string): WavIntent | undefined => intents.get(versionId),
    /** ¿Hay algún intento en curso? */
    get active(): boolean { return intents.size > 0; },

    /**
     * El usuario eligió «Descargar / Preparar WAV» de UNA versión. Con un intento ya en curso para esa versión no hace nada (doble clic).
     *  • listo → descarga directa, sin tocar la conversión;
     *  • en preparación → espera la existente, sin pedir otra (no hay tarea ni costo nuevos);
     *  • nunca pedido o fallido → se pide y se espera.
     */
    async request(input: WavRequestInput): Promise<void> {
      if (disposed || intents.has(input.versionId)) return;
      const intent: WavIntent = { songId: input.songId, versionId: input.versionId, versionNumber: input.versionNumber, title: input.title ?? null, phase: 'requesting', since: now(), lastSeen: now() };
      intents.set(input.versionId, intent);
      emit();
      try {
        let state: WavStateLike | null | undefined = input.wav;
        if (state?.status !== 'COMPLETED' && !inProgress(state?.status)) state = await deps.requestWav(input.songId, input.versionId);
        if (disposed || intents.get(input.versionId) !== intent) return;
        if (state?.status === 'COMPLETED') { await beginDownload(intent); return; }
        if (inProgress(state?.status)) {
          intent.phase = 'preparing';
          intent.lastSeen = now();
          emit();
          rearm();
          report({ type: 'preparing', ...ids(intent) });
          return;
        }
        if (state?.status === 'FAILED') {
          finish(intent.versionId);
          report({ type: 'failed', ...ids(intent), message: state.message ?? null, retryable: state.retryable !== false });
          return;
        }
        finish(intent.versionId); // NONE: el servidor no registró la conversión
        report({ type: 'error', ...ids(intent), error: new Error('El servidor no registró la conversión') });
      } catch (error) {
        if (disposed) return;
        if (intents.get(input.versionId) === intent) finish(intent.versionId);
        report({ type: 'error', ...ids(intent), error });
      }
    },

    /**
     * Llegó un dato nuevo del servidor (el listado de versiones que la pantalla ya consulta). Solo mira los intentos en `preparing`:
     * lista → descarga automática de ESA versión; fallida → se detiene; sigue en preparación → espera (con tope de tiempo).
     */
    onVersions(songId: string, versions: readonly VersionLike[]): void {
      if (disposed) return;
      for (const intent of [...intents.values()]) {
        if (intent.phase !== 'preparing') continue;
        if (intent.songId !== songId) { finish(intent.versionId); continue; } // otra canción: nunca se baja nada
        intent.lastSeen = now(); // llegó un dato del servidor: el seguimiento está vivo
        const version = versions.find((v) => v.id === intent.versionId);
        if (!version) { finish(intent.versionId); continue; } // la versión ya no está (borrada, otra pantalla)
        const status = version.wav?.status;
        if (status === 'COMPLETED') void beginDownload(intent);
        else if (status === 'FAILED') {
          finish(intent.versionId);
          report({ type: 'failed', ...ids(intent), message: version.wav?.message ?? null, retryable: version.wav?.retryable !== false });
        } else if (inProgress(status)) {
          if (now() - intent.since > WAV_WAIT_LIMIT_MS) { finish(intent.versionId); report({ type: 'gave-up', ...ids(intent) }); }
        } else {
          finish(intent.versionId); // NONE: la conversión desapareció del servidor
          report({ type: 'error', ...ids(intent), error: new Error('La conversión ya no existe') });
        }
      }
      rearm();
    },

    /** La pestaña volvió a estar visible: el sondeo se reanuda, se le da un margen nuevo antes de considerar que se detuvo. */
    touch(): void {
      if (disposed) return;
      const t = now();
      for (const i of intents.values()) if (i.phase === 'preparing') i.lastSeen = t;
      rearm();
    },

    /** Cierre de la pantalla o cambio de canción: se cancela todo (incluido el vigilante) y no se vuelve a notificar ni a descargar. */
    dispose(): void {
      disposed = true;
      cancelTimer?.();
      cancelTimer = null;
      intents.clear();
    },
  };
}

export type WavFlow = ReturnType<typeof createWavFlow>;
