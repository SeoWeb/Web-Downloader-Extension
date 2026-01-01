import { useTranslation } from "react-i18next";

export type Message = string | { key: string; options?: any };

export default function Actions({ messages }: { messages: Message[] }) {
  const { t } = useTranslation();
  return (
    <div className="pt-8">
      <div className="pb-2 font-bold">{t('actions.title')}</div>
      <div className="border p-2 text-neutral-600 bg-neutral-100 max-h-32 overflow-auto">
        {messages.map((message, index) => (
          <div key={index}>
            {typeof message === 'string' 
              ? message 
              : t(message.key, message.options) as string}
          </div>
        ))}
      </div>
    </div>
  );
}
