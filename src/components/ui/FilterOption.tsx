// src/components/ui/FilterOption.tsx
import React from "react";
import { Checkbox } from "./checkbox";
import { Label } from "./label";

interface FilterOptionProps {
  id: string;
  label: string;
  icon?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (id: string) => void;
}

export default function FilterOption({
  id,
  label,
  icon,
  checked,
  onCheckedChange,
}: FilterOptionProps) {
  const uniqueId = `filter-option-${id}`;
  return (
    <div className="bg-slate-50 p-1 rounded-md hover:bg-slate-100 transition-colors">
      <Label
        htmlFor={uniqueId}
        className="flex items-center space-x-2 text-sm text-slate-800 cursor-pointer w-full"
      >
        <Checkbox
          id={uniqueId}
          checked={checked}
          onCheckedChange={() => onCheckedChange(id)}
          className="text-blue-600"
        />
        <span className="flex items-center">
          {icon} {label}
        </span>
      </Label>
    </div>
  );
}