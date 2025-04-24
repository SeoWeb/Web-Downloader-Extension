// src/components/ui/StaticCard.tsx
import React from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button"; // Assuming button import path
import { ArrowLeft, ArrowRight } from "lucide-react"; // Import icons

interface StaticCardProps {
  title: React.ReactNode;
  icon: React.ReactNode;
  children: React.ReactNode;
  headerClassName?: string;
  contentClassName?: string;
  containerClassName?: string;
  // New props for navigation
  onNext?: () => void;
  onBack?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
}

export default function StaticCard({
  title,
  icon,
  children,
  headerClassName,
  contentClassName,
  containerClassName,
  // Destructure new props
  onNext,
  onBack,
  isFirst = false, // Default values
  isLast = false,  // Default values
}: StaticCardProps) {
  return (
    <div
      className={cn(
        "bg-white rounded-sm shadow-lg border border-slate-200 overflow-hidden flex flex-col h-[485px]",
        containerClassName
      )}
    >
      <div
        className={cn(
          "bg-gradient-to-r from-blue-600 to-indigo-700 p-2 border-b border-slate-200 flex justify-between items-center",
          headerClassName
        )}
      >
        <h2 className="text-base font-medium text-white flex items-center">
          {icon}
          {title}
        </h2>
      </div>

      {/* Make content area scrollable if needed and take remaining space */}
      <div
        className={cn(
          "p-4 flex-grow overflow-y-auto", // Added flex-grow and overflow-y-auto
          contentClassName
        )}
      >
        <div className="space-y-4">{children}</div>
      </div>

      {/* Card Footer for Navigation */}
      {((onBack || onNext) && (!isFirst || !isLast)) && ( // Only show footer if navigation functions are provided
        <div className="p-2 border-t border-slate-200 bg-slate-50 flex justify-between items-center mt-auto">
          <div> {/* Placeholder for potential left-aligned content */}
            {!isFirst && onBack && (
              <Button variant="outline" size="sm" onClick={onBack}>
                <ArrowLeft className="mr-1 h-4 w-4" /> Back
              </Button>
            )}
          </div>
          <div> {/* Placeholder for potential right-aligned content */}
            {!isLast && onNext && (
              <Button variant="outline" size="sm" onClick={onNext}>
                 Next <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}