import React from "react";
// import { Button } from "../../components/Button";
import { MessageAction, messageActions } from "../../common/message";

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
  if (action !== messageActions.DOWNLOAD_DONE) {
    return null;
  }

  return (
    <div className="pt-8">
      <div className="pb-2 font-bold">Download is complete:</div>
      <div className="pb-4">
        You can find the zip file in your downloads folder
      </div>
      <div className="pb-4">
        <h3 className="pb-4 font-bold">
          If you were satisfied, please leave a positive review :)
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
