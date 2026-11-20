/**
 * Extensión del archivo descargado según el `Content-Type` real de la respuesta del API.
 * El backend sirve cada audio con el MIME con que lo guardó; la extensión no se fija a mano.
 *
 * Con un `Content-Type` ausente o no contemplado NO se asume ningún formato: devuelve '' y el archivo se guarda sin
 * extensión (el contenido no se toca), en lugar de rotularlo con un formato que no está garantizado.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
};

export function audioFileExtension(contentType: string | null | undefined): string {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return EXTENSION_BY_MIME[mime] ?? '';
}

/** Nombre del archivo descargado: el título sin caracteres inválidos y la extensión según el tipo real entregado. */
export function downloadFilename(title: string | null | undefined, contentType: string | null | undefined): string {
  const base = (title ?? '').replace(/[\\/:*?"<>|\r\n]/g, '').trim() || 'cancion';
  return `${base}${audioFileExtension(contentType)}`;
}
