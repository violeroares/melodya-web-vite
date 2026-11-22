'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const WAVE_BARS = 64;
/** Cada línea mide 2 px de ancho y hay 4 px entre un inicio y el siguiente: al achicarse la onda se muestran menos líneas, nunca más finas ni apretadas. */
const BAR_PITCH = 4;

/** Alturas (20–100 %) de la forma de onda: deterministas por tema, sin leer el audio. */
function waveHeights(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < WAVE_BARS; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    const noise = (h % 1000) / 1000;
    const envelope = 0.35 + 0.65 * Math.abs(Math.sin((i / WAVE_BARS) * Math.PI * 3.2 + (h % 7)));
    out.push(Math.round(20 + 80 * Math.min(1, noise * 0.6 + envelope * 0.5)));
  }
  return out;
}

/** Progreso como forma de onda (design-V2): lo reproducido en dorado; el control real es un range nativo (teclado y lectores). */
export function Waveform({ seed, position, duration, onSeek, className, onVoice }: { seed: string; position: number; duration: number; onSeek: (sec: number) => void; className?: string; onVoice?: boolean }) {
  const heights = useMemo(() => waveHeights(seed), [seed]);
  /* Mientras el dedo/mouse arrastra, la onda sigue al puntero (vista previa) pero el audio se mueve UNA sola vez, al soltar:
     el range nativo emite «input» sin parar al arrastrar y cada uno hacía un seek al <audio> (en Safari/iOS, con streaming, eso se
     traduce en saltos y un segundo salto cuando termina de bufferizar). Con teclado (sin puntero) el seek es inmediato. */
  const [preview, setPreview] = useState<number | null>(null);
  const pointerDownRef = useRef(false);
  const pendingRef = useRef<number | null>(null);
  const commit = () => {
    pointerDownRef.current = false;
    const v = pendingRef.current;
    pendingRef.current = null;
    setPreview(null);
    if (v !== null) onSeek(v);
  };
  const shown = preview ?? position;
  const ratio = duration > 0 ? Math.min(1, shown / duration) : 0;
  const boxRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(WAVE_BARS);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setCount(Math.max(4, Math.min(WAVE_BARS, Math.floor((el.clientWidth + 2) / BAR_PITCH))));
    measure();
    window.addEventListener('resize', measure);
    if (typeof ResizeObserver === 'undefined') return () => window.removeEventListener('resize', measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  }, []);
  return (
    <div ref={boxRef} className={cn('relative min-w-0 flex-1 rounded-md has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring', className)}>
      <div aria-hidden className="flex h-full items-center justify-between">
        {Array.from({ length: count }, (_, i) => {
          const h = heights[Math.floor((i * WAVE_BARS) / count)];
          return <span key={i} className={cn('w-[2px] shrink-0 rounded-full', i / count < ratio ? 'bg-gold' : (onVoice ? 'bg-on-voice/30' : 'bg-foreground/20'))} style={{ height: `${h}%` }} />;
        })}
      </div>
      <input
        type="range"
        min={0}
        max={duration || 30}
        step={0.5}
        value={Math.min(shown, duration || 30)}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!pointerDownRef.current) {
            onSeek(v);
            return;
          }
          pendingRef.current = v;
          setPreview(v);
        }}
        onPointerDown={() => {
          pointerDownRef.current = true;
        }}
        onPointerUp={commit}
        onPointerCancel={commit}
        onTouchEnd={commit}
        onBlur={commit}
        aria-label="Progreso de la canción"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 outline-none"
      />
    </div>
  );
}
