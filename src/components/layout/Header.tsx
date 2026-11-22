'use client';

/**
 * MELODYA WEB — Header global: logo (mobile), saldo de fichas, avatar y menú
 * de usuario. Sin saturar: solo lo esencial.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { LogOut, User as UserIcon, Settings2, Search, Bell, Sun, Moon, Monitor } from 'lucide-react';
import { CoinIcon } from '@/components/common/CoinIcon';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ConfirmDialog } from '@/features/library/library-utils';
import { useTheme } from '@/lib/theme';
import { useRoute, navigate, Link } from '@/lib/router';
import { useAuthStore } from '@/stores/auth';
import { notificationsApi } from '@/lib/api';
import { useCredits, formatNumber } from '@/hooks';
import { MelodyaLogo, AuthAvatar } from '@/components/common';
import { openCommandPalette } from '@/components/common/CommandPalette';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { queryPollDelayMs, rateLimitRemainingMs } from '@/lib/api/resilience';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { HomeGreeting } from '@/features/home/HomeGreeting';

export function Header() {
  const { path } = useRoute();
  const { theme, setTheme } = useTheme();
  const user = useAuthStore((s) => s.user);
  const status = useAuthStore((s) => s.status);
  const logout = useAuthStore((s) => s.logout);
  const [confirmLogout, setConfirmLogout] = React.useState(false);
  const { data: credits, isLoading } = useCredits();
  /* Sesión guardada en recuperación (error temporal): no es un invitado, así que no se ofrece Ingresar / Crear cuenta. */
  const recovering = useAuthStore((s) => s.sessionRecovering);
  const isGuest = status === 'guest';
  const balance = credits?.balance;
  /* El saludo del inicio solo existe con sesión: los invitados ven la landing. */
  const showGreeting = path === '/' && Boolean(user);

  /* v0.18.0 — notificaciones sin leer (badge de la campanita). Sin datos todavía
     no mostramos badge (ni esqueleto): la campanita queda limpia hasta la 1ª
     respuesta. Refresco suave cada 30s + al volver a la pestaña. */
  const { data: unreadData } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => notificationsApi.unreadCount(),
    enabled: !isGuest,
    /* Periodo normal 30 s; ante error, backoff; ante 429, no antes de Retry-After / del fin de la pausa de la API general. React Query no solapa
       consultas ni sondea con la pestaña oculta. */
    refetchInterval: (query) => queryPollDelayMs(query, 30_000),
    /* Al volver a la pestaña se actualiza, salvo durante una pausa por 429 (se retoma al terminar). */
    refetchOnWindowFocus: () => rateLimitRemainingMs('api') === 0,
  });
  const unreadCount = unreadData?.count;

  return (
    <header className="sticky top-0 z-40 bg-background">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
        {/* Logo (mobile) */}
        <Link to="/" className="md:hidden" aria-label="Melodya inicio">
          <MelodyaLogo compact />
        </Link>

        <div className="hidden min-w-0 flex-1 md:block">
          {showGreeting && <HomeGreeting headingId="home-bienvenida" />}
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {/* Búsqueda rápida (command palette · Ctrl+K) */}
          <button
            type="button"
            onClick={openCommandPalette}
            aria-label="Búsqueda rápida (/ o Ctrl+K)"
            className="group flex h-11 min-w-0 shrink items-center gap-2 rounded-full md:w-44 lg:w-60 xl:w-72 border-[1.5px] border-line bg-[var(--m-input)] px-4 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus-visible:border-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--m-focus-ring)]"
          >
            <Search className="h-4 w-4" aria-hidden />
            <span className="hidden text-sm md:inline">Buscar…</span>
            <span className="hidden items-center gap-1 md:ml-auto md:flex" aria-hidden>
              <kbd className="kbd">/</kbd>
            </span>
          </button>

          {/* Campanita de notificaciones (v0.18.0): badge con las sin leer */}
          {!isGuest && (
            <button
              type="button"
              onClick={() => navigate('/notifications')}
              aria-label={unreadCount ? `Notificaciones (${unreadCount} sin leer)` : 'Notificaciones'}
              className="group relative flex size-11 items-center justify-center rounded-full border-[1.5px] border-line text-foreground transition-colors hover:bg-accent focus-visible:border-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--m-focus-ring)]"
            >
              <Bell className="h-4 w-4" aria-hidden />
              {unreadCount !== undefined && unreadCount > 0 && (
                <span aria-hidden className="absolute right-2 top-2 size-2.5 rounded-full border-2 border-background bg-primary" />
              )}
            </button>
          )}

          {/* Saldo de fichas (key=balance: al cambiar se remonta y el "bump" se re-dispara) */}
          {!isGuest && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/plans')}
              className="border-gold bg-gold/15 px-4 text-foreground hover:bg-gold/25 md:hidden"
              aria-label={`Saldo: ${credits?.balance ?? 0} fichas. Ver planes.`}
            >
              <CoinIcon className="h-4 w-4 text-lyric-tag" aria-hidden />
              <span key={`bal-${balance ?? 'x'}`} className="balance-bump inline-flex font-bold tabular-nums">
                {isLoading ? <Skeleton className="inline-block h-3.5 w-8" /> : formatNumber(credits?.balance ?? 0)}
              </span>
              <span className="hidden text-xs font-medium text-muted-foreground sm:inline">fichas</span>
            </Button>
          )}

          {isGuest && recovering ? null : isGuest ? (
            <>
              <Button variant="ghost" size="sm" className="rounded-full" onClick={() => navigate('/login')}>
                Ingresar
              </Button>
              <Button size="sm" className="rounded-full" onClick={() => navigate('/register')}>
                Crear cuenta
              </Button>
            </>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button aria-label="Menú de usuario" className="rounded-full outline-none ring-[var(--m-gold)] ring-2 ring-offset-2 ring-offset-background focus-visible:outline-2 focus-visible:outline-foreground">
                  <AuthAvatar src={user?.avatarUrl} name={user?.name ?? 'M'} className="h-9 w-9" fallbackClassName="text-xs" />
                </button>
              </DropdownMenuTrigger>
              {/* Menú de usuario con el estilo de las listas del sistema: tarjeta 28/28/14/14, filas altas con el ícono en círculo y el tema como selector de grupo */}
              <DropdownMenuContent align="end" variant="list" className="w-64 overflow-hidden" sideOffset={8}>
                <div className="border-b border-border/60 px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate font-display text-[15px] font-bold leading-tight text-foreground">{user?.name}</p>
                    <p className="truncate text-[13px] text-muted-foreground">{user?.email}</p>
                  </div>
                </div>
                <DropdownMenuItem onClick={() => navigate('/profile')} className="cursor-pointer">
                  <UserIcon aria-hidden /> Mi perfil
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate('/plans')} className="cursor-pointer">
                  <CoinIcon aria-hidden /> Planes y fichas
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate('/profile/settings')} className="cursor-pointer">
                  <Settings2 aria-hidden /> Configuración
                </DropdownMenuItem>
                {/* Tema: claro, oscuro o el del sistema (por defecto) */}
                <div className="space-y-2.5 border-b border-border/60 px-3.5 py-3">
                  <p className="flex items-center gap-2.5 text-xs font-bold uppercase tracking-[0.12em] text-label">
                    <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-[var(--m-accent)]" />
                    Color de tema
                  </p>
                  <SegmentedTabs
                    ariaLabel="Tema de la aplicación"
                    iconOnly
                    value={(theme ?? 'system') as 'light' | 'dark' | 'system'}
                    onChange={setTheme}
                    tabs={[
                      { key: 'light', label: 'Claro', icon: Sun },
                      { key: 'dark', label: 'Oscuro', icon: Moon },
                      { key: 'system', label: 'Sistema', icon: Monitor },
                    ]}
                  />
                </div>
                <DropdownMenuItem
                  onClick={() => setConfirmLogout(true)}
                  className="cursor-pointer text-destructive focus:text-destructive [&&[data-slot]>svg]:border-primary! [&&[data-slot]>svg]:bg-primary [&&[data-slot]>svg]:text-[#131C33]!"
                >
                  <LogOut aria-hidden /> Cerrar sesión
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmLogout}
        onOpenChange={setConfirmLogout}
        title="¿Cerrar sesión?"
        description="Salís de tu cuenta en este dispositivo. Tus canciones quedan guardadas."
        actionLabel="Cerrar sesión"
        onConfirm={() => {
          setConfirmLogout(false);
          void logout();
        }}
      />
    </header>
  );
}
