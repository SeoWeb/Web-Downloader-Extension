// src/components/popup/sections/LeftMenu.tsx
import { FileDown, Globe, Download } from "lucide-react";
import MenuItem from "../../ui/MenuItem"; // Use relative path

type DownloadMode = "single" | "website";

interface LeftMenuProps {
  downloadMode: DownloadMode;
  setDownloadMode: (mode: DownloadMode) => void;
}

export default function LeftMenu({ downloadMode, setDownloadMode }: LeftMenuProps) {
  return (
    <div className="w-56 bg-white border-r border-slate-200 shadow-sm flex flex-col fixed h-screen z-10">
      <div className="p-2 border-b border-slate-200 bg-gradient-to-r from-blue-600 to-indigo-700 text-white">
        <h2 className="font-bold text-lg flex items-center"> {/* Removed py-1 */}
          <Download className="h-5 w-5 mr-2" /> {/* Slightly smaller icon */}
          Download Mode
        </h2>
      </div>

      <div className="flex flex-col p-2 space-y-1 flex-grow">
        <MenuItem
          icon={<FileDown className="h-5 w-5" />}
          label="Single Page"
          isActive={downloadMode === "single"}
          onClick={() => setDownloadMode("single")}
        />
        <MenuItem
          icon={<Globe className="h-5 w-5" />}
          label="Whole Website"
          isActive={downloadMode === "website"}
          onClick={() => setDownloadMode("website")}
        />
      </div>

      <div className="p-2 border-t border-slate-200">
        <div className="text-xs text-slate-500 min-h-9 flex items-center">
          {downloadMode === "single" ? (
            <p>Download just the current page with all its assets.</p>
          ) : (
            <p>Download the entire website including all linked pages.</p>
          )}
        </div>
      </div>
    </div>
  );
}