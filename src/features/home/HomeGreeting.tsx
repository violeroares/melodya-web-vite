'use client';

/**
 * Saludo del inicio: «¡Hola, usuario!» + saldo de fichas.
 * Vive en el Header en desktop y arriba de la órbita en mobile (ver HomeView).
 */
import React from 'react';
import { CoinIcon } from '@/components/common/CoinIcon';
import { useAuthStore } from '@/stores/auth';
import { useCredits } from '@/hooks';

function firstName(name?: string | null): string {
  const n = (name ?? '').trim();
  return n ? n.split(/\s+/)[0] : '';
}

export function HomeGreeting({ headingId }: { headingId?: string }) {
  const user = useAuthStore((s) => s.user);
  const credits = useCredits();
  const balance = credits.data?.balance ?? user?.creditsBalance;
  const name = firstName(user?.name);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 id={headingId} className="font-display text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
        ¡Hola{name ? `, ${name}` : ''}!
      </h1>
      {typeof balance === 'number' && (
        <span className="hidden items-center gap-1.5 rounded-full bg-voice px-3 py-1 text-xs font-bold text-on-voice md:inline-flex sm:text-[15px]">
          <CoinIcon className="h-4 w-4 text-gold" aria-hidden />
          {balance} fichas
        </span>
      )}
    </div>
  );
}
