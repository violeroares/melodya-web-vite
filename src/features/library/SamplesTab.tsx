
/**
 * MELODYA WEB — Biblioteca › Samples (muestras de audio propias).
 * Contrato real: subida multipart (máx 50 MB, audio). La subida (o edición hacia)
 * tipo VOICE exige consentimiento de voz aceptado (403 VOICE_CONSENT_REQUIRED);
 * el consentimiento se acepta INLINE dentro del diálogo (mismo texto que el perfil).
 * Nota: `sunoPersonaId` solo aplica a samples VOICE clonados (ver pestaña Voces).
 */
import React, { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Drum, Guitar, Mic, Mic2, MoreVertical, Music, Music2, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { profileApi, samplesApi } from '@/lib/api';
import { ApiError, apiFileUrl } from '@/lib/api/client';
import { toUserMessage } from '@/lib/errors';
import { useAuthStore } from '@/stores/auth';
import { formatDuration, formatRelative } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import { LOCK_REASON } from '@/lib/capabilities';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { RequiredPlanBadge } from '@/components/common/PlanGate';
import type { UserSample } from '@/types';
import { cn } from '@/lib/utils';
import { Chip, EmptyState, ErrorState, LoadingCards, SectionHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog, Field, LIST_MENU_COMFORTABLE_MOBILE, PencilSolid, SamplePlayButton, TabCtaButton, TrashSolid, ViewToggle, useViewMode } from './library-utils';

type KindFilter = 'ALL' | 'VOICE' | 'INSTRUMENT';

const SAMPLE_TYPES = ['BEATBOX', 'VOICE', 'GUITAR', 'BASS', 'DRUMS', 'MELODY', 'INSTRUMENT', 'OTHER'] as const;
type SampleType = (typeof SAMPLE_TYPES)[number];

const TYPE_LABELS: Record<string, string> = {
  BEATBOX: 'Beatbox', VOICE: 'Voz', GUITAR: 'Guitarra', BASS: 'Bajo', DRUMS: 'Batería',
  MELODY: 'Melodía', INSTRUMENT: 'Instrumento', OTHER: 'Otro',
};

const KIND_FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: 'ALL', label: 'Todos' },
  { key: 'VOICE', label: 'Voz' },
  { key: 'INSTRUMENT', label: 'Instrumentos' },
];

/* ── Autorización de uso de voz (idéntico al perfil: v1, texto honesto) ── */
const VOICE_CONSENT_VERSION = '1';
const VOICE_CONSENT_PARAGRAPHS = [
  'Autorizo a Melodya a procesar mis muestras de voz para crear una versión sintética de mi voz, únicamente para generar canciones en mi cuenta.',
  'Mis muestras se usan solamente para crear esa versión sintética: no se comparten con otras personas ni se usan para entrenar voces de terceros.',
  'Puedo revocar este consentimiento en cualquier momento eliminando mis muestras de voz desde la biblioteca.',
  'Me comprometo a no usar esta función para suplantar la voz ni la identidad de otras personas.',
];

/** Acepta la autorización de voz y refresca el usuario del store (flujo inline). */
async function acceptVoiceConsentAndRefresh() {
  await profileApi.acceptVoiceConsent(VOICE_CONSENT_VERSION);
  await useAuthStore.getState().loadMe();
}

/** ¿El tipo elegido requiere consentimiento todavía no aceptado? `race` cubre un
 *  403 del backend aunque el store diga lo contrario (carrera de sesión). */
const consentNeeded = (type: SampleType, accepted: boolean, race: boolean) =>
  type === 'VOICE' && (!accepted || race);

/* ── Tarjeta inline de consentimiento de voz (checkbox + 4 párrafos) ── */
function VoiceConsentCard({ id, checked, onCheckedChange }: { id: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-amber/40 bg-amber/10 p-3">
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(v) => onCheckedChange(v === true)}
          aria-label="Acepto la autorización de uso de voz"
          className="mt-0.5"
        />
        <Label htmlFor={id} className="text-sm font-medium leading-snug text-foreground">
          Acepto la autorización de uso de voz
        </Label>
      </div>
      <div className="space-y-2 rounded-lg bg-surface-2/60 p-3 text-xs leading-relaxed text-foreground/80">
        {VOICE_CONSENT_PARAGRAPHS.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        <p className="text-[11px] text-muted-foreground">Versión {VOICE_CONSENT_VERSION}</p>
      </div>
    </div>
  );
}

