import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "./LanguageSwitcher";

export default function Heading() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col justify-center items-center py-6 animate-slide-up">
      <div className="mb-2 flex flex-row justify-between w-full">
        <div className="relative group cursor-default">
          <div className="absolute -inset-1 bg-gradient-to-r from-brand to-purple-600 rounded-full blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
          <div className="relative bg-white rounded-2xl p-1 shadow-sm border border-slate-100">
            <img
              src="/icons/32x32.png"
              alt={t('app.iconAlt')}
              className="size-8 transform transition-transform group-hover:scale-110 duration-300"
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
