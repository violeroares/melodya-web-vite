
/**
 * MELODYA WEB — ViewErrorBoundary: error boundary por vista.
 * Un crash de una sección no tumba toda la app: fallback cálido en es-AR con
 * "Intentar de nuevo" y "Volver al inicio". Se monta con key={ruta} desde el
 * punto de entrada para que cada vista tenga un boundary fresco.
 */
import React from 'react';
import { Music4, RefreshCw } from 'lucide-react';
import { navigate } from '@/lib/router';
import { Button } from '@/components/ui/button';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ViewErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log de desarrollo (no alertamos al usuario con esto).
    console.error('[Melodya] Error en la vista:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  private goHome = () => {
    this.reset();
    navigate('/');
  };

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="view-in mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
          <div className="grid-music relative flex h-16 w-16 items-center justify-center rounded-3xl border border-amber/30 bg-amber/10 text-amber-strong">
            <Music4 className="h-8 w-8" aria-hidden />
          </div>
          <h2 className="font-display text-2xl font-extrabold text-foreground">Se desafinó algo 🎵</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Esta sección tuvo un problema y no pudimos mostrarla. Tus canciones y tus fichas están a salvo.
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <Button onClick={this.reset} className="rounded-full">
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
              Intentar de nuevo
            </Button>
            <Button variant="outline" onClick={this.goHome} className="rounded-full">
              Volver al inicio
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
