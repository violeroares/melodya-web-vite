import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-line placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:ring-[4px] focus-visible:ring-[var(--m-focus-ring)] aria-invalid:border-destructive bg-[var(--m-input)] flex field-sizing-content min-h-24 w-full rounded-[20px_20px_6px_6px] border-[1.5px] px-4 py-3 text-base leading-[1.45] transition-[color,box-shadow,border-color] outline-none disabled:cursor-not-allowed disabled:border-dashed disabled:bg-faint disabled:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
