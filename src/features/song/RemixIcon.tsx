import { createLucideIcon } from 'lucide-react';

/**
 * Ícono de Remix: dos flechas circulares (las de «refresh-cw» de Lucide) con una chispa de cuatro puntas en el centro.
 * Es un ícono Lucide más (acepta `className`, `size`, `strokeWidth`, `aria-hidden`…), así que hereda el color y el tamaño del contexto:
 * en los menús queda dentro del círculo de las filas y en los contadores se ve como los demás.
 * Se usa en el menú Remix, en el contador de remixes y en la atribución, para que sea siempre el mismo.
 */
export const RemixIcon = createLucideIcon('remix', [
  ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', key: 'remix-a1' }],
  ['path', { d: 'M21 3v5h-5', key: 'remix-a2' }],
  ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', key: 'remix-a3' }],
  ['path', { d: 'M8 16H3v5', key: 'remix-a4' }],
  // Chispa (la de «sparkle» de Lucide) reducida al centro del círculo.
  [
    'path',
    {
      d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z',
      transform: 'translate(12 12) scale(0.34) translate(-12 -12)',
      fill: 'currentColor',
      strokeWidth: '3',
      key: 'remix-spark',
    },
  ],
]);
