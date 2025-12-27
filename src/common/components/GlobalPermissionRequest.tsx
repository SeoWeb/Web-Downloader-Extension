import { Button } from "../../components/Button";

interface GlobalPermissionRequestProps {
  onRequestPermission: () => Promise<void>;
  requesting: boolean;
  error?: string | null;
}

export function GlobalPermissionRequest({
  onRequestPermission,
  requesting,
  error,
}: GlobalPermissionRequestProps) {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
      <div className="mb-4">
        <div className="text-3xl mb-2">🔒</div>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          Permissions Required
        </h2>
        <p className="text-sm text-gray-600 mb-4 leading-relaxed">
          This extension needs storage and offscreen permissions to provide the best download experience.
        </p>
        <div className="text-xs text-gray-500 mb-3 text-left">
          <div className="mb-3">
            <strong>Storage Permission:</strong>
            <br />
            Allows the extension to save small amounts of data locally in your browser. This enables us to remember your preferences and provide a personalized experience across sessions.
          </div>
          <div className="mb-3">
            <strong>Offscreen Permission:</strong>
            <br />
            Enables large file downloads by allowing the extension to process files in the background without affecting your browsing experience.
          </div>
        </div>
        <div className="text-xs text-gray-500 mb-4 text-left">
          <div className="mb-2">
            <strong>What we store:</strong>
            <br />• Unique generated ID
            <br />• Download preferences
          </div>
          <div>
            <strong>Privacy:</strong>
            <br />• No personal data
            <br />• No browsing history
            <br />• All data stays local in your browser
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <Button
        onClick={onRequestPermission}
        disabled={requesting}
        className="px-6 py-2"
      >
        {requesting ? "Requesting Permissions..." : "Enable Permissions"}
      </Button>

      <p className="text-xs text-gray-500 mt-3">
        Revoke anytime in browser settings
      </p>
    </div>
  );
}
