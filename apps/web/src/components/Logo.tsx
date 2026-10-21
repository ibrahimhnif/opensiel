import { cn } from "../lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={cn("size-6", className)}>
      <path
        d="M16 3 27.3 9.5v13L16 29 4.7 22.5v-13L16 3Z"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="13.8" r="3.1" stroke="currentColor" strokeWidth="2.4" />
      <path d="M16 16.9v5.2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-lg font-semibold tracking-tight",
        className,
      )}
    >
      <LogoMark className={cn("text-primary", markClassName)} />
      opensiel
    </span>
  );
}
