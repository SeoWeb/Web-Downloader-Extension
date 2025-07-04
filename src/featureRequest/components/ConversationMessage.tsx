import { ConversationMessage as MessageType } from '../utils/conversationManager';
import { Button } from '../../components/Button';

interface ConversationMessageProps {
  message: MessageType;
  onAnswerOptionClick?: (answer: string) => void;
  isLatestAI?: boolean;
  isLoading?: boolean;
}

export function ConversationMessage({
  message,
  onAnswerOptionClick,
  isLatestAI = false,
  isLoading = false
}: ConversationMessageProps) {
  const isUser = message.type === 'user';
  const hasAnswerOptions = message.answerOptions && message.answerOptions.length > 0;
  const showAnswerButtons = hasAnswerOptions && isLatestAI && !isLoading;
  
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div className={`max-w-[80%] ${isUser ? 'order-2' : 'order-1'}`}>
        <div
          className={`px-4 py-3 rounded-lg ${
            isUser
              ? 'bg-sky-500 text-white rounded-br-sm'
              : 'bg-gray-100 text-gray-900 rounded-bl-sm'
          }`}
        >
          <div className="whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
        
        {/* Answer Options Buttons */}
        {showAnswerButtons && (
          <div className="mt-3 space-y-2">
            <div className="text-xs text-gray-600 mb-2">Quick answers:</div>
            <div className="flex flex-wrap gap-2">
              {message.answerOptions!.map((option, index) => (
                <Button
                  key={index}
                  variant="outline"
                  size="sm"
                  onClick={() => onAnswerOptionClick?.(option)}
                  className="text-sm max-w-full text-pretty"
                >
                  {option}
                </Button>
              ))}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              Or type your own answer below
            </div>
          </div>
        )}
        
        <div
          className={`text-xs text-gray-500 mt-1 ${
            isLatestAI ? 'text-left' : isUser ? 'text-right' : 'text-left'
          }`}
        >
          {isUser ? '👤 You' : '🤖 AI Assistant'} • {message.timestamp.toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}