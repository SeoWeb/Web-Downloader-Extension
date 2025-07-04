import { Button } from './Button';

export function FeatureRequestButton() {
  const openFeatureRequestPage = () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL('featureRequest.html')
    });
  };

  return (
    <div className="mt-4 pt-4 border-t border-gray-200">
      <Button 
        variant="outline" 
        onClick={openFeatureRequestPage}
        className="w-full flex items-center justify-center space-x-2"
      >
        <span>💡</span>
        <span>Request Feature</span>
      </Button>
    </div>
  );
}