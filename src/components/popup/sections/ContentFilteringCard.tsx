// src/components/popup/sections/ContentFilteringCard.tsx
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../../ui/select";
import { Filter, FileType } from "lucide-react";

type DownloadMode = "single" | "website";
type AccordionName = "download" | "filtering" | "preview";

interface ContentFilteringCardProps {
  downloadMode: DownloadMode;
  isOpen: boolean;
  toggleAccordion: (accordion: AccordionName) => void;
}

export default function ContentFilteringCard({ downloadMode, isOpen, toggleAccordion }: ContentFilteringCardProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all hover:shadow-md">
      <div
        className="bg-gradient-to-r from-blue-50 to-indigo-50 p-3 border-b border-slate-200 cursor-pointer flex justify-between items-center"
        onClick={() => toggleAccordion("filtering")}
      >
        <h2 className="text-lg font-medium text-slate-800 flex items-center">
          <Filter className="h-5 w-5 mr-2 text-blue-600" />
          Content Filtering
        </h2>
        <div className={`transform transition-transform ${isOpen ? "rotate-180" : ""}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      <div className={`transition-all duration-300 overflow-hidden ${isOpen ? "max-h-[1000px] p-4 space-y-4" : "max-h-0 p-0 opacity-0"}`}>
        <div className="space-y-3">
          <Label className="text-sm font-medium text-slate-700">
            Include Content
          </Label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {downloadMode === "website" && (
              <div className="flex items-center space-x-2 bg-slate-50 p-2 rounded-md hover:bg-slate-100 transition-colors">
                <Checkbox id="includeSubpages" defaultChecked className="text-blue-600" />
                <Label htmlFor="includeSubpages" className="text-sm text-slate-700 cursor-pointer">
                  Include Subpages
                </Label>
              </div>
            )}
            <div className="flex items-center space-x-2 bg-slate-50 p-2 rounded-md hover:bg-slate-100 transition-colors">
              <Checkbox id="includeAssets" defaultChecked className="text-blue-600" />
              <Label htmlFor="includeAssets" className="text-sm text-slate-700 cursor-pointer">
                Include Assets (CSS, JS, Images)
              </Label>
            </div>
            {/* More filter options can go here */}
          </div>
        </div>

        <div className="space-y-3 pt-2 border-t border-slate-100">
          <div className="flex items-center">
            <FileType className="h-4 w-4 mr-2 text-slate-500" />
            <Label className="text-sm font-medium text-slate-700">
              Filter by File Type
            </Label>
          </div>

          <div className="space-y-3">
            <div className="flex items-center space-x-2 bg-slate-50 p-2 rounded-md hover:bg-slate-100 transition-colors">
              <Checkbox id="filterExtensions" className="text-blue-600" />
              <Label htmlFor="filterExtensions" className="text-sm text-slate-700 cursor-pointer">
                By Extensions
              </Label>
            </div>
            <Input
              type="text"
              placeholder="e.g., html, css, js"
              className="w-full focus:ring-blue-500 focus:border-blue-500"
            />

            <div className="flex items-center space-x-2 bg-slate-50 p-2 rounded-md hover:bg-slate-100 transition-colors">
              <Checkbox id="filterTypes" className="text-blue-600" />
              <Label htmlFor="filterTypes" className="text-sm text-slate-700 cursor-pointer">
                By File Type
              </Label>
            </div>
            <Select>
              <SelectTrigger className="w-full focus:ring-blue-500 focus:border-blue-500">
                <SelectValue placeholder="Select file type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="document">Documents</SelectItem>
                <SelectItem value="image">Images</SelectItem>
                <SelectItem value="script">Scripts</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}