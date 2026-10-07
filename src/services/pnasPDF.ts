import { IdentifierError, normalizeDOI } from "./identifier";
import { createPDFTemp, stagePDF, PDFCandidate, validatePDF } from "./pdf";
import { DownloadTask } from "./downloadTask";
import { ChromeSession } from "./chromeSession";

// Only one task may own the plugin's shared Chrome profile at a time.
let queue: Promise<unknown> = Promise.resolve();
const cancellations = new Set<() => void>();

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

/** Cancel plugin-owned downloads on shutdown, preserving the Chrome profile. */
export function stopPNASDownloads(): void {
  for (const cancel of cancellations) cancel();
}

/**
 * Stage a DOI-matched PNAS PDF through a dedicated Chrome process.
 *
 * Args:
 *   item: Existing parent whose DOI must match publisher metadata.
 * Returns:
 *   A validated temporary PDF; its caller owns cleanup. Queueing, startup,
 *   and download share one 20-second budget.
 */
export async function downloadPNASPDF(
  item: Zotero.Item,
): Promise<PDFCandidate> {
  const doi = normalizeDOI(item.getField("DOI"));
  if (!doi || !/^10\.1073\/pnas\./.test(doi))
    throw new IdentifierError("INVALID_DOI", "Unsupported PNAS DOI");
  const win = Zotero.getMainWindow();
  let challenge = false;
  const pdfURL = "https://www.pnas.org/doi/pdf/" + doi;
  const pdfDownloadURL = pdfURL + "?download=true";
  let download: { guid: string; state?: string } | undefined;
  const task = new DownloadTask(
    (error) => browser.cancel(error),
    () =>
      new IdentifierError(
        challenge ? "NEEDS_BROWSER_ACCESS" : "PNAS_TIMEOUT",
        "PNAS fallback timed out after 20 seconds" +
          (challenge
            ? "; publisher browser verification did not complete"
            : ""),
      ),
  );
  const browser = new ChromeSession(task);
  const shutdown = () => task.cancel(new Error("PNAS download stopped"));
  cancellations.add(shutdown);

  const operation = queue.then(async (): Promise<PDFCandidate> => {
    task.check();
    const temporary = createPDFTemp("pnas");
    const directory = Zotero.File.pathToFile(temporary.path).parent!;
    return stagePDF(temporary, async () => {
      try {
        await browser.start(directory, (message) => {
          if (
            message.method === "Browser.downloadWillBegin" &&
            message.params.url === pdfDownloadURL
          )
            download = message.params;
          if (
            message.method === "Browser.downloadProgress" &&
            message.params.guid === download?.guid
          )
            download = { ...download!, state: message.params.state };
        });
        await browser.command("Browser.setDownloadBehavior", {
          behavior: "allowAndName",
          downloadPath: directory.path,
          eventsEnabled: true,
        });
        const { targetId } = await browser.command("Target.createTarget", {
          url: "about:blank",
        });
        const { sessionId } = await browser.command("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const articleStarted = Date.now();
        await browser.command(
          "Page.navigate",
          { url: "https://www.pnas.org/doi/" + doi },
          sessionId,
        );
        let page: Record<string, string | undefined> | undefined;
        while (!page?.doi) {
          const response = await browser.command(
            "Runtime.evaluate",
            {
              expression:
                "({doi:document.querySelector('meta[name=citation_doi]')?.content,pdf:document.querySelector('meta[name=citation_pdf_url]')?.content,title:document.title,url:location.href})",
              returnByValue: true,
            },
            sessionId,
          );
          page = response.result?.value;
          challenge = /just a moment|请稍候|security verification/i.test(
            page?.title || "",
          );
          if (!page?.doi)
            await new Promise((resolve) => win.setTimeout(resolve, 250));
        }
        if (normalizeDOI(page.doi) !== doi)
          throw new IdentifierError(
            "DOI_MISMATCH",
            "PNAS page DOI does not match the parent item",
          );
        const url = new win.URL(page.url);
        if (url.protocol !== "https:" || url.hostname !== "www.pnas.org")
          throw new Error("PNAS article redirected to an unexpected publisher");
        const articleMs = Date.now() - articleStarted;
        if (page.pdf !== pdfURL)
          throw new Error("PNAS article has an unexpected PDF URL");
        const pdfStarted = Date.now();
        await browser.command(
          "Page.navigate",
          { url: pdfDownloadURL },
          sessionId,
        );
        while (download?.state !== "completed") {
          task.check();
          if (browser.exited)
            throw new Error("Dedicated Chrome exited during PDF download");
          if (download?.state === "canceled")
            throw new Error("Chrome canceled the PNAS PDF download");
          if (!download) {
            const response = await browser.command(
              "Runtime.evaluate",
              { expression: "document.title", returnByValue: true },
              sessionId,
            );
            challenge = /just a moment|请稍候|security verification/i.test(
              response.result?.value || "",
            );
          }
          await new Promise((resolve) => win.setTimeout(resolve, 100));
        }
        // The task directory, URL and browser event identify this download uniquely.
        if (!/^[a-f0-9-]{36}$/i.test(download.guid))
          throw new Error("Chrome returned an invalid download identifier");
        const file = directory.clone();
        file.append(download.guid);
        await validatePDF(file.path);
        task.check();
        file.moveTo(directory, "article.pdf");
        return {
          ...temporary,
          source: "pnas",
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
  queue = operation.catch(() => undefined);
  try {
    return await task.run(operation);
  } finally {
    cancellations.delete(shutdown);
  }
}
