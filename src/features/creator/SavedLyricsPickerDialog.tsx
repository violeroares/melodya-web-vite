
/**
 * Elegir una letra guardada (Biblioteca › Letras) sin pasar por el Estudio de letras.
 * Mismo listado y mismas tarjetas que la vista «Mis letras» del estudio; sirve cuando el plan no incluye el asistente.
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, FileText, Loader2, Search } from 'lucide-react';
import { lyricsApi } from '@/lib/api';
import { useDebounce } from '@/hooks';
import { cn } from '@/lib/utils';
import type { UserLyric } from '@/types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export function SavedLyricsPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (lyric: UserLyric) => void;
}) {
  const [search, setSearch] = useState('');
  const term = useDebounce(search.trim(), 300);

  const { data, isLoading } = useQuery({
    queryKey: ['lyrics', 'picker', term],
    queryFn: () => lyricsApi.list({ pageSize: 50, ...(term ? { search: term } : {}) }),
    enabled: open,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const items = data?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto overflow-x-hidden border-border/70 bg-surface sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="font-display">Mis letras</DialogTitle>
          <DialogDescription>Elegí una letra guardada para usarla en tu canción.</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar en mis letras"
            aria-label="Buscar en mis letras"
            className="h-11 w-full rounded-full pl-10 text-sm font-normal"
          />
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-[28px_28px_14px_14px] border-[1.5px] border-dashed border-line bg-[var(--m-input)] p-6 text-center">
            <span aria-hidden className="relative block size-24 shrink-0">
              <svg className="absolute inset-0 size-full" viewBox="0 0 96 96" fill="none">
                <circle cx="48" cy="48" r="44" stroke="var(--m-faint)" strokeWidth="3" />
              </svg>
              <span className="absolute inset-[21%] flex items-center justify-center rounded-full bg-voice">
                <BookOpen className="h-[26px] w-[26px] text-gold" />
              </span>
            </span>
            <p className="max-w-[250px] font-display text-[19px] leading-tight font-semibold">
              {term ? 'No encontramos letras con esa búsqueda.' : 'Todavía no tenés letras guardadas.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
            {items.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => onPick(l)}
                className="flex w-full min-w-0 items-center gap-3.5 rounded-[28px] border-[1.5px] border-line bg-surface p-3 pr-4 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex size-[52px] shrink-0 items-center justify-center rounded-full',
                    l.source === 'MANUAL' ? 'bg-foreground text-background' : 'bg-primary text-[#131C33]'
                  )}
                >
                  <FileText className="h-[22px] w-[22px]" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-snug">
                  <span className="truncate font-display text-base font-bold">{l.title}</span>
                  <span className="truncate text-[13px] text-muted-foreground">{l.lyrics.replace(/\s+/g, ' ')}</span>
                  <span className="text-xs text-muted-foreground/85">
                    {l.source === 'MANUAL' ? 'Mía' : 'Melodya'}
                    {l.genre ? ` · ${l.genre}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
