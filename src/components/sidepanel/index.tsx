import { useState, useEffect } from "react";
import { useConnectListener } from "../../hooks/useConnectListener";
import { useDownloadStatusStore } from "../../store/downloadStatusStore";
import {
  MESSAGE_SCROLL_PAGE_DOWN,
  MESSAGE_SIDEPANEL,
  MESSAGE_DOWNLOAD_DONE,
  MESSAGE_DOWNLOAD_ASSETS,
  MESSAGE_SIMULATE_DOWNLOAD_DONE, // Added for the new button
  AssetData
} from "../../types/message";
import useSendPortMessage from "../../hooks/useSendPortMessage";
import PrimaryButton from "../ui/PrimaryButton";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { useDownloadSettingsStore } from "../../store/downloadSettingsStore";

export default function SidePanel() {
  const [assetGroups, setAssetGroups] = useState<AssetData | null>(null);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);

  useConnectListener(MESSAGE_SIDEPANEL, (message) => {
    if (message.action === MESSAGE_DOWNLOAD_DONE && message.assets) {
      setAssetGroups(message.assets);
      setSelectedAssets([]); // Clear previous selections
    }
  });

  const { isDownloading, setIsDownloading } = useDownloadStatusStore();
  const { sendPortMessage } = useSendPortMessage(MESSAGE_SIDEPANEL);
  const { downloadMode, activeTabId } = useDownloadSettingsStore();

  // Helper Functions
  const getAllAssetUrls = (): string[] => {
    if (!assetGroups) return [];
    return Object.values(assetGroups).flat();
  };

  const isGroupSelected = (groupName: string): boolean | "indeterminate" => {
    if (!assetGroups || !assetGroups[groupName]) return false;
    const groupAssets = assetGroups[groupName];
    const selectedGroupAssets = groupAssets.filter(asset => selectedAssets.includes(asset));
    if (selectedGroupAssets.length === 0) return false;
    if (selectedGroupAssets.length === groupAssets.length) return true;
    return "indeterminate";
  };

  // Checkbox Event Handlers
  const handleGroupChange = (groupName: string, isChecked: boolean | "indeterminate") => {
    if (!assetGroups || !assetGroups[groupName]) return;
    const groupAssets = assetGroups[groupName];
    if (isChecked === true) {
      setSelectedAssets(prev => [...new Set([...prev, ...groupAssets])]);
    } else { // false or indeterminate, interpreted as deselect all for the group
      setSelectedAssets(prev => prev.filter(asset => !groupAssets.includes(asset)));
    }
  };

  const handleAssetChange = (assetUrl: string, isChecked: boolean | "indeterminate") => {
    if (isChecked === true) {
      setSelectedAssets(prev => [...new Set([...prev, assetUrl])]);
    } else {
      setSelectedAssets(prev => prev.filter(asset => asset !== assetUrl));
    }
  };

  // Button Click Handlers
  const handleSelectAllToggle = () => {
    const allAssetUrls = getAllAssetUrls();
    if (selectedAssets.length === allAssetUrls.length) {
      setSelectedAssets([]); // Deselect all
    } else {
      setSelectedAssets(allAssetUrls); // Select all
    }
  };

  const handleDownloadSelected = () => {
    if (selectedAssets.length > 0 && !isDownloading) {
      sendPortMessage(MESSAGE_DOWNLOAD_ASSETS, { assetUrls: selectedAssets });
      // Optionally: setIsDownloading(true); or wait for background status update
    }
  };

  const handleStopButtonClick = () => {
    setIsDownloading(false);
  }

  useEffect(() => {
    if (isDownloading && activeTabId && downloadMode) {
      if (downloadMode === 'single') {
        sendPortMessage(MESSAGE_SCROLL_PAGE_DOWN).then(() => {
          console.log('sidepanel scroll start');
        });
      } else if (downloadMode === 'single_file') {
        // TODO: not working, use scroll instead and then createMhtmlWithPuppeteer
        // chrome.pageCapture.saveAsMHTML(
        //   {
        //     tabId: activeTabId,
        //   },
        //   function (mhtmlBlob) {
        //     if (mhtmlBlob) {
        //       const url = URL.createObjectURL(mhtmlBlob);
        //       const a = document.createElement('a');
        //       a.href = url;
        //       a.download = 'page.mhtml';
        //       document.body.appendChild(a);
        //       a.click();
        //       document.body.removeChild(a);
        //       URL.revokeObjectURL(url);
        //     }
        //     setIsDownloading(false);
        //   }
        // )
      } else if (downloadMode === 'website') {
        //
      }
    }
  }, [isDownloading, downloadMode, activeTabId]);

  if (isDownloading) {
    return <div className="p-4">
      <p className="mb-2">Downloading ...</p>
      <PrimaryButton onClick={handleStopButtonClick}>
        Stop
      </PrimaryButton>
    </div>
  }

  if (!assetGroups) {
    return <div className="p-4"><h1>Sidepanel - No assets loaded yet.</h1></div>;
  }

  const totalAssetsCount = getAllAssetUrls().length;

  return (
    <div className="p-4 space-y-4">
      <div>
        <PrimaryButton onClick={handleSelectAllToggle} className="mb-2">
          {selectedAssets.length === totalAssetsCount && totalAssetsCount > 0 ? "Deselect All" : "Select All"}
        </PrimaryButton>
      </div>

      {Object.entries(assetGroups).map(([groupName, assets]) => (
        <div key={groupName} className="space-y-2 p-2 border rounded-md">
          <div className="flex items-center space-x-2">
            <Checkbox
              id={`group-${groupName}`}
              checked={isGroupSelected(groupName)}
              onCheckedChange={(checked) => handleGroupChange(groupName, checked)}
            />
            <Label htmlFor={`group-${groupName}`} className="font-semibold text-lg">{groupName} ({assets.length})</Label>
          </div>
          <div className="pl-6 space-y-1">
            {assets.map((assetUrl) => (
              <div key={assetUrl} className="flex items-center space-x-2">
                <Checkbox
                  id={assetUrl}
                  checked={selectedAssets.includes(assetUrl)}
                  onCheckedChange={(checked) => handleAssetChange(assetUrl, checked)}
                />
                {/* Using a span for asset URLs as they can be long and Label might have specific styling */}
                <span title={assetUrl} className="text-sm truncate" style={{maxWidth: '250px'}}>{assetUrl}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div>
        <PrimaryButton
          onClick={handleDownloadSelected}
          disabled={isDownloading || selectedAssets.length === 0}
        >
          Download Selected ({selectedAssets.length})
        </PrimaryButton>
      </div>
      {/* Existing h1 for Sidepanel, can be removed or integrated */}
      {/* <h1>Sidepanel</h1> */}

      {/* Temporary button for testing */}
      <div className="mt-4 border-t pt-4">
        <h3 className="text-lg font-semibold mb-2">Testing Utilities</h3>
        <PrimaryButton
          onClick={() => sendPortMessage(MESSAGE_SIMULATE_DOWNLOAD_DONE)}
          variant="outline" // Assuming PrimaryButton can take a variant or just using default
        >
          Simulate Download Done Event
        </PrimaryButton>
      </div>
    </div>
  );
}
