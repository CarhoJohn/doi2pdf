import { IdentifierError, normalizeDOI } from "./identifier";
import { downloadBrowserPDF, openBrowserPDFStream } from "./browserPDF";
import type { PDFCandidate } from "./pdf";

/**
 * Verify an Annual Reviews article or PDF URL without retaining signed parameters.
 *
 * Args:
 *   value: Publisher URL to check.
 *   doi: Expected normalized DOI.
 *   pdf: Whether to match the delivery/PDF path instead of the article page.
 * Returns:
 *   True for the expected HTTPS article; other URLs raise an identity error.
 */
function matchesArticle(value: string, doi: string, pdf = false): boolean {
  const url = new (Zotero.getMainWindow().URL)(value);
  const path = decodeURIComponent(url.pathname).toLowerCase();
  const expected = pdf
    ? ["deliver", "docserver"].map(
        (route) => `/${route}/fulltext/${doi}/${doi.split("/")[1]}.pdf`,
      )
    : [`/content/journals/${doi}`];
  if (
    url.origin !== "https://www.annualreviews.org" ||
    url.username ||
    url.password ||
    !expected.includes(path)
  )
    throw new IdentifierError(
      "UNEXPECTED_PUBLISHER",
      "Annual Reviews URL does not match the requested article",
    );
  return true;
}

/**
 * Submit the article's PDF form and stream the authenticated response through Chrome.
 *
 * Args:
 *   item: Parent already identified as Annual Reviews from Crossref metadata.
 * Returns:
 *   A validated PDF candidate using the shared persistent profile and 60-second budget.
 */
export function downloadAnnualReviewsPDF(
  item: Zotero.Item,
): Promise<PDFCandidate> {
  const doi = normalizeDOI(item.getField("DOI"));
  if (!doi)
    throw new IdentifierError(
      "INVALID_DOI",
      "Annual Reviews download requires its DOI",
    );
  const articleURL = `https://www.annualreviews.org/content/journals/${doi}`;
  return downloadBrowserPDF(
    {
      source: "annualreviews",
      timeoutMs: 60_000,
      timeoutMessage: "Annual Reviews download timed out after 60 seconds",
    },
    async (context) => {
      const { browser } = context;
      const articleStarted = Date.now();
      const { sessionId, save } = await openBrowserPDFStream(context, {
        publisher: "Annual Reviews",
        errorPrefix: "ANNUALREVIEWS",
        pdfURL: `https://www.annualreviews.org/deliver/fulltext/${doi}/${doi.split("/")[1]}.pdf`,
        responsePattern: "https://www.annualreviews.org/*/fulltext/*.pdf*",
        matchesPDF: (url) => matchesArticle(url, doi, true),
        start: (session) =>
          browser.command(
            "Runtime.evaluate",
            {
              // Submit the real form in this tab, preserving hidden fields and cookies.
              expression: `(() => {
          const form = document.querySelector('a[aria-label="Download PDF"]').closest('form');
          form.target = '_self'; form.requestSubmit();
        })()`,
            },
            session,
          ),
      });
      await browser.command("Page.navigate", { url: articleURL }, sessionId);
      await browser.readArticle(sessionId, doi, "Annual Reviews");
      let page;
      do {
        const response = await browser.command(
          "Runtime.evaluate",
          {
            expression: `(() => {
          const form = document.querySelector('a[aria-label="Download PDF"]')?.closest('form');
          return {url:location.href,ready:document.readyState,formAction:form?.action,formMethod:form?.method};
        })()`,
            returnByValue: true,
          },
          sessionId,
        );
        page = response.result?.value;
        if (!page)
          throw new IdentifierError(
            "LOOKUP_FAILED",
            "Annual Reviews article could not be read",
          );
        // The citation DOI can arrive before the body/PDF form has been parsed.
        if (page.ready === "loading")
          await new Promise((resolve) =>
            Zotero.getMainWindow().setTimeout(resolve, 100),
          );
      } while (page.ready === "loading");
      matchesArticle(page.url, doi);
      if (page.formMethod?.toLowerCase() !== "post" || !page.formAction)
        throw new IdentifierError(
          "ANNUALREVIEWS_PDF_UNAVAILABLE",
          "Annual Reviews PDF POST form is missing",
        );
      matchesArticle(page.formAction, doi, true);
      const articleMs = Date.now() - articleStarted;
      const pdfStarted = Date.now();
      await save();
      // Record the stable article URL, not the expiring signed PDF URL.
      return { url: articleURL, articleMs, pdfStarted };
    },
  );
}
