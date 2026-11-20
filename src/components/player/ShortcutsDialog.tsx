
/**
 * MELODYA WEB — ShortcutsDialog: hoja completa de atajos de teclado.
 * Se abre con "?" (Shift + /) desde cualquier vista o desde el botón
 * "Atajos" (icono de teclado) del sheet de la cola. CLIENT-ONLY.
 *
 * Grupos: Reproductor · Cola · General, con chips .kbd y descripciones
 * cortas en es-AR. Las filas entran con un stagger sutil (.sc-row).
 */
import React from 'react';
import { Keyboard, ListMusic, PlayCircle, Sparkles } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface ShortcutRow {
  keys: string[];
  /** Clave amplia (ej. "Espacio", "Ctrl K") para chips más anchos. */
  wide?: boolean;
  desc: string;
}

const GROUPS: { id: string; title: string; icon: React.ReactNode; rows: ShortcutRow[] }[] = [
  {
    id: 'reproductor',
    title: 'Reproductor',
    icon: <PlayCircle className="h-4 w-4 text-amber-strong" aria-hidden />,
    rows: [
      { keys: ['Espacio'], wide: true, desc: 'Reproducir / pausar' },
      { keys: ['←', '→'], desc: 'Atrás / adelante 5 segundos' },
      { keys: ['⇧', '↑', '↓'], desc: 'Volumen ±5 %' },
      { keys: ['N', 'P'], desc: 'Canción siguiente / anterior' },
      { keys: ['M'], desc: 'Silenciar' },
      { keys: ['S'], desc: 'Orden aleatorio' },
      { keys: ['L'], desc: 'Me gusta de la canción en curso' },
    ],
  },
  {
    id: 'cola',
    title: 'Cola',
    icon: <ListMusic className="h-4 w-4 text-amber-strong" aria-hidden />,
    rows: [
      { keys: ['Q'], desc: 'Abrir / cerrar la cola' },
      { keys: ['Arrastrar'], wide: true, desc: 'Reordenar filas de la cola (o con ↑ ↓)' },
    ],
  },
  {
    id: 'general',
    title: 'General',
    icon: <Keyboard className="h-4 w-4 text-amber-strong" aria-hidden />,
    rows: [
      { keys: ['Ctrl', 'K'], desc: 'Paleta de comandos y búsqueda' },
      { keys: ['?'], desc: 'Esta hoja de atajos' },
      { keys: ['Esc'], desc: 'Cerrar lo que esté abierto' },
    ],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-[28px_28px_14px_14px] border-border/70 bg-surface/98 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 font-display text-lg">
            <Keyboard className="h-5 w-5 text-amber-strong" aria-hidden />
            Atajos de teclado
          </DialogTitle>
          <DialogDescription>
            Melodya se maneja entero desde el teclado. Probálos sin miedo: ningún atajo actúa mientras escribís.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {GROUPS.map((g) => (
            <section key={g.id} aria-label={g.title}>
              <h3 className="mb-2 flex items-center gap-2 text-[11px] font-bold tracking-[0.14em] text-muted-foreground uppercase">
                <span className="dot-amber" aria-hidden />
                {g.title}
              </h3>
              <ul className="space-y-1">
                {g.rows.map((r) => (
                  <li key={r.desc} className="sc-row flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2/70">
                    <span className="flex w-24 shrink-0 items-center gap-1">
                      {r.keys.map((k) => (
                        <span key={k} className={r.wide && k.length > 2 ? 'kbd kbd-wide' : 'kbd'}>
                          {k}
                        </span>
                      ))}
                    </span>
                    <span className="min-w-0 text-sm text-foreground/90">{r.desc}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p className="flex items-start gap-2 rounded-xl border border-amber/25 bg-amber/8 p-3 text-xs text-amber-strong">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              También: tocá la portada del reproductor para la vista expandida, y usá la <strong>rueda del ratón</strong> sobre el
              volumen para ajustarlo sin apuntar al deslizador.
            </span>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
