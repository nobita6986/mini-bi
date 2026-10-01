import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border border-border bg-surface p-5 shadow-sm", className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-3">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
    </header>
  );
}
