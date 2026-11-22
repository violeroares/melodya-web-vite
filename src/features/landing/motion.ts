/** GSAP se carga bajo demanda: sólo quien ve la landing pública lo descarga (no el resto de la app). */
export async function loadGsap() {
  const [{ gsap }, { ScrollTrigger }] = await Promise.all([import('gsap'), import('gsap/ScrollTrigger')]);
  gsap.registerPlugin(ScrollTrigger);
  return { gsap, ScrollTrigger };
}

export type Revertible = { revert: () => void };
