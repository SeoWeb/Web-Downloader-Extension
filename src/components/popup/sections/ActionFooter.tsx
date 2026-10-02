// src/components/popup/sections/ActionFooter.tsx
import { Button } from "../../ui/button";
import { Settings, Download } from "lucide-react";
import { useDownloadSettingsStore } from "../../../store/downloadSettingsStore";
import PrimaryButton from "../../ui/PrimaryButton";
import ScrollModeSwitch from "../../ui/ScrollModeSwitch";
import { openSidePanel } from "../../../background/messageActions/openSidePanel";
import closePopup from "../../../common/chrome/closePopup";
import useSendPortMessage from "../../../hooks/useSendPortMessage";
import {
  MESSAGE_SIDEPANEL,
  MESSAGE_START_DOWNLOAD,
} from "../../../types/message";
import { useLanguageStore } from "../../../store/languageStore";

interface ActionFooterProps {
  isDownloadDisabled?: boolean;
}

export default function ActionFooter({
  isDownloadDisabled = false,
}: ActionFooterProps) {
  const {
    activeTabId,
    downloadMode,
    isSidePanelOpen,
    scrollMode,
    setIsSidePanelOpen,
    setScrollMode,
  } = useDownloadSettingsStore();
  const { sendPortMessage } = useSendPortMessage("popup");
  const { direction, getTranslation } = useLanguageStore();

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
    groupId: 0,
  };

  const handleClick = () => {
    if (!activeTabId) {
      return;
    }

    // setIsDownloading(true);
    openSidePanel(tab).then(async () => {
      setIsSidePanelOpen(true);
      await sendPortMessage(MESSAGE_START_DOWNLOAD, MESSAGE_SIDEPANEL);
      await closePopup();
    });
  };

  return (
    <div className="sticky bottom-0 bg-white border-t border-slate-200 py-2 px-2">
      <div
        className={`flex items-center justify-between ${direction === "rtl" ? "flex-row-reverse" : ""}`}
      >
        <div
          className={`flex items-center gap-2 ${direction === "rtl" ? "flex-row-reverse" : ""}`}
        >
          <Button
            variant="outline"
            size="sm"
            className="text-slate-600 border-slate-300 hover:bg-slate-50"
          >
            <Settings className="h-4 w-4" /> {getTranslation("button_options")}
          </Button>
        </div>
        <div
          className={`flex items-center gap-2 ${direction === "rtl" ? "flex-row-reverse" : ""}`}
        >
          <ScrollModeSwitch
            scrollMode={scrollMode}
            onCheckedChange={(checked) => {
              setScrollMode(checked ? "auto" : "manual");
            }}
            autoModeText={getTranslation("text_auto_mode")}
            manualModeText={getTranslation("text_manual_mode")}
            tooltipText={getTranslation("tooltip_toggle_scroll_mode")}
            direction={direction}
          />
          <PrimaryButton
            disabled={isDownloadDisabled || !activeTabId || isSidePanelOpen}
            onClick={handleClick}
          >
            <Download className="h-5 w-5" />
            {downloadMode === "single"
              ? getTranslation("button_download_page")
              : downloadMode === "single_file"
                ? getTranslation("button_download_single_file")
                : getTranslation("button_download_website")}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
