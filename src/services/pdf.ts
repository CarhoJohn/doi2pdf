import { IdentifierError, normalizeDOI } from "./identifier";

export interface PDFCandidate {
  path: string;
  source: "native" | "nature" | "pnas";
  url?: string;
  timings?: { articleMs: number; pdfMs: number; totalMs: number };
  cleanup: () => void;
}

/**
 * Resolve plugin-owned runtime data under Zotero's configured data directory.
 *
 * Args:
 *   child: Optional plugin subdirectory, never an arbitrary path.
 * Returns:
 *   A writable native directory; existing Zotero storage is not modified.
 */
export function getPluginDataDirectory(child?: "chrome_profile" | "downloads") {
  const directory = Zotero.File.pathToFile(Zotero.DataDirectory.dir).clone();
  directory.append("doi2pdf");
  if (!directory.exists()) directory.create(1, 0o700);
  if (child) {
    directory.append(child);
    if (!directory.exists()) directory.create(1, 0o700);
  }
  return directory;
}

/** Serialize attachment writes for each parent across all plugin endpoints. */
const imports = new Map<string, Promise<Zotero.Item>>();

/**
 * Find an existing PDF whose backing file is accessible.
 *
 * Args:
 *   item: Parent bibliographic item.
 * Returns:
 *   The first available PDF attachment, or undefined.
 */
export async function getPDFAttachment(item: Zotero.Item) {
  for (const id of item.getAttachments()) {
    const attachment = Zotero.Items.get(id) as Zotero.Item;
    if (!attachment || attachment.deleted || !attachment.isPDFAttachment())
      continue;
    const path = await attachment.getFilePathAsync();
    if (path && Zotero.File.pathToFile(path).exists()) return attachment;
  }
  return undefined;
}

/**
 * Validate a local file before creating an attachment record.
 *
 * Args:
 *   path: Absolute path on the Zotero host.
 * Returns:
 *   A native file object; invalid paths and non-PDF files raise IdentifierError.
 */
export async function validatePDF(path: string): Promise<nsIFile> {
  if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path)) {
    throw new IdentifierError("INVALID_PDF", "pdfPath must be absolute");
  }
  // nsIFile rejects forward slashes on Windows even though API clients use them.
  let file: nsIFile;
  try {
    file = Zotero.File.pathToFile(
      Zotero.isWin ? path.replace(/\//g, "\\") : path,
    );
  } catch {
    throw new IdentifierError(
      "INVALID_PDF",
      "pdfPath is not a valid local file path",
    );
  }
  if (!file.exists() || !file.isFile() || file.fileSize === 0) {
    throw new IdentifierError("INVALID_PDF", "PDF file is missing or empty");
  }
  // Inspect bytes, not the extension or an HTTP 200 response carrying HTML.
  const sample = await Zotero.File.getBinaryContentsAsync(file, 1024);
  if (!/^\s*%PDF-\d\.\d/.test(sample)) {
    throw new IdentifierError("INVALID_PDF", "File does not have a PDF header");
  }
  return file;
}

/**
 * Copy a PDF into Zotero storage under an existing, DOI-checked parent.
 *
 * Args:
 *   item: Existing regular item; this function never creates a parent.
 *   path: PDF file to copy; the caller's source file is preserved.
 *   expectedDOI: DOI expected on the parent at the time of import.
 *   sourceURL: Optional download URL recorded on the new attachment.
 * Returns:
 *   The imported attachment, or an already available PDF.
 */
export async function importPDF(
  item: Zotero.Item,
  path: string,
  expectedDOI?: string,
  sourceURL?: string,
): Promise<Zotero.Item> {
  const key = `${item.libraryID}/${item.key}`;
  const doi = normalizeDOI(expectedDOI);
  // Await another writer, then recheck the file and parent independently.
  while (imports.has(key)) {
    await imports.get(key)!.catch(() => undefined);
  }
  const operation = (async () => {
    const parent = Zotero.Items.getByLibraryAndKey(item.libraryID, item.key);
    if (!parent || parent.deleted || !parent.isRegularItem()) {
      throw new IdentifierError("ITEM_NOT_FOUND", "Parent item is unavailable");
    }
    if (
      expectedDOI !== undefined &&
      (!doi || normalizeDOI(parent.getField("DOI")) !== doi)
    ) {
      throw new IdentifierError(
        "DOI_MISMATCH",
        "Parent DOI does not match expectedDOI",
      );
    }
    const existing = await getPDFAttachment(parent);
    if (existing) return existing;
    const file = await validatePDF(path);
    const attachment = await Zotero.Attachments.importFromFile({
      file: file.path,
      parentItemID: parent.id,
      contentType: "application/pdf",
    });
    if (sourceURL) {
      attachment.setField("url", sourceURL);
      await attachment.saveTx();
    }
    return attachment;
  })();
  imports.set(key, operation);
  try {
    return await operation;
  } finally {
    imports.delete(key);
  }
}

/**
 * Create an isolated task directory inside the plugin's runtime data.
 *
 * Args:
 *   source: Name of the download route, for local diagnostics.
 * Returns:
 *   The private directory, PDF path, and an idempotent cleanup callback.
 */
export function createPDFTemp(source: string) {
  const directory = getPluginDataDirectory("downloads");
  directory.append(`doi2pdf-${source}-${Zotero.Utilities.randomString(12)}`);
  directory.create(1, 0o700);
  const file = directory.clone();
  file.append("article.pdf");
  return {
    path: file.path,
    cleanup() {
      try {
        if (directory.exists()) directory.remove(true);
      } catch (error) {
        Zotero.logError(error as Error);
      }
    },
  };
}

/**
 * Transfer temporary-file ownership only after download and teardown succeed.
 *
 * Args:
 *   temporary: Private files allocated for this route.
 *   operation: Download and validation; release processes before it settles.
 * Returns:
 *   The candidate owned by the caller, or undefined after cleaning a miss.
 */
export async function stagePDF<T extends PDFCandidate | undefined>(
  temporary: ReturnType<typeof createPDFTemp>,
  operation: () => Promise<T>,
): Promise<T> {
  let candidate: T | undefined;
  try {
    candidate = await operation();
    return candidate;
  } finally {
    // Exceptions, including teardown failures, must not leave task directories.
    if (!candidate) temporary.cleanup();
  }
}
