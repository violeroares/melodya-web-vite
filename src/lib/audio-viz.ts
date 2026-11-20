/**
 * MELODYA WEB — grafo de audio para el visualizador (CLIENT-ONLY).
 *
 * Web Audio API: AnalyserNode conectado al <audio> persistente del player.
 * • createMediaElementSource() solo puede llamarse UNA vez por elemento:
 *   el grafo se crea la primera vez que el usuario activa el visualizador
 *   (su clic sirve de gesto → AudioContext.resume() sin bloqueo).
 * • A partir de ahí el audio "fluye" por el contexto: si el contexto queda
 *   suspendido el sonido se corta → ensureAudioRunning() se llama en cada
 *   play/toggle del store como seguro.
 * • El <audio> del PlayerBar nace con crossOrigin="anonymous": el stream se
 *   pide en modo CORS (mismo origen o API remota con
 *   Access-Control-Allow-Origin) y el grafo puede leer la señal. Sin eso,
 *   un recurso cross-origin "tainted" devuelve ceros y SILENCIA el audio.
 */

let audioCtx: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let sourceNode: MediaElementAudioSourceNode | null = null;

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** Crea (una sola vez) el grafo y devuelve el analyser, o null si no se pudo. */
export function ensureAnalyser(el: HTMLAudioElement | null): AnalyserNode | null {
  if (typeof window === 'undefined' || !el) return null;
  try {
    if (!audioCtx) {
      const w = window as AudioWindow;
      const Ctx = window.AudioContext ?? w.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    if (!sourceNode) {
      sourceNode = audioCtx.createMediaElementSource(el);
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 128;
      analyserNode.smoothingTimeConstant = 0.78;
      sourceNode.connect(analyserNode);
      analyserNode.connect(audioCtx.destination);
    }
    return analyserNode;
  } catch {
    return null;
  }
}

/** Reanuda el contexto si el grafo ya existe (barato; no-op si no existe). */
export function ensureAudioRunning() {
  if (audioCtx && audioCtx.state === 'suspended') void audioCtx.resume();
}

/** El analyser si el grafo ya fue creado (para dibujar sin re-crear). */
export function getAnalyser(): AnalyserNode | null {
  return analyserNode;
}
