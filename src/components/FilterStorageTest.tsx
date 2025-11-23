import { useFilterOptions, useStorageStatus } from "../hooks/useFilterOptions";
import { Button } from "./Button";

/**
 * Test component to verify filter storage functionality
 * This component can be temporarily added to test the storage system
 */
export function FilterStorageTest() {
  const {
    options,
    isLoading,
    isInitialized,
    setDownloadHTML,
    setDownloadImages,
    resetToDefaults,
    clearStorageError,
  } = useFilterOptions();

  const { isStorageAvailable, hasError, errorMessage } = useStorageStatus();

  const testRandomOptions = () => {
    setDownloadHTML(Math.random() > 0.5);
    setDownloadImages(Math.random() > 0.5);
  };

  if (isLoading) {
    return (
      <div className="p-4 bg-gray-50 rounded-lg border">
        <h4 className="font-semibold mb-2">Storage Test - Loading...</h4>
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded mb-2"></div>
          <div className="h-4 bg-gray-200 rounded w-3/4"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 bg-gray-50 rounded-lg border">
      <h4 className="font-semibold mb-4">Filter Storage Test</h4>

      {/* Status Information */}
      <div className="mb-4 space-y-2">
        <div className="text-sm">
          <span className="font-medium">Initialized:</span>
          <span className={isInitialized ? "text-green-600" : "text-red-600"}>
            {isInitialized ? " ✓ Yes" : " ✗ No"}
          </span>
        </div>

        <div className="text-sm">
          <span className="font-medium">Storage Available:</span>
          <span
            className={isStorageAvailable ? "text-green-600" : "text-red-600"}
          >
            {isStorageAvailable ? " ✓ Yes" : " ✗ No"}
          </span>
        </div>

        {hasError && (
          <div className="text-sm">
            <span className="font-medium text-red-600">Error:</span>
            <span className="text-red-600"> {errorMessage}</span>
            <Button
              onClick={clearStorageError}
              className="ml-2 text-xs px-2 py-1"
            >
              Clear Error
            </Button>
          </div>
        )}
      </div>

      {/* Current Options Display */}
      <div className="mb-4">
        <h5 className="font-medium mb-2">Current Options:</h5>
        <div className="text-sm space-y-1 bg-white p-2 rounded border">
          <div>HTML: {options.downloadHTML ? "✓" : "✗"}</div>
          <div>Images: {options.downloadImages ? "✓" : "✗"}</div>
          <div>Links: {options.downloadLinks ? "✓" : "✗"}</div>
          <div>Assets: {options.downloadAssets ? "✓" : "✗"}</div>
          <div>Text: {options.downloadContentAsText ? "✓" : "✗"}</div>
          <div>Documents: {options.downloadDocuments ? "✓" : "✗"}</div>
          <div>Single File: {options.singleFile ? "✓" : "✗"}</div>
        </div>
      </div>

      {/* Test Actions */}
      <div className="space-x-2">
        <Button onClick={testRandomOptions} className="text-sm px-3 py-1">
          Random Options
        </Button>

        <Button onClick={resetToDefaults} className="text-sm px-3 py-1">
          Reset to Defaults
        </Button>
      </div>

      {/* Instructions */}
      <div className="mt-4 text-xs text-gray-600">
        <p>
          Test the storage by changing options above, then refresh the page.
          Your preferences should persist if storage is working correctly.
        </p>
      </div>
    </div>
  );
}
