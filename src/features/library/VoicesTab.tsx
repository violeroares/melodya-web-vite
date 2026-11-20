
/**
 * MELODYA WEB — Biblioteca › Voces (clonación estilo Suno Voice).
 * Panel estilo Suno "My Voices": crear voz (grabar/subir + frase de
 * verificación + detalles + avatar), administrar voces clonadas y seguir
 * sesiones en curso. Contrato backend v0.14.2:
 *  • POST /voice-sessions { sampleId VOICE } → { alreadyRegistered, voiceId?, session? }
 *  • Estados: PHRASE_PENDING → PHRASE_READY → (verify con detalles) → VOICE_PENDING → READY | FAILED
 *  • PATCH /samples/:id { name, description, tags } · POST /samples/:id/avatar
 */
import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Check, CheckCircle2, CircleAlert, CircleHelp, Loader2, Mic2, MoreVertical, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Upload, Volume2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { samplesApi, voiceSessionsApi } from '@/lib/api';
import { apiFileUrl } from '@/lib/api/client';
import { toUserMessage } from '@/lib/errors';
import { useAuthStore } from '@/stores/auth';
import { formatRelative } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import { LOCK_REASON } from '@/lib/capabilities';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { RequiredPlanBadge } from '@/components/common/PlanGate';
import type { Paginated, UserSample, VoiceSession } from '@/types';
import { cn } from '@/lib/utils';
import { AuthAvatar, EmptyState, ErrorState, LoadingRows, SectionHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog, InlineError, SamplePlayButton, ViewToggle, useViewMode } from './library-utils';
import { VoiceCloneDialog } from '@/features/voice/VoiceCloneDialog';
import { useVoiceAvailability } from '@/features/voice/VoiceAvailabilityNotice';
import { voiceCardStatus, type VoiceCardStatus } from '@/features/voice/voice-expiry';
import { failedBeforeVoice, findActiveSession, nextCloneAction, PHRASE_INSTRUCTION, resumePhase, sessionErrorMessage, sessionNeedsAction, withoutSession } from '@/features/voice/voice-session-flow';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VOICE_STATUS_LABELS: Record<VoiceSession['status'], string> = {
  PHRASE_PENDING: 'Preparando frase…',
  PHRASE_READY: 'Frase lista para grabar',
  VERIFYING: 'Verificando…',
  VOICE_PENDING: 'Creando tu voz…',
  READY: 'Voz lista',
  FAILED: 'Falló',
};

/** Cuántos pasos están completos (de 4) según el estado. */
function stepsDone(status: VoiceSession['status']): number {
  switch (status) {
    case 'PHRASE_READY':
    case 'VERIFYING':
      return 1;
    case 'VOICE_PENDING':
      return 2;
    case 'READY':
      return 4;
    default:
      return 0;
  }
}

