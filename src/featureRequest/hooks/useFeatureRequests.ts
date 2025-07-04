import { useState, useCallback } from 'react';
import {
  submitFeatureRequest,
  getFeatureRequests,
  validateFeatureRequest,
  voteFeature,
  FeatureRequest,
  ExistingFeatureRequest,
  VoteRequest
} from '../utils/api';

export function useFeatureRequests() {
  const [features, setFeatures] = useState<ExistingFeatureRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFeatures = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getFeatureRequests();
      setFeatures(data);
    } catch (err) {
      console.error('Error fetching features:', err);
      setError('Failed to load feature requests');
    } finally {
      setLoading(false);
    }
  }, []);

  const submitFeature = useCallback(async (featureRequest: FeatureRequest): Promise<boolean> => {
    try {
      setSubmitting(true);
      setError(null);

      // Validate the request
      const validationErrors = validateFeatureRequest(featureRequest);
      if (validationErrors.length > 0) {
        setError(validationErrors.join(', '));
        return false;
      }

      const result = await submitFeatureRequest(featureRequest);
      if (result) {
        // Refresh the features list after successful submission
        await fetchFeatures();
        return true;
      } else {
        setError('Failed to submit feature request');
        return false;
      }
    } catch (err) {
      console.error('Error submitting feature:', err);
      setError('Failed to submit feature request');
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [fetchFeatures]);

  const submitVote = useCallback(async (voteRequest: VoteRequest, forceRefresh: boolean = false): Promise<boolean> => {
    try {
      setError(null);
      const result = await voteFeature(voteRequest);
      
      if (result && result.success) {
        console.log('Vote successful, updating local state with:', result.votes);
        
        if (forceRefresh) {
          // Refresh the entire list to ensure consistency with server
          console.log('Force refreshing feature list after vote');
          await fetchFeatures();
        } else {
          // Update the local features state with new vote data
          setFeatures(prevFeatures => {
            const updatedFeatures = prevFeatures.map(feature =>
              feature.id === voteRequest.featureId
                ? { ...feature, votes: result.votes }
                : feature
            );
            
            console.log('Updated features state after vote');
            return updatedFeatures;
          });
        }
        
        return true;
      } else {
        console.error('Vote failed:', result);
        setError('Failed to submit vote');
        return false;
      }
    } catch (err) {
      console.error('Error submitting vote:', err);
      setError('Failed to submit vote');
      return false;
    }
  }, [fetchFeatures]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    features,
    loading,
    submitting,
    error,
    fetchFeatures,
    submitFeature,
    submitVote,
    clearError,
  };
}