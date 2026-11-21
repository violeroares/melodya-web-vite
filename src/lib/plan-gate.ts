/**
 * MELODYA WEB — Funcionalidades fuera del plan: qué plan las habilita y qué se le dice al usuario. Lógica pura, sin React ni alias de módulos (se prueba con node --test).
 *
 * Reglas:
 *  • El plan requerido NO está codificado: sale del catálogo público (GET /plans), cuyos planes traen sus `entitlements`. Es el plan pago activo más barato que incluye
 *    la capacidad; si hay más de uno se mencionan todos («Creator y Pro»).
 *  • Si el catálogo no está disponible no se inventa ningún plan: el aviso es genérico y la etiqueta no muestra plan.
 *  • Una capacidad NO incluida (aviso de upgrade) no es lo mismo que un cupo agotado (límite del período): este módulo solo trata lo primero.
 *  • El plan que cuenta es el EFECTIVO vigente; un cambio programado no habilita nada antes de tiempo (eso lo decide el servidor al informar las capacidades).
 */

export interface CatalogPlanLike {
  code: string;
  name: string;
  isDefault?: boolean;
  isActive?: boolean;
  priceCents?: number | null;
  sortOrder?: number | null;
  entitlements?: Record<string, { enabled: boolean } | undefined> | null;
}

/** Nombre visible de cada funcionalidad comercial (solo texto; qué plan la habilita sale del catálogo). */
export const FEATURE_NAME: Record<string, string> = {
  LYRICS_AI: 'El Asistente de Melodya',
  LYRIC_PERSONAS: 'Los letristas personalizados',
  AUDIO_REFERENCE: 'El planeta Audio',
  PRODUCTION_CONTROLS: 'El planeta Producción',
  CREATIVITY_SETTINGS: 'El planeta Creatividad',
  VOICE_CLONING: 'Clonar tu voz',
  VOICE_COVER: 'Cantar con tu voz clonada',
  COVER_ART: 'Generar portadas con Melodya',
  DOWNLOAD_AUDIO: 'Descargar tus canciones',
  DOWNLOAD_WAV: 'Descargar tus canciones en WAV',
  SONG_REMIX: 'Remix de canciones',
};

/** Planes pagos activos que incluyen la capacidad, del más barato al más completo. */
export function plansIncluding(key: string, plans: readonly CatalogPlanLike[] | null | undefined): CatalogPlanLike[] {
  return (plans ?? [])
    .filter((p) => !p.isDefault && p.isActive !== false && p.entitlements?.[key]?.enabled === true)
    .sort((a, b) => (a.priceCents ?? 0) - (b.priceCents ?? 0) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/** El plan mínimo que habilita la capacidad (null si el catálogo no lo dice). */
export const requiredPlan = (key: string, plans: readonly CatalogPlanLike[] | null | undefined): CatalogPlanLike | null => plansIncluding(key, plans)[0] ?? null;

const joinNames = (names: string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`);

export interface UpgradeCopy {
  feature: string;
  /** Plan mínimo («Creator» / «Pro») para la etiqueta, o null si no se conoce. */
  planLabel: string | null;
  /** Todos los planes que la incluyen, del más barato al más completo. */
  planNames: string[];
  title: string;
  message: string;
}

/** Texto del aviso de upgrade de una capacidad, derivado del catálogo. */
export function upgradeCopy(key: string, plans: readonly CatalogPlanLike[] | null | undefined): UpgradeCopy {
  const feature = FEATURE_NAME[key] ?? 'Esta herramienta';
  const names = plansIncluding(key, plans).map((p) => p.name);
  if (names.length === 0) {
    return { feature, planLabel: null, planNames: [], title: 'No está incluido en tu plan', message: `${feature} no forma parte de tu plan actual. Mirá los planes de Melodya y elegí el que mejor se adapte a tu forma de crear.` };
  }
  if (names.length === 1) {
    return { feature, planLabel: names[0], planNames: names, title: `Disponible en Melodya ${names[0]}`, message: `${feature} forma parte de Melodya ${names[0]}. Descubrí todo lo que podés crear con este plan.` };
  }
  return {
    feature,
    planLabel: names[0],
    planNames: names,
    title: `Disponible en ${joinNames(names)}`,
    message: `${feature} está disponible en ${joinNames(names)}. Elegí el plan que mejor se adapte a tu forma de crear.`,
  };
}
