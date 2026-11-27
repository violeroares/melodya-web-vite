/**
 * MELODYA WEB — Planes y fichas (ruta /plans, pública).
 * Contrato real (audit §2.5, §2.6 y §7):
 *  • GET /plans → { items: SubscriptionPlan[] } y GET /plans/credit-packages → { items: CreditPackage[] } (públicos).
 *    v0.18: cada plan/pack incluye previousPriceCents (tachado si existe), features
 *    (ítems check ✓/✗ administrados desde el backoffice) y purchaseCount (compras
 *    reales → badges «El favorito» / «Más popular», nada hardcodeado).
 *  • Las COMPRAS (alta de plan, mejora, baja y paquetes) se hacen en Melodya Store con Mercado Pago (POST /billing/checkout, solo desde Store): acá NO se llama al checkout
 *    simulado. Web muestra el estado y abre Store con la sesión actual; «Deshacer el cambio» (POST /billing/subscriptions/:id/resume) y «Cancelar renovación» siguen acá.
 *  • GET /credits → { balance } · GET /credits/transactions ?page&pageSize&type 🔒
 *    (la API filtra por un solo type → el filtro "Compras" combina PACKAGE_PURCHASE
 *     + PLAN_GRANT con dos fetch paralelos).
 *  • Plan efectivo: GET /users/me → user.effectivePlan { code, name, isDefault, source: 'BASE' | 'SUBSCRIPTION' }. Free es el plan BASE (no es una
 *    suscripción). Suscripción paga: user.subscription { plan, currentPeriodEnd, pendingPlan, scheduledChange } | null.
 *  • Con una suscripción paga de Mercado Pago: un plan SUPERIOR (Creator → Pro) cobra la diferencia prorrateada y activa Pro al verificar el pago; un plan INFERIOR (Pro → Creator)
 *    queda PROGRAMADO para el próximo período. Ambos se confirman en Store (con su cotización); acá se ve el plan vigente y el cambio pendiente (`scheduledChange`).
 * Precios y fichas SIEMPRE desde el backend (nada hardcodeado).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BadgeCheck, Check, Info, Loader2, Sparkles, X } from 'lucide-react';
import { CoinIcon } from '@/components/common/CoinIcon';
import { billingApi } from '@/lib/api';
import { navigate } from '@/lib/router';
import { toUserMessage } from '@/lib/errors';
import { useAuthStore } from '@/stores/auth';
import { formatPriceCents, formatRelative, useCredits } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import { useRefreshCommercialState } from '@/hooks/use-commercial-state';
import type { CreditPackage, SubscriptionPlan } from '@/types';
import {
  PLAN_CHANGES_UNAVAILABLE_NOTE, formatDateDMY, planCtaLabel, planRole, resumeNotice, withPlanChangeCapability,
  type PlanRole,
} from '@/lib/subscription';
import { cn } from '@/lib/utils';
import { Chip, EmptyState, ErrorState, SectionHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { SubscriptionCard } from './SubscriptionCard';
import { OpenStoreButton } from './OpenStoreButton';
import { usePageRestore } from '@/hooks/use-page-restore';
import { openStore, packBuyMode, type StoreProduct } from '@/lib/store-link';
import { CurrentPlanCard } from './CurrentPlanCard';
import { msUntilNextPromotionEnd, priceChanged, priceView, promotionEndsText, serverNowMs } from '@/lib/pricing';

/** Entero con separador es-AR (1000 → 1.000). */
const fmtInt = (n: number) => n.toLocaleString('es-AR');

/** Id del ítem más comprado según purchaseCount real del backend; sin compras registradas no hay destacado
 *  (empate → el primero del catálogo). Lo usan «El favorito» / «Más popular» en Planes y fichas y en el Inicio. */
export function mostPurchasedId<T extends { id: string; purchaseCount?: number | null }>(items: T[]): string | null {
  const best = items.reduce<T | null>((max, p) => ((p.purchaseCount ?? 0) > (max?.purchaseCount ?? 0) ? p : max), null);
  return best && (best.purchaseCount ?? 0) > 0 ? best.id : null;
}

