import { createLucideIcon } from 'lucide-react';

/** La monedita de las fichas (icono `coin` del diseño V2): dos círculos concéntricos, mismo trazo que el resto de los íconos. */
export const CoinIcon = createLucideIcon('coin', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'outer' }],
  ['circle', { cx: '12', cy: '12', r: '5', key: 'inner' }],
]);
