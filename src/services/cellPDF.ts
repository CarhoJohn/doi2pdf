import { IdentifierError, normalizeDOI } from "./identifier";
import { CellArticle, cellPII, lookupCellArticle } from "./cellMetadata";
import { ChromeSession, queueChromeDownload } from "./chromeSession";
import { DownloadTask } from "./downloadTask";
import { createPDFTemp, PDFCandidate, stagePDF, validatePDF } from "./pdf";

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
  let paused: { requestId: string } | undefined;
  let navigationError: string | undefined;
  const task: DownloadTask = new DownloadTask(
    (error) => browser.cancel(error),
    () =>
      new IdentifierError(
        browser.challenge ? "NEEDS_BROWSER_ACCESS" : "CELL_TIMEOUT",
        "Cell download timed out after 60 seconds" +
          (browser.challenge
            ? "; publisher browser verification did not complete"
            : ""),
      ),
    60_000,
  );
  const browser = new ChromeSession(task);
  return queueChromeDownload(task, async () => {
    const temporary = createPDFTemp("cell");
    const directory = Zotero.File.pathToFile(temporary.path).parent!;
    return stagePDF(temporary, async () => {
      try {
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
        await browser.start(
          directory,
          (message) => {
            if (message.method !== "Fetch.requestPaused") return;
            const response = message.params;
            if (
              /^https?:\/\/(?:[^/]+\.)?sciencedirect\.com\//i.test(
                response.request.url,
              )
            ) {
              task.cancel(
                new IdentifierError(
                  "UNEXPECTED_PUBLISHER",
                  "Cell download attempted to redirect to ScienceDirect",
                ),
              );
              return;
            }
            const headers = new Map<string, string>(
              (response.responseHeaders || []).map(
                (header: { name: string; value: string }) => [
                  header.name.toLowerCase(),
                  header.value,
                ],
              ),
            );
            const type = headers.get("content-type") || "";
            if (
              response.request.url === pdfURL &&
              response.responseStatusCode === 200 &&
              (!type || /^application\/(?:pdf|octet-stream)(?:;|$)/i.test(type))
            ) {
              paused = response;
              return;
            }
            // Let a verification page render and refresh its clearance normally.
            const verification =
              headers.get("cf-mitigated")?.toLowerCase() === "challenge";
            browser.challenge ||= verification;
            if (
              response.request.url === pdfURL &&
              response.responseStatusCode >= 400 &&
              !verification
            ) {
              task.cancel(
                new IdentifierError(
                  "CELL_PDF_UNAVAILABLE",
                  `Cell refused PDF access (HTTP ${response.responseStatusCode})`,
                ),
              );
              return;
            }
            void browser
              .command(
                "Fetch.continueRequest",
                { requestId: response.requestId },
                message.sessionId,
              )
              .catch((error) => task.cancel(error));
          },
          true,
        );
        const { targetId } = await browser.command("Target.createTarget", {
          url: "about:blank",
          background: true,
        });
        await browser.minimize(targetId);
        const { sessionId } = await browser.command("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        await browser.command(
          "Fetch.enable",
          {
            patterns: [
              { urlPattern: "*://*.sciencedirect.com/*" },
              { urlPattern: "*://sciencedirect.com/*" },
              {
                urlPattern: "https://www.cell.com/action/showPdf?*",
                requestStage: "Response",
              },
            ],
          },
          sessionId,
        );
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
        // Read Chrome's authenticated response before its PDF viewer can open.
        // No save dialog, blob URL, copied cookies, or headless browser is needed.
        const navigation = browser
          .command("Page.navigate", { url: pdfURL }, sessionId)
          .then(
            (result) => {
              if (result.errorText && !/ERR_ABORTED/.test(result.errorText))
                navigationError = result.errorText;
            },
            () => undefined,
          );
        while (!paused) {
          task.check();
          if (navigationError)
            throw new Error(`Cell PDF navigation failed: ${navigationError}`);
          if (browser.exited)
            throw new Error("Dedicated Chrome exited during Cell PDF download");
          // A paused navigation can block Runtime.evaluate. Observe response
          // events here instead, so the stream can be read before page commit.
          await new Promise((resolve) => win.setTimeout(resolve, 100));
        }
        await browser.saveResponseBody(
          sessionId,
          paused.requestId,
          temporary.path,
        );
        await navigation;
        task.check();
        await validatePDF(temporary.path);
        task.check();
        return {
          ...temporary,
          source: "cell",
          url: pdfURL,
          timings: {
            articleMs,
            pdfMs: Date.now() - pdfStarted,
            totalMs: Date.now() - task.started,
          },
        };
      } finally {
        await browser.close();
      }
    });
  });
}
