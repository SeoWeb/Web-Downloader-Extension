import { useState } from 'react';
import { Button } from '../../components/Button';
import { ChatInterface } from './ChatInterface';
import { GeneratedFormPreview } from './GeneratedFormPreview';
import { FeatureRequestForm } from './FeatureRequestForm';
import { useAIFeatureRequest } from '../hooks/useAIFeatureRequest';
import { FeatureRequest } from '../utils/api';

interface AIFeatureRequestFormProps {
  userId: number;
  onSubmit: (featureRequest: FeatureRequest) => Promise<boolean>;
  submitting: boolean;
}

export function AIFeatureRequestForm({ userId, onSubmit, submitting }: AIFeatureRequestFormProps) {
  const [initialDescription, setInitialDescription] = useState('');
  const [useManualForm, setUseManualForm] = useState(false);
  
  const {
    stage,
    conversation,
    generatedData,
    isLoading,
    error,
    startAnalysis,
    continueConversation,
    updateGeneratedData,
    regenerateWithAI,
    reset,
    switchToManual,
    clearError,
    setSubmitting,
  } = useAIFeatureRequest();

  const handleStartAnalysis = async () => {
    if (!initialDescription.trim()) {
      return;
    }
    await startAnalysis(initialDescription);
  };

  const handleSubmitFeature = async (featureRequest: FeatureRequest) => {
    setSubmitting(true);
    try {
      const success = await onSubmit(featureRequest);
      if (success) {
        reset();
        setInitialDescription('');
      }
      return success;
    } finally {
      setSubmitting(false);
    }
  };

  const handleSwitchToManual = () => {
    setUseManualForm(true);
    switchToManual();
  };

  const handleBackToAI = () => {
    setUseManualForm(false);
    reset();
    setInitialDescription('');
  };

  // Show manual form if user explicitly chose it
  if (useManualForm) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900">📝 Manual Feature Request</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={handleBackToAI}
            disabled={submitting}
          >
            Try AI Assistant
          </Button>
        </div>
        <FeatureRequestForm
          userId={userId}
          onSubmit={onSubmit}
          submitting={submitting}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error Display */}
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded flex justify-between items-center">
          <span><strong>Error:</strong> {error}</span>
          <button
            onClick={clearError}
            className="text-red-700 hover:text-red-900 font-bold"
          >
            ×
          </button>
        </div>
      )}

      {/* Initial Input Stage */}
      {stage === 'input' && (
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <h2 className="text-xl font-semibold mb-4 text-gray-900">
            📝 Submit New Feature Request
          </h2>
          <p className="text-gray-600 mb-4">
            Describe your feature idea and why you need it. Our AI will help structure your request.
          </p>
          
          <div className="space-y-4">
            <div>
              <label htmlFor="feature-description" className="block text-sm font-medium text-gray-700 mb-2">
                What feature would you like to see? *
              </label>
              <textarea
                id="feature-description"
                value={initialDescription}
                onChange={(e) => setInitialDescription(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500"
                placeholder="I would like to add a feature that allows me to..."
                maxLength={1000}
                disabled={isLoading}
              />
              <div className="text-gray-400 text-sm mt-1 text-right">
                {initialDescription.length}/1000
              </div>
            </div>

            <div className="flex space-x-3">
              <Button
                onClick={handleStartAnalysis}
                disabled={!initialDescription.trim() || isLoading}
                className="flex-1"
              >
                {isLoading ? 'Analyzing...' : '🤖 Analyze with AI'}
              </Button>
              {/* <Button
                variant="outline"
                onClick={handleSwitchToManual}
                disabled={isLoading}
                className="flex-1"
              >
                📝 Use Manual Form
              </Button> */}
            </div>
          </div>

          <div className="mt-6 p-4 bg-blue-50 rounded-lg">
            <h3 className="font-medium text-blue-900 mb-2">💡 How it works:</h3>
            <ul className="text-sm text-blue-800 space-y-1">
              <li>• Describe your feature idea in natural language</li>
              <li>• AI will ask clarifying questions if needed</li>
              <li>• Review and edit the structured form</li>
              <li>• Submit your polished feature request</li>
            </ul>
          </div>
        </div>
      )}

      {/* Analyzing Stage */}
      {stage === 'analyzing' && (
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <div className="text-center py-8">
            <div className="inline-flex items-center space-x-3">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky-500"></div>
              <span className="text-lg text-gray-700">AI is analyzing your request...</span>
            </div>
            <p className="text-gray-500 mt-2">This may take a few seconds</p>
          </div>
        </div>
      )}

      {/* Conversation Stage */}
      {stage === 'conversation' && (
        <ChatInterface
          conversation={conversation}
          onSendMessage={continueConversation}
          isLoading={isLoading}
          onSwitchToManual={handleSwitchToManual}
        />
      )}

      {/* Preview Stage */}
      {stage === 'preview' && generatedData && (
        <GeneratedFormPreview
          generatedData={generatedData}
          onUpdateData={updateGeneratedData}
          onSubmit={handleSubmitFeature}
          onRegenerate={regenerateWithAI}
          onSwitchToManual={handleSwitchToManual}
          userId={userId}
          submitting={submitting}
          isRegenerating={isLoading}
        />
      )}
    </div>
  );
}