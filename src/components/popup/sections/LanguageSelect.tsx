// src/components/popup/sections/LanguageSelect.tsx
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { useLanguageStore } from "../../../store/languageStore";
import { LanguageCode, languages } from "../../../common/chrome/getTranslation";
import * as langConstants from "../../../config/languageConstants";
import { Globe } from "lucide-react";

export default function LanguageSelect() {
  const { direction, currentLanguage, setLanguage, getTranslation } =
    useLanguageStore();

  const handleLanguageChange = (value: string) => {
    setLanguage(value as LanguageCode);
  };

  return (
    <Select value={currentLanguage} onValueChange={handleLanguageChange}>
      <SelectTrigger
        className={`w-auto bg-transparent border-none text-white hover:bg-white/20 focus:ring-0 focus:ring-offset-0 px-2 py-1 h-auto text-sm gap-1 ${
          direction === "rtl" ? "text-right flex-row-reverse" : "text-left"
        }`}
      >
        <Globe className="h-4 w-4" />
        <SelectValue>
          <span>
            {langConstants[
              `LANG_${currentLanguage.toUpperCase()}` as keyof typeof langConstants
            ] || `lang_${currentLanguage}`}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        className="bg-white h-[480px] w-auto mr-0 pr-0 top-0 right-0 overflow-y-auto"
        position="popper"
      >
        {Object.entries(languages).map(([code, _name]) => (
          <SelectItem
            key={code}
            value={code}
            currentValue={currentLanguage}
            className="text-gray-900 hover:bg-gray-100 py-1"
          >
            {getTranslation(
              langConstants[
                `LANG_${code.toUpperCase()}` as keyof typeof langConstants
              ] || `lang_${code}`,
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
