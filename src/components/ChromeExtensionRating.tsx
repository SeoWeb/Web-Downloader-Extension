import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";

const ChromeExtensionRating = () => {
  const { t } = useTranslation();
  const handleStarClick = () => {
    const reviewUrl =
      "https://chromewebstore.google.com/detail/web-page-downloader/aeojmgngnebhbjpncamiplkimkbnmpmk/reviews";
    window.open(reviewUrl, "_blank");
  };

  return (
    <div className="flex items-center justify-center space-x-1">
      {[...Array(5)].map((_, index) => (
        <button
          key={index}
          onClick={handleStarClick}
          className="focus:outline-none transition-transform hover:scale-125"
          aria-label={t('rating.ariaLabel', { count: index + 1 })}
        >
          <Star className="w-8 h-8 text-yellow-400 fill-current" />
        </button>
      ))}
    </div>
  );
};

export default ChromeExtensionRating;
