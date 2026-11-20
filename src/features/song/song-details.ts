/**
 * «Editar detalles de la canción»: lógica pura del formulario (sin React ni red; se prueba en tests/song-details.test.mjs).
 *
 * Son datos de PRESENTACIÓN de la canción: nombre, resumen de estilos y descripción (la portada se cambia con el diálogo de portada de
 * siempre). Nunca modifican versiones, audios ni los parámetros con los que se generó cada versión. Los límites y la normalización
 * espejan los del backend (lib/song-details.js): el servidor es la autoridad y vuelve a validar.
 */

export const DETAIL_LIMITS = { title: 120, styleSummary: 200, description: 500 } as const;

export interface DetailsDraft { title: string; styleSummary: string; description: string }
export interface DetailsSource { title: string; styleSummary?: string | null; description?: string | null }
/** Solo lo que cambió. `null` borra el valor guardado; un campo ausente no se toca. */
export interface DetailsPatch { title?: string; styleSummary?: string | null; description?: string | null }
export type DetailsErrors = Partial<Record<keyof DetailsDraft, string>>;

// Controles C0/C1, espacios de ancho cero, separadores Unicode de línea/párrafo y BOM (se conservan \n y \t).
const CONTROL_CHARS = new RegExp(
  '[' + [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0x200b, 0x200d], [0x2028, 0x2029], [0xfeff, 0xfeff]]
    .map(([a, b]) => String.fromCodePoint(a) + '-' + String.fromCodePoint(b)).join('') + ']',
  'g',
);

/** Mismo criterio que el servidor: texto plano, sin caracteres de control; una línea (resumen) o párrafos (descripción). */
export function normalizeDetail(value: string | null | undefined, multiline = false): string {
  let text = String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
  text = multiline ? text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') : text.replace(/\s+/g, ' ');
  return text.trim();
}

/** Caracteres reales (un emoji cuenta uno), como los cuenta el servidor. */
export const charCount = (value: string): number => [...value].length;

export const draftFrom = (song: DetailsSource): DetailsDraft => ({
  title: song.title,
  styleSummary: song.styleSummary ?? '',
  description: song.description ?? '',
});

export function validateDetails(draft: DetailsDraft): DetailsErrors {
  const errors: DetailsErrors = {};
  const title = normalizeDetail(draft.title);
  if (!title) errors.title = 'El nombre no puede quedar vacío.';
  else if (charCount(title) > DETAIL_LIMITS.title) errors.title = `El nombre admite hasta ${DETAIL_LIMITS.title} caracteres.`;
  if (charCount(normalizeDetail(draft.styleSummary)) > DETAIL_LIMITS.styleSummary) errors.styleSummary = `El resumen admite hasta ${DETAIL_LIMITS.styleSummary} caracteres.`;
  if (charCount(normalizeDetail(draft.description, true)) > DETAIL_LIMITS.description) errors.description = `La descripción admite hasta ${DETAIL_LIMITS.description} caracteres.`;
  return errors;
}

/** Parche mínimo para PATCH /songs/:id: solo los campos que cambiaron respecto de lo guardado. Vacío ⇒ `null` (vuelve a «sin definir»). */
export function buildDetailsPatch(song: DetailsSource, draft: DetailsDraft): DetailsPatch {
  const patch: DetailsPatch = {};
  const title = normalizeDetail(draft.title);
  if (title && title !== song.title) patch.title = title;
  const summary = normalizeDetail(draft.styleSummary) || null;
  if (summary !== (normalizeDetail(song.styleSummary) || null)) patch.styleSummary = summary;
  const description = normalizeDetail(draft.description, true) || null;
  if (description !== (normalizeDetail(song.description, true) || null)) patch.description = description;
  return patch;
}

export const hasChanges = (patch: DetailsPatch): boolean => Object.keys(patch).length > 0;

/** ¿Hay un texto para mostrar? Evita pintar bloques vacíos (null, "" o solo espacios). */
export const hasText = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/** Resumen visible: el del dueño si lo definió; si no, `null` y el cliente conserva la presentación derivada (género + etiquetas). */
export const customStyleSummary = (song: { styleSummary?: string | null }): string | null => (hasText(song.styleSummary) ? song.styleSummary.trim() : null);

/** Texto de ayuda con los estilos que se muestran mientras no haya un resumen propio. */
export function derivedStyleHint(genre: string | null | undefined, tags: readonly string[] | null | undefined): string {
  const clean = (v: string) => v.replace(/^["'\s]+|["'\s]+$/g, '');
  const parts = [...(genre ?? '').split(','), ...(tags ?? [])].map((t) => clean(t.trim())).filter(Boolean);
  return [...new Set(parts)].join(', ');
}
