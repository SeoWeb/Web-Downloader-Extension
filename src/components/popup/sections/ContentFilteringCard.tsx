// src/components/popup/sections/ContentFilteringCard.tsx
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../../ui/select";
import { Filter, FileType } from "lucide-react";
import AccordionCard from "../../ui/AccordionCard"; // Import the new component

type DownloadMode = "single" | "website";
type AccordionName = "download" | "filtering" | "preview";

interface ContentFilteringCardProps {
  downloadMode: DownloadMode;
  isOpen: boolean;
  toggleAccordion: (accordion: AccordionName) => void;
}

export default function ContentFilteringCard({ downloadMode, isOpen, toggleAccordion }: ContentFilteringCardProps) {
  return (
    <AccordionCard
      title="Content Filtering"
      icon={<Filter className="h-4 w-4 mr-2" />}
      isOpen={isOpen}
      toggleAccordion={() => toggleAccordion("filtering")}
    >
      {/* Content goes here */}
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
    </AccordionCard>
  );
}