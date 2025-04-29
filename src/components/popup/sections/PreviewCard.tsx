// src/components/popup/sections/PreviewCard.tsx
import { useEffect } from 'react'; // Added
import { Checkbox } from "../../ui/checkbox";
import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";
import { CheckSquare } from "lucide-react";
import StaticCard from "../../ui/StaticCard";
// import { sendMessage } from '../../../common/chrome/sendMessage'; // Added
import { Message, MESSAGE_SEND_SOCKET_MESSAGE } from '../../../types/message'; // Added - Assuming structure

// Define the props interface including navigation props
interface PreviewCardProps {
  onNext?: () => void;
  onBack?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  containerClassName?: string; // Add containerClassName
}

async function sendStringAsStream(dataString: string, chunkSize: number = 100) {
  for (let i = 0; i < dataString.length; i += chunkSize) {
    const chunk = dataString.substring(i, i + chunkSize);
    const message: Message = {
      action: MESSAGE_SEND_SOCKET_MESSAGE,
      target: 'background', // Send to the background script
      sender: 'popup',
      data: {
        action: 'submitHtml',
        data: chunk
      },
    };
    // socket.emit('stream-chunk', chunk);
    // Optional: Add a small delay to simulate a more continuous stream
    // await new Promise(resolve => setTimeout(resolve, 50));
  }
  const message: Message = {
    action: MESSAGE_SEND_SOCKET_MESSAGE,
    target: 'background', // Send to the background script
    sender: 'popup',
    data: {
      action: 'submitHtml',
      data: null
    },
  };
  // socket.emit('stream-end');
  console.log('String sent as stream!');
}

export default function PreviewCard({
  // Destructure the navigation props
  onNext,
  onBack,
  isFirst,
  isLast,
  containerClassName, // Destructure containerClassName
}: PreviewCardProps) {

  // Send sample HTML when the component mounts
  useEffect(() => {
    const sampleHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Sample Page</title>
</head>
<body>
  <h1>Hello from PreviewCard!</h1>
  <p>This is sample HTML content.</p>
</body>
</html>
    `.trim();

    sendStringAsStream(sampleHtml).then(() => {
      // done
    });
    // sendMessage(message).catch(console.error); // Send message to background script

    // TODO ! use port message

  }, []); // Empty dependency array ensures this runs only once on mount

  return (
    <StaticCard
      title="Files & Subpages to Download"
      icon={<CheckSquare className="h-4 w-4 mr-2" />}
      contentClassName="space-y-3"
      // Pass the navigation props down
      onNext={onNext}
      onBack={onBack}
      isFirst={isFirst}
      isLast={isLast}
      containerClassName={containerClassName} // Pass down containerClassName
    >
      {/* ... (rest of the component remains the same) */}
      <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg bg-slate-50">
        <ul className="divide-y divide-slate-200">
          {/* List items remain unchanged */}
          <li className="flex items-center p-3 hover:bg-slate-100 transition-colors">
            <Checkbox id="page1" className="mr-3 text-blue-600" />
            <Label htmlFor="page1" className="text-sm text-slate-700 cursor-pointer flex-1">
              index.html
            </Label>
            <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">HTML</span>
          </li>
          <li className="flex items-center p-3 hover:bg-slate-100 transition-colors">
            <Checkbox id="page2" className="mr-3 text-blue-600" />
            <Label htmlFor="page2" className="text-sm text-slate-700 cursor-pointer flex-1">
              /about
            </Label>
            <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">HTML</span>
          </li>
          <li className="flex items-center p-3 hover:bg-slate-100 transition-colors">
            <Checkbox id="style.css" className="mr-3 text-blue-600" />
            <Label htmlFor="style.css" className="text-sm text-slate-700 cursor-pointer flex-1">
              css/style.css
            </Label>
            <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full">CSS</span>
          </li>
        </ul>
      </div>
      <p className="text-xs text-slate-500">
        Select which files and pages to download.
      </p>

      <div className="pt-3 border-t border-slate-100">
        <div className="flex items-center justify-between bg-slate-50 p-3 rounded-lg">
          <div className="space-y-1">
            <Label
              htmlFor="autoAccept"
              className="text-sm font-medium text-slate-700"
            >
              Auto Accept New Pages
            </Label>
            <p className="text-xs text-slate-500">
              Automatically start downloading linked pages.
            </p>
          </div>
          <Switch id="autoAccept" defaultChecked className="text-blue-600" />
        </div>
      </div>
    </StaticCard>
  );
}