import { IdentifierError, normalizeDOI } from "./identifier";
import { CellArticle, cellPII, lookupCellArticle } from "./cellMetadata";
import { downloadBrowserPDF, openBrowserPDFStream } from "./browserPDF";
import type { PDFCandidate } from "./pdf";

/**
 * Download a DOI-checked Cell PDF through minimized, persistent headed Chrome.
 *
 * Args:
 *   item: Existing parent whose DOI will be checked again before import.
 *   article: Journal identity determined from metadata, not DOI patterns.
 * Returns:
 *   A validated PDF candidate after the complete browser response reaches EOF.
 *   Queueing, PII lookup, startup and download share a 60-second budget.
 */
export async function downloadCellPDF(
  item: Zotero.Item,
  article: CellArticle,
): Promise<PDFCandidate> {
  const doi = normalizeDOI(item.getField("DOI"));
  if (!doi)
    throw new IdentifierError(
      "INVALID_DOI",
      "Cell download requires a parent DOI",
    );
  const win = Zotero.getMainWindow();
  return downloadBrowserPDF(
    {
      source: "cell",
      timeoutMs: 60_000,
      timeoutMessage: "Cell download timed out after 60 seconds",
    },
    async (context) => {
      const { task, browser } = context;
      const resolved = await lookupCellArticle(
        doi,
        Math.min(5000, task.check()),
        article,
      );
      task.check();
      if (!resolved?.pii)
        throw new IdentifierError(
          "PII_NOT_FOUND",
          "No publisher PII was found for this DOI",
        );
      const { journal, pii } = resolved;
      const articleURL = `https://www.cell.com/${journal.path}/fulltext/${pii}`;
      const pdf = new win.URL("https://www.cell.com/action/showPdf");
      pdf.searchParams.set("pii", pii);
      const pdfURL = pdf.href;
      const { sessionId, save } = await openBrowserPDFStream(context, {
        publisher: "Cell",
        pdfURL,
        blockedHosts: ["sciencedirect.com"],
      });
      const articleStarted = Date.now();
      await browser.command("Page.navigate", { url: articleURL }, sessionId);
      const page = await browser.readArticle(sessionId, doi, "Cell");
      const finalURL = new win.URL(page.url);
      if (
        finalURL.protocol !== "https:" ||
        finalURL.hostname !== "www.cell.com" ||
        !finalURL.pathname.startsWith(`/${journal.path}/`) ||
        cellPII(finalURL.href) !== pii
      )
        throw new IdentifierError(
          "UNEXPECTED_PUBLISHER",
          "Cell article has an unexpected publisher URL or PII",
        );
      if (page.pdf) {
        const advertised = new win.URL(page.pdf, finalURL);
        if (
          advertised.protocol !== "https:" ||
          advertised.hostname !== "www.cell.com" ||
          cellPII(advertised.href) !== pii
        )
          throw new IdentifierError(
            "PII_MISMATCH",
            "Cell article advertises an unexpected PDF",
          );
      }
      const articleMs = Date.now() - articleStarted;
      const pdfStarted = Date.now();
      await save();
      return {
        url: pdfURL,
        articleMs,
        pdfStarted,
      };
    },
  );
}
