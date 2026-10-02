// src/components/ui/InfoTooltip.tsx
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import React from "react";
import { cn } from "../../lib/utils";

interface InfoTooltipProps {
  text: string;
  side?: TooltipPrimitive.TooltipContentProps["side"];
}

const InfoTooltip: React.FC<InfoTooltipProps> = ({ text, side = "top" }) => {
  return (
    <TooltipPrimitive.Provider>
      <TooltipPrimitive.Root delayDuration={300}>
        <TooltipPrimitive.Trigger asChild>
          <button className="p-0.5 rounded-full hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-300">
            <Info className="h-4 w-4 text-slate-500" />
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={5}
            className={cn(
              "z-50 overflow-hidden rounded-md border bg-white px-3 py-1.5 text-sm text-slate-900 shadow-md animate-in fade-in-0 zoom-in-95",
              "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
              "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
              "dark:border-slate-800 dark:bg-slate-950 dark:text-slate-50",
            )}
          >
            {text}
            <TooltipPrimitive.Arrow className="fill-white dark:fill-slate-950" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
};

export default InfoTooltip;
