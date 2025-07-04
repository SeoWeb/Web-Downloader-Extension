import React, { useState } from 'react';
import { FeatureRequest } from '../utils/api';

interface GeneratedFormPreviewProps {
  generatedData: Partial<FeatureRequest>;
  onUpdateData: (data: Partial<FeatureRequest>) => void;
  onSubmit: (featureRequest: FeatureRequest) => Promise<boolean>;
  onRegenerate: () => void;
  onSwitchToManual: () => void;
  userId: number;
  submitting: boolean;
  isRegenerating: boolean;
}

export function GeneratedFormPreview({
  generatedData,
  onUpdateData,
  onSubmit,
//   onRegenerate,
//   onSwitchToManual,
  userId,
  submitting,
  isRegenerating
}: GeneratedFormPreviewProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!generatedData.title?.trim()) {
      newErrors.title = 'Title is required';
    } else if (generatedData.title.length > 100) {
      newErrors.title = 'Title must be 100 characters or less';
    }

    if (!generatedData.description?.trim()) {
      newErrors.description = 'Description is required';
    } else if (generatedData.description.length > 1000) {
      newErrors.description = 'Description must be 1000 characters or less';
    }

    if (!generatedData.useCase?.trim()) {
      newErrors.useCase = 'Use case is required';
    } else if (generatedData.useCase.length > 1000) {
      newErrors.useCase = 'Use case must be 1000 characters or less';
    }

    if (generatedData.proposedSolution && generatedData.proposedSolution.length > 1000) {
      newErrors.proposedSolution = 'Proposed solution must be 1000 characters or less';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    const featureRequest: FeatureRequest = {
      userId,
      title: generatedData.title!.trim(),
      description: generatedData.description!.trim(),
      useCase: generatedData.useCase!.trim(),
      proposedSolution: generatedData.proposedSolution?.trim() || undefined,
    };

    const success = await onSubmit(featureRequest);
    if (success) {
      setSuccess(true);
      // Hide success message after 3 seconds
      setTimeout(() => setSuccess(false), 3000);
    }
  };

  const handleInputChange = (field: keyof FeatureRequest, value: string) => {
    onUpdateData({ [field]: value });
    // Clear error for this field when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-gray-900">
          ✨ AI-Generated Feature Request
        </h2>
        {/* <Button
          variant="outline"
          size="sm"
          onClick={onSwitchToManual}
          disabled={submitting || isRegenerating}
        >
          Use Manual Form
        </Button> */}
      </div>
      
      <p className="text-gray-600 mb-6">
        Review and edit the details below. The AI has structured your request based on our conversation.
      </p>

      {success && (
        <div className="mb-4 p-3 bg-green-100 border border-green-400 text-green-700 rounded">
          Feature request submitted successfully!
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="ai-title" className="block text-sm font-medium text-gray-700 mb-1">
            Title *
          </label>
          <input
            type="text"
            id="ai-title"
            value={generatedData.title || ''}
            onChange={(e) => handleInputChange('title', e.target.value)}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 ${
              errors.title ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder="Brief title for your feature request"
            maxLength={100}
            disabled={submitting || isRegenerating}
          />
          <div className="flex justify-between mt-1">
            {errors.title && <span className="text-red-500 text-sm">{errors.title}</span>}
            <span className="text-gray-400 text-sm ml-auto">{(generatedData.title || '').length}/100</span>
          </div>
        </div>

        <div>
          <label htmlFor="ai-description" className="block text-sm font-medium text-gray-700 mb-1">
            Description *
          </label>
          <textarea
            id="ai-description"
            value={generatedData.description || ''}
            onChange={(e) => handleInputChange('description', e.target.value)}
            rows={4}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 ${
              errors.description ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder="Detailed description of the feature you'd like to see"
            maxLength={1000}
            disabled={submitting || isRegenerating}
          />
          <div className="flex justify-between mt-1">
            {errors.description && <span className="text-red-500 text-sm">{errors.description}</span>}
            <span className="text-gray-400 text-sm ml-auto">{(generatedData.description || '').length}/1000</span>
          </div>
        </div>

        <div>
          <label htmlFor="ai-useCase" className="block text-sm font-medium text-gray-700 mb-1">
            Use Case / Problem *
          </label>
          <textarea
            id="ai-useCase"
            value={generatedData.useCase || ''}
            onChange={(e) => handleInputChange('useCase', e.target.value)}
            rows={3}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 ${
              errors.useCase ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder="What problem does this feature solve? How would you use it?"
            maxLength={1000}
            disabled={submitting || isRegenerating}
          />
          <div className="flex justify-between mt-1">
            {errors.useCase && <span className="text-red-500 text-sm">{errors.useCase}</span>}
            <span className="text-gray-400 text-sm ml-auto">{(generatedData.useCase || '').length}/1000</span>
          </div>
        </div>

        <div>
          <label htmlFor="ai-proposedSolution" className="block text-sm font-medium text-gray-700 mb-1">
            Proposed Solution (Optional)
          </label>
          <textarea
            id="ai-proposedSolution"
            value={generatedData.proposedSolution || ''}
            onChange={(e) => handleInputChange('proposedSolution', e.target.value)}
            rows={3}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 ${
              errors.proposedSolution ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder="How do you think this feature should work?"
            maxLength={1000}
            disabled={submitting || isRegenerating}
          />
          <div className="flex justify-between mt-1">
            {errors.proposedSolution && <span className="text-red-500 text-sm">{errors.proposedSolution}</span>}
            <span className="text-gray-400 text-sm ml-auto">{(generatedData.proposedSolution || '').length}/1000</span>
          </div>
        </div>

        <div className="flex space-x-3 pt-4">
          {/* Magical Submit Button */}
          <div className="relative group flex-1">
            {/* Magical glow background */}
            <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 via-pink-600 to-blue-600 rounded-lg blur opacity-25 group-hover:opacity-75 transition duration-1000 group-hover:duration-200 animate-pulse"></div>
            
            <button
              type="submit"
              disabled={submitting || isRegenerating}
              className={`
                relative w-full px-6 py-4 rounded-lg font-semibold text-white
                bg-gradient-to-r from-purple-500 via-pink-500 to-indigo-500
                hover:from-purple-600 hover:via-pink-600 hover:to-indigo-600
                transform transition-all duration-300 ease-out
                hover:scale-105 shadow-lg hover:shadow-2xl
                focus:outline-none focus:ring-4 focus:ring-purple-300 focus:ring-opacity-50
                disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
                overflow-hidden
              `}
            >
              {/* Shimmer effect */}
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white to-transparent opacity-0 hover:opacity-20 transform -skew-x-12 -translate-x-full hover:translate-x-full transition-transform duration-1000"></div>
              
              {/* Button content */}
              <div className="relative flex items-center justify-center space-x-3">
                {submitting ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    <span className="text-lg font-bold tracking-wide">Casting Your Wish...</span>
                    <span className="text-xl animate-pulse">✨</span>
                  </>
                ) : (
                  <>
                    <span className="text-xl">📤</span>
                    <span className="text-lg font-bold tracking-wide">Submit Request</span>
                    <span className="text-xl">✨</span>
                  </>
                )}
              </div>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}