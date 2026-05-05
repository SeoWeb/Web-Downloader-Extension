import { toast } from "sonner";

const VARIANT_DURATIONS = {
  success: 3000,
  error: 6000,
  info: 4000,
  warning: 5000,
} as const;

export type ToastVariant = keyof typeof VARIANT_DURATIONS;

function emit(variant: ToastVariant, message: string, opts?: Record<string, unknown>) {
  toast[variant](message, { duration: VARIANT_DURATIONS[variant], ...opts });
}

export const t = {
  success: (message: string, opts?: Record<string, unknown>) => emit("success", message, opts),
  error: (message: string, opts?: Record<string, unknown>) => emit("error", message, opts),
  info: (message: string, opts?: Record<string, unknown>) => emit("info", message, opts),
  warning: (message: string, opts?: Record<string, unknown>) => emit("warning", message, opts),
  promise: toast.promise,
  dismiss: toast.dismiss,
  custom: toast.custom,
};
