import { API_URLS } from "../../common/apiConstants.js";

interface AIAnalysisRequest {
  description: string;
  questions?: Array<{
    question: string;
    answer: string;
  }>;
}

interface AIQuestionResponse {
  question: string;
  answer_options?: string[];
  answer?: string;
}

interface AICompleteResponse {
  title: string;
  description: string;
  use_case: string;
  solution?: string;
}

type AIAnalysisResponse = AIQuestionResponse[] | AICompleteResponse;

/**
 * Analyze feature description using AI service
 */
export async function analyzeFeatureDescription(
  description: string,
  questions?: Array<{ question: string; answer: string }>,
): Promise<AIAnalysisResponse> {
  try {
    const requestBody: AIAnalysisRequest = {
      description: description.trim(),
    };

    if (questions && questions.length > 0) {
      requestBody.questions = questions;
    }

    const response = await fetch(API_URLS.AI_FEATURE_ANALYSIS, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`AI API request failed: ${response.statusText}`);
    }

    const data: AIAnalysisResponse = await response.json();
    return data;
  } catch (error) {
    console.error("Error analyzing feature description:", error);
    throw error;
  }
}

/**
 * Check if AI response contains complete feature request data
 */
export function isCompleteAIResponse(
  response: AIAnalysisResponse,
): response is AICompleteResponse {
  return (
    !Array.isArray(response) &&
    "title" in response &&
    "description" in response &&
    "use_case" in response
  );
}

/**
 * Check if AI response contains a follow-up question
 */
export function hasAIQuestion(response: AIAnalysisResponse): boolean {
  if (Array.isArray(response)) {
    return response.length > 0 && "question" in response[response.length - 1];
  }
  return false;
}

/**
 * Check if AI response contains answer options
 */
export function hasAnswerOptions(response: AIAnalysisResponse): boolean {
  if (Array.isArray(response)) {
    const lastItem = response[response.length - 1];
    return !!(
      lastItem &&
      "answer_options" in lastItem &&
      lastItem.answer_options &&
      lastItem.answer_options.length > 0
    );
  }
  return false;
}

/**
 * Get the latest question from AI response
 */
export function getLatestQuestion(
  response: AIAnalysisResponse,
): AIQuestionResponse | null {
  if (Array.isArray(response) && response.length > 0) {
    return response[response.length - 1];
  }
  return null;
}

/**
 * Get all conversation history from AI response
 */
export function getConversationHistory(
  response: AIAnalysisResponse,
): AIQuestionResponse[] {
  if (Array.isArray(response)) {
    return response;
  }
  return [];
}
