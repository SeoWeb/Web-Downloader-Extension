import { useState } from "react";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Slider } from "../ui/slider";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { 
  Settings, 
  HelpCircle, 
  Download, 
  Layers, 
  Clock, 
  FolderDown, 
  FileType, 
  Filter, 
  CheckSquare,
  FileDown,
  Globe
} from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../ui/select";

export default function Popup() {
  const [downloadMode, setDownloadMode] = useState<"single" | "website">("single");
  const [openAccordion, setOpenAccordion] = useState<"download" | "filtering" | "preview" | null>("download");
  
  const toggleAccordion = (accordion: "download" | "filtering" | "preview") => {
    setOpenAccordion(accordion === openAccordion ? null : accordion);
  };
  return (
    <div className="w-full h-full bg-gradient-to-br from-slate-50 to-slate-100 overflow-y-auto flex">
      {/* Left Menu */}
      <div className="w-56 bg-white border-r border-slate-200 shadow-sm flex flex-col">
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
      
      {/* Main Content */}
      <div className="flex-grow">
        <header className="sticky top-0 z-10 bg-gradient-to-r from-blue-600 to-indigo-700 text-white p-4 shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Download className="h-6 w-6 mr-2" />
            <h1 className="font-bold text-lg flex items-center">Web Page & Site Downloader</h1>
          </div>
          <div className="flex items-center space-x-2">
            <Button variant="ghost" size="sm" className="text-white hover:bg-white/20">
              <Settings className="h-4 w-4 mr-1" />
              <span>Settings</span>
            </Button>
            <Button variant="ghost" size="sm" className="text-white hover:bg-white/20">
              <HelpCircle className="h-4 w-4 mr-1" />
              <span>Help</span>
            </Button>
          </div>
        </div>
      </header>
      
        <div className="p-6 space-y-6">

          {/* Download Configuration Card */}
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
              <div className={`transform transition-transform ${openAccordion === "download" ? "rotate-180" : ""}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>
          
            <div className={`transition-all duration-300 overflow-hidden ${openAccordion === "download" ? "max-h-[1000px] p-4 space-y-4" : "max-h-0 p-0 opacity-0"}`}>
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
                      <span id="depthValue">1</span> Page(s)
                    </span>
                  </div>
                  <Slider
                    defaultValue={[1]}
                    min={1}
                    max={10}
                    step={1}
                    id="downloadDepth"
                    className="flex-grow"
                  />
                  <p className="text-xs text-slate-500">
                    How many levels deep should the crawler go?
                  </p>
                </div>
              )}

            {downloadMode === "website" && (<div className="space-y-2">
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
            </div>)}

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

          {/* Content Filtering Card */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all hover:shadow-md">
            <div 
              className="bg-gradient-to-r from-blue-50 to-indigo-50 p-3 border-b border-slate-200 cursor-pointer flex justify-between items-center"
              onClick={() => toggleAccordion("filtering")}
            >
              <h2 className="text-lg font-medium text-slate-800 flex items-center">
                <Filter className="h-5 w-5 mr-2 text-blue-600" />
                Content Filtering
              </h2>
              <div className={`transform transition-transform ${openAccordion === "filtering" ? "rotate-180" : ""}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>
          
            <div className={`transition-all duration-300 overflow-hidden ${openAccordion === "filtering" ? "max-h-[1000px] p-4 space-y-4" : "max-h-0 p-0 opacity-0"}`}>
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

          {/* Preview Section Card */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all hover:shadow-md">
            <div 
              className="bg-gradient-to-r from-blue-50 to-indigo-50 p-3 border-b border-slate-200 cursor-pointer flex justify-between items-center"
              onClick={() => toggleAccordion("preview")}
            >
              <h2 className="text-lg font-medium text-slate-800 flex items-center">
                <CheckSquare className="h-5 w-5 mr-2 text-blue-600" />
                Files & Subpages to Download
              </h2>
              <div className={`transform transition-transform ${openAccordion === "preview" ? "rotate-180" : ""}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>
          
            <div className={`transition-all duration-300 overflow-hidden ${openAccordion === "preview" ? "max-h-[1000px] p-4 space-y-3" : "max-h-0 p-0 opacity-0"}`}>
            <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg bg-slate-50">
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
        
          {/* Action Footer */}
          <div className="sticky bottom-0 bg-white border-t border-slate-200 p-4 shadow-md rounded-t-xl mt-6 -mb-6">
            <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Button 
                variant="outline" 
                size="sm"
                className="text-slate-600 border-slate-300 hover:bg-slate-50"
              >
                <Settings className="mr-1 h-4 w-4" /> Options
              </Button>
              <Button 
                variant="outline" 
                size="sm"
                className="text-slate-600 border-slate-300 hover:bg-slate-50"
              >
                <HelpCircle className="mr-1 h-4 w-4" /> Support
              </Button>
            </div>
              <Button 
                variant="primary" 
                size="lg"
                className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg hover:shadow-xl transition-all duration-200"
              >
                <Download className="h-6 w-6 mr-2" /> 
                {downloadMode === "single" ? "Download Page" : "Download Website"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
