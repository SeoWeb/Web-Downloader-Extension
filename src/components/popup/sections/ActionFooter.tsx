// src/components/popup/sections/ActionFooter.tsx
import { Button } from "../../ui/button";
import { Settings, Download } from "lucide-react";

type DownloadMode = "single" | "website";

interface ActionFooterProps {
  downloadMode: DownloadMode;
}

export default function ActionFooter({ downloadMode }: ActionFooterProps) {
  return (
    <div className="sticky bottom-0 bg-white border-t border-slate-200 py-2 px-2 mt-4"> {/* Reduced padding p-4 to p-2 and margin mt-6 to mt-4 */}
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
          className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg hover:shadow-xl transition-all duration-200"
        >
          <Download className="h-5 w-5 mr-2" />
          {downloadMode === "single" ? "Download Page" : "Download Website"}
        </Button>
      </div>
    </div>
  );
}