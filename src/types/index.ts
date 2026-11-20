/**
 * MELODYA WEB — Tipos de dominio (espejo de los DTOs reales del backend).
 */

import type { GenerationFailure } from '../lib/generation-failure';
import type { Pricing } from '../lib/pricing';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'PRO_SESSIONIST' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED' | 'BLOCKED';
  avatarFileId: string | null;
  /** Portada del perfil (v0.19): id del archivo si el usuario subió una. */
  coverImageFileId?: string | null;
  /** Géneros musicales favoritos (v0.19, hasta 5). */
  genres?: string[];
  creditsBalance: number;
  voiceConsentAcceptedAt: string | null;
  voiceConsentVersion: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Ítem de un plan de suscripción (v0.18): check (✓) si `included`, cruz (✗) si no. */
export interface PlanFeature {
  label: string;
  included: boolean;
}

export interface SubscriptionPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  /** Precio anterior (v0.18): se muestra tachado si existe. */
  previousPriceCents: number | null;
  /** Ítems del plan (v0.18), administrados desde el backoffice. */
  features: PlanFeature[] | null;
  currency: string;
  monthlyCredits: number;
  periodDays: number;
  isActive: boolean;
  sortOrder: number;
  /** Compras históricas reales (v0.18): el plan con más compras es «Más popular». */
  purchaseCount?: number;
  /** Precio final con la promoción vigente (E7), calculado por el servidor con la misma cotización que la orden. */
  pricing?: Pricing;
  /** Plan base (Free): permanente y gratuito, lo tiene todo usuario sin una suscripción paga vigente. NO es una suscripción ni se contrata. */
  isDefault?: boolean;
  /** Capacidades del plan (todas las claves del registro; sin fila = no incluida). Las informa el servidor. */
  entitlements?: Record<string, { enabled: boolean; limit?: number } | undefined>;
}

export interface CreditPackage {
  id: string;
  code: string;
  name: string;
  description: string | null;
  credits: number;
  bonusCredits: number;
  priceCents: number;
  /** Precio anterior (v0.18): se muestra tachado si existe. */
  previousPriceCents: number | null;
  currency: string;
  isActive: boolean;
  sortOrder: number;
  /** Compras históricas reales (v0.18): el pack con más compras es «El favorito». */
  purchaseCount?: number;
  /** Precio final con la promoción vigente (E7), calculado por el servidor con la misma cotización que la orden. */
  pricing?: Pricing;
}

export interface ActiveSubscription {
  id: string;
  planId: string;
  status: 'ACTIVE' | 'CANCELED' | 'PAST_DUE';
  startsAt: string;
  currentPeriodEnd: string;
  plan: SubscriptionPlan;
  /** `true` = el usuario canceló la renovación: sigue activa hasta `currentPeriodEnd` y después vence (pasa al plan Gratis). */
  cancelAtPeriodEnd?: boolean;
  /** Cuándo se pidió la cancelación de la renovación. */
  canceledAt?: string | null;
  /** Plan al que pasará la suscripción al renovar (upgrade o downgrade programado). Hasta entonces rige `plan`. */
  pendingPlan?: { id: string; code: string; name: string } | null;
  /** Lo que ocurrirá en `effectiveAt` (= fin del período): cambio de plan programado o cancelación (vuelve al plan base). */
  scheduledChange?: ScheduledChange | null;
}

export interface ScheduledChange {
  kind: 'UPGRADE' | 'DOWNGRADE' | 'CANCELLATION';
  toPlan: { id: string; code: string; name: string } | null;
  effectiveAt: string;
}

/** Cambio de plan programado por POST /billing/mock-checkout cuando el usuario ya tiene una suscripción paga: se aplica al renovar, nunca antes. */
export interface PlanChangeResult {
  kind: 'UPGRADE' | 'DOWNGRADE';
  status: 'SCHEDULED';
  effectiveAt: string;
  fromPlan: { id: string; code: string; name: string };
  toPlan: { id: string; code: string; name: string };
  alreadyScheduled: boolean;
}

