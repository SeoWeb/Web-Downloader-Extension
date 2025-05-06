// src/components/popup/index.tsx
import { useEffect, useState } from "react";
import LeftMenu from "./sections/LeftMenu";
import Header from "./sections/Header";
import PermissionsCard from "./sections/PermissionsCard";
// import DownloadConfigCard from "./sections/DownloadConfigCard";
import ContentFilteringCard from "./sections/ContentFilteringCard";
import ActionFooter from "./sections/ActionFooter";
import { getActiveTab } from "../../common/chrome";
import { useDownloadSettingsStore } from "../../store/downloadSettingsStore";
import { useDownloadStatusStore } from "../../store/downloadStatusStore";
import { useConnectListener } from "../../hooks/useConnectListener";
import { MESSAGE_POPUP } from "../../types/message";
import { useLanguageStore } from "../../store/languageStore";

const cardComponents = [
  ContentFilteringCard,
  // PreviewCard,
  // DownloadConfigCard
];

export default function Popup() {
  useConnectListener(MESSAGE_POPUP);
  const { direction, getTranslation } = useLanguageStore();
  const [activeCardIndex, setActiveCardIndex] = useState(0);
  const [hasPermissions, setHasPermissions] = useState<boolean>(false);
  const { activeTabId, isSidePanelOpen, setActiveTabId } = useDownloadSettingsStore();
  const { isDownloading } = useDownloadStatusStore();

  const handleNext = () => {
    setActiveCardIndex((prevIndex) =>
      Math.min(prevIndex + 1, cardComponents.length - 1),
    );
  };

  const handleBack = () => {
    setActiveCardIndex((prevIndex) => Math.max(prevIndex - 1, 0));
  };

  const ActiveCardComponent = cardComponents[activeCardIndex];
  const isFirstCard = activeCardIndex === 0;
  const isLastCard = activeCardIndex === cardComponents.length - 1;

  useEffect(() => {
    getActiveTab().then((tab) => {
      const url = tab?.url || null;
      const tabId = tab?.id && url && url.startsWith('https://') ? tab.id : null;
      setActiveTabId(tabId);
    });
  }, []);

  const renderPermissonsCard = () => (
    <PermissionsCard
      hasPermissions={hasPermissions}
      setHasPermissions={setHasPermissions}
    />
  );

  const renderActiveCarcComponent = () => (
    <ActiveCardComponent
      onNext={handleNext}
      onBack={handleBack}
      isFirst={isFirstCard}
      isLast={isLastCard}
      key={activeCardIndex}
    />
  );

  const renderLayout = (children: React.ReactNode) => (
    <div className={`w-full h-full bg-gradient-to-br from-slate-50 to-slate-100 overflow-y-auto flex ${direction === "rtl" ? "flex-row-reverse justify-start" : ""}`}>
      <LeftMenu />

      <div className={`flex-grow flex flex-col h-full ${direction === "rtl" ? "mr-56" : "ml-56"}`}>
        <Header />
        <div className="p-2 flex-grow flex flex-col">{children}</div>
        <ActionFooter isDownloadDisabled={!isLastCard} />
      </div>
    </div>
  );

  if (activeTabId === undefined) {
    return renderLayout(<p>{getTranslation('loading')}</p>);
  }

  if (activeTabId === null) {
    return renderLayout(<p>{getTranslation('not_downloadable')}</p>)
  }

  if (!hasPermissions) {
    return renderLayout(renderPermissonsCard());
  }

  if (isDownloading) {
    return renderLayout(<p>{getTranslation('downloading')}</p>);
  }

  if (isSidePanelOpen) {
    return renderLayout(<p>{getTranslation('close_sidepanel_message')}</p>);
  }

  return renderLayout(renderActiveCarcComponent());
}
