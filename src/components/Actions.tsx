export default function Actions({ messages }: { messages: string[] }) {
  return (
    <div className="pt-8">
      <div className="pb-2 font-bold">Actions:</div>
      <div className="border p-2 text-neutral-600 bg-neutral-100 max-h-32 overflow-auto">
        {messages.map((message, index) => (
          <div key={index}>{message}</div>
        ))}
      </div>
    </div>
  );
}
