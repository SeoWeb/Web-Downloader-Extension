// src/components/popup/sections/Header.tsx
import { Button } from "../../ui/button";
import { Download, Settings, HelpCircle } from "lucide-react";

export default function Header() {
  return (
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
  );
}