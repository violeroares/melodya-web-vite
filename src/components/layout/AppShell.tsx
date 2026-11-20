
/**
 * MELODYA WEB — AppShell: skip-link (a11y) + AnnouncementBar + Header +
 * Sidebar/BottomNav + contenido + PlayerBar global + avisos de conexión.
 * Footer sticky al fondo.
 */
import React, { useEffect, useState } from 'react';
import { AnnouncementBar } from './AnnouncementBar';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { BottomNav } from './BottomNav';
import { PlayerBar } from '@/components/player/PlayerBar';
import { BannerSlot } from '@/components/banners';
import { CommandPalette } from '@/components/common/CommandPalette';
import { UpgradeDialog } from '@/components/common/PlanGate';
import { useRealtime, type NotificationCreatedPayload } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import { Heart } from 'lucide-react';
import { useRoute } from '@/lib/router';
import { cn } from '@/lib/utils';
import { generationFailureMessage } from '@/lib/generation-failure';
import { usePlayerStore } from '@/stores/player';

const COLLAPSE_KEY = 'melodya.sidebar.collapsed';

export function AppShell({ children, withFooter = true }: { children: React.ReactNode; withFooter?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const { toast } = useToast();
  const { path } = useRoute();
  /* ¿Hay un tema cargado en el player? El PlayerBar es fijo y cubre el pie
     del contenido: solo reservamos ese aire cuando realmente está visible. */
  const playerActive = usePlayerStore((s) => !!s.track);

  useEffect(() => {
    // Sincroniza con un sistema externo (localStorage) al montar.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);

  /* Avisos de conexión (navigator online/offline, CLIENT-ONLY) */
  useEffect(() => {
    const onOffline = () =>
      toast({
        title: 'Te quedaste sin conexión',
        description: 'Algunas cosas pueden no cargar hasta que vuelva la red.',
        variant: 'destructive',
      });
    const onOnline = () =>
      toast({
        title: '¡Volvió la conexión! 🎵',
        description: 'Seguí creando sin problemas.',
      });
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [toast]);

  const toggleCollapse = () => {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      return !c;
    });
  };

  // Socket.IO realtime (eventos reales del backend) + toasts de generación
  useRealtime((ev) => {
    if (ev.type === 'generation:completed') {
      toast({
        title: '🎵 ¡Tu canción está lista!',
        description: 'Ya podés escucharla en tu biblioteca.',
      });
    } else if (ev.type === 'generation:failed') {
      toast({
        title: 'La generación falló',
        description: `${generationFailureMessage(ev.payload.error)} Te devolvimos las fichas.`,
        variant: 'destructive',
      });
    } else if (ev.type === 'notification:created') {
      /* v0.18.0 — notificación en vivo: toast solo si NO está en el centro de
         notificaciones (ahí la lista se repinta sola con la invalidación). */
      if (path.startsWith('/notifications')) return;
      const p = ev.payload as NotificationCreatedPayload;
      const actor = p.actor?.name ?? 'Melodya';
      const song = p.song ? `«${p.song.title}»` : null;
      const byType: Record<string, { emoji: string; text: string }> = {
        NEW_FOLLOWER: { emoji: '👤', text: `${actor} empezó a seguirte` },
        SONG_COMMENT: { emoji: '💬', text: song ? `${actor} comentó en ${song}` : `${actor} comentó tu canción` },
        COMMENT_REPLY: { emoji: '💬', text: song ? `${actor} respondió tu comentario en ${song}` : `${actor} respondió tu comentario` },
        COMMENT_LIKE: { emoji: '❤️', text: song ? `A ${actor} le gustó tu comentario en ${song}` : `A ${actor} le gustó tu comentario` },
        SONG_LIKE: { emoji: '❤️', text: song ? `A ${actor} le gustó ${song}` : `A ${actor} le gustó tu canción` },
      };
      /* Avisos SYSTEM (panel de administración): muestran el texto real del
         mensaje — sanciones, moderación de contenido y anuncios del equipo. */
      const info =
        p.type === 'SYSTEM'
          ? { emoji: '📣', text: p.message ?? 'Tenés una novedad nueva' }
          : byType[p.type] ?? { emoji: '✨', text: 'Tenés una novedad nueva' };
      toast({
        title: `${info.emoji} ${actor}`,
        description: info.text,
      });
    }
  });

  return (
    <div className="flex min-h-screen bg-background bg-noise">
      {/* Skip-link accesible: primera tabulación de la página */}
      <button
        type="button"
        onClick={() => {
          const main = document.getElementById('contenido');
          if (main) {
            main.focus();
            main.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }}
        className="skip-link"
      >
        Saltar al contenido
      </button>
      <Sidebar collapsed={collapsed} onToggle={toggleCollapse} />

      <div className="flex min-w-0 flex-1 flex-col">
        <AnnouncementBar />
        <Header />

        <main id="contenido" tabIndex={-1} className="@container flex flex-1 flex-col focus:outline-none">
          <div
            className={cn(
              'mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pt-6 sm:px-6',
              /* Con un tema en curso, el PlayerBar fijo (y el BottomNav en
                 móvil) tapan el pie: dejamos aire para que el footer respire.
                 Sin nada sonando, las páginas de poco contenido (login,
                 registro, recuperar contraseña…) llenan exactamente la
                 pantalla: el footer queda a la vista, SIN scroll. En móvil
                 siempre se reserva el BottomNav fijo. */
              playerActive ? 'pb-40 md:pb-36' : 'pb-24 md:pb-8'
            )}
          >
            {children}
          </div>
        </main>

        {withFooter && (
          <footer className="mt-auto border-t border-border/70 bg-surface/50">
            <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 pb-32 sm:px-6 md:pb-5">
              <BannerSlot position="FOOTER" />
              <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                <p className="inline-flex items-center gap-1.5">
                  Hecho con <Heart className="h-3.5 w-3.5 fill-coral text-coral" aria-label="cariño" />
                </p>
                <p>© {new Date().getFullYear()} Melodya</p>
              </div>
            </div>
          </footer>
        )}
      </div>

      <BottomNav />
      <PlayerBar />
      <CommandPalette />
      {/* Aviso de upgrade común a toda la app (funcionalidades fuera del plan) */}
      <UpgradeDialog />
    </div>
  );
}
