// src/components/popup/index.tsx
import { useState } from "react";
import LeftMenu from "./sections/LeftMenu";
import Header from "./sections/Header";
import PermissionsCard from "./sections/PermissionsCard";
import DownloadConfigCard from "./sections/DownloadConfigCard";
import ContentFilteringCard from "./sections/ContentFilteringCard";
import PreviewCard from "./sections/PreviewCard";
import ActionFooter from "./sections/ActionFooter";

const cardComponents = [
  PermissionsCard,
  ContentFilteringCard,
  PreviewCard,
  DownloadConfigCard,
];

export default function Popup() {
  const [activeCardIndex, setActiveCardIndex] = useState(0);

  const handleNext = () => {
    setActiveCardIndex((prevIndex) => Math.min(prevIndex + 1, cardComponents.length - 1));
  };

  const handleBack = () => {
    setActiveCardIndex((prevIndex) => Math.max(prevIndex - 1, 0));
  };

  const ActiveCardComponent = cardComponents[activeCardIndex];
  const isFirstCard = activeCardIndex === 0;
  const isLastCard = activeCardIndex === cardComponents.length - 1;

  return (
    <div className="w-full h-full bg-gradient-to-br from-slate-50 to-slate-100 overflow-y-auto flex">
      <LeftMenu /> 

      <div className="flex-grow ml-56 flex flex-col h-full">
        <Header />
        <div className="p-2 flex-grow flex flex-col">
          <ActiveCardComponent
            onNext={handleNext}
            onBack={handleBack}
            isFirst={isFirstCard}
            isLast={isLastCard}
            key={activeCardIndex}
          />
        </div>
        <ActionFooter isDownloadDisabled={!isLastCard} />
      </div>
    </div>
  );
}
