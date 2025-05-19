// src/components/popup/sections/LeftMenu.tsx
import { FileDown, FileStack, Download, FileCode2 } from "lucide-react";
import MenuItem from "../../ui/MenuItem";
import { useDownloadSettingsStore } from "../../../store/downloadSettingsStore";
import { useLanguageStore } from "../../../store/languageStore";

export default function LeftMenu() {
  const { downloadMode, setDownloadMode } = useDownloadSettingsStore();
  const { direction, getTranslation } = useLanguageStore();

  return (
    <div className={`w-56 bg-white ${direction === 'rtl' ? 'border-l' : 'border-r'} border-slate-200 shadow-sm flex flex-col fixed h-screen z-10`}>
      <div className="p-2 border-b border-slate-200 bg-gradient-to-r from-blue-600 to-indigo-700 text-white">
        <h2 className={`font-bold text-lg flex items-center gap-2 ${direction === "rtl" ? "flex-row-reverse" : ""}`}> 
          <Download className="h-5 w-5" />
          {getTranslation("download_mode")}
        </h2>
      </div>

      <div className="flex flex-col p-2 space-y-1 flex-grow">
        <MenuItem
          icon={<FileDown className="h-5 w-5" />}
          label={getTranslation("single_page")}
          isActive={downloadMode === "single"}
          onClick={() => setDownloadMode("single")}
        />
        <MenuItem
          icon={<FileCode2 className="h-5 w-5" />}
          label={getTranslation("single_file")}
          isActive={downloadMode === "single_file"}
          onClick={() => setDownloadMode("single_file")}
        />
        <MenuItem
          icon={<FileStack className="h-5 w-5" />}
          label={getTranslation("whole_website")}
          isActive={downloadMode === "website"}
          onClick={() => setDownloadMode("website")}
        />
      </div>

      <div className="p-2 border-t border-slate-200">
        <div className={`text-xs text-slate-500 min-h-9 flex items-center ${direction === "rtl" ? "text-right" : ""}`}>
          {downloadMode === "single" ? (
            <p>{getTranslation('single_download_description')}</p>
          ) : (
            <p>{getTranslation('site_download_description')}</p>
          )}
        </div>
      </div>
    </div>
  );
}