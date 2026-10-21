import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "../lib/utils";

const tones = {
  info: "border-primary/40 bg-primary/10 text-primary",
  success: "border-primary/40 bg-primary/10 text-primary",
  error: "border-destructive/50 bg-destructive/10 text-destructive-foreground",
};

export function Notice({
  tone = "info",
  children,
  onDismiss,
}: {
  tone?: keyof typeof tones;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const Icon = tone === "error" ? AlertCircle : tone === "success" ? CheckCircle2 : Info;
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm",
        tones[tone],
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 break-words">{children}</div>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="opacity-60 transition-opacity hover:opacity-100"
          aria-label="dismiss"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
