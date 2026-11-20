import { createRoot, type Root } from 'react-dom/client';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource/bricolage-grotesque/500.css';
import '@fontsource/bricolage-grotesque/600.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/700.css';
import '@/styles/globals.css';
import { RouterProvider } from 'react-router-dom';
import { API_CONFIG_ERROR } from '@/lib/api/client';
import { migrateLegacyResetLink } from '@/lib/links';

/** Configuración del backend ausente o inválida: pantalla de diagnóstico, sin fallback hacia ningún servidor alternativo. */
function ConfigError({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground" role="alert">
      <div className="max-w-lg space-y-3 rounded-2xl border border-destructive/40 bg-card p-6">
        <h1 className="text-lg font-semibold">Melodya no puede conectarse al backend</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        <p className="text-xs text-muted-foreground">
          Esta web es únicamente el frontend: necesita la URL del backend oficial de Melodya en <code>VITE_API_BASE_URL</code>.
        </p>
      </div>
    </main>
  );
}

const rootEl = document.getElementById('root')!;

async function start() {
  // En desarrollo, el HMR re-ejecuta este módulo: se reutiliza el mismo root (React no admite dos createRoot sobre un contenedor).
  const root: Root = (import.meta.hot?.data.root as Root | undefined) ?? createRoot(rootEl);
  if (import.meta.hot) import.meta.hot.data.root = root;
  if (API_CONFIG_ERROR) {
    root.render(<ConfigError message={API_CONFIG_ERROR} />);
    return;
  }
  // El correo de recuperación del backend aún emite `/#/reset-password?token=…`: se lleva a `/reset-password#token=…`
  // ANTES de crear el router (única compatibilidad con `#/`; ver lib/links.ts).
  migrateLegacyResetLink();
  const { router } = await import('@/routes');
  root.render(<RouterProvider router={router} />);
}

void start();
