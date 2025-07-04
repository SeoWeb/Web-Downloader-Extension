import { getUserId } from '../../background/userIdManager.js';
import { API_URLS } from '../../common/apiConstants.js';

export interface FeatureRequest {
  id?: number;
  userId: number;
  title: string;
  description: string;
  useCase: string;
  proposedSolution?: string;
  timestamp?: string;
  status?: string;
}

export interface FeatureRequestResponse {
  id: number;
}

export interface VoteData {
  upvotes: number;
  downvotes: number;
  totalVotes: number;
  averageVote: number;
  userVote?: 'up' | 'down' | null;
}

export interface ExistingFeatureRequest {
  id: number;
  Status: string;
  Title: string;
  Description: string;
  Use_Case: string;
  Solution: string;
  Created: number;
  votes?: VoteData;
}

export interface VoteRequest {
  featureId: number;
  userId: number;
  vote: 'up' | 'down';
}

export interface VoteResponse {
  success: boolean;
  votes: VoteData;
}

/**
 * Submit a new feature request
 */
export async function submitFeatureRequest(featureRequest: FeatureRequest): Promise<FeatureRequestResponse | null> {
  try {
    const response = await fetch(API_URLS.SUBMIT_FEATURE_REQUEST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: featureRequest.userId,
        Title: featureRequest.title,
        Description: featureRequest.description,
        Use_Case: featureRequest.useCase,
        Solution: featureRequest.proposedSolution || '',
        Created: new Date().toISOString(),
        Status: "New"
      }),
    });

    if (!response.ok) {
      console.error('Failed to submit feature request:', response.statusText);
      return null;
    }

    const data: FeatureRequestResponse = await response.json();
    return data;
  } catch (error) {
    console.error('Error submitting feature request:', error);
    return null;
  }
}

/**
 * Get all existing feature requests
 */
export async function getFeatureRequests(): Promise<ExistingFeatureRequest[]> {
  try {
    const userId = await getUserId();
    const response = await fetch(API_URLS.GET_FEATURE_REQUESTS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: userId
      })
    });

    if (!response.ok) {
      console.error('Failed to fetch feature requests:', response.statusText);
      return [];
    }

    const data: ExistingFeatureRequest[] = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching feature requests:', error);
    return [];
  }
}

/**
 * Validate feature request data
 */
export function validateFeatureRequest(featureRequest: Partial<FeatureRequest>): string[] {
  const errors: string[] = [];

  if (!featureRequest.title || featureRequest.title.trim().length === 0) {
    errors.push('Title is required');
  } else if (featureRequest.title.length > 100) {
    errors.push('Title must be 100 characters or less');
  }

  if (!featureRequest.description || featureRequest.description.trim().length === 0) {
    errors.push('Description is required');
  } else if (featureRequest.description.length > 1000) {
    errors.push('Description must be 1000 characters or less');
  }

  if (!featureRequest.useCase || featureRequest.useCase.trim().length === 0) {
    errors.push('Use case is required');
  } else if (featureRequest.useCase.length > 500) {
    errors.push('Use case must be 500 characters or less');
  }

  if (featureRequest.proposedSolution && featureRequest.proposedSolution.length > 500) {
    errors.push('Proposed solution must be 500 characters or less');
  }

  return errors;
}

/**
 * Submit a vote for a feature request
 */
export async function voteFeature(voteRequest: VoteRequest): Promise<VoteResponse | null> {
  try {
    console.log('Submitting vote:', voteRequest);
    
    const response = await fetch(API_URLS.VOTE_FEATURE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        feature_id: voteRequest.featureId,
        user_id: voteRequest.userId,
        vote: voteRequest.vote,
      }),
    });

    if (!response.ok) {
      console.error('Failed to submit vote:', response.status, response.statusText);
      return null;
    }

    const data: VoteResponse = await response.json();
    console.log('Vote response received:', data);
    
    // Validate the response structure
    if (!data || typeof data.success !== 'boolean') {
      console.error('Invalid vote response structure:', data);
      return null;
    }
    
    // Ensure votes object has required properties
    if (data.success && data.votes) {
      data.votes = {
        upvotes: data.votes.upvotes || 0,
        downvotes: data.votes.downvotes || 0,
        totalVotes: data.votes.totalVotes || 0,
        averageVote: data.votes.averageVote || 0,
        userVote: data.votes.userVote || null,
      };
    }
    
    return data;
  } catch (error) {
    console.error('Error submitting vote:', error);
    return null;
  }
}