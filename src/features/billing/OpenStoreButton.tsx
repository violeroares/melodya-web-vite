import React, { useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toUserMessage } from '@/lib/errors';
import { useToast } from '@/hooks/use-toast';
import { usePageRestore } from '@/hooks/use-page-restore';
import { openStore, storeBaseUrl } from '@/lib/store-link';

/** Lleva al usuario a Melodya Store con su sesión actual (código de un solo uso): ahí se compran fichas y planes con Mercado Pago. No se muestra si la tienda no está configurada. */
export function OpenStoreButton({ next = '/store#fichas', label = 'Comprar en la Tienda' }: { next?: string; label?: string }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  usePageRestore(() => setBusy(false)); // volver de Store desde el bfcache restaura la página tal cual: se libera el botón
  if (!storeBaseUrl()) {
    // En producción no se muestra. En desarrollo se avisa por qué no aparece (Vite incorpora VITE_* al arrancar: hay que reiniciar `npm run dev` tras cambiarla).
    return import.meta.env.DEV ? (
      <p className="text-xs text-muted-foreground">Tienda sin configurar: definí VITE_STORE_URL (https, o http en localhost) y reiniciá el servidor de desarrollo.</p>
    ) : null;
  }

  async function go() {
    setBusy(true);
    try {
      await openStore(next);
    } catch (err) {
      setBusy(false);
      toast({ title: 'No pudimos abrir la tienda', description: toUserMessage(err), variant: 'destructive' });
    }
  }

  return (
    <Button type="button" onClick={() => void go()} disabled={busy} className="gap-2">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {busy ? 'Abriendo la tienda…' : label}
      {!busy ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
    </Button>
  );
}
