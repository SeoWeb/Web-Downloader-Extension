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
                ✨ AI-powered wish fulfillment ✨
              </p>
            </div>
          </div>
          <p className="text-gray-600 mb-4">
            Describe your feature idea or problem and why you need it.
            <br />
            Our artificial intelligence will help you structure your request.
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
              {/* Magical AI Analyze Button */}
              <div className="relative group flex-1">
                {/* Magical glow background */}
                <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 via-pink-600 to-blue-600 rounded-lg blur opacity-25 group-hover:opacity-75 transition duration-1000 group-hover:duration-200 animate-pulse"></div>
                
                <button
                  onClick={handleStartAnalysis}
                  disabled={!initialDescription.trim() || isLoading}
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
                    {isLoading ? (
                      <>
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                        <span className="text-lg font-bold tracking-wide">Analyzing Magic...</span>
                        <span className="text-xl animate-pulse">🔮</span>
                      </>
                    ) : (
                      <>
                        <span className="text-xl">🤖</span>
                        <span className="text-lg font-bold tracking-wide">Analyze with AI</span>
                        <span className="text-xl">✨</span>
                      </>
                    )}
                  </div>
                </button>
              </div>
            </div>
          </div>

          {/* <div className="mt-6 p-4 bg-blue-50 rounded-lg">
            <h3 className="font-medium text-blue-900 mb-2">💡 How it works:</h3>
            <ul className="text-sm text-blue-800 space-y-1">
              <li>• Describe your feature idea in natural language</li>
              <li>• AI will ask clarifying questions if needed</li>
              <li>• Review and edit the structured form</li>
              <li>• Submit your polished feature request</li>
            </ul>
          </div> */}
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