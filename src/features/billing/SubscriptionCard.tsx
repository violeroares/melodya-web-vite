/**
 * MELODYA WEB — «Tu suscripción»: plan vigente, precio, fin del período y estado de la renovación, con la acción «Cancelar renovación».
 *
 * El servidor decide el estado (GET /users/me y POST /billing/subscriptions/:id/cancel): cancelar NO termina el plan, solo evita que se renueve;
 * los beneficios siguen hasta el fin del período vigente y no hay reembolso. Tras confirmar se muestra el estado real que devolvió el servidor.
 * Un cambio de plan programado (upgrade o downgrade) o la cancelación se muestran con el plan vigente, el cambio futuro, la fecha efectiva y lo que ocurrirá
 * ese día; ambos se pueden deshacer antes de su fecha (POST /billing/subscriptions/:id/resume). Free es el plan base, no una suscripción.
 * Confirmación con AlertDialog del Design System (sin alertas nativas), foco y teclado resueltos por el componente.
 */
import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CalendarClock, Crown, Info, Loader2, RefreshCw } from 'lucide-react';
import { billingApi } from '@/lib/api';
import { toUserMessage } from '@/lib/errors';
import { cancelDialogCopy, cancelErrorMessage, cancelOutcome, cancelRejection, canceledNotice, planPriceParts, planTitle, renewalState, resumeNotice, scheduledChangeView } from '@/lib/subscription';
import { PlanCapabilities } from './CurrentPlanCard';
import { PlanUsage } from './PlanUsage';
import { formatPriceCents } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import { useAuthStore } from '@/stores/auth';
import { useRefreshCommercialState } from '@/hooks/use-commercial-state';
import type { ActiveSubscription } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type CancelResponse = { subscription: ActiveSubscription; alreadyRequested?: boolean };

