import { useState, useEffect } from "react";
import StaticCard from "../../ui/StaticCard"; // Import StaticCard correctly
import { AlertTriangle, CheckCircle, KeyRound } from "lucide-react"; // Add KeyRound icon
import PrimaryButton from "../../ui/PrimaryButton";

const REQUIRED_PERMISSIONS: chrome.permissions.Permissions = {
  permissions: ["activeTab", "scripting", "downloads", "storage"],
};

interface PermissionsCardProps {
  hasPermissions: boolean;
  setHasPermissions: (set: boolean) => void;
}

export default function PermissionsCard({ hasPermissions, setHasPermissions }: PermissionsCardProps){
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkAndProceed = async () => {
      try {
        const granted = await chrome.permissions.contains(REQUIRED_PERMISSIONS);
        setHasPermissions(granted);
        setError(null); // Clear previous errors
      } catch (err) {
        console.error("Error checking permissions:", err);
        setError("Failed to check permissions. Please try again.");
        setHasPermissions(false); // Assume no permissions on error
      }
    };
    checkAndProceed();
  }, []);

  const requestPermissions = async () => {
    setIsRequesting(true);
    setError(null);
    try {
      const granted = await chrome.permissions.request(REQUIRED_PERMISSIONS);
      setHasPermissions(granted);
      if (!granted) {
        setError("Permissions were not granted. Please grant permissions to continue.");
      }
    } catch (err) {
      console.error("Error requesting permissions:", err);
      setError("An error occurred while requesting permissions.");
      setHasPermissions(false);
    } finally {
      setIsRequesting(false);
    }
  };

  const renderContent = () => {
    if (error) {
        return (
            <div className="text-red-600 flex items-center space-x-2">
                <AlertTriangle size={18} />
                <span>{error}</span>
            </div>
        );
    }

    const renderPermissions = () => (
      <>
        <p className="text-sm text-slate-600 mb-2">This extension requires the following permissions to function correctly:</p>
        <ul className="list-disc list-inside space-y-1 text-sm text-slate-500 mb-4">
          <li><strong>activeTab:</strong> Access the content of the current tab.</li>
          <li><strong>scripting:</strong> Inject scripts into the current tab to analyze content.</li>
          <li><strong>downloads:</strong> Download the web page content.</li>
          <li><strong>storage:</strong> Store extension settings and download configurations locally.</li>
        </ul>
      </>
    );

    if (hasPermissions) {
      return (
        <div>
          <div className="flex items-center text-green-600 mb-4">
            <CheckCircle size={20} className="mr-2" />
            <p className="font-semibold">Permissions Granted!</p>
          </div>
          {renderPermissions()}
        </div>
      );
    }

    // Permissions not granted, show request UI
    return (
      <div>
        <div className="flex items-center text-orange-600 mb-4">
          <AlertTriangle size={20} className="mr-2" />
          <p className="font-semibold">Permissions Required</p>
        </div>
        {renderPermissions()}
        <PrimaryButton onClick={requestPermissions} disabled={isRequesting}>
          {isRequesting ? "Requesting..." : "Grant Permissions"}
        </PrimaryButton>
      </div>
    );
  };

  return (
    <StaticCard
      title="Required Permissions"
      icon={<KeyRound className="mr-2 h-5 w-5 text-white" />}
    >
      {renderContent()}
    </StaticCard>
  );
};