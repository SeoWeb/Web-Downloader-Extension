import { useMessageListener } from "../../hooks/useMessageListener";
import { useDownloadStatusStore } from "../../store/downloadStatusStore";

export default function SidePanel() {
  useMessageListener('sidepanel'); // Add this line to use the hook
  const { isDownloading } = useDownloadStatusStore();

  if (isDownloading) {
    return <p>Downloading ...</p>
  }

  return <h1>Sidepanel</h1>;
}
