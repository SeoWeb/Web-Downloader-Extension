// src/components/popup/sections/PreviewCard.tsx
import { Checkbox } from "../../ui/checkbox";
import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";
import { CheckSquare } from "lucide-react";
import StaticCard from "../../ui/StaticCard";

// Define the props interface including navigation props
interface PreviewCardProps {
  onNext?: () => void;
  onBack?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  containerClassName?: string; // Add containerClassName
}

export default function PreviewCard({
  // Destructure the navigation props
  onNext,
  onBack,
  isFirst,
  isLast,
  containerClassName, // Destructure containerClassName
}: PreviewCardProps) {
  return (
    <StaticCard
      title="Files & Subpages to Download"
      icon={<CheckSquare className="h-4 w-4 mr-2" />}
      contentClassName="space-y-3"
      // Pass the navigation props down
      onNext={onNext}
      onBack={onBack}
      isFirst={isFirst}
      isLast={isLast}
      containerClassName={containerClassName} // Pass down containerClassName
    >
      {/* ... (rest of the component remains the same) */}
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
    </StaticCard>
  );
}