export function SubscriptionCard({ subscription, entitlements }: { subscription: ActiveSubscription; entitlements?: Record<string, { enabled: boolean; limit?: number } | undefined> | null }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const state = renewalState(subscription);
  const plan = subscription.plan;
  const parts = planPriceParts(plan);
  const price = parts ? formatPriceCents(parts.cents, parts.currency) : null;

  /** Vuelve a hidratar el estado comercial (perfil, consumo, saldo, movimientos): el estado visible es siempre el del servidor. */
  const refreshCommercial = useRefreshCommercialState();
  const refresh = () => void refreshCommercial();

  const cancel = useMutation({
    mutationFn: () => billingApi.cancelRenewal(subscription.id) as Promise<CancelResponse>,
    onSuccess: (res) => {
      // Se refleja la respuesta real del servidor y se refresca el perfil completo (capacidades, saldo).
      const current = useAuthStore.getState().user;
      if (current?.subscription) {
        useAuthStore.getState().setUser({
          ...current,
          subscription: { ...current.subscription, ...res.subscription, plan: { ...current.subscription.plan, ...res.subscription.plan } },
        });
      }
      refresh();
      setOpen(false);
      const out = cancelOutcome(res);
      toast(
        out.kind === 'already'
          ? { title: 'La cancelación ya estaba registrada', description: `Tu plan seguirá activo hasta el ${out.endsOn}.` }
          : { title: 'Renovación cancelada', description: `Conservás los beneficios de tu plan hasta el ${out.endsOn}.` }
      );
    },
    onError: (err) => {
      // Si el servidor dice que ya terminó o cambió, el estado local quedó viejo: se recarga.
      if (cancelRejection(err) || (err as { status?: number })?.status === 404) {
        refresh();
        setOpen(false);
      }
      toast({ title: 'No pudimos cancelar la renovación', description: cancelErrorMessage(err, toUserMessage(err)), variant: 'destructive' });
    },
  });

  const resume = useMutation({
    mutationFn: () => billingApi.resumeSubscription(subscription.id),
    onSuccess: (res) => {
      refresh();
      toast(resumeNotice(res));
    },
    onError: (err) => {
      refresh();
      toast({ title: 'No pudimos deshacer el cambio', description: cancelErrorMessage(err, toUserMessage(err)), variant: 'destructive' });
    },
  });

  const copy = cancelDialogCopy(plan.name, state.endsOn, subscription.provider);
  const providerManaged = subscription.provider === 'mercadopago';
  // Plan vigente / cambio futuro / fecha / qué pasará ese día (nunca se presenta el plan futuro como vigente).
  const scheduled = state.kind === 'ended' ? null : scheduledChangeView(subscription.scheduledChange, plan.name);
  const isPlanChange = subscription.scheduledChange?.kind === 'UPGRADE' || subscription.scheduledChange?.kind === 'DOWNGRADE';

  return (
    <Card className="mb-8 w-full rounded-cover border-amber/40 bg-surface" data-testid="subscription-card">
      <CardContent className="grid gap-6 p-5 lg:grid-cols-2 lg:gap-8">
        <div className="min-w-0 space-y-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Crown className="h-4 w-4 text-amber-strong" aria-hidden />
            <h2 className="font-display text-lg font-extrabold text-foreground">{planTitle(plan)}</h2>
            {state.kind === 'renews' && <Badge variant="outline" className="border-amber/40 text-amber-strong">Activa</Badge>}
            {state.kind === 'canceled' && <Badge variant="outline" className="border-border text-muted-foreground">Renovación cancelada</Badge>}
            {state.kind === 'ended' && <Badge variant="outline" className="border-border text-muted-foreground">Finalizada</Badge>}
            {state.kind === 'past_due' && <Badge variant="outline" className="border-border text-muted-foreground">Pago pendiente</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            {price ? <>{price}{parts?.period ? ` / ${parts.period}` : ''} · </> : null}
            <span className="inline-flex items-center gap-1">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              {state.kind === 'canceled' ? 'Vigente hasta' : 'El período actual termina el'} {state.endsOn}
            </span>
          </p>
          {state.kind === 'renews' && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Se renueva automáticamente el {state.endsOn}.
            </p>
          )}
          {state.kind === 'past_due' && (
            <p role="status" className="flex items-start gap-1.5 text-sm font-medium text-foreground" data-testid="past-due-notice">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-strong" aria-hidden /> No pudimos cobrar tu renovación. Mantenemos tu plan unos días mientras Mercado Pago vuelve a intentarlo; revisá tu medio de pago en Mercado Pago para no perderlo.
            </p>
          )}
          {state.kind === 'canceled' && (
            <p role="status" className="flex items-start gap-1.5 text-sm font-medium text-foreground" data-testid="renewal-canceled-notice">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-strong" aria-hidden /> {canceledNotice(state.endsOn)}.
            </p>
          )}
          {scheduled && (
            <div role="status" className="space-y-0.5 rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-sm" data-testid="scheduled-change">
              <p className="font-semibold text-foreground">{scheduled.current}</p>
              <p className="font-semibold text-amber-strong">{scheduled.future}</p>
              <p className="text-muted-foreground">{scheduled.what}</p>
            </div>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Qué incluye tu plan</summary>
            <PlanCapabilities entitlements={entitlements} className="mt-2" />
          </details>
        </div>

        <div className="flex flex-wrap gap-2">
          {((state.kind === 'canceled' && !providerManaged) || isPlanChange) && (
            <Button className="w-full rounded-full sm:w-auto" onClick={() => resume.mutate()} disabled={resume.isPending}>
              {resume.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />}
              {state.kind === 'canceled' ? 'Reactivar renovación' : 'Deshacer el cambio de plan'}
            </Button>
          )}
          {state.canCancel && (
            <Button variant="outline" className="w-full rounded-full sm:w-auto" onClick={() => setOpen(true)} disabled={cancel.isPending}>
              Cancelar renovación
            </Button>
          )}
        </div>
        </div>
        <PlanUsage className="border-t border-border/60 pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0" />
      </CardContent>

      <AlertDialog open={open} onOpenChange={(o) => !cancel.isPending && setOpen(o)}>
        <AlertDialogContent className="max-w-md border-border/70 bg-surface">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display">{copy.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <ul className="list-disc space-y-1.5 pl-5 text-left text-sm text-muted-foreground">
                  {copy.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancel.isPending}>Mantener mi plan</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancel.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!cancel.isPending) cancel.mutate();
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {cancel.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />}
              {cancel.isPending ? 'Cancelando…' : 'Cancelar renovación'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
