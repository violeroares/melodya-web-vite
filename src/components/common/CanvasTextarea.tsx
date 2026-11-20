
import React from 'react';
import { cn } from '@/lib/utils';

/** Lienzo de texto (design-V2, «Letra»): borde fino con esquinas 20/20/6/6, textarea sin marco (se agranda hacia abajo) y el aro de foco rodea todo el conjunto. */
export const CanvasTextarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(function CanvasTextarea({ className, ...props }, ref) {
  return (
    <div className="rounded-[20px_20px_6px_6px] border-[1.5px] border-line bg-[var(--m-input)] px-4 pt-4 pb-2 transition-shadow focus-within:border-foreground focus-within:ring-4 focus-within:ring-[var(--m-focus-ring)]">
      <textarea
        ref={ref}
        data-canvas-field
        className={cn('block h-[110px] min-h-[72px] w-full resize-y border-0 bg-transparent p-0 pr-2.5 pb-1 text-base leading-[1.45] text-foreground outline-none [scrollbar-width:thin] placeholder:text-muted-foreground', className)}
        {...props}
      />
    </div>
  );
});
