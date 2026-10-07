import type { PDFCandidate } from "./pdf";

/** Publisher fallback budget, including queueing and process startup. */
export const PDF_FALLBACK_TIMEOUT_MS = 20_000;

/** Own a fallback deadline, cancellation, and cleanup of late PDF results. */
export class DownloadTask {
  readonly started = Date.now();
  private readonly win = Zotero.getMainWindow();
  /** First cancellation reason; unset while the task may still complete. */
  error?: Error;
  private readonly timer = this.win.setTimeout(
    () => this.cancel(),
    PDF_FALLBACK_TIMEOUT_MS,
  );
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
   */
  constructor(
    private readonly onCancel: (error: Error) => void,
    private readonly timeoutError: () => Error,
  ) {}

  /**
   * Check that work may continue.
   *
   * Returns:
   *   Milliseconds remaining, or throws the cancellation reason.
   */
  check(): number {
    const remaining = this.started + PDF_FALLBACK_TIMEOUT_MS - Date.now();
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