/** Referencia mínima de un plan en la cotización de un upgrade. */
export interface UpgradePlanRef { id: string; code: string; name: string; priceCents: number; monthlyCredits: number }

/** GET /billing/upgrade-quote: cotización del upgrade INMEDIATO (solo lectura). El servidor calcula todo; la web solo la muestra y envía `finalPriceCents` como `expectedFinalPriceCents`. */
export interface UpgradeQuote {
  kind: 'UPGRADE';
  immediate: true;
  currency: string;
  fromPlan: UpgradePlanRef;
  toPlan: UpgradePlanRef;
  listPriceCents: number;
  creditAppliedCents: number;
  finalPriceCents: number;
  monthlyCredits: number;
  currentPeriodEnd: string;
  newPeriodStart: string;
  nextRenewalAt: string;
  quotedAt: string;
}

/** Respuesta de POST /billing/mock-checkout: una compra (suscripción/paquete + orden), un upgrade inmediato (orden PLAN_UPGRADE y la suscripción ya con el plan nuevo; sin `change`) o un downgrade programado (`order: null` + `change`). */
export interface CheckoutResult {
  subscription?: ActiveSubscription | null;
  order?: { id: string; status: string } | null;
  change?: PlanChangeResult;
}

/** Plan efectivo del usuario: el de su suscripción paga vigente o, si no la tiene, el plan base Free (que no es una suscripción). */
export interface EffectivePlan {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  source: 'BASE' | 'SUBSCRIPTION';
}

/** Medidor de un cupo (GET /users/me/usage, E6). `limit: null` = sin tope; `used: null` = no se cuenta. */
export interface UsageMeter {
  included: boolean;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  enforced: boolean;
  tracked?: boolean;
}
/** Medidor dinámico de un cupo numérico del plan (GET /users/me/usage → meters). Lo arma el servidor con el mismo conteo y límite que el enforcement. */
export interface UsageMeterItem {
  key: string;
  /** Nombre visible de la capacidad (p. ej. «Canciones por período»). */
  name: string;
  /** Unidad en plural (p. ej. «canciones»). */
  unit: string | null;
  /** NOT_INCLUDED: no incluido (límite 0 o falta la capacidad previa) · UNLIMITED: sin tope · AVAILABLE: queda cupo · REACHED: consumo >= límite. */
  status: 'NOT_INCLUDED' | 'UNLIMITED' | 'AVAILABLE' | 'REACHED';
  included: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  enforced: boolean;
  periodStart: string;
  periodEnd: string;
  resetsAt: string;
}
export interface UsageSummary {
  effectivePlan: { id: string; code: string; name: string; isDefault: boolean } | null;
  period: { kind: 'subscription' | 'calendar'; start: string; end: string; resetsAt: string };
  /** Lista dinámica de cupos numéricos del plan (ausente en un backend anterior). */
  meters?: UsageMeterItem[];
  songs: UsageMeter;
  downloads: UsageMeter;
  clonedVoices: { used: number; limit: number | null; enforced: boolean };
}

export interface MeProfile extends PublicUser {
  avatarUrl: string | null;
  /** Portada del perfil (v0.19): banner visible en el perfil público. */
  coverImageUrl?: string | null;
  bio?: string | null;
  subscription: ActiveSubscription | null;
  /** Plan efectivo (Free si no hay suscripción paga vigente). Única fuente para mostrar «Tu plan …». */
  effectivePlan?: EffectivePlan | null;
  /** Capacidades del plan efectivo (E5). `enforced`: el servidor rechaza hoy la operación sin ella. Ver lib/capabilities. */
  entitlements?: Record<string, { enabled: boolean; limit?: number; enforced?: boolean } | undefined>;
}

export interface AuthSession {
  user?: PublicUser;
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
}

