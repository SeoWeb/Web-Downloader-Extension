import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "./LanguageSwitcher";

export default function Heading() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col justify-center items-center animate-slide-up">
      <div className="mb-2 flex flex-row justify-between w-full">
        <div className="relative group cursor-default">
          <div className="relative">
            <img
              src="/icons/128x128.png"
              alt={t('app.iconAlt')}
              className="size-12"
            />
          </div>
        </div>
        <LanguageSwitcher />
      </div>
      <h1 className="mt-2 text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-900 via-brand to-slate-800">
        {t('app.title')}
      </h1>
    </div>
  );
}
