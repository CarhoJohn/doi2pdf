/** Utilities for resolving identifiers and creating Zotero items. */

export class IdentifierError extends Error {
  /** Stable error code returned by the local API. */
  public readonly code: string;

  /**
   * Create an identifier workflow error.
   *
   * @param code Stable API error code.
   * @param message Human-readable error message.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "IdentifierError";
    this.code = code;
  }
}

/**
 * Normalize a DOI supplied as plain text or a DOI URL.
 *
 * @param value DOI text to normalize.
 * @returns A lowercase DOI, or null when the value is not a DOI.
 */
export function normalizeDOI(value: unknown): string | null {
  if (typeof value !== "string") return null;

  let doi = value.trim();
  doi = doi.replace(/^doi:\s*/i, "");
  doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  doi = doi.replace(/[\s.,;:)\]}]+$/g, "");

  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : null;
}

/**
 * Find a regular item in the user's library by exact DOI.
 *
 * @param doi Normalized or parseable DOI.
 * @returns Matching item, or null when no item exists.
 */
export async function findItemByDOI(doi: string): Promise<Zotero.Item | null> {
  const normalized = normalizeDOI(doi);
  if (!normalized) return null;

  const libraryID = Zotero.Libraries.userLibraryID;
  const items = (await Zotero.Items.getAll(libraryID)) as Zotero.Item[];
  return (
    items.find((item) => {
      if (item.isAttachment?.() || item.isNote?.()) return false;
      return normalizeDOI(item.getField("DOI")) === normalized;
    }) ?? null
  );
}

/**
 * Resolve a collection key to its numeric Zotero collection ID.
 *
 * @param collectionKey Optional collection key.
 * @returns Collection IDs suitable for Translate.Search, or false.
 */
export function resolveCollection(collectionKey?: unknown): number[] | false {
  if (
    collectionKey === undefined ||
    collectionKey === null ||
    collectionKey === ""
  ) {
    return false;
  }
  if (typeof collectionKey !== "string") {
    throw new IdentifierError(
      "COLLECTION_NOT_FOUND",
      "collectionKey must be a string",
    );
  }

  const collection = Zotero.Collections.getByLibraryAndKey(
    Zotero.Libraries.userLibraryID,
    collectionKey,
  );
  if (!collection) {
    throw new IdentifierError(
      "COLLECTION_NOT_FOUND",
      `Collection not found: ${collectionKey}`,
    );
  }
  return [collection.id];
}

/**
 * Add a single identifier through Zotero's built-in translator.
 *
 * @param identifier DOI, ISBN, PMID, or another Zotero-supported identifier.
 * @param collectionKey Optional destination collection key.
 * @returns The created regular item.
 */
export async function addByIdentifier(
  identifier: string,
  collectionKey?: string,
): Promise<Zotero.Item> {
  const identifiers = Zotero.Utilities.extractIdentifiers(identifier);
  if (!identifiers.length) {
    throw new IdentifierError(
      "INVALID_IDENTIFIER",
      "Could not parse identifier",
    );
  }

  const collections = resolveCollection(collectionKey);
  const translate = new Zotero.Translate.Search();
  translate.setIdentifier(identifiers[0]);
  const translators = await translate.getTranslators();
  if (!translators.length) {
    throw new IdentifierError(
      "LOOKUP_FAILED",
      "No translator found for identifier",
    );
  }

  translate.setTranslator(translators);
  const items = await translate.translate({
    libraryID: Zotero.Libraries.userLibraryID,
    collections,
    saveAttachments: true,
  });
  const item = (items as Zotero.Item[]).find(
    (candidate) => !candidate.isAttachment?.() && !candidate.isNote?.(),
  );
  if (!item) {
    throw new IdentifierError("LOOKUP_FAILED", "No item was created");
  }
  return item;
}

/**
 * Create a compact representation of a Zotero item for API responses.
 *
 * @param item Zotero regular item.
 * @returns Stable item fields exposed by the local API.
 */
export function summarizeItem(item: Zotero.Item) {
  return {
    id: item.id,
    key: item.key,
    title: item.getField("title") || "",
    doi: (normalizeDOI(item.getField("DOI")) ?? item.getField("DOI")) || "",
  };
}
