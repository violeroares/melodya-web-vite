/**
 * Carga incremental de generaciones (Mi Perfil → Actividad): funciones puras sobre la paginación de GET /generations
 * ({ page, pages }), con el mismo criterio que el historial de fichas de PricingView.
 */

/** Página siguiente a pedir, o `undefined` si la última cargada ya es la última que hay. */
export function nextGenerationPage(last: { page: number; pages: number }): number | undefined {
  return last.page < last.pages ? last.page + 1 : undefined;
}

/**
 * Une las páginas cargadas conservando el orden (más recientes primero) y sin repetir ids: si entra una generación
 * nueva mientras se pagina, el desplazamiento del offset puede traer de nuevo una fila ya mostrada.
 */
export function flattenGenerationPages<T extends { id: string }>(pages: ReadonlyArray<{ items: readonly T[] }> | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}
