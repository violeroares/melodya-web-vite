/**
 * MELODYA WEB — APIs por dominio (solo endpoints reales del backend).
 */
import { getData, postData, postDataWithStatus, patchData, deleteData, client } from './client';
import type {
  AuthSession, PublicUser, MeProfile, Paginated, Generation, Song, SongVersion, CommunitySong,
  CommunitySongDetail, SongComment, UserLyric, LyricPersona, UserSample, VoiceSession, VoiceAvailability, Project,
  CreditTransaction, SubscriptionPlan, CreditPackage, Banner, Announcement, WavState, RemixMode, RemixTemplate, GenerationRecovery, RetryBody,
  SuggestionsResult, PublicUserProfile, CommunityUserCard, AppNotification, NotificationType,
  Report, ReportReason, ReportTargetType, UsageSummary, ActiveSubscription, CheckoutResult, UpgradeQuote,
} from '@/types';

/* ── Auth ── */
export interface ChangePasswordResult {
  ok: true;
  sessionRenewed: boolean;
  accessToken?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  sessionId?: string;
}

export const authApi = {
  register: (body: { email: string; password: string; name: string }) => postData<AuthSession>('/auth/register', body),
  login: (body: { email: string; password: string }) => postData<AuthSession>('/auth/login', body),
  refresh: (refreshToken: string) => postData<AuthSession>('/auth/refresh', { refreshToken }),
  logout: (refreshToken?: string) => postData<{ ok: true }>('/auth/logout', refreshToken ? { refreshToken } : {}),
  logoutAll: () => postData<{ ok: true }>('/auth/logout-all', {}),
  /** Respuesta siempre `{ ok: true }` (no revela si el email existe). `resetToken` solo llega en desarrollo con AUTH_EXPOSE_RESET_TOKEN. */
  forgot: (email: string) => postData<{ ok: true; resetToken?: string }>('/auth/forgot-password', { email }),
  reset: (body: { token: string; password: string }) => postData<{ ok: true }>('/auth/reset-password', body),
  /* Con `refreshToken` el dispositivo actual recibe una sesión nueva (sessionRenewed); sin él (o inválido) se cierran TODAS las sesiones. */
  changePassword: (body: { currentPassword: string; newPassword: string; refreshToken?: string }) =>
    postData<ChangePasswordResult>('/auth/change-password', body),
};

/* ── Perfil ── */
export const profileApi = {
  me: () => getData<MeProfile>('/users/me'),
  /** Consumo y renovación de cupos (E6). */
  usage: () => getData<UsageSummary>('/users/me/usage'),
  update: (body: { name?: string; bio?: string | null; genres?: string[] }) => patchData<MeProfile>('/users/me', body),
  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client.post('/users/me/avatar', form, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data.data as MeProfile);
  },
  /** v0.19 — portada del perfil (banner público). */
  uploadCover: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client.post('/users/me/cover', form, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data.data as MeProfile);
  },
  removeCover: () => client.delete('/users/me/cover').then((r) => r.data.data as MeProfile),
  acceptVoiceConsent: (version?: string) =>
    postData<{ acceptedAt: string; version: string }>('/users/me/voice-consent', { accepted: true, version }),
  follow: (id: string) => postData<{ following: boolean; followersCount?: number }>(`/users/${id}/follow`),
  unfollow: (id: string) => deleteData<{ following: boolean; followersCount?: number }>(`/users/${id}/follow`),
  /** v0.15.0 — bloqueos estilo Instagram (rompen follows mutuos + ocultan contenido). */
  block: (id: string) => postData<{ blocked: boolean }>(`/users/${id}/block`),
  unblock: (id: string) => deleteData<{ blocked: boolean }>(`/users/${id}/block`),
  blocks: () => getData<{ items: CommunityUserCard[] }>('/users/me/blocks'),
};

