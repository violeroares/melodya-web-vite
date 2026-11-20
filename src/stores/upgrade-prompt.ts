
/**
 * MELODYA WEB — Aviso de upgrade (estado global mínimo): cualquier pantalla pide mostrar el aviso de una capacidad no incluida y UN solo diálogo
 * (components/common/PlanGate.tsx → UpgradeDialog, montado en AppShell) lo muestra. Así no hay un modal distinto por pantalla.
 */
import { create } from 'zustand';

interface UpgradePromptState {
  /** Clave de la capacidad no incluida que el usuario intentó usar (null = cerrado). */
  capability: string | null;
  show: (capability: string) => void;
  close: () => void;
}

export const useUpgradePrompt = create<UpgradePromptState>((set) => ({
  capability: null,
  show: (capability) => set({ capability }),
  close: () => set({ capability: null }),
}));
