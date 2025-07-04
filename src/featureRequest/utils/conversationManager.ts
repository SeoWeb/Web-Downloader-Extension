export interface ConversationMessage {
  id: string;
  type: 'user' | 'ai';
  content: string;
  timestamp: Date;
  answerOptions?: string[];
}

export interface QuestionAnswerPair {
  question: string;
  answer: string;
}

export class ConversationManager {
  private messages: ConversationMessage[] = [];

  /**
   * Add a user message to the conversation
   */
  addUserMessage(content: string): void {
    const message: ConversationMessage = {
      id: this.generateId(),
      type: 'user',
      content: content.trim(),
      timestamp: new Date(),
    };
    this.messages.push(message);
  }

  /**
   * Add an AI message to the conversation
   */
  addAIMessage(content: string): void {
    const message: ConversationMessage = {
      id: this.generateId(),
      type: 'ai',
      content: content.trim(),
      timestamp: new Date(),
    };
    this.messages.push(message);
  }

  /**
   * Add an AI message with answer options to the conversation
   */
  addAIMessageWithOptions(content: string, answerOptions: string[]): void {
    const message: ConversationMessage = {
      id: this.generateId(),
      type: 'ai',
      content: content.trim(),
      timestamp: new Date(),
      answerOptions: answerOptions,
    };
    this.messages.push(message);
  }

  /**
   * Get the full description by combining all user messages
   */
  getFullDescription(): string {
    const userMessages = this.messages
      .filter(msg => msg.type === 'user')
      .map(msg => msg.content);
    
    return userMessages.join(' ');
  }

  /**
   * Get all conversation messages
   */
  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  /**
   * Reset the conversation
   */
  reset(): void {
    this.messages = [];
  }

  /**
   * Get the latest AI message
   */
  getLatestAIMessage(): ConversationMessage | null {
    const aiMessages = this.messages.filter(msg => msg.type === 'ai');
    return aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : null;
  }

  /**
   * Get the latest user message
   */
  getLatestUserMessage(): ConversationMessage | null {
    const userMessages = this.messages.filter(msg => msg.type === 'user');
    return userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
  }

  /**
   * Check if conversation has any messages
   */
  hasMessages(): boolean {
    return this.messages.length > 0;
  }

  /**
   * Get the initial description (first user message)
   */
  getInitialDescription(): string {
    const firstUserMessage = this.messages.find(msg => msg.type === 'user');
    return firstUserMessage ? firstUserMessage.content : '';
  }

  /**
   * Get question-answer pairs from the conversation
   */
  getQuestionAnswerPairs(): QuestionAnswerPair[] {
    const pairs: QuestionAnswerPair[] = [];
    
    for (let i = 0; i < this.messages.length - 1; i++) {
      const currentMessage = this.messages[i];
      const nextMessage = this.messages[i + 1];
      
      // Skip the first user message (initial description)
      if (i === 0 && currentMessage.type === 'user') {
        continue;
      }
      
      if (currentMessage.type === 'ai' && nextMessage.type === 'user') {
        pairs.push({
          question: currentMessage.content,
          answer: nextMessage.content,
        });
      }
    }
    
    return pairs;
  }

  /**
   * Get the latest AI message with answer options
   */
  getLatestAIMessageWithOptions(): ConversationMessage | null {
    const aiMessages = this.messages.filter(msg => msg.type === 'ai');
    const latestAI = aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : null;
    return latestAI && latestAI.answerOptions ? latestAI : null;
  }

  /**
   * Generate a unique ID for messages
   */
  private generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}