
/**
 * MELODYA WEB — ExportQueueDialog: guarda la cola de reproducción actual como
 * COLECCIÓN de canciones usando el contrato real de POST /lyric-personas
 * ({ name, description, songIds[] }).
 *
 * Regla REAL del backend (v0.13): las referencias de songIds deben ser
 * canciones PROPIAS del usuario (si no: 422 INVALID_SONG_REFERENCE). Por eso
 * el diálogo distingue: tus canciones (se guardan) y las de otros creadores
 * (quedan en la vista previa, con nota, pero fuera de la colección).
 * CLIENT-ONLY, sin endpoints inventados.
 */
import React, { useMemo, useState } from 'react';
import { BookmarkPlus, Loader2, Music4, Users } from 'lucide-react';
import { usePlayerStore } from '@/stores/player';
import { useAuthStore } from '@/stores/auth';
import { songwritersApi } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { toUserMessage } from '@/lib/errors';
import { navigate } from '@/lib/router';
import { queryClient } from '@/lib/query-client';
import { CoverArt } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const NAME_MAX = 80;
const DESC_MAX = 500;
const PREVIEW_MAX = 6;
/* El contrato real limita las referencias: máximo 20 canciones por colección. */
const SONG_REFS_MAX = 20;
const DEFAULT_DESC = 'Cola guardada desde el reproductor.';

function defaultName(): string {
  const d = new Date();
  const fecha = d.toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
  return `Mi cola · ${fecha}`;
}

