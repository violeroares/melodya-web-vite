
/**
 * MELODYA WEB — Header global: logo (mobile), saldo de fichas, avatar y menú
 * de usuario. Sin saturar: solo lo esencial.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { LogOut, User as UserIcon, Zap, Settings2, Coins, Search, Bell, Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '@/lib/theme';
import { useRoute, navigate, Link } from '@/lib/router';
import { useAuthStore } from '@/stores/auth';
import { notificationsApi } from '@/lib/api';
import { queryPollDelayMs } from '@/lib/api/resilience';
import { useCredits, formatNumber } from '@/hooks';
import { MelodyaLogo, AuthAvatar } from '@/components/common';
import { openCommandPalette } from '@/components/common/CommandPalette';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { HomeGreeting } from '@/features/home/HomeGreeting';

export function Header() {
  const { path } = useRoute();
  const { theme, setTheme } = useTheme();
  const user = useAuthStore((s) => s.user);
  const status = useAuthStore((s) => s.status);
  const logout = useAuthStore((s) => s.logout);
  const { data: credits, isLoading } = useCredits();
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
    /* 30 s normales; con error, backoff (≥ Retry-After si hubo 429) en vez de insistir cada 30 s. */
    refetchInterval: (query) => queryPollDelayMs(query, 30_000),
    refetchOnWindowFocus: true,
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
              <Zap className="h-4 w-4 text-lyric-tag" aria-hidden />
              <span key={`bal-${balance ?? 'x'}`} className="balance-bump inline-flex font-bold tabular-nums">
                {isLoading ? <Skeleton className="inline-block h-3.5 w-8" /> : formatNumber(credits?.balance ?? 0)}
              </span>
              <span className="hidden text-xs font-medium text-muted-foreground sm:inline">fichas</span>
            </Button>
          )}

          {isGuest ? (
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
              <DropdownMenuContent align="end" className="w-56 rounded-[20px]">
                <DropdownMenuLabel className="font-normal">
                  <p className="truncate text-sm font-semibold">{user?.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate('/profile')} className="cursor-pointer rounded-lg">
                  <UserIcon className="mr-2 h-4 w-4" aria-hidden /> Mi perfil
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate('/plans')} className="cursor-pointer rounded-lg">
                  <Coins className="mr-2 h-4 w-4" aria-hidden /> Planes y fichas
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate('/profile/settings')} className="cursor-pointer rounded-lg">
                  <Settings2 className="mr-2 h-4 w-4" aria-hidden /> Configuración
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* Tema: claro, oscuro o el del sistema (por defecto) */}
                <DropdownMenuLabel className="text-xs font-bold uppercase tracking-[0.12em] text-label">Tema</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
                  <DropdownMenuRadioItem value="light" className="cursor-pointer rounded-lg py-2.5">
                    <Sun className="mr-2 h-4 w-4" aria-hidden /> Claro
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark" className="cursor-pointer rounded-lg py-2.5">
                    <Moon className="mr-2 h-4 w-4" aria-hidden /> Oscuro
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system" className="cursor-pointer rounded-lg py-2.5">
                    <Monitor className="mr-2 h-4 w-4" aria-hidden /> Sistema
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => void logout()}
                  className="cursor-pointer rounded-lg text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" aria-hidden /> Cerrar sesión
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  );
}
