// src/components/popup/sections/DownloadConfigCard.tsx
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Slider } from "../../ui/slider";
import { Layers, Clock, FolderDown } from "lucide-react";

type DownloadMode = "single" | "website";
type AccordionName = "download" | "filtering" | "preview";

interface DownloadConfigCardProps {
  downloadMode: DownloadMode;
  isOpen: boolean;
  toggleAccordion: (accordion: AccordionName) => void;
}

export default function DownloadConfigCard({ downloadMode, isOpen, toggleAccordion }: DownloadConfigCardProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all hover:shadow-md">
      <div
        className="bg-gradient-to-r from-blue-50 to-indigo-50 p-3 border-b border-slate-200 cursor-pointer flex justify-between items-center"
        onClick={() => toggleAccordion("download")}
      >
        <h2 className="text-lg font-medium text-slate-800 flex items-center">
          <Layers className="h-5 w-5 mr-2 text-blue-600" />
          Download Configuration
          {downloadMode === "single" ? (
            <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
              Single Page
            </span>
          ) : (
            <span className="ml-2 text-xs bg-indigo-100 text-indigo-800 px-2 py-1 rounded-full">
              Whole Website
            </span>
          )}
        </h2>
        <div className={`transform transition-transform ${isOpen ? "rotate-180" : ""}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      <div className={`transition-all duration-300 overflow-hidden ${isOpen ? "max-h-[1000px] p-4 space-y-4" : "max-h-0 p-0 opacity-0"}`}>
        {downloadMode === "website" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label
                htmlFor="downloadDepth"
                className="text-sm font-medium text-slate-700 flex items-center"
              >
                Download Depth
              </Label>
              <span className="text-sm font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                <span id="depthValue">1</span> Page(s) {/* TODO: Make dynamic */}
              </span>
            </div>
            <Slider
              defaultValue={[1]}
              min={1}
              max={10}
              step={1}
              id="downloadDepth"
              className="flex-grow"
              // TODO: Add onChange handler to update depthValue
            />
            <p className="text-xs text-slate-500">
              How many levels deep should the crawler go?
            </p>
          </div>
        )}

        {downloadMode === "website" && (
          <div className="space-y-2">
            <div className="flex items-center">
              <Clock className="h-4 w-4 mr-2 text-slate-500" />
              <Label
                htmlFor="delay"
                className="text-sm font-medium text-slate-700"
              >
                Delay Between Pages (ms)
              </Label>
            </div>
            <Input
              type="number"
              id="delay"
              defaultValue={500}
              className="w-full focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center">
            <FolderDown className="h-4 w-4 mr-2 text-slate-500" />
            <Label
              htmlFor="downloadDir"
              className="text-sm font-medium text-slate-700"
            >
              Download Directory
            </Label>
          </div>
          <Input
            type="text"
            id="downloadDir"
            placeholder="e.g., ~/Downloads/website"
            className="w-full focus:ring-blue-500 focus:border-blue-500"
          />
          <p className="text-xs text-slate-500">
            Specify where to save the downloaded files.
          </p>
        </div>
      </div>
    </div>
  );
}