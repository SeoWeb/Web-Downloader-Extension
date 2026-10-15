import { Component, ErrorInfo, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  name?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * (5.6) Localized fallback UI. Lives outside the class component so it can
 * use the `useTranslation` hook (hooks are not available in class
 * components). Raw error details are never shown to users — they are
 * logged to the console instead.
 */
function LocalizedErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-center">
      <h3 className="text-red-800 font-medium mb-2">
        {t("app.somethingWentWrong")}
      </h3>
      <p className="text-red-600 text-sm mb-4">{t("app.unexpectedError")}</p>
      <Button onClick={onRetry} variant="secondary" size="sm">
        {t("app.tryAgain")}
      </Button>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // (5.6) Log full details for debugging; the UI only shows a generic,
    // localized message.
    console.error(
      `[ErrorBoundary${this.props.name ? `:${this.props.name}` : ""}]`,
      error,
      errorInfo,
    );
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return <LocalizedErrorFallback onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}
