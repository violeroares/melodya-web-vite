'use client';

/**
 * MELODYA WEB — Sidebar desktop: colapsable, persistente, con CTA "Crear
 * canción" siempre visible. En mobile se reemplaza por BottomNav.
 */
import React from 'react';
import {
  Home, Users, ListMusic, Music4, FileText, PenLine, Mic2, AudioLines,
  ChevronLeft, ChevronRight, Plus, Trash2,
} from 'lucide-react';
import { CoinIcon } from '@/components/common/CoinIcon';
import { Link, useRoute, navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore } from '@/stores/player';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MelodyaLogo, AuthAvatar } from '@/components/common';
import { useCredits, formatNumber } from '@/hooks';
import { Button } from '@/components/ui/button';

interface NavItem {
  to: string;
  label: string;
  icon: React.ElementType;
  exact?: boolean;
}

const MAIN: NavItem[] = [
  { to: '/', label: 'Inicio', icon: Home, exact: true },
  { to: '/community', label: 'Comunidad', icon: Users },
];

const LIBRARY: NavItem[] = [
  { to: '/library/songs', label: 'Canciones', icon: Music4 },
  { to: '/library/projects', label: 'Proyectos', icon: ListMusic },
  { to: '/library/lyrics', label: 'Letras', icon: FileText },
  { to: '/library/lyric-personas', label: 'Letristas', icon: PenLine },
  { to: '/library/samples', label: 'Audios', icon: AudioLines },
  { to: '/library/voices', label: 'Voces', icon: Mic2 },
  { to: '/library/trash', label: 'Papelera', icon: Trash2 },
];

function isActive(item: NavItem, path: string) {
  if (item.exact) return path === '/';
  return path === item.to || path.startsWith(item.to + '/');
}

function SideItem({ item, collapsed, path }: { item: NavItem; collapsed: boolean; path: string }) {
  const active = isActive(item, path);
  const Icon = item.icon;
  const link = (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex min-h-12 items-center gap-3 rounded-full px-4 py-2 text-[14.5px] font-medium transition-colors',
        // design-V2: todos los ítems tienen la misma forma (cápsula que sale del borde izquierdo de la barra; el nav tiene px-3, se compensa).
        // Solo cambia el color: terracota al seleccionar, terracota suave al pasar el mouse.
        '-ml-3 w-[calc(100%+0.75rem)] justify-start rounded-l-none pr-4 pl-[22px]',
        active
          ? 'bg-[var(--m-capsule-tint)] font-bold text-foreground'
          : 'text-muted-foreground hover:bg-[color-mix(in_srgb,var(--m-capsule-tint)_50%,transparent)] hover:text-foreground'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full',
          active && 'bg-primary text-primary-foreground'
        )}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

/** Tarjeta de usuario (design-V2): avatar, nombre y saldo de fichas; abre el perfil. */
function UserCard({ collapsed }: { collapsed: boolean }) {
  const user = useAuthStore((s) => s.user);
  const { data: credits } = useCredits();
  const { path } = useRoute();
  if (!user) return null;
  const active = path === '/profile' || path.startsWith('/profile/');
  const card = (
    <Link
      to="/profile"
      aria-label={`Mi perfil, ${user.name}. Saldo: ${credits?.balance ?? 0} fichas`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        // Misma forma que los ítems del menú (sin margen ni borde a la izquierda; el pie tiene p-3, se compensa), con su borde y fondo propios.
        'mb-1 flex min-h-14 -ml-3 w-[calc(100%+0.75rem)] items-center justify-start gap-3 rounded-full rounded-l-none border border-l-0 border-border/70 bg-surface py-1.5 dark:bg-voice pr-4 pl-4 transition-colors hover:border-amber/40 focus-visible:outline-2 focus-visible:outline-foreground',
        active && 'border-amber/50'
      )}
    >
      <AuthAvatar src={user.avatarUrl} name={user.name ?? 'M'} className="size-11 shrink-0" fallbackClassName="text-sm" />
      {!collapsed && (
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-bold text-foreground">{user.name}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <span aria-hidden className="size-2 rounded-full bg-gold" />
            <span className="tabular-nums">{formatNumber(credits?.balance ?? 0)} fichas</span>
          </span>
        </span>
      )}
    </Link>
  );
  if (!collapsed) return card;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{card}</TooltipTrigger>
      <TooltipContent side="right">{user.name} · {formatNumber(credits?.balance ?? 0)} fichas</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { path } = useRoute();
  const authed = useAuthStore((s) => Boolean(s.user));
  /* Cuando suena una canción, el PlayerBar (fixed, todo el ancho) tapa el pie
     del sidebar en desktop → empujamos la sección de usuario hacia arriba. */
  const playerActive = usePlayerStore((s) => Boolean(s.track));

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        aria-label="Navegación principal"
        className={cn(
          'sticky top-0 z-30 hidden h-screen shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-300 md:flex',
          collapsed ? 'w-[76px]' : 'w-[248px]'
        )}
      >
        {/* Logo + colapso */}
        <div className={cn('flex h-16 items-center px-4', collapsed && 'justify-center px-2')}>
          {collapsed ? (
            <Link to="/" aria-label="Melodya inicio" className="flex items-center">
              <MelodyaLogo compact className="[&_img]:h-4" />
            </Link>
          ) : (
            <Link to="/" aria-label="Melodya inicio" className="flex items-center">
              <MelodyaLogo className="[&_img]:h-5" />
            </Link>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          {/* CTA principal */}
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => navigate('/create')}
                  aria-label="Creá tu canción"
                  className="mb-5 -ml-3 flex h-11 w-[calc(100%+0.75rem)] items-center justify-start rounded-full rounded-l-none bg-primary pl-7 text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-foreground"
                >
                  <Plus className="h-5 w-5" strokeWidth={3} aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Creá tu canción</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              onClick={() => navigate('/create')}
              size="lg"
              className="mb-5 -ml-3 h-12 w-[calc(100%+0.75rem)] justify-start rounded-l-none pl-7 font-display text-base font-bold"
            >
              <Plus className="mr-1 h-5 w-5" strokeWidth={3} aria-hidden />
              Creá tu canción
            </Button>
          )}

          <nav className="space-y-1.5">
            {MAIN.map((item) => (
              <SideItem key={item.to} item={item} collapsed={collapsed} path={path} />
            ))}
          </nav>

          {/* Biblioteca: solo con sesión iniciada (los invitados no pueden ver
              esta sección — antes de loguearse no existe para ellos). */}
          {authed && (
            <>
              <div aria-hidden className="h-5" />
              {!collapsed && (
                <p className="mb-2.5 flex items-center gap-2.5 px-3 text-xs font-bold uppercase tracking-[0.12em] text-label">
                  <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-[var(--m-accent)]" />
                  Biblioteca
                </p>
              )}
              <nav className="space-y-1.5">
                {LIBRARY.map((item) => (
                  <SideItem key={item.to} item={item} collapsed={collapsed} path={path} />
                ))}
              </nav>
            </>
          )}

        </div>

        {/* Pie: solo el colapso (sesión, perfil y acceso viven en el header y en el menú del avatar) */}
        <div className={cn(
          'p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-[padding] duration-300',
          playerActive && 'pb-[max(5.5rem,calc(env(safe-area-inset-bottom)+5.5rem))]'
        )}>
          {/* Pegado a la tarjeta del usuario */}
          <nav className="mb-1.5 space-y-1.5">
            <SideItem item={{ to: '/plans', label: 'Planes y fichas', icon: CoinIcon }} collapsed={collapsed} path={path} />
            {/* v0.25.0: la administración vive en melodya_backoffice — la web
                es exclusiva para creadores. */}
          </nav>
          {authed && <UserCard collapsed={collapsed} />}
          <button
            onClick={onToggle}
            aria-label={collapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral'}
            className="group mt-1 -ml-3 hidden min-h-11 w-[calc(100%+0.75rem)] items-center justify-start gap-3 rounded-full rounded-l-none py-1.5 pr-4 pl-[22px] text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--m-capsule-tint)_50%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground lg:flex"
          >
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full border-[1.5px] border-line">
              {collapsed ? <ChevronRight className="h-4 w-4" strokeWidth={2.5} /> : <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />}
            </span>
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
