import { IdentifierError, normalizeDOI } from "./identifier";
import {
  createPDFTemp,
  getPluginDataDirectory,
  PDFCandidate,
  validatePDF,
} from "./pdf";
import { DownloadTask } from "./downloadTask";
import { DownloadProcess, DownloadSubprocess, readOutput } from "./subprocess";

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

type ChromeClasses = Record<
  string,
  { createInstance: (iid: unknown) => unknown }
>;

/**
 * Locate installed Chrome without a shell or using the user's profile.
 *
 * Args:
 *   subprocess: Gecko's native process launcher.
 * Returns:
 *   The executable's absolute path, or a CHROME_NOT_FOUND error.
 */
async function findChrome(subprocess: DownloadSubprocess): Promise<string> {
  const win = Zotero.getMainWindow();
  if (Zotero.isWin) {
    // App Paths covers user-selected installation locations as well as defaults.
    for (const hive of [
      "ROOT_KEY_CURRENT_USER",
      "ROOT_KEY_LOCAL_MACHINE",
    ] as const) {
      let registry: nsIWindowsRegKey | undefined;
      try {
        registry = (win.Components.classes as unknown as ChromeClasses)[
          "@mozilla.org/windows-registry-key;1"
        ].createInstance(win.Ci.nsIWindowsRegKey) as nsIWindowsRegKey;
        registry.open(
          registry[hive]!,
          "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
          registry.ACCESS_READ!,
        );
        const path = registry.readStringValue("");
        const file = Zotero.File.pathToFile(path);
        if (file.exists() && file.isFile()) return file.path;
      } catch {
        // A missing App Paths entry is normal for some Chrome installations.
      } finally {
        registry?.close();
      }
    }
    for (const key of ["ProgF", "ProgF86", "LocalAppData"]) {
      try {
        const file = win.Services.dirsvc.get(key, win.Ci.nsIFile).clone();
        for (const part of ["Google", "Chrome", "Application", "chrome.exe"])
          file.append(part);
        if (file.exists() && file.isFile()) return file.path;
      } catch {
        // Not all Windows installations expose every directory-service key.
      }
    }
  } else {
    const mac = Zotero.File.pathToFile(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    if (Zotero.isMac && mac.exists()) return mac.path;
    for (const name of ["google-chrome", "google-chrome-stable", "chrome"]) {
      try {
        return await subprocess.pathSearch(name);
      } catch {
        /* Try the next installed Chrome name. */
      }
    }
  }
  throw new IdentifierError(
    "CHROME_NOT_FOUND",
    "PNAS fallback requires installed Google Chrome",
  );
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
  let child: DownloadProcess | undefined;
  let exit: Promise<unknown> | undefined;
  let childExited = false;
  let closing = false;
  let socket: WebSocket | undefined;
  let nextID = 0;
  let challenge = false;
  const pdfURL = "https://www.pnas.org/doi/pdf/" + doi;
  const pdfDownloadURL = pdfURL + "?download=true";
  let download: { guid: string; state?: string } | undefined;
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();
  const task = new DownloadTask(
    (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      if (socket && socket.readyState < 2) socket.close();
      if (child && !childExited) void child.kill(0).catch(Zotero.logError);
    },
    () =>
      new IdentifierError(
        challenge ? "NEEDS_BROWSER_ACCESS" : "PNAS_TIMEOUT",
        "PNAS fallback timed out after 20 seconds" +
          (challenge
            ? "; publisher browser verification did not complete"
            : ""),
      ),
  );
  const shutdown = () => task.cancel(new Error("PNAS download stopped"));
  cancellations.add(shutdown);

  /**
   * Send a CDP request, retaining its response until resolved or canceled.
   *
   * Args:
   *   method: Protocol method.
   *   params: Protocol request parameters.
   *   sessionId: Optional owned page session.
   * Returns:
   *   The protocol response.
   */
  async function command(
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<any> {
    task.check();
    const id = ++nextID;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // The executor rejects send errors; closing the connection clears pending requests.
      socket!.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  const operation = queue.then(async (): Promise<PDFCandidate> => {
    task.check();
    const temporary = createPDFTemp("pnas");
    const directory = Zotero.File.pathToFile(temporary.path).parent!;
    let succeeded = false;
    try {
      const { Subprocess } = win.ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      ) as unknown as { Subprocess: DownloadSubprocess };
      const executable = await findChrome(Subprocess);
      task.check();
      // Reserve a nonzero loopback port, preserving the existing browser flags.
      const reservation = (win.Components.classes as unknown as ChromeClasses)[
        "@mozilla.org/network/server-socket;1"
      ].createInstance(win.Ci.nsIServerSocket) as nsIServerSocket;
      reservation.init(-1, true, 1);
      const port = reservation.port;
      reservation.close();
      child = await Subprocess.call({
        command: executable,
        arguments: [
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=" + port,
          // System-principal Gecko windows may send the opaque origin "null".
          "--remote-allow-origins=" +
            [...new Set([win.location.origin, "null"])].join(","),
          "--user-data-dir=" + getPluginDataDirectory("chrome_profile").path,
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        stderr: "stdout",
        environmentAppend: true,
        environment: { TEMP: directory.path, TMP: directory.path },
      });
      void readOutput(child.stdout, false).catch(Zotero.logError);
      exit = child.wait().then(
        () => {
          childExited = true;
        },
        (error) => task.cancel(error),
      );
      // Startup can finish after the timer; terminate that late child as well.
      if (task.error) await child.kill(0);
      let version: { webSocketDebuggerUrl: string } | undefined;
      while (!version) {
        const remaining = task.check();
        if (childExited)
          throw new IdentifierError(
            "CHROME_PROFILE_BUSY",
            "Dedicated Chrome exited before connecting; its profile may already be in use",
          );
        try {
          const response = await Zotero.HTTP.request(
            "GET",
            "http://127.0.0.1:" + port + "/json/version",
            { timeout: Math.min(1000, remaining) },
          );
          version = JSON.parse(response.responseText);
        } catch {
          await new Promise((resolve) => win.setTimeout(resolve, 100));
        }
      }
      task.check();
      const address = new win.URL(version.webSocketDebuggerUrl);
      if (
        address.protocol !== "ws:" ||
        address.hostname !== "127.0.0.1" ||
        address.port !== String(port)
      )
        throw new Error("Chrome returned an unexpected debugger address");
      const connection: WebSocket = (socket = new win.WebSocket(address.href));
      connection.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) request?.reject(new Error(message.error.message));
          else request?.resolve(message.result);
        }
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
      };
      await new Promise<void>((resolve, reject) => {
        connection.onopen = () => resolve();
        connection.onerror = () =>
          reject(new Error("Cannot connect to dedicated Chrome"));
        connection.onclose = () => {
          const error = new Error("Dedicated Chrome disconnected");
          // Reject startup too: a canceled connection must release the profile queue.
          reject(error);
          for (const request of pending.values()) request.reject(error);
          pending.clear();
          if (!closing) task.cancel(error);
        };
      });
      await command("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: directory.path,
        eventsEnabled: true,
      });
      const { targetId } = await command("Target.createTarget", {
        url: "about:blank",
      });
      const { sessionId } = await command("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const articleStarted = Date.now();
      await command(
        "Page.navigate",
        { url: "https://www.pnas.org/doi/" + doi },
        sessionId,
      );
      let page: Record<string, string | undefined> | undefined;
      while (!page?.doi) {
        const response = await command(
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
      await command("Page.navigate", { url: pdfDownloadURL }, sessionId);
      while (download?.state !== "completed") {
        task.check();
        if (childExited)
          throw new Error("Dedicated Chrome exited during PDF download");
        if (download?.state === "canceled")
          throw new Error("Chrome canceled the PNAS PDF download");
        if (!download) {
          const response = await command(
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
      succeeded = true;
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
      try {
        closing = true;
        if (child && !childExited) {
          // Allow a short profile flush before terminating the owned child.
          if (!task.error && socket?.readyState === 1)
            void command("Browser.close").catch(() => undefined);
          await Promise.race([
            exit,
            new Promise((resolve) => win.setTimeout(resolve, 1000)),
          ]);
          if (!childExited) await child.kill(0).catch(Zotero.logError);
        }
        socket?.close();
      } finally {
        if (!succeeded || task.error) temporary.cleanup();
      }
    }
  });
  queue = operation.catch(() => undefined);
  try {
    return await task.run(operation);
  } finally {
    cancellations.delete(shutdown);
  }
}
