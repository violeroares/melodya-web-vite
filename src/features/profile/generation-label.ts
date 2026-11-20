/**
 * Etiquetas de cara al usuario de una generación (Mi Perfil → Actividad), a partir de `Generation.generationTypes`.
 *
 * Esa lista guarda TODAS las modalidades del pedido (backend: generation.service → inferGenerationTypes), así que una
 * combinación se puede mostrar completa. Solo se traducen los valores que el código confirma; cualquier otro se omite
 * y nunca se muestra tal cual (son códigos internos). No se infiere nada que la lista no diga: p. ej. si se generó o no
 * una letra, porque `generationTypes` no lo registra para las canciones.
 */

/** Etiqueta por modalidad confirmada, en el orden en que se muestran (canción primero, luego sus variantes). */
const LABELS: ReadonlyArray<readonly [type: string, label: string]> = [
  ['TEXT_PROMPT', 'Creación de canción'],
  ['MELODY_REF', 'Con melodía de referencia'],
  ['BEATBOX_RHYTHM', 'Con ritmo de referencia'],
  ['VOICE_COVER', 'Con tu voz'],
  ['COVER', 'Creación de portada'],
];

/** Texto cuando la lista no trae ninguna modalidad reconocida. */
export const GENERIC_GENERATION_LABEL = 'Generación';

/** Etiquetas sin repetir y en orden fijo; nunca devuelve una lista vacía ni un código interno. */
export function generationLabels(generationTypes: unknown): string[] {
  const present = new Set(Array.isArray(generationTypes) ? generationTypes.filter((t): t is string => typeof t === 'string') : []);
  const labels = LABELS.filter(([type]) => present.has(type)).map(([, label]) => label);
  return labels.length > 0 ? labels : [GENERIC_GENERATION_LABEL];
}
