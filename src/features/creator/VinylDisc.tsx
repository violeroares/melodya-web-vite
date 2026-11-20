
import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Disco de vinilo del prototipo «Generar canción · animación» (design-V2): fondo azul muy oscuro, surcos concéntricos,
 * un brillo en cono, la etiqueta naranja y su agujero. No gira por sí solo: quien lo usa le pone la animación.
 */
export function VinylDisc({ className, style, plain, sheenRef }: { className?: string; style?: React.CSSProperties; /** Sin etiqueta ni agujero (en el lanzamiento, el centro de la canción hace de etiqueta). */ plain?: boolean; sheenRef?: React.Ref<HTMLDivElement> }) {
  return (
    <div
      aria-hidden
      className={cn('overflow-hidden rounded-full', className)}
      style={{
        background: 'radial-gradient(circle, #1B2A4D 0%, #111B36 58%, #0A1122 100%)',
        boxShadow: '0 18px 40px -12px rgba(0,0,0,.6), 0 0 46px 2px rgba(255,107,77,.16), 0 0 0 1px rgba(255,255,255,.1)',
        ...style,
      }}
    >
      <svg className="absolute inset-0 size-full" viewBox="0 0 280 280" fill="none">
        {Array.from({ length: 14 }).map((_, k) => (
          <circle key={k} cx="140" cy="140" r={(57.6 + (k * (132.9 - 57.6)) / 13).toFixed(1)} stroke={`rgba(255,255,255,${(0.06 + (0.06 * (k % 3)) / 2).toFixed(3)})`} />
        ))}
      </svg>
      <div
        ref={sheenRef}
        className="absolute inset-0 rounded-full"
        style={{ background: 'conic-gradient(from 0deg, rgba(255,255,255,0) 0 6%, rgba(255,255,255,.22) 11%, rgba(255,255,255,0) 17% 56%, rgba(255,255,255,.14) 61%, rgba(255,255,255,0) 67%)' }}
      />
      {!plain && (
        <>
        <span className="absolute top-1/2 left-1/2 size-[32%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
        <span className="absolute top-1/2 left-1/2 size-[3.5%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#03050B]" />
        </>
      )}
    </div>
  );
}
