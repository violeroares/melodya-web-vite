
/**
 * Recuperación de una generación fallida (E4): aviso al volver al creador, panel de la composición recuperada y selector de otro origen.
 * Solo presentación: las reglas viven en `recovery-model.ts` y el estado en `use-recovery-session.ts`. Sin términos técnicos.
 */

import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArchiveRestore, CircleAlert, History, Loader2, RefreshCw, Sparkles, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { songsApi } from '@/lib/api';
import { formatRelative } from '@/hooks';
import { cn } from '@/lib/utils';
import type { CapabilityLocks } from '@/lib/capabilities';
import type { OriginMode, OtherOrigin, RecoverySession } from '@/lib/recovery-store';
import type { Generation, GenerationRecovery, Song } from '@/types';
import { VersionNotes } from './VersionSourcePicker';
import { remixAccess } from './remix-source';
import { REMIX_BLOCKED_DESCRIPTION, REMIX_BLOCKED_DISCARDED, REMIX_BLOCKED_TITLE, bannerMessage, describeTarget, effectiveDestination, notRetryableText, type DecisionOption } from './recovery-model';
import type { HydrationNote } from './version-source';
import type { RecoveryProblem } from './use-recovery-session';

// `min-w-0 max-w-full break-words`: el aviso nunca ensancha su contenedor (ni con un texto largo ni con botones largos).
const CARD = 'mb-5 min-w-0 max-w-full break-words rounded-[28px] bg-surface p-4 text-sm sm:p-5';
// Los botones del aviso pueden partirse en varias líneas en pantallas angostas.
const BTN = 'h-auto min-h-9 max-w-full whitespace-normal rounded-full py-2 text-left';
const PRIMARY = 'h-auto max-w-full whitespace-normal rounded-full py-2 text-left gradient-warm text-primary-foreground hover:text-primary-foreground';

/* ───────────── Aviso al volver al creador ───────────── */

export function RecoveryBanner({ generation, editorHasWork, busy, onRecover, onDismiss }: {
  generation: Generation;
  /** Hay una composición en el editor: recuperar la reemplazaría (el creador pide confirmación). */
  editorHasWork: boolean;
  busy: boolean;
  onRecover: () => void;
  onDismiss: () => void;
}) {
  return (
    <section role="region" aria-label="Recuperar tu última canción" data-testid="recovery-banner" className={cn(CARD, 'flex flex-col gap-3 sm:flex-row sm:items-center sm:rounded-full sm:py-3 sm:pr-3 sm:pl-5')}>
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        <History className="mt-0.5 h-5 w-5 shrink-0 text-amber-strong sm:mt-0" aria-hidden />
        <p className="min-w-0 flex-1">
          <span className="font-semibold">No pudimos crear tu última canción</span> ({formatRelative(generation.createdAt)}). {bannerMessage(generation)}{' '}
          Podés recuperar lo que habías armado, ajustarlo y volver a intentarlo.
          {editorHasWork && <span className="block text-xs text-muted-foreground">Recuperarla reemplaza lo que estás armando ahora.</span>}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button className={PRIMARY} disabled={busy} onClick={onRecover}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Undo2 className="mr-2 h-4 w-4" aria-hidden />}
          Recuperar composición
        </Button>
        <Button variant="ghost" className={BTN} disabled={busy} onClick={onDismiss}>Descartar y empezar de cero</Button>
      </div>
    </section>
  );
}

/* ───────────── Remix bloqueado: pantalla compacta, sin planetas ───────────── */

/** El origen de un Remix de otra persona ya no está autorizado: no se carga nada de esa generación. Solo se vuelve a Mi actividad o se empieza desde cero. */
export function RecoveryBlocked({ discardedDraft, onActivity, onFresh }: { discardedDraft: boolean; onActivity: () => void; onFresh: () => void }) {
  return (
    <div role="alert" data-testid="recovery-blocked" className="view-in mx-auto flex w-full max-w-xl flex-col items-start gap-3 rounded-2xl border border-border/70 bg-surface p-5 sm:p-6">
      <CircleAlert className="h-6 w-6 text-amber-strong" aria-hidden />
      <h1 className="font-display text-xl font-extrabold">{REMIX_BLOCKED_TITLE}</h1>
      <p className="text-sm text-muted-foreground">{REMIX_BLOCKED_DESCRIPTION}</p>
      {discardedDraft && <p className="text-xs text-muted-foreground">{REMIX_BLOCKED_DISCARDED}</p>}
      <div className="mt-1 flex flex-wrap gap-2">
        <Button type="button" className={PRIMARY} onClick={onActivity}>Volver a Mi actividad</Button>
        <Button type="button" variant="outline" className={BTN} onClick={onFresh}>Crear canción desde cero</Button>
      </div>
    </div>
  );
}

