import { useState, useMemo } from "react";
import { ExistingFeatureRequest, VoteRequest } from "../utils/api";
import { useUserId } from "../hooks/useUserId";

interface FeatureListProps {
  features: ExistingFeatureRequest[];
  loading: boolean;
  userFeatures?: ExistingFeatureRequest[];
  onVote?: (voteRequest: VoteRequest) => Promise<boolean>;
}

interface FeatureModalProps {
  feature: ExistingFeatureRequest;
  isOpen: boolean;
  onClose: () => void;
  isUserFeature: boolean;
  userId: number | null;
  onVote?: (voteRequest: VoteRequest) => Promise<boolean>;
}

const STATUS_COLORS = {
  New: "bg-blue-100 text-blue-800",
  "In Development": "bg-yellow-100 text-yellow-800",
  Done: "bg-green-100 text-green-800",
  Rejected: "bg-red-100 text-red-800",
  "On Hold": "bg-gray-100 text-gray-800",
};

interface VotingComponentProps {
  feature: ExistingFeatureRequest;
  userId: number | null;
  onVote?: (voteRequest: VoteRequest) => Promise<boolean>;
}

function VotingComponent({ feature, userId, onVote }: VotingComponentProps) {
  const [isVoting, setIsVoting] = useState(false);
  const [lastVoteType, setLastVoteType] = useState<"up" | "down" | null>(null);

  const votes = feature.votes || {
    upvotes: 0,
    downvotes: 0,
    totalVotes: 0,
    averageVote: 0,
    userVote: null,
  };

  const handleVote = async (voteType: "up" | "down") => {
    // Prevent voting if user has already voted
    if (!userId || !onVote || isVoting || votes.userVote) return;

    setIsVoting(true);
    setLastVoteType(voteType);

    try {
      const success = await onVote({
        featureId: feature.id,
        userId,
        vote: voteType,
      });

      if (success) {
        console.log("Vote submitted successfully for feature:", feature.id);
        // The list will be refreshed automatically by the parent component
      } else {
        console.error("Failed to submit vote for feature:", feature.id);
      }
    } catch (error) {
      console.error("Error voting:", error);
    } finally {
      setIsVoting(false);
      setLastVoteType(null);
    }
  };

  const getVoteButtonClass = (voteType: "up" | "down") => {
    const baseClass =
      "flex items-center space-x-1 px-2 py-1 rounded-md text-sm transition-colors";
    const isUserVote = votes.userVote === voteType;
    const isCurrentlyVoting = isVoting && lastVoteType === voteType;
    const isDisabled = !userId || isVoting || !!votes.userVote;

    let colorClass = "";
    if (voteType === "up") {
      if (isCurrentlyVoting) {
        colorClass = "bg-green-200 text-green-800 border border-green-400";
      } else if (isUserVote) {
        colorClass = "bg-green-100 text-green-700 border border-green-300";
      } else if (isDisabled) {
        colorClass = "text-gray-400 cursor-not-allowed";
      } else {
        colorClass = "text-gray-600 hover:bg-green-50 hover:text-green-600";
      }
    } else {
      if (isCurrentlyVoting) {
        colorClass = "bg-red-200 text-red-800 border border-red-400";
      } else if (isUserVote) {
        colorClass = "bg-red-100 text-red-700 border border-red-300";
      } else if (isDisabled) {
        colorClass = "text-gray-400 cursor-not-allowed";
      } else {
        colorClass = "text-gray-600 hover:bg-red-50 hover:text-red-600";
      }
    }

    return `${baseClass} ${colorClass}`;
  };

  return (
    <div className="flex items-center space-x-3 text-sm">
      {/* Upvote Button */}
      <button
        onClick={() => handleVote("up")}
        disabled={!userId || isVoting || !!votes.userVote}
        className={getVoteButtonClass("up")}
        title={
          !userId
            ? "Login required to vote"
            : votes.userVote
              ? "You have already voted on this feature"
              : "Upvote this feature"
        }
      >
        {isVoting && lastVoteType === "up" ? (
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            ></circle>
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            ></path>
          </svg>
        ) : (
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 15l7-7 7 7"
            />
          </svg>
        )}
        <span>{votes.upvotes}</span>
      </button>

      {/* Downvote Button */}
      <button
        onClick={() => handleVote("down")}
        disabled={!userId || isVoting || !!votes.userVote}
        className={getVoteButtonClass("down")}
        title={
          !userId
            ? "Login required to vote"
            : votes.userVote
              ? "You have already voted on this feature"
              : "Downvote this feature"
        }
      >
        {isVoting && lastVoteType === "down" ? (
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            ></circle>
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            ></path>
          </svg>
        ) : (
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        )}
        <span>{votes.downvotes}</span>
      </button>

      {/* Vote Statistics */}
      {votes.totalVotes > 0 && (
        <div className="flex items-center space-x-2 text-gray-500">
          <span className="text-xs">
            {votes.totalVotes} vote{votes.totalVotes !== 1 ? "s" : ""}
          </span>
          <span className="text-xs">Avg: {votes.averageVote.toFixed(1)}</span>
        </div>
      )}

      {/* User Vote Indicator */}
      {votes.userVote && (
        <span className="text-xs text-gray-400">
          You voted {votes.userVote === "up" ? "👍" : "👎"}
        </span>
      )}
    </div>
  );
}

