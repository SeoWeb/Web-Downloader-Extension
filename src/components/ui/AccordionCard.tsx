// src/components/ui/AccordionCard.tsx
import React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils"; // Assuming you have a utility for classnames

interface AccordionCardProps {
  title: React.ReactNode; // Allow React nodes for the title
  icon: React.ReactNode; // Accept any React node for the icon
  isOpen: boolean;
  toggleAccordion: () => void; // Simplified toggle function
  children: React.ReactNode;
  headerClassName?: string;
  contentClassName?: string;
  containerClassName?: string;
}

export default function AccordionCard({
  title,
  icon,
  isOpen,
  toggleAccordion,
  children,
  headerClassName,
  contentClassName,
  containerClassName,
}: AccordionCardProps) {
  return (
    <div
      className={cn(
        "bg-white rounded-sm shadow-lg border border-slate-200 overflow-hidden transition-all hover:shadow-md",
        containerClassName,
      )}
    >
      <div
        className={cn(
          "bg-gradient-to-r from-blue-600 to-indigo-700 p-2 border-b border-slate-200 cursor-pointer flex justify-between items-center",
          headerClassName,
        )}
        onClick={toggleAccordion}
      >
        <h2 className="text-base font-medium text-white flex items-center">
          {icon} {/* Render the passed icon */}
          {title}
        </h2>
        <div
          className={`transform transition-transform text-white ${isOpen ? "rotate-180" : ""}`}
        >
          {/* Using Lucide ChevronDown directly */}
          <ChevronDown className="h-5 w-5 mr-2" />
        </div>
      </div>

      <div
        className={cn(
          `transition-all duration-300 overflow-hidden`,
          isOpen ? "max-h-[1000px] p-4" : "max-h-0 p-0 opacity-0", // Keep padding inside content for better transition
          contentClassName,
        )}
      >
        {/* Render children only when open or during transition for smoother animation */}
        {isOpen && <div className="space-y-4">{children}</div>}
      </div>
    </div>
  );
}
