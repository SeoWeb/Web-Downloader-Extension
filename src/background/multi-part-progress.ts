export interface MultiPartProgress {
  totalParts: number;
  currentPart: number;
  state: 'analyzing' | 'generating' | 'downloading' | 'complete' | 'failed';
  error?: string;
}

type ProgressCallback = (progress: MultiPartProgress) => void;

export class MultiPartProgressTracker {
  private progress: MultiPartProgress = {
    totalParts: 0,
    currentPart: 0,
    state: 'analyzing'
  };
  
  private onUpdate: ProgressCallback;

  constructor(onUpdate: ProgressCallback) {
    this.onUpdate = onUpdate;
  }

  setTotalParts(count: number) {
    this.progress.totalParts = count;
    this.notify();
  }

  startGenerating(partNumber: number) {
    this.progress.state = 'generating';
    this.progress.currentPart = partNumber;
    this.notify();
  }

  startDownloading(partNumber: number) {
    this.progress.state = 'downloading';
    this.progress.currentPart = partNumber;
    this.notify();
  }

  complete() {
    this.progress.state = 'complete';
    this.notify();
  }

  fail(error: string) {
    this.progress.state = 'failed';
    this.progress.error = error;
    this.notify();
  }

  private notify() {
    this.onUpdate({ ...this.progress });
  }
}
