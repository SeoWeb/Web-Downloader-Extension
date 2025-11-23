import React from "react";
import { MessageAction, messageActions } from "../../common/message";
import Heading from "../../components/Heading";
import Actions from "../../components/Actions";
// import { FeatureRequestButton } from "../../components/FeatureRequestButton";
import { ScrollingResponse } from "../hooks/useScrapingDownloader";
import { ErrorBoundary } from "../../components/ErrorBoundary";

const Filter = React.lazy(() => import("../../components/Filter"));

interface MainContentProps {
  messages: string[];
  tabId: number;
  isScraping: boolean;
  action: MessageAction | null;
  downloadResponse: ScrollingResponse | null;
  onClickStartDownload: (options: any) => void;
  userId: number | null;
  tabUrl: string;
}

export function MainContent({
  messages,
  tabId,
  isScraping,
  action,
  downloadResponse,
  onClickStartDownload,
  userId,
  tabUrl,
}: MainContentProps) {
  return (
    <>
      <Heading />
      {/* <FeatureRequestButton /> */}
      <Actions messages={messages} />

      {!!tabId &&
        !isScraping &&
        action !== messageActions.DOWNLOAD_DONE &&
        !downloadResponse?.html && (
          <div className="pt-8">
            <ErrorBoundary name="Filter">
              <React.Suspense fallback={<div className="p-4">Loading filters...</div>}>
                <Filter
                  download={onClickStartDownload}
                  userId={userId}
                  tabUrl={tabUrl}
                />
              </React.Suspense>
            </ErrorBoundary>
          </div>
        )}
    </>
  );
}
