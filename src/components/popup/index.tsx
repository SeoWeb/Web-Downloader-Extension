// src/components/popup/index.tsx
import { useState } from "react";
import LeftMenu from "./sections/LeftMenu";
import Header from "./sections/Header";
import DownloadConfigCard from "./sections/DownloadConfigCard";
import ContentFilteringCard from "./sections/ContentFilteringCard";
import PreviewCard from "./sections/PreviewCard";
import ActionFooter from "./sections/ActionFooter";

type DownloadMode = "single" | "website";

// Define the card components in order
// We need to wrap them or modify them to accept navigation props
// Let's assume for now we will modify the individual card components later
const cardComponents = [
  ContentFilteringCard,
  PreviewCard,
  DownloadConfigCard,
];


export default function Popup() {
  const [downloadMode, setDownloadMode] = useState<DownloadMode>("single");
  const [activeCardIndex, setActiveCardIndex] = useState(0); // State for active card index

  const handleNext = () => {
    setActiveCardIndex((prevIndex) => Math.min(prevIndex + 1, cardComponents.length - 1));
  };

  const handleBack = () => {
    setActiveCardIndex((prevIndex) => Math.max(prevIndex - 1, 0));
  };

  // Get the component constructor for the active card
  const ActiveCardComponent = cardComponents[activeCardIndex];
  const isFirstCard = activeCardIndex === 0;
  const isLastCard = activeCardIndex === cardComponents.length - 1;

  return (
    <div className="w-full h-full bg-gradient-to-br from-slate-50 to-slate-100 overflow-y-auto flex">
      <LeftMenu downloadMode={downloadMode} setDownloadMode={setDownloadMode} />

      <div className="flex-grow ml-56 flex flex-col h-full">
        <Header />
        <div className="p-2 flex-grow flex flex-col"> {/* Use flex-col to allow card to grow */}
          {/* Render the active card component */}
          <ActiveCardComponent
            downloadMode={downloadMode} // Pass existing props
            // Pass navigation props - these need to be handled by the individual card components
            onNext={handleNext}
            onBack={handleBack}
            isFirst={isFirstCard}
            isLast={isLastCard}
            key={activeCardIndex} // Add key for proper re-rendering
            // Ensure the card container takes available space
            // Pass containerClassName down if the component accepts it
            // containerClassName="flex-grow" // This should be applied within the component if needed
          />
        </div>

        {/* Pass isLastCard status to ActionFooter */}
        <ActionFooter downloadMode={downloadMode} isDownloadDisabled={!isLastCard} />
      </div>
    </div>
  );
}
