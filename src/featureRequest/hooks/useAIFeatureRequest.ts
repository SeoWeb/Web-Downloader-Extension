import { useState, useCallback } from "react";
import { ConversationManager } from "../utils/conversationManager";
import {
  analyzeFeatureDescription,
  isCompleteAIResponse,
  hasAIQuestion,
  hasAnswerOptions,
  getLatestQuestion,
} from "../utils/aiApi";
import { FeatureRequest } from "../utils/api";

export type AIFeatureRequestStage =
  | "input"
  | "analyzing"
  | "conversation"
  | "preview"
  | "submitting";

interface AIFeatureRequestState {
  stage: AIFeatureRequestStage;
  conversation: ConversationManager;
  generatedData: Partial<FeatureRequest> | null;
  isLoading: boolean;
  error: string | null;
}

export function useAIFeatureRequest() {
  const [state, setState] = useState<AIFeatureRequestState>({
    stage: "input",
    conversation: new ConversationManager(),
    generatedData: null,
    isLoading: false,
    error: null,
  });

  /**
   * Start AI analysis with initial description
   */
  const startAnalysis = useCallback(async (description: string) => {
    if (!description.trim()) {
      setState((prev) => ({
        ...prev,
        error: "Please provide a description of your feature idea.",
      }));
      return;
    }

    setState((prev) => ({
      ...prev,
      stage: "analyzing",
      isLoading: true,
      error: null,
    }));

    try {
      // Add initial user message to conversation
      const newConversation = new ConversationManager();
      newConversation.addUserMessage(description);

      const response = await analyzeFeatureDescription(description);

      if (isCompleteAIResponse(response)) {
        // AI has enough information to generate the form
        setState((prev) => ({
          ...prev,
          stage: "preview",
          conversation: newConversation,
          generatedData: {
            title: response.title,
            description: response.description,
            useCase: response.use_case,
            proposedSolution: response.solution,
          },
          isLoading: false,
        }));
      } else if (hasAIQuestion(response)) {
        // AI needs more information - handle array response
        const latestQuestion = getLatestQuestion(response);
        if (latestQuestion) {
          if (hasAnswerOptions(response)) {
            newConversation.addAIMessageWithOptions(
              latestQuestion.question,
              latestQuestion.answer_options!,
            );
          } else {
            newConversation.addAIMessage(latestQuestion.question);
          }
        }
        setState((prev) => ({
          ...prev,
          stage: "conversation",
          conversation: newConversation,
          isLoading: false,
        }));
      } else {
        // Unexpected response format
        throw new Error("Invalid AI response format");
      }
    } catch (error) {
      console.error("AI analysis failed:", error);
      setState((prev) => ({
        ...prev,
        stage: "input",
        isLoading: false,
        error: "AI analysis failed. Please try again or use the manual form.",
      }));
    }
  }, []);

  /**
   * Continue conversation with user response
   */
  const continueConversation = useCallback(
    async (userResponse: string) => {
      if (!userResponse.trim()) {
        setState((prev) => ({ ...prev, error: "Please provide a response." }));
        return;
      }

      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }));

      try {
        // Add user response to conversation
        const updatedConversation = new ConversationManager();
        state.conversation.getMessages().forEach((msg) => {
          if (msg.type === "user") {
            updatedConversation.addUserMessage(msg.content);
          } else {
            updatedConversation.addAIMessage(msg.content);
          }
        });
        updatedConversation.addUserMessage(userResponse);

        // Get initial description and question-answer pairs
        const initialDescription = updatedConversation.getInitialDescription();
        const questionAnswerPairs =
          updatedConversation.getQuestionAnswerPairs();
        const response = await analyzeFeatureDescription(
          initialDescription,
          questionAnswerPairs,
        );

        if (isCompleteAIResponse(response)) {
          // AI now has enough information
          setState((prev) => ({
            ...prev,
            stage: "preview",
            conversation: updatedConversation,
            generatedData: {
              title: response.title,
              description: response.description,
              useCase: response.use_case,
              proposedSolution: response.solution,
            },
            isLoading: false,
          }));
        } else if (hasAIQuestion(response)) {
          // AI needs more information - handle array response
          const latestQuestion = getLatestQuestion(response);
          if (latestQuestion) {
            if (hasAnswerOptions(response)) {
              updatedConversation.addAIMessageWithOptions(
                latestQuestion.question,
                latestQuestion.answer_options!,
              );
            } else {
              updatedConversation.addAIMessage(latestQuestion.question);
            }
          }
          setState((prev) => ({
            ...prev,
            conversation: updatedConversation,
            isLoading: false,
          }));
        } else {
          throw new Error("Invalid AI response format");
        }
      } catch (error) {
        console.error("Conversation continuation failed:", error);
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: "Failed to process your response. Please try again.",
        }));
      }
    },
    [state.conversation],
  );

  /**
   * Update generated data
   */
  const updateGeneratedData = useCallback((data: Partial<FeatureRequest>) => {
    setState((prev) => ({
      ...prev,
      generatedData: { ...prev.generatedData, ...data },
    }));
  }, []);

  /**
   * Regenerate form with AI using current conversation
   */
  const regenerateWithAI = useCallback(async () => {
    if (!state.conversation.hasMessages()) {
      setState((prev) => ({
        ...prev,
        error: "No conversation history to regenerate from.",
      }));
      return;
    }

    setState((prev) => ({
      ...prev,
      stage: "analyzing",
      isLoading: true,
      error: null,
    }));

    try {
      const initialDescription = state.conversation.getInitialDescription();
      const questionAnswerPairs = state.conversation.getQuestionAnswerPairs();
      const response = await analyzeFeatureDescription(
        initialDescription,
        questionAnswerPairs,
      );

      if (isCompleteAIResponse(response)) {
        setState((prev) => ({
          ...prev,
          stage: "preview",
          generatedData: {
            title: response.title,
            description: response.description,
            useCase: response.use_case,
            proposedSolution: response.solution,
          },
          isLoading: false,
        }));
      } else {
        throw new Error("AI could not generate complete data");
      }
    } catch (error) {
      console.error("Regeneration failed:", error);
      setState((prev) => ({
        ...prev,
        stage: "preview",
        isLoading: false,
        error: "Failed to regenerate with AI. Please edit manually.",
      }));
    }
  }, [state.conversation]);

  /**
   * Reset to initial state
   */
  const reset = useCallback(() => {
    setState({
      stage: "input",
      conversation: new ConversationManager(),
      generatedData: null,
      isLoading: false,
      error: null,
    });
  }, []);

  /**
   * Switch to manual form mode
   */
  const switchToManual = useCallback(() => {
    setState((prev) => ({
      ...prev,
      stage: "input",
      error: null,
    }));
  }, []);

  /**
   * Clear error
   */
  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  /**
   * Set submitting state
   */
  const setSubmitting = useCallback((submitting: boolean) => {
    setState((prev) => ({
      ...prev,
      stage: submitting ? "submitting" : "preview",
    }));
  }, []);

  return {
    stage: state.stage,
    conversation: state.conversation,
    generatedData: state.generatedData,
    isLoading: state.isLoading,
    error: state.error,
    startAnalysis,
    continueConversation,
    updateGeneratedData,
    regenerateWithAI,
    reset,
    switchToManual,
    clearError,
    setSubmitting,
  };
}
