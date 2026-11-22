"use client"

import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  )
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  )
}

/* Variante «list»: el menú de los tres puntos con el estilo de la lista de Perfil (design-V2): tarjeta de esquinas 28/28/14/14 con
   borde de 1,5 px y filas altas, separadas por una línea fina, con el ícono en un círculo de borde fino.
   UNA sola medida para todos los menús y todos los anchos (sin versión «mobile» más chica): ancho mínimo 224 px, filas de 48 px,
   letra de 14 px en semibold, círculo de 24 px con el ícono de 14 px y el mismo color para todos los íconos. */
/* Las clases van completas (Tailwind no detecta nombres armados con plantillas). */
const LIST_VARIANT = [
  'min-w-56 max-w-[calc(100vw-2rem)] rounded-[28px_28px_14px_14px] border-[1.5px] border-border bg-[var(--m-input)] p-0 py-1 shadow-xl',
  '[&_[data-slot=dropdown-menu-item]]:h-12 [&_[data-slot=dropdown-menu-item]]:gap-3 [&_[data-slot=dropdown-menu-item]]:rounded-none [&_[data-slot=dropdown-menu-item]]:border-b [&_[data-slot=dropdown-menu-item]]:border-border/60 [&_[data-slot=dropdown-menu-item]]:px-4 [&_[data-slot=dropdown-menu-item]]:text-[14px] [&_[data-slot=dropdown-menu-item]]:font-semibold',
  '[&_[data-slot=dropdown-menu-item]:last-child]:border-b-0 [&_[data-slot=dropdown-menu-separator]]:hidden',
  // sin el aro de foco global: el resaltado al pasar el mouse/teclado es solo el fondo de la fila
  '[&_[data-slot=dropdown-menu-item]]:outline-none! [&_[data-slot=dropdown-menu-item]]:focus-visible:outline-none!',
  '[&_[data-slot=dropdown-menu-item]>svg]:box-content [&_[data-slot=dropdown-menu-item]>svg]:size-[14px]! [&_[data-slot=dropdown-menu-item]>svg]:rounded-full [&_[data-slot=dropdown-menu-item]>svg]:border-[1.5px] [&_[data-slot=dropdown-menu-item]>svg]:border-line [&_[data-slot=dropdown-menu-item]>svg]:p-[5px] [&_[data-slot=dropdown-menu-item]>svg]:text-foreground!',
  // Entrada con submenú (p. ej. «Remix»): MISMA fila que un ítem — alto, separador, texto y el ícono propio (el primer svg) en su círculo.
  // La flecha del submenú (último svg) queda sin círculo.
  `[&_[data-slot=dropdown-menu-sub-trigger]]:h-12 [&_[data-slot=dropdown-menu-sub-trigger]]:gap-3 [&_[data-slot=dropdown-menu-sub-trigger]]:rounded-none [&_[data-slot=dropdown-menu-sub-trigger]]:border-b [&_[data-slot=dropdown-menu-sub-trigger]]:border-border/60 [&_[data-slot=dropdown-menu-sub-trigger]]:px-4 [&_[data-slot=dropdown-menu-sub-trigger]]:text-[14px] [&_[data-slot=dropdown-menu-sub-trigger]]:font-semibold`,
  `[&_[data-slot=dropdown-menu-sub-trigger]:last-child]:border-b-0 [&_[data-slot=dropdown-menu-sub-trigger]]:outline-none! [&_[data-slot=dropdown-menu-sub-trigger]]:focus-visible:outline-none!`,
  `[&_[data-slot=dropdown-menu-sub-trigger]>svg:first-child]:box-content [&_[data-slot=dropdown-menu-sub-trigger]>svg:first-child]:size-[14px]! [&_[data-slot=dropdown-menu-sub-trigger]>svg:first-child]:rounded-full [&_[data-slot=dropdown-menu-sub-trigger]>svg:first-child]:border-[1.5px] [&_[data-slot=dropdown-menu-sub-trigger]>svg:first-child]:border-line [&_[data-slot=dropdown-menu-sub-trigger]>svg:first-child]:p-[5px] [&_[data-slot=dropdown-menu-sub-trigger]>svg:first-child]:text-foreground!`,
].join(' ')

function DropdownMenuContent({
  className,
  sideOffset = 4,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & { variant?: "default" | "list" }) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1",
          variant === "list" && LIST_VARIANT,
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1.5 text-sm font-medium data-[inset]:pl-8",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "text-muted-foreground ml-auto text-xs tracking-widest",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent> & {
  /** «list»: el mismo estilo que el menú de tres puntos (filas altas con el ícono en círculo). */
  variant?: "default" | "list"
}) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-md border p-1",
        variant === "list" && LIST_VARIANT,
        className
      )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
