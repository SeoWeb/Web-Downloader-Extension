import * as React from "react";
import * as SliderPrimitives from "@radix-ui/react-slider";
import { cn } from "../../lib/utils";

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitives.Root
    ref={ref}
    className={cn(
      "relative flex w-full touch-none select-none items-center",
      className,
    )}
    {...props}
  >
    <SliderPrimitives.Track className="relative h-2 w-full grow rounded-full bg-gray-200">
      <SliderPrimitives.Range className="absolute h-full rounded-full bg-primary" />
    </SliderPrimitives.Track>
    <SliderPrimitives.Thumb className="block h-5 w-5 rounded-full bg-primary shadow-[0_2px_10px_-1px_#0b0e11] transition-transform focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" />
  </SliderPrimitives.Root>
));
Slider.displayName = "Slider";

export { Slider };
