// src/components/popup/sections/LeftMenu.tsx
import { FileDown, Globe, Download } from "lucide-react";

type DownloadMode = "single" | "website";

interface LeftMenuProps {
  downloadMode: DownloadMode;
  setDownloadMode: (mode: DownloadMode) => void;
}

export default function LeftMenu({ downloadMode, setDownloadMode }: LeftMenuProps) {
  return (
    <div className="w-56 bg-white border-r border-slate-200 shadow-sm flex flex-col fixed h-screen z-10">
      <div className="p-4 border-b border-slate-200 bg-gradient-to-r from-blue-600 to-indigo-700 text-white">
        <h2 className="font-bold text-lg flex items-center py-1">
          <Download className="h-6 w-6 mr-2" />
          Download Mode
        </h2>
      </div>

      <div className="flex flex-col p-2 space-y-1 flex-grow">
        <button
          onClick={() => setDownloadMode("single")}
          className={`flex items-center space-x-2 p-3 rounded-lg text-left transition-colors ${
            downloadMode === "single"
              ? "bg-blue-50 text-blue-700 font-medium"
              : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <FileDown className="h-5 w-5" />
          <span>Single Page</span>
        </button>

        <button
          onClick={() => setDownloadMode("website")}
          className={`flex items-center space-x-2 p-3 rounded-lg text-left transition-colors ${
            downloadMode === "website"
              ? "bg-blue-50 text-blue-700 font-medium"
              : "hover:bg-slate-100 text-slate-700"
          }`}
        >
          <Globe className="h-5 w-5" />
          <span>Whole Website</span>
        </button>
      </div>

      <div className="p-3 border-t border-slate-200">
        <div className="text-xs text-slate-500">
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