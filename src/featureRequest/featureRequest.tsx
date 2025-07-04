import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../popup.css';
import { AIFeatureRequestForm } from './components/AIFeatureRequestForm';
import { FeatureList } from './components/FeatureList';
import { PermissionRequest } from './components/PermissionRequest';
import { useUserId } from './hooks/useUserId';
import { useFeatureRequests } from './hooks/useFeatureRequests';
import { VoteRequest } from './utils/api';

function FeatureRequestPage() {
  const {
    userId,
    loading: userIdLoading,
    error: userIdError,
    hasPermission,
    permissionRequesting,
    requestPermission
  } = useUserId();
  
  const {
    features,
    loading: featuresLoading,
    submitting,
    error: featuresError,
    fetchFeatures,
    submitFeature,
    submitVote,
    clearError
  } = useFeatureRequests();

  // Fetch features when component mounts
  useEffect(() => {
    fetchFeatures();
  }, [fetchFeatures]);

  // Filter user's own features for highlighting
  const userFeatures = userId ? features.filter(f => f.id === userId) : [];

  const handleSubmitFeature = async (featureRequest: any) => {
    if (!userId) {
      return false;
    }
    return await submitFeature({ ...featureRequest, userId });
  };

  const handleVote = async (voteRequest: VoteRequest) => {
    if (!userId) {
      return false;
    }
    // Use forceRefresh=true to ensure the list is always up-to-date after voting
    return await submitVote(voteRequest, true);
  };

  if (userIdLoading) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center py-12">
            <div className="text-gray-500">Loading user information...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center space-x-3">
            <img
              src="/icons/48x48.png"
              alt="Web Page Downloader"
              className="w-8 h-8"
            />
            <h1 className="text-2xl font-bold text-gray-900">
              🔧 Web Page Downloader - Feature Requests
            </h1>
          </div>
          <p className="text-gray-600 mt-1">
            Help us improve the extension by submitting feature requests and viewing existing ones.
          </p>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 max-w-4xl mx-auto p-6 space-y-8 w-full">
        {/* Error Display */}
        {(featuresError || userIdError) && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded flex justify-between items-center">
            <span><strong>Error:</strong> {featuresError || userIdError}</span>
            <button
              onClick={clearError}
              className="text-red-700 hover:text-red-900 font-bold"
            >
              ×
            </button>
          </div>
        )}

        {/* Permission Request */}
        {!hasPermission && !userIdLoading && (
          <PermissionRequest
            onRequestPermission={requestPermission}
            requesting={permissionRequesting}
          />
        )}

        {/* Feature Request Form - Only show if user has permission and ID */}
        {hasPermission && userId && (
          <AIFeatureRequestForm
            userId={userId}
            onSubmit={handleSubmitFeature}
            submitting={submitting}
          />
        )}

        {/* Feature List - Always show (read-only if no permission) */}
        <FeatureList
          features={features}
          loading={featuresLoading}
          userFeatures={userFeatures}
          onVote={handleVote}
        />
      </div>

      {/* Footer - Sticky to bottom */}
      <div className="bg-white border-t mt-auto">
        <div className="max-w-4xl mx-auto px-6 py-4 text-center text-gray-500 text-sm">
          <p>Thank you for helping us improve Web Page Downloader!</p>
        </div>
      </div>
    </div>
  );
}
// Render the component
const root = createRoot(document.getElementById("feature-request-root")!);

root.render(
  <React.StrictMode>
    <FeatureRequestPage />
  </React.StrictMode>,
);