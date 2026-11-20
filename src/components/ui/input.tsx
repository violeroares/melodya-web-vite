import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-line bg-[var(--m-input)] flex h-14 w-full min-w-0 rounded-full border-[1.5px] px-5 py-1 text-base font-semibold transition-[color,box-shadow,border-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-dashed disabled:bg-faint disabled:text-muted-foreground",
        "focus-visible:border-foreground focus-visible:ring-[4px] focus-visible:ring-[var(--m-focus-ring)]",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
