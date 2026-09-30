// src/components/popup/sections/content-filtering/data.tsx
import {
  Image,
  Code,
  FileCode2,
  FileAudio,
  FileVideo,
  FileJson,
  Type,
  FileArchive,
  FileSpreadsheet,
  FileTerminal,
  FileQuestion,
  FileText,
} from "lucide-react";
import { FilterGroupData } from "./types"; // Import the type from the new types file

export const filterGroups: FilterGroupData[] = [
  {
    id: "image",
    label: "Images",
    icon: <Image className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "jpg", label: ".jpg / .jpeg", icon: <Image className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "png", label: ".png", icon: <Image className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "gif", label: ".gif", icon: <Image className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "svg", label: ".svg", icon: <Image className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "webp", label: ".webp", icon: <Image className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "ico", label: ".ico", icon: <Image className="h-4 w-4 mr-1 text-slate-500" /> }, // Added ico
    ],
  },
  {
    id: "script",
    label: "Scripts",
    icon: <Code className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "js", label: ".js", icon: <Code className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "ts", label: ".ts", icon: <Code className="h-4 w-4 mr-1 text-slate-500" /> }, // Added ts
    ],
  },
  {
    id: "stylesheet",
    label: "Stylesheets",
    icon: <FileCode2 className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "css", label: ".css", icon: <FileCode2 className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "scss", label: ".scss", icon: <FileCode2 className="h-4 w-4 mr-1 text-slate-500" /> }, // Added scss
    ],
  },
  {
    id: "font",
    label: "Fonts",
    icon: <Type className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "woff", label: ".woff", icon: <Type className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "woff2", label: ".woff2", icon: <Type className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "ttf", label: ".ttf", icon: <Type className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "otf", label: ".otf", icon: <Type className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "eot", label: ".eot", icon: <Type className="h-4 w-4 mr-1 text-slate-500" /> }, // Added eot
    ],
  },
  {
    id: "markup",
    label: "Markup",
    icon: <FileCode2 className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "html", label: ".html", icon: <FileCode2 className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "htm", label: ".htm", icon: <FileCode2 className="h-4 w-4 mr-1 text-slate-500" /> }, // Added htm
      { id: "xml", label: ".xml", icon: <FileCode2 className="h-4 w-4 mr-1 text-slate-500" /> },
    ],
  },
  {
    id: "document",
    label: "Documents",
    icon: <FileText className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "pdf", label: ".pdf", icon: <FileText className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "doc", label: ".doc", icon: <FileText className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "docx", label: ".docx", icon: <FileText className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "txt", label: ".txt", icon: <FileText className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "rtf", label: ".rtf", icon: <FileText className="h-4 w-4 mr-1 text-slate-500" /> }, // Added rtf
      { id: "odt", label: ".odt", icon: <FileText className="h-4 w-4 mr-1 text-slate-500" /> }, // Added odt
    ],
  },
   {
    id: "spreadsheet", // Added Spreadsheet group
    label: "Spreadsheets",
    icon: <FileSpreadsheet className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "csv", label: ".csv", icon: <FileSpreadsheet className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "xls", label: ".xls", icon: <FileSpreadsheet className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "xlsx", label: ".xlsx", icon: <FileSpreadsheet className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "ods", label: ".ods", icon: <FileSpreadsheet className="h-4 w-4 mr-1 text-slate-500" /> },
    ],
  },
  {
    id: "audio",
    label: "Audio",
    icon: <FileAudio className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "mp3", label: ".mp3", icon: <FileAudio className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "wav", label: ".wav", icon: <FileAudio className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "ogg", label: ".ogg", icon: <FileAudio className="h-4 w-4 mr-1 text-slate-500" /> }, // Added ogg
      { id: "aac", label: ".aac", icon: <FileAudio className="h-4 w-4 mr-1 text-slate-500" /> }, // Added aac
    ],
  },
  {
    id: "video",
    label: "Video",
    icon: <FileVideo className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "mp4", label: ".mp4", icon: <FileVideo className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "avi", label: ".avi", icon: <FileVideo className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "mov", label: ".mov", icon: <FileVideo className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "wmv", label: ".wmv", icon: <FileVideo className="h-4 w-4 mr-1 text-slate-500" /> }, // Added wmv
      { id: "webm", label: ".webm", icon: <FileVideo className="h-4 w-4 mr-1 text-slate-500" /> }, // Added webm
    ],
  },
  {
    id: "json", // Renamed from 'data' for clarity
    label: "Data",
    icon: <FileJson className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "json", label: ".json", icon: <FileJson className="h-4 w-4 mr-1 text-slate-500" /> },
    ],
  },
  {
    id: "archive",
    label: "Archives",
    icon: <FileArchive className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "zip", label: ".zip", icon: <FileArchive className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "rar", label: ".rar", icon: <FileArchive className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "tar", label: ".tar", icon: <FileArchive className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "gz", label: ".gz", icon: <FileArchive className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "7z", label: ".7z", icon: <FileArchive className="h-4 w-4 mr-1 text-slate-500" /> }, // Added 7z
    ],
  },
   {
    id: "executable", // Added Executable group
    label: "Executables/Scripts",
    icon: <FileTerminal className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "exe", label: ".exe", icon: <FileTerminal className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "sh", label: ".sh", icon: <FileTerminal className="h-4 w-4 mr-1 text-slate-500" /> },
      { id: "bat", label: ".bat", icon: <FileTerminal className="h-4 w-4 mr-1 text-slate-500" /> },
    ],
  },
  {
    id: "other", // Keep 'other' group
    label: "Other",
    icon: <FileQuestion className="h-4 w-4 mr-1 text-slate-500" />,
    items: [
      { id: "other", label: "Other/Unknown", icon: <FileQuestion className="h-4 w-4 mr-1 text-slate-500" /> },
    ],
  },
];