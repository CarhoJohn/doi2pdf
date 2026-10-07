import { normalizeDOI } from "./identifier";
import {
  createPDFTemp,
  getPDFAttachment,
  importPDF,
  validatePDF,
  PDFCandidate,
} from "./pdf";
import { canFetchNaturePDF, downloadNaturePDF } from "./naturePDF";
import { canFetchPNASPDF, downloadPNASPDF } from "./pnasPDF";

export const NATIVE_WAIT_MS = 15_000;
export type FullTextStatus = "found" | "not_found" | "failed";
export interface FullTextResult {
  status: FullTextStatus;
  attachmentID?: number;
  attachmentKey?: string;
  source?: "existing" | PDFCandidate["source"];
  code?: string;
  timings?: PDFCandidate["timings"];
  message?: string;
  attempts?: {
    source: PDFCandidate["source"];
    status: string;
    message?: string;
    code?: string;
  }[];
}

interface DownloadOutcome {
  candidate?: PDFCandidate;
  message?: string;
  code?: string;
}

/** The native methods exist in Zotero 9/10 but bundled typings lag behind. */
interface NativeDownloader {
  getFileResolvers?: (item: Zotero.Item, methods?: string[]) => unknown[];
  getPDFResolvers: (item: Zotero.Item, methods?: string[]) => unknown[];
  downloadFirstAvailableFile: (
    resolvers: unknown[],
    path: string,
    options: {
      enforceFileType: boolean;
      shouldDisplayCaptcha: boolean;
      onBeforeRequest: () => void;
    },
  ) => Promise<false | { url: string }>;
}

/** Deduplicate full-text work by parent, including requests from both endpoints. */
const tasks = new Map<string, Promise<FullTextResult>>();

/**
 * Download through Zotero resolvers without letting them create attachments.
 *
 * Args:
 *   item: Existing parent item.
 *   methods: Optional native resolver order.
 *   isClosed: Whether the owning task has already finished.
 * Returns:
 *   A validated temporary candidate, or undefined when no PDF is found.
 */
async function downloadNativePDF(
  item: Zotero.Item,
  methods: string[] | undefined,
  isClosed: () => boolean,
): Promise<PDFCandidate | undefined> {
  const temporary = createPDFTemp("native");
  let succeeded = false;
  try {
    const native = Zotero.Attachments as unknown as NativeDownloader;
    const resolver = native.getFileResolvers ?? native.getPDFResolvers;
    const result = await native.downloadFirstAvailableFile(
      resolver.call(
        Zotero.Attachments,
        item,
        methods?.length ? methods : undefined,
      ),
      temporary.path,
      {
        enforceFileType: true,
        shouldDisplayCaptcha: false,
        onBeforeRequest: () => {
          if (isClosed()) throw new Error("Full-text task already finished");
        },
      },
    );
    if (!result || !result.url) return undefined;
    await validatePDF(temporary.path);
    succeeded = true;
    return { ...temporary, source: "native", url: result.url };
  } finally {
    if (!succeeded) temporary.cleanup();
  }
}

/**
 * Coordinate native and publisher downloads, committing only one attachment.
 *
 * Args:
 *   item: Parent resolved before the 15-second download timer starts.
 *   methods: Optional native resolver order.
 * Returns:
 *   PDF status, attachment identifiers, and download-route diagnostics.
 */
async function resolveFullText(
  item: Zotero.Item,
  methods?: string[],
): Promise<FullTextResult> {
  let closed = false;
  let timer: number | undefined;
  let native: Promise<DownloadOutcome> | undefined;
  let fallback: Promise<DownloadOutcome> | undefined;
  const win = Zotero.getMainWindow();
  const attempts: NonNullable<FullTextResult["attempts"]> = [];
  const expectedDOI = normalizeDOI(item.getField("DOI")) ?? undefined;
  const fallbackSource = canFetchPNASPDF(item)
    ? "pnas"
    : canFetchNaturePDF(item)
      ? "nature"
      : undefined;
  try {
    const existing = await getPDFAttachment(item);
    if (existing)
      return {
        status: "found",
        source: "existing",
        attachmentID: existing.id,
        attachmentKey: existing.key,
      };
    native = downloadNativePDF(item, methods, () => closed).then(
      (candidate) => ({ candidate }),
      (error) => ({ message: error?.message || String(error) }),
    );
    let outcome: DownloadOutcome;
    if (fallbackSource) {
      // A timer observes the task; it does not cancel or detach the parent item.
      const threshold = new Promise<undefined>((resolve) => {
        timer = win.setTimeout(() => resolve(undefined), NATIVE_WAIT_MS);
      });
      const initial = await Promise.race([native, threshold]);
      win.clearTimeout(timer);
      if (initial?.candidate) {
        outcome = initial;
      } else {
        attempts.push({
          source: "native",
          status: initial?.message
            ? "failed"
            : initial
              ? "not_found"
              : "timeout",
          message: initial?.message,
        });
        fallback = (
          fallbackSource === "pnas"
            ? downloadPNASPDF(item)
            : downloadNaturePDF(item)
        ).then(
          (candidate) => ({ candidate }),
          (error) => ({
            message: error?.message || String(error),
            code: error?.code,
          }),
        );
        // A late native success may still win during the 20-second fallback budget.
        // Native failures never suppress a running publisher attempt.
        const nativeSuccess = native.then((result) =>
          result.candidate ? result : new Promise<DownloadOutcome>(() => {}),
        );
        outcome = await Promise.race([nativeSuccess, fallback]);
      }
    } else {
      outcome = await native;
    }
    const candidate = outcome.candidate;
    if (!candidate) {
      attempts.push({
        source: fallback ? fallbackSource! : "native",
        status: outcome.message ? "failed" : "not_found",
        message: outcome.message,
        code: outcome.code,
      });
      return {
        status: outcome.message ? "failed" : "not_found",
        message: outcome.message,
        attempts,
        code: outcome.code,
      };
    }
    // Both routes and manual PDF imports use the same per-item write lock.
    const attachment = await importPDF(
      item,
      candidate.path,
      expectedDOI,
      candidate.url,
    );
    attempts.push({ source: candidate.source, status: "found" });
    return {
      status: "found",
      source: candidate.source,
      attachmentID: attachment.id,
      attachmentKey: attachment.key,
      timings: candidate.timings,
      attempts,
    };
  } catch (error) {
    Zotero.logError(error as Error);
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      attempts,
    };
  } finally {
    closed = true;
    win.clearTimeout(timer);
    // Each route owns its private directory. Late results only discard files.
    for (const pending of [native, fallback]) {
      if (pending) void pending.then((result) => result.candidate?.cleanup());
    }
  }
}

/**
 * Share one PDF retrieval task for concurrent calls concerning the same item.
 *
 * Args:
 *   item: Existing regular item.
 *   methods: Optional resolver order; the first concurrent caller chooses it.
 * Returns:
 *   Structured result after native retrieval or a publisher fallback.
 */
export async function findFullText(
  item: Zotero.Item,
  methods?: string[],
): Promise<FullTextResult> {
  const key = `${item.libraryID}/${item.key}`;
  const pending = tasks.get(key);
  if (pending) return pending;
  const operation = resolveFullText(item, methods);
  tasks.set(key, operation);
  try {
    return await operation;
  } finally {
    tasks.delete(key);
  }
}
