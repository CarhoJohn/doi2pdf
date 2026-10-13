import type { PDFCandidate } from "./pdf";

/** Allow publisher startup and PDF transfer to share a 30-second budget. */
export const PDF_FALLBACK_TIMEOUT_MS = 30_000;

/** Own a fallback deadline, cancellation, and cleanup of late PDF results. */
export class DownloadTask {
  readonly started = Date.now();
  private readonly win = Zotero.getMainWindow();
  /** First cancellation reason; unset while the task may still complete. */
  error?: Error;
  private readonly timer: number;
  private reject!: (error: Error) => void;
  private readonly cancellation = new Promise<never>((_, reject) => {
    this.reject = reject;
  });

  /**
   * Start the whole-task timer before any queued or asynchronous work.
   *
   * Args:
   *   onCancel: Stop only resources owned by this task.
   *   timeoutError: Build the publisher-specific timeout error.
   *   timeoutMs: Whole-task budget; existing publishers default to 30 seconds.
   */
  constructor(
    private readonly onCancel: (error: Error) => void,
    private readonly timeoutError: () => Error,
    private readonly timeoutMs = PDF_FALLBACK_TIMEOUT_MS,
  ) {
    // Initialize after the chosen budget is assigned, before any queued work.
    this.timer = this.win.setTimeout(() => this.cancel(), timeoutMs);
  }

  /**
   * Check that work may continue.
   *
   * Returns:
   *   Milliseconds remaining, or throws the cancellation reason.
   */
  check(): number {
    const remaining = this.started + this.timeoutMs - Date.now();
    if (remaining <= 0) this.cancel();
    if (this.error) throw this.error;
    return remaining;
  }

  /**
   * Cancel once and notify the owner to close its process or connection.
   *
   * Args:
   *   error: Explicit cancellation reason; defaults to the timeout error.
   */
  cancel(error = this.timeoutError()): void {
    if (this.error) return;
    this.error = error;
    this.reject(error);
    this.onCancel(error);
  }

  /**
   * Race staged work against cancellation and dispose of late PDF results.
   *
   * Args:
   *   operation: Work responsible for releasing processes and failed files.
   * Returns:
   *   A candidate whose successful cleanup belongs to the caller.
   */
  run(operation: Promise<PDFCandidate>): Promise<PDFCandidate> {
    return Promise.race([
      operation.then((candidate) => {
        if (this.error) candidate.cleanup();
        return candidate;
      }),
      this.cancellation,
    ]).finally(() => this.win.clearTimeout(this.timer));
  }
}
