import { IdentifierError } from "./identifier";
import { getPluginDataDirectory } from "./pdf";
import { DownloadTask } from "./downloadTask";
import { DownloadProcess, DownloadSubprocess, readOutput } from "./subprocess";

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

/** A publisher-independent CDP event from the owned browser connection. */
export interface ChromeEvent {
  method: string;
  params: any;
}

/** Own Chrome startup, CDP requests, and teardown for a download task. */
export class ChromeSession {
  private readonly win = Zotero.getMainWindow();
  private child?: DownloadProcess;
  private exit?: Promise<unknown>;
  private socket?: WebSocket;
  private closing = false;
  private nextID = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();
  exited = false;

  /**
   * Bind the session to the caller's deadline and cancellation.
   *
   * Args:
   *   task: Download task whose budget includes browser startup.
   */
  constructor(private readonly task: DownloadTask) {}

  /**
   * Reject outstanding requests and stop only this session's resources.
   *
   * Args:
   *   error: Reason the requests cannot finish.
   */
  cancel(error: Error): void {
    this.rejectRequests(error);
    if (this.socket && this.socket.readyState < 2) this.socket.close();
    if (this.child && !this.exited)
      void this.child.kill(0).catch(Zotero.logError);
  }

  /**
   * Release callers waiting on replies that can no longer arrive.
   *
   * Args:
   *   error: Cancellation or connection failure shared by outstanding requests.
   */
  private rejectRequests(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  /**
   * Launch installed Chrome and connect to its loopback debugger.
   *
   * Args:
   *   directory: Private task directory for Chrome's temporary files.
   *   onEvent: Publisher callback for CDP events, excluding command replies.
   */
  async start(
    directory: nsIFile,
    onEvent: (event: ChromeEvent) => void,
  ): Promise<void> {
    const win = this.win;
    const { Subprocess } = win.ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    ) as unknown as { Subprocess: DownloadSubprocess };
    const executable = await findChrome(Subprocess);
    this.task.check();
    // Reserve a nonzero loopback port, preserving the existing browser flags.
    const reservation = (win.Components.classes as unknown as ChromeClasses)[
      "@mozilla.org/network/server-socket;1"
    ].createInstance(win.Ci.nsIServerSocket) as nsIServerSocket;
    reservation.init(-1, true, 1);
    const port = reservation.port;
    reservation.close();
    this.child = await Subprocess.call({
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
    void readOutput(this.child.stdout, false).catch(Zotero.logError);
    this.exit = this.child.wait().then(
      () => {
        this.exited = true;
      },
      (error) => this.task.cancel(error),
    );
    // Startup can finish after the timer; terminate that late child as well.
    if (this.task.error) await this.child.kill(0);
    let version: { webSocketDebuggerUrl: string } | undefined;
    while (!version) {
      const remaining = this.task.check();
      if (this.exited)
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
    this.task.check();
    const address = new win.URL(version.webSocketDebuggerUrl);
    if (
      address.protocol !== "ws:" ||
      address.hostname !== "127.0.0.1" ||
      address.port !== String(port)
    )
      throw new Error("Chrome returned an unexpected debugger address");
    const connection: WebSocket = (this.socket = new win.WebSocket(
      address.href,
    ));
    connection.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error.message));
        else request?.resolve(message.result);
      } else {
        onEvent(message);
      }
    };
    await new Promise<void>((resolve, reject) => {
      connection.onopen = () => resolve();
      connection.onerror = () =>
        reject(new Error("Cannot connect to dedicated Chrome"));
      connection.onclose = () => {
        const error = new Error("Dedicated Chrome disconnected");
        // Reject startup too so cancellation releases the shared-profile queue.
        reject(error);
        this.rejectRequests(error);
        if (!this.closing) this.task.cancel(error);
      };
    });
  }

  /**
   * Send a CDP request and retain its response until resolved or canceled.
   *
   * Args:
   *   method: Protocol method.
   *   params: Protocol request parameters.
   *   sessionId: Optional owned page session.
   * Returns:
   *   The protocol response.
   */
  async command(
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<any> {
    this.task.check();
    const id = ++this.nextID;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket!.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        // A failed send has no response; remove its entry immediately.
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Close the owned browser, allowing a short profile flush before killing it. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.child && !this.exited) {
      if (!this.task.error && this.socket?.readyState === 1)
        void this.command("Browser.close").catch(() => undefined);
      await Promise.race([
        this.exit,
        new Promise((resolve) => this.win.setTimeout(resolve, 1000)),
      ]);
      if (!this.exited) await this.child.kill(0).catch(Zotero.logError);
    }
    this.socket?.close();
  }
}
