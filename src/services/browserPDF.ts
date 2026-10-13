import { ChromeSession, queueChromeDownload } from "./chromeSession";
import { DownloadTask } from "./downloadTask";
import { IdentifierError } from "./identifier";
import { createPDFTemp, PDFCandidate, stagePDF, validatePDF } from "./pdf";

interface BrowserPDFOptions {
  source: "pnas" | "cell";
  timeoutMs: number;
  timeoutMessage: string;
}

interface BrowserPDFContext {
  task: DownloadTask;
  browser: ChromeSession;
  temporary: ReturnType<typeof createPDFTemp>;
  directory: nsIFile;
}

interface PDFStreamOptions {
  publisher: "PNAS" | "Cell";
  pdfURL: string;
  blockedHosts?: string[];
}

/**
 * Open minimized Chrome and intercept the publisher's authenticated PDF stream.
 *
 * Args:
 *   context: Browser and private file resources owned by the download task.
 *   options: Expected PDF URL and publisher-specific blocked redirect hosts.
 * Returns:
 *   The page session and a saver to call after verifying article identity.
 */
export async function openBrowserPDFStream(
  { task, browser, temporary, directory }: BrowserPDFContext,
  { publisher, pdfURL, blockedHosts = [] }: PDFStreamOptions,
): Promise<{ sessionId: string; save: () => Promise<void> }> {
  const win = Zotero.getMainWindow();
  let paused: { requestId: string } | undefined;
  await browser.start(
    directory,
    (message) => {
      if (message.method !== "Fetch.requestPaused") return;
      const response = message.params;
      const host = new win.URL(response.request.url).hostname;
      if (
        blockedHosts.some(
          (blocked) => host === blocked || host.endsWith(`.${blocked}`),
        )
      ) {
        task.cancel(
          new IdentifierError(
            "UNEXPECTED_PUBLISHER",
            `${publisher} download attempted to redirect to ${host}`,
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
      const verification =
        headers.get("cf-mitigated")?.toLowerCase() === "challenge";
      browser.challenge ||= verification;
      if (
        response.request.url === pdfURL &&
        response.responseStatusCode === 200 &&
        !verification &&
        (!type || /^application\/(?:pdf|octet-stream)(?:;|$)/i.test(type))
      ) {
        paused = response;
        return;
      }
      if (
        response.request.url === pdfURL &&
        response.responseStatusCode >= 400 &&
        !verification
      ) {
        task.cancel(
          new IdentifierError(
            `${publisher.toUpperCase()}_PDF_UNAVAILABLE`,
            `${publisher} refused PDF access (HTTP ${response.responseStatusCode})`,
          ),
        );
        return;
      }
      // Let verification pages and redirects continue instead of consuming HTML.
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
  // Streaming owns the file write; unexpected redirects must not save elsewhere.
  await browser.command("Browser.setDownloadBehavior", { behavior: "deny" });
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
        ...blockedHosts.flatMap((host) => [
          { urlPattern: `*://${host}/*` },
          { urlPattern: `*://*.${host}/*` },
        ]),
        { urlPattern: pdfURL, requestStage: "Response" },
      ],
    },
    sessionId,
  );

  /**
   * Read the matched response to EOF before releasing its paused navigation.
   *
   * Returns:
   *   Completion after all response bytes have reached the private PDF file.
   */
  async function save(): Promise<void> {
    let navigationError: string | undefined;
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
        throw new Error(
          `${publisher} PDF navigation failed: ${navigationError}`,
        );
      if (browser.exited)
        throw new Error(
          `Dedicated Chrome exited during ${publisher} PDF download`,
        );
      // Runtime.evaluate may block while PDF navigation is paused; observe events.
      await new Promise((resolve) => win.setTimeout(resolve, 100));
    }
    await browser.saveResponseBody(sessionId, paused.requestId, temporary.path);
    await navigation;
  }
  return { sessionId, save };
}

/**
 * Own the shared deadline, profile queue, PDF staging and browser teardown.
 *
 * Args:
 *   options: Publisher identity and whole-task timeout diagnostics.
 *   operation: Publisher transport that writes the private article.pdf file.
 * Returns:
 *   A validated candidate; its caller owns cleanup after browser teardown.
 */
export function downloadBrowserPDF(
  options: BrowserPDFOptions,
  operation: (
    context: BrowserPDFContext,
  ) => Promise<{ url: string; articleMs: number; pdfStarted: number }>,
): Promise<PDFCandidate> {
  // Start the deadline before queueing, including publisher metadata lookup.
  const task: DownloadTask = new DownloadTask(
    (error) => browser.cancel(error),
    () =>
      new IdentifierError(
        browser.challenge
          ? "NEEDS_BROWSER_ACCESS"
          : `${options.source.toUpperCase()}_TIMEOUT`,
        options.timeoutMessage +
          (browser.challenge
            ? "; publisher browser verification did not complete"
            : ""),
      ),
    options.timeoutMs,
  );
  const browser = new ChromeSession(task);
  return queueChromeDownload(task, async () => {
    const temporary = createPDFTemp(options.source);
    const directory = Zotero.File.pathToFile(temporary.path).parent!;
    return stagePDF(temporary, async () => {
      try {
        const result = await operation({ task, browser, temporary, directory });
        task.check();
        await validatePDF(temporary.path);
        task.check();
        return {
          ...temporary,
          source: options.source,
          url: result.url,
          timings: {
            articleMs: result.articleMs,
            // Include validation in transfer timing, as the publisher routes did.
            pdfMs: Date.now() - result.pdfStarted,
            totalMs: Date.now() - task.started,
          },
        };
      } finally {
        // Release Chrome before staged files transfer to the caller or are removed.
        await browser.close();
      }
    });
  });
}
