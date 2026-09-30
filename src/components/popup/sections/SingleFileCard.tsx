import { useLanguageStore } from "../../../store/languageStore";
import StaticCard from "../../ui/StaticCard";
import { ContentFilteringCardProps } from "./content-filtering/types";
import { FileCode2 } from "lucide-react";

export default function SingleFileCard({
  onNext,
  onBack,
  isFirst,
  isLast,
  containerClassName,
}: ContentFilteringCardProps) {
  const { direction, getTranslation } = useLanguageStore();

  return (
    <StaticCard
      title={getTranslation("single_file_title")}
      icon={<FileCode2 className="h-5 w-5" />}
      onNext={onNext}
      onBack={onBack}
      isFirst={isFirst}
      isLast={isLast}
      containerClassName={containerClassName}
    >
      <div className={`space-y-4 p-1 ${direction === "rtl" ? "text-right" : ""}`}>
        <h3 className="text-lg font-medium">
          {getTranslation("single_file_download_intro")}
        </h3>
        <ul dir={direction} className={`list-disc list-inside space-y-2 text-sm ${direction === "rtl" ? "text-right" : ""}`}>
          <li>
            <span className="font-bold">
              {getTranslation("single_file_format_mhtml_title")}
            </span>
            : {getTranslation("single_file_format_mhtml_desc")}
          </li>
          <li>
            <span className="font-bold">
              {getTranslation("single_file_includes_all_title")}
            </span>
            : {getTranslation("single_file_includes_all_desc")}
          </li>
          <li>
            <span className="font-bold">
              {getTranslation("single_file_offline_viewing_title")}
            </span>
            : {getTranslation("single_file_offline_viewing_desc")}
          </li>
          <li>
            <span className="font-bold">
              {getTranslation("single_file_browser_support_title")}
            </span>
            : {getTranslation("single_file_browser_support_desc")}
          </li>
        </ul>
        <p className="text-xs  bg-gray-200  p-2 rounded-md italic">
          {getTranslation("single_file_download_time_notice")}
        </p>
      </div>
    </StaticCard>
  );
}
