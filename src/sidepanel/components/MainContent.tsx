import React from "react";
import { MessageAction, messageActions } from "../../common/message";
import { useTranslation } from "react-i18next";
import Heading from "../../components/Heading";
import Actions, { Message } from "../../components/Actions";

import { ScrollingResponse } from "../hooks/useScrapingDownloader";
import { ErrorBoundary } from "../../components/ErrorBoundary";

const Filter = React.lazy(() => import("../../components/Filter"));

interface MainContentProps {
  messages: Message[];
  tabId: number;
  isScraping: boolean;
  isScrapingLinkedPages: boolean;
  action: MessageAction | null;
  downloadResponse: ScrollingResponse | null;
  onClickStartDownload: (options: any) => void;
  tabUrl: string;
}

export function MainContent({
  messages,
  tabId,
  isScraping,
  isScrapingLinkedPages,
  action,
  downloadResponse,
  onClickStartDownload,
  tabUrl,
}: MainContentProps) {
  const { t } = useTranslation();
  return (
    <>
      <Heading />

      {action !== messageActions.DOWNLOAD_DONE && (
        <Actions messages={messages} />
      )}

      {!!tabId &&
        !isScraping &&
        !isScrapingLinkedPages &&
        !downloadResponse && (
          <div className="pt-4">
            <ErrorBoundary name="Filter">
              <React.Suspense fallback={<div className="p-4">{t('filter.loading')}</div>}>
                <Filter
                  download={onClickStartDownload}
                  tabUrl={tabUrl}
                />
              </React.Suspense>
            </ErrorBoundary>
          </div>
        )}
    </>
  );
}
