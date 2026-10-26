import { useEffect } from "react";
import { notify } from "../lib/notify";

export function useToastMessage(
  tone: "success" | "error" | "info",
  value: string,
  clear: (next: string) => void,
) {
  useEffect(() => {
    if (!value) return;
    if (tone === "success") notify.success(value);
    else if (tone === "error") notify.error(value);
    else notify.info(value);
    clear("");
  }, [tone, value, clear]);
}
