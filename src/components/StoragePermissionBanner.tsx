import { useState } from "react";
import { Button } from "./Button";
import { requestStoragePermission } from "../common/permissions";

interface StoragePermissionBannerProps {
  onPermissionGranted?: () => void;
  onPermissionDenied?: () => void;
}

export function StoragePermissionBanner({
  onPermissionGranted,
  onPermissionDenied,
}: StoragePermissionBannerProps) {
  const [isRequesting, setIsRequesting] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  const handleRequestPermission = async () => {
    setIsRequesting(true);

    try {
      const granted = await requestStoragePermission();

      if (granted) {
        onPermissionGranted?.();
      } else {
        onPermissionDenied?.();
      }
    } catch {
      onPermissionDenied?.();
    } finally {
      setIsRequesting(false);
    }
  };

  const handleDismiss = () => {
    setIsDismissed(true);
    onPermissionDenied?.();
  };

  if (isDismissed) {
    return null;
  }

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
      <div className="flex items-start">
        <div className="flex-shrink-0">
          <svg
            className="h-5 w-5 text-blue-400"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        <div className="ml-3 flex-1">
          <h3 className="text-sm font-medium text-blue-800">
            Save Your Filter Preferences
          </h3>
          <div className="mt-2 text-sm text-blue-700">
            <p>
              Allow storage access to remember your download filter preferences
              across browser sessions. Your preferences will be saved locally
              and never shared.
            </p>
          </div>
          <div className="mt-4 flex space-x-2">
            <Button
              onClick={handleRequestPermission}
              disabled={isRequesting}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-3 py-1"
            >
              {isRequesting ? "Requesting..." : "Allow Storage"}
            </Button>
            <button
              onClick={handleDismiss}
              className="text-sm text-blue-600 hover:text-blue-800 underline"
            >
              Not now
            </button>
          </div>
        </div>
        <div className="ml-auto pl-3">
          <div className="-mx-1.5 -my-1.5">
            <button
              onClick={handleDismiss}
              className="inline-flex rounded-md p-1.5 text-blue-500 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-blue-50 focus:ring-blue-600"
            >
              <span className="sr-only">Dismiss</span>
              <svg
                className="h-5 w-5"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
