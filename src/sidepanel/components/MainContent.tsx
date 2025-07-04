import React from "react";
import { MessageAction, messageActions } from "../../common/message";
import Heading from "../../components/Heading";
import Actions from "../../components/Actions";
import { FeatureRequestButton } from "../../components/FeatureRequestButton";
import { ScrollingResponse } from "../hooks/useScrapingDownloader";

const Filter = React.lazy(() => import("../../components/Filter"));

interface MainContentProps {
  messages: string[];
  tabId: number;
  isScraping: boolean;
  action: MessageAction | null;
  downloadResponse: ScrollingResponse | null;
  onClickStartDownload: (options: any) => void;
}

export function MainContent({
  messages,
  tabId,
  isScraping,
  action,
  downloadResponse,
  onClickStartDownload,
}: MainContentProps) {
  return (
    <>
      <Heading />
      <FeatureRequestButton />
      <Actions messages={messages} />

      {!!tabId &&
        !isScraping &&
        action !== messageActions.DOWNLOAD_DONE &&
        !downloadResponse?.html && (
          <div className="pt-8">
            <React.Suspense>
              <Filter download={onClickStartDownload} />
            </React.Suspense>
          </div>
        )}
      
    </>
  );
}