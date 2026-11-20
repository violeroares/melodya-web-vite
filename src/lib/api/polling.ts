/**
 * MELODYA WEB (Vite) — Poller HTTP resiliente (reemplaza a los `setInterval` que consultan al backend).
 *
 * Diferencias con un `setInterval`:
 *  • Un solo ciclo en vuelo: la siguiente espera se agenda DESPUÉS de terminar la anterior (nunca se apilan).
 *  • Errores: backoff exponencial con jitter, nunca menos que `Retry-After` ni que la compuerta global de 429.
 *  • NO se detiene por un error transitorio (429 / red / 5xx): sigue intentando más despacio y se recupera solo.
 *    Se detiene ante un error PERMANENTE (403, 404…) o cuando `run` devuelve 'stop' (estado terminal).
 *  • Pestaña oculta: pausa total (sin temporizador); al volver a ser visible consulta de inmediato.
 *  • Con la compuerta de 429 activa, no consulta hasta que termine el bloqueo.
 */
import { classifyError, isPermanent, pollErrorDelayMs, rateLimitRemainingMs } from './resilience.ts';

export interface PollerEnv {
  isHidden: () => boolean;
  onVisible: (cb: () => void) => () => void;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  rand: () => number;
}

const browserEnv: PollerEnv = {
  isHidden: () => typeof document !== 'undefined' && document.hidden,
  onVisible: (cb) => {
    if (typeof document === 'undefined') return () => {};
    const handler = () => {
      if (!document.hidden) cb();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  rand: Math.random,
};

export interface PollerOptions {
  /** Periodo normal entre consultas (puede variar: p. ej. 5 s con trabajo activo, 60 s en reposo). */
  baseMs: number | (() => number);
  /** Una consulta. Devolver 'stop' cuando se alcanzó un estado terminal. Lanzar para señalar un error. */
  run: () => Promise<'stop' | void>;
  /** Tope del backoff por errores (por defecto 5 min). */
  maxBackoffMs?: number;
  /** Se llama en cada error. Devolver 'stop' para detener el ciclo (si no, el ciclo decide según el tipo de error). */
  onError?: (err: unknown, consecutiveFailures: number) => 'stop' | void;
  /** Se llama tras un éxito que sigue a errores (para limpiar mensajes). */
  onRecovered?: () => void;
  /** Consultar enseguida al iniciar (por defecto true). */
  immediate?: boolean;
  env?: PollerEnv;
}

export interface Poller {
  stop: () => void;
  /** Consulta ahora (si no hay una en curso). */
  poke: () => void;
  readonly failures: number;
}

export function startPoller(opts: PollerOptions): Poller {
  const env = opts.env ?? browserEnv;
  const maxBackoff = opts.maxBackoffMs ?? 5 * 60_000;
  const base = () => (typeof opts.baseMs === 'function' ? opts.baseMs() : opts.baseMs);
  let stopped = false;
  let inFlight = false;
  let timer: unknown = null;
  let failures = 0;

  const clear = () => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    clear();
    if (stopped) return;
    timer = env.setTimer(() => {
      timer = null;
      void tick();
    }, ms);
  };

  async function tick() {
    if (stopped || inFlight) return;
    if (env.isHidden()) return; // pausa total: el listener de visibilidad reanuda
    const blocked = rateLimitRemainingMs();
    if (blocked > 0) {
      schedule(blocked + Math.round(env.rand() * 1000));
      return;
    }
    inFlight = true;
    try {
      const result = await opts.run();
      if (stopped) return;
      if (failures > 0) {
        failures = 0;
        opts.onRecovered?.();
      }
      if (result === 'stop') {
        stop();
        return;
      }
      schedule(base());
    } catch (err) {
      if (stopped) return;
      failures += 1;
      if (opts.onError?.(err, failures) === 'stop' || isPermanent(classifyError(err))) {
        stop();
        return;
      }
      schedule(pollErrorDelayMs(base(), failures, err, maxBackoff, env.rand));
    } finally {
      inFlight = false;
    }
  }

  function stop() {
    stopped = true;
    clear();
    offVisible();
  }

  const offVisible = env.onVisible(() => {
    // Al volver a la pestaña: consulta inmediata (si no hay una en curso ni bloqueo).
    if (!stopped && !inFlight) {
      clear();
      void tick();
    }
  });

  if (opts.immediate === false) schedule(base());
  else void tick();

  return {
    stop,
    poke: () => {
      if (!stopped && !inFlight) {
        clear();
        void tick();
      }
    },
    get failures() {
      return failures;
    },
  };
}