/* Ícono circular del audio (design-V2 › Biblioteca › Audios): voz en naranja, instrumentos en azul; el ícono sale del tipo. */
const SAMPLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  VOICE: Mic, BEATBOX: Mic2, GUITAR: Guitar, BASS: Guitar, DRUMS: Drum, MELODY: Music2, INSTRUMENT: Music, OTHER: AudioLines,
};
/** Los nombres autogenerados traen la fecha pegada («Mi voz · 19 nov»): ya se muestra debajo, así que en el título se omite (el nombre guardado no cambia). */
const displayName = (name: string) => name.replace(/s*·s*d{1,2}s+[a-záéíóúñ]{3,}.?(s+d{4})?s*$/i, '').trim() || name;

function SampleTile({ type, kind, className }: { type: string; kind: string; className?: string }) {
  const Icon = SAMPLE_ICONS[type] ?? AudioLines;
  return (
    <span aria-hidden className={cn('flex size-12 shrink-0 items-center justify-center rounded-full text-[#131C33]', kind === 'VOICE' ? 'bg-[#F0A44B]' : 'bg-element-sound', className)}>
      <Icon className="h-[22px] w-[22px]" />
    </span>
  );
}

export function SamplesTab() {
  const [view, setView] = useViewMode('melodya:samples-view');
  const list = view === 'list';
  const qc = useQueryClient();
  const { toast } = useToast();
  const [kind, setKind] = useState<KindFilter>('ALL');
  const [toDelete, setToDelete] = useState<UserSample | null>(null);
  const [toEdit, setToEdit] = useState<UserSample | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    // Una voz clonada sigue siendo una grabación del usuario: se lista aquí (sin filtro `cloned`) y sus acciones de clonación viven
    // en «Biblioteca › Voces». Esta consulta es idéntica a la de «Voces» para kind=VOICE, así que compartir la clave es correcto.
    // El backend nunca lista las grabaciones de verificación.
    queryKey: ['samples', kind],
    queryFn: () => samplesApi.list({ kind: kind === 'ALL' ? undefined : kind, pageSize: 50 }),
  });
  const samples = useMemo(() => data?.items ?? [], [data]);

  const removeMutation = useMutation({
    mutationFn: (id: string) => samplesApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['samples'] });
      toast({ title: 'Audio enviado a la Papelera', description: 'Lo restaurás desde Biblioteca › Papelera.' });
      setToDelete(null);
    },
    onError: (err) => toast({ title: 'No pudimos eliminar el audio', description: toUserMessage(err), variant: 'destructive' }),
  });

  return (
    <section aria-label="Tus audios">
      <SectionHeader
        title="Audios"
        subtitle="Tus audios: beatboxes para el ritmo, melodías de referencia y tu voz."
        hideSubtitleOnMobile
        action={
          <TabCtaButton icon={Plus} onClick={() => setUploadOpen(true)}>
            Subir audio
          </TabCtaButton>
        }
      />

      <div className="mb-5 flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar audios por tipo">
          {KIND_FILTERS.map((f) => (
            <Chip key={f.key} active={kind === f.key} onClick={() => setKind(f.key)}>
              {f.label}
            </Chip>
          ))}
        </div>
        <ViewToggle view={view} onChange={setView} className="max-sm:hidden" />
      </div>

      {isLoading ? (
        <LoadingCards count={6} />
      ) : isError ? (
        <ErrorState message={toUserMessage(error)} onRetry={() => void refetch()} />
      ) : samples.length === 0 ? (
        kind === 'ALL' ? (
          <EmptyState
            variant="studio"
            icon={<AudioLines className="h-7 w-7" />}
            title="Todavía no tenés audios."
            description="Subí un beatbox, una melodía o tu voz para usarlos como referencia en tus creaciones."
            actionLabel="Subir mi primer audio"
            onAction={() => setUploadOpen(true)}
          />
        ) : (
          <EmptyState
            variant="studio"
            icon={<AudioLines className="h-7 w-7" />}
            title={kind === 'VOICE' ? 'Todavía no subiste muestras de voz.' : 'Todavía no subiste instrumentos.'}
            description="Los audios que subís aparecen acá y los podés usar al crear canciones."
            actionLabel="Subir audio"
            onAction={() => setUploadOpen(true)}
          />
        )
      ) : (
        <div className={cn(list ? 'flex flex-col gap-2' : 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3')}>
          {samples.map((sample) => {
            const playBtn = (
              <SamplePlayButton
                id={sample.id}
                name={sample.name}
                className={cn('shrink-0', list ? 'sm:size-9' : 'size-11 [&_svg]:size-[18px]')}
                track={() => ({
                  id: sample.id,
                  title: sample.name,
                  artist: 'Audio',
                  coverUrl: null,
                  audioUrl: apiFileUrl(sample.fileUrl) ?? '',
                  kind: 'sample',
                  isPublic: false, // los samples son privados (del dueño): descarga autenticada desde el primer intento, sin pedido anónimo
                  durationSec: sample.durationSec,
                })}
              />
            );
            const dotsMenu = (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Opciones de ${sample.name}`}
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground',
                list && 'sm:hidden'
              )}
            >
              <MoreVertical className="h-4 w-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" variant="list" className={LIST_MENU_COMFORTABLE_MOBILE}>
            <DropdownMenuItem onClick={() => setToEdit(sample)}>
              <Pencil className="h-4 w-4" aria-hidden /> Editar
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setToDelete(sample)} className="text-destructive focus:text-destructive">
              <Trash2 className="h-4 w-4" aria-hidden /> Enviar a la Papelera
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
            );
            return (
              <article
                key={sample.id}
                className={cn(
                  '@container relative rounded-cover border border-[var(--m-border)] bg-[var(--m-input)] p-4 transition-colors hover:border-amber/40',
                  /* Grilla: encabezado (ícono + nombre) y debajo, a todo el ancho, play + etiquetas y descripción. Lista: una sola fila. */
                  list && 'flex items-center gap-3.5 pr-3'
                )}
              >
                <div className={list ? 'contents' : 'grid grid-cols-[3rem_minmax(0,1fr)_auto] content-start gap-x-3.5 gap-y-2.5'}>
                {/* design-V2 › Biblioteca › Audios: ícono circular por tipo (voz en naranja, instrumentos en azul), nombre, fecha · duración,
                    etiquetas en píldoras, descripción de una línea y acciones. */}
                <SampleTile type={sample.type} kind={sample.kind} className={!list ? 'col-start-1 row-start-1' : undefined} />
                <div className={list ? 'min-w-0 flex-1' : 'contents'}>
                  <div className={cn('min-w-0', !list && 'col-span-3 row-start-2 @[17rem]:col-span-1 @[17rem]:col-start-2 @[17rem]:row-start-1 @[17rem]:self-center')}>
                    <h3 title={sample.name} className="truncate font-display text-lg font-bold leading-[1.2] text-foreground">{displayName(sample.name)}</h3>
                    {/* Fecha y duración debajo del título */}
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] leading-[1.35] text-muted-foreground">
                      <span className="first-letter:uppercase">{formatRelative(sample.createdAt)}</span>
                      {sample.durationSec ? (
                        <>
                          <span aria-hidden>·</span>
                          <span>{formatDuration(sample.durationSec)}</span>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className={cn('min-w-0', list ? 'mt-1.5' : 'col-span-3 row-start-3')}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center rounded-full border border-muted-foreground px-[9px] py-[3px] text-xs leading-none font-medium text-foreground">{TYPE_LABELS[sample.type] ?? sample.type}</span>
                        <span className="inline-flex items-center rounded-full border border-muted-foreground px-[9px] py-[3px] text-xs leading-none font-medium text-foreground">{sample.kind === 'VOICE' ? 'Voz' : 'Instrumento'}</span>
                      </div>
                    </div>
                    {sample.description ? (
                      <p className="mt-1.5 line-clamp-1 text-[13px] leading-snug text-muted-foreground" title={sample.description}>
                        {sample.description}
                      </p>
                    ) : null}
                    {sample.sunoPersonaId ? <p className="mt-1 truncate text-[13px] text-muted-foreground">Voz clonada ✓</p> : null}
                  </div>
                </div>
                {/* Grilla: play a la izquierda de los 3 puntos, arriba a la derecha (como en Audios). */}
                {!list && <div className="col-start-3 row-start-1 flex items-center gap-0.5 self-start justify-self-end">{playBtn}{dotsMenu}</div>}
                {/* Vista lista: play + editar + enviar a la Papelera como botones a la vista (≥ sm). Grilla y mobile: menú de opciones. */}
                {list && (
                  <div className="flex shrink-0 items-center gap-1 sm:gap-3">
                    {playBtn}
                    {[
                      { key: 'edit', label: 'Editar', Icon: PencilSolid, onClick: () => setToEdit(sample) },
                      { key: 'delete', label: 'Enviar a la Papelera', Icon: TrashSolid, onClick: () => setToDelete(sample) },
                    ].map(({ key, label, Icon, onClick }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={onClick}
                        title={label}
                        aria-label={`${label}: ${sample.name}`}
                        className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] border-foreground text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground max-sm:hidden"
                      >
                        <Icon className="h-[18px] w-[18px]" />
                      </button>
                    ))}
                  </div>
                )}
                {list && dotsMenu}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <UploadSampleDialog open={uploadOpen} onOpenChange={setUploadOpen} />

      {toEdit && <EditSampleDialog sample={toEdit} onOpenChange={(o) => !o && setToEdit(null)} />}

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`¿Enviar "${toDelete?.name ?? ''}" a la Papelera?`}
        actionLabel="Enviar a la Papelera"
        description={
          toDelete?.sunoPersonaId
            ? 'Se conserva en la Papelera con su audio. Restaurar la grabación no garantiza que la voz clonada siga vigente en Suno.'
            : 'El archivo se conserva en la Papelera y lo restaurás cuando quieras. Las canciones que ya generaste no cambian.'
        }
        onConfirm={() => toDelete && removeMutation.mutate(toDelete.id)}
        pending={removeMutation.isPending}
      />
    </section>
  );
}

/* ── Subida de sample (multipart real; VOICE con consentimiento inline) ── */
function UploadSampleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const consentAccepted = useAuthStore((s) => !!s.user?.voiceConsentAcceptedAt);

  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<SampleType>('BEATBOX');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [consent, setConsent] = useState(false);
  const [consentRace, setConsentRace] = useState(false); // 403 pese al store (carrera)
  const fileRef = useRef<HTMLInputElement>(null);

  const showConsentCard = consentNeeded(type, consentAccepted, consentRace);

  const reset = () => {
    setFile(null);
    setType('BEATBOX');
    setName('');
    setDescription('');
    setDurationSec(null);
    setConsent(false);
    setConsentRace(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const uploadMutation = useMutation({
    mutationFn: async () => {
      // Si hace falta, registramos la autorización inline y refrescamos el usuario
      // ANTES de subir, en el mismo flujo (el diálogo no se cierra).
      if (showConsentCard && consent) {
        await acceptVoiceConsentAndRefresh();
      }
      return samplesApi.create(file!, {
        type,
        name: name.trim() || file!.name.replace(/\.[^.]+$/, ''),
        description: description.trim() || undefined,
        durationSec: durationSec ?? undefined,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['samples'] });
      toast({ title: 'Audio subido', description: 'Ya lo podés usar como referencia al crear.' });
      reset();
      onOpenChange(false);
    },
    onError: (err) => {
      // Contrato real: subir VOICE sin consentimiento → 403 VOICE_CONSENT_REQUIRED.
      // En vez de mandarte al perfil, mostramos el consentimiento inline acá mismo.
      if (err instanceof ApiError && err.code === 'VOICE_CONSENT_REQUIRED') {
        setConsentRace(true);
        setConsent(false);
      } else {
        toast({ title: 'No pudimos subir el audio', description: toUserMessage(err), variant: 'destructive' });
      }
    },
  });

  const pickFile = (f: File | null) => {
    setFile(f);
    if (f && !name) setName(f.name.replace(/\.[^.]+$/, ''));
    // Duración best-effort para enviarla como metadato
    if (f) {
      try {
        const audio = new Audio(URL.createObjectURL(f));
        audio.addEventListener('loadedmetadata', () => {
          if (Number.isFinite(audio.duration)) setDurationSec(Math.round(audio.duration));
        });
      } catch { /* la duración es opcional */ }
    }
  };

  // Capacidades del plan (E5): una voz es clonación; cualquier otro tipo es un audio de referencia.
  const cloneGate = usePlanGate('VOICE_CLONING');
  const referenceGate = usePlanGate('AUDIO_REFERENCE');
  const voiceCloningLocked = cloneGate.locked;
  const audioReferenceLocked = referenceGate.locked;
  const gate = type === 'VOICE' ? cloneGate : referenceGate;
  const gateCapability = type === 'VOICE' ? 'VOICE_CLONING' : 'AUDIO_REFERENCE';
  const lockedReason = type === 'VOICE' ? (voiceCloningLocked ? LOCK_REASON.VOICE_CLONING : null) : (audioReferenceLocked ? LOCK_REASON.AUDIO_REFERENCE : null);
  const valid = !!file && !lockedReason && (!showConsentCard || consent);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-h-[90vh] gap-3 overflow-y-auto border-border/70 bg-surface max-sm:max-h-[96dvh] max-sm:p-4 sm:max-w-lg sm:gap-4">
        <DialogHeader>
          <DialogTitle className="font-display">Subir audio</DialogTitle>
          <DialogDescription>
            Audio de hasta 50 MB. Beatboxes marcan el ritmo; melodías sirven de referencia.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 max-sm:space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || uploadMutation.isPending) return;
            uploadMutation.mutate();
          }}
        >
          {/* Selector de archivo */}
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            aria-hidden
            tabIndex={-1}
          />
          {/* Selector de audio con el mismo estilo que el área de portada de «Nuevo proyecto»: tarjeta punteada, aro con círculo e ícono dorado */}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={cn(
              'flex aspect-video w-full cursor-pointer flex-col items-center justify-center gap-4 overflow-hidden rounded-[28px_28px_14px_14px] border-[1.5px] border-dashed p-6 text-center transition-colors max-sm:aspect-auto max-sm:flex-row max-sm:gap-3 max-sm:p-3 max-sm:text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
              file ? 'border-amber/50 bg-amber/5' : 'border-line bg-[var(--m-input)] hover:border-amber/40'
            )}
            aria-label="Elegir archivo de audio"
          >
            {/* Núcleo de voz (igual que el estado vacío del Estudio de letras): aro tenue y círculo de voz con el ícono dorado */}
            <span aria-hidden className="relative block size-24 shrink-0 max-sm:size-14">
              <svg className="absolute inset-0 size-full" viewBox="0 0 96 96" fill="none">
                <circle cx="48" cy="48" r="44" stroke="var(--m-faint)" strokeWidth="3" />
              </svg>
              <span className="absolute inset-[21%] flex items-center justify-center rounded-full bg-voice">
                <Upload className="h-[26px] w-[26px] text-gold max-sm:h-4 max-sm:w-4" />
              </span>
            </span>
            <span className="flex min-w-0 flex-col items-center gap-4 max-sm:items-start max-sm:gap-0.5">
            {file ? (
              <>
                <span className="max-w-full truncate font-display text-[19px] leading-tight font-semibold text-foreground max-sm:text-base">{file.name}</span>
                <span className="max-w-xs text-sm text-muted-foreground">
                  {(file.size / (1024 * 1024)).toFixed(1)} MB
                  {durationSec ? ` · ${formatDuration(durationSec)}` : ''} · tocá para cambiar
                </span>
              </>
            ) : (
              <>
                <span className="max-w-[250px] font-display text-[19px] leading-tight font-semibold text-foreground max-sm:text-base">Archivo de audio</span>
                <span className="max-w-xs text-sm text-muted-foreground max-sm:text-xs">Tocá para elegir un audio (MP3, WAV, M4A…)</span>
              </>
            )}
            </span>
          </button>

          <Field label="Tipo" htmlFor="sample-type">
            <Select value={type} onValueChange={(v) => setType(v as SampleType)}>
              <SelectTrigger id="sample-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SAMPLE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {lockedReason && (
            <div role="note" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-xs leading-relaxed text-amber-strong">
              <RequiredPlanBadge capability={gateCapability} />
              <span>{gate.copy?.message ?? lockedReason}</span>
              <button type="button" className="font-semibold underline underline-offset-4" onClick={() => { onOpenChange(false); gate.prompt(); }}>Ver planes</button>
            </div>
          )}

          {type === 'VOICE' && (
            <p className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              Las muestras de voz se usan para cantar con tu timbre. Requieren la autorización de uso de voz aceptada (contrato real del backend).
            </p>
          )}

          {showConsentCard && (
            <VoiceConsentCard id="upload-voice-consent" checked={consent} onCheckedChange={setConsent} />
          )}

          <Field label="Nombre" htmlFor="sample-name">
            <Input
              id="sample-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej.: Beatbox rápido 120bpm"
              maxLength={120}
            />
          </Field>

          <Field label="Descripción" htmlFor="sample-desc" optional>
            <Textarea
              id="sample-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="¿Qué tiene de particular este audio?"
              maxLength={500}
              className="min-h-20 max-sm:min-h-14"
            />
          </Field>

          <DialogFooter className="max-sm:flex-row max-sm:justify-end">
            <Button type="button" variant="outline" className="rounded-full max-sm:flex-1" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground max-sm:flex-1" disabled={!valid || uploadMutation.isPending}>
              {uploadMutation.isPending && (
                <span className="mr-1 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" aria-hidden />
              )}
              Subir
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Edición de sample (PATCH /samples/:id: nombre / tipo / descripción) ── */
function EditSampleDialog({ sample, onOpenChange }: { sample: UserSample; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const consentAccepted = useAuthStore((s) => !!s.user?.voiceConsentAcceptedAt);

  const [name, setName] = useState(sample.name);
  const [type, setType] = useState<SampleType>(
    (SAMPLE_TYPES as readonly string[]).includes(sample.type) ? (sample.type as SampleType) : 'OTHER'
  );
  const [description, setDescription] = useState(sample.description ?? '');
  const [consent, setConsent] = useState(false);
  const [consentRace, setConsentRace] = useState(false);

  const showConsentCard = consentNeeded(type, consentAccepted, consentRace);

  const updateMutation = useMutation({
    mutationFn: async () => {
      // Cambiar a VOICE sin consentimiento → mismo flujo inline que la subida.
      if (showConsentCard && consent) {
        await acceptVoiceConsentAndRefresh();
      }
      return samplesApi.update(sample.id, {
        name: name.trim(),
        description: description.trim() || null,
        type,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['samples'] });
      toast({ title: 'Audio actualizado' });
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'VOICE_CONSENT_REQUIRED') {
        setConsentRace(true);
        setConsent(false);
      } else {
        toast({ title: 'No pudimos guardar los cambios', description: toUserMessage(err), variant: 'destructive' });
      }
    },
  });

  const valid = name.trim().length > 0 && (!showConsentCard || consent);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border/70 bg-surface sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Editar audio</DialogTitle>
          <DialogDescription>
            Cambiale el nombre, el tipo o la descripción. El archivo de audio queda tal cual está.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || updateMutation.isPending) return;
            updateMutation.mutate();
          }}
        >
          <Field label="Nombre" htmlFor="edit-sample-name">
            <Input
              id="edit-sample-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Ej.: Beatbox rápido 120bpm"
            />
          </Field>

          <Field label="Tipo" htmlFor="edit-sample-type">
            <Select value={type} onValueChange={(v) => setType(v as SampleType)}>
              <SelectTrigger id="edit-sample-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SAMPLE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {type === 'VOICE' && !consentAccepted && (
            <p className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              Para cambiar el tipo a Voz necesitás aceptar la autorización de uso de voz (contrato real del backend).
            </p>
          )}

          {showConsentCard && (
            <VoiceConsentCard id="edit-voice-consent" checked={consent} onCheckedChange={setConsent} />
          )}

          <Field label="Descripción" htmlFor="edit-sample-desc" optional>
            <Textarea
              id="edit-sample-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="¿Qué tiene de particular este audio?"
              maxLength={500}
              className="min-h-20"
            />
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" disabled={!valid || updateMutation.isPending}>
              {updateMutation.isPending && (
                <span className="mr-1 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" aria-hidden />
              )}
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
