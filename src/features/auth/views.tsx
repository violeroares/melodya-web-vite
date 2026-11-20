
/**
 * MELODYA WEB — Vistas de autenticación: login, registro, recuperación y
 * restablecimiento. Contratos reales: POST /auth/{login,register,forgot-password,reset-password}.
 */
import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles, Loader2, Mail, Lock, User as UserIcon, ArrowLeft, KeyRound, Eye, EyeOff, CheckCircle2, AlertCircle } from 'lucide-react';
import { navigate, useRoute, Link } from '@/lib/router';
import { extractResetToken, RESET_PASSWORD_PATH } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';
import { authApi } from '@/lib/api';
import { toUserMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MelodyaLogo } from '@/components/common';

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: React.ReactNode; footer?: React.ReactNode }) {
  /* La tarjeta ocupa el espacio disponible del shell (main es flex) y se
     centra verticalmente SIN forzar altura mínima: en viewports altos el
     footer queda a la vista y la página no scrollea; en viewports bajos
     (p. ej. notebook 1366×768 con chrome del navegador ≈ 600 px) compactamos
     paddings/logo para que el CTA principal quede a la vista. */
  return (
    <div className="view-in mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-8 [@media(max-height:720px)]:py-5">
      <div className="mb-6 flex flex-col items-center text-center [@media(max-height:720px)]:mb-4 [@media(max-height:620px)]:mb-2">
        <MelodyaLogo vertical className="mb-6 [@media(max-height:720px)]:mb-4 [@media(max-height:620px)]:mb-2 [@media(max-height:620px)]:scale-75" />
        <h1 className="font-display text-[30px] font-bold leading-[1.05] tracking-[-0.03em] sm:text-[34px] [@media(max-height:620px)]:text-xl">{title}</h1>
        <p className="mt-2 text-[15.5px] text-muted-foreground [@media(max-height:620px)]:sr-only">{subtitle}</p>
      </div>
      <div className="rounded-[28px_28px_14px_14px] border border-border bg-surface p-6 sm:p-7 [@media(max-height:720px)]:p-5 [@media(max-height:620px)]:p-4">{children}</div>
      {footer && <div className="mt-6 text-center text-sm text-muted-foreground [@media(max-height:720px)]:mt-4">{footer}</div>}
    </div>
  );
}

function Field({ label, icon: Icon, error, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; icon: React.ElementType; error?: string }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id ?? props.name} className="text-sm font-bold">
        {label}
      </Label>
      <div className="relative">
        <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input {...props} className={`pl-11 ${error ? 'border-destructive' : ''}`} />
      </div>
      {error && <p className="flex items-start gap-1.5 text-[13px] text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{error}</p>}
    </div>
  );
}

/* v0.19 — campo de contraseña con ojo para mostrar/ocultar. El ícono usa ámbar
   de la marca (visible en claro y oscuro — antes heredaba negro y no se veía). */
function PasswordField({
  label,
  error,
  rightSlot,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; rightSlot?: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const id = props.id ?? props.name;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id} className="text-sm font-bold">
          {label}
        </Label>
        {rightSlot}
      </div>
      <div className="relative">
        <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          {...props}
          id={id}
          type={visible ? 'text' : 'password'}
          className={`pl-11 pr-12 ${error ? 'border-destructive' : ''}`}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? `Ocultar la contraseña de ${label.toLowerCase()}` : `Mostrar la contraseña de ${label.toLowerCase()}`}
          title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          className="absolute right-2 top-1/2 flex size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-foreground"
        >
          {visible ? <EyeOff className="h-4.5 w-4.5" aria-hidden /> : <Eye className="h-4.5 w-4.5" aria-hidden />}
        </button>
      </div>
      {error && <p className="flex items-start gap-1.5 text-[13px] text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{error}</p>}
    </div>
  );
}

const SubmitButton = ({ loading, children }: { loading: boolean; children: React.ReactNode }) => (
  <Button type="submit" disabled={loading} className="h-14 w-full text-base">
    {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="mr-2 h-4 w-4" aria-hidden />}
    {children}
  </Button>
);

