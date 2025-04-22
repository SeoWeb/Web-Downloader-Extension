// src/components/ui/FilterGroup.tsx
import React from "react";
import FilterOption from "./FilterOption";
import { Label } from "./label";

interface FilterItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

interface FilterGroupProps<T extends FilterItem> {
  items: T[];
  selectedItems: string[];
  onSelectionChange: (id: string) => void;
  groupLabel?: string;
}

export default function FilterGroup<T extends FilterItem>({
  items,
  selectedItems,
  onSelectionChange,
  groupLabel,
}: FilterGroupProps<T>) {
  return (
    <div className="space-y-1 pl-2 border-l-2 border-blue-200 ml-1 h-[325px] overflow-auto">
      {groupLabel && (
         <Label className="text-sm text-slate-600 mb-1 block">{groupLabel}</Label>
      )}
      {items.map((item) => (
        <FilterOption
          key={item.id}
          id={item.id}
          label={item.label}
          icon={item.icon}
          checked={selectedItems.includes(item.id)}
          onCheckedChange={onSelectionChange}
        />
      ))}
    </div>
  );
}