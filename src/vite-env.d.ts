/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL del backend (con /api). Obligatoria. */
  readonly VITE_API_BASE_URL?: string;
  /** Origen público canónico para enlaces compartibles (https://app.melodya.com.ar). */
  readonly VITE_PUBLIC_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
