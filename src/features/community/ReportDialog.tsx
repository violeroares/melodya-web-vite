
/**
 * MELODYA WEB — ReportDialog: diálogo reutilizable para denunciar contenido
 * de la comunidad (canción, comentario o usuario) — backend v0.18.0.
 *
 * Contrato real (POST /reports, 🔒):
 *   body { targetType: 'SONG'|'COMMENT'|'USER', targetId, reason, description? }
 *   201 → { data: Report } · 409 ya denunciado · 404 · 422 · 400 contenido propio.
 *
 * Patrón de uso (un solo dialog por view):
 *   const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
 *   <ReportDialog open={!!reportTarget} target={reportTarget}
 *                 onOpenChange={(o) => !o && setReportTarget(null)} />
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Copyright, EyeOff, Flag, Loader2, Megaphone, MessageSquareMore, ShieldAlert,
} from 'lucide-react';
import { reportsApi } from '@/lib/api';
import { ApiError } from '@/lib/api/client';
import { toUserMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import type { ReportReason, ReportTargetType } from '@/types';

/** Qué se denuncia: id + nombre visible para el título del dialog
 *  (título de canción, "el comentario de X" o "a X" para usuarios). */
export interface ReportTarget {
  type: ReportTargetType;
  id: string;
  title: string;
}

/* Motivos del backend con su presentation (icono + label + descripción corta). */
const REASONS: Array<{ value: ReportReason; label: string; description: string; icon: typeof Megaphone }> = [
  { value: 'SPAM', label: 'Spam o publicidad', description: 'Publicidad engañosa, links repetidos o promoción fuera de lugar.', icon: Megaphone },
  { value: 'INAPPROPRIATE', label: 'Contenido inapropiado u ofensivo', description: 'Lenguaje, imágenes o temas que no corresponden.', icon: EyeOff },
  { value: 'HARASSMENT', label: 'Acoso o comportamiento abusivo', description: 'Intimidación, odio o ataques contra una persona.', icon: ShieldAlert },
  { value: 'COPYRIGHT', label: 'Plagio o problemas de copyright', description: 'Contenido que no es propio o vulnera derechos de autor.', icon: Copyright },
  { value: 'OTHER', label: 'Otro motivo', description: 'Contanos qué pasa en el campo de detalle.', icon: MessageSquareMore },
];

const DESCRIPTION_MAX = 500;

export function ReportDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ReportTarget | null;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [description, setDescription] = useState('');

  /* Cerrar (overlay, Escape, botones) también limpia el form para el próximo uso. */
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setReason(null);
      setDescription('');
    }
    onOpenChange(next);
  };

  /* POST /reports — éxito cierra con agradecimiento; 409 es neutro (ya estaba). */
  const submitMutation = useMutation({
    mutationFn: () => {
      if (!target || !reason) throw new Error('Falta el motivo de la denuncia');
      return reportsApi.create({
        targetType: target.type,
        targetId: target.id,
        reason,
        description: description.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast({ title: 'Denuncia enviada', description: '¡Gracias por cuidar la comunidad!' });
      handleOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast({ title: 'Ya habías denunciado esto', description: 'Nuestro equipo ya tiene tu denuncia de este contenido.' });
        handleOpenChange(false);
        return;
      }
      toast({ title: 'No pudimos enviar la denuncia', description: toUserMessage(err), variant: 'destructive' });
    },
  });

  const descriptionLength = description.length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-y-auto rounded-[28px_28px_14px_14px] sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle className="font-display text-lg font-bold leading-tight text-foreground">
            Denunciar {target?.title ?? 'contenido'}
          </DialogTitle>
          <DialogDescription>Contanos qué está pasando. Lo revisa nuestro equipo.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Motivos: radio cards verticales (icono + label + descripción) */}
          <RadioGroup
            value={reason ?? ''}
            onValueChange={(v) => setReason(v as ReportReason)}
            className="grid gap-2"
            aria-label="Motivo de la denuncia"
          >
            {REASONS.map((r) => {
              const active = reason === r.value;
              const Icon = r.icon;
              return (
                <label
                  key={r.value}
                  htmlFor={`report-reason-${r.value}`}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors focus-within:border-amber/60 focus-within:ring-2 focus-within:ring-ring/50',
                    active
                      ? 'border-amber bg-amber/10'
                      : 'border-border/70 bg-surface-2/40 hover:border-amber/40'
                  )}
                >
                  <RadioGroupItem value={r.value} id={`report-reason-${r.value}`} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-amber-strong' : 'text-muted-foreground')} aria-hidden />
                      {r.label}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{r.description}</span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>

          {/* Detalle opcional con contador de caracteres */}
          <div className="space-y-1.5">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
              maxLength={DESCRIPTION_MAX}
              placeholder="Contanos más (opcional)"
              aria-label="Detalle de la denuncia (opcional)"
              disabled={submitMutation.isPending}
              className="min-h-20 rounded-xl bg-surface-2 text-sm"
            />
            <p className="text-right text-xs tabular-nums text-muted-foreground" aria-live="polite">
              {descriptionLength}/{DESCRIPTION_MAX}
            </p>
          </div>
        </div>

        <DialogFooter className="mt-1 gap-2 sm:gap-2">
          <Button variant="ghost" className="rounded-full" onClick={() => handleOpenChange(false)} disabled={submitMutation.isPending}>
            Cancelar
          </Button>
          <Button
            variant="outline"
            className="rounded-full border-destructive/50 text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive"
            disabled={!reason || submitMutation.isPending}
            onClick={() => submitMutation.mutate()}
          >
            {submitMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Enviando…
              </>
            ) : (
              <>
                <Flag className="h-4 w-4" aria-hidden /> Enviar denuncia
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
