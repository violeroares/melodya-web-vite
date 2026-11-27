/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL del backend (con /api). Obligatoria. */
  readonly VITE_API_BASE_URL?: string;
  /** Origen público canónico para enlaces compartibles (https://app.melodya.com.ar). */
  readonly VITE_PUBLIC_ORIGIN?: string;
  /** Origen de Melodya Store (https, o http en localhost). Los botones de compra abren Store con la sesión actual. */
  readonly VITE_STORE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
