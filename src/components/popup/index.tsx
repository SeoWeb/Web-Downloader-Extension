// src/components/popup/index.tsx
import { useEffect, useState } from "react";
import LeftMenu from "./sections/LeftMenu";
import Header from "./sections/Header";
import PermissionsCard from "./sections/PermissionsCard";
// import DownloadConfigCard from "./sections/DownloadConfigCard";
import ContentFilteringCard from "./sections/ContentFilteringCard";
// import PreviewCard from "./sections/PreviewCard";
import ActionFooter from "./sections/ActionFooter";
import { getActiveTab } from "../../common/chrome";
import { useDownloadSettingsStore } from "../../store/downloadSettingsStore";
import { useDownloadStatusStore } from "../../store/downloadStatusStore";
import { useMessageListener } from "../../hooks/useMessageListener";

const cardComponents = [
  ContentFilteringCard,
  // PreviewCard,
  // DownloadConfigCard
];

export default function Popup() {
  useMessageListener('popup'); // Add this line to use the hook
  const [activeCardIndex, setActiveCardIndex] = useState(0);
  const [hasPermissions, setHasPermissions] = useState<boolean>(false);
  const { activeTabId, setActiveTabId } = useDownloadSettingsStore();
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
      if (tab?.id) {
        setActiveTabId(tab.id);
      }
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
    <div className="w-full h-full bg-gradient-to-br from-slate-50 to-slate-100 overflow-y-auto flex">
      <LeftMenu />

      <div className="flex-grow ml-56 flex flex-col h-full">
        <Header />
        <div className="p-2 flex-grow flex flex-col">{children}</div>
        <ActionFooter isDownloadDisabled={!isLastCard} />
      </div>
    </div>
  );

  if (!activeTabId) {
    return renderLayout(<p>Loading ...</p>);
  }

  if (!hasPermissions) {
    return renderLayout(renderPermissonsCard());
  }

  if (isDownloading) {
    return renderLayout(<p>Downloading ...</p>);
  }

  return renderLayout(renderActiveCarcComponent());
}
