// src/components/popup/sections/ContentFilteringCard.tsx
import { useState } from "react";
import { Label } from "../../ui/label";
import { RadioGroup, RadioGroupItem } from "../../ui/radio-group";
import { Filter, FileType } from "lucide-react";
import StaticCard from "../../ui/StaticCard";
import FilterGroup from "../../ui/FilterGroup";
import { filterGroups } from "./content-filtering/data";
import {
  ContentFilteringCardProps,
  FilterMode,
} from "./content-filtering/types";

export default function ContentFilteringCard({
  onNext,
  onBack,
  isFirst,
  isLast,
  containerClassName,
}: ContentFilteringCardProps) {
  const [filterMode, setFilterMode] = useState<FilterMode>("type");
  const [selectedAssetTypes, setSelectedAssetTypes] = useState<string[]>([
    "image",
    "script",
    "stylesheet",
    "html",
    "font",
  ]);
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([
    "jpg",
    "png",
    "gif",
    "svg",
    "webp",
    "js",
    "css",
    "woff",
    "woff2",
    "html",
  ]);

  const handleAssetTypeChange = (typeId: string) => {
    setSelectedAssetTypes((prev) =>
      prev.includes(typeId)
        ? prev.filter((id) => id !== typeId)
        : [...prev, typeId],
    );
    // TODO: Potentially sync extension selection based on type selection?
  };

  // Handler for extension changes
  const handleExtensionChange = (extId: string) => {
    setSelectedExtensions((prev) =>
      prev.includes(extId)
        ? prev.filter((id) => id !== extId)
        : [...prev, extId],
    );
  };

  return (
    <StaticCard
      title="Content Filtering"
      icon={<Filter className="h-4 w-4 mr-2" />}
      onNext={onNext}
      onBack={onBack}
      isFirst={isFirst}
      isLast={isLast}
      containerClassName={containerClassName}
    >
      <div className="">
        <div className="flex justify-start gap-4 items-center mb-3">
          {" "}
          <div className="flex items-center">
            {" "}
            <FileType className="h-4 w-4 mr-2 text-slate-500" />
            <Label className="text-sm font-medium text-slate-700">
              Filter Included Assets By:
            </Label>
          </div>
          <RadioGroup
            value={filterMode}
            onValueChange={(value: string) =>
              setFilterMode(value as FilterMode)
            }
            className="flex space-x-4"
          >
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="type" id="filter-type" />
              <Label htmlFor="filter-type" className="cursor-pointer">
                Type
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="extension" id="filter-extension" />
              <Label htmlFor="filter-extension" className="cursor-pointer">
                File Extension
              </Label>
            </div>
          </RadioGroup>
        </div>

        {filterMode === "extension" && (
          <FilterGroup
            items={filterGroups.flatMap(({ items }) => items)}
            selectedItems={selectedExtensions}
            onSelectionChange={handleExtensionChange}
          />
        )}

        {filterMode === "type" && (
          <FilterGroup
            items={filterGroups}
            selectedItems={selectedAssetTypes}
            onSelectionChange={handleAssetTypeChange}
          />
        )}
      </div>
    </StaticCard>
  );
}
