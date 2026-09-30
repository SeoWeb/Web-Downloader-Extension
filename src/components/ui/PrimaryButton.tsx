import React from "react";
import { Button } from "./button";
import { cn } from "../../lib/utils";

const PrimaryButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
  }
>(({ children, disabled = false, ...props }, ref) => {
  return (
    <Button
      ref={ref} // Forward the ref
      variant="primary"
      size="sm"
      disabled={disabled}
      className={cn(
        "bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg hover:shadow-xl transition-all duration-200",
        disabled &&
          "opacity-50 cursor-not-allowed hover:from-blue-600 hover:to-indigo-600 hover:shadow-lg",
      )}
      {...props} // Spread the rest of the props (including onClick)
    >
      {children}
    </Button>
  );
});

export default PrimaryButton;
