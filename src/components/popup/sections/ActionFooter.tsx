// src/components/popup/sections/ActionFooter.tsx
import { Button } from "../../ui/button";
import { Settings, Download } from "lucide-react";
import { useDownloadSettingsStore } from "../../../store/downloadSettingsStore";
import PrimaryButton from "../../ui/PrimaryButton";

interface ActionFooterProps {
  isDownloadDisabled?: boolean;
}

export default function ActionFooter({
  isDownloadDisabled = false,
}: ActionFooterProps) {
  const { downloadMode } = useDownloadSettingsStore();

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
        <PrimaryButton disabled={isDownloadDisabled}>
          <Download className="h-5 w-5 mr-2" />
          {downloadMode === "single" ? "Download Page" : "Download Website"}
        </PrimaryButton>
      </div>
    </div>
  );
}