export function PricingView() {
  const qc = useQueryClient();
  const refreshCommercial = useRefreshCommercialState(); // UN solo mecanismo: perfil + consumo + saldo + movimientos
  const { toast } = useToast();
  const user = useAuthStore((s) => s.user);
  const authStatus = useAuthStore((s) => s.status);
  const isLoggedIn = authStatus === 'authenticated' && !!user;

  const creditsQuery = useCredits();

  // El precio puede ser personal (cupo por usuario, primera compra): la clave incluye al usuario para no mezclar cachés.
  const priceScope = user?.id ?? 'anon';
  const plansQuery = useQuery({ queryKey: ['plans', priceScope], queryFn: () => billingApi.plans() });
  const packsQuery = useQuery({ queryKey: ['credit-packages', priceScope], queryFn: () => billingApi.packages() });
  const plans = useMemo(
    () => [...(plansQuery.data?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [plansQuery.data]
  );
  const packs = useMemo(
    () => [...(packsQuery.data?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [packsQuery.data]
  );
  /** Pack «El favorito»: el MÁS COMPRADO según purchaseCount real del backend (v0.18).
   *  Sin compras registradas no hay destacado (nada hardcodeado). Empate → el primero
   *  en orden de catálogo (sortOrder). */
  const favoritePackId = useMemo(() => mostPurchasedId(packs), [packs]);
  /** Plan «Más popular»: el MÁS COMPRADO según purchaseCount real del backend (v0.18). */
  const popularPlanId = useMemo(() => mostPurchasedId(plans), [plans]);

  const subscription = user?.subscription ?? null;
  // Capacidad de cambiar de plan con Mercado Pago: la decide el backend (sin dato = deshabilitada).
  const checkoutStatusQuery = useQuery({ queryKey: ['checkout-status'], queryFn: () => billingApi.checkoutStatus(), staleTime: 60_000 });
  const planChangesEnabled = checkoutStatusQuery.data?.planChanges?.enabled === true;
  const effectivePlan = user?.effectivePlan ?? null;
  const roleCtx = { effectivePlan, subscription };
  // Cuando vence la primera promoción que se muestra (según el reloj del servidor) se vuelve a pedir el catálogo: no queda una oferta terminada en pantalla.
  const serverTime = plansQuery.data?.serverTime ?? packsQuery.data?.serverTime;
  const pricedAt = plansQuery.data?.serverTime ? plansQuery.dataUpdatedAt : packsQuery.dataUpdatedAt;
  useEffect(() => {
    const ms = msUntilNextPromotionEnd([...plans, ...packs], serverNowMs(serverTime, pricedAt, Date.now()));
    if (ms === null) return undefined;
    const timer = setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ['plans'] });
      void qc.invalidateQueries({ queryKey: ['credit-packages'] });
    }, Math.min(ms + 1500, 2_000_000_000));
    return () => clearTimeout(timer);
  }, [plans, packs, serverTime, pricedAt, qc]);

  /** Deshace el cambio de plan programado (o la cancelación) de la suscripción vigente. */
  const resume = useMutation({
    mutationFn: () => billingApi.resumeSubscription(subscription!.id),
    onSuccess: (res) => {
      void refreshCommercial();
      toast(resumeNotice(res));
    },
    onError: (err) => {
      void refreshCommercial();
      toast({ title: 'No pudimos deshacer el cambio', description: toUserMessage(err), variant: 'destructive' });
    },
  });

  /** Producto (pack o plan) que se está abriendo en Store (mientras se pide el código de acceso). */
  const [openingStoreFor, setOpeningStoreFor] = useState<string | null>(null);
  /* Volver de Store con «atrás» restaura esta página desde el bfcache con el botón todavía en «abriendo»: se libera para poder elegir de nuevo (packs, Creator y Pro). */
  usePageRestore(() => setOpeningStoreFor(null));
  /**
   * Los PAQUETES y los PLANES (alta, mejora, baja) se pagan y gestionan en Melodya Store con Mercado Pago (el mismo checkout real, sin duplicarlo acá). Acá nunca se llama al checkout
   * simulado: si Store no está configurada se avisa y no se compra nada.
   */
  const openStoreFor = async (product: StoreProduct, next: '/store#fichas' | '/store#planes') => {
    const productId = product.id;
    const mode = packBuyMode({ loggedIn: !!user });
    if (mode === 'login') {
      toast({ title: 'Ingresá para comprar', description: 'Creá tu cuenta gratis y volvé para sumar fichas.' });
      navigate('/login');
      return;
    }
    if (mode === 'store-not-configured') {
      toast({
        title: 'La tienda no está configurada',
        description: 'Las compras se hacen en Melodya Store y todavía no está disponible en este entorno (falta VITE_STORE_URL). No se realizó ninguna compra.',
        variant: 'destructive',
      });
      return;
    }
    setOpeningStoreFor(productId);
    try {
      await openStore(next, product);
    } catch (err) {
      setOpeningStoreFor(null);
      toast({ title: 'No pudimos abrir la tienda', description: toUserMessage(err), variant: 'destructive' });
    }
  };
  const buyPack = (pack: CreditPackage) => openStoreFor({ kind: 'pack', id: pack.id }, '/store#fichas');
  const buyPlan = (plan: SubscriptionPlan) => openStoreFor({ kind: 'plan', id: plan.id }, '/store#planes');

  return (
    <div className="view-in">
      {/* ── Header ── */}
      <header className="mb-8">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-foreground">Planes y fichas</h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Elegí cómo querés abastecer tu creatividad.
        </p>

        {/* Entrada a Melodya Store con la sesión actual (código de un solo uso). En el encabezado para que se vea sin desplazarse: el saldo de abajo ocupa mucho alto. */}
        {isLoggedIn && (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <OpenStoreButton />
            <span className="text-sm text-muted-foreground">Pagá con Mercado Pago en la Tienda de Melodya.</span>
          </div>
        )}

        {isLoggedIn && (
          <div className="mt-6 flex items-center gap-4 sm:gap-7">
            {/* Ficha de Melodya (public/ficha-melodya.svg) en lugar del rayo */}
            <img src="/ficha-melodya.svg" alt="" aria-hidden className="h-28 w-auto shrink-0 sm:h-40 lg:h-48" />
            <div className="min-w-0">
              <p className="text-sm font-semibold uppercase tracking-wider text-gold sm:text-lg">Tu saldo</p>
              {creditsQuery.isLoading ? (
                <div role="status" className="mt-2 flex items-center gap-2">
                  <Skeleton className="h-14 w-48" />
                  <span className="sr-only">Cargando saldo…</span>
                </div>
              ) : (
                <p className="font-display text-5xl leading-tight font-extrabold text-foreground sm:text-6xl lg:text-7xl">
                  {fmtInt(creditsQuery.data?.balance ?? user?.creditsBalance ?? 0)}{' '}
                  <span className="text-xl font-semibold sm:text-2xl lg:text-3xl">fichas</span>
                </p>
              )}
            </div>
          </div>
        )}
      </header>

      {/* ── Tu suscripción: estado de la renovación y cancelación ── */}
      {isLoggedIn && effectivePlan?.source === 'BASE' && (
        <CurrentPlanCard effectivePlan={effectivePlan} entitlements={plans.find((p) => p.id === effectivePlan.id)?.entitlements ?? user?.entitlements} />
      )}
      {isLoggedIn && subscription && (
        <SubscriptionCard subscription={subscription} entitlements={plans.find((p) => p.id === subscription.plan.id)?.entitlements ?? user?.entitlements} />
      )}

      {/* ── Paquetes de fichas (la compra más común, va primero) ── */}
      <section>
        <SectionHeader
          title="Comprar un paquete de fichas"
          subtitle="Pago único: las fichas se acreditan al instante en tu cuenta."
        />
        {isLoggedIn && <div className="mb-4"><OpenStoreButton /></div>}
        {packsQuery.isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy="true" aria-label="Cargando paquetes de fichas">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-80 rounded-cover" />
            ))}
          </div>
        ) : packsQuery.isError ? (
          <ErrorState message="No pudimos cargar los paquetes de fichas." onRetry={() => void packsQuery.refetch()} />
        ) : packs.length === 0 ? (
          <EmptyState
            icon={<CoinIcon className="h-6 w-6" />}
            title="No hay paquetes disponibles"
            description="Volvé a intentar en unos minutos: estamos afinando los precios."
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
            {packs.map((pack) => (
              <PackCard
                key={pack.id}
                pack={pack}
                popular={pack.id === favoritePackId}
                busy={openingStoreFor === pack.id}
                onBuy={() => void buyPack(pack)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Planes ── */}
      <section className="mt-12">
        <SectionHeader
          title="O suscribite a un plan"
          subtitle="Fichas todos los meses, para no quedarte a mitad de una canción."
        />
        {plansQuery.isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-busy="true" aria-label="Cargando planes">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-88 rounded-cover" />
            ))}
          </div>
        ) : plansQuery.isError ? (
          <ErrorState message="No pudimos cargar los planes." onRetry={() => void plansQuery.refetch()} />
        ) : plans.length === 0 ? (
          <EmptyState
            icon={<BadgeCheck className="h-6 w-6" />}
            title="No hay planes disponibles"
            description="Volvé a intentar en unos minutos: estamos afinando los planes."
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4">
            {plans.map((plan) => {
              const role = withPlanChangeCapability(planRole(plan, roleCtx), { provider: subscription?.provider, planChangesEnabled });
              const mine = subscription?.plan?.id === plan.id;
              return (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  popular={!plan.isDefault && plan.id === popularPlanId}
                  role={role}
                  renewalCanceled={mine && Boolean(subscription?.cancelAtPeriodEnd)}
                  renewsOn={mine && subscription?.currentPeriodEnd ? formatDateDMY(subscription.currentPeriodEnd) : null}
                  scheduledOn={role === 'scheduled' && subscription?.scheduledChange ? formatDateDMY(subscription.scheduledChange.effectiveAt) : null}
                  busy={openingStoreFor === plan.id || (role === 'scheduled' && resume.isPending)}
                  onSubscribe={() => {
                    if (role === 'scheduled') {
                      resume.mutate(); // deshacer un cambio programado: mismo endpoint que Store
                      return;
                    }
                    void buyPlan(plan); // alta, mejora o baja: se hacen en Store con Mercado Pago
                  }}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Dónde se paga */}
      <p className="mt-6 flex max-w-2xl items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        Los planes y los paquetes de fichas se contratan y se pagan en la Tienda de Melodya con Mercado Pago; desde ahí también podés mejorar, bajar o cancelar tu plan.
      </p>

      {/* El historial de fichas vive en Perfil → Mi actividad */}
      {isLoggedIn && (
        <p className="mt-10 text-center">
          <Button variant="link" className="text-amber-strong" onClick={() => navigate('/profile/activity')}>Ver mi actividad</Button>
        </p>
      )}
    </div>
  );
}

/* Estilo de las tarjetas de «Empezá gratis. Seguí creando.» de la landing: borde fino, esquinas 28/28/14/14, el más elegido en coral
   y el botón como barra oscura pegada al borde izquierdo con el círculo dorado de la flecha. */
const PRICING_CARD = '@container relative flex flex-col gap-0 rounded-[28px_28px_14px_14px] border border-border bg-surface py-0 transition-all duration-300 hover:-translate-y-0.5';
const PRICING_CARD_POPULAR = 'border-primary bg-primary text-[#131C33]';
/* El relleno y los tamaños se ajustan al ancho de la tarjeta (container queries), no al de la pantalla: en las grillas de 2–3 columnas las tarjetas quedan angostas. */
const PRICING_CARD_BODY = 'flex h-full flex-col px-5 py-6 [--pad:20px] @[300px]:px-[30px] @[300px]:py-[34px] @[300px]:[--pad:30px]';

/** Botón de la tarjeta: barra navy que sale del borde izquierdo (se compensa el padding de 30px) + círculo dorado con la flecha. */
function PricingCta({
  onClick,
  disabled,
  busy,
  children,
  ariaLabel,
}: {
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'group -ml-[var(--pad)] flex min-h-[52px] w-[calc(100%+var(--pad))] items-center rounded-r-[28px] bg-[#131C33] py-1.5 pr-1.5 pl-5 text-left text-sm leading-tight font-bold @[300px]:pl-7 @[300px]:text-base text-[#F3E5E2] transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
        disabled ? 'cursor-not-allowed opacity-60' : 'hover:opacity-90'
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 pr-2">{children}</span>
      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33]">
        {busy ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <ArrowRight className="h-[18px] w-[18px] transition-transform group-hover:translate-x-0.5" strokeWidth={2.5} />}
      </span>
    </button>
  );
}

/* ── Tarjeta de paquete de fichas ── */
export function PackCard({ pack, popular, busy, onBuy }: { pack: CreditPackage; popular: boolean; busy: boolean; onBuy: () => void }) {
  // Con promoción: el precio final, el tachado y el ahorro salen del servidor (misma cotización que la orden). Sin promoción rige el
  // «precio anterior» manual del catálogo, como siempre (C10 pendiente).
  const view = priceView(pack);
  const hasPrevious = view.strikeCents != null;
  const discountPct =
    !view.promotion && hasPrevious && view.finalCents > 0 ? Math.round((1 - view.finalCents / view.strikeCents!) * 100) : null;
  const endsText = promotionEndsText(view.promotion?.endsAt);
  const soft = popular ? 'text-[#131C33]/75' : 'text-muted-foreground';
  const strong = popular ? 'text-[#131C33]' : 'text-foreground';
  const chip = popular ? 'border-[#131C33]/30 bg-[#131C33]/10 text-[#131C33]' : 'border-coral/40 bg-coral/10 text-coral';

  return (
    <Card className={cn(PRICING_CARD, popular && PRICING_CARD_POPULAR)}>
      {popular && (
        <span className="absolute right-5 top-6 z-10 text-[11px] @[300px]:right-[30px] @[300px]:top-[34px] font-bold uppercase tracking-wider text-[#131C33]">El favorito</span>
      )}
      <CardContent className={PRICING_CARD_BODY}>
        <h3 className={cn('font-display text-2xl font-bold @[300px]:text-3xl', popular && 'pr-20 @[300px]:pr-24', strong)}>{pack.name}</h3>
        <p className="mt-5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={cn('font-display text-5xl leading-none font-bold tabular-nums @[300px]:text-6xl', strong)}>{fmtInt(pack.credits)}</span>
          <span className={cn('text-sm font-medium', soft)}>fichas</span>
        </p>
        {pack.bonusCredits > 0 && (
          <Badge
            variant="outline"
            className={cn('mt-3 w-fit gap-1.5', popular ? 'border-[#131C33]/30 bg-[#131C33]/10 text-[#131C33]' : 'border-amber/40 bg-amber/10 text-amber-strong')}
          >
            <Sparkles className="h-3 w-3" aria-hidden />+{fmtInt(pack.bonusCredits)} fichas de regalo
          </Badge>
        )}
        {pack.description && <p className={cn('mt-3 text-[15px] leading-relaxed', soft)}>{pack.description}</p>}
        <p className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {hasPrevious && (
            <span
              className={cn('text-sm font-medium tabular-nums line-through', popular ? 'text-[#131C33]/70 decoration-[#131C33]/60' : 'text-muted-foreground decoration-coral/70')}
              aria-label="Precio anterior"
            >
              {formatPriceCents(view.strikeCents!, pack.currency)}
            </span>
          )}
          <span className={cn('font-display text-2xl font-bold tabular-nums', strong)}>{formatPriceCents(view.finalCents, pack.currency)}</span>
          {discountPct != null && (
            <Badge variant="outline" className={cn('h-5 px-1.5 text-[11px] font-bold', chip)}>
              −{discountPct}%
            </Badge>
          )}
        </p>
        {view.promotion && (
          <p className={cn('mt-1.5 text-xs font-semibold', popular ? 'text-[#131C33]' : 'text-coral')} data-testid="promo-note">
            {view.promotion.name} · ahorrás {formatPriceCents(view.savingsCents!, pack.currency)}{endsText ? ` · ${endsText}` : ''}
          </p>
        )}
        <div className="mt-auto pt-6">
          <PricingCta
            onClick={onBuy}
            disabled={busy}
            busy={busy}
            ariaLabel={`Comprar ${fmtInt(pack.credits)} fichas por ${formatPriceCents(view.finalCents, pack.currency)}`}
          >
            <CoinIcon className="h-4 w-4 shrink-0" aria-hidden />
            <span>Comprar {fmtInt(pack.credits)} fichas</span>
          </PricingCta>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Tarjeta de plan ── */
export function PlanCard({
  plan,
  popular,
  role,
  renewsOn,
  scheduledOn = null,
  renewalCanceled = false,
  busy,
  onSubscribe,
}: {
  plan: SubscriptionPlan;
  popular: boolean;
  /** Qué es este plan para el usuario: plan base, plan vigente, destino de un cambio programado, o contratable/mejora/baja. */
  role: PlanRole;
  renewsOn: string | null;
  /** Fecha (DD/MM/AAAA) desde la que regirá este plan si es el destino de un cambio programado. */
  scheduledOn?: string | null;
  /** La renovación está cancelada: se muestra «Vence» en lugar de «Renueva». */
  renewalCanceled?: boolean;
  busy: boolean;
  onSubscribe: () => void;
}) {
  // Con promoción: precio final, tachado y ahorro del servidor. Sin promoción rige el «precio anterior» manual del catálogo (C10 pendiente).
  const view = priceView(plan);
  const hasPrevious = view.strikeCents != null;
  const discountPct =
    !view.promotion && hasPrevious && view.finalCents > 0 ? Math.round((1 - view.finalCents / view.strikeCents!) * 100) : null;
  const endsText = promotionEndsText(view.promotion?.endsAt);
  const isCurrent = role === 'current' || role === 'base-current';
  const isBase = Boolean(plan.isDefault);
  const cta = planCtaLabel(role, plan.name);
  const features = plan.features ?? [];
  const soft = popular ? 'text-[#131C33]/75' : 'text-muted-foreground';
  const strong = popular ? 'text-[#131C33]' : 'text-foreground';
  const chip = popular ? 'border-[#131C33]/30 bg-[#131C33]/10 text-[#131C33]' : 'border-coral/40 bg-coral/10 text-coral';

  return (
    <Card className={cn(PRICING_CARD, popular && PRICING_CARD_POPULAR, isCurrent && !popular && 'border-amber/50')}>
      {(popular || isCurrent) && (
        <div className="absolute right-5 top-6 z-10 flex flex-col @[300px]:right-[30px] @[300px]:top-[34px] items-end gap-1.5">
          {popular && <span className="text-[11px] font-bold uppercase tracking-wider text-[#131C33]">Más popular</span>}
          {isCurrent && (
            <span className="rounded-full border border-amber/30 bg-surface-2 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-strong">
              {isBase ? `Tu plan ${plan.name}` : 'Tu plan actual'}
            </span>
          )}
        </div>
      )}
      <CardContent className={PRICING_CARD_BODY}>
        <h3 className={cn('pr-20 font-display text-2xl font-bold @[300px]:pr-24 @[300px]:text-3xl', strong)}>{plan.name}</h3>
        <p className="mt-5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {hasPrevious && (
            <span
              className={cn('text-base font-medium tabular-nums line-through', popular ? 'text-[#131C33]/70 decoration-[#131C33]/60' : 'text-muted-foreground decoration-coral/70')}
              aria-label="Precio anterior"
            >
              {formatPriceCents(view.strikeCents!, plan.currency)}
            </span>
          )}
          <span className={cn('font-display text-4xl leading-none font-bold tabular-nums @[300px]:text-5xl', strong)}>{isBase ? 'Gratis' : formatPriceCents(view.finalCents, plan.currency)}</span>
          {!isBase && <span className={cn('text-sm font-medium', soft)}> /mes</span>}
          {discountPct != null && (
            <Badge variant="outline" className={cn('h-5 px-1.5 text-[11px] font-bold', chip)}>
              −{discountPct}%
            </Badge>
          )}
        </p>
        {view.promotion && (
          <p className={cn('mt-1.5 text-xs font-semibold', popular ? 'text-[#131C33]' : 'text-coral')} data-testid="promo-note">
            {view.promotion.name} · ahorrás {formatPriceCents(view.savingsCents!, plan.currency)}{endsText ? ` · ${endsText}` : ''}
            <span className={cn('font-normal', soft)}> (en tu primer cobro)</span>
          </p>
        )}
        {plan.monthlyCredits > 0 && (
          <p className="mt-3 text-sm">
            <span className={cn('font-semibold', popular ? 'text-[#131C33]' : 'text-amber-strong')}>{fmtInt(plan.monthlyCredits)} fichas por mes</span>{' '}
            <span className={soft}>≈ {fmtInt(Math.round(plan.monthlyCredits / 12))} generaciones</span>
          </p>
        )}
        {features.length > 0 && (
          <ul className="mt-5 space-y-2.5" aria-label="Qué incluye el plan">
            {features.map((f, i) => (
              <li key={i} className="flex items-start gap-2.5 text-[15px]">
                <span className={cn('mt-1 flex h-4 w-4 shrink-0 items-center justify-center', f.included ? strong : soft)} aria-hidden>
                  {f.included ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <X className="h-4 w-4" strokeWidth={2.5} />}
                </span>
                <span className={f.included ? strong : soft}>
                  {f.label}
                  <span className="sr-only">{f.included ? ' (incluido)' : ' (no incluido)'}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {plan.description && <p className={cn('mt-3 text-[15px] leading-relaxed', soft)}>{plan.description}</p>}
        {!isBase && <p className={cn('mt-3 text-[13px]', soft)}>Cada período dura {plan.periodDays} días.</p>}
        <div className="mt-auto pt-6">
          {role === 'base-current' || role === 'base' ? (
            <p className={cn('text-center text-sm', soft)}>Incluido para todos los usuarios: no se contrata.</p>
          ) : role === 'current' ? (
            <>
              <PricingCta disabled ariaLabel="Plan activo">
                <BadgeCheck className="h-4 w-4 shrink-0" aria-hidden /> Plan activo
              </PricingCta>
              {renewsOn && <p className={cn('mt-2 text-center text-xs', soft)}>{renewalCanceled ? 'Vence' : 'Renueva'}: {renewsOn}</p>}
            </>
          ) : role === 'locked' ? (
            <p className={cn('text-center text-sm', soft)} data-testid="plan-change-unavailable">{PLAN_CHANGES_UNAVAILABLE_NOTE}</p>
          ) : role === 'scheduled' ? (
            <>
              <p className={cn('mb-2 text-center text-sm font-semibold', strong)} data-testid="scheduled-plan-note">Programado: rige desde el {scheduledOn}</p>
              <PricingCta onClick={onSubscribe} disabled={busy} busy={busy}>
                Deshacer el cambio
              </PricingCta>
            </>
          ) : (
            <PricingCta onClick={onSubscribe} disabled={busy} busy={busy}>
              {cta}
            </PricingCta>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Fila de transacción ── */
export default PricingView;
