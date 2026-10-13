import { IdentifierError, normalizeDOI } from "./identifier";
import type { PDFCandidate } from "./pdf";
import { downloadBrowserPDF, openBrowserPDFStream } from "./browserPDF";

/**
 * Identify PNAS main-journal DOIs; PNAS Nexus uses another platform.
 *
 * Args:
 *   item: Existing bibliographic parent.
 * Returns:
 *   Whether this publisher route supports its DOI.
 */
export function canFetchPNASPDF(item: Zotero.Item): boolean {
  return /^10\.1073\/pnas\./.test(normalizeDOI(item.getField("DOI")) || "");
}

/**
 * Stage a DOI-matched PNAS PDF from a dedicated Chrome response stream.
 *
 * Args:
 *   item: Existing parent whose DOI must match publisher metadata.
 * Returns:
 *   A validated temporary PDF; its caller owns cleanup. Queueing, startup,
 *   and download share one 30-second budget.
 */
export async function downloadPNASPDF(
  item: Zotero.Item,
): Promise<PDFCandidate> {
  const doi = normalizeDOI(item.getField("DOI"));
  if (!doi || !/^10\.1073\/pnas\./.test(doi))
    throw new IdentifierError("INVALID_DOI", "Unsupported PNAS DOI");
  const win = Zotero.getMainWindow();
  const pdfURL = "https://www.pnas.org/doi/pdf/" + doi;
  const pdfDownloadURL = pdfURL + "?download=true";
  return downloadBrowserPDF(
    {
      source: "pnas",
      timeoutMs: 30_000,
      timeoutMessage: "PNAS fallback timed out after 30 seconds",
    },
    async (context) => {
      const { browser } = context;
      const { sessionId, save } = await openBrowserPDFStream(context, {
        publisher: "PNAS",
        pdfURL: pdfDownloadURL,
      });
      const articleStarted = Date.now();
      await browser.command(
        "Page.navigate",
        { url: "https://www.pnas.org/doi/" + doi },
        sessionId,
      );
      const page = await browser.readArticle(sessionId, doi, "PNAS");
      const url = new win.URL(page.url);
      if (url.protocol !== "https:" || url.hostname !== "www.pnas.org")
        throw new Error("PNAS article redirected to an unexpected publisher");
      const articleMs = Date.now() - articleStarted;
      if (page.pdf !== pdfURL)
        throw new Error("PNAS article has an unexpected PDF URL");
      const pdfStarted = Date.now();
      // Consume the authenticated response before Chrome opens its PDF viewer.
      await save();
      return {
        url: pdfURL,
        articleMs,
        pdfStarted,
      };
    },
  );
}
