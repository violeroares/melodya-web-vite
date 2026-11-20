/**
 * Mide la duración de un archivo de audio en el navegador (metadatos). Devuelve `null` si no se puede medir:
 * algunos contenedores (p. ej. WebM de MediaRecorder) informan `Infinity`, y un archivo ilegible nunca resuelve.
 * Nunca estima ni inventa un valor.
 */
export function readAudioDuration(file: Blob, timeoutMs = 4000): Promise<number | null> {
  if (typeof window === 'undefined' || typeof Audio === 'undefined' || typeof URL === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}
