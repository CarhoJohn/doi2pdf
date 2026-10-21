import { IdentifierError, normalizeDOI } from "./identifier";
import { lookupCrossrefMetadata } from "./crossref";

/** A locally registered Cell or partner journal, independent of DOI patterns. */
export interface CellJournal {
  name: string;
  issns: string[];
  path: string;
  aliases: string[];
}

/** Verified journal identity and optional publisher article identifier. */
export interface CellArticle {
  journal: CellJournal;
  pii?: string;
  /** Reuse a completed Crossref lookup even when it did not contain a PII. */
  crossrefChecked?: boolean;
}

let registry: Promise<CellJournal[]> | undefined;

/**
 * Normalize explicit journal titles, including renamed journals' dash variants.
 *
 * Args:
 *   value: Publisher or translator journal title.
 * Returns:
 *   A string suitable for exact alias matching, without fuzzy DOI inference.
 */
function journalName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match bibliographic fields against the packaged journal table.
 *
 * Args:
 *   fields: Actual ISSNs, journal title and URL, never DOI substrings.
 * Returns:
 *   One unambiguous journal; conflicting positive identities raise an error.
 */
export async function matchCellJournal(fields: {
  issns?: unknown;
  title?: unknown;
  url?: unknown;
}): Promise<CellJournal | undefined> {
  if (!registry) {
    registry = (async () => {
      // XPI jar URIs need Gecko resource channels, not the HTTP URL parser.
      const data = JSON.parse(
        await Zotero.File.getResourceAsync(
          `${rootURI}content/data/cell-press-journals.json`,
        ),
      );
      if (
        data.schemaVersion !== 2 ||
        data.columns?.join(",") !== "name,issns,path,aliases,partner"
      )
        throw new IdentifierError(
          "CELL_REGISTRY_INVALID",
          "Unsupported Cell journal table",
        );
      return (
        data.journals as [string, string[], string, string[], boolean][]
      ).map(([name, issns, path, aliases]) => ({ name, issns, path, aliases }));
    })().catch((error) => {
      registry = undefined;
      throw error;
    });
  }
  const journals = await registry;
  const rawISSNs = Array.isArray(fields.issns) ? fields.issns : [fields.issns];
  const issns = rawISSNs
    .flatMap((value) =>
      typeof value === "string"
        ? value.match(/\b\d{4}-?\d{3}[\dX]\b/gi) || []
        : [],
    )
    .map((value) => value.replace(/-/g, "").toUpperCase());
  const titles = (Array.isArray(fields.title) ? fields.title : [fields.title])
    .filter((value): value is string => typeof value === "string")
    .map(journalName);
  let pathname = "";
  try {
    const url = new (Zotero.getMainWindow().URL)(String(fields.url));
    if (
      url.protocol === "https:" &&
      (url.hostname === "cell.com" || url.hostname === "www.cell.com")
    )
      pathname = url.pathname;
  } catch {
    /* Missing or non-URL bibliographic fields are normal. */
  }
  const matches = journals.filter(
    (journal) =>
      journal.issns.some((issn) => issns.includes(issn.replace(/-/g, ""))) ||
      [journal.name, ...journal.aliases].some((name) =>
        titles.includes(journalName(name)),
      ) ||
      pathname === `/${journal.path}` ||
      pathname.startsWith(`/${journal.path}/`),
  );
  if (matches.length > 1)
    throw new IdentifierError(
      "JOURNAL_MISMATCH",
      "Cell journal metadata identifies different journals",
    );
  return matches[0];
}

/**
 * Extract a publisher-issued PII from a URL or metadata string.
 *
 * Args:
 *   value: Explicit PII or publisher link; the URL is not fetched.
 * Returns:
 *   Canonical PII, or undefined for unrecognized structures.
 */
export function cellPII(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text: string;
  try {
    text = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  const formatted = text.match(/\bS\d{4}-\d{4}\(\d{2}\)\d{5}-\d\b/i)?.[0];
  if (formatted) return formatted.toUpperCase();
  return text
    .match(/\bS\d{16}\b/i)?.[0]
    .toUpperCase()
    .replace(/^S(\d{4})(\d{4})(\d{2})(\d{5})(\d)$/, "S$1-$2($3)$4-$5");
}

/**
 * Resolve real journal metadata and PII using a complete DOI as a lookup key.
 *
 * Args:
 *   doi: Normalized parent DOI, never used as a journal classification pattern.
 *   timeout: Remaining allowed metadata-request budget in milliseconds.
 *   known: Parent journal or earlier lookup to complete without querying twice.
 * Returns:
 *   A Cell article context, or undefined for another journal.
 */
export async function lookupCellArticle(
  doi: string,
  timeout = 5000,
  known?: CellArticle,
): Promise<CellArticle | undefined> {
  if (known?.pii || known?.crossrefChecked) return known;
  const metadata = await lookupCrossrefMetadata(doi, timeout);
  if (normalizeDOI(metadata?.DOI) !== doi)
    throw new IdentifierError(
      "DOI_MISMATCH",
      "Crossref metadata does not match the requested DOI",
    );
  const journal = await matchCellJournal({
    issns: metadata.ISSN,
    title: metadata["container-title"],
    url: metadata.resource?.primary?.URL,
  });
  if (known && journal?.path !== known.journal.path)
    throw new IdentifierError(
      "JOURNAL_MISMATCH",
      "Publisher metadata does not match the Cell parent journal",
    );
  if (!journal) return undefined;
  // Parse the links as data; do not follow Linking Hub or ScienceDirect.
  const links = [
    metadata.resource?.primary?.URL,
    ...(Array.isArray(metadata.link)
      ? metadata.link.map((link: { URL?: string }) => link.URL)
      : []),
  ];
  const piis = new Set(
    links.map(cellPII).filter((pii): pii is string => !!pii),
  );
  if (piis.size > 1)
    throw new IdentifierError(
      "PII_MISMATCH",
      "Publisher metadata contains conflicting PIIs",
    );
  return { journal, pii: [...piis][0], crossrefChecked: true };
}

/**
 * Identify a Cell parent before any generic full-text resolver starts.
 *
 * Args:
 *   item: Resolved bibliographic parent.
 * Returns:
 *   Local journal identity, or a bounded metadata lookup for incomplete items.
 */
export async function getCellArticle(
  item: Zotero.Item,
): Promise<CellArticle | undefined> {
  const issns = item.getField("ISSN");
  const title = item.getField("publicationTitle");
  const url = item.getField("url");
  const journal = await matchCellJournal({ issns, title, url });
  if (journal) return { journal, pii: cellPII(url) };
  if (issns) return undefined;
  const doi = normalizeDOI(item.getField("DOI"));
  if (!doi) return undefined;
  try {
    return await lookupCellArticle(doi);
  } catch (error) {
    // Conflicting identities are not an outage and must not fall through.
    if (error instanceof IdentifierError) throw error;
    // A metadata outage must not disable existing publishers' native resolvers.
    Zotero.logError(error as Error);
    return undefined;
  }
}
