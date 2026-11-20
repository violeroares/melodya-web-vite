/**
 * MELODYA WEB (Vite) — Árbol de rutas (React Router, URLs limpias).
 *
 * ESTRUCTURA PARA PERSISTIR EL REPRODUCTOR
 *   RouterProvider
 *   └─ RootLayout            ← se monta UNA vez y no se desmonta al navegar
 *        ├─ QueryClientProvider, ThemeProvider, Toaster, bootstrap de sesión
 *        ├─ AppShell          ← Header, Sidebar, PlayerBar (<audio>), Socket.IO (useRealtime), avisos…
 *        │    └─ ViewsBoundary → <Outlet/>   ← lo ÚNICO que cambia entre rutas
 *        └─ reconciliación de generaciones
 *
 * El audio, la cola, el volumen, el socket y los borradores viven en Zustand/AppShell, fuera del <Outlet/>,
 * por lo que navegar entre rutas no reinicia la canción ni abre una segunda conexión WebSocket.
 *
 * Las vistas se cargan con `lazy` del data router: al cambiar de ruta React Router espera el chunk SIN desmontar
 * el shell (el reproductor sigue sonando) y SIN parpadeos.
 */
import { useEffect } from 'react';
import { Navigate, Outlet, createBrowserRouter, useParams } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Music4 } from 'lucide-react';
import { queryClient } from '@/lib/query-client';
import { ThemeProvider } from '@/lib/theme';
import { Toaster } from '@/components/ui/toaster';
import { registerAppRouter, useRoute, navigate, matchPath, normalizePath } from '@/lib/router';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore } from '@/stores/player';
import { useGenerationReconciliation } from '@/hooks';
import { AppShell } from '@/components/layout/AppShell';
import { ViewErrorBoundary } from '@/components/common/ErrorBoundary';
import { MelodyaLogo } from '@/components/common';
import { Button } from '@/components/ui/button';

/* Título del documento por ruta (pestaña del navegador / historial).
   Si el player global está sonando, el título muestra el tema en curso (tipo Spotify): "▶ {canción} · Melodya". */
const DEFAULT_TITLE = 'Melodya — Creá música con Melodya';

function routeTitle(path: string, isGuest: boolean): string | null {
  if (path === '/') return isGuest ? DEFAULT_TITLE : 'Inicio';
  if (path === '/create') return 'Crear canción';
  if (path.startsWith('/library')) return 'Biblioteca';
  if (matchPath('/songs/:id', path)) return 'Canción';
  if (path === '/community') return 'Comunidad';
  if (matchPath('/user/:id', path)) return 'Creador';
  if (path === '/plans') return 'Planes y fichas';
  if (path === '/notifications') return 'Notificaciones';
  if (path.startsWith('/profile')) return 'Mi perfil';
  if (path === '/login') return 'Ingresar';
  if (path === '/register') return 'Crear cuenta';
  if (path === '/forgot-password') return 'Recuperar contraseña';
  if (path === '/reset-password') return 'Restablecer contraseña';
  return null; // 404 y rutas desconocidas: dejamos el default
}

function useDocumentTitle(path: string, isGuest: boolean) {
  const track = usePlayerStore((s) => s.track);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  useEffect(() => {
    if (isPlaying && track) {
      document.title = `▶ ${track.title} · Melodya`;
      return;
    }
    const label = routeTitle(path, isGuest);
    document.title = label && label !== DEFAULT_TITLE ? `${label} · Melodya` : DEFAULT_TITLE;
  }, [path, isGuest, isPlaying, track?.title]);
}

/** Vuelve arriba al cambiar de ruta (equivale al scrollTo del antiguo router por hash). */
function useScrollToTopOnNavigate() {
  const { raw } = useRoute();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [raw]);
}

/** Splash de arranque: mientras la sesión es desconocida ('idle') o se está hidratando ('loading') NO se pinta la UI de invitado. */
function BootSplash() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Cargando Melodya"
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-6 bg-background bg-noise px-6"
    >
      <span className="view-in flex flex-col items-center gap-4">
        <MelodyaLogo className="scale-125" />
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-amber border-t-transparent" aria-hidden />
        <p className="text-sm text-muted-foreground">Preparando tu estudio…</p>
      </span>
    </div>
  );
}

/** Boundary por vista: se reinicia solo al cambiar de ruta (key={path}). */
function ViewsBoundary() {
  const { path } = useRoute();
  return (
    <ViewErrorBoundary key={path}>
      <Outlet />
    </ViewErrorBoundary>
  );
}

/** Contenido persistente (dentro del router y de los providers). */
function PersistentShell() {
  const user = useAuthStore((s) => s.user);
  const { path } = useRoute();
  useGenerationReconciliation();
  useDocumentTitle(path, !user);
  useScrollToTopOnNavigate();
  return (
    <AppShell>
      <ViewsBoundary />
    </AppShell>
  );
}

