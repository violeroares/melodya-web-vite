'use client';

/**
 * Estado en vivo de una generación (progreso por jobs, cancelación, resultado). Extraído tal cual del asistente
 * anterior: el flujo de creación cambió, pero el seguimiento de la generación (polling REST como fuente de verdad)
 * es el mismo.
 */

import React, { useRef, useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles, Check, CircleAlert, Mic2, Play, RefreshCw, X, Clock3, Loader2 } from 'lucide-react';
import { navigate } from '@/lib/router';
import { generationApi } from '@/lib/api';
import { startPoller } from '@/lib/api/polling';
import { createGenerationTracker } from './generation-tracker';
import { toUserMessage } from '@/lib/errors';
import { applyGenerationCompleted, useCredits } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/features/library/library-utils';
import { generationFailureMessage } from '@/lib/generation-failure';
import { isVoiceExpiredFailure, voiceSampleIdOf } from '@/features/voice/voice-expiry';
import { VinylDisc } from './VinylDisc';
import { PLANET_DOT, planetIcon } from './SolarSystem';
import type { PlanetId } from './song-model';
import { UNCERTAIN_ACTION, UNCERTAIN_TITLE } from './pending-copy';
import type { Generation } from '@/types';

export type LiveGen =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'running'; generationId: string }
  | { phase: 'done'; generationId: string; songId: string | null }
  | { phase: 'error'; message: string; canRetry: boolean; /** Voz caducada rechazada antes de cobrar: muestra a recrear. */ recreateVoiceId?: string; /** Sin respuesta confiable: el pedido pudo haberse aceptado (se confirma desde el estudio; no se promete reintegro). */ uncertain?: boolean };

/** Un elemento (planeta) de la canción enviada, para la lista «Lo que lleva tu canción». */
export interface SentElement { id: PlanetId; label: string; detail: string }

