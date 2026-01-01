import { Button } from "../../components/Button";
import { MessageAction, messageActions } from "../../common/message";
import { ScrollingResponse } from "../hooks/useScrapingDownloader";
import { useTranslation } from "react-i18next";

interface DownloadStatusProps {
  tabId: number;
  isScraping: boolean;
  action: MessageAction | null;
  downloadResponse: ScrollingResponse | null;
  setIsScraping: (value: boolean) => void;
}

export function DownloadStatus({
  tabId,
  isScraping,
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
    return (
      <div className="pt-8">
        <h3 className="pb-2 font-bold">{t('status.scraping')}</h3>
        <Button onClick={() => setIsScraping(false)} variant={"secondary"}>
          {t('actions.stop')}
        </Button>
      </div>
    );
  }

  return null;
}
