// src/components/popup/sections/content-filtering/types.ts
import React from "react";

export type GroupId = 'image' | 'script' | 'stylesheet' | 'font' | 'html' | 'document' | 'xml' | 'audio' | 'video' | 'json' | 'archive' | 'spreadsheet' | 'executable' | 'other';

export interface GroupItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

export interface FilterGroupData {
  id: GroupId;
  label: string;
  icon: React.ReactNode;
  items: GroupItem[];
}

export type DownloadMode = "single" | "website";
export type FilterMode = "extension" | "type";

export interface ContentFilteringCardProps {
  onNext?: () => void;
  onBack?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  containerClassName?: string;
}