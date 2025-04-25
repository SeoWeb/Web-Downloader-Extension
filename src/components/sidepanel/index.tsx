import { useConnectListener } from "../../hooks/useConnectListener";
import { useDownloadStatusStore } from "../../store/downloadStatusStore";
import { MESSAGE_SIDEPANEL } from "../../types/message";

export default function SidePanel() {
  useConnectListener(MESSAGE_SIDEPANEL); // Add this line to use the hook
  const { isDownloading } = useDownloadStatusStore();

  if (isDownloading) {
    return <p>Downloading ...</p>
  }

  return <h1>Sidepanel</h1>;
}
