import React, { useState } from 'react';
import { FeatureRequest } from '../utils/api';

interface FeatureRequestFormProps {
  userId: number;
  onSubmit: (featureRequest: FeatureRequest) => Promise<boolean>;
  submitting: boolean;
}

export function FeatureRequestForm({ userId, onSubmit, submitting }: FeatureRequestFormProps) {
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    useCase: '',
    proposedSolution: '',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.title.trim()) {
      newErrors.title = 'Title is required';
    } else if (formData.title.length > 100) {
      newErrors.title = 'Title must be 100 characters or less';
    }

    if (!formData.description.trim()) {
      newErrors.description = 'Description is required';
    } else if (formData.description.length > 1000) {
      newErrors.description = 'Description must be 1000 characters or less';
    }

    if (!formData.useCase.trim()) {
      newErrors.useCase = 'Use case is required';
    } else if (formData.useCase.length > 1000) {
      newErrors.useCase = 'Use case must be 1000 characters or less';
    }

    if (formData.proposedSolution.length > 1000) {
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
      title: formData.title.trim(),
      description: formData.description.trim(),
      useCase: formData.useCase.trim(),
      proposedSolution: formData.proposedSolution.trim() || undefined,
    };

    const success = await onSubmit(featureRequest);
    if (success) {
      setSuccess(true);
      setFormData({
        title: '',
        description: '',
        useCase: '',
        proposedSolution: '',
      });
      setErrors({});
      
      // Hide success message after 3 seconds
      setTimeout(() => setSuccess(false), 3000);
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    // Clear error for this field when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      {/* Magical Header Section */}
      <div className="relative group mb-6">
        {/* Magical glow background */}
        <div className="absolute -inset-2 bg-gradient-to-r from-purple-600 via-pink-600 to-blue-600 rounded-lg blur opacity-20 group-hover:opacity-40 transition duration-1000 animate-pulse"></div>
        
        {/* Header content */}
        <div className="relative bg-gradient-to-r from-purple-50 via-pink-50 to-indigo-50 rounded-lg p-4 border border-purple-200">
          <div className="flex items-center justify-center space-x-3">
            <span className="text-3xl animate-bounce">✨</span>
            <h2 className="text-2xl font-bold bg-gradient-to-r from-purple-600 via-pink-600 to-indigo-600 bg-clip-text text-transparent">
              Submit New Feature Request
            </h2>
            <span className="text-3xl animate-bounce" style={{ animationDelay: '0.5s' }}>🌟</span>
          </div>
          
          {/* Floating sparkles */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute top-2 left-8 w-1 h-1 bg-purple-400 rounded-full animate-ping opacity-75"></div>
            <div className="absolute top-6 right-12 w-1 h-1 bg-pink-400 rounded-full animate-pulse opacity-75" style={{ animationDelay: '1s' }}></div>
            <div className="absolute bottom-3 left-16 w-1 h-1 bg-blue-400 rounded-full animate-bounce opacity-75" style={{ animationDelay: '1.5s' }}></div>
            <div className="absolute bottom-6 right-6 w-1 h-1 bg-yellow-400 rounded-full animate-ping opacity-75" style={{ animationDelay: '2s' }}></div>
          </div>
          
          {/* Magical subtitle */}
          <p className="text-center text-purple-700 font-medium mt-2 text-sm">
            ✨ Transform your ideas into reality ✨
          </p>
        </div>
      </div>
      
      {success && (
        <div className="mb-4 p-3 bg-green-100 border border-green-400 text-green-700 rounded">
          Feature request submitted successfully!
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-1">
            Title *
          </label>
          <input
            type="text"
            id="title"
            value={formData.title}
            onChange={(e) => handleInputChange('title', e.target.value)}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 ${
              errors.title ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder="Brief title for your feature request"
            maxLength={100}
            disabled={submitting}
          />
          <div className="flex justify-between mt-1">
            {errors.title && <span className="text-red-500 text-sm">{errors.title}</span>}
            <span className="text-gray-400 text-sm ml-auto">{formData.title.length}/100</span>
          </div>
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
            Description *
          </label>
          <textarea
            id="description"
            value={formData.description}
            onChange={(e) => handleInputChange('description', e.target.value)}
            rows={4}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 ${
              errors.description ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder="Detailed description of the feature you'd like to see"
            maxLength={1000}
            disabled={submitting}
          />
          <div className="flex justify-between mt-1">
            {errors.description && <span className="text-red-500 text-sm">{errors.description}</span>}
            <span className="text-gray-400 text-sm ml-auto">{formData.description.length}/1000</span>
          </div>
        </div>

        <div>
          <label htmlFor="useCase" className="block text-sm font-medium text-gray-700 mb-1">
            Use Case / Problem *
          </label>
          <textarea
            id="useCase"
            value={formData.useCase}
            onChange={(e) => handleInputChange('useCase', e.target.value)}
            rows={3}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 ${
              errors.useCase ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder="What problem does this feature solve? How would you use it?"
            maxLength={1000}
            disabled={submitting}
          />
          <div className="flex justify-between mt-1">
            {errors.useCase && <span className="text-red-500 text-sm">{errors.useCase}</span>}
            <span className="text-gray-400 text-sm ml-auto">{formData.useCase.length}/1000</span>
          </div>
        </div>

        <div>
          <label htmlFor="proposedSolution" className="block text-sm font-medium text-gray-700 mb-1">
            Proposed Solution (Optional)
          </label>
          <textarea
            id="proposedSolution"
            value={formData.proposedSolution}
            onChange={(e) => handleInputChange('proposedSolution', e.target.value)}
            rows={3}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 ${
              errors.proposedSolution ? 'border-red-500' : 'border-gray-300'
            }`}
            placeholder="How do you think this feature should work?"
            maxLength={1000}
            disabled={submitting}
          />
          <div className="flex justify-between mt-1">
            {errors.proposedSolution && <span className="text-red-500 text-sm">{errors.proposedSolution}</span>}
            <span className="text-gray-400 text-sm ml-auto">{formData.proposedSolution.length}/1000</span>
          </div>
        </div>

        {/* Magical Submit Button */}
        <div className="relative group">
          {/* Magical glow background */}
          <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 via-pink-600 to-blue-600 rounded-lg blur opacity-25 group-hover:opacity-75 transition duration-1000 group-hover:duration-200 animate-pulse"></div>
          
          <button
            type="submit"
            disabled={submitting}
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
                  <span className="text-xl">🚀</span>
                  <span className="text-lg font-bold tracking-wide">Submit Feature Request</span>
                  <span className="text-xl">✨</span>
                </>
              )}
            </div>
          </button>
        </div>
      </form>
    </div>
  );
}