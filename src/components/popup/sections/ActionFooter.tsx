// src/components/popup/sections/ActionFooter.tsx
import { Button } from "../../ui/button";
import { Settings, Download } from "lucide-react";
import { cn } from "../../../lib/utils"; // Import cn for conditional classes

type DownloadMode = "single" | "website";

interface ActionFooterProps {
  downloadMode: DownloadMode;
  isDownloadDisabled?: boolean; // Add the new prop
}

export default function ActionFooter({
  downloadMode,
  isDownloadDisabled = false, // Destructure and provide default value
}: ActionFooterProps) {
  return (
    <div className="sticky bottom-0 bg-white border-t border-slate-200 py-2 px-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button
            variant="outline"
            size="sm"
            className="text-slate-600 border-slate-300 hover:bg-slate-50"
          >
            <Settings className="mr-1 h-4 w-4" /> Options
          </Button>
        </div>
        <Button
          variant="primary"
          size="sm"
          // Apply disabled attribute
          disabled={isDownloadDisabled}
          // Use cn to conditionally apply disabled styles
          className={cn(
            "bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg hover:shadow-xl transition-all duration-200",
            isDownloadDisabled && "opacity-50 cursor-not-allowed hover:from-blue-600 hover:to-indigo-600 hover:shadow-lg" // Add disabled styles
          )}
        >
          <Download className="h-5 w-5 mr-2" />
          {downloadMode === "single" ? "Download Page" : "Download Website"}
        </Button>
      </div>
    </div>
  );
}