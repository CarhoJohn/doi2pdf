import {
  IdentifierError,
  normalizeDOI,
  resolveDestinationCollection,
} from "./identifier";

/** Bibliographic fields shared by publisher identification and item creation. */
export interface CrossrefMetadata {
  DOI: string;
  publisher?: string;
  title?: string[];
  "container-title"?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  ISSN?: string[];
  abstract?: string;
  resource?: { primary?: { URL?: string } };
  link?: { URL?: string }[];
}

// Reuse one bounded lookup across ingestion and Cell/Annual Reviews routing.
const records = new Map<
  string,
  { expires: number; request: Promise<CrossrefMetadata> }
>();

/**
 * Retrieve DOI-matched metadata shared by the publisher routes.
 * Args:
 *   doi: Complete normalized DOI.
 *   timeout: Network timeout in milliseconds.
 * Returns:
 *   Metadata cached for five minutes, up to 64 records.
 */
export function lookupCrossrefMetadata(
  doi: string,
  timeout = 5000,
): Promise<CrossrefMetadata> {
  const cached = records.get(doi);
  if (cached && cached.expires > Date.now()) return cached.request;
  records.delete(doi);
  if (records.size >= 64) records.delete(records.keys().next().value!);
  const request = (async () => {
    const response = await Zotero.HTTP.request(
      "GET",
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      { timeout },
    );
    const metadata = JSON.parse(response.responseText)
      .message as CrossrefMetadata;
    if (normalizeDOI(metadata?.DOI) !== doi)
      throw new IdentifierError(
        "DOI_MISMATCH",
        "Crossref metadata does not match the requested DOI",
      );
    return metadata;
  })();
  records.set(doi, { expires: Date.now() + 300_000, request });
  // A transient API outage must not become a persistent negative classification.
  void request.catch(() => {
    if (records.get(doi)?.request === request) records.delete(doi);
  });
  return request;
}

/**
 * Identify Annual Reviews from the API publisher field.
 * Args:
 *   doi: Complete normalized DOI.
 * Returns:
 *   Its record, or undefined for another publisher or a network failure.
 */
export async function lookupAnnualReviewsMetadata(
  doi: string,
): Promise<CrossrefMetadata | undefined> {
  try {
    const metadata = await lookupCrossrefMetadata(doi);
    return metadata.publisher?.trim().toLowerCase() === "annual reviews"
      ? metadata
      : undefined;
  } catch (error) {
    if (error instanceof IdentifierError) throw error;
    Zotero.logError(error as Error);
    return undefined;
  }
}

/**
 * Save API metadata using Zotero's native CSL converter.
 * Args:
 *   metadata: DOI-matched record from the expected publisher.
 *   collectionKey: Destination collection, or the configured default.
 * Returns:
 *   The saved journal article.
 */
export async function createCrossrefItem(
  metadata: CrossrefMetadata,
  collectionKey?: unknown,
): Promise<Zotero.Item> {
  if (!metadata.title?.[0] || !metadata["container-title"]?.[0])
    throw new IdentifierError(
      "LOOKUP_FAILED",
      "Crossref title or journal is missing",
    );
  const collections = await resolveDestinationCollection(collectionKey);
  const item = new Zotero.Item("journalArticle");
  item.libraryID = Zotero.Libraries.userLibraryID;
  // Crossref REST uses arrays for titles/ISSNs; normalize only these CSL differences.
  Zotero.Utilities.Item.itemFromCSLJSON(item, {
    ...metadata,
    type: "article-journal",
    DOI: normalizeDOI(metadata.DOI)!,
    title: Zotero.Utilities.cleanTags(metadata.title[0]),
    "container-title": metadata["container-title"][0],
    URL: metadata.resource?.primary?.URL || `https://doi.org/${metadata.DOI}`,
    ISSN: metadata.ISSN?.join(" "),
    abstract: metadata.abstract
      ? Zotero.Utilities.cleanTags(metadata.abstract)
      : undefined,
    author: metadata.author?.map((author) =>
      author.name ? { literal: author.name } : author,
    ),
  });
  item.setField("libraryCatalog", "Crossref");
  if (collections !== false) item.setCollections(collections);
  await item.saveTx();
  return item;
}