export interface Pagination {
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface Paginated<T> {
  items: T[];
  pagination: Pagination;
}

export type GenerationStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELED';

export interface GenerationInput {
  id: string;
  field: string;
  source: 'USER' | 'AI_SUGGESTED' | 'SYSTEM';
  value?: unknown;
  text?: string | null;
  sampleId?: string | null;
}

export interface GenerationJob {
  id: string;
  task: 'LYRICS' | 'MUSIC' | 'COVER';
  status: GenerationStatus;
  progress: number;
  attempts: number;
  /** Salida normalizada del job (en LYRICS completados: { title, lyrics, tags }). */
  result?: unknown;
  /** Desde cuándo el resultado del proveedor es desconocido (solo si el backend lo marcó). */
  uncertainSince?: string | null;
  error?: GenerationFailure | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Generation {
  id: string;
  userId: string;
  generationTypes: string[];
  status: GenerationStatus;
  songId: string | null;
  projectId: string | null;
  requestedTitle: string | null;
  creditsCost: number;
  providerCostCents: number | null;
  error?: GenerationFailure | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  inputs?: GenerationInput[];
  jobs?: GenerationJob[];
  song?: { id: string; title: string; currentVersionId: string | null } | null;
  project?: { id: string; name: string } | null;
  /** Solo para el dueño (E2/E3): destino original, si se puede recuperar y el vínculo de reintento. */
  target?: GenerationTarget | null;
  retry?: RetryInfo;
  retryOf?: string | null;
  retriedBy?: string | null;
}

/* ── Recuperación y reintento de generaciones fallidas (backend E2/E3) ── */

export type RecoveryTargetKind = 'NEW_SONG' | 'NEW_VERSION' | 'REMIX';
export type RecoveryTargetReason =
  | 'TRASHED' | 'DELETED' | 'NOT_AVAILABLE' | 'NOT_ALLOWED' | 'VERSION_NOT_CURRENT' | 'VERSION_UNAVAILABLE' | 'AUDIO_UNAVAILABLE' | 'AUDIO_TOO_LONG';

export interface GenerationTarget {
  kind: RecoveryTargetKind;
  songId: string | null;
  remix: { songId: string; versionId: string | null; versionNumber: number | null; mode: RemixMode | null } | null;
  /** Solo en `/recovery`. */
  status?: 'AVAILABLE' | 'UNAVAILABLE';
  reason?: RecoveryTargetReason | null;
}

export interface RetryInfo {
  allowed: boolean;
  /** COMPLETED | CANCELED | STILL_ACTIVE | OUTCOME_UNCERTAIN | NOT_MUSIC | NOT_FAILED | ALREADY_RETRIED | REMIX_ORIGIN_BLOCKED */
  reason: string | null;
  requiresEdit: boolean;
}

export interface RecoveryInput { field: string; text?: string; value?: unknown; sampleId?: string }

export type RecoveryMissingReason = 'SAMPLE_DELETED' | 'SAMPLE_IN_TRASH' | 'FILE_UNAVAILABLE' | 'VOICE_NOT_READY' | 'VOICE_EXPIRED' | 'LYRIC_PERSONA_UNAVAILABLE';

/** `GET /generations/:id/recovery`: la solicitud original reconstruida por el servidor (solo generaciones FAILED propias). */
export interface GenerationRecovery {
  generationId: string;
  status: 'FAILED';
  failure: { reasonCode: string; userMessage: string };
  retryable: { allowed: boolean; reason: string | null; requiresEdit: boolean; requiresDecision: boolean };
  target: GenerationTarget;
  destinationOptions: Array<'SAME' | 'NEW_SONG' | 'RESTORE'>;
  request: {
    inputs: RecoveryInput[];
    options: { instrumental?: boolean; generateLyricsIfMissing?: boolean };
    title?: string;
    projectId?: string;
  };
  meta: { lyrics: { origin: 'USER' | 'AI_PREVIOUS' | 'HELD' | 'NONE' } };
  /** Datos que NO se reutilizan solos (p. ej. una letra de procedencia incierta): requieren una decisión del usuario. */
  held: Array<{ field: string; text: string; reason: 'PROVENANCE_UNKNOWN' }>;
  missing: Array<{ field: string; sampleId: string | null; reason: RecoveryMissingReason }>;
  checks: Array<{ field: string; sampleId: string; endpoint: string }>;
  notes: Array<{ code: string; text: string; field?: string; reason?: string }>;
  validation: { valid: boolean; forDestination: 'SAME' | 'NEW_SONG'; issues: Array<{ path: string; message: string }> };
  credits: { previousCharged: number; previousRefunded: number; refundApplied: boolean };
}

/** Cuerpo de `POST /generations/:id/retry` (sin `clientRequestId`, que lo pone el almacén de pedidos pendientes). */
export interface RetryBody {
  request?: { inputs: Array<{ field: string; text?: string; value?: unknown; sampleId?: string }>; options?: { generateLyricsIfMissing?: boolean; instrumental?: boolean }; title?: string; projectId?: string };
  destination?: { kind: 'SAME' | 'NEW_SONG'; confirm?: boolean };
  regenerateLyrics?: boolean;
}

/** Estado de la conversión a WAV de una versión (solo lo ve su dueño). NONE = todavía no hay conversión registrada. */
export interface WavState {
  status: 'NONE' | 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  available?: boolean;
  retryable: boolean;
  errorCode?: string;
  message?: string;
  completedAt?: string;
}

export interface SongVersion {
  id: string;
  songId: string;
  versionNumber: number;
  generationId: string | null;
  title: string | null;
  lyricsText: string | null;
  lyricsSource: 'USER' | 'AI' | 'AI_EDITED' | null;
  durationSec: number | null;
  genre: string | null;
  tags: string[];
  createdAt: string;
  audioUrl: string | null;
  coverUrl?: string | null;
  /** Conversión a WAV de esta versión (solo el dueño). El archivo se baja con POST /songs/:id/versions/:versionId/download {format:'wav'}. */
  wav?: WavState;
}

/** Remix: COVER usa el audio de la versión como referencia (upload-cover); PROMPT_REUSE reutiliza letra y estilo. */
export type RemixMode = 'COVER' | 'PROMPT_REUSE';

/** Atribución de un remix. Si el original ya no es accesible llega solo `{ kind, available: false }` (nada del original). */
export interface SongOrigin {
  kind: RemixMode;
  available: boolean;
  versionNumber?: number;
  song?: { id: string; title: string; coverUrl?: string | null };
  author?: { id: string; name: string };
}

/** GET /songs/:id/remix-template: solo datos autorizados y seguros para precargar el creador. */
export interface RemixTemplate {
  source: { songId: string; versionId: string; versionNumber: number; title: string; author: { id: string; name: string } };
  isOwner: boolean;
  modes: { COVER: { available: boolean; code?: string }; PROMPT_REUSE: { available: boolean } };
  suggestedTitle: string;
  lyrics: string | null;
  /** Sin letra guardada: el creador arranca en modo instrumental (nunca inventa una letra). */
  instrumental: boolean;
  genres: string[];
  tags: string[];
  styleSummary: string | null;
}

export interface Song {
  id: string;
  deletedAt?: string | null;
  userId: string;
  projectId: string | null;
  title: string;
  coverUrl: string | null;
  visibility: 'PRIVATE' | 'PUBLIC';
  allowComments: boolean;
  /** Remix: el dueño permite que otras personas creen canciones nuevas a partir de esta (apagado por defecto). */
  allowRemix?: boolean;
  /** Remixes directos públicos y visibles para quien consulta. */
  remixCount?: number;
  /** Si la canción es un remix: de dónde salió. `null`/ausente = no es un remix. */
  origin?: SongOrigin | null;
  /** «Editar detalles»: resumen de estilos del dueño. `null`/ausente = se muestran los estilos derivados de la versión. */
  styleSummary?: string | null;
  /** «Editar detalles»: descripción de la canción. `null`/ausente = sin bloque de descripción. */
  description?: string | null;
  currentVersionId: string | null;
  completedVersionCount: number;
  likesCount: number;
  dislikesCount: number;
  playsCount: number;
  commentsCount: number;
  lastGenerationAt: string | null;
  createdAt: string;
  updatedAt: string;
  currentVersion: (SongVersion & { audioUrl: string | null }) | null;
  versions?: Array<{ id: string; versionNumber: number; createdAt: string; title: string | null }>;
}

export interface CommunitySong {
  id: string;
  title: string;
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null; followersCount?: number };
  coverUrl: string | null;
  audioUrl: string | null;
  durationSec: number | null;
  genre: string | null;
  tags: string[];
  likesCount: number;
  dislikesCount: number;
  playsCount: number;
  commentsCount: number;
  /** Remix: el dueño permite crear canciones nuevas a partir de esta. */
  allowRemix?: boolean;
  viewerReaction?: 'LIKE' | 'DISLIKE' | null;
}

export interface CommunitySongDetail extends CommunitySong {
  allowComments: boolean;
  allowRemix?: boolean;
  remixCount?: number;
  origin?: SongOrigin | null;
  description?: string | null;
  styleSummary?: string | null;
  lyrics: string | null;
  comments: Paginated<SongComment>;
  viewerIsFollowing?: boolean;
}

/** Comentario con hilo de conversación (v0.15.0): una respuesta lleva
 *  parentId + parentAuthor ("respondiendo a X"); likesCount + viewerLiked
 *  para el corazón; repliesCount solo en las raíces. */
export interface SongComment {
  id: string;
  songId: string;
  parentId?: string | null;
  parentAuthor?: { id: string; name: string } | null;
  content: string;
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null };
  likesCount?: number;
  repliesCount?: number;
  viewerLiked?: boolean;
}

