
/**
 * MELODYA WEB — Compartir nativo (Web Share API) con fallback a portapapeles.
 * CLIENT-ONLY: no toca ningún endpoint, es una capacidad del navegador.
 */

export type ShareOutcome = 'shared' | 'copied' | 'failed';

/**
 * Copiado legacy (textarea + execCommand): funciona sin la API de clipboard
 * (contextos no seguros o sin permiso) mientras haya un gesto del usuario.
 */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Comparte {title, text, url} con el diálogo nativo del SO si está disponible
 * (mobile/desktop con Web Share API). Si no, copia al portapapeles.
 */
export async function shareContent(opts: { title: string; text?: string; url: string }): Promise<ShareOutcome> {
  const { title, text, url } = opts;

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text: text ? `${text}\n${url}` : url, url });
      return 'shared';
    } catch (err) {
      // AbortError = el usuario cerró el diálogo: no es un error real.
      if (err instanceof DOMException && err.name === 'AbortError') return 'failed';
      // Otros errores de share → probamos con el portapapeles.
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return 'copied';
    } catch {
      // seguimos con el fallback legacy abajo
    }
  }
  return legacyCopy(url) ? 'copied' : 'failed';
}
