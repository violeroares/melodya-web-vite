/**
 * MELODYA WEB — Estado de la renovación de la suscripción y cancelación (lógica pura, sin dependencias: se prueba con node --test).
 *
 * El servidor decide todo: la web solo refleja `cancelAtPeriodEnd` / `currentPeriodEnd` / `canceledAt` de GET /users/me y de la respuesta de
 * POST /billing/subscriptions/:id/cancel. Cancelar la renovación NO termina la suscripción: sigue activa, con sus beneficios, hasta el fin del
 * período vigente; después vuelve al plan base (Free). No hay reembolso.
 */

export interface RenewalSubscription {
  id: string;
  status: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: string | null;
}

export type RenewalState =
  | { kind: 'renews'; endsOn: string; canCancel: true }
  | { kind: 'canceled'; endsOn: string; canCancel: false }
  | { kind: 'ended'; endsOn: string; canCancel: false };

/** DD/MM/AAAA con ceros (formato pedido por producto, es-AR). */
export function formatDateDMY(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Estado de renovación de una suscripción: renovable (se puede cancelar), con la renovación cancelada o ya terminada. */
export function renewalState(sub: RenewalSubscription, nowMs: number = Date.now()): RenewalState {
  const endsOn = formatDateDMY(sub.currentPeriodEnd);
  const over = sub.status !== 'ACTIVE' || new Date(sub.currentPeriodEnd).getTime() <= nowMs;
  if (over) return { kind: 'ended', endsOn, canCancel: false };
  if (sub.cancelAtPeriodEnd) return { kind: 'canceled', endsOn, canCancel: false };
  return { kind: 'renews', endsOn, canCancel: true };
}

/** Texto informativo de una suscripción con la renovación cancelada. */
export const canceledNotice = (endsOn: string): string => `Renovación cancelada. Tu plan seguirá activo hasta el ${endsOn}`;

/** Lo que explica el diálogo de confirmación antes de cancelar (todo con la fecha real del período). */
export function cancelDialogCopy(planName: string, endsOn: string): { title: string; points: string[] } {
  return {
    title: '¿Cancelar la renovación?',
    points: [
      `Tu plan ${planName} dejará de renovarse: no se hará un nuevo cobro ni se sumarán nuevas fichas del plan.`,
      `Conservás todos los beneficios del plan hasta el ${endsOn}.`,
      'No se realiza un reembolso por el período vigente.',
      `Podés seguir usando Melodya con normalidad hasta el ${endsOn}; después pasás al plan Free. No se elimina ninguna de tus canciones ni tu contenido.`,
    ],
  };
}

export type CancelOutcome = { kind: 'canceled' | 'already'; endsOn: string };

/** Qué dice el servidor tras POST …/cancel: `alreadyRequested` = ya estaba registrada (no hubo cambios). */
export function cancelOutcome(res: { subscription: RenewalSubscription; alreadyRequested?: boolean }): CancelOutcome {
  return { kind: res.alreadyRequested ? 'already' : 'canceled', endsOn: formatDateDMY(res.subscription.currentPeriodEnd) };
}

/** Códigos funcionales (`details.code`) del rechazo de la cancelación, o null si el error es otro (red, sesión, servidor…). */
export function cancelRejection(err: unknown): 'NOT_CANCELABLE' | 'CHANGED' | null {
  const e = err as { status?: unknown; details?: unknown } | null;
  if (!e || typeof e !== 'object' || e.status !== 409) return null;
  const code = (e.details as { code?: string } | undefined)?.code;
  if (code === 'SUBSCRIPTION_NOT_CANCELABLE') return 'NOT_CANCELABLE';
  if (code === 'SUBSCRIPTION_CHANGED') return 'CHANGED';
  return null;
}

/** Mensaje para el usuario ante un fallo al cancelar. `fallback` se usa para los errores que no son de este flujo (red, sesión, servidor). */
export function cancelErrorMessage(err: unknown, fallback: string): string {
  const rejection = cancelRejection(err);
  if (rejection === 'NOT_CANCELABLE') return 'Tu suscripción ya terminó y no admite cancelación. Actualizamos tu estado.';
  if (rejection === 'CHANGED') return 'Tu suscripción cambió mientras se procesaba la cancelación. Revisá su estado e intentá de nuevo.';
  const e = err as { status?: unknown } | null;
  if (e && typeof e === 'object' && e.status === 404) return 'No encontramos esa suscripción. Actualizamos tu estado.';
  return fallback;
}

export interface PlanPriceFields {
  priceCents?: number | null;
  currency?: string | null;
  periodDays?: number | null;
}

/**
 * Precio y periodicidad de la suscripción tal como los informa el servidor (`plan.priceCents`, `currency`, `periodDays`). Si falta el precio o la
 * moneda no se muestra nada (no se inventa un valor); si falta solo la periodicidad se muestra el precio sin «/ mes».
 */
export function planPriceParts(plan: PlanPriceFields | null | undefined): { cents: number; currency: string; period: string | null } | null {
  if (!plan || typeof plan.priceCents !== 'number' || !plan.currency) return null;
  const days = typeof plan.periodDays === 'number' && plan.periodDays > 0 ? plan.periodDays : null;
  return { cents: plan.priceCents, currency: plan.currency, period: days === null ? null : days === 30 ? 'mes' : `${days} días` };
}

/* ───────────── Plan efectivo, cambios de plan programados y reanudación ─────────────
 * Free es el plan BASE: lo tiene todo usuario sin una suscripción paga vigente y NO es una suscripción. El servidor decide todo (plan efectivo, tipo de
 * cambio, fecha); acá solo se elige qué mostrar. Un cambio programado nunca se presenta como vigente antes de su fecha. */

export interface PlanLike { id: string; isDefault?: boolean; priceCents?: number | null }
export interface PlanRoleContext {
  effectivePlan?: { id: string; isDefault: boolean } | null;
  subscription?: { status: string; plan: { id: string; priceCents?: number | null }; pendingPlan?: { id: string } | null } | null;
}

/** Qué es cada plan del catálogo para ESTE usuario. */
export type PlanRole =
  | 'base-current' // plan base y es el plan efectivo
  | 'base' // plan base, pero el usuario tiene una suscripción paga
  | 'current' // la suscripción paga vigente
  | 'scheduled' // destino de un cambio programado (todavía no rige)
  | 'subscribe' // sin suscripción paga: se puede contratar
  | 'upgrade' // con suscripción paga de menor precio
  | 'downgrade'; // con suscripción paga de mayor precio

export function planRole(plan: PlanLike, ctx: PlanRoleContext): PlanRole {
  if (plan.isDefault) return ctx.effectivePlan?.isDefault ? 'base-current' : 'base';
  const sub = ctx.subscription;
  if (!sub || sub.status !== 'ACTIVE') return 'subscribe';
  if (plan.id === sub.plan.id) return 'current';
  if (sub.pendingPlan?.id === plan.id) return 'scheduled';
  return (plan.priceCents ?? 0) > (sub.plan.priceCents ?? 0) ? 'upgrade' : 'downgrade';
}

/** «Tu plan Free» / «Tu plan Creator». */
export const planTitle = (plan: { name: string } | null | undefined): string => (plan ? `Tu plan ${plan.name}` : 'Tu plan');

/** Texto del botón de un plan según su rol (null = sin botón). */
export function planCtaLabel(role: PlanRole, planName: string): string | null {
  switch (role) {
    case 'subscribe': return 'Suscribirme';
    case 'upgrade': return `Comprar ${planName} ahora`; // el upgrade se aplica de inmediato (E8)
    case 'downgrade': return `Cambiar a ${planName}`;
    default: return null;
  }
}

/** Confirmación antes de PROGRAMAR un downgrade: deja claro qué rige hoy, qué regirá y desde cuándo. (El upgrade es inmediato: ver upgradeDialogCopy.) */
export function changeDialogCopy(_kind: 'DOWNGRADE', currentName: string, targetName: string, endsOn: string): { title: string; points: string[] } {
  return {
    title: `¿Cambiar a ${targetName}?`,
    points: [
      `Hoy seguís con ${currentName}, con todos sus beneficios, hasta el ${endsOn}.`,
      `Desde el ${endsOn} tu suscripción pasa a ${targetName} y se acreditan las fichas de ese plan.`,
      'No se cobra nada ahora ni se prorratea: el cambio se aplica en el próximo período.',
      'Podés deshacerlo antes de esa fecha.',
    ],
  };
}

/* ───────────── Upgrade inmediato (cotización del servidor) ───────────── */

export interface UpgradeQuoteLike {
  currency: string;
  fromPlan: { name: string };
  toPlan: { name: string };
  listPriceCents: number;
  creditAppliedCents: number;
  finalPriceCents: number;
  monthlyCredits: number;
  nextRenewalAt: string;
}

export interface UpgradeDialogCopy { title: string; rows: Array<{ label: string; value: string; strong?: boolean }>; points: string[] }

/** Contenido de la confirmación del upgrade inmediato. Todos los importes y fechas salen de la cotización del servidor: la web no calcula nada. */
export function upgradeDialogCopy(quote: UpgradeQuoteLike, formatMoney: (cents: number, currency: string) => string): UpgradeDialogCopy {
  const to = quote.toPlan.name;
  const from = quote.fromPlan.name;
  const rows: UpgradeDialogCopy['rows'] = [{ label: `Precio de ${to}`, value: formatMoney(quote.listPriceCents, quote.currency) }];
  if (quote.creditAppliedCents > 0) rows.push({ label: `Crédito por tu ${from} sin usar`, value: `−${formatMoney(quote.creditAppliedCents, quote.currency)}` });
  rows.push({ label: 'Pagás ahora', value: formatMoney(quote.finalPriceCents, quote.currency), strong: true });
  return {
    title: `¿Comprar ${to} ahora?`,
    rows,
    points: [
      `${to} se activa de inmediato, con todos sus beneficios.`,
      `Empieza un nuevo período mensual hoy: se acreditan ${quote.monthlyCredits.toLocaleString('es-AR')} fichas de ${to} y se reemplazan las fichas mensuales que te queden de ${from}. Tus fichas permanentes se conservan.`,
      `Próxima renovación: ${formatDateDMY(quote.nextRenewalAt)}.`,
    ],
  };
}

/** Texto del botón de confirmación del upgrade. */
export const upgradeConfirmLabel = (planName: string): string => `Comprar ${planName} ahora`;

/** Aviso tras un upgrade aplicado: el plan nuevo ya está activo (nunca se anuncia como cambio programado). */
export function upgradeAppliedNotice(sub: { plan?: { name: string } | null; currentPeriodEnd?: string | null } | null | undefined, credits: number, fallbackName: string): { title: string; description: string } {
  const name = sub?.plan?.name ?? fallbackName;
  const renewal = formatDateDMY(sub?.currentPeriodEnd);
  return {
    title: `¡${name} activo!`,
    description: `Sumaste ${credits.toLocaleString('es-AR')} fichas de tu plan ${name}.${renewal ? ` Próxima renovación: ${renewal}.` : ''}`,
  };
}

/** Mensaje para el usuario cuando no se puede cotizar el upgrade (409 UPGRADE_NOT_AVAILABLE con su motivo) o falla la consulta. */
export function upgradeQuoteErrorMessage(err: unknown): string {
  const e = err as { status?: unknown; details?: unknown } | null;
  if (e && typeof e === 'object' && e.status === 409) {
    const d = e.details as { code?: string; reason?: string } | undefined;
    if (d?.code === 'UPGRADE_NOT_AVAILABLE') {
      if (d.reason === 'PAYMENT_PENDING') return 'Tenés un pago pendiente. Resolvelo antes de mejorar tu plan.';
      if (d.reason === 'PERIOD_ENDED') return 'Tu período se está renovando. Probá de nuevo en unos segundos.';
      return 'Por ahora no podés mejorar tu plan desde acá.';
    }
  }
  return 'No pudimos cotizar el upgrade. Probá de nuevo en unos segundos.';
}

export interface ScheduledChangeLike { kind: 'UPGRADE' | 'DOWNGRADE' | 'CANCELLATION'; toPlan: { name: string } | null; effectiveAt: string }

/** Lo que se muestra de un cambio programado o una cancelación: plan vigente, cambio futuro, fecha y qué pasará ese día. */
export function scheduledChangeView(change: ScheduledChangeLike | null | undefined, currentName: string): { current: string; future: string; what: string; date: string } | null {
  if (!change) return null;
  const date = formatDateDMY(change.effectiveAt);
  const target = change.toPlan?.name ?? 'Free';
  const current = `Plan vigente: ${currentName}`;
  const future = `Desde el ${date}: ${target}`;
  if (change.kind === 'CANCELLATION') {
    return { current, future, date, what: `Ese día termina tu suscripción y volvés al plan ${target}. Conservás tus canciones y todo tu contenido.` };
  }
  return { current, future, date, what: `Ese día tu suscripción pasa a ${target} y se acreditan las fichas de ese plan. Hasta entonces conservás ${currentName}.` };
}

/** Aviso tras POST /billing/mock-checkout cuando el servidor programó un cambio (nunca se anuncia como ya aplicado). */
export function changeScheduledNotice(change: { kind: 'UPGRADE' | 'DOWNGRADE'; effectiveAt: string; toPlan: { name: string }; fromPlan: { name: string }; alreadyScheduled?: boolean }): { title: string; description: string } {
  const date = formatDateDMY(change.effectiveAt);
  return {
    title: change.alreadyScheduled ? 'El cambio ya estaba programado' : 'Cambio de plan programado',
    description: `Seguís con ${change.fromPlan.name} hasta el ${date}. Desde ese día pasás a ${change.toPlan.name}.`,
  };
}

/** Aviso tras POST …/resume. */
export function resumeNotice(res: { alreadyActive?: boolean; resumed?: 'CANCELLATION' | 'PLAN_CHANGE' | null }): { title: string; description: string } {
  if (res.alreadyActive || !res.resumed) return { title: 'No había nada para deshacer', description: 'Tu suscripción ya se renueva con normalidad.' };
  return res.resumed === 'CANCELLATION'
    ? { title: 'Renovación reactivada', description: 'Tu suscripción se renovará con normalidad.' }
    : { title: 'Cambio de plan deshecho', description: 'Seguís con tu plan actual y se renovará con normalidad.' };
}

/* ───────────── Capacidades y límites del plan ───────────── */

export interface PlanEntitlementLike { enabled: boolean; limit?: number }
export interface PlanLine { key: string; label: string; included: boolean; detail: string | null }

const BOOLEAN_LINES: Array<[string, string]> = [
  ['COVER_ART', 'Portadas para tus canciones'],
  ['LYRICS_AI', 'Asistente de letras de Melodya'],
  ['LYRIC_PERSONAS', 'Letristas personalizados'],
  ['AUDIO_REFERENCE', 'Audio de referencia'],
  ['PRODUCTION_CONTROLS', 'Planeta Producción'],
  ['CREATIVITY_SETTINGS', 'Planeta Creatividad'],
  ['VOICE_CLONING', 'Clonar tu voz'],
  ['VOICE_COVER', 'Cantar con tu voz clonada'],
];

/** Capacidades y límites de un plan, tal como los informa el servidor (sin fila = no incluida). Solo funciones que existen hoy. */
export function planCapabilityLines(entitlements: Record<string, PlanEntitlementLike | undefined> | null | undefined): PlanLine[] {
  const get = (k: string) => entitlements?.[k];
  const songs = get('SONGS_PER_PERIOD');
  const downloads = get('DOWNLOADS_PER_PERIOD');
  const mp3 = get('DOWNLOAD_AUDIO');
  const songsIncluded = Boolean(songs?.enabled) && (songs?.limit == null || songs.limit > 0);
  const downloadsIncluded = Boolean(mp3?.enabled) && Boolean(downloads?.enabled) && (downloads?.limit == null || downloads.limit > 0);
  const lines: PlanLine[] = [
    { key: 'SONGS_PER_PERIOD', label: 'Canciones por mes', included: songsIncluded, detail: songsIncluded ? (songs?.limit == null ? 'sin tope' : String(songs.limit)) : null },
    { key: 'DOWNLOADS_PER_PERIOD', label: 'Descargas de audio (MP3) por mes', included: downloadsIncluded, detail: downloadsIncluded ? (downloads?.limit == null ? 'sin tope' : String(downloads.limit)) : null },
  ];
  for (const [key, label] of BOOLEAN_LINES) lines.push({ key, label, included: Boolean(get(key)?.enabled), detail: null });
  return lines;
}
