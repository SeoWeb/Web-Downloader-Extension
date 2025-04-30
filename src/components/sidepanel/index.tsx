import { useEffect } from "react";
import { useConnectListener } from "../../hooks/useConnectListener";
import { useDownloadStatusStore } from "../../store/downloadStatusStore";
import { MESSAGE_SCROLL_PAGE_DOWN, MESSAGE_SIDEPANEL } from "../../types/message";
import useSendPortMessage from "../../hooks/useSendPortMessage";
import PrimaryButton from "../ui/PrimaryButton";

export default function SidePanel() {
  useConnectListener(MESSAGE_SIDEPANEL);
  const { isDownloading, setIsDownloading } = useDownloadStatusStore();
  const { sendPortMessage } = useSendPortMessage(MESSAGE_SIDEPANEL);

  const handleStopButtonClick = () => {
    setIsDownloading(false);
  }

  useEffect(() => {
    if (isDownloading) {
      sendPortMessage(MESSAGE_SCROLL_PAGE_DOWN).then(() => {
        console.log('sidepanel scroll start');
      });
    }
  }, [isDownloading]);

  if (isDownloading) {
    return <div>
      <p>Downloading ...</p>
      <PrimaryButton onClick={handleStopButtonClick}>
        Stop
      </PrimaryButton>
    </div>
  }

  return <h1>Sidepanel</h1>;
}
