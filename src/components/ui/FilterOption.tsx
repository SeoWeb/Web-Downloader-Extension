// src/components/ui/FilterOption.tsx
import React from "react";
import { Checkbox } from "./checkbox";
import { Label } from "./label";
import { useLanguageStore } from "../../store/languageStore";
import { useDownloadSettingsStore } from "../../store/downloadSettingsStore";

interface FilterOptionProps {
  id: string;
  label: string;
  icon?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (id: string) => void;
}

export default function FilterOption({
  id,
  icon,
  checked,
  onCheckedChange,
}: FilterOptionProps) {
  const { direction, getTranslation } = useLanguageStore();
  const { filterMode } = useDownloadSettingsStore();
  const uniqueId = `filter-option-${id}`;
  const translation = filterMode === 'extension' ? id : getTranslation('filter_by_' + id)
  return (
    <div className="bg-slate-50 p-1 rounded-md hover:bg-slate-100 transition-colors">
      <Label
        htmlFor={uniqueId}
        className={`flex items-center gap-2 text-sm text-slate-800 cursor-pointer w-full ${
          direction === "rtl" ? "flex-row-reverse" : ""}`}
      >
        <Checkbox
          id={uniqueId}
          checked={checked}
          onCheckedChange={() => onCheckedChange(id)}
          className="text-blue-600"
        />
        <span className={`flex items-center gap-1 ${direction === "rtl" ? "flex-row-reverse" : ""}`}>
          <span>{icon}</span><span>{translation}</span>
        </span>
      </Label>
    </div>
  );
}