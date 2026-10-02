// src/components/popup/sections/DownloadConfigCard.tsx
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Slider } from "../../ui/slider";
import { Layers, Clock, FolderDown } from "lucide-react";
import StaticCard from "../../ui/StaticCard";
import { useState } from "react";
import { useDownloadSettingsStore } from "../../../store/downloadSettingsStore";
interface DownloadConfigCardProps {
  onNext?: () => void;
  onBack?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  containerClassName?: string;
}

export default function DownloadConfigCard({
  onNext,
  onBack,
  isFirst,
  isLast,
  containerClassName,
}: DownloadConfigCardProps) {
  const { downloadMode } = useDownloadSettingsStore();
  const [depthValue, setDepthValue] = useState(1);

  const cardTitle = (
    <>
      Download Configuration
      {downloadMode === "single" ? (
        <span className="ml-1.5 text-xs bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded-full">
          Single Page
        </span>
      ) : (
        <span className="ml-1.5 text-xs bg-indigo-100 text-indigo-800 px-1.5 py-0.5 rounded-full">
          Whole Website
        </span>
      )}
    </>
  );

  return (
    <StaticCard
      title={cardTitle}
      icon={<Layers className="h-4 w-4 mr-2" />}
      onNext={onNext}
      onBack={onBack}
      isFirst={isFirst}
      isLast={isLast}
      containerClassName={containerClassName}
    >
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
              <span id="depthValue">{depthValue}</span> Page(s)
            </span>
          </div>
          <Slider
            defaultValue={[depthValue]}
            min={1}
            max={10}
            step={1}
            id="downloadDepth"
            className="flex-grow"
            onValueChange={(value) => setDepthValue(value[0])}
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
    </StaticCard>
  );
}
