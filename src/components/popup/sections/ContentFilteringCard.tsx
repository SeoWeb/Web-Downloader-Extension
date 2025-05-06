// src/components/popup/sections/ContentFilteringCard.tsx
import { Label } from "../../ui/label";
import { RadioGroup, RadioGroupItem } from "../../ui/radio-group";
import { Filter, FileType } from "lucide-react";
import StaticCard from "../../ui/StaticCard";
import FilterGroup from "../../ui/FilterGroup";
import { filterGroups } from "./content-filtering/data";
import { ContentFilteringCardProps } from "./content-filtering/types";
import {
  useDownloadSettingsStore,
  FilterMode,
} from "../../../store/downloadSettingsStore";
import { useLanguageStore } from "../../../store/languageStore";

export default function ContentFilteringCard({
  onNext,
  onBack,
  isFirst,
  isLast,
  containerClassName,
}: ContentFilteringCardProps) {
  const { direction, getTranslation } = useLanguageStore();
  const {
    filterMode,
    selectedAssetTypes,
    selectedExtensions,
    setFilterMode,
    toggleAssetType,
    toggleExtension,
  } = useDownloadSettingsStore();
  const hasFooter = !isFirst || !isLast;

  return (
    <StaticCard
      title={getTranslation("filtering_title")}
      icon={<Filter className="h-4 w-4 mr-2" />}
      onNext={onNext}
      onBack={onBack}
      isFirst={isFirst}
      isLast={isLast}
      containerClassName={containerClassName}
    >
      <div>
        <div className={`flex justify-start gap-4 items-center mb-3 ${direction === "rtl" ? "flex-row-reverse" : ""}`}>
          {" "}
          <div className="flex items-center">
            {" "}
            <FileType className="h-4 w-4 mr-2 text-slate-500" />
            <Label className={`text-sm font-medium text-slate-700 flex items-center ${direction === "rtl" ? "flex-row-reverse" : ""}`}>
              {getTranslation("filtering_label")}<span>:</span>
            </Label>
          </div>
          <RadioGroup
            value={filterMode}
            onValueChange={(value) => setFilterMode(value as FilterMode)}
            className="flex gap-4"
          >
            <div className={`flex items-center gap-2 ${direction === "rtl" ? "flex-row-reverse" : ""}`}>
              <RadioGroupItem value="type" id="filter-type" />
              <Label htmlFor="filter-type" className="cursor-pointer">
                {getTranslation("filtering_by_type")}
              </Label>
            </div>
            <div className={`flex items-center gap-2 ${direction === "rtl" ? "flex-row-reverse" : ""}`}>
              <RadioGroupItem value="extension" id="filter-extension" />
              <Label htmlFor="filter-extension" className="cursor-pointer">
                {getTranslation("filtering_by_extension")}
              </Label>
            </div>
          </RadioGroup>
        </div>

        {filterMode === "extension" && (
          <FilterGroup
            items={filterGroups.flatMap(({ items }) => items)}
            selectedItems={selectedExtensions}
            onSelectionChange={toggleExtension}
            hasFooter={hasFooter}
          />
        )}

        {filterMode === "type" && (
          <FilterGroup
            items={filterGroups}
            selectedItems={selectedAssetTypes}
            onSelectionChange={toggleAssetType}
            hasFooter={hasFooter}
          />
        )}
      </div>
    </StaticCard>
  );
}
