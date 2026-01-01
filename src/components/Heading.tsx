import { useTranslation } from "react-i18next";

export default function Heading() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col justify-start items-center">
      <h1 className="text-2xl text-black flex gap-2 items-center">
        <img
          src="/icons/32x32.png"
          alt={t('app.iconAlt')}
          className="size-8"
        />
        {t('app.title')}
      </h1>
    </div>
  );
}
