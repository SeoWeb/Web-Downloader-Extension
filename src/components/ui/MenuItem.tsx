// src/components/ui/MenuItem.tsx
import React from "react";
import { cn } from "../../lib/utils"; // Use relative path

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  onClick: () => void;
}

export default function MenuItem({ icon, label, isActive, onClick }: MenuItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center space-x-2 p-3 rounded-lg text-left transition-colors w-full",
        {
          "bg-blue-50 text-blue-700 font-medium": isActive,
          "hover:bg-slate-100 text-slate-700": !isActive,
        }
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}