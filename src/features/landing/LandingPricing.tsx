/**
 * MELODYA WEB — Sección «Precios» de la landing pública. Diseño de melodya.landing; los datos son los del backend:
 * mismos planes (GET /plans vía usePublicPlans), mismo precio final / tachado / promoción (priceView) y mismo «Más popular» que la página de
 * Planes. No hay planes, precios ni cantidades escritos acá. Sin sesión, suscribirse lleva a ingresar, igual que en «Planes y fichas».
 */
import React from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import { navigate } from '@/lib/router';
import { useToast } from '@/hooks/use-toast';
import { formatNumber, formatPriceCents } from '@/hooks';
import { priceView, promotionEndsText } from '@/lib/pricing';
import { ErrorState } from '@/components/common';
import { usePublicPlans } from '@/features/home/public-data';
import type { SubscriptionPlan } from '@/types';

function LandingPlanCard({ plan, featured, onChoose }: { plan: SubscriptionPlan; featured: boolean; onChoose: () => void }) {
  const view = priceView(plan);
  const isBase = Boolean(plan.isDefault);
  const endsText = promotionEndsText(view.promotion?.endsAt);
  const features = plan.features ?? [];
  return (
    <article className={`pricing-card ${featured ? 'featured' : ''}`}>
      {featured && <span className="popular">MÁS POPULAR</span>}
      <h3>{plan.name}</h3>
      {plan.description && <p className="plan-desc" title={plan.description}>{plan.description}</p>}
      <strong>
        {view.strikeCents != null && <s className="price-was" aria-label="Precio anterior">{formatPriceCents(view.strikeCents, plan.currency)}</s>}
        {isBase ? 'Gratis' : formatPriceCents(view.finalCents, plan.currency)}
        <small>{isBase ? 'para siempre' : '/ mes'}</small>
      </strong>
      <div className="annual-price" data-testid="promo-note">
        {view.promotion && view.savingsCents != null
          ? `${view.promotion.name} · ahorrás ${formatPriceCents(view.savingsCents, plan.currency)}${endsText ? ` · ${endsText}` : ''}`
          : ''}
      </div>
      <ul aria-label="Qué incluye el plan">
        {plan.monthlyCredits > 0 && !features.some((f) => /ficha/i.test(f.label)) && (
          <li><Check size={16} aria-hidden="true" />{formatNumber(plan.monthlyCredits)} fichas por mes</li>
        )}
        {features.map((f, i) => (
          <li key={i} className={f.included ? undefined : 'is-off'}>
            {f.included ? <Check size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
            <span>{f.label}<span className="sr-only">{f.included ? ' (incluido)' : ' (no incluido)'}</span></span>
          </li>
        ))}
      </ul>
      <button type="button" className="adv-btn" onClick={onChoose}>
        <span className="adv-c">{isBase ? 'Empezar gratis' : `Elegir ${plan.name.toLowerCase()}`}</span>
        <span className="adv-d"><ArrowRight size={22} aria-hidden="true" /></span>
      </button>
    </article>
  );
}

export function LandingPricing() {
  const { toast } = useToast();
  const { query, plans, popularPlanId } = usePublicPlans();

  const choose = (plan: SubscriptionPlan) => {
    if (plan.isDefault) {
      navigate('/register');
      return;
    }
    toast({ title: 'Ingresá para suscribirte', description: 'Creá tu cuenta gratis y volvé para elegir tu plan.' });
    navigate('/login');
  };

  return (
    <section className="pricing section" id="planes" aria-labelledby="landing-planes">
      <header>
        <p className="eyebrow">● PRECIOS CLAROS</p>
        <h2 id="landing-planes">Empezá gratis.<br /><span>Seguí creando.</span></h2>
        <p className="section-intro">Probá Melodya y encontrá tu forma de crear. Cuando quieras llevar tus ideas más lejos, elegí el plan que mejor acompañe tu ritmo.</p>
      </header>

      {query.isLoading ? (
        <div className="pricing-grid" aria-busy="true" aria-label="Cargando planes">
          {[0, 1, 2].map((i) => <div key={i} className="pricing-card is-loading" aria-hidden="true" />)}
        </div>
      ) : query.isError ? (
        <ErrorState message="No pudimos cargar los planes." onRetry={() => void query.refetch()} />
      ) : plans.length > 0 ? (
        <div className="pricing-grid">
          {plans.map((plan) => (
            <LandingPlanCard key={plan.id} plan={plan} featured={!plan.isDefault && plan.id === popularPlanId} onChoose={() => choose(plan)} />
          ))}
        </div>
      ) : null}

      <p className="pricing-note">Cambialo cuando quieras. Tus creaciones siempre siguen siendo tuyas.</p>
    </section>
  );
}
