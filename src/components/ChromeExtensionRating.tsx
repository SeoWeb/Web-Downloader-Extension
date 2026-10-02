import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";

const ChromeExtensionRating = () => {
  const { t } = useTranslation();
  const handleStarClick = (rating: number) => {
    const supportUrl =
      "https://chromewebstore.google.com/detail/web-page-downloader/aeojmgngnebhbjpncamiplkimkbnmpmk/support";
    const reviewUrl =
      "https://chromewebstore.google.com/detail/web-page-downloader/aeojmgngnebhbjpncamiplkimkbnmpmk/reviews";

    // For ratings 1-3, open support page; for 4-5, open reviews page
    const url = rating <= 3 ? supportUrl : reviewUrl;
    window.open(url, "_blank");
  };

  return (
    <div className="flex items-center justify-center space-x-1">
      {[...Array(5)].map((_, index) => (
        <button
          key={index}
          onClick={() => handleStarClick(index + 1)}
          className="focus:outline-none transition-transform hover:scale-125 cursor-pointer"
          aria-label={t("rating.ariaLabel", { count: index + 1 })}
        >
          <Star className="w-8 h-8 text-yellow-400 fill-current" />
        </button>
      ))}
    </div>
  );
};

export default ChromeExtensionRating;
