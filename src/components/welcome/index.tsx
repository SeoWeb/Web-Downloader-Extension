import { useTranslation } from "react-i18next";
import {
  Cloud,
  Download,
  Globe,
  Layers,
  MousePointerClick,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";

/**
 * First-run welcome page (task 5.7 / extension-onboarding spec).
 *
 * Explains what the extension does, walks through the 3-step download flow
 * and directs the user to the side panel. Fully localized via en.json
 * (`welcome.*`); opened by the background install listener (task 4.8).
 */

function Step({
  index,
  icon,
  title,
  description,
}: {
  index: number;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <li className="flex items-start gap-4">
      <div className="relative flex-shrink-0">
        <div className="w-10 h-10 rounded-full bg-brand/10 text-brand flex items-center justify-center font-bold">
          {index}
        </div>
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-brand">{icon}</span>
          <h3 className="font-semibold text-slate-800">{title}</h3>
        </div>
        <p className="text-sm text-slate-500 mt-1 leading-relaxed">
          {description}
        </p>
      </div>
    </li>
  );
}

function Feature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
      <span className="text-brand flex-shrink-0">{icon}</span>
      <span className="text-sm text-slate-600">{text}</span>
    </div>
  );
}

export default function Welcome() {
  const { t } = useTranslation();

  const handleOpenPanel = async () => {
    try {
      // The welcome page is an extension page, so the sidePanel API is
      // available. Requires a user gesture (this click handler).
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id != null && chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ tabId: tab.id });
        window.close();
      }
    } catch {
      // API unavailable or refused — the hint below explains the manual way.
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white py-10 px-4">
      <div className="max-w-lg mx-auto space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex flex-col items-center text-center space-y-3">
          <img
            src="/icons/128x128.png"
            alt={t("app.iconAlt")}
            className="size-16"
          />
          <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-900 via-brand to-slate-800">
            {t("welcome.title")}
          </h1>
          <p className="text-slate-500 leading-relaxed">
            {t("welcome.subtitle")}
          </p>
        </div>

        {/* What the extension does */}
        <div className="card p-6 bg-white space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
            {t("welcome.featuresTitle")}
          </h2>
          <div className="space-y-2">
            <Feature
              icon={<Layers className="w-4 h-4" />}
              text={t("welcome.feature1")}
            />
            <Feature
              icon={<Cloud className="w-4 h-4" />}
              text={t("welcome.feature2")}
            />
            <Feature
              icon={<Globe className="w-4 h-4" />}
              text={t("welcome.feature3")}
            />
          </div>
        </div>

        {/* 3-step flow */}
        <div className="card p-6 bg-white">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-4">
            {t("welcome.stepsTitle")}
          </h2>
          <ol className="space-y-5">
            <Step
              index={1}
              icon={<MousePointerClick className="w-4 h-4" />}
              title={t("welcome.step1Title")}
              description={t("welcome.step1Description")}
            />
            <Step
              index={2}
              icon={<SlidersHorizontal className="w-4 h-4" />}
              title={t("welcome.step2Title")}
              description={t("welcome.step2Description")}
            />
            <Step
              index={3}
              icon={<Download className="w-4 h-4" />}
              title={t("welcome.step3Title")}
              description={t("welcome.step3Description")}
            />
          </ol>
        </div>

        {/* CTA */}
        <div className="card p-6 bg-gradient-to-br from-brand/5 to-white border-brand/20 space-y-3">
          <button
            onClick={handleOpenPanel}
            className="btn-primary w-full flex items-center justify-center gap-2 text-lg py-4 shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 transform hover:-translate-y-0.5 transition-all cursor-pointer"
          >
            <Settings2 className="w-5 h-5" />
            <span>{t("welcome.cta")}</span>
          </button>
          <p className="text-center text-xs text-slate-500">
            {t("welcome.ctaHint")}
          </p>
        </div>
      </div>
    </div>
  );
}