/* ───────────── Lo indispensable de la composición recuperada ─────────────
 * Una vez cargados los planetas, el creador vuelve a su diseño habitual: NO hay tarjeta permanente de «recuperada» (la confirmación es un aviso
 * transitorio que dibuja el creador). Este bloque solo aparece si hay algo que el usuario DEBE ver o decidir —un destino que ya no está
 * disponible, una letra retenida o una referencia que falta— y entonces es una tira compacta; si no hay nada, no renderiza nada. */

const STRIP = 'mb-3 min-w-0 max-w-full break-words rounded-2xl bg-surface px-3 py-2.5 text-xs sm:text-sm';
const SMALL = 'h-auto min-h-7 max-w-full whitespace-normal rounded-full px-3 py-1 text-left text-xs';

export interface RecoveryPanelProps {
  status: 'idle' | 'loading' | 'ready' | 'error';
  recovery: GenerationRecovery | null;
  problem: RecoveryProblem | null;
  retriedBy: string | null;
  session: RecoverySession;
  notes: HydrationNote[];
  restoring: boolean;
  onChoose: (choice: 'SAME' | 'NEW_SONG') => void;
  onRestore: () => void;
  onPickOrigin: () => void;
  onHeld: (decision: 'KEEP' | 'DROP') => void;
  /** Cierra la recuperación (solo desde los estados de carga o error: con la composición armada se usa «Empezar de cero» del encabezado). */
  onDiscard: () => void;
  /** Hay un pedido de reintento sin confirmar: no se puede cerrar la recuperación sin ocultarlo. */
  pendingBlocks: boolean;
  onViewRetry: (generationId: string) => void;
  onReload: () => void;
  onRetryNote: () => void;
  onRecreateVoice: (sampleId: string) => void;
}

