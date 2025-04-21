import { Button } from "../../components/Button";
import { MessageAction, messageActions } from "../../common/message";
import { ScrollingResponse } from "../hooks/useScrapingDownloader";

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
  if (!tabId) return null;

  if (!isScraping && action !== messageActions.DOWNLOAD_DONE && !downloadResponse?.html) {
    return null;
  }

  if (!isScraping && action !== messageActions.DOWNLOAD_DONE && !!downloadResponse?.html) {
    return (
      <div className="pt-8">
        <h3 className="pb-2 font-bold">Downloading website content ...</h3>
      </div>
    );
  }

  if (isScraping) {
    return (
      <div className="pt-8">
        <h3 className="pb-2 font-bold">Scraping...</h3>
        <Button onClick={() => setIsScraping(false)} variant={"secondary"}>
          Stop
        </Button>
      </div>
    );
  }

  return null;
}