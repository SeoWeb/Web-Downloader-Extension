// src/components/popup/sections/Header.tsx
import { Button } from "../../ui/button";
import { Download, HelpCircle, Globe } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { useLanguageStore } from "../../../store/languageStore";
import { LanguageCode, languages } from "../../../common/chrome/getTranslation";

export default function Header() {
  const { direction, currentLanguage, setLanguage, getTranslation } =
    useLanguageStore();

  const handleLanguageChange = (value: string) => {
    setLanguage(value as LanguageCode);
  };

  return (
    <header className="sticky top-0 z-10 bg-gradient-to-r from-blue-600 to-indigo-700 text-white p-1 shadow-md">
      <div
        className={`flex items-center justify-between ${direction === "rtl" ? "flex-row-reverse" : ""}`}
      >
        <div
          className={`flex items-center gap-2 ${direction === "rtl" ? "flex-row-reverse" : ""}`}
        >
          <Download className="h-5 w-5" />
          <h1 className="font-bold text-lg flex items-center">
            {getTranslation("title")}
          </h1>
        </div>
        <div
          className={`relative flex items-center gap-1 ${direction === "rtl" ? "flex-row-reverse" : ""}`}
        >
          <Button
            variant="ghost"
            size="sm"
            className={`text-white hover:bg-white/20 px-2 gap-1 ${direction === "rtl" ? "flex-row-reverse" : ""}`}
          >
            <HelpCircle className="h-4 w-4" />
            <span>{getTranslation("help")}</span>
          </Button>
          <Select value={currentLanguage} onValueChange={handleLanguageChange}>
            <SelectTrigger
              className={`w-auto bg-transparent border-none text-white hover:bg-white/20 focus:ring-0 focus:ring-offset-0 px-2 py-1 h-auto text-sm gap-1 ${direction === "rtl" ? "text-right flex-row-reverse" : "text-left"}`}
            >
              <Globe className="h-4 w-4" />
              <SelectValue>
                <span>{getTranslation(`lang_${currentLanguage}`)}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              className="bg-white w-auto mr-0 pr-0 top-0 right-0"
              position="popper"
            >
              {Object.entries(languages).map(([code, _name]) => (
                <SelectItem
                  key={code}
                  value={code}
                  className="text-gray-900 hover:bg-gray-100 py-1"
                >
                  {getTranslation(`lang_${code}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </header>
  );
}
