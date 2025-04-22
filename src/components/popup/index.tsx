// src/components/popup/index.tsx
import { useState } from "react";
import LeftMenu from "./sections/LeftMenu";
import Header from "./sections/Header";
import DownloadConfigCard from "./sections/DownloadConfigCard";
import ContentFilteringCard from "./sections/ContentFilteringCard";
import PreviewCard from "./sections/PreviewCard";
import ActionFooter from "./sections/ActionFooter";

type DownloadMode = "single" | "website";
type AccordionName = "download" | "filtering" | "preview";

export default function Popup() {
  const [downloadMode, setDownloadMode] = useState<DownloadMode>("single");
  const [openAccordion, setOpenAccordion] = useState<AccordionName | null>("filtering");

  const toggleAccordion = (accordion: AccordionName) => {
    setOpenAccordion(accordion === openAccordion ? null : accordion);
  };

  return (
    <div className="w-full h-full bg-gradient-to-br from-slate-50 to-slate-100 overflow-y-auto flex">
      <LeftMenu downloadMode={downloadMode} setDownloadMode={setDownloadMode} />

      {/* Make this container a full-height flex column */}
      <div className="flex-grow ml-56 flex flex-col h-full">
        <Header />
        {/* Allow this content area to grow and push the footer down */}
        <div className="p-6 space-y-4 flex-grow">
          <ContentFilteringCard
            downloadMode={downloadMode}
            isOpen={openAccordion === "filtering"}
            toggleAccordion={toggleAccordion}
          />

          <PreviewCard
            isOpen={openAccordion === "preview"}
            toggleAccordion={toggleAccordion}
          />

          <DownloadConfigCard
            downloadMode={downloadMode}
            isOpen={openAccordion === "download"}
            toggleAccordion={toggleAccordion}
          />
        </div>

        <ActionFooter downloadMode={downloadMode} />
      </div>
    </div>
  );
}