/* ── Fichas / Billing ── */
export const billingApi = {
  balance: () => getData<{ balance: number }>('/credits'),
  transactions: (params?: { page?: number; pageSize?: number; type?: string }) =>
    getData<Paginated<CreditTransaction>>('/credits/transactions', params),
  /** `serverTime`: la hora del servidor, para que el vencimiento de una promoción no dependa del reloj del navegador. */
  plans: () => getData<{ items: SubscriptionPlan[]; serverTime?: string }>('/plans'),
  packages: () => getData<{ items: CreditPackage[]; serverTime?: string }>('/plans/credit-packages'),
  /** `expectedFinalPriceCents`: el importe que el usuario vio, solo para detectar desfasajes (409 PRICE_CHANGED). El servidor nunca lo usa como importe. */
  mockCheckout: (body: ({ type: 'PLAN'; planId: string } | { type: 'PACKAGE'; packageId: string }) & { expectedFinalPriceCents?: number }) =>
    postData<CheckoutResult>('/billing/mock-checkout', body),
  /** Cotización del upgrade inmediato al plan `planId` (solo lectura; 409 UPGRADE_NOT_AVAILABLE con `details.reason` si no corresponde). La compra la recalcula y valida. */
  upgradeQuote: (planId: string) => getData<UpgradeQuote>('/billing/upgrade-quote', { planId }),
  /** Deshace la cancelación pedida o el cambio de plan programado de la propia suscripción (antes de que se aplique). Idempotente: `alreadyActive`. */
  resumeSubscription: (subscriptionId: string) =>
    postData<{ subscription: ActiveSubscription; alreadyActive: boolean; resumed: 'CANCELLATION' | 'PLAN_CHANGE' | null }>(`/billing/subscriptions/${encodeURIComponent(subscriptionId)}/resume`, {}),
  /** Cancela la RENOVACIÓN de la propia suscripción (sigue vigente hasta el fin del período; sin reembolso). Idempotente: `alreadyRequested`. */
  cancelRenewal: (subscriptionId: string) =>
    postData<{ subscription: ActiveSubscription; alreadyRequested: boolean }>(`/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {}),
};

/* ── Samples / Voces ── */
export const samplesApi = {
  /** `cloned`: true = solo voces clonadas, false = solo muestras sin voz clonada. El backend nunca incluye las grabaciones de verificación. */
  list: (params?: { page?: number; pageSize?: number; kind?: 'VOICE' | 'INSTRUMENT'; type?: string; cloned?: boolean }) =>
    getData<Paginated<UserSample>>('/samples', params),
  get: (id: string) => getData<UserSample>(`/samples/${id}`),
  create: (
    file: File,
    meta: { type: string; name: string; description?: string; durationSec?: number; tags?: string[]; purpose?: 'VOICE_VERIFICATION' },
  ) => {
    const form = new FormData();
    form.append('file', file);
    form.append('type', meta.type);
    form.append('name', meta.name);
    if (meta.description) form.append('description', meta.description);
    if (meta.durationSec) form.append('durationSec', String(meta.durationSec));
    if (meta.tags?.length) form.append('tags', JSON.stringify(meta.tags));
    if (meta.purpose) form.append('purpose', meta.purpose);
    return client.post('/samples', form, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data.data as UserSample);
  },
  /** PATCH /samples/:id — nombre / descripción / tipo / tags de estilo (backend v0.14.2). */
  update: (id: string, body: { name?: string; description?: string | null; type?: string; tags?: string[] }) =>
    patchData<UserSample>(`/samples/${id}`, body),
  /** POST /samples/:id/avatar — avatar de la voz clonada (imagen ≤ 5 MB). */
  setAvatar: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client
      .post(`/samples/${id}/avatar`, form, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((r) => r.data.data as UserSample);
  },
  remove: (id: string) => deleteData<{ ok: true }>(`/samples/${id}`),
  /** Papelera (borrado lógico): samples enviados a la Papelera. */
  trash: (params?: { page?: number; pageSize?: number }) => getData<Paginated<UserSample>>('/samples/trash', params),
  /** Restaura desde la Papelera (idempotente). No reconstruye nada. */
  restore: (id: string) => postData<UserSample>(`/samples/${id}/restore`, {}),
  /** DELETE /samples/:id/voice — quita la voz clonada y CONSERVA la grabación (vuelve a estar sin clonar). No borra la voz en Suno. */
  removeVoice: (id: string) => deleteData<UserSample>(`/samples/${id}/voice`),
  /** GET /samples/:id/voice-availability — ¿sigue disponible la voz clonada? `available: null` = no se pudo comprobar (no es «caducada»). */
  voiceAvailability: (id: string) => getData<VoiceAvailability>(`/samples/${id}/voice-availability`),
};

export type SingerSkillLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'PROFESSIONAL';

export const voiceSessionsApi = {
  list: (params?: { page?: number; pageSize?: number }) => getData<Paginated<VoiceSession>>('/voice-sessions', params),
  /** `recreate: true` = recrear una voz caducada con la MISMA muestra original (la voz actual se reemplaza al confirmarse la nueva). */
  create: (sampleId: string, opts?: { recreate?: boolean }) =>
    postData<{ alreadyRegistered: boolean; voiceId?: string | null; session: VoiceSession | null; sample?: UserSample }>('/voice-sessions', { sampleId, ...(opts?.recreate ? { recreate: true } : {}) }),
  get: (id: string) => getData<VoiceSession>(`/voice-sessions/${id}`),
  /** verify con los detalles de la voz (backend v0.14.2): además del sampleId
   *  de la grabación, se pasan name/description/style/singerSkillLevel a Suno. */
  verify: (
    id: string,
    body: { sampleId: string; name?: string; description?: string; style?: string; singerSkillLevel?: SingerSkillLevel },
  ) => postData<VoiceSession>(`/voice-sessions/${id}/verify`, body),
  /** DELETE /voice-sessions/:id — descarta una sesión propia FAILED o PHRASE_READY (otro estado: 422 SESSION_NOT_DELETABLE; cambió en el medio: 409 SESSION_CHANGED). */
  remove: (id: string) => deleteData<{ ok: true }>(`/voice-sessions/${id}`),
};

/* ── Generaciones ── */
export interface GenerationInputPayload {
  field: string;
  source?: 'USER' | 'AI_SUGGESTED' | 'SYSTEM';
  value?: string | number | boolean | Array<string | number> | Record<string, unknown>;
  text?: string;
  sampleId?: string;
}

export const generationApi = {
  create: (body: {
    inputs: GenerationInputPayload[];
    songId?: string;
    /** Remix: canción NUEVA a partir de otra (excluyente con songId). El servidor valida el permiso y firma el audio del Cover. */
    remix?: { songId: string; versionId?: string; mode: RemixMode };
    projectId?: string;
    title?: string;
    options?: { generateLyricsIfMissing?: boolean; instrumental?: boolean; requestCover?: boolean };
    clientRequestId?: string;
  }) => postData<Generation>('/generations', body),
  createCover: (body: { songId: string; versionId?: string; prompt?: string; style?: string; clientRequestId?: string }) =>
    postData<Generation>('/generations/cover', body),
  /** `retried: 'false'` ⇒ solo el ÚLTIMO intento de cada cadena (las generaciones sin reintento posterior). */
  list: (params?: { page?: number; pageSize?: number; status?: string; retried?: 'false' }) => getData<Paginated<Generation>>('/generations', params),
  get: (id: string) => getData<Generation>(`/generations/${id}`),
  cancel: (id: string) => postData<Generation>(`/generations/${id}/cancel`),
  /** Solicitud original reconstruida por el servidor (solo generaciones FAILED propias; solo lectura, no llama a ningún proveedor). */
  recovery: (id: string, opts?: { regenerateLyrics?: boolean }) =>
    getData<GenerationRecovery>(`/generations/${id}/recovery`, opts?.regenerateLyrics ? { regenerateLyrics: 'true' } : undefined),
  /** «Editar y reintentar». 404 GENERATION_RETRY_DISABLED si la función está apagada; 409 RETRY_ALREADY_EXISTS (details.retriedBy) si ya se reintentó. */
  retry: (id: string, body: RetryBody & { clientRequestId: string }) => postData<Generation>(`/generations/${id}/retry`, body),
  /** Resuelve una solicitud de resultado incierto por su clave (solo lectura). Un 404 no garantiza que no se esté procesando. */
  byRequest: (clientRequestId: string) => getData<Generation>(`/generations/by-request/${encodeURIComponent(clientRequestId)}`),
};

/* ── Asistente ── */
export interface AssistantLyricsRequest {
    /** Obligatoria al generar; en modo mejorar (existingLyrics) es opcional. */
    idea?: string;
    genre?: string;
    energy?: string;
    structure?: string[];
    language?: string;
    lyricPersonaId?: string;
    /** Tono emocional (alegre, nostálgica…). */
    tone?: string;
    /** Duración aproximada en segundos (30–360). */
    durationSec?: number;
    /** Nombres, palabras o frases que deben aparecer en la letra. */
    mustInclude?: string;
    /** Modo MEJORAR: letra existente a editar (viaja aparte de la idea). */
    existingLyrics?: string;
    /** Modo MEJORAR: título actual (el backend lo conserva). */
    existingTitle?: string;
    /** Modo MEJORAR: cambio pedido por el usuario. */
    instruction?: string;
}

export const assistantApi = {
  suggestions: (body: { draft: Record<string, unknown>; missing?: string[] }) => postData<SuggestionsResult>('/assistant/suggestions', body),
  /**
   * POST /assistant/lyrics con `Idempotency-Key` (contrato E9). Devuelve el estado HTTP porque 200 y 202 significan
   * cosas distintas: un 202 NO trae letra (operación en curso o incierta). La clave la decide el llamador y debe
   * mantenerse estable en los reintentos de la misma acción (ver lib/assistant-lyrics/flow).
   * `replayOnlyOnAuth401`: el interceptor no repite este POST ante un 401 reenviado por el proveedor.
   */
  lyricsAttempt: (body: AssistantLyricsRequest, idempotencyKey: string) =>
    postDataWithStatus<unknown>('/assistant/lyrics', body, {
      headers: { 'Idempotency-Key': idempotencyKey },
      replayOnlyOnAuth401: true,
    }),
};

/* ── Canciones (biblioteca) ── */
export const songsApi = {
  list: (params?: { page?: number; pageSize?: number }) => getData<Paginated<Song>>('/songs', params),
  get: (id: string) => getData<Song>(`/songs/${id}`),
  versions: (id: string) => getData<{ items: SongVersion[] }>(`/songs/${id}/versions`),
  /** Plantilla de remix: letra y estilo públicos + título sugerido. `version` solo lo puede elegir el dueño. */
  remixTemplate: (id: string, version?: string | null) => getData<RemixTemplate>(`/songs/${id}/remix-template`, version ? { version } : undefined),
  /** Reabre la conversión a WAV de una versión propia (fallida) o la solicita si nunca existió. La conversión normal es automática. */
  retryWav: (id: string, versionId: string) => postData<WavState>(`/songs/${id}/versions/${versionId}/wav/retry`, {}),
  /** PATCH /songs/:id. `styleSummary` / `description` («Editar detalles»): `null` los borra; omitirlos los deja igual. */
  update: (id: string, body: { title?: string; visibility?: 'PRIVATE' | 'PUBLIC'; currentVersionId?: string; projectId?: string | null; styleSummary?: string | null; description?: string | null }) =>
    patchData<Song>(`/songs/${id}`, body),
  /** POST /songs/:id/cover — subir portada propia (multipart).
   *  El backend lo expone (song.service.setCover): cambia SOLO la portada general; las de las versiones no se tocan. */
  uploadCover: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client.post(`/songs/${id}/cover`, form, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data.data as Song);
  },
  remove: (id: string) => deleteData<{ ok: true }>(`/songs/${id}`),
  /** Papelera (borrado lógico): songs enviados a la Papelera. */
  trash: (params?: { page?: number; pageSize?: number }) => getData<Paginated<Song>>('/songs/trash', params),
  /** Restaura desde la Papelera (idempotente). No reconstruye nada. */
  restore: (id: string) => postData<Song>(`/songs/${id}/restore`, {}),
  setVisibility: (id: string, body: { visibility?: 'PUBLIC' | 'PRIVATE'; allowComments?: boolean; allowRemix?: boolean }) =>
    patchData<{ id: string; visibility: string; allowComments: boolean; allowRemix?: boolean }>(`/songs/${id}/visibility`, body),
  react: (id: string, type: 'LIKE' | 'DISLIKE') => postData<{ reaction: 'LIKE' | 'DISLIKE' | null }>(`/songs/${id}/react`, { type }),
  addComment: (id: string, content: string, parentId?: string) =>
    postData<SongComment>(`/songs/${id}/comments`, { content, ...(parentId ? { parentId } : {}) }),
  /** v0.15.0 — me gusta de comentario (toggle). */
  likeComment: (songId: string, commentId: string) =>
    postData<{ liked: boolean; likesCount: number }>(`/songs/${songId}/comments/${commentId}/like`),
  deleteComment: (id: string, commentId: string) => deleteData<{ ok: true }>(`/songs/${id}/comments/${commentId}`),
  registerPlay: (id: string) => postData<{ playsCount: number }>(`/songs/${id}/play`),
};

/* ── Comunidad ── */
export const communityApi = {
  feed: (params?: { sort?: 'newest' | 'most_played' | 'most_liked'; genre?: string; style?: string; authorId?: string; remixOf?: string; search?: string; scope?: 'all' | 'following'; page?: number; limit?: number }) =>
    getData<Paginated<CommunitySong>>('/community/songs', params),
  song: (id: string) => getData<CommunitySongDetail>(`/community/songs/${id}`),
  comments: (id: string, params?: { page?: number; limit?: number }) => getData<Paginated<SongComment>>(`/community/songs/${id}/comments`, params),
  /** v0.15.0 — perfil público de creador + listas de seguidos/seguidores. */
  userProfile: (id: string) => getData<PublicUserProfile>(`/community/users/${id}`),
  userFollows: (id: string, params?: { page?: number; limit?: number }) =>
    getData<Paginated<CommunityUserCard>>(`/community/users/${id}/follows`, params),
  userFollowers: (id: string, params?: { page?: number; limit?: number }) =>
    getData<Paginated<CommunityUserCard>>(`/community/users/${id}/followers`, params),
};

/* ── Notificaciones (v0.18.0, 🔒) ── */
/* type (no interface): así el objeto es asignable al Record<string, unknown>
   que espera getData(url, params) — los interfaces no tienen firma índice. */
export type NotificationListParams = {
  page?: number;
  pageSize?: number;
  /** '1' → solo sin leer. */
  unread?: '1';
  /** Filtro por tipos, coma-separado (p. ej. 'SONG_COMMENT,COMMENT_REPLY'). */
  type?: string;
  /** Búsqueda de texto. */
  search?: string;
};

export const notificationsApi = {
  /** GET /notifications — centro de notificaciones paginado. */
  list: (params?: NotificationListParams) => getData<Paginated<AppNotification>>('/notifications', params),
  /** GET /notifications/unread-count — total sin leer (badge de la campanita). */
  unreadCount: () => getData<{ count: number }>('/notifications/unread-count'),
  /** POST /notifications/:id/read — marca una notificación como leída. */
  markRead: (id: string) => postData<AppNotification>(`/notifications/${id}/read`),
  /** POST /notifications/read-all — marca todas como leídas → { updated }. */
  markAll: () => postData<{ updated: number }>('/notifications/read-all'),
};

/* ── Denuncias de comunidad (v0.18.0, 🔒) ── */
export interface CreateReportBody {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  description?: string;
}

export const reportsApi = {
  /** POST /reports — denuncia una canción / comentario / usuario.
   *  Errores esperados: 409 (ya denunciado), 404, 422, 400 (contenido propio). */
  create: (body: CreateReportBody) => postData<Report>('/reports', body),
};

/* El panel de administración vive en melodya.backoffice (contra el backend oficial). La web solo denuncia (reportsApi) y
 * recibe notificaciones (notificationsApi). */

/* ── Proyectos ── */
/* El backend (v0.14) devuelve el Project crudo de Prisma:
 *   { id, userId, name, description, coverFileId, coverFile: { id, mimeType } | null,
 *     _count: { songs }, createdAt, updatedAt }
 * La portada NO viene como URL: se arma desde el File con el endpoint público
 * de stream (igual que hace el propio backend con las canciones). */
interface RawProject {
  id: string;
  deletedAt?: string | null;
  userId: string;
  name: string;
  description: string | null;
  coverFileId?: string | null;
  coverFile?: { id: string; mimeType: string } | null;
  _count?: { songs: number };
  createdAt: string;
  updatedAt: string;
}

function mapProject(p: RawProject): Project {
  return {
    id: p.id,
    userId: p.userId,
    name: p.name,
    description: p.description,
    coverUrl: p.coverFile?.id ? `/api/files/${p.coverFile.id}/stream` : null,
    songsCount: p._count?.songs ?? 0,
    deletedAt: p.deletedAt ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/* El backend real devuelve las canciones de un proyecto SIN serializar
 * (objeto Prisma crudo: coverFile { id }, currentVersion { audioFile { id } }),
 * a diferencia de GET /songs que agrega coverUrl / currentVersion.audioUrl.
 * Normalizamos acá para que la UI reciba siempre la forma Song — tolera ambas. */
interface RawSongFile { id: string; mimeType?: string }

interface RawProjectSong {
  id: string;
  userId?: string;
  projectId?: string | null;
  title: string;
  visibility?: 'PRIVATE' | 'PUBLIC';
  allowComments?: boolean;
  currentVersionId?: string | null;
  coverFile?: RawSongFile | null;
  coverUrl?: string | null;
  likesCount?: number;
  dislikesCount?: number;
  playsCount?: number;
  commentsCount?: number;
  lastGenerationAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  currentVersion?: {
    id: string;
    songId?: string;
    versionNumber?: number;
    generationId?: string | null;
    title?: string | null;
    lyricsText?: string | null;
    lyricsSource?: 'USER' | 'AI' | 'AI_EDITED' | null;
    durationSec?: number | null;
    genre?: string | null;
    tags?: string[];
    createdAt?: string;
    audioFile?: RawSongFile | null;
    audioUrl?: string | null;
    coverUrl?: string | null;
  } | null;
  versions?: Array<{ id: string; versionNumber: number; createdAt: string; title: string | null }>;
  _count?: { versions?: number };
}

/** Canción cruda → Song: arma coverUrl/audioUrl desde los File si no vienen. */
function mapProjectSong(s: RawProjectSong): Song {
  const cv = s.currentVersion;
  return {
    id: s.id,
    userId: s.userId ?? '',
    projectId: s.projectId ?? null,
    title: s.title,
    coverUrl: s.coverUrl ?? (s.coverFile?.id ? `/api/files/${s.coverFile.id}/stream` : null),
    visibility: s.visibility ?? 'PRIVATE',
    allowComments: s.allowComments ?? true,
    currentVersionId: s.currentVersionId ?? null,
    completedVersionCount: s._count?.versions ?? 0,
    likesCount: s.likesCount ?? 0,
    dislikesCount: s.dislikesCount ?? 0,
    playsCount: s.playsCount ?? 0,
    commentsCount: s.commentsCount ?? 0,
    lastGenerationAt: s.lastGenerationAt ?? null,
    createdAt: s.createdAt ?? new Date(0).toISOString(),
    updatedAt: s.updatedAt ?? new Date(0).toISOString(),
    currentVersion: cv
      ? {
        id: cv.id,
        songId: cv.songId ?? s.id,
        versionNumber: cv.versionNumber ?? 1,
        generationId: cv.generationId ?? null,
        title: cv.title ?? s.title,
        lyricsText: cv.lyricsText ?? null,
        lyricsSource: cv.lyricsSource ?? null,
        durationSec: cv.durationSec ?? null,
        genre: cv.genre ?? null,
        tags: cv.tags ?? [],
        createdAt: cv.createdAt ?? new Date(0).toISOString(),
        audioUrl: cv.audioUrl ?? (cv.audioFile?.id ? `/api/files/${cv.audioFile.id}/stream` : null),
        coverUrl: cv.coverUrl ?? null,
      }
      : null,
    versions: s.versions,
  };
}

export const projectsApi = {
  list: async (params?: { page?: number; pageSize?: number }) => {
    const data = await getData<Paginated<RawProject>>('/projects', params);
    return { ...data, items: data.items.map(mapProject) };
  },
  create: (body: { name: string; description?: string }) => postData<RawProject>('/projects', body).then(mapProject),
  get: (id: string) => getData<RawProject>(`/projects/${id}`).then(mapProject),
  update: (id: string, body: { name?: string; description?: string }) => patchData<RawProject>(`/projects/${id}`, body).then(mapProject),
  remove: (id: string) => deleteData<{ ok: true }>(`/projects/${id}`),
  /** Papelera (borrado lógico): proyectos enviados a la Papelera. Sus canciones nunca se mueven. */
  trash: async (params?: { page?: number; pageSize?: number }) => {
    const data = await getData<Paginated<RawProject>>('/projects/trash', params);
    return { ...data, items: data.items.map(mapProject) };
  },
  /** Restaura desde la Papelera (idempotente). */
  restore: (id: string) => postData<RawProject>(`/projects/${id}/restore`, {}).then(mapProject),
  songs: async (id: string, params?: { page?: number; pageSize?: number }) => {
    const data = await getData<Paginated<RawProjectSong>>(`/projects/${id}/songs`, params);
    return { ...data, items: data.items.map(mapProjectSong) };
  },
  uploadCover: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client.post(`/projects/${id}/cover`, form, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => mapProject(r.data.data as RawProject));
  },
};

/* ── Letras / Letristas ── */
export const lyricsApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string; genre?: string; source?: 'MANUAL' | 'AI_GENERATED' }) =>
    getData<Paginated<UserLyric>>('/lyrics', params),
  create: (body: { title: string; lyrics: string; idea?: string; genre?: string; tags?: string[] }) =>
    postData<UserLyric>('/lyrics', body),
  get: (id: string) => getData<UserLyric>(`/lyrics/${id}`),
  update: (id: string, body: Partial<{ title: string; lyrics: string; idea: string | null; genre: string | null; tags: string[] }>) =>
    patchData<UserLyric>(`/lyrics/${id}`, body),
  remove: (id: string) => deleteData<{ ok: true }>(`/lyrics/${id}`),
  /** Papelera (borrado lógico): lyrics enviados a la Papelera. */
  trash: (params?: { page?: number; pageSize?: number }) => getData<Paginated<UserLyric>>('/lyrics/trash', params),
  /** Restaura desde la Papelera (idempotente). No reconstruye nada. */
  restore: (id: string) => postData<UserLyric>(`/lyrics/${id}/restore`, {}),
};

export const songwritersApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string }) => getData<Paginated<LyricPersona>>('/lyric-personas', params),
  create: (body: { name: string; description: string; lyricIds?: string[]; songIds?: string[] }) =>
    postData<LyricPersona>('/lyric-personas', body),
  get: (id: string, hydrate = false) => getData<LyricPersona>(`/lyric-personas/${id}${hydrate ? '?hydrate=1' : ''}`),
  update: (id: string, body: Partial<{ name: string; description: string; lyricIds: string[]; songIds: string[] }>) =>
    patchData<LyricPersona>(`/lyric-personas/${id}`, body),
  remove: (id: string) => deleteData<{ ok: true }>(`/lyric-personas/${id}`),
  /** Papelera (borrado lógico): lyric-personas enviados a la Papelera. */
  trash: (params?: { page?: number; pageSize?: number }) => getData<Paginated<LyricPersona>>('/lyric-personas/trash', params),
  /** Restaura desde la Papelera (idempotente). No reconstruye nada. */
  restore: (id: string) => postData<LyricPersona>(`/lyric-personas/${id}/restore`, {}),
};

/* ── CMS ── */
export const cmsApi = {
  banners: (position?: string) => getData<{ items: Banner[] }>('/banners', position ? { position } : undefined),
  announcements: () => getData<{ items: Announcement[] }>('/announcements'),
};