export function GenerationStatusView({ state, elements, onRetry, onClose, onCompleted, onRecreateVoice, onRecover }: { state: LiveGen; /** Los elementos que llevó la canción (se listan cuando está lista). */ elements?: SentElement[]; onRetry: () => void; onClose: () => void; onCompleted: (songId: string | null) => void; /** Recrear una voz caducada con su muestra original (la lleva al asistente de clonación). */ onRecreateVoice?: (sampleId: string) => void; /** Recupera la composición de una generación FALLIDA desde el servidor (aunque el editor se haya perdido) para editarla y reintentar. */ onRecover?: (generationId: string) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [gen, setGen] = useState<Generation | null>(null);
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Polling REST (fuente de verdad, como manda el backend) + reconciliación por cache
  const generationId = state.phase === 'running' || state.phase === 'done' ? state.generationId : null;
  const completedRef = useRef(onCompleted);
  useEffect(() => {
    completedRef.current = onCompleted;
  }, [onCompleted]);
  useEffect(() => {
    if (!generationId) return;
    const id = generationId;
    let stop = false;

    /* Un solo ciclo en vuelo (nunca se apilan), backoff ante 429 / red / 5xx respetando Retry-After y la pausa de la API general, pausa con la
       pestaña oculta y consulta inmediata al volver (si terminó mientras tanto, se completa ahí). Socket.IO sigue siendo el canal en vivo; este
       seguimiento REST es la fuente de verdad y el respaldo. Los estados de la generación no se tocan (ver generation-tracker.ts). */
    const poller = startPoller({
      baseMs: 2500,
      run: createGenerationTracker({
        fetchGeneration: () => generationApi.get(id),
        isCurrent: () => !stop,
        onUpdate: (current) => setGen(current),
        onCompleted: (current) => {
          /* Misma compuerta que el socket: una sola tanda de invalidaciones por generación completada. */
          applyGenerationCompleted(qc, { generationId: id, songId: current.songId });
          completedRef.current(current.songId);
        },
        onUnsuccessful: () => {
          void qc.invalidateQueries({ queryKey: ['credits'] });
        },
      }),
      onError: (err) => {
        if (!stop) setError(toUserMessage(err));
      },
      onRecovered: () => {
        if (!stop) setError('');
      },
    });
    return () => {
      stop = true;
      poller.stop();
    };
  }, [generationId, qc]);

  const musicJob = gen?.jobs?.find((j) => j.task === 'MUSIC');
  const lyricsJob = gen?.jobs?.find((j) => j.task === 'LYRICS');
  const activeJob = lyricsJob?.status === 'PROCESSING' ? lyricsJob : musicJob;
  const progress = activeJob?.progress ?? 0;
  const { data: credits } = useCredits();

  const phaseLabel =
    gen?.status === 'PENDING'
      ? 'Preparando tu canción…'
      : lyricsJob?.status === 'PENDING' || lyricsJob?.status === 'PROCESSING'
        ? 'Escribiendo la letra…'
        : musicJob?.status === 'PROCESSING'
          ? progress >= 90
            ? 'Procesando el audio…'
            : 'Componiendo tu canción…'
          : gen?.status === 'COMPLETED'
            ? '¡Tu canción está lista!'
            : gen?.status === 'CANCELED'
              ? 'Generación cancelada'
              : 'Generando…';

  const cancel = async () => {
    if (!gen) return;
    try {
      await generationApi.cancel(gen.id);
      toast({ title: 'Generación cancelada', description: 'Te devolvimos las fichas.' });
      void qc.invalidateQueries({ queryKey: ['credits'] });
      onRetry();
    } catch (err) {
      toast({ title: 'No se pudo cancelar', description: toUserMessage(err), variant: 'destructive' });
    }
  };

  if (state.phase === 'creating') {
    return (
      <div className="view-in mx-auto flex w-full max-w-md min-w-0 flex-col items-center gap-3.5 py-4 text-center sm:py-8">
        <StatusHeading label="Generando" title="Enviando tu idea a Melodya…" />
        <GenerationArt mode="running" size="sm" />
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <StatusShell>
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
            <CircleAlert className="h-8 w-8 text-destructive" aria-hidden />
          </div>
          <h3 className="font-display text-xl font-bold">{state.uncertain ? UNCERTAIN_TITLE : 'No pudimos generar tu canción'}</h3>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{state.message}</p>
          <div className="mt-2 flex gap-3">
            <Button variant="outline" className="rounded-full" onClick={onClose}>Volver al estudio</Button>
            {state.recreateVoiceId && onRecreateVoice && (
              <Button className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" onClick={() => onRecreateVoice(state.recreateVoiceId as string)}>
                <Mic2 className="mr-2 h-4 w-4" aria-hidden /> Recrear mi voz
              </Button>
            )}
            {state.canRetry && (
              <Button className=" rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" onClick={onRetry}>
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> {state.uncertain ? UNCERTAIN_ACTION : 'Intentar de nuevo'}
              </Button>
            )}
          </div>
        </div>
      </StatusShell>
    );
  }

  if (state.phase === 'done' && gen?.status === 'COMPLETED') {
    return (
      /* Como «Tu canción está lista» del prototipo: columna centrada sin tarjeta, arte de 200 px, lista de elementos y botón de ancho completo. */
      <div className="view-in mx-auto flex w-full max-w-md min-w-0 flex-col items-center gap-3.5 py-4 text-center sm:py-8">
        <StatusHeading
          label="Lista"
          title="Tu canción está lista"
          subtitle={[gen.requestedTitle || 'Tu nueva canción', elements?.find((e) => e.id === 'style')?.detail].filter(Boolean).join(' · ')}
        />
        <GenerationArt mode="done" size="sm" onListen={state.songId ? () => navigate(`/songs/${state.songId}`) : undefined} />
        {elements && elements.length > 0 && <SentElements elements={elements} />}
        <Button variant="outline" className="mt-1.5 h-11 w-full rounded-[24px] border-[1.5px] border-line text-[15px] font-bold tracking-[0.02em]" onClick={onRetry}>
          Crear otra
        </Button>
      </div>
    );
  }

  const failed = gen?.status === 'FAILED' || gen?.status === 'CANCELED';

  return (
    <StatusShell plain>
      <div className="view-in mx-auto flex w-full max-w-md min-w-0 flex-col items-center gap-3.5 py-4 text-center sm:py-8">
        <StatusHeading
          label={failed ? 'Detenida' : 'Generando'}
          title={failed ? (gen?.status === 'CANCELED' ? 'Generación cancelada' : 'La generación falló') : phaseLabel}
          subtitle={
            gen?.status === 'FAILED'
              ? generationFailureMessage(gen.error ?? musicJob?.error)
              : gen?.status === 'CANCELED'
                ? 'Las fichas vuelven a tu saldo automáticamente.'
                : 'Puede tomar un minuto. Dejá esta ventana abierta o seguí navegando: te avisamos cuando esté lista.'
          }
          note={gen?.status === 'FAILED' ? 'Las fichas vuelven a tu saldo automáticamente.' : undefined}
        />
        <GenerationArt mode={failed ? 'failed' : 'running'} size="sm" />

        {!failed && (
          <>
            {/* Progreso por jobs */}
            <div className="w-full space-y-3 rounded-[28px_28px_14px_14px] border-[1.5px] border-border bg-[var(--m-input)] px-4 py-3.5 text-left">
              {lyricsJob && (
                <JobRow label="Letra" status={lyricsJob.status} progress={lyricsJob.progress} />
              )}
              <JobRow label="Música" status={musicJob?.status ?? 'PENDING'} progress={musicJob?.progress ?? 0} />
            </div>
            <div className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-gold" aria-hidden />
              Costo: {gen?.creditsCost ?? '…'} fichas · Saldo: {credits?.balance ?? '…'}
            </div>
            <Button variant="outline" className="h-11 w-full rounded-[24px] border-[1.5px] border-line text-[15px] font-bold tracking-[0.02em]" onClick={() => setConfirmCancel(true)}>
              <X className="mr-2 h-4 w-4" aria-hidden /> Cancelar generación
            </Button>
            <ConfirmDialog
              open={confirmCancel}
              onOpenChange={setConfirmCancel}
              title="¿Cancelar la generación?"
              description="Tu canción deja de generarse y te devolvemos las fichas."
              actionLabel="Cancelar generación"
              onConfirm={() => {
                setConfirmCancel(false);
                void cancel();
              }}
            />
          </>
        )}

        {failed && (
          <div className="flex gap-3">
            <Button variant="outline" className="rounded-full" onClick={onClose}>Volver</Button>
            {/* La voz caducó durante la generación (se devolvieron las fichas): se ofrece recrearla con su muestra original. */}
            {onRecreateVoice && gen?.status === 'FAILED' && isVoiceExpiredFailure(gen.error ?? musicJob?.error) && voiceSampleIdOf(gen) && (
              <Button className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" onClick={() => onRecreateVoice(voiceSampleIdOf(gen) as string)}>
                <Mic2 className="mr-2 h-4 w-4" aria-hidden /> Recrear mi voz
              </Button>
            )}
            {/* FALLIDA: la composición se reconstruye desde el servidor (no depende del estado del editor). CANCELADA: vuelve al editor como siempre. */}
            {onRecover && gen?.status === 'FAILED' ? (
              <Button className="rounded-full" onClick={() => onRecover(gen.id)}>
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Editar y reintentar
              </Button>
            ) : (
              <Button className="rounded-full" onClick={onRetry}>
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Intentar de nuevo
              </Button>
            )}
          </div>
        )}
      </div>
    </StatusShell>
  );
}

/* «Lo que lleva tu canción» (design-V2 · Crear, «Tu canción está lista · 6 elementos»): una fila por planeta con su punto de color, el nombre y el resumen. */
function SentElements({ elements }: { elements: SentElement[] }) {
  return (
    <div className="w-full max-w-md text-left">
      <p className="mb-2 flex items-center gap-2.5 text-[13px] font-bold tracking-[0.08em] text-label uppercase">
        <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-[var(--m-accent)]" />
        Lo que lleva tu canción
      </p>
      <ul className="rounded-[28px_28px_14px_14px] border-[1.5px] border-border bg-[var(--m-input)] px-3.5 py-1" aria-label="Elementos de tu canción">
        {elements.map((el) => {
          const Icon = planetIcon(el.id);
          return (
            <li key={el.id} className="flex min-h-[52px] items-center gap-3.5 border-b border-separator py-2 last:border-b-0">
              <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full', PLANET_DOT[el.id])} aria-hidden>
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block text-[15px] font-bold">{el.label}</span>
                <span className="block truncate text-[13px] text-muted-foreground">{el.detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* Encabezado como el de «Generando» del prototipo (design-V2): etiqueta chica con el punto dorado, título en la fuente de títulos y bajada gris. */
function StatusHeading({ label, title, subtitle, note }: { label: string; title: string; subtitle?: string; note?: string }) {
  return (
    <div className="space-y-2 text-center">
      <p className="flex items-center justify-center gap-2 text-[13px] font-bold tracking-[0.08em] text-label uppercase">
        <span aria-hidden className="size-[7.5px] shrink-0 rounded-full bg-gold" />
        {label}
      </p>
      <h3 className="font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl">{title}</h3>
      {subtitle && <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">{subtitle}</p>}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/* Arte animado del prototipo «Generar canción · animación»: dos anillos tenues, un arco dorado que gira, un punto naranja y otro claro que orbitan, y el núcleo de voz al centro.
   Al terminar, el núcleo pasa a ser el botón naranja «Escuchar». */
function GenerationArt({ mode, onListen, size = 'md' }: { mode: 'running' | 'failed' | 'done'; onListen?: () => void; size?: 'sm' | 'md' }) {
  const spin = mode === 'running';
  const orbit = (seconds: number, reverse = false) => ({ transformOrigin: '150px 150px', animationDuration: `${seconds}s`, animationDirection: reverse ? ('reverse' as const) : ('normal' as const), animationTimingFunction: 'linear' });
  return (
    <div className={cn('relative mx-auto aspect-square w-full', size === 'sm' ? 'max-w-[200px] sm:max-w-[240px]' : 'max-w-[300px]')}>
      {/* Disco de vinilo que gira mientras se genera (como el que se forma en «Generar canción · animación»): surcos, brillo que da vueltas y la etiqueta naranja con su agujero */}
      {spin && (
        <div
          aria-hidden
          className="animate-in fade-in zoom-in-50 absolute inset-[3.33%] duration-700 [animation-fill-mode:backwards]"
        >
          <VinylDisc
            className="absolute inset-0 animate-spin motion-reduce:animate-none"
            style={{ animationDuration: '3.2s', animationTimingFunction: 'linear' }}
          />
        </div>
      )}
      <svg className="absolute inset-0 size-full" viewBox="0 0 300 300" fill="none" aria-hidden>
        <circle cx="150" cy="150" r="140" stroke="var(--m-faint)" strokeWidth="1.5" />
        <circle cx="150" cy="150" r="104" stroke="var(--m-faint)" strokeWidth="1.5" />
        <circle
          cx="150" cy="150" r="140" stroke="var(--m-gold)" strokeWidth="3" strokeDasharray="230 650" strokeLinecap="round"
          className={cn(spin && 'animate-spin motion-reduce:animate-none')} style={orbit(8)}
        />
        <g className={cn(spin && 'animate-spin motion-reduce:animate-none')} style={orbit(5, true)}>
          <circle cx="150" cy="46" r="9" fill="var(--m-accent)" />
        </g>
        <g className={cn(spin && 'animate-spin motion-reduce:animate-none')} style={orbit(11)}>
          <circle cx="290" cy="150" r="7" fill="var(--foreground)" />
        </g>
      </svg>
      {mode === 'done' ? (
        <button
          type="button"
          onClick={onListen}
          disabled={!onListen}
          aria-label="Escuchar"
          className="absolute top-[26.67%] left-[26.67%] flex size-[46.67%] flex-col items-center justify-center rounded-full bg-primary text-[#131C33] transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground enabled:hover:scale-[1.03]"
        >
          <Play className="ml-1 size-[38%] fill-current" aria-hidden />
        </button>
      ) : spin ? null : (
        <div className="absolute top-[26.67%] left-[26.67%] flex size-[46.67%] items-center justify-center rounded-full bg-voice">
          {mode === 'failed' ? (
            <CircleAlert className="h-[35%] w-[35%] text-destructive" aria-hidden />
          ) : (
            <svg className="h-[37%] w-[37%]" viewBox="0 0 24 24" aria-hidden>
              <path d="M12 2C12 8 16 12 22 12C16 12 12 16 12 22C12 16 8 12 2 12C8 12 12 8 12 2Z" fill="var(--m-gold)" />
            </svg>
          )}
        </div>
      )}
    </div>
  );
}

function StatusShell({ children, plain }: { children: React.ReactNode; plain?: boolean }) {
  if (plain) return <>{children}</>;
  return (
    <div className="view-in mx-auto w-full max-w-3xl rounded-cover border border-border/70 bg-surface p-6 sm:p-10">
      {children}
    </div>
  );
}

function JobRow({ label, status, progress }: { label: string; status: string; progress: number }) {
  const done = status === 'COMPLETED';
  const active = status === 'PROCESSING';
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full text-xs',
          done ? 'bg-gold text-[#131C33]' : active ? 'bg-[var(--m-accent)] text-[#131C33]' : 'border-[1.5px] border-line text-muted-foreground'
        )}
        aria-hidden
      >
        {done ? <Check className="h-4 w-4" /> : active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock3 className="h-3.5 w-3.5" />}
      </span>
      <div className="flex-1">
        <div className="mb-1.5 flex items-center justify-between text-[13px]">
          <span className={cn('font-bold', done || active ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
          <span className="tabular-nums text-muted-foreground">{done ? '100%' : active ? `${progress}%` : 'esperando'}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--m-faint)]">
          <div
            className={cn('h-full rounded-full transition-all duration-700', 'bg-gold')}
            style={{ width: `${done ? 100 : progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}
