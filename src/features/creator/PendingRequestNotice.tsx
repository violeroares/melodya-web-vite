
/**
 * Aviso de un pedido de generación sin confirmar (resultado incierto: se cortó la conexión, venció el tiempo o se cerró la página
 * justo después de enviarlo). Mientras exista no se puede enviar otro en el mismo contexto: se confirma reenviando EXACTAMENTE el
 * mismo pedido (misma clave), que el servidor no cobra dos veces. Ver lib/pending-request.ts.
 */

import { CircleAlert, RefreshCw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatRelative } from '@/hooks';
import type { PendingRecord } from '@/lib/pending-request';

export function PendingRequestNotice({ record, busy, onConfirm, onDiscard }: { record: PendingRecord; busy: boolean; onConfirm: () => void; onDiscard: () => void }) {
  return (
    <div role="alert" data-testid="pending-request" className="mb-5 flex flex-col gap-3 rounded-[28px] bg-surface p-4 text-sm sm:flex-row sm:items-center sm:rounded-full sm:py-3 sm:pr-3 sm:pl-5">
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-strong sm:mt-0" aria-hidden />
        <p className="min-w-0 flex-1">
          <span className="font-semibold">Tenés un pedido sin confirmar</span> (enviado {formatRelative(record.createdAt)}). Puede que ya se haya creado: confirmalo antes de armar otro. Se reenvía el mismo y no se cobra dos veces.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" disabled={busy} onClick={onConfirm}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden />}
          Confirmar pedido
        </Button>
        <Button variant="ghost" className="rounded-full" disabled={busy} onClick={onDiscard}>Descartar</Button>
      </div>
    </div>
  );
}
