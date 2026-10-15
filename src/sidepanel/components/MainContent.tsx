import React from "react";
import { MessageAction, messageActions } from "../../common/message";
import { useTranslation } from "react-i18next";
import Heading from "../../components/Heading";
import Actions, { Message } from "../../components/Actions";

import { ScrollingResponse } from "../hooks/useScrapingDownloader";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { PagePocketAuth } from "../../components/PagePocketAuth";
import { UnsupportedPage } from "./UnsupportedPage";

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
  showAuthForm?: boolean;
  /** (5.1) False when the active tab cannot be downloaded — hides the form. */
  tabSupported?: boolean;
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
  showAuthForm,
  tabSupported = true,
}: MainContentProps) {
  const { t } = useTranslation();
  return (
    <>
      <Heading />

      {/* (5.1) Hide the step list when the active tab is unsupported —
          the unsupported card replaces the connection status. */}
      {action !== messageActions.DOWNLOAD_DONE &&
        !(!!tabId && !tabSupported) && <Actions messages={messages} />}

      {!!tabId &&
        !isScraping &&
        !isScrapingLinkedPages &&
        !downloadResponse && (
          <div className="pt-4">
            {showAuthForm ? (
              <ErrorBoundary name="PagePocketAuth">
                <PagePocketAuth />
              </ErrorBoundary>
            ) : !tabSupported ? (
              // (5.1) Unsupported page — friendly state instead of the form.
              <UnsupportedPage />
            ) : (
              <ErrorBoundary name="Filter">
                <React.Suspense
                  fallback={<div className="p-4">{t("filter.loading")}</div>}
                >
                  <Filter download={onClickStartDownload} tabUrl={tabUrl} />
                </React.Suspense>
              </ErrorBoundary>
            )}
          </div>
        )}
    </>
  );
}
