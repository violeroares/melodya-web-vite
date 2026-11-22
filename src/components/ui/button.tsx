import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-[15px] font-bold tracking-[0.04em] transition-[color,background-color,border-color,box-shadow,transform] active:scale-[0.98] disabled:pointer-events-none disabled:border-transparent disabled:bg-faint disabled:bg-none disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none border-[1.5px] border-transparent focus-visible:border-foreground focus-visible:ring-[4px] focus-visible:ring-[var(--m-focus-ring)] aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-background hover:bg-destructive/90",
        outline:
          "border-line bg-transparent text-foreground hover:bg-accent",
        secondary:
          "border-foreground bg-transparent text-foreground hover:bg-accent",
        ghost:
          "hover:bg-accent hover:text-accent-foreground",
        link: "text-label underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-6 py-2 has-[>svg]:px-5",
        sm: "h-10 gap-1.5 px-4 has-[>svg]:px-3.5",
        lg: "h-12 px-7 has-[>svg]:px-5",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
