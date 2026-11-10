import { downloadBrowserPDF, openBrowserPDFStream } from "./browserPDF";
import { IdentifierError, normalizeDOI } from "./identifier";
import type { PDFCandidate } from "./pdf";
import { getDOIPublisher } from "./publishers";

/**
 * Download a DOI-verified Science article through the shared Chrome profile.
 *
 * Args:
 *   item: Zotero parent with an AAAS DOI.
 * Returns:
 *   A validated temporary PDF candidate owned by the caller.
 */
export function downloadSciencePDF(item: Zotero.Item): Promise<PDFCandidate> {
  const doi = normalizeDOI(item.getField("DOI"));
  if (!doi || getDOIPublisher(doi) !== "science-family")
    throw new IdentifierError(
      "INVALID_DOI",
      "Science download requires an AAAS DOI",
    );
  const win = Zotero.getMainWindow();
  const encodedDOI = doi.split("/").map(encodeURIComponent).join("/");
  const articleURL = `https://www.science.org/doi/${encodedDOI}`;
  const pdfURL = `https://www.science.org/doi/pdf/${encodedDOI}?download=true`;
  // Prevent DOI path components from changing the requested publisher route.
  if (
    decodeURIComponent(new win.URL(articleURL).pathname).toLowerCase() !==
    `/doi/${doi}`
  )
    throw new IdentifierError(
      "INVALID_DOI",
      "Science DOI has an unsupported path",
    );
  return downloadBrowserPDF(
    {
      source: "science",
      timeoutMs: 60_000,
      timeoutMessage: "Science download timed out after 60 seconds",
    },
    async (context) => {
      const { browser } = context;
      const { sessionId, save } = await openBrowserPDFStream(context, {
        publisher: "Science",
        pdfURL,
        rejectRedirects: true,
      });
      const articleStarted = Date.now();
      await browser.command("Page.navigate", { url: articleURL }, sessionId);
      const page = await browser.readArticle(
        sessionId,
        doi,
        "Science",
        "publication_doi",
      );
      const finalURL = new win.URL(page.url);
      const finalPath = decodeURIComponent(finalURL.pathname).toLowerCase();
      if (
        finalURL.origin !== "https://www.science.org" ||
        finalURL.username ||
        finalURL.password ||
        ![`/doi/${doi}`, `/doi/abs/${doi}`, `/doi/full/${doi}`].includes(
          finalPath,
        )
      )
        throw new IdentifierError(
          "UNEXPECTED_PUBLISHER",
          "Science article URL does not match the requested DOI",
        );
      const articleMs = Date.now() - articleStarted;
      const pdfStarted = Date.now();
      await save();
      return { url: pdfURL, articleMs, pdfStarted };
    },
  );
}
