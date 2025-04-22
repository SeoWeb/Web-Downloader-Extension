// src/components/popup/sections/ContentFilteringCard.tsx
import { useState } from "react";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { RadioGroup, RadioGroupItem } from "../../ui/radio-group"; // Import RadioGroup
import {
  Filter,
  FileType,
  FileText,
  Image,
  Code,
  FileCode2, // Added for CSS, HTML, XML
  FileAudio, // Added for Audio
  FileVideo, // Added for Video
  FileJson,  // Added for JSON
  Type       // Added for Fonts
} from "lucide-react";
import AccordionCard from "../../ui/AccordionCard";

type DownloadMode = "single" | "website";
type AccordionName = "download" | "filtering" | "preview";
type FilterMode = "extension" | "type";

interface ContentFilteringCardProps {
  downloadMode: DownloadMode;
  isOpen: boolean;
  toggleAccordion: (accordion: AccordionName) => void;
}

// Define available asset types for multi-select
const assetTypes = [
  { id: "image", label: "Images", icon: <Image className="h-4 w-4 mr-1 text-slate-500" /> },
  { id: "script", label: "Scripts (JS)", icon: <Code className="h-4 w-4 mr-1 text-slate-500" /> },
  { id: "stylesheet", label: "Stylesheets (CSS)", icon: <FileCode2 className="h-4 w-4 mr-1 text-slate-500" /> },
  { id: "font", label: "Fonts", icon: <Type className="h-4 w-4 mr-1 text-slate-500" /> },
  { id: "html", label: "HTML", icon: <FileCode2 className="h-4 w-4 mr-1 text-slate-500" /> },
  { id: "document", label: "Documents (.doc, .pdf, ...)", icon: <FileText className="h-4 w-4 mr-1 text-slate-500" /> },
  { id: "xml", label: "XML", icon: <FileCode2 className="h-4 w-4 mr-1 text-slate-500" /> },
  { id: "audio", label: "Audio", icon: <FileAudio className="h-4 w-4 mr-1 text-slate-500" /> },
  { id: "video", label: "Video", icon: <FileVideo className="h-4 w-4 mr-1 text-slate-500" /> },
  { id: "json", label: "Data (JSON)", icon: <FileJson className="h-4 w-4 mr-1 text-slate-500" /> },
];

export default function ContentFilteringCard({ isOpen, toggleAccordion }: ContentFilteringCardProps) {
  const [filterMode, setFilterMode] = useState<FilterMode>("type"); // State for filter mode
  const [selectedAssetTypes, setSelectedAssetTypes] = useState<string[]>([
    "image",
    "script",
    "stylesheet",
    "html",
    "font",
  ]); // State for selected types
  const [extensions, setExtensions] = useState<string>(""); // State for extensions input

  const handleAssetTypeChange = (typeId: string) => {
    setSelectedAssetTypes((prev) =>
      prev.includes(typeId) ? prev.filter((id) => id !== typeId) : [...prev, typeId]
    );
  };

  return (
    <AccordionCard
      title="Content Filtering"
      icon={<Filter className="h-4 w-4 mr-2" />}
      isOpen={isOpen}
      toggleAccordion={() => toggleAccordion("filtering")}
    >

      {/* Filtering Section */}
      <div className="space-y-3 pt-4 border-t border-slate-100">
        <div className="flex items-center mb-2">
          <FileType className="h-4 w-4 mr-2 text-slate-500" />
          <Label className="text-sm font-medium text-slate-700">
            Filter Included Assets By
          </Label>
        </div>

        {/* Filter Mode Selection */}
        <RadioGroup
          value={filterMode}
          onValueChange={(value: string) => setFilterMode(value as FilterMode)}
          className="flex space-x-4 mb-3"
        >
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="type" id="filter-type" />
            <Label htmlFor="filter-type" className="cursor-pointer">File Type</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="extension" id="filter-extension" />
            <Label htmlFor="filter-extension" className="cursor-pointer">File Extension</Label>
          </div>
        </RadioGroup>

        {/* Conditional Rendering based on Filter Mode */}
        {filterMode === "extension" && (
          <div className="space-y-2 pl-2 border-l-2 border-blue-200 ml-1">
            <Label htmlFor="extensionsInput" className="text-sm text-slate-600">Enter extensions (comma-separated):</Label>
            <Input
              id="extensionsInput"
              type="text"
              placeholder="e.g., html, css, jpg, png"
              value={extensions}
              onChange={(e) => setExtensions(e.target.value)}
              className="w-full focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        )}

        {filterMode === "type" && (
          <div className="space-y-2 pl-2 border-l-2 border-blue-200 ml-1">
             <Label className="text-sm text-slate-600 mb-1 block">Select asset types:</Label>
            {assetTypes.map((type) => (
              <div key={type.id} className="flex items-center space-x-2 bg-slate-50 p-2 rounded-md hover:bg-slate-100 transition-colors">
                <Checkbox
                  id={`type-${type.id}`}
                  checked={selectedAssetTypes.includes(type.id)}
                  onCheckedChange={() => handleAssetTypeChange(type.id)}
                  className="text-blue-600"
                />
                 <Label htmlFor={`type-${type.id}`} className="flex items-center text-sm text-slate-700 cursor-pointer">
                   {type.icon} {type.label}
                 </Label>
              </div>
            ))}
          </div>
        )}
      </div>
    </AccordionCard>
  );
}