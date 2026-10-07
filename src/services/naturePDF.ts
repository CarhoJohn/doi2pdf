import { normalizeDOI, IdentifierError } from "./identifier";
import { createPDFTemp, stagePDF, validatePDF, PDFCandidate } from "./pdf";
import { DownloadTask } from "./downloadTask";
import { DownloadProcess, DownloadSubprocess, readOutput } from "./subprocess";

/**
 * Recognize Nature's publisher domains for article and PDF URL checks.
 *
 * Args:
 *   host: Parsed URL hostname.
 * Returns:
 *   Whether the hostname belongs to nature.com.
 */
function isNatureHost(host: string): boolean {
  return host === "nature.com" || host.endsWith(".nature.com");
}

/**
 * Decide whether a DOI or publisher URL merits the Nature fallback.
 *
 * Args:
 *   item: Existing bibliographic item.
 * Returns:
 *   True for Nature URLs or Nature's DOI prefix; final pages are checked later.
 */
export function canFetchNaturePDF(item: Zotero.Item): boolean {
  const doi = normalizeDOI(item.getField("DOI"));
  if (doi?.startsWith("10.1038/")) return true;
  try {
    const host = new (Zotero.getMainWindow().URL)(String(item.getField("url")))
      .hostname;
    return isNatureHost(host);
  } catch {
    return false;
  }
}

/**
 * Fetch a DOI-matched Nature article and PDF via curl, without a shell.
 *
 * Args:
 *   item: Parent item whose DOI must match the publisher's metadata.
 * Returns:
 *   A validated temporary PDF and timings; the caller must invoke cleanup.
 */
export async function downloadNaturePDF(
  item: Zotero.Item,
): Promise<PDFCandidate> {
  const doi = normalizeDOI(item.getField("DOI"));
  if (!doi)
    throw new IdentifierError("INVALID_DOI", "Nature lookup requires a DOI");
  const win = Zotero.getMainWindow();
  const temporary = createPDFTemp("nature");
  const directory = Zotero.File.pathToFile(temporary.path).parent!;
  const article = directory.clone();
  article.append("article.html");
  const cookies = directory.clone();
  cookies.append("cookies.txt");
  let process: DownloadProcess | undefined;
  let subprocess: DownloadSubprocess;
  let command: string;
  const task = new DownloadTask(
    () => {
      if (process) void process.kill(0).catch(Zotero.logError);
    },
    () => new Error("Nature fallback timed out after 20 seconds"),
  );

  /**
   * Invoke curl with separate arguments and the remaining shared time budget.
   *
   * Args:
   *   url: HTTPS article or PDF URL.
   *   path: Private output file.
   * Returns:
   *   The final URL after redirects and this request's elapsed milliseconds.
   */
  async function request(url: string, path: string) {
    const remaining = task.check() / 1000;
    const begin = Date.now();
    // --disable must be first: ignore user curlrc files. Cookies are task-local.
    // Gecko's Subprocess launches Windows processes with CREATE_NO_WINDOW.
    const child = await subprocess.call({
      command,
      arguments: [
        "--disable",
        "--location",
        "--fail",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-redirs",
        "5",
        "--max-time",
        String(remaining),
        "--connect-timeout",
        String(Math.min(10, remaining)),
        "--cookie",
        cookies.path,
        "--cookie-jar",
        cookies.path,
        "--output",
        path,
        "--write-out",
        "%{url_effective}",
        "--",
        url,
      ],
      stderr: "pipe",
    });
    process = child;
    // Process startup may complete after the shared timer has already fired.
    if (task.error) await child.kill(0);
    const [finalURL, errors, result] = await Promise.all([
      readOutput(child.stdout),
      readOutput(child.stderr!),
      child.wait(),
    ]);
    process = undefined;
    if (result.exitCode === 28) task.cancel();
    task.check();
    if (result.exitCode !== 0)
      throw new Error(
        "curl failed (" + result.exitCode + "): " + errors.trim().slice(0, 500),
      );
    return { url: finalURL.trim(), ms: Date.now() - begin };
  }

  const operation = stagePDF(temporary, async (): Promise<PDFCandidate> => {
    try {
      ({ Subprocess: subprocess } = win.ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      ) as unknown as { Subprocess: DownloadSubprocess });
      if (Zotero.isWin) {
        // Use Windows' absolute system executable path, never a shell or cwd.
        const executable = win.Services.dirsvc
          .get("SysD", win.Ci.nsIFile)
          .clone();
        executable.append("curl.exe");
        if (!executable.exists())
          throw new Error(
            "curl.exe is missing from the Windows system directory",
          );
        command = executable.path;
      } else {
        command = await subprocess.pathSearch("curl");
      }
      // Resolve the publisher URL through DOI redirects instead of guessing its path.
      const page = await request("https://doi.org/" + doi, article.path);
      const finalURL = new win.URL(page.url);
      if (finalURL.protocol !== "https:" || !isNatureHost(finalURL.hostname))
        throw new Error("DOI did not resolve to a Nature article");
      const document = new win.DOMParser().parseFromString(
        await Zotero.File.getContentsAsync(article.path),
        "text/html",
      );
      const pageDOI = document
        .querySelector('meta[name="citation_doi"]')
        ?.getAttribute("content");
      if (normalizeDOI(pageDOI) !== doi)
        throw new Error(
          "Nature page DOI is missing or does not match the parent item",
        );
      const link =
        document
          .querySelector('meta[name="citation_pdf_url"]')
          ?.getAttribute("content") ||
        document
          .querySelector('a[data-track-action="download pdf"]')
          ?.getAttribute("href");
      if (!link) throw new Error("Nature article has no main PDF link");
      const pdfURL = new win.URL(link, finalURL);
      const allowedHost =
        isNatureHost(pdfURL.hostname) ||
        pdfURL.hostname === "media.springernature.com";
      if (pdfURL.protocol !== "https:" || !allowedHost)
        throw new Error("Nature PDF link has an unsupported publisher URL");
      const pdf = await request(pdfURL.href, temporary.path);
      await validatePDF(temporary.path);
      task.check();
      return {
        ...temporary,
        source: "nature",
        url: pdfURL.href,
        timings: {
          articleMs: page.ms,
          pdfMs: pdf.ms,
          totalMs: Date.now() - task.started,
        },
      };
    } finally {
      // A killed process releases files before cleanup; late results never import.
      if (process) await process.kill(0).catch(Zotero.logError);
    }
  });
  return task.run(operation);
}
