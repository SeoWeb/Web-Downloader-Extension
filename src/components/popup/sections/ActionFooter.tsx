// src/components/popup/sections/ActionFooter.tsx
import { Button } from "../../ui/button";
import { Settings, Download } from "lucide-react";
import { useDownloadSettingsStore } from "../../../store/downloadSettingsStore";
import PrimaryButton from "../../ui/PrimaryButton";
import { openSidePanel } from "../../../background/messageActions/openSidePanel";
import closePopup from "../../../common/chrome/closePopup";
import useSendPortMessage from "../../../hooks/useSendPortMessage";
import { MESSAGE_SIDEPANEL, MESSAGE_START_DOWNLOAD } from "../../../types/message";

interface ActionFooterProps {
  isDownloadDisabled?: boolean;
}

export default function ActionFooter({
  isDownloadDisabled = false,
}: ActionFooterProps) {
  const { activeTabId, downloadMode } = useDownloadSettingsStore();
  // const { setIsDownloading } = useDownloadStatusStore();
  const { sendPortMessage } = useSendPortMessage('popup');

  const tab: chrome.tabs.Tab = {
    id: activeTabId || undefined,
    index: 0,
    pinned: false,
    highlighted: false,
    windowId: 0,
    active: true,
    frozen: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: false,
    groupId: 0
  }

  const handleClick = () => {
    if (!activeTabId) {
      return;
    }

    // setIsDownloading(true);
    openSidePanel(tab).then(async () => {
      await sendPortMessage(MESSAGE_START_DOWNLOAD, MESSAGE_SIDEPANEL);
      await closePopup();
    });
  };

  return (
    <div className="sticky bottom-0 bg-white border-t border-slate-200 py-2 px-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button
            variant="outline"
            size="sm"
            className="text-slate-600 border-slate-300 hover:bg-slate-50"
          >
            <Settings className="mr-1 h-4 w-4" /> Options
          </Button>
        </div>
        <PrimaryButton disabled={isDownloadDisabled || !activeTabId} onClick={handleClick}>
          <Download className="h-5 w-5 mr-2" />
          {downloadMode === "single" ? "Download Page" : "Download Website"}
        </PrimaryButton>
      </div>
    </div>
  );
}