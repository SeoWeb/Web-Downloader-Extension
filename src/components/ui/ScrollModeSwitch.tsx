// src/components/ui/ScrollModeSwitch.tsx
import { Switch } from "./switch";
import { Label } from "./label";
import InfoTooltip from "./InfoTooltip";
import { cn } from "../../lib/utils";

interface ScrollModeSwitchProps {
  scrollMode: "auto" | "manual";
  onCheckedChange: (checked: boolean) => void;
  autoModeText: string;
  manualModeText: string;
  tooltipText: string;
  direction?: "ltr" | "rtl";
}

export default function ScrollModeSwitch({
  scrollMode,
  onCheckedChange,
  autoModeText,
  manualModeText,
  tooltipText,
  direction = "ltr",
}: ScrollModeSwitchProps) {
  const isAutoMode = scrollMode === "auto";

  return (
    <div
      className={cn(
        "flex items-center space-x-2",
        direction === "rtl" ? "space-x-reverse" : "",
      )}
    >
      <Switch
        id="scroll-mode-toggle"
        checked={isAutoMode}
        onCheckedChange={onCheckedChange}
        aria-label={tooltipText}
        className={cn(
          "data-[state=checked]:bg-blue-600 data-[state=unchecked]:bg-slate-300",
          "relative inline-flex flex-shrink-0 cursor-pointer",
          "rounded-full border-2 border-transparent",
          "transition-colors duration-200 ease-in-out",
          "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
        )}
      />
      <Label
        htmlFor="scroll-mode-toggle"
        className="text-sm text-slate-600 cursor-pointer"
      >
        {isAutoMode ? autoModeText : manualModeText}
      </Label>
      <InfoTooltip text={tooltipText} side="top" />
    </div>
  );
}
