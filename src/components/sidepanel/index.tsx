import { useEffect } from "react";
import { useConnectListener } from "../../hooks/useConnectListener";
import { useDownloadStatusStore } from "../../store/downloadStatusStore";
import { MESSAGE_SCROLL_PAGE_DOWN, MESSAGE_SIDEPANEL } from "../../types/message";
import useSendPortMessage from "../../hooks/useSendPortMessage";
import PrimaryButton from "../ui/PrimaryButton";
import { useDownloadSettingsStore } from "../../store/downloadSettingsStore";

export default function SidePanel() {
  useConnectListener(MESSAGE_SIDEPANEL);
  const { isDownloading, setIsDownloading } = useDownloadStatusStore();
  const { sendPortMessage } = useSendPortMessage(MESSAGE_SIDEPANEL);
  const { downloadMode, activeTabId } = useDownloadSettingsStore();

  const handleStopButtonClick = () => {
    setIsDownloading(false);
  }

  useEffect(() => {
    if (isDownloading && activeTabId && downloadMode) {
      if (downloadMode === 'single') {
        sendPortMessage(MESSAGE_SCROLL_PAGE_DOWN).then(() => {
          console.log('sidepanel scroll start');
        });
      } else if (downloadMode === 'single_file') {
        // TODO: not working, use scroll instead and then createMhtmlWithPuppeteer
        // chrome.pageCapture.saveAsMHTML(
        //   {
        //     tabId: activeTabId,
        //   },
        //   function (mhtmlBlob) {
        //     if (mhtmlBlob) {
        //       const url = URL.createObjectURL(mhtmlBlob);
        //       const a = document.createElement('a');
        //       a.href = url;
        //       a.download = 'page.mhtml';
        //       document.body.appendChild(a);
        //       a.click();
        //       document.body.removeChild(a);
        //       URL.revokeObjectURL(url);
        //     }
        //     setIsDownloading(false);
        //   }
        // )
      } else if (downloadMode === 'website') {
        //
      }
    }
  }, [isDownloading, downloadMode, activeTabId]);

  if (isDownloading) {
    return <div>
      <p>Downloading ...</p>
      <PrimaryButton onClick={handleStopButtonClick}>
        Stop
      </PrimaryButton>
    </div>
  }

  // HTML lehe laadimise staatus - see ei ole veel allalaadimine va kui tegemist ei ole ainult html allaadimisega
  // Laaditavad failid koos staatuse ja tühistamisnupuga
  // Kui automaatrežiim on välja lülitatud, saab kasutaja valida milliseid failid alla laadida
  // Grpud - lehed, documendid, scriptid jne

  // TODO: mhtml
  // chrome.pageCapture.saveAsMHTML(
  //   details: object,
  //   callback?: function,
  // )

  return <h1>Sidepanel</h1>;
}
