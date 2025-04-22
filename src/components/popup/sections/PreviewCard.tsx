// src/components/popup/sections/PreviewCard.tsx
import { Checkbox } from "../../ui/checkbox";
import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";
import { CheckSquare } from "lucide-react";

type AccordionName = "download" | "filtering" | "preview";

interface PreviewCardProps {
  isOpen: boolean;
  toggleAccordion: (accordion: AccordionName) => void;
}

export default function PreviewCard({ isOpen, toggleAccordion }: PreviewCardProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all hover:shadow-md">
      <div
        className="bg-gradient-to-r from-blue-50 to-indigo-50 p-3 border-b border-slate-200 cursor-pointer flex justify-between items-center"
        onClick={() => toggleAccordion("preview")}
      >
        <h2 className="text-lg font-medium text-slate-800 flex items-center">
          <CheckSquare className="h-5 w-5 mr-2 text-blue-600" />
          Files & Subpages to Download
        </h2>
        <div className={`transform transition-transform ${isOpen ? "rotate-180" : ""}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      <div className={`transition-all duration-300 overflow-hidden ${isOpen ? "max-h-[1000px] p-4 space-y-3" : "max-h-0 p-0 opacity-0"}`}>
        <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg bg-slate-50">
          {/* TODO: Replace with dynamic list */}
          <ul className="divide-y divide-slate-200">
            <li className="flex items-center p-3 hover:bg-slate-100 transition-colors">
              <Checkbox id="page1" className="mr-3 text-blue-600" />
              <Label htmlFor="page1" className="text-sm text-slate-700 cursor-pointer flex-1">
                index.html
              </Label>
              <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">HTML</span>
            </li>
            <li className="flex items-center p-3 hover:bg-slate-100 transition-colors">
              <Checkbox id="page2" className="mr-3 text-blue-600" />
              <Label htmlFor="page2" className="text-sm text-slate-700 cursor-pointer flex-1">
                /about
              </Label>
              <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">HTML</span>
            </li>
            <li className="flex items-center p-3 hover:bg-slate-100 transition-colors">
              <Checkbox id="style.css" className="mr-3 text-blue-600" />
              <Label htmlFor="style.css" className="text-sm text-slate-700 cursor-pointer flex-1">
                css/style.css
              </Label>
              <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full">CSS</span>
            </li>
          </ul>
        </div>
        <p className="text-xs text-slate-500">
          Select which files and pages to download.
        </p>

        <div className="pt-3 border-t border-slate-100">
          <div className="flex items-center justify-between bg-slate-50 p-3 rounded-lg">
            <div className="space-y-1">
              <Label
                htmlFor="autoAccept"
                className="text-sm font-medium text-slate-700"
              >
                Auto Accept New Pages
              </Label>
              <p className="text-xs text-slate-500">
                Automatically start downloading linked pages.
              </p>
            </div>
            <Switch id="autoAccept" defaultChecked className="text-blue-600" />
          </div>
        </div>
      </div>
    </div>
  );
}