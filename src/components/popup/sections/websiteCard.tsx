import { useLanguageStore } from "../../../store/languageStore";
import StaticCard from "../../ui/StaticCard";
import { ContentFilteringCardProps } from "./content-filtering/types";
import { FileStack } from "lucide-react";

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
    >website</StaticCard>
    );
};