export function LoginView() {
  const login = useAuthStore((s) => s.login);
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(form.email, form.password);
      navigate('/');
    } catch (err) {
      setError(toUserMessage(err, 'No pudimos iniciar sesión. Revisá tus datos.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Bienvenido de nuevo"
      subtitle="Seguí creando música donde lo dejaste"
      footer={
        <>
          ¿Todavía no tenés cuenta?{' '}
          <Link to="/register" className="font-semibold text-amber-strong underline-offset-4 hover:underline">
            Crear cuenta
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Email" icon={Mail} type="email" name="email" required autoComplete="email" placeholder="vos@email.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <PasswordField
          label="Contraseña"
          name="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          rightSlot={
            <Link to="/forgot-password" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Olvidé mi contraseña
            </Link>
          }
        />
        {error && <p className="flex items-start gap-2 rounded-[18px] border-[1.5px] border-destructive px-4 py-3 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{error}</p>}
        <SubmitButton loading={loading}>Ingresar</SubmitButton>
      </form>
    </AuthLayout>
  );
}

export function RegisterView() {
  const register = useAuthStore((s) => s.register);
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (form.password.length < 8 || !/[a-zA-Z]/.test(form.password) || !/[0-9]/.test(form.password)) {
      setError('La contraseña necesita al menos 8 caracteres, con letras y números.');
      return;
    }
    /* v0.19 — confirmación: las dos contraseñas tienen que coincidir. */
    if (form.password !== form.confirmPassword) {
      setError('Las contraseñas no coinciden. Revisalas y probá de nuevo.');
      return;
    }
    setLoading(true);
    try {
      await register(form.email, form.password, form.name);
      navigate('/');
    } catch (err) {
      setError(toUserMessage(err, 'No pudimos crear tu cuenta. Intentá de nuevo.'));
    } finally {
      setLoading(false);
    }
  };

  const passwordWeak =
    form.confirmPassword.length > 0 &&
    (form.password.length < 8 || !/[a-zA-Z]/.test(form.password) || !/[0-9]/.test(form.password));
  const passwordMismatch = form.confirmPassword.length > 0 && form.password !== form.confirmPassword;
  const passwordOk = form.confirmPassword.length > 0 && form.password === form.confirmPassword && !passwordWeak;

  return (
    <AuthLayout
      title="Creá tu cuenta"
      subtitle="Te regalamos 20 fichas para tu primera canción"
      footer={
        <>
          ¿Ya tenés cuenta?{' '}
          <Link to="/login" className="font-semibold text-amber-strong underline-offset-4 hover:underline">
            Ingresar
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Tu nombre" icon={UserIcon} name="name" required minLength={2} placeholder="Cómo te llaman" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Field label="Email" icon={Mail} type="email" name="email" required autoComplete="email" placeholder="vos@email.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <PasswordField
          label="Contraseña"
          name="password"
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="Mínimo 8 caracteres, letras y números"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        {/* v0.19 — confirmación de contraseña con check en vivo */}
        <PasswordField
          label="Confirmar contraseña"
          name="confirmPassword"
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="Repetí la contraseña"
          value={form.confirmPassword}
          onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
          error={passwordMismatch ? 'Las contraseñas no coinciden.' : undefined}
          aria-invalid={passwordMismatch || undefined}
        />
        {form.confirmPassword.length > 0 && (
          <p
            className={cn(
              'flex items-center gap-1.5 text-xs',
              passwordOk ? 'text-success' : 'text-muted-foreground'
            )}
            aria-live="polite"
          >
            {passwordOk ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : null}
            {passwordOk
              ? 'Las contraseñas coinciden.'
              : passwordWeak
                ? 'La contraseña necesita al menos 8 caracteres, con letras y números.'
                : 'Escribí la contraseña otra vez para confirmarla.'}
          </p>
        )}
        {error && <p className="flex items-start gap-2 rounded-[18px] border-[1.5px] border-destructive px-4 py-3 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{error}</p>}
        <SubmitButton loading={loading}>Crear cuenta y empezar</SubmitButton>
      </form>
    </AuthLayout>
  );
}

export function ForgotView() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ ok: boolean; resetToken?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authApi.forgot(email);
      setSent(res);
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Recuperar contraseña" subtitle="Te enviamos un enlace para restablecerla">
      <button onClick={() => navigate('/login')} className="mb-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Volver a ingresar
      </button>
      {sent ? (
        <div className="space-y-3 text-center">
          <p className="rounded-xl bg-success/10 px-4 py-3 text-sm text-success">
            {/* Mensaje único: nunca revela si el email está registrado ni si el envío funcionó. */}
            Si el email está registrado, te enviamos el enlace de recuperación. Revisá tu casilla (y el correo no deseado).
            El enlace vence en pocos minutos.
          </p>
          {sent.resetToken && (
            <div className="rounded-xl border border-amber/40 bg-amber/10 p-4 text-xs leading-relaxed text-amber-strong">
              <p className="mb-2 font-semibold">Entorno de desarrollo:</p>
              <p className="mb-2 opacity-80">El envío de emails no está configurado, así que te dejamos el enlace directo:</p>
              <Button size="sm" variant="outline" className="rounded-full" onClick={() => navigate(`/reset-password?token=${sent.resetToken}`)}>
                <KeyRound className="mr-2 h-3.5 w-3.5" aria-hidden /> Restablecer ahora
              </Button>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <Field label="Email" icon={Mail} type="email" name="email" required placeholder="vos@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <p className="flex items-start gap-2 rounded-[18px] border-[1.5px] border-destructive px-4 py-3 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{error}</p>}
          <SubmitButton loading={loading}>Enviar enlace</SubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetView() {
  const { query, hash } = useRoute();
  const qc = useQueryClient();
  /* Formato recomendado del enlace: /reset-password#token=… — el fragmento no viaja al servidor ni en el Referer y
   * es el que reciben tal cual Android App Links / iOS Universal Links. También se acepta `?token=` en la query.
   * Reacciona a cambios de fragmento: pegar el enlace con la pantalla ya abierta no recarga la página. */
  const fromUrl = extractResetToken(query, hash);
  const [token, setToken] = useState(fromUrl);
  if (fromUrl && fromUrl !== token) setToken(fromUrl);
  /* Limpia el token de la URL apenas se lee (no queda en la barra, el historial ni el portapapeles de «copiar enlace»).
   * Se conserva history.state: es la clave interna de React Router para Atrás/Adelante. */
  useEffect(() => {
    if (!token) return;
    window.history.replaceState(window.history.state, '', RESET_PASSWORD_PATH);
  }, [token, hash]);
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    /* v0.19 — mismas reglas que el registro, validadas en cliente. */
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      setError('La contraseña necesita al menos 8 caracteres, con letras y números.');
      return;
    }
    setLoading(true);
    try {
      await authApi.reset({ token, password });
      setDone(true);
      void qc.invalidateQueries();
    } catch (err) {
      setError(toUserMessage(err, 'El enlace es inválido o expiró. Pedí uno nuevo.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Nueva contraseña" subtitle="Elegí una contraseña con al menos 8 caracteres, letras y números">
      {done ? (
        <div className="space-y-3 text-center">
          <p className="rounded-xl bg-success/10 px-4 py-3 text-sm text-success">
            ¡Listo! Tu contraseña quedó actualizada.
          </p>
          <Button className=" rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" onClick={() => navigate('/login')}>
            Ingresar
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          {!token && <p className="rounded-xl bg-amber/10 px-4 py-3 text-xs text-amber-strong">Falta el token. Abrí el enlace desde tu email.</p>}
          <PasswordField
            label="Nueva contraseña"
            name="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Mínimo 8 caracteres, letras y números"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="flex items-start gap-2 rounded-[18px] border-[1.5px] border-destructive px-4 py-3 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{error}</p>}
          <SubmitButton loading={loading}>Guardar contraseña</SubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}
