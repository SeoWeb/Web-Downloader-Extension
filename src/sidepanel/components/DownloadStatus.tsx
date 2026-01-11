import { Button } from "../../components/Button";
import { MessageAction, messageActions } from "../../common/message";
import { ScrollingResponse } from "../hooks/useScrapingDownloader";
import { useTranslation } from "react-i18next";
import { sendMessage } from "../../common/chrome";

interface DownloadStatusProps {
  tabId: number;
  isScraping: boolean;
  isScrapingLinkedPages: boolean;
  isPaused: boolean;
  action: MessageAction | null;
  downloadResponse: ScrollingResponse | null;
  setIsScraping: (value: boolean) => void;
  setIsPaused: (value: boolean) => void;
}

export function DownloadStatus({
  tabId,
  isScraping,
  isScrapingLinkedPages,
  isPaused,
  action,
  downloadResponse,
  setIsScraping,
  setIsPaused,
}: DownloadStatusProps) {
  const { t } = useTranslation();

  if (!tabId) return null;

  // Show buttons during any scraping activity (main page or linked pages)
  if (isScraping || isScrapingLinkedPages) {
    const handlePause = async () => {
      setIsPaused(true); // Update UI immediately
      await sendMessage("background", { action: messageActions.SCRAPER_PAUSE, data: {} });
    };

    const handleResume = async () => {
      setIsPaused(false); // Update UI immediately
      await sendMessage("background", { action: messageActions.SCRAPER_RESUME, data: {} });
    };

    const handleStop = async () => {
      await sendMessage("background", { action: messageActions.SCRAPER_STOP, data: {} });
      setIsScraping(false);
    };

    return (
      <div className="pt-8">
        <h3 className="pb-2 font-bold">{t('status.scraping')}</h3>
        <div className="flex gap-2">
          {isPaused ? (
            <Button onClick={handleResume} variant={"secondary"}>
              {t('actions.resume')}
            </Button>
          ) : (
            <Button onClick={handlePause} variant={"secondary"}>
              {t('actions.pause')}
            </Button>
          )}
          <Button onClick={handleStop} variant={"secondary"}>
            {t('actions.stop')}
          </Button>
        </div>
      </div>
    );
  }

  // Show "Downloading website content..." when download is in progress but not scraping
  // Hide this component when download is complete (DOWNLOAD_DONE)
  if (
    !isScraping &&
    !isScrapingLinkedPages &&
    action !== messageActions.DOWNLOAD_DONE &&
    !!downloadResponse?.html
  ) {
    return (
      <div className="pt-8">
        <h3 className="pb-2 font-bold">{t('status.downloadingWebsiteContent')}</h3>
      </div>
    );
  }

  // Hide component when download is complete
  if (action === messageActions.DOWNLOAD_DONE) {
    return null;
  }

  // Hide component if no scraping and no download response
  if (
    !isScraping &&
    action !== messageActions.DOWNLOAD_DONE &&
    !downloadResponse?.html
  ) {
    return null;
  }

  return null;
}
