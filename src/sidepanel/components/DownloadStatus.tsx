import { Button } from "../../components/Button";
import { MessageAction, messageActions } from "../../common/message";
import { ScrollingResponse } from "../hooks/useScrapingDownloader";
import { useTranslation } from "react-i18next";
import { sendMessage } from "../../common/chrome";

interface DownloadStatusProps {
  tabId: number;
  isScraping: boolean;
  isPaused: boolean;
  action: MessageAction | null;
  downloadResponse: ScrollingResponse | null;
  setIsScraping: (value: boolean) => void;
}

export function DownloadStatus({
  tabId,
  isScraping,
  isPaused,
  action,
  downloadResponse,
  setIsScraping,
}: DownloadStatusProps) {
  const { t } = useTranslation();

  if (!tabId) return null;

  if (
    !isScraping &&
    action !== messageActions.DOWNLOAD_DONE &&
    !downloadResponse?.html
  ) {
    return null;
  }

  if (
    !isScraping &&
    action !== messageActions.DOWNLOAD_DONE &&
    !!downloadResponse?.html
  ) {
    return (
      <div className="pt-8">
        <h3 className="pb-2 font-bold">{t('status.downloadingWebsiteContent')}</h3>
      </div>
    );
  }

  if (isScraping) {
    const handlePause = async () => {
      await sendMessage("background", { action: messageActions.SCRAPER_PAUSE, data: {} });
    };

    const handleResume = async () => {
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
              {t('actions.resume') || "Resume"}
            </Button>
          ) : (
            <Button onClick={handlePause} variant={"secondary"}>
              {t('actions.pause') || "Pause"}
            </Button>
          )}
          <Button onClick={handleStop} variant={"secondary"}>
            {t('actions.stop')}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
