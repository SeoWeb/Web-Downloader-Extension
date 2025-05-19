import { useLanguageStore } from "../../../store/languageStore";
import StaticCard from "../../ui/StaticCard";
import { ContentFilteringCardProps } from "./content-filtering/types";
import { FileStack, Construction } from "lucide-react";

export default function WebsiteCard({
  onNext,
  onBack,
  isFirst,
  isLast,
  containerClassName,
}: ContentFilteringCardProps) {
    const { direction, getTranslation } = useLanguageStore();
      
    return (
        <StaticCard
      title={getTranslation("filtering_title")}
      icon={<FileStack className="h-4 w-4" />}
      onNext={onNext}
      onBack={onBack}
      isFirst={isFirst}
      isLast={isLast}
      containerClassName={containerClassName}
    >
      <div className={`flex flex-col items-center justify-center p-6 space-y-3 ${direction === "rtl" ? "text-right" : "text-center"}`}>
        <Construction className="h-12 w-12 text-blue-500" />
        <h3 className="text-xl font-semibold">
          {getTranslation("full_web_page_download_title_v2_coming_soon")}
        </h3>
        <p className="text-md text-gray-600">
          {getTranslation("full_web_page_download_subtitle_v2_next_version")}
        </p>
      </div>
    </StaticCard>
    );
};