export function RootLayout() {
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const status = useAuthStore((s) => s.status);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /* Un usuario logueado que recarga (F5) ve el splash y luego SU estudio — nunca la landing ni la sidebar de invitado. */
  const booted = status !== 'idle' && status !== 'loading';

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {booted ? <PersistentShell /> : <BootSplash />}
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/* ── Guardas ───────────────────────────────────────────── */

/** Ruta protegida: muestra el aviso de acceso a invitados (sin redirect, igual que la web Next). */
function RequireAuth() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  if (status === 'idle' || status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center" aria-busy="true">
        <div className="flex flex-col items-center gap-3">
          <span className="h-10 w-10 animate-spin rounded-full border-2 border-amber border-t-transparent" aria-hidden />
          <p className="text-sm text-muted-foreground">Cargando tu estudio…</p>
        </div>
      </div>
    );
  }
  if (!user) {
    return (
      <div className="view-in mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full gradient-warm">
          <Music4 className="h-8 w-8 text-primary-foreground" aria-hidden />
        </div>
        <h2 className="font-display text-2xl font-extrabold">Esta sección es para vos</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Iniciá sesión para acceder a tu biblioteca, tus fichas y todo tu mundo creativo.
        </p>
        <div className="flex gap-3">
          <Button variant="outline" className="rounded-full" onClick={() => navigate('/login')}>
            Ingresar
          </Button>
          <Button className=" rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" onClick={() => navigate('/register')}>
            Crear cuenta gratis
          </Button>
        </div>
      </div>
    );
  }
  return <Outlet />;
}

/** 404 (y rutas legacy en español con path limpio → se redirigen a su equivalente actual). */
function NotFound() {
  const { path, query } = useRoute();
  const mapped = normalizePath(path);
  if (mapped !== path) return <Navigate to={`${mapped}${query.toString() ? `?${query.toString()}` : ''}`} replace />;
  return (
    <div className="view-in mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-4 text-center">
      <p className="font-display text-6xl font-extrabold text-gradient-warm">404</p>
      <h2 className="font-display text-xl font-bold">Esta nota no existe</h2>
      <p className="text-sm text-muted-foreground">La página que buscás se fue de gira. Volvamos al estudio.</p>
      <Button className="rounded-full" onClick={() => navigate('/')}>
        Ir al inicio
      </Button>
    </div>
  );
}

/* ── Vistas (carga diferida por ruta) ──────────────────── */

const homeRoute = {
  lazy: async () => {
    const { HomeView, LandingView } = await import('@/features/home/views');
    return {
      Component: function HomeRoute() {
        const user = useAuthStore((s) => s.user);
        return user ? <HomeView /> : <LandingView />;
      },
    };
  },
};

/** Login / registro: si ya hay sesión, vuelve al inicio. */
const guestOnly = (name: 'LoginView' | 'RegisterView') => ({
  lazy: async () => {
    const views = await import('@/features/auth/views');
    const View = views[name];
    return {
      Component: function GuestRoute() {
        const user = useAuthStore((s) => s.user);
        return user ? <Navigate to="/" replace /> : <View />;
      },
    };
  },
});

const authView = (name: 'ForgotView' | 'ResetView') => ({
  lazy: async () => ({ Component: (await import('@/features/auth/views'))[name] }),
});

const libraryRoute = { lazy: async () => ({ Component: (await import('@/features/library/LibraryView')).LibraryView }) };
const profileRoute = { lazy: async () => ({ Component: (await import('@/features/profile/ProfileView')).ProfileView }) };

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    HydrateFallback: BootSplash,
    children: [
      { index: true, ...homeRoute },
      { path: 'login', ...guestOnly('LoginView') },
      { path: 'register', ...guestOnly('RegisterView') },
      { path: 'forgot-password', ...authView('ForgotView') },
      { path: 'reset-password', ...authView('ResetView') },
      {
        path: 'songs/:id',
        lazy: async () => {
          const { SongDetailView } = await import('@/features/song/SongDetailView');
          return {
            Component: function SongRoute() {
              const { id = '' } = useParams();
              return <SongDetailView songId={id} />;
            },
          };
        },
      },
      { path: 'community', lazy: async () => ({ Component: (await import('@/features/community/CommunityView')).CommunityView }) },
      {
        path: 'user/:id',
        lazy: async () => {
          const { PublicProfileView } = await import('@/features/community/PublicProfileView');
          return {
            Component: function UserRoute() {
              const { id = '' } = useParams();
              return <PublicProfileView userId={id} />;
            },
          };
        },
      },
      { path: 'plans', lazy: async () => ({ Component: (await import('@/features/billing/PricingView')).PricingView }) },
      {
        // Rutas privadas: el aviso de acceso se muestra sin redirigir.
        element: <RequireAuth />,
        children: [
          {
            path: 'create',
            lazy: async () => {
              const { CreatorWizard } = await import('@/features/creator/CreatorWizard');
              return {
                Component: function CreateRoute() {
                  const { query } = useRoute();
                  /* `key` por canción de origen: la creación normal y cada «otra versión» son instancias separadas (no se arrastra estado ni borrador). */
                  const key = query.get('remix') ? `remix:${query.get('remix')}:${query.get('mode') ?? ''}` : (query.get('song') ?? 'new');
                  return <CreatorWizard key={key} />;
                },
              };
            },
          },
          { path: 'library/*', ...libraryRoute },
          { path: 'library', ...libraryRoute },
          { path: 'notifications', lazy: async () => ({ Component: (await import('@/features/notifications/NotificationsView')).NotificationsView }) },
          { path: 'profile/*', ...profileRoute },
          { path: 'profile', ...profileRoute },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

registerAppRouter(router);