function FeatureModal({
  feature,
  isOpen,
  onClose,
  isUserFeature,
  userId,
  onVote,
}: FeatureModalProps) {
  if (!isOpen) return null;

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getStatusColor = (status: string) => {
    return (
      STATUS_COLORS[status as keyof typeof STATUS_COLORS] ||
      "bg-gray-100 text-gray-800"
    );
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 rounded-t-xl">
          <div className="flex items-start justify-between">
            <div className="flex-1 pr-4">
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                {feature.Title}
              </h2>
              <div className="flex items-center space-x-3">
                {isUserFeature && (
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-sky-100 text-sky-800">
                    <svg
                      className="w-4 h-4 mr-1"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Your Request
                  </span>
                )}
                <span
                  className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(feature.Status)}`}
                >
                  {feature.Status}
                </span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="flex-shrink-0 p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-6 space-y-6">
          {/* Description */}
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
              <svg
                className="w-5 h-5 mr-2 text-blue-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              Description
            </h3>
            <p className="text-gray-700 leading-relaxed">
              {feature.Description}
            </p>
          </div>

          {/* Use Case */}
          {feature.Use_Case && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
                <svg
                  className="w-5 h-5 mr-2 text-green-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                  />
                </svg>
                Use Case
              </h3>
              <p className="text-gray-700 leading-relaxed">
                {feature.Use_Case}
              </p>
            </div>
          )}

          {/* Proposed Solution */}
          {feature.Solution && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
                <svg
                  className="w-5 h-5 mr-2 text-purple-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                Proposed Solution
              </h3>
              <p className="text-gray-700 leading-relaxed">
                {feature.Solution}
              </p>
            </div>
          )}

          {/* Metadata */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
              <svg
                className="w-5 h-5 mr-2 text-gray-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              Details
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <span className="font-medium text-gray-600">Request ID:</span>
                <span className="ml-2 text-gray-900">#{feature.id}</span>
              </div>
              <div>
                <span className="font-medium text-gray-600">Created:</span>
                <span className="ml-2 text-gray-900">
                  {formatDate(feature.Created)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Voting Section */}
        <div className="bg-gray-50 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
            <svg
              className="w-5 h-5 mr-2 text-blue-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 11l5-5m0 0l5 5m-5-5v12"
              />
            </svg>
            Community Feedback
          </h3>
          <VotingComponent feature={feature} userId={userId} onVote={onVote} />
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-gray-50 px-6 py-4 rounded-b-xl border-t border-gray-200">
          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="px-6 py-2 bg-sky-600 text-white rounded-lg hover:bg-sky-700 transition-colors font-medium"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FeatureList({
  features,
  loading,
  userFeatures = [],
  onVote,
}: FeatureListProps) {
  const { userId } = useUserId();
  const [searchTerm, setSearchTerm] = useState("");
  // const [statusFilter, setStatusFilter] = useState<string>('All');
  const [showUserOnly, setShowUserOnly] = useState(false);
  const [selectedFeature, setSelectedFeature] =
    useState<ExistingFeatureRequest | null>(null);

  const filteredFeatures = useMemo(() => {
    let filtered = features;

    // Filter by user's features if requested
    if (showUserOnly && userFeatures.length > 0) {
      const userFeatureIds = new Set(userFeatures.map((f) => f.id));
      filtered = filtered.filter((f) => userFeatureIds.has(f.id));
    }

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (f) =>
          f.Title.toLowerCase().includes(term) ||
          f.Description.toLowerCase().includes(term) ||
          f.Use_Case.toLowerCase().includes(term),
      );
    }

    // Filter by status
    // if (statusFilter !== 'All') {
    //   filtered = filtered.filter(f => f.Status === statusFilter);
    // }

    // Sort by creation date (newest first)
    return filtered.sort((a, b) => b.Created - a.Created);
  }, [features, userFeatures, searchTerm, showUserOnly]);

  // const uniqueStatuses = useMemo(() => {
  //   const statuses = new Set(features.map(f => f.Status));
  //   return Array.from(statuses).sort();
  // }, [features]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString();
  };

  const getStatusColor = (status: string) => {
    return (
      STATUS_COLORS[status as keyof typeof STATUS_COLORS] ||
      "bg-gray-100 text-gray-800"
    );
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <h2 className="text-xl font-semibold mb-4 text-gray-900">
          📋 Existing Feature Requests
        </h2>
        <div className="flex items-center justify-center py-8">
          <div className="text-gray-500">Loading feature requests...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <h2 className="text-xl font-semibold mb-4 text-gray-900">
        📋 Existing Feature Requests
      </h2>

      {/* Filters */}
      <div className="mb-4 space-y-3">
        <div>
          <input
            type="text"
            placeholder="Search feature requests..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
        </div>

        <div className="flex flex-wrap gap-3">
          {/* <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="All">All Statuses</option>
            {uniqueStatuses.map(status => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select> */}

          {userFeatures.length > 0 && (
            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={showUserOnly}
                onChange={(e) => setShowUserOnly(e.target.checked)}
                className="rounded border-gray-300 text-sky-600 focus:ring-sky-500"
              />
              <span className="text-sm text-gray-700">
                Show only my requests
              </span>
            </label>
          )}
        </div>
      </div>

      {/* Feature List */}
      {filteredFeatures.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          {features.length === 0
            ? "No feature requests found."
            : "No feature requests match your filters."}
        </div>
      ) : (
        <div className="space-y-3 max-h-[1000px] overflow-y-auto">
          {filteredFeatures.map((feature) => {
            const isUserFeature = userFeatures.some(
              (uf) => uf.id === feature.id,
            );

            return (
              <div
                key={feature.id}
                className={`border rounded-lg p-4 transition-all hover:shadow-md ${
                  isUserFeature
                    ? "border-sky-200 bg-sky-50"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div className="flex items-start justify-between mb-3">
                  <h3 className="font-semibold text-gray-900 flex-1 text-lg leading-tight">
                    {feature.Title}
                  </h3>
                  <div className="flex items-center space-x-2 ml-4 flex-shrink-0">
                    {isUserFeature && (
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-sky-100 text-sky-800">
                        <svg
                          className="w-3 h-3 mr-1"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
                            clipRule="evenodd"
                          />
                        </svg>
                        Your Request
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(feature.Status)}`}
                    >
                      {feature.Status}
                    </span>
                  </div>
                </div>

                <p
                  className="text-gray-600 text-sm mb-4 overflow-hidden"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {feature.Description}
                </p>

                {/* Voting Component */}
                <div className="mb-3">
                  <VotingComponent
                    feature={feature}
                    userId={userId}
                    onVote={onVote}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">
                    Created: {formatDate(feature.Created)}
                  </span>
                  <button
                    onClick={() => setSelectedFeature(feature)}
                    className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-sky-600 hover:text-sky-700 hover:bg-sky-50 rounded-md transition-colors"
                  >
                    Read More
                    <svg
                      className="w-4 h-4 ml-1"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {filteredFeatures.length > 0 && (
        <div className="mt-4 text-sm text-gray-500 text-center">
          Showing {filteredFeatures.length} of {features.length} feature
          requests
        </div>
      )}

      {/* Feature Detail Modal */}
      {selectedFeature && (
        <FeatureModal
          feature={selectedFeature}
          isOpen={!!selectedFeature}
          onClose={() => setSelectedFeature(null)}
          isUserFeature={userFeatures.some(
            (uf) => uf.id === selectedFeature.id,
          )}
          userId={userId}
          onVote={onVote}
        />
      )}
    </div>
  );
}
