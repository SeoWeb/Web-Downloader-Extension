import React, { useState, useRef, useEffect } from 'react';
import { Button } from '../../components/Button';
import { ConversationMessage } from './ConversationMessage';
import { ConversationManager } from '../utils/conversationManager';

interface ChatInterfaceProps {
  conversation: ConversationManager;
  onSendMessage: (message: string) => void;
  isLoading: boolean;
  onSwitchToManual: () => void;
}

export function ChatInterface({
  conversation,
  onSendMessage,
  isLoading,
  // onSwitchToManual
}: ChatInterfaceProps) {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const messages = conversation.getMessages();

  // Auto-scroll to bottom when new messages arrive - only within the chat container
  useEffect(() => {
    if (messagesContainerRef.current && messagesEndRef.current) {
      const container = messagesContainerRef.current;
      const endElement = messagesEndRef.current;
      
      // Scroll within the container only, not the entire page
      container.scrollTo({
        top: endElement.offsetTop,
        behavior: 'smooth'
      });
    }
  }, [messages]);

  // Focus input when component mounts or loading stops
  useEffect(() => {
    if (!isLoading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() && !isLoading) {
      onSendMessage(inputValue.trim());
      setInputValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900">
            🤖 AI Assistant
          </h2>
          {/* <Button
            variant="outline"
            size="sm"
            onClick={onSwitchToManual}
            disabled={isLoading}
          >
            Use Manual Form
          </Button> */}
        </div>
        <p className="text-sm text-gray-600 mt-1">
          I'll help you structure your feature request by asking a few questions.
        </p>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} className="px-6 py-4 max-h-96 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            <div className="text-4xl mb-2">🤖</div>
            <p>Starting conversation...</p>
          </div>
        ) : (
          <>
            {messages.map((message, index) => {
              const isLatestAI = message.type === 'ai' && index === messages.length - 1;
              return (
                <ConversationMessage
                  key={message.id}
                  message={message}
                  onAnswerOptionClick={onSendMessage}
                  isLatestAI={isLatestAI}
                  isLoading={isLoading}
                />
              );
            })}
            {isLoading && (
              <div className="flex justify-start mb-4">
                <div className="max-w-[80%]">
                  <div className="bg-gray-100 text-gray-900 px-4 py-3 rounded-lg rounded-bl-sm">
                    <div className="flex items-center space-x-2">
                      <div className="flex space-x-1">
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                      </div>
                      <span className="text-sm text-gray-600">AI is thinking...</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t px-6 py-4">
        <form onSubmit={handleSubmit} className="flex space-x-3">
          <div className="flex-1">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your response..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 resize-none"
              rows={2}
              disabled={isLoading}
              maxLength={500}
            />
            <div className="text-xs text-gray-400 mt-1 text-right">
              {inputValue.length}/500
            </div>
          </div>
          <div className="flex flex-col justify-end">
            <Button
              type="submit"
              disabled={!inputValue.trim() || isLoading}
              size="sm"
            >
              Send
            </Button>
          </div>
        </form>
        <div className="text-xs text-gray-500 mt-2">
          Press Enter to send, Shift+Enter for new line
        </div>
      </div>
    </div>
  );
}