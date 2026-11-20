/**
 * MELODYA WEB (Vite) — Fachada de navegación sobre React Router (data router con URLs limpias, sin #).
 *
 * Conserva la API que ya usa todo el código de Melodya Web:
 *  • useRoute()  → { path, query, raw }
 *  • navigate(to, { replace })   (imperativo, también fuera de componentes: stores, hooks, handlers)
 *  • goBack()
 *  • matchPath('/songs/:id', path)
 *  • <Link to="…"/>
 *
 * El único router de la app es el `createBrowserRouter` de `src/routes.tsx`; acá solo se lo registra para que
 * `navigate()` funcione fuera del árbol de React. No existe un segundo router ni compatibilidad con `/#/…`.
 */
import { useMemo } from 'react';
import { Link as RouterLink, useLocation, type createBrowserRouter } from 'react-router-dom';

export interface RouteState {
  path: string;
  query: URLSearchParams;
  /** Fragmento (#…) sin el #. Lo usa el enlace de recuperación (/reset-password#token=…). */
  hash: string;
  /** path + query, como se ve en la barra de direcciones (sin origen). */
  raw: string;
}

type AppRouter = ReturnType<typeof createBrowserRouter>;

let appRouter: AppRouter | null = null;

/** Registra el router de la app (lo llama `routes.tsx` una sola vez). */
export function registerAppRouter(router: AppRouter) {
  appRouter = router;
}

/**
 * Rutas antiguas en español → rutas del backend/frontend actuales. Solo para enlaces viejos con PATH limpio
 * (p. ej. /ingresar); los enlaces con `#/` ya no se soportan.
 */
const LEGACY_ROUTES: Record<string, string> = {
  '/ingresar': '/login',
  '/registro': '/register',
  '/recuperar': '/forgot-password',
  '/restablecer': '/reset-password',
  '/crear': '/create',
  '/biblioteca': '/library',
  '/biblioteca/canciones': '/library/songs',
  '/biblioteca/proyectos': '/library/projects',
  '/biblioteca/letras': '/library/lyrics',
  '/biblioteca/letristas': '/library/lyric-personas',
  '/biblioteca/samples': '/library/samples',
  '/biblioteca/voces': '/library/voices',
  '/comunidad': '/community',
  '/planes': '/plans',
  '/perfil': '/profile',
  '/perfil/configuracion': '/profile/settings',
  '/perfil/seguridad': '/profile/security',
  '/perfil/actividad': '/profile/activity',
};

/** Normaliza paths legacy (español) al inglés del backend. */
export function normalizePath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const base = `/${segments.slice(0, 2).join('/')}`;
  const mapped = LEGACY_ROUTES[base];
  if (mapped) {
    const rest = segments.slice(2);
    return rest.length ? `${mapped}/${rest.join('/')}` : mapped;
  }
  // Rutas con parámetro dinámico: /cancion/:id → /songs/:id
  if (segments[0] === 'cancion' && segments[1]) return `/songs/${segments[1]}`;
  return path;
}

/** Ruta actual (reactiva). El path se entrega sin barra final para que las comparaciones por igualdad sigan valiendo. */
export function useRoute(): RouteState {
  const { pathname, search, hash } = useLocation();
  return useMemo(() => {
    const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
    return { path: clean, query: new URLSearchParams(search), hash: hash.replace(/^#/, ''), raw: `${clean}${search}` };
  }, [pathname, search, hash]);
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

function toPath(to: string): string {
  // Compatibilidad con linkUrl de banners/avisos del CMS que aún traigan «#/ruta».
  const t = to.startsWith('#') ? to.slice(1) : to;
  if (ABSOLUTE_URL.test(t)) return t;
  return t.startsWith('/') ? t : `/${t}`;
}

export function navigate(to: string, opts?: { replace?: boolean }) {
  const target = toPath(to);
  if (ABSOLUTE_URL.test(target)) {
    window.location.assign(target);
    return;
  }
  if (!appRouter) {
    // Antes de registrar el router (no debería ocurrir): navegación nativa.
    if (opts?.replace) window.location.replace(target);
    else window.location.assign(target);
    return;
  }
  void appRouter.navigate(target, { replace: opts?.replace });
}

export function goBack() {
  window.history.back();
}

/** Matchea patrones tipo "/songs/:id" → params o null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const pParts = pattern.split('/').filter(Boolean);
  const uParts = path.split('/').filter(Boolean);
  if (pParts.length !== uParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith(':')) {
      params[pParts[i].slice(1)] = decodeURIComponent(uParts[i]);
    } else if (pParts[i] !== uParts[i]) {
      return null;
    }
  }
  return params;
}

export function Link({
  to,
  children,
  className,
  onClick,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const target = toPath(to);
  if (ABSOLUTE_URL.test(target)) {
    return (
      <a href={target} className={className} onClick={onClick} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <RouterLink to={target} className={className} onClick={onClick} {...rest}>
      {children}
    </RouterLink>
  );
}