export function RecoveryPanel(p: RecoveryPanelProps) {
  const { recovery, session } = p;

  if (p.status === 'loading' || p.status === 'idle') {
    return (
      <section role="status" data-testid="recovery-panel" className={cn(STRIP, 'flex items-center gap-2')}>
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-strong" aria-hidden />
        <p className="min-w-0 flex-1">Recuperando tu composición…</p>
        <Button variant="ghost" size="sm" className={SMALL} disabled={p.pendingBlocks} onClick={p.onDiscard}>Cerrar</Button>
      </section>
    );
  }

  if (p.status === 'error' || !recovery) {
    const retried = p.problem?.kind === 'not-retryable' && p.problem.reason === 'ALREADY_RETRIED';
    const text = p.problem?.kind === 'not-retryable' ? (retried ? 'Esta canción ya se volvió a intentar (quizás desde otro dispositivo).' : notRetryableText(p.problem.reason))
      : p.problem?.kind === 'gone' ? 'No encontramos esa generación: puede que ya no exista.'
        : 'No pudimos recuperar tu composición por un problema temporal. No se perdió nada.';
    return (
      <section role="alert" data-testid="recovery-panel" className={STRIP}>
        <p className="flex items-start gap-2"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-strong" aria-hidden /> <span className="min-w-0 flex-1">{text}</span></p>
        <div className="mt-2 flex flex-wrap gap-2">
          {retried && p.retriedBy && <Button className={cn(PRIMARY, 'min-h-7 px-3 py-1 text-xs')} onClick={() => p.onViewRetry(p.retriedBy as string)}>Ver ese intento</Button>}
          {p.problem?.kind === 'temporary' && <Button variant="outline" className={SMALL} onClick={p.onReload}><RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Reintentar</Button>}
          <Button variant="ghost" className={SMALL} disabled={p.pendingBlocks} onClick={p.onDiscard}>Cerrar la recuperación</Button>
        </div>
      </section>
    );
  }

  const decision = describeTarget(recovery);
  const dest = effectiveDestination(session, recovery);
  const heldLyrics = recovery.held.find((h) => h.field === 'LYRICS');
  const askHeld = Boolean(heldLyrics) && session.heldDecision === null;
  const warnings = p.notes.filter((n) => n.tone === 'warning');
  if (!decision.needsDecision && !askHeld && warnings.length === 0) return null; // nada que decidir ni advertir: el creador queda como siempre

  const chosenNewSong = dest === 'NEW_SONG';
  const chosenOther = dest === 'OTHER_ORIGIN';

  return (
    <section role="region" aria-label="Para terminar de recuperar tu composición" data-testid="recovery-panel" className={STRIP}>
      {/* Destino: solo si ya no está disponible (hay que decidir) */}
      {decision.needsDecision && (
        <div data-testid="recovery-target">
          <p role="alert" className="flex items-start gap-2"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-strong" aria-hidden /> <span className="min-w-0 flex-1">{decision.summary}</span></p>
          <div className="mt-2 flex flex-wrap gap-2">
            {decision.options.includes('RESTORE') && (
              <Button variant="outline" className={SMALL} disabled={p.restoring} onClick={p.onRestore}>
                {p.restoring ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" aria-hidden />} Restaurar la canción
              </Button>
            )}
            {decision.options.includes('NEW_SONG') && (
              <Button variant={chosenNewSong ? 'default' : 'outline'} className={SMALL} aria-pressed={chosenNewSong} onClick={() => p.onChoose('NEW_SONG')}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {chosenNewSong ? 'Canción nueva ✓' : 'Crear una canción nueva'}
              </Button>
            )}
            {decision.options.includes('OTHER_ORIGIN') && (
              <Button variant={chosenOther ? 'default' : 'outline'} className={SMALL} aria-pressed={chosenOther} onClick={p.onPickOrigin}>
                {chosenOther && session.otherOrigin ? 'Cambiar el otro origen' : 'Elegir otro origen'}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Letra retenida: nunca se carga sola; desaparece en cuanto el usuario decide */}
      {askHeld && heldLyrics && (
        <div className={cn(decision.needsDecision && 'mt-3')} data-testid="recovery-held">
          <p role="alert" className="flex items-start gap-2"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-strong" aria-hidden /> <span className="min-w-0 flex-1">No podemos confirmar de dónde viene la letra de este remix, así que no la cargamos. ¿La querés como tuya?</span></p>
          <p className="mt-1 line-clamp-1 border-l-2 border-border pl-2 text-muted-foreground">{heldLyrics.text}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="outline" className={SMALL} onClick={() => p.onHeld('KEEP')}>Conservar como mía</Button>
            <Button variant="outline" className={SMALL} onClick={() => p.onHeld('DROP')}>No usar esta letra</Button>
          </div>
        </div>
      )}

      {/* Referencias que faltan, voz vencida…: solo las advertencias */}
      <VersionNotes notes={warnings} loading={false} onRetry={p.onRetryNote} onRecreateVoice={p.onRecreateVoice} />
    </section>
  );
}

/* ───────────── Elegir otro origen para un remix ───────────── */

export function OriginPickerDialog({ open, onOpenChange, locks, current, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locks: CapabilityLocks;
  current: OtherOrigin | null;
  onPick: (origin: OtherOrigin) => void;
}) {
  const [mode, setMode] = useState<OriginMode>(current?.mode ?? 'PROMPT_REUSE');
  const [search, setSearch] = useState('');
  const songsQ = useQuery({ queryKey: ['songs', 'origin-picker'], queryFn: () => songsApi.list({ pageSize: 50 }), enabled: open, staleTime: 30_000 });
  const access = remixAccess(locks, mode);
  const songs = useMemo<Song[]>(() => {
    const all = (songsQ.data?.items ?? []).filter((s) => Boolean(s.currentVersionId));
    const q = search.trim().toLowerCase();
    return q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all;
  }, [songsQ.data, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-1.5rem)] gap-4 overflow-y-auto border-0 p-4 sm:max-w-lg sm:p-6">
        <DialogHeader>
          <DialogTitle>Elegir otro origen</DialogTitle>
          <DialogDescription>Tus ajustes se conservan. Elegí una de tus canciones: el remix se hace a partir de su versión vigente.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Cómo usar el origen">
          {(['PROMPT_REUSE', 'COVER'] as const).map((m) => (
            <Button key={m} type="button" size="sm" variant={mode === m ? 'default' : 'outline'} className={BTN} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'COVER' ? 'Versionar (usa su audio)' : 'Reutilizar configuración'}
            </Button>
          ))}
        </div>
        {!access.allowed && <p role="alert" className="text-xs text-muted-foreground">{access.reason}</p>}
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar entre tus canciones" aria-label="Buscar entre tus canciones" />
        {songsQ.isLoading && <p className="text-sm text-muted-foreground">Cargando tus canciones…</p>}
        {songsQ.isError && <p role="alert" className="text-sm text-muted-foreground">No pudimos cargar tus canciones. Probá de nuevo en un momento.</p>}
        {!songsQ.isLoading && !songsQ.isError && songs.length === 0 && <p className="text-sm text-muted-foreground">No encontramos canciones con audio para usar como origen.</p>}
        <ul className="space-y-2">
          {songs.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                disabled={!access.allowed}
                onClick={() => { onPick({ songId: s.id, versionId: s.currentVersionId, mode }); onOpenChange(false); }}
                className={cn('flex min-h-12 w-full items-center gap-3 rounded-[24px] border border-border/70 bg-surface-2/40 px-4 py-2 text-left text-sm transition-colors', access.allowed ? 'hover:border-amber/40 hover:bg-surface-2' : 'cursor-not-allowed opacity-60')}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                {current?.songId === s.id && <span className="text-xs text-muted-foreground">Elegida</span>}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
