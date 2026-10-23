import { useTranslation } from "react-i18next";
import { CheckCircle, Circle, Loader2 } from "lucide-react";
import cn from "classnames";

export type Message = string | { key: string; options?: any };

export default function Actions({ messages }: { messages: Message[] }) {
  const { t } = useTranslation();

  // Define steps based on mode
  // logic: if we see 'status.scraping', we are in step 2.
  // if we see 'status.creating', we are in step 3.
  // if we see 'status.complete', we are in step 4.

  const steps = [
    {
      id: "connect",
      label: t("status.connected", "Connected"),
      keyMatch: ["status.connected", "status.waiting"],
    },
    {
      id: "scrape",
      label: t("status.scraping", "Scraping Content"),
      keyMatch: ["status.scraping", "status.scraped"],
    },
    {
      id: "upload",
      label: t("status.uploadingResources", "Uploading Resources"),
      keyMatch: [
        "status.uploadProgress",
        "status.waitingForUploads",
        "status.sendingScrapeComplete",
        "status.scrapeComplete",
      ],
    },
    {
      id: "assemble",
      label: t("status.assemblingServer", "Assembling on Server"),
      keyMatch: [
        "status.assemblingServer",
        "status.assemblyProgress",
        "status.finalizingServer",
      ],
    },
    {
      id: "complete",
      label: t("status.complete", "Complete"),
      keyMatch: ["status.complete"],
    },
  ];

  // Determine current active step index
  // This logic is a bit heuristic based on the sequential nature of messages
  const hasMessage = (key: string) =>
    messages.some((m) => (typeof m === "string" ? m : m.key) === key);

  // "Done!" only for the actually-finished state — assembling maps to the
  // same step index (steps.length - 1) but must show the assembly headline.
  const isComplete = hasMessage("status.complete");

  // Subtitle = last message. Defensive against raw i18n keys: when a key
  // has no translation, i18next echoes the key itself ("status.foo.bar") —
  // never render that; skip the subtitle instead. Assembly progress carries
  // a raw server phase id ("merging_html"): translate it through the
  // status.assemblyPhase* keys before interpolation (the background has no
  // reliable translator at emission time, so the UI does it here and in
  // DownloadStatus).
  let subtitle: string | null = null;
  const lastMessage =
    messages.length > 0 ? messages[messages.length - 1] : null;
  if (typeof lastMessage === "string") {
    subtitle = lastMessage;
  } else if (lastMessage && typeof lastMessage.key === "string") {
    const options = { ...(lastMessage.options ?? {}) };
    if (
      lastMessage.key === "status.assemblyProgress" &&
      typeof options.phase === "string"
    ) {
      const raw = options.phase as string;
      options.phase = t(
        `status.assemblyPhase${raw.charAt(0).toUpperCase()}${raw.slice(1)}`,
        raw,
      );
    }
    const translated = t(lastMessage.key, options) as string;
    if (translated !== lastMessage.key) {
      subtitle = translated;
    }
  }

  let currentStepIndex = -1;
  if (isComplete) currentStepIndex = steps.length - 1;
  else if (
    hasMessage("status.assemblingServer") ||
    hasMessage("status.assemblyProgress") ||
    hasMessage("status.finalizingServer")
  )
    currentStepIndex = 3; // assembling
  else if (
    hasMessage("status.uploadProgress") ||
    hasMessage("status.waitingForUploads") ||
    hasMessage("status.sendingScrapeComplete") ||
    hasMessage("status.scrapeComplete")
  )
    currentStepIndex = 2; // uploading
  else if (hasMessage("status.scraping") || hasMessage("status.scraped"))
    currentStepIndex = 1; // scraping
  else if (hasMessage("status.connected")) currentStepIndex = 0; // connected

  return (
    <div className="pt-4 animate-fade-in">
      <div className="card p-6 bg-white space-y-6">
        {/* Dynamic Status Text */}
        <div className="text-center pb-2">
          <div className="text-2xl font-bold text-slate-800">
            {isComplete
              ? t("status.done")
              : currentStepIndex === 3
                ? t("status.assemblingServer")
                : currentStepIndex === 2
                  ? t("status.packing")
                  : currentStepIndex === 1
                    ? t("status.downloading")
                    : t("status.ready")}
          </div>
          <div className="text-slate-500 text-sm mt-1">{subtitle}</div>
        </div>

        {/* Stepper */}
        <div className="space-y-4 relative">
          {/* Vertical Line */}
          <div className="absolute left-3.5 top-2 bottom-2 w-0.5 bg-slate-100 -z-10" />

          {steps.map((step, index) => {
            const isCompleted =
              index < currentStepIndex ||
              currentStepIndex === 3 ||
              (index === 0 && currentStepIndex === 0);
            const isCurrent =
              index === currentStepIndex && currentStepIndex !== 3;

            return (
              <div key={step.id} className="flex items-center gap-4 bg-white">
                <div className="relative flex shrink-0 items-center justify-center">
                  {isCompleted ? (
                    <CheckCircle className="w-8 h-8 text-green-500 fill-white" />
                  ) : isCurrent ? (
                    <div className="relative">
                      <div className="absolute inset-0 bg-brand/20 rounded-full animate-ping" />
                      <Loader2 className="w-8 h-8 text-brand animate-spin bg-white rounded-full" />
                    </div>
                  ) : (
                    <Circle className="w-8 h-8 text-slate-200 fill-white" />
                  )}
                </div>
                <div
                  className={cn(
                    "font-medium transition-colors duration-300",
                    isCompleted
                      ? "text-slate-900"
                      : isCurrent
                        ? "text-brand"
                        : "text-slate-400",
                  )}
                >
                  {step.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