export function VoicesTab() {
  const [view, setView] = useViewMode('melodya:voices-view');
  const list = view === 'list';
  const qc = useQueryClient();
  const { toast } = useToast();
  const user = useAuthStore((s) => s.user);
  const consentAccepted = !!user?.voiceConsentAcceptedAt;

  const [createOpen, setCreateOpen] = useState(false);
  // Sesión en curso que el asistente retoma (null = flujo nuevo).
  const [resumeSession, setResumeSession] = useState<VoiceSession | null>(null);
  // Voz caducada que se recrea con su muestra original (null = flujo nuevo o retomar sesión).
  const [recreateSampleId, setRecreateSampleId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<UserSample | null>(null); // grabación sin clonar que se elimina
  const [toRemoveVoice, setToRemoveVoice] = useState<UserSample | null>(null); // voz clonada que se quita (la grabación se conserva)
  const [editing, setEditing] = useState<UserSample | null>(null);
  const [resuming, setResuming] = useState<UserSample | null>(null);

  const samplesQuery = useQuery({
    queryKey: ['samples', 'VOICE'],
    queryFn: () => samplesApi.list({ kind: 'VOICE', pageSize: 50 }),
  });
  const voiceSamples = samplesQuery.data?.items ?? [];

  const sessionsQuery = useQuery({
    queryKey: ['voice-sessions'],
    queryFn: () => voiceSessionsApi.list({ pageSize: 50 }),
  });
  const sessions = sessionsQuery.data?.items ?? [];
  // Solo las sesiones que piden algo al usuario (retomar, reintentar o descartar): las terminadas ya son una voz en «Mis voces».
  const actionableSessions = sessions.filter((s) => sessionNeedsAction(s.status));

  const removeSampleMutation = useMutation({
    mutationFn: (id: string) => samplesApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['samples'] });
      void qc.invalidateQueries({ queryKey: ['voice-sessions'] });
      toast({ title: 'Grabación enviada a la Papelera', description: 'La restaurás desde Biblioteca › Papelera.' });
      setToDelete(null);
    },
    onError: (err) => toast({ title: 'No pudimos eliminar la grabación', description: toUserMessage(err), variant: 'destructive' }),
  });

  // Quitar una voz clonada NO borra la grabación original (son el mismo registro): la voz sale de «Mis voces» y el audio pasa a
  // «Muestras sin clonar», listo para clonarse de nuevo. Las canciones ya generadas no cambian.
  const removeVoiceMutation = useMutation({
    mutationFn: (id: string) => samplesApi.removeVoice(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['samples'] });
      toast({ title: 'Voz quitada', description: 'Tu grabación se conservó en «Muestras sin clonar».' });
      setToRemoveVoice(null);
    },
    onError: (err) => toast({ title: 'No pudimos quitar la voz', description: toUserMessage(err), variant: 'destructive' }),
  });

  // Clonar una voz exige VOICE_CLONING: sin la capacidad ninguna entrada abre el flujo de clonación; se muestra el aviso de upgrade.
  const cloneGate = usePlanGate('VOICE_CLONING');
  const cloneLocked = cloneGate.locked;

  const openResume = (session: VoiceSession) => {
    if (cloneLocked) {
      cloneGate.prompt();
      return;
    }
    setResumeSession(session);
    setCreateOpen(true);
  };
  /** «Crear voz» (encabezado y estado vacío). */
  const openCreate = () => {
    if (cloneLocked) {
      cloneGate.prompt();
      return;
    }
    setResumeSession(null);
    setRecreateSampleId(null);
    setCreateOpen(true);
  };
  /** «Recrear voz»: las voces clonadas son temporales; se recrea con la grabación original que Melodya conserva (frase nueva). */
  const openRecreate = (sample: UserSample) => {
    if (cloneLocked) {
      cloneGate.prompt();
      return;
    }
    setResumeSession(null);
    setRecreateSampleId(sample.id);
    setCreateOpen(true);
  };

  /** "Clonar mi voz" sobre una muestra existente sin clonar. */
  const startClone = async (sample: UserSample) => {
    if (cloneLocked) {
      cloneGate.prompt();
      return;
    }
    // POST /voice-sessions crea una sesión nueva (y pide otra frase a Suno) cada vez: si ya hay una en curso, se retoma esa.
    const next = nextCloneAction(sessions, sample.id);
    if (next.action === 'resume') {
      openResume(next.session);
      return;
    }
    setResuming(sample);
    try {
      const res = await voiceSessionsApi.create(sample.id);
      if (res.alreadyRegistered) {
        toast({ title: 'Esta voz ya está registrada', description: 'Elegí otra muestra o usá la voz que ya clonaste.' });
      } else {
        toast({ title: '¡Vamos a clonar tu voz!', description: 'Seguí la sesión abajo para grabar la frase de verificación.' });
      }
      void qc.invalidateQueries({ queryKey: ['voice-sessions'] });
    } catch (err) {
      toast({ title: 'No pudimos empezar la clonación', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setResuming(null);
    }
  };

  const cloned = voiceSamples.filter((s) => s.sunoPersonaId);
  const pending = voiceSamples.filter((s) => !s.sunoPersonaId);

  return (
    <div className="space-y-10">
      {/* ── Autorización de uso de voz ── */}
      {!consentAccepted && (
        <section aria-label="Autorización de uso de voz">
          <div className="rounded-cover border border-amber/40 bg-amber/5 p-4 sm:p-6">
            <div className="flex items-start gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-element-idea text-[#131C33]" aria-hidden>
                <Mic2 className="h-[22px] w-[22px]" />
              </div>
              <div className="flex-1">
                <h3 className="font-display text-lg font-bold text-foreground">Voces</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Para cantar con tu timbre, Melodya clona tu voz a partir de una muestra tuya y una frase de
                  verificación. Tu voz se usa únicamente en tus generaciones, siempre bajo tu control: podés borrar
                  tus voces cuando quieras.
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  Antes de crear tu primera voz te vamos a pedir la{' '}
                  <strong className="text-foreground">autorización de uso de voz</strong> (datos biométricos),
                  como pide la ley.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Mis voces ── */}
      <section aria-label="Mis voces">
        <SectionHeader
          title="Mis voces"
          subtitle="Tus voces clonadas, listas para usar en cualquier canción."
          hideSubtitleOnMobile
          action={
            <div className="flex items-center gap-2">
              <ViewToggle view={view} onChange={setView} compact={false} className="max-sm:hidden" />
              <Button
                onClick={openCreate}
                aria-label="Crear voz"
                aria-disabled={cloneLocked || undefined}
                className={cn('rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground order-first max-sm:size-11 max-sm:gap-0 max-sm:px-0', cloneLocked && '!bg-none border border-dashed border-amber/50 !bg-transparent !text-muted-foreground hover:!bg-amber/5')}
              >
                <Plus className="h-4 w-4" aria-hidden /> <span className="max-sm:sr-only">Crear voz</span>
                <RequiredPlanBadge capability="VOICE_CLONING" className="max-sm:hidden" />
              </Button>
            </div>
          }
        />
        {samplesQuery.isLoading ? (
          <LoadingRows count={3} />
        ) : samplesQuery.isError ? (
          <ErrorState message={toUserMessage(samplesQuery.error)} onRetry={() => void samplesQuery.refetch()} />
        ) : cloned.length === 0 ? (
          <EmptyState
            variant="studio"
            icon={<Mic2 className="h-7 w-7" />}
            title="Todavía no tenés voces clonadas."
            description="Grabá o subí tu voz, verificá con una frase y queda disponible para tus canciones."
            actionLabel="Crear mi primera voz"
            actionIcon={cloneGate.excluded ? <RequiredPlanBadge capability="VOICE_CLONING" /> : undefined}
            onAction={openCreate}
          />
        ) : (
          <div className={cn(list ? 'flex flex-col gap-2' : 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3')}>
            {cloned.map((sample) => (
              <VoiceCard key={sample.id} list={list} sample={sample} onEdit={() => setEditing(sample)} onDelete={() => setToRemoveVoice(sample)} onRecreate={() => openRecreate(sample)} />
            ))}
          </div>
        )}
      </section>

      {/* ── Muestras sin clonar (continuar clonación) ── */}
      {pending.length > 0 && (
        <section aria-label="Muestras de voz sin clonar">
          <SectionHeader
            title="Muestras sin clonar"
            subtitle="Subiste estas tomas pero todavía no completaste la verificación."
          />
          <div className={cn(list ? 'flex flex-col gap-2' : 'grid grid-cols-[minmax(0,1fr)] gap-3 xl:grid-cols-2')}>
            {pending.map((sample) => (
              /* Mismo formato que las cards de Samples: ícono + título con la fecha debajo, y a la derecha las acciones (play y menú de 3 puntos) */
              <article
                key={sample.id}
                className="flex flex-nowrap items-center gap-x-3 rounded-cover border border-border/70 bg-surface p-3 transition-colors hover:border-amber/40 max-sm:gap-x-2 max-sm:p-2.5"
              >
                <div className="flex min-w-0 flex-1 basis-0 items-center gap-3 max-sm:gap-2">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-element-sound text-[#131C33] max-sm:size-9" aria-hidden>
                    <AudioLines className="h-[22px] w-[22px] max-sm:h-[18px] max-sm:w-[18px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-foreground">{sample.name}</h3>
                    <p className="text-xs whitespace-nowrap text-muted-foreground first-letter:uppercase">{formatRelative(sample.createdAt)}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center justify-end gap-1 max-sm:gap-0.5">
                  <Button
                    size="sm"
                    className={cn('mr-1 rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground max-sm:h-8 max-sm:px-3 max-sm:text-xs max-[420px]:size-8 max-[420px]:gap-0 max-[420px]:px-0', cloneLocked && '!bg-none border border-dashed border-amber/50 !bg-transparent !text-muted-foreground')}
                    aria-label="Clonar mi voz"
                    title={cloneLocked ? LOCK_REASON.VOICE_CLONING : undefined}
                    aria-disabled={cloneLocked || undefined}
                    disabled={resuming?.id === sample.id}
                    onClick={() => void startClone(sample)}
                  >
                    {resuming?.id === sample.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <Mic2 className="h-4 w-4" aria-hidden />
                    )}
                    <span className="max-[420px]:sr-only">Clonar mi voz</span>
                    <RequiredPlanBadge capability="VOICE_CLONING" className="max-[420px]:hidden" />
                  </Button>
                  <SamplePlayButton
                    id={sample.id}
                    name={sample.name}
                    className="shrink-0 max-sm:size-9"
                    track={() => ({
                      id: sample.id,
                      title: sample.name,
                      artist: 'Sample de voz',
                      coverUrl: null,
                      audioUrl: apiFileUrl(sample.fileUrl) ?? '',
                      kind: 'sample',
                      isPublic: false, // los samples son privados (del dueño): descarga autenticada desde el primer intento, sin pedido anónimo
                      durationSec: sample.durationSec,
                    })}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Opciones de ${sample.name}`}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors max-sm:h-7 max-sm:w-7 hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground"
                      >
                        <MoreVertical className="h-4 w-4" aria-hidden />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" variant="list">
                      <DropdownMenuItem onClick={() => setToDelete(sample)} className="text-destructive focus:text-destructive">
                        <Trash2 className="h-4 w-4" aria-hidden /> Enviar a la Papelera
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* ── Clonaciones que requieren una acción (retomar, reintentar o descartar); las terminadas no se muestran ── */}
      {(sessionsQuery.isLoading || sessionsQuery.isError || actionableSessions.length > 0) && (
      <section aria-label="Sesiones de clonación de voz">
        <SectionHeader
          title="Clonación de voz"
          subtitle="Cada clonación necesita una frase de verificación grabada por vos."
        />
        {sessionsQuery.isLoading ? (
          <LoadingRows count={2} />
        ) : sessionsQuery.isError ? (
          <ErrorState message={toUserMessage(sessionsQuery.error)} onRetry={() => void sessionsQuery.refetch()} />
        ) : (
          <div className="space-y-4">
            {actionableSessions.map((session) => (
              <VoiceSessionCard
                // El estado local de la tarjeta nace de la prop: si la lista cambia de estado esta sesión (p. ej. el asistente la
                // avanzó), la tarjeta se vuelve a montar con el estado nuevo en vez de quedar mostrando uno viejo.
                key={`${session.id}:${session.status}`}
                session={session}
                // Otra sesión en curso para la misma muestra: reintentar duplicaría la clonación (POST /voice-sessions no es idempotente).
                otherActiveForSample={!!session.voiceSampleId && !!findActiveSession(sessions, session.voiceSampleId, session.id)}
                onResume={() => openResume(session)}
              />
            ))}
          </div>
        )}
      </section>
      )}

      {/* Crear voz (flujo completo estilo Suno) */}
      <VoiceCloneDialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) { setResumeSession(null); setRecreateSampleId(null); }
        }}
        resumeSession={resumeSession}
        recreateSampleId={recreateSampleId}
      />

      {/* Editar detalles de la voz */}
      <EditVoiceDialog sample={editing} onClose={() => setEditing(null)} />

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`¿Enviar "${toDelete?.name ?? ''}" a la Papelera?`}
        actionLabel="Enviar a la Papelera"
        description="La grabación se conserva en la Papelera. Si es una voz clonada, restaurarla no garantiza que la voz siga vigente en Suno. Las canciones que ya generaste no cambian."
        onConfirm={() => toDelete && removeSampleMutation.mutate(toDelete.id)}
        pending={removeSampleMutation.isPending}
      />

      <ConfirmDialog
        open={!!toRemoveVoice}
        onOpenChange={(o) => !o && setToRemoveVoice(null)}
        title={`¿Quitar la voz "${toRemoveVoice?.name ?? ''}"?`}
        description="Deja de estar disponible para crear canciones. Tu grabación se conserva en «Muestras sin clonar» y podés clonarla de nuevo; las canciones ya generadas no cambian. Melodya no puede eliminar la voz del servicio de clonación: puede seguir existiendo allí."
        actionLabel="Quitar voz"
        // Un segundo clic mientras se quita no repite la operación (devolvería un error aunque la primera haya funcionado).
        onConfirm={() => toRemoveVoice && !removeVoiceMutation.isPending && removeVoiceMutation.mutate(toRemoveVoice.id)}
        pending={removeVoiceMutation.isPending}
      />
    </div>
  );
}

/* ── Tarjeta de voz clonada: avatar, tags, acciones ── */
const CARD_STATUS: Record<VoiceCardStatus, { chip: string; text: string; className: string }> = {
  checking: { chip: 'Verificando…', text: 'Comprobando la disponibilidad…', className: 'border-border bg-surface-2 text-muted-foreground' },
  available: { chip: 'Lista', text: 'Disponible al crear canciones', className: 'border-success/40 bg-success/10 text-success' },
  expired: { chip: 'Caducada', text: 'Recreala con tu grabación original', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
  unverified: { chip: 'Sin verificar', text: 'No pudimos comprobar la disponibilidad de esta voz. Podés volver a intentarlo más tarde', className: 'border-border bg-surface-2 text-muted-foreground' },
};

function VoiceCard({ sample, onEdit, onDelete, onRecreate, list = false }: { sample: UserSample; onEdit: () => void; onDelete: () => void; onRecreate: () => void; list?: boolean }) {
  // Disponibilidad real en Suno (las voces son temporales): una consulta por voz, con la misma entrada de caché que el selector del creador.
  const availability = useVoiceAvailability(sample.id);
  const status = voiceCardStatus({ data: availability.data, isError: availability.isError });
  const info = CARD_STATUS[status];
  const expired = status === 'expired';

  return (
    <article
      className={cn(
        'group flex h-full flex-col rounded-cover border border-border/70 bg-surface p-4 transition-colors hover:border-amber/40',
        list && 'p-3 sm:flex-row sm:items-center sm:gap-4'
      )}
    >
      <div className={cn('flex items-start gap-3', list && 'sm:w-72 sm:shrink-0 sm:items-center')}>
        <AuthAvatar
          src={sample.avatarUrl}
          name={sample.name}
          className="h-12 w-12 border-amber/30"
          fallbackClassName="font-display text-sm font-extrabold"
        />
        <div className="min-w-0 flex-1">
          {/* El chip va en la fila del nombre (no como columna aparte) para que el mensaje de abajo use todo el ancho del bloque. */}
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{sample.name}</h3>
            <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', info.className)} data-voice-status={status}>
              {status === 'checking' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              {status === 'available' && <CheckCircle2 className="h-3 w-3" aria-hidden />}
              {status === 'expired' && <CircleAlert className="h-3 w-3" aria-hidden />}
              {status === 'unverified' && <CircleHelp className="h-3 w-3" aria-hidden />}
              {info.chip}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">Creada {formatRelative(sample.createdAt)}</p>
          <p className={cn('mt-0.5 text-[11px] leading-snug', expired ? 'font-medium text-destructive' : 'text-muted-foreground')}>{info.text}</p>
        </div>
        {/* Anuncia los cambios de estado a lectores de pantalla (el chip y el texto visibles cambian junto con este). */}
        <span className="sr-only" role="status" aria-live="polite">{`${sample.name}: ${info.chip}. ${info.text}`}</span>
      </div>

      {sample.description && (
        <p className={cn('mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground', list && 'sm:mt-0 sm:min-w-0 sm:flex-1')}>{sample.description}</p>
      )}
      {!!sample.tags?.length && (
        <p className={cn('mt-2 flex flex-wrap gap-1.5', list && 'sm:mt-0 sm:max-w-64')}>
          {sample.tags.slice(0, 4).map((t) => (
            <span key={t} className="rounded-full border border-amber/30 bg-amber/10 px-2 py-0.5 text-[11px] text-amber-strong">
              {t}
            </span>
          ))}
          {sample.tags.length > 4 && (
            <span className="text-[11px] text-muted-foreground">+{sample.tags.length - 4}</span>
          )}
        </p>
      )}

      <div className={cn('mt-3 flex items-center justify-end gap-2 border-t border-border/60 pt-3 sm:justify-start', list && 'sm:mt-0 sm:ml-auto sm:shrink-0 sm:border-t-0 sm:pt-0')}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Editar ${sample.name}`}
          className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground"
          onClick={onEdit}
        >
          <Pencil className="h-4 w-4" aria-hidden />
        </Button>
        {/* Voz caducada: la acción pasa a ser un botón con texto y color propio; en cualquier otro estado sigue siendo el ícono discreto. */}
        <Button
          variant={expired ? 'default' : 'ghost'}
          size={expired ? 'sm' : 'icon'}
          aria-label={`Recrear la voz ${sample.name}`}
          title="Recrear la voz (las voces clonadas son temporales: se recrea con tu grabación original y una frase nueva)"
          className={expired ? 'rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground' : 'h-9 w-9 rounded-full text-muted-foreground hover:text-foreground'}
          onClick={onRecreate}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          {expired && <span>Recrear</span>}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Quitar la voz ${sample.name}`}
          title="Quitar la voz (la grabación se conserva)"
          className="h-9 w-9 rounded-full text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </article>
  );
}

/* ── Edición de detalles (nombre / tags / descripción / avatar) ── */
function EditVoiceDialog({ sample, onClose }: { sample: UserSample | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  // Foto recién subida: la lista (`sample`) es una copia tomada al abrir el diálogo, así que la nueva foto se muestra desde acá.
  const [newAvatarUrl, setNewAvatarUrl] = useState<string | null>(null);

  // Al cambiar de muestra se recarga el formulario (ajuste de estado durante el render).
  const [loadedSample, setLoadedSample] = useState(sample);
  if (sample !== loadedSample) {
    setLoadedSample(sample);
    setNewAvatarUrl(null);
    if (sample) {
      setName(sample.name);
      setTagsInput(sample.tags?.join(', ') ?? '');
      setDescription(sample.description ?? '');
      setError(null);
    }
  }

  const save = async () => {
    if (!sample) return;
    setBusy(true);
    setError(null);
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8);
      await samplesApi.update(sample.id, {
        name: name.trim().slice(0, 120),
        description: description.trim() ? description.trim().slice(0, 500) : null,
        tags,
      });
      await qc.invalidateQueries({ queryKey: ['samples'] });
      toast({ title: 'Voz actualizada' });
      onClose();
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    if (!sample) return;
    setAvatarBusy(true);
    try {
      // La foto se sube y se guarda al instante (como siempre); el diálogo sigue abierto y no toca lo que el usuario escribió.
      const updated = await samplesApi.setAvatar(sample.id, file);
      setNewAvatarUrl(updated.avatarUrl);
      void qc.invalidateQueries({ queryKey: ['samples'] });
      toast({ title: 'Foto actualizada' });
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <Dialog open={!!sample} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg border-border/70 bg-surface">
        <DialogHeader>
          <DialogTitle className="font-display">Editar voz</DialogTitle>
          <DialogDescription>Cambiale el nombre, las etiquetas, la descripción o la foto.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => imgInputRef.current?.click()}
            className="relative shrink-0 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
            aria-label="Cambiar foto de la voz"
          >
            <AuthAvatar
              src={newAvatarUrl ?? sample?.avatarUrl}
              name={sample?.name ?? ''}
              className="h-16 w-16 border-amber/30"
              fallbackClassName="font-display text-lg font-extrabold"
            />
            <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full gradient-warm text-primary-foreground shadow" aria-hidden>
              {avatarBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pencil className="h-3 w-3" />}
            </span>
          </button>
          <div className="space-y-1 text-sm">
            <p className="font-semibold">{sample?.name}</p>
            <p className="text-xs text-muted-foreground">
              JPG, PNG o WEBP · hasta 5 MB. La foto es solo tuya: no se comparte.
            </p>
            {sample?.sunoPersonaId && (
              <p className="font-mono text-[11px] text-muted-foreground">voiceId: {sample.sunoPersonaId}</p>
            )}
          </div>
          <input
            ref={imgInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadAvatar(f);
              e.target.value = '';
            }}
          />
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-voice-name" className="text-sm font-medium">Nombre</Label>
            <Input id="edit-voice-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="rounded-xl" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-voice-tags" className="text-sm font-medium">
              Etiquetas de estilo <span className="font-normal text-muted-foreground">(separadas por comas)</span>
            </Label>
            <Input id="edit-voice-tags" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="Ej: pop, funk, balada" className="rounded-xl" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-voice-desc" className="text-sm font-medium">Descripción</Label>
            <Textarea
              id="edit-voice-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
              className="resize-none rounded-xl"
            />
          </div>
        </div>

        {error && <InlineError message={error} />}

        <DialogFooter>
          <Button variant="outline" className="rounded-full" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
            Guardar cambios
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Tarjeta de sesión: pasos + frase + subida de verificación ── */
function VoiceSessionCard({
  session: initial, otherActiveForSample, onResume,
}: {
  session: VoiceSession;
  otherActiveForSample: boolean;
  /** Abre el asistente de clonación en la fase que le corresponde a esta sesión. */
  onResume: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [session, setSession] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Guarda para qué sesión+estado se agotó el sondeo: al avanzar de paso deja de valer.
  const [timedOutKey, setTimedOutKey] = useState<string | null>(null);

  const { status, phrase } = session;
  const pollKey = `${initial.id}:${status}`;
  const timedOut = timedOutKey === pollKey;

  // Polling honesto y acotado (3s × 10 = 30s) mientras la frase o la voz están en proceso.
  useEffect(() => {
    if (status !== 'PHRASE_PENDING' && status !== 'VOICE_PENDING') return;
    let cancelled = false;
    const poll = async () => {
      for (let i = 0; i < 10 && !cancelled; i++) {
        await sleep(3000);
        if (cancelled) return;
        try {
          const s = await voiceSessionsApi.get(initial.id);
          if (cancelled) return;
          setSession(s);
          if (s.status !== status) return; // cambió de paso: el efecto decide si sigue sondeando
        } catch {
          /* seguimos intentando dentro del límite */
        }
      }
      if (!cancelled) setTimedOutKey(`${initial.id}:${status}`);
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [initial.id, status]);

  // Al terminar (READY: badge "Voz clonada ✓"; FAILED: la lista deja de ver la sesión como activa): refrescar samples y sesiones.
  useEffect(() => {
    if (status === 'READY' || status === 'FAILED') {
      void qc.invalidateQueries({ queryKey: ['samples'] });
      void qc.invalidateQueries({ queryKey: ['voice-sessions'] });
    }
  }, [status, qc]);

  /** Sesión FAILED: nueva sesión con la misma muestra fuente (el backend no reabre sesiones fallidas). */
  const retry = async () => {
    if (!session.voiceSampleId) return;
    setError(null);
    setRetrying(true);
    try {
      const res = await voiceSessionsApi.create(session.voiceSampleId);
      toast({
        title: res.alreadyRegistered ? 'Esa voz ya está clonada' : 'Nueva sesión creada',
        description: res.alreadyRegistered ? undefined : 'Seguila en la tarjeta nueva para grabar la frase.',
      });
      void qc.invalidateQueries({ queryKey: ['voice-sessions'] });
      void qc.invalidateQueries({ queryKey: ['samples'] });
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setRetrying(false);
    }
  };

  /** Descarta esta sesión (FAILED o PHRASE_READY; no toca la muestra ni otras sesiones). Si el backend la rechaza, la tarjeta queda y se muestra el error. */
  const discard = async () => {
    setError(null);
    setDeleting(true);
    try {
      await voiceSessionsApi.remove(initial.id);
      qc.setQueriesData<Paginated<VoiceSession>>({ queryKey: ['voice-sessions'] }, (old) => withoutSession(old, initial.id));
      void qc.invalidateQueries({ queryKey: ['voice-sessions'] });
      toast({ title: 'Clonación eliminada' });
    } catch (err) {
      setConfirmDelete(false);
      setError(toUserMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  // Una sesión que terminó bien ya es una voz en «Mis voces»: no se muestra (la lista la filtra; esto cubre el instante hasta el refresco).
  if (status === 'READY') return null;

  const done = stepsDone(status);
  const stepLabels = ['Frase', 'Grabación', 'Creando voz', 'Lista'];

  return (
    <article className="rounded-[28px_28px_14px_14px] border-[1.5px] border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Sesión del {new Date(session.createdAt).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}</span>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
            status === 'FAILED'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-amber/40 bg-amber/10 text-amber-strong'
          )}
        >
          {(status === 'PHRASE_PENDING' || status === 'VOICE_PENDING') && (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          )}
          {VOICE_STATUS_LABELS[status]}
        </span>
      </div>

      {/* Paso a paso como en el modal «Crear voz»: círculos numerados con línea de unión y etiqueta chica en mayúsculas */}
      <ol className="mt-4 grid grid-cols-4 gap-2" aria-label="Progreso de la clonación">
        {stepLabels.map((label, i) => {
          const isDone = i < done;
          const current = i === done && status !== 'FAILED';
          return (
            <li key={label} aria-current={current ? 'step' : undefined} className="flex min-w-0 flex-col items-center gap-1.5 sm:flex-row sm:gap-2">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                  current ? 'bg-primary text-primary-foreground' : isDone ? 'bg-success text-background' : 'border-[1.5px] border-line text-muted-foreground'
                )}
                aria-hidden
              >
                {isDone ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cn('truncate text-[11.5px] tracking-[0.08em] uppercase', current ? 'font-bold text-label' : isDone ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground')}>
                {label}
                <span className="sr-only">{current ? ' (paso actual)' : isDone ? ' (completado)' : ''}</span>
              </span>
              {i < stepLabels.length - 1 && (
                <span className={cn('ml-1 hidden h-px flex-1 rounded-full sm:block', isDone ? 'bg-success' : 'bg-faint')} aria-hidden />
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-4">
        {status === 'PHRASE_PENDING' && (
          <p className="text-sm text-muted-foreground">
            {timedOut
              ? 'La frase está tardando más de lo esperado. Volvé a entrar en un rato para ver si ya está.'
              : 'Estamos preparando tu frase de verificación…'}
          </p>
        )}

        {status === 'PHRASE_READY' && phrase && (
          <div className="rounded-2xl border border-amber/40 bg-amber/10 p-4 sm:p-5">
            <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-amber-strong uppercase">
              <Volume2 className="h-3.5 w-3.5" aria-hidden /> Necesitamos verificar que sos vos
            </p>
            <p className="mt-1 text-sm leading-relaxed text-foreground/90">{PHRASE_INSTRUCTION}</p>
            <p className="mt-2 font-display text-xl leading-snug text-foreground sm:text-2xl">“{phrase}”</p>
          </div>
        )}

        {status === 'VERIFYING' && (
          <p className="text-sm text-muted-foreground">Estamos verificando tu grabación…</p>
        )}

        {status === 'VOICE_PENDING' && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {timedOut
              ? 'Seguimos creando tu voz y puede demorar un poco más. Podés volver más tarde a ver el estado.'
              : 'Creando tu voz a partir de tu muestra y tu grabación…'}
          </p>
        )}

        {resumePhase(status) !== null && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button
              size="sm"
              className="rounded-full bg-primary font-bold text-[#131C33] hover:bg-primary hover:text-[#131C33] hover:brightness-95"
              onClick={onResume}
            >
              <Mic2 className="h-4 w-4" aria-hidden />
              Continuar clonación
            </Button>
            {status === 'PHRASE_READY' && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-full border-[1.5px] border-line bg-transparent font-medium text-foreground transition-colors hover:bg-accent max-sm:size-9 max-sm:gap-0 max-sm:px-0"
                disabled={deleting}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                <span className="max-sm:sr-only">Descartar esta clonación</span>
              </Button>
            )}
          </div>
        )}

        {status === 'FAILED' && (
          <div className="space-y-2">
            <InlineError
              message={
                sessionErrorMessage(session.error)
                ?? (failedBeforeVoice(session)
                  ? 'No pudimos preparar la frase de verificación. Probá con una muestra más limpia o volvé a empezar con otra muestra.'
                  : 'No pudimos crear tu voz con esa grabación. Probá con una muestra más limpia o volvé a empezar con otra muestra.')
              }
            />
            {session.voiceSampleId && otherActiveForSample && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Ya tenés otra clonación en curso para esta muestra: seguila en su tarjeta.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {session.voiceSampleId && !otherActiveForSample && (
                <Button variant="outline" size="sm" className="rounded-full" disabled={retrying || deleting} onClick={() => void retry()}>
                  {retrying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Mic2 className="h-4 w-4" aria-hidden />}
                  Volver a intentar
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="rounded-full border-[1.5px] border-line bg-transparent font-medium text-foreground transition-colors hover:bg-accent max-sm:size-9 max-sm:gap-0 max-sm:px-0"
                disabled={retrying || deleting}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                <span className="max-sm:sr-only">Eliminar</span>
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3">
            <InlineError message={error} />
          </div>
        )}
      </div>

      {/* Descartar: solo FAILED o PHRASE_READY (el backend lo exige también). La muestra y los demás intentos no se tocan. */}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={status === 'FAILED' ? '¿Eliminar esta clonación fallida?' : '¿Descartar esta clonación?'}
        description="Se elimina solo este intento. Tu muestra de voz y los demás intentos no se tocan."
        actionLabel={status === 'FAILED' ? 'Eliminar' : 'Descartar'}
        onConfirm={() => void discard()}
        pending={deleting}
      />
    </article>
  );
}
