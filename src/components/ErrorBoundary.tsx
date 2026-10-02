import { Component, ErrorInfo, ReactNode } from "react";
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

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    if (error || errorInfo) {
      // ignore
    }
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-center">
          <h3 className="text-red-800 font-medium mb-2">
            Something went wrong
          </h3>
          <p className="text-red-600 text-sm mb-4">
            {this.state.error?.message || "An unexpected error occurred"}
          </p>
          <Button onClick={this.handleRetry} variant="secondary" size="sm">
            Try again
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
