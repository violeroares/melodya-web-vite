
/**
 * MELODYA WEB — Navegación inferior mobile con botón central "Crear"
 * (tipo app musical, usable con el pulgar).
 * Cuando el player global está activo, muestra un hilo de progreso fino
 * arriba del nav (mini now-playing: sabés cuánto queda del tema sin abrir
 * el reproductor).
 */
import React from 'react';
import { Home, Library, Users, Plus, User as UserIcon, Zap } from 'lucide-react';
import { navigate, useRoute } from '@/lib/router';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore } from '@/stores/player';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/', label: 'Inicio', icon: Home, exact: true },
  { to: '/community', label: 'Comunidad', icon: Users },
  { to: '__create__', label: 'Crear', icon: Plus },
  { to: '/library', label: 'Biblioteca', icon: Library },
  { to: '/profile', label: 'Perfil', icon: UserIcon },
];

/* Invitados: la pestaña Biblioteca requiere sesión → la reemplazamos por
 * Planes (pública) para no dejar un tab muerto (misma grilla de 5). */
const GUEST_TABS = TABS.map((t) =>
  t.to === '/library' ? { to: '/plans', label: 'Planes', icon: Zap } : t,
);

export function BottomNav() {
  const { path } = useRoute();
  const authed = useAuthStore((s) => Boolean(s.user));
  const tabs = authed ? TABS : GUEST_TABS;
  const track = usePlayerStore((s) => s.track);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const radioMode = usePlayerStore((s) => s.radioMode);
  const progress = track && duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <nav
      aria-label="Navegación inferior"
      className="fixed bottom-[max(0.5rem,env(safe-area-inset-bottom))] left-0 right-4 z-50 rounded-r-[31px] bg-voice text-on-voice md:hidden"
    >
      {/* Mini now-playing: hilo de progreso del tema en curso sobre el nav */}
      {track && (
        <div
          aria-hidden
          className={cn(
            'absolute inset-x-0 top-0 h-[3px] origin-left rounded-tr-full bg-gold transition-transform duration-300',
            radioMode && 'radio-thread'
          )}
          style={{ transform: `scaleX(${progress})` }}
        />
      )}
      <div className="mx-auto grid h-[62px] max-w-md grid-cols-5">
        {tabs.map((tab) => {
          /* «Crear» es una pestaña más: sólo se resalta en /create (como el resto, según la ruta activa). */
          const target = tab.to === '__create__' ? '/create' : tab.to;
          const active = tab.exact ? path === '/' : path === target || path.startsWith(target + '/');
          const Icon = tab.icon;
          return (
            <button
              key={tab.to}
              onClick={() => navigate(target)}
              aria-label={tab.to === '__create__' ? 'Crear canción' : undefined}
              aria-current={active ? 'page' : undefined}
              className="relative flex min-h-[56px] flex-col items-center justify-center gap-1 py-2 focus-visible:outline-2 focus-visible:outline-on-voice"
            >
              <span
                className={cn(
                  'flex size-7 items-center justify-center rounded-full transition-all',
                  active ? '-mt-5 size-11 bg-primary text-primary-foreground ring-4 ring-background' : 'text-on-voice/80'
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <span className={cn('text-[11px] transition-colors', active ? 'font-bold text-on-voice' : 'font-medium text-on-voice/80')}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