export function ExportQueueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queue = usePlayerStore((s) => s.queue);
  const track = usePlayerStore((s) => s.track);
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  /* Canciones propias en orden de cola, sin repetir id (las referencias de la
   * colección son un conjunto validado por el backend) y acotadas al máximo
   * del contrato (20 referencias). */
  const ownSongs = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof queue = [];
    for (const t of queue) {
      if (!t.own || !t.id || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= SONG_REFS_MAX) break;
    }
    return out;
  }, [queue]);

  /* De otros creadores: se muestran en la vista previa con nota. */
  const foreignCount = useMemo(() => new Set(queue.filter((t) => !t.own).map((t) => t.id)).size, [queue]);

  const preview = queue.slice(0, PREVIEW_MAX);
  const nameError = touched && name.trim().length === 0 ? 'Ponele un nombre a la colección.' : null;
  const descError = touched && description.trim().length === 0 ? 'Contá en una línea de qué va la colección.' : null;
  const ownTotal = useMemo(() => new Set(queue.filter((t) => t.own).map((t) => t.id)).size, [queue]);

  const reset = () => {
    setName('');
    setDescription('');
    setTouched(false);
    setSaving(false);
  };

  const close = (v: boolean) => {
    if (saving) return;
    if (!v) reset();
    onOpenChange(v);
  };

  const save = async () => {
    setTouched(true);
    const trimmed = name.trim();
    const trimmedDesc = description.trim();
    if (!trimmed || !trimmedDesc) return;
    if (!user) {
      toast({
        title: 'Ingresá para guardar colecciones',
        description: 'Creá tu cuenta gratis y guardá tus colas para escucharlas cuando quieras.',
      });
      onOpenChange(false);
      navigate('/login');
      return;
    }
    if (!ownSongs.length) return;
    setSaving(true);
    try {
      const persona = await songwritersApi.create({
        name: trimmed.slice(0, NAME_MAX),
        description: trimmedDesc.slice(0, DESC_MAX),
        songIds: ownSongs.map((t) => t.id),
      });
      void queryClient.invalidateQueries({ queryKey: ['songwriters'] });
      toast({
        title: 'Colección guardada 🎧',
        description: `“${persona.name}” quedó en Biblioteca → Letristas con ${ownSongs.length} ${ownSongs.length === 1 ? 'canción' : 'canciones'}.`,
      });
      reset();
      onOpenChange(false);
    } catch (err) {
      toast({
        title: 'No pudimos guardar la colección',
        description: toUserMessage(err),
        variant: 'destructive',
      });
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      {/* Layout flex con footer fijo: en pantallas bajas la vista previa scrollea
          (min-h-0 flex-1) y “Guardar colección” queda siempre visible/accesible. */}
      {/* z por encima del reproductor expandido (z-70) y de su cola (z-80): si no, el diálogo queda oculto detrás y bloquea la pantalla */}
      <DialogContent overlayClassName="z-[85]" className="z-[90] flex flex-col rounded-[28px_28px_14px_14px] border-border/70 bg-surface/98 sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2.5 font-display text-lg">
            <BookmarkPlus className="h-5 w-5 text-amber-strong" aria-hidden />
            Guardar la cola como colección
          </DialogTitle>
          <DialogDescription>
            {queue.length === 0
              ? 'La cola está vacía: reproducí algo primero.'
              : ownSongs.length > 0
                ? `Se guardan tus ${ownSongs.length} ${ownSongs.length === 1 ? 'canción' : 'canciones'} de esta cola, en orden. La vas a encontrar en Biblioteca → Letristas.`
                : 'Esta cola solo tiene canciones de otros creadores.'}
          </DialogDescription>
        </DialogHeader>

        {queue.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            {/* Vista previa compacta de la cola (propias se guardan, otras no):
                región scrolleable para que el formulario quede a la vista. */}
            <ul className="queue-export-preview min-h-0 flex-shrink" aria-label="Vista previa de la colección">
              {preview.map((t) => (
                <li key={`${t.id}-${t.audioUrl}`} className={cn(!t.own && 'opacity-60')}>
                  <CoverArt id={t.id} src={t.coverUrl} alt="" className="h-8 w-8 shrink-0" rounded="rounded-md" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {t.title}
                    <span className="ml-2 text-xs text-muted-foreground">{t.artist}</span>
                  </span>
                  {track && t.id === track.id && t.audioUrl === track.audioUrl ? (
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-strong">sonando</span>
                  ) : t.own ? (
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-strong/70">se guarda</span>
                  ) : (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground" title="El backend solo acepta referencias a tus propias canciones">
                      de otro creador
                    </span>
                  )}
                </li>
              ))}
              {queue.length > PREVIEW_MAX && (
                <li className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Music4 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  y {queue.length - PREVIEW_MAX} más…
                </li>
              )}
            </ul>

            {ownSongs.length === 0 && (
              <p className="flex shrink-0 items-start gap-2.5 rounded-xl border border-border/70 bg-surface-2/60 p-3 text-xs text-muted-foreground">
                <Users className="mt-0.5 h-4 w-4 shrink-0 text-amber-strong" aria-hidden />
                Las colecciones referencian solo tus canciones (regla del backend). Reproducí tu biblioteca y guardá esa cola,
                o guardá las canciones que te gusten con el corazón ♥.
              </p>
            )}

            {ownSongs.length > 0 && (
              <div className="flex shrink-0 flex-col gap-4">
                <div className="space-y-1.5">
                  <label htmlFor="queue-collection-name" className="text-xs font-semibold text-foreground">
                    Nombre <span className="font-normal text-muted-foreground">(hasta {NAME_MAX})</span>
                  </label>
                  <Input
                    id="queue-collection-name"
                    value={name}
                    onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                    onFocus={() => {
                      if (!name && !touched) setName(defaultName());
                    }}
                    placeholder={defaultName()}
                    aria-invalid={!!nameError}
                    className={cn('rounded-xl bg-background/60', nameError && 'border-destructive/60')}
                    maxLength={NAME_MAX}
                  />
                  {nameError ? (
                    <p className="text-xs text-destructive" role="alert">
                      {nameError}
                    </p>
                  ) : (
                    <p className="text-right text-[10px] tabular-nums text-muted-foreground">{name.length}/{NAME_MAX}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="queue-collection-desc" className="text-xs font-semibold text-foreground">
                    Nota <span className="font-normal text-muted-foreground">(requerida, hasta {DESC_MAX})</span>
                  </label>
                  <Textarea
                    id="queue-collection-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value.slice(0, DESC_MAX))}
                    onFocus={() => {
                      if (!description && !touched) setDescription(DEFAULT_DESC);
                    }}
                    placeholder={DEFAULT_DESC}
                    aria-invalid={!!descError}
                    className={cn('min-h-20 resize-none rounded-xl bg-background/60', descError && 'border-destructive/60')}
                    maxLength={DESC_MAX}
                  />
                  {descError ? (
                    <p className="text-xs text-destructive" role="alert">
                      {descError}
                    </p>
                  ) : (
                    <p className="text-right text-[10px] tabular-nums text-muted-foreground">{description.length}/{DESC_MAX}</p>
                  )}
                </div>

                {ownTotal > SONG_REFS_MAX && (
                  <p className="text-[11px] text-muted-foreground">
                    La colección guarda las primeras {SONG_REFS_MAX} canciones de la cola (máximo del backend); {ownTotal - SONG_REFS_MAX} quedan
                    afuera.
                  </p>
                )}

                {foreignCount > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    {foreignCount} {foreignCount === 1 ? 'canción de otro creador queda' : 'canciones de otros creadores quedan'} fuera de la
                    colección (el backend solo acepta referencias a tus canciones).
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="shrink-0 gap-2 sm:justify-end">
          <Button variant="ghost" onClick={() => close(false)} disabled={saving} className="rounded-full">
            Cancelar
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || ownSongs.length === 0}
            className="rounded-full gradient-warm text-primary-foreground transition-transform active:scale-95"
            aria-label="Guardar la cola como colección"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <BookmarkPlus className="h-4 w-4" aria-hidden />}
            {saving ? 'Guardando…' : 'Guardar colección'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
