/**
 * MELODYA WEB — Imágenes autenticadas.
 *
 * Los archivos privados (portadas de canciones PRIVATE, avatares) exigen
 * `Authorization: Bearer` y un <img> no puede mandar headers. Por eso:
 *  • Imagen PÚBLICA o desconocida → carga directa (cacheable por el navegador: `private, max-age=3600`).
 *  • Si falla (401/403/404) → fetch autenticado → object URL (cacheado en memoria por URL).
 *
 * Para no malgastar cupo del backend (cada /files/* cuenta en su límite de solicitudes), el intento directo que SABEMOS que devolverá
 * 401/403 se omite:
 *  • el llamador puede indicar `requireAuth` (p. ej. la portada de una canción PRIVATE de la biblioteca);
 *  • y se APRENDE: toda URL que necesitó el fallback autenticado se recuerda (sessionStorage) y en cargas siguientes va directo al fetch
 *    autenticado. Los permisos no cambian: sigue siendo el backend quien autoriza cada archivo con el token del usuario.
 *
 * Rate limit: un 429 de archivos registra una pausa del alcance 'files' (independiente de la API general y del refresh). Durante la pausa no se
 * piden más descargas autenticadas ni se marca la imagen como «denegada»: simplemente no se reintenta de forma agresiva y se vuelve a pedir
 * cuando se monta de nuevo (o termina la pausa).
 */
import { useCallback, useEffect, useState } from 'react';
import { getAccessTokenSync } from '@/stores/auth';
import { apiFileUrl } from '@/lib/api/client';
import { noteRateLimit, rateLimitRemainingMs, retryAfterFromHeaders } from '@/lib/api/resilience';

const objectUrlCache = new Map<string, string>();
/** MIME real (Content-Type de la respuesta) de cada object URL ya creado. Solo lectura para quien lo necesite (p. ej. MediaSession). */
const objectUrlTypes = new Map<string, string>();
/** Descargas autenticadas en vuelo: varias tarjetas con la misma imagen comparten UNA solicitud. */
const inflight = new Map<string, Promise<string | null>>();
/** URLs que el backend ya rechazó (401/403/404) para el estado de sesión actual: no se vuelven a pedir en cada render
 *  o montaje (varias tarjetas del mismo autor, remontajes del listado). La clave incluye si había sesión, así que al
 *  iniciar/cerrar sesión se reintenta. */
const deniedCache = new Set<string>();
const deniedKey = (key: string, token: string | null) => `${token ? 'auth' : 'anon'}|${key}`;

/** URLs que se sabe que exigen sesión (aprendido; persiste por pestaña para sobrevivir a recargas). */
const PRIVATE_KEYS_STORAGE = 'melodya.img.private';
const MAX_PRIVATE_KEYS = 500;
let privateKeys: Set<string> | null = null;

function loadPrivateKeys(): Set<string> {
  if (privateKeys) return privateKeys;
  privateKeys = new Set();
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(PRIVATE_KEYS_STORAGE) : null;
    if (raw) for (const k of JSON.parse(raw) as string[]) privateKeys.add(k);
  } catch {
    /* storage no disponible: solo memoria */
  }
  return privateKeys;
}

function markPrivate(key: string) {
  const set = loadPrivateKeys();
  if (set.has(key)) return;
  if (set.size >= MAX_PRIVATE_KEYS) set.delete(set.values().next().value as string);
  set.add(key);
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(PRIVATE_KEYS_STORAGE, JSON.stringify([...set]));
  } catch {
    /* sin persistencia */
  }
}

/** ¿Hay que saltarse el intento directo? Solo con sesión y si la URL es conocida como privada o el llamador lo pide. */
export function shouldSkipDirectLoad(key: string, token: string | null, requireAuth?: boolean): boolean {
  if (!key || !token) return false;
  return Boolean(requireAuth) || loadPrivateKeys().has(key);
}

/** Época de caché: sube cada vez que se limpia (logout / cambio de cuenta). Una descarga que EMPEZÓ en una época anterior y termina después
 *  descarta su resultado (no crea el object URL ni lo guarda): nada de la sesión anterior vuelve a entrar en la caché. */
let cacheEpoch = 0;

/** Limpia los object URLs cacheados (logout / cambio de usuario): revoca los
 *  blobs para que no queden accesibles imágenes privadas de la cuenta anterior.
 *  También invalida las descargas que todavía están en curso (ver `cacheEpoch`). */
export function clearAuthImageCache() {
  cacheEpoch += 1;
  for (const obj of objectUrlCache.values()) {
    try {
      URL.revokeObjectURL(obj);
    } catch {
      /* ya revocado: no importa */
    }
  }
  objectUrlCache.clear();
  objectUrlTypes.clear();
  inflight.clear();
  deniedCache.clear();
  privateKeys = new Set();
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(PRIVATE_KEYS_STORAGE);
  } catch {
    /* noop */
  }
}