/** Perfil público de creador (GET /community/users/:id). */
export interface PublicUserProfile {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** Portada del creador (v0.19): banner del perfil. */
  coverImageUrl?: string | null;
  /** Géneros musicales del creador (v0.19, hasta 5). */
  genres?: string[];
  bio: string | null;
  followersCount: number;
  followingCount: number;
  songsCount: number;
  totalPlays: number;
  totalLikes: number;
  viewerIsFollowing?: boolean;
  viewerHasBlocked?: boolean;
}

/** Tarjeta de usuario para listas de seguidos/seguidores/bloqueados. */
export interface CommunityUserCard {
  id: string;
  name: string;
  avatarUrl: string | null;
  followersCount?: number;
  viewerIsFollowing?: boolean;
}

export interface UserLyric {
  id: string;
  /** Solo en la Papelera: cuándo se envió. */
  deletedAt?: string | null;
  userId: string;
  title: string;
  lyrics: string;
  idea: string | null;
  genre: string | null;
  tags: string[];
  source: 'MANUAL' | 'AI_GENERATED';
  providerModelCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LyricPersona {
  id: string;
  deletedAt?: string | null;
  userId: string;
  name: string;
  description: string;
  lyricIds: string[];
  songIds: string[];
  createdAt: string;
  updatedAt: string;
  lyricRefs?: Array<{ id: string; title: string; genre: string | null; source: string }>;
  songRefs?: Array<{ id: string; title: string; genre: string | null }>;
}

export interface UserSample {
  id: string;
  deletedAt?: string | null;
  userId: string;
  fileId: string;
  kind: 'VOICE' | 'INSTRUMENT';
  type: string;
  name: string;
  description: string | null;
  durationSec: number | null;
  sunoPersonaId: string | null;
  sunoPersonaModel: string | null;
  tags: string[] | null;
  avatarFileId: string | null;
  avatarUrl: string | null;
  createdAt: string;
  fileUrl: string;
}

/** GET /samples/:id/voice-availability. `available: null` = no se pudo comprobar (red, timeout…): NO significa caducada. */
export interface VoiceAvailability {
  sampleId: string;
  available: boolean | null;
  checkedAt: string | null;
  cached: boolean;
  reason?: string;
}

export interface VoiceSession {
  id: string;
  userId: string;
  voiceSampleId: string | null;
  phraseTaskId: string | null;
  phrase: string | null;
  verifySampleId: string | null;
  verifyTaskId: string | null;
  voiceId: string | null;
  status: 'PHRASE_PENDING' | 'PHRASE_READY' | 'VERIFYING' | 'VOICE_PENDING' | 'READY' | 'FAILED';
  error?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  deletedAt?: string | null;
  userId: string;
  name: string;
  description: string | null;
  coverUrl?: string | null;
  songsCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreditTransaction {
  id: string;
  userId: string;
  type: 'WELCOME_GRANT' | 'PLAN_GRANT' | 'PACKAGE_PURCHASE' | 'ADMIN_ADJUSTMENT' | 'GENERATION_DEBIT' | 'GENERATION_REFUND';
  amount: number;
  balanceAfter: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface Banner {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  mobileImageUrl: string | null;
  linkUrl: string | null;
  buttonLabel: string | null;
  position: 'HERO' | 'SLIDER' | 'PROMO' | 'COMMUNITY' | 'FOOTER';
  theme: 'light' | 'dark' | null;
  sortOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  /** Promoción vinculada (E8): solo informa qué es y cuándo vence; el precio sale del catálogo, nunca del banner. */
  promotion?: { code: string; name: string; description: string | null; startsAt: string; endsAt: string | null } | null;
}

export interface Announcement {
  id: string;
  message: string;
  effect: 'SCROLL' | 'PULSE' | 'STATIC' | 'TYPE' | 'SHINE';
  linkUrl: string | null;
  linkLabel: string | null;
  bgColor: string | null;
  textColor: string | null;
  sortOrder: number;
  isActive: boolean;
}

/* ═══ Notificaciones + Denuncias (user-facing) ═══
 * v0.25.0: los tipos del panel (AdminReport, AdminUser, AdminStats…) se
 * mudaron a melodya_backoffice. La web solo crea denuncias y consume su
 * centro de notificaciones. */

/** Tipos de notificación que emite el backend (GET /notifications?type= csv). */
export type NotificationType =
  | 'NEW_FOLLOWER'
  | 'SONG_COMMENT'
  | 'COMMENT_REPLY'
  | 'COMMENT_LIKE'
  | 'SONG_LIKE'
  | 'SYSTEM';

/** Notificación del centro de actividades (GET /notifications). */
export interface AppNotification {
  id: string;
  type: NotificationType;
  /** null = no leída. */
  readAt: string | null;
  createdAt: string;
  /** Quién disparó el evento (seguidor, comentador…). null en SYSTEM. */
  actor: { id: string; name: string; avatarUrl: string | null } | null;
  /** Canción relacionada (donde pasó el comentario / me gusta). */
  song: { id: string; title: string; coverUrl: string | null } | null;
  /** Fragmento del comentario (o texto del aviso en SYSTEM). */
  commentExcerpt: string | null;
}

/** Sobre qué se puede denunciar (POST /reports). */
export type ReportTargetType = 'SONG' | 'COMMENT' | 'USER';

/** Motivos de denuncia (POST /reports). */
export type ReportReason = 'SPAM' | 'INAPPROPRIATE' | 'HARASSMENT' | 'COPYRIGHT' | 'OTHER';

/** Denuncia creada (respuesta 201 de POST /reports). */
export interface Report {
  id: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  description: string | null;
  status: 'PENDING';
  createdAt: string;
}

/* ═══ Panel de administración → migrado a melodya_backoffice (v0.25.0) ═══
 * Los tipos AdminReport / AdminUser / AdminStats / ModerationUser viven
 * ahora en el proyecto melodya_backoffice. Aquí solo queda lo user-facing:
 * denunciar contenido (Report) y el centro de notificaciones. */

export interface AssistantLyricsResult {
  title: string;
  lyrics: string;
  tags: string[];
  resolvedProvider: { code: string; model: string };
}

export interface SuggestionsResult {
  suggestions: Record<string, unknown>;
  draft: Record<string, unknown>;
  resolvedProvider?: { code: string; model: string };
}
