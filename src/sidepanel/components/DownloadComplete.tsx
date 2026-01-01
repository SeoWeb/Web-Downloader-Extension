import React from "react";
// import { Button } from "../../components/Button";
import { MessageAction, messageActions } from "../../common/message";
import { useTranslation } from "react-i18next";

const ChromeExtensionRating = React.lazy(
  () => import("../../components/ChromeExtensionRating"),
);

interface DownloadCompleteProps {
  tabId: number;
  tabUrl: string;
  links: string[];
  action: MessageAction | null;
  reset: (newTabUrl: string) => void;
}

export function DownloadComplete({
  // tabId,
  // tabUrl,
  // links,
  action,
  // reset,
}: DownloadCompleteProps) {
  const { t } = useTranslation();

  if (action !== messageActions.DOWNLOAD_DONE) {
    return null;
  }

  return (
    <div className="pt-8">
      <div className="pb-2 font-bold">{t('status.completeTitle')}</div>
      <div className="pb-4">
        {t('status.zipLocation')}
      </div>
      <div className="pb-4">
        <h3 className="pb-4 font-bold">
          {t('rating.prompt')}
        </h3>
        <React.Suspense>
          <ChromeExtensionRating />
        </React.Suspense>
      </div>
      {/* <div className="pb-2 font-bold">Other links to download:</div>
      <div className="pb-2 flex flex-col gap-0 justify-start">
        {links
          .filter(
            (link) => !!link && link !== "" && link !== "/" && link !== "/#",
          )
          .map((link, index) => (
            <Button
              key={index}
              className="pb-2"
              variant="link"
              onClick={() => {
                const u = new URL(tabUrl);
                const baseUrl = u.origin + "/";
                const url = new URL(link, baseUrl);
                chrome.tabs.update(tabId, { url: url.href }, () => {
                  reset(url.href);
                });
              }}
            >
              {link}
            </Button>
          ))}
      </div> */}
    </div>
  );
}
