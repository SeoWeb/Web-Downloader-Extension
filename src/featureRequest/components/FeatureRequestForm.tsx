import React, { useState } from 'react';
import { Button } from '../../components/Button';
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
      <h2 className="text-xl font-semibold mb-4 text-gray-900">📝 Submit New Feature Request</h2>
      
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

        <Button
          type="submit"
          disabled={submitting}
          className="w-full"
        >
          {submitting ? 'Submitting...' : 'Submit Feature Request'}
        </Button>
      </form>
    </div>
  );
}