/** Descarga una imagen (con Bearer si hay sesión) y devuelve un object URL
 *  cacheado. La usan los <img> con reintento y el artwork del MediaSession
 *  del reproductor (las portadas PRIVATE no cargan sin header). La URL se
 *  resuelve contra el origin del API antes del fetch. */
export async function authImageObjectUrl(url: string): Promise<string | null> {
  const key = apiFileUrl(url) ?? url;
  const hit = objectUrlCache.get(key);
  if (hit) return hit;
  /* getAccessTokenSync: la primera carga (artwork del player al restaurar)
     puede correr antes del bootstrap async del auth → lee el storage también. */
  const token = getAccessTokenSync();
  if (deniedCache.has(deniedKey(key, token))) return null;
  const pending = inflight.get(key);
  if (pending) return pending;
  // El limitador de archivos pidió esperar: no se le insiste (la imagen queda sin cargar; se reintenta al volver a montarla).
  if (rateLimitRemainingMs('files') > 0) return null;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const epoch = cacheEpoch;
  const task = (async () => {
    try {
      const res = await fetch(key, { headers });
      if (epoch !== cacheEpoch) return null; // cambió la cuenta mientras bajaba: nada de esta descarga se guarda
      if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 404) deniedCache.add(deniedKey(key, token));
        // 429: pausa del alcance de archivos (no frena la API general ni el refresh). No se marca como «denegada»: es transitorio.
        if (res.status === 429) noteRateLimit(retryAfterFromHeaders(res.headers), 'files');
        return null;
      }
      const blob = await res.blob();
      if (epoch !== cacheEpoch) return null; // ídem: el blob es de la sesión anterior y no se materializa
      if (blob.size === 0) return null;
      const obj = URL.createObjectURL(blob);
      objectUrlCache.set(key, obj);
      if (blob.type.startsWith('image/')) objectUrlTypes.set(obj, blob.type);
      if (token) markPrivate(key);
      return obj;
    } catch {
      return null;
    } finally {
      if (epoch === cacheEpoch) inflight.delete(key); // tras una limpieza, `inflight` ya es de la época nueva
    }
  })();
  inflight.set(key, task);
  return task;
}

/** MIME real de un object URL creado por `authImageObjectUrl`, o `undefined` si no se conoce
 *  (URL directa, blob sin Content-Type de imagen o caché ya limpiada). No hace ninguna petición. */
export function authImageMimeType(objectUrl: string | null | undefined): string | undefined {
  return objectUrl ? objectUrlTypes.get(objectUrl) : undefined;
}

export interface AuthImage {
  /** Fuente final: object URL autenticado, o la URL directa si aún no falló. */
  src: string | null;
  /** true cuando ni la carga directa ni la autenticada funcionaron. */
  failed: boolean;
  /** Pasar al onError del <img>. */
  onError: () => void;
}

/** <img> con reintento autenticado (para archivos privados del usuario).
 *  La URL entrante se resuelve contra el origin del API: con el backend en
 *  otro puerto, la relativa pegaría contra el origen de la web (404).
 *  `requireAuth`: la imagen se sabe privada → se omite el intento directo (que devolvería 401/403). */
export function useAuthImage(url: string | null | undefined, opts?: { requireAuth?: boolean }): AuthImage {
  const key = apiFileUrl(url) ?? '';
  const [objUrl, setObjUrl] = useState<string | null>(() => (key ? objectUrlCache.get(key) ?? null : null));
  const [failed, setFailed] = useState(() => (key ? deniedCache.has(deniedKey(key, getAccessTokenSync())) : false));
  const [prevKey, setPrevKey] = useState(key);

  // Reset derivado al cambiar la URL (patrón setState-durante-render de React).
  if (prevKey !== key) {
    setPrevKey(key);
    setObjUrl(key ? objectUrlCache.get(key) ?? null : null);
    setFailed(key ? deniedCache.has(deniedKey(key, getAccessTokenSync())) : false);
  }

  const skipDirect = shouldSkipDirectLoad(key, getAccessTokenSync(), opts?.requireAuth) && !objUrl && !failed;

  // Imagen conocida como privada: se baja directamente con Bearer (1 solicitud) en vez de 401 + fetch (2 solicitudes).
  useEffect(() => {
    if (!skipDirect) return;
    let alive = true;
    void authImageObjectUrl(key).then((obj) => {
      if (!alive) return;
      if (obj) setObjUrl(obj);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [skipDirect, key]);

  const onError = useCallback(() => {
    if (!key || failed) return;
    void authImageObjectUrl(key).then((obj) => {
      if (obj) setObjUrl(obj);
      else setFailed(true);
    });
  }, [key, failed]);

  return { src: failed ? null : (objUrl ?? (skipDirect ? null : key || null)), failed, onError };
}
