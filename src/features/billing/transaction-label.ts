/**
 * Texto de cara al usuario de un movimiento de fichas (historial de Planes y fichas).
 *
 * Función pura: se calcula en el render, sin estado. Fuente de verdad, en este orden:
 *  1. `type` del movimiento;
 *  2. `metadata` estructurada (`breakdown.components` del débito de una generación; `component`/`lazyRenewal` de otros);
 *  3. `reason`, SOLO como respaldo donde no hay metadata: portadas y débitos históricos, motivos de reintegro,
 *     y nombre de plan o paquete.
 *
 * Nunca se interpola el `reason` de una generación (trae el nombre del modelo y códigos internos), ni se infiere de él
 * voz, melodía o ritmo. Ante cualquier duda se devuelve un texto genérico y veraz. El único `reason` que se muestra
 * tal cual es el del ajuste administrativo, que es texto libre pensado para el usuario.
 */

/** Forma mínima que lee el helper (compatible con `CreditTransaction`). */
export interface TransactionLike {
  type: string;
  reason?: string | null;
  metadata?: unknown;
}

export interface TransactionLabel {
  title: string;
  /** Aclaración opcional bajo el título; `null` si no hay nada veraz que agregar. */
  detail: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Componentes del desglose, o `null` si falta o está mal formado (se trata como ausente, nunca se adivina). */
function readComponents(metadata: unknown): Array<{ type: string; generationType: string | null }> | null {
  if (!isRecord(metadata) || !isRecord(metadata.breakdown)) return null;
  const raw = metadata.breakdown.components;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<{ type: string; generationType: string | null }> = [];
  for (const c of raw) {
    if (!isRecord(c) || typeof c.type !== 'string') return null;
    out.push({ type: c.type, generationType: typeof c.generationType === 'string' ? c.generationType : null });
  }
  return out;
}

/** Modalidades que el desglose confirma (su `generationType`); cualquier otra se comunica como «Creación de canción». */
const SPECIFIC_TITLE: Record<string, string> = {
  BEATBOX_RHYTHM: 'Canción con ritmo de referencia',
  MELODY_REF: 'Canción con melodía de referencia',
  VOICE_COVER: 'Canción con tu voz',
};

function describeGenerationDebit(tx: TransactionLike): TransactionLabel {
  const components = readComponents(tx.metadata);
  // Letras pedidas al asistente: movimiento independiente que el backend marca con `metadata.source === 'assistant'`
  // (assistant-operation.service). Una generación musical nunca lleva esa marca, y su componente LYRICS va junto a MUSIC.
  if (isRecord(tx.metadata) && tx.metadata.source === 'assistant' && !components?.some((c) => c.type === 'MUSIC')) {
    return { title: 'Creación de letra con el asistente', detail: 'Generación de letras para tu canción' };
  }
  if (components) {
    const music = components.filter((c) => c.type === 'MUSIC');
    const lyrics = components.filter((c) => c.type === 'LYRICS');
    // Un desglose válido tiene a lo sumo un componente de cada clase.
    if (music.length <= 1 && lyrics.length <= 1 && music.length + lyrics.length > 0) {
      const withLyrics = lyrics.length === 1;
      if (music.length === 0) return { title: 'Creación de letra', detail: null };
      // Solo el ritmo de referencia y la voz propia están confirmados por el desglose; el resto se comunica como canción.
      const kind = music[0].generationType;
      const specific = kind && Object.prototype.hasOwnProperty.call(SPECIFIC_TITLE, kind) ? SPECIFIC_TITLE[kind] : undefined;
      if (specific) return { title: specific, detail: withLyrics ? 'Incluye la creación de la letra' : null };
      return { title: withLyrics ? 'Creación de canción y letra' : 'Creación de canción', detail: null };
    }
  }
  // Sin desglose utilizable (portadas, filas históricas): el respaldo es el comienzo del motivo, nada más.
  const reason = clean(tx.reason);
  if (/^generación de portada\b/i.test(reason)) return { title: 'Creación de portada', detail: null };
  if (/^generación \(/i.test(reason)) return { title: 'Creación de canción', detail: null };
  return { title: 'Uso de fichas', detail: null };
}

function describeRefund(tx: TransactionLike): TransactionLabel {
  const title = 'Devolución de fichas';
  if (isRecord(tx.metadata) && tx.metadata.component === 'LYRICS') return { title, detail: 'La letra no se generó' };
  switch (clean(tx.reason).toLowerCase()) {
    case 'generación fallida':
      return { title, detail: 'La generación no se completó' };
    case 'generación cancelada por el usuario':
      return { title, detail: 'Cancelaste la generación' };
    case 'reintegro por letras no generadas':
      return { title, detail: 'La letra no se generó' };
    default:
      return { title, detail: null };
  }
}

function describePlanGrant(tx: TransactionLike): TransactionLabel {
  const title = 'Fichas de tu plan';
  const reason = clean(tx.reason);
  const m = /^Plan (.+?) \((período inicial|renovación[^)]*)\)$/i.exec(reason);
  const name = m ? m[1].trim() : '';
  const renewal = (isRecord(tx.metadata) && tx.metadata.lazyRenewal === true) || (m !== null && /^renovación/i.test(m[2]));
  const parts = [name ? `Plan ${name}` : '', renewal ? 'Renovación' : ''].filter(Boolean);
  return { title, detail: parts.length ? parts.join(' · ') : null };
}

function describePackage(tx: TransactionLike): TransactionLabel {
  const reason = clean(tx.reason);
  return { title: 'Compra de fichas', detail: /^Paquete .{1,80}$/i.test(reason) ? reason : null };
}

export function describeTransaction(tx: TransactionLike): TransactionLabel {
  switch (tx.type) {
    case 'GENERATION_DEBIT':
      return describeGenerationDebit(tx);
    case 'GENERATION_REFUND':
      return describeRefund(tx);
    case 'PLAN_GRANT':
      return describePlanGrant(tx);
    case 'PACKAGE_PURCHASE':
      return describePackage(tx);
    case 'WELCOME_GRANT':
      return { title: 'Regalo de bienvenida', detail: null };
    case 'ADMIN_ADJUSTMENT':
      return { title: 'Ajuste de Melodya', detail: clean(tx.reason) || null };
    default:
      return { title: 'Movimiento de fichas', detail: null };
  }
}
