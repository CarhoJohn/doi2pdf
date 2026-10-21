import { test } from "node:test";
import assert from "node:assert/strict";
import { atob, Buffer } from "node:buffer";
import vm from "node:vm";
import process from "node:process";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { TextEncoder } from "node:util";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";

const bundle = buildSync({
  stdin: {
    contents: `export * from './src/services/fullText';
      export * from './src/services/pdf';
      export * from './src/services/pnasPDF';
      export * from './src/services/chromeSession';
      export * from './src/services/cellMetadata';
      export * from './src/services/cellPDF';
      export * from './src/services/annualReviewsPDF';
      export * from './src/services/crossref';
      export * from './src/endpoints/importPDF';
      export * from './src/endpoints/addDOI';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "cjs",
  platform: "neutral",
  write: false,
}).outputFiles[0].text;
const DOI = "10.1038/s42256-026-01281-1";
const PDF = "%PDF-1.4\nfixture";
const PNAS_DOI = "10.1073/pnas.2515233123";
const CELL_DOI = "10.1016/j.isci.2026.117391";
const CELL_PII = "S2589-0042(26)02769-0";
const ANNUAL_DOI = "10.1146/annurev-psych-032526-071359";
const ANNUAL_URL =
  "https://www.annualreviews.org/content/journals/" + ANNUAL_DOI;
const ANNUAL_PDF = `https://www.annualreviews.org/docserver/fulltext/${ANNUAL_DOI}/${ANNUAL_DOI.split("/")[1]}.pdf?expires=123&checksum=fixture`;
const ANNUAL_METADATA = {
  DOI: ANNUAL_DOI,
  publisher: "Annual Reviews",
  resource: { primary: { URL: ANNUAL_URL } },
  title: ["Understanding Understanding"],
  "container-title": ["Annual Review of Psychology"],
  author: [{ given: "Timothy T.", family: "Rogers" }],
  ISSN: ["0066-4308", "1545-2085"],
  abstract: "<jats:p>Semantic knowledge review.</jats:p>",
  issued: { "date-parts": [[2026, 10, 2]] },
  language: "en",
};
const CELL_URL = "https://www.cell.com/iscience/fulltext/" + CELL_PII;
const CELL_FIELDS = {
  ISSN: "2589-0042",
  publicationTitle: "iScience",
  url: CELL_URL,
};
const registryText = readFileSync(
  "addon/content/data/cell-press-journals.json",
  "utf8",
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build isolated Zotero/file/network doubles for observable workflow tests. */
function fixture(options = {}) {
  const files = new Map([
    ["/input.pdf", PDF],
    ["/html.pdf", "<html>login</html>"],
  ]);
  const items = new Map();
  const stats = {
    imports: 0,
    translations: 0,
    native: 0,
    requests: [],
    timers: [],
    aborted: false,
    chrome: 0,
    activeChrome: 0,
    maxChrome: 0,
    notifications: [],
  };
  let nextID = 1;
  let random = 0;
  function file(path) {
    return {
      path,
      get parent() {
        return file(this.path.slice(0, this.path.lastIndexOf("/")));
      },
      clone() {
        return file(this.path);
      },
      append(part) {
        this.path += "/" + part;
      },
      create() {
        files.set(this.path, "directory");
      },
      exists() {
        return files.has(this.path);
      },
      isFile() {
        return files.get(this.path) !== "directory";
      },
      get fileSize() {
        return files.get(this.path)?.length ?? 0;
      },
      remove() {
        for (const key of files.keys())
          if (key === this.path || key.startsWith(this.path + "/"))
            files.delete(key);
      },
      moveTo(parent, name) {
        const destination = parent.path + "/" + name;
        files.set(destination, files.get(this.path));
        files.delete(this.path);
        this.path = destination;
      },
    };
  }
  function parent(doi = DOI) {
    const item = {
      id: nextID++,
      key: `ITEM${nextID}`,
      libraryID: 1,
      fields: { DOI: doi, title: "Test" },
      attachments: [],
      getField(name) {
        return this.fields[name] || "";
      },
      setField(name, value) {
        this.fields[name] = value;
      },
      getAttachments() {
        return this.attachments;
      },
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      addToCollection() {},
      setCollections(value) {
        this.collections = value;
      },
      setCreators(value) {
        this.creators = value;
      },
      saveTx: async () => {},
    };
    items.set(item.id, item);
    return item;
  }
  const subprocess = {
    pathSearch: async (name) => {
      if (name !== "curl") {
        if (options.chromeMissing) throw new Error("Chrome not found");
        return "/system/chrome";
      }
      if (options.curlMissing) throw new Error("curl executable not found");
      return "/system/curl";
    },
    async call(config) {
      if (options.launchDelay) await delay(options.launchDelay);
      const args = config.arguments;
      if (args.includes("about:blank")) {
        if (options.chromeLaunchDelay) await delay(options.chromeLaunchDelay);
        stats.chrome++;
        stats.activeChrome++;
        stats.maxChrome = Math.max(stats.maxChrome, stats.activeChrome);
        stats.chromeArguments = args;
        stats.chromeCommand = config.command;
        let release;
        let done = false;
        const exited = new Promise((resolve) => {
          release = resolve;
        });
        stats.exitChrome = () => {
          if (!done) {
            done = true;
            stats.activeChrome--;
            release({ exitCode: 0 });
          }
        };
        return {
          stdout: { readString: async () => "" },
          wait: () => exited,
          kill: async () => {
            stats.aborted = true;
            stats.exitChrome();
          },
        };
      }
      const url = args.at(-1);
      const path = args[args.indexOf("--output") + 1];
      stats.requests.push({ url, command: config.command, args });
      let killed = false;
      let release;
      const completed = (async () => {
        if (options.hang || (options.hangPDF && !path.endsWith("article.html")))
          await new Promise((resolve) => {
            release = resolve;
          });
        if (options.publisherDelay) await delay(options.publisherDelay);
        if (killed) return { exitCode: -9 };
        if (options.curlFailure) return { exitCode: 22 };
        files.set(
          path,
          path.endsWith("article.html")
            ? "<html>article</html>"
            : options.html || url === options.nonPDFURL
              ? "<html>login</html>"
              : PDF,
        );
        return { exitCode: 0 };
      })();
      let sent = false;
      let sentError = false;
      return {
        stdout: {
          async readString() {
            await completed;
            if (sent) return "";
            sent = true;
            // Model curl's effective article URL after the DOI redirect.
            return (
              options.finalURL ??
              (path.endsWith("article.html")
                ? "https://www.nature.com/articles/s42256-026-01281-1"
                : url)
            );
          },
        },
        stderr: {
          async readString() {
            await completed;
            if (sentError) return "";
            sentError = true;
            return options.curlFailure ? "HTTP error 403" : "";
          },
        },
        wait: () => completed,
        kill: async () => {
          killed = true;
          stats.aborted = true;
          release?.();
          return completed;
        },
      };
    },
  };
  const Zotero = {
    logError() {},
    Prefs: {
      get: (key) =>
        key === "extensions.zotero.doi2pdf.chromePath"
          ? options.chromePath
          : undefined,
    },
    Libraries: { userLibraryID: 1 },
    Collections: { getByLibraryAndKey: () => ({ id: 99 }) },
    Item: class {
      constructor() {
        return parent();
      }
    },
    DataDirectory: { dir: "/data" },
    HTTP: {
      request: async (method, url) => {
        if (url.startsWith("https://api.crossref.org/")) {
          stats.metadataRequests ??= [];
          stats.metadataRequests.push(url);
          if (url.endsWith(encodeURIComponent(ANNUAL_DOI))) {
            if (options.annualMetadataFailure)
              throw new Error("Crossref unavailable");
            return {
              responseText: JSON.stringify({
                message: options.annualCrossref ?? ANNUAL_METADATA,
              }),
            };
          }
          if (!options.crossref) throw new Error("Metadata unavailable");
          return {
            responseText: JSON.stringify({ message: options.crossref }),
          };
        }
        return {
          responseText: JSON.stringify({
            webSocketDebuggerUrl:
              options.debuggerURL ??
              "ws://127.0.0.1:45678/devtools/browser/owned",
          }),
        };
      },
    },
    getMainWindow: () => ({
      URL,
      TextEncoder,
      atob,
      IOUtils: {
        async write(path, bytes, config) {
          if (options.streamWriteDelay) await delay(options.streamWriteDelay);
          const chunk = Buffer.from(bytes).toString("binary");
          files.set(
            path,
            (config.mode === "append" ? files.get(path) || "" : "") + chunk,
          );
        },
      },
      location: { origin: "chrome://zotero" },
      Components: {
        classes: {
          "@mozilla.org/network/server-socket;1": {
            createInstance: () => ({ init() {}, port: 45678, close() {} }),
          },
        },
      },
      WebSocket: class {
        constructor() {
          this.readyState = 0;
          if (!options.chromeConnectionHang)
            setTimeout(() => {
              if (this.readyState !== 0) return;
              this.readyState = 1;
              this.onopen?.();
            }, 0);
        }
        send(raw) {
          if (options.chromeSendFailure) {
            options.chromeSendFailure = false;
            throw new Error("Chrome socket send failed");
          }
          const request = JSON.parse(raw);
          stats.cdp ??= [];
          stats.cdp.push(request);
          let result = {};
          let error;
          if (request.method === "Target.getTargets")
            result = { targetInfos: [{ type: "page", targetId: "owned" }] };
          if (request.method === "Browser.getWindowForTarget")
            result = { windowId: 1 };
          if (request.method === "Browser.setDownloadBehavior")
            stats.downloadDirectory = request.params.downloadPath;
          if (request.method === "Target.createTarget")
            result = { targetId: "owned" };
          if (request.method === "Target.attachToTarget")
            result = { sessionId: "session" };
          if (request.method === "Runtime.evaluate") {
            const value =
              this.cell && !options.chromeChallenge
                ? {
                    doi: options.cellPageDOI ?? CELL_DOI,
                    url: options.cellFinalURL ?? CELL_URL,
                    pdf: options.cellPDFURL,
                    title: "Cell paper",
                  }
                : request.params.expression === "document.title"
                  ? "Just a moment..."
                  : options.chromeChallenge
                    ? { title: "Just a moment..." }
                    : {
                        doi: options.pnasPageDOI ?? this.doi,
                        pdf:
                          options.pnasPDFURL ??
                          "https://www.pnas.org/doi/pdf/" + this.doi,
                        url: "https://www.pnas.org/doi/" + this.doi,
                      };
            result = { result: { value } };
            if (this.annualreviews && !options.chromeChallenge) {
              result = {
                result: {
                  value: request.params.expression.includes("const form =")
                    ? {
                        url: options.annualFinalURL ?? ANNUAL_URL,
                        ready:
                          (this.annualReads = (this.annualReads || 0) + 1) <=
                          (options.annualLoadingReads || 0)
                            ? "loading"
                            : "complete",
                        formAction: options.annualFormMissing
                          ? undefined
                          : (options.annualFormAction ??
                            ANNUAL_PDF.replace("/docserver/", "/deliver/")),
                        formMethod: "post",
                      }
                    : {
                        doi: options.annualPageDOI ?? ANNUAL_DOI,
                        url: ANNUAL_URL,
                      },
                },
              };
              if (
                request.params.expression.includes("form.requestSubmit()") &&
                !options.chromeHangPDF
              ) {
                setTimeout(
                  () =>
                    this.onmessage?.({
                      data: JSON.stringify({
                        method: "Fetch.requestPaused",
                        sessionId: "session",
                        params: {
                          requestId: "pdf-response",
                          request: { url: options.annualPDFURL ?? ANNUAL_PDF },
                          responseStatusCode: options.annualStatus ?? 200,
                          responseHeaders: [
                            { name: "Content-Type", value: "application/pdf" },
                          ],
                        },
                      }),
                    }),
                  0,
                );
              }
            }
          }
          if (request.method === "Page.navigate") {
            const url = request.params.url;
            let pdfNavigation = false;
            if (url.includes("annualreviews.org/")) {
              this.annualreviews = true;
            } else if (url.includes("cell.com/")) {
              this.cell = true;
              pdfNavigation = url.includes("/action/showPdf");
            } else if (!url.includes("/pdf/")) this.doi = url.split("/doi/")[1];
            else pdfNavigation = true;
            if (pdfNavigation && !options.chromeHangPDF) {
              setTimeout(
                () =>
                  this.onmessage?.({
                    data: JSON.stringify({
                      method: "Fetch.requestPaused",
                      sessionId: "session",
                      params: {
                        requestId: "pdf-response",
                        request: {
                          url: this.cell ? (options.cellRedirect ?? url) : url,
                        },
                        responseStatusCode:
                          (this.cell
                            ? options.cellStatus
                            : options.pnasStatus) ?? 200,
                        responseHeaders: (this.cell
                          ? options.cellHeaders
                          : options.pnasHeaders) || [
                          { name: "Content-Type", value: "application/pdf" },
                        ],
                      },
                    }),
                  }),
                0,
              );
            }
          }
          if (request.method === "Fetch.takeResponseBodyAsStream")
            result = { stream: "response-body" };
          if (request.method === "IO.read") {
            this.reads = (this.reads || 0) + 1;
            if (options.streamError && this.reads > 1)
              error = { message: "Response stream disconnected" };
            const content =
              (!this.cell && options.pnasStreamData) ||
              options.streamData ||
              (options.chromeHTML ? "<html>verification</html>" : PDF);
            const data =
              this.reads === 1 ? content.slice(0, 9) : content.slice(9);
            result = {
              data: options.streamPlainText
                ? data
                : Buffer.from(data, "binary").toString("base64"),
              base64Encoded: !options.streamPlainText,
              eof: this.reads > 1 && !options.streamNoEOF,
            };
          }
          setTimeout(
            () =>
              this.onmessage?.({
                data: JSON.stringify({ id: request.id, result, error }),
              }),
            0,
          );
          if (request.method === "Browser.close")
            setTimeout(() => {
              stats.exitChrome();
              this.close();
            }, 0);
        }
        close() {
          this.readyState = 3;
          this.onclose?.();
        }
      },
      ChromeUtils: { importESModule: () => ({ Subprocess: subprocess }) },
      Services: { dirsvc: { get: () => file("/system") } },
      Ci: { nsIFile: {} },
      DOMParser: class {
        parseFromString() {
          return {
            querySelector(selector) {
              // Model a real download button independently of citation metadata.
              if (selector.startsWith("a["))
                return options.articlePDFURL
                  ? { getAttribute: () => options.articlePDFURL }
                  : null;
              return {
                getAttribute: () =>
                  selector.includes("citation_doi")
                    ? (options.pageDOI ?? DOI)
                    : (options.pdfURL ??
                      "https://www.nature.com/articles/s42256-026-01281-1.pdf"),
              };
            },
          };
        }
      },
      navigator: { userAgent: "test" },
      setTimeout(callback, ms) {
        stats.timers.push(ms);
        return setTimeout(callback, ms / (options.timerDivisor ?? 200));
      },
      clearTimeout,
    }),
    getTempDirectory: () => file("/temp"),
    Utilities: {
      Item: {
        // Model the native CSL API; assertions below also verify the supplied CSL record.
        itemFromCSLJSON(item, csl) {
          stats.csl = csl;
          Object.assign(item.fields, {
            DOI: csl.DOI,
            title: csl.title,
            publicationTitle: csl["container-title"],
            url: csl.URL,
            abstractNote: csl.abstract,
            ISSN: csl.ISSN,
          });
          item.setCreators(
            (csl.author || []).map((author) => ({
              firstName: author.given || "",
              lastName: author.family || author.literal,
              creatorType: "author",
            })),
          );
        },
      },
      cleanTags: (value) => value.replace(/<[^>]*>/g, ""),
      randomString: () => String(++random),
      extractIdentifiers: (value) => [{ DOI: value }],
    },
    Items: {
      get: (id) => items.get(id),
      getAll: async () => [...items.values()],
      getByLibraryAndKey: (library, key) =>
        [...items.values()].find(
          (x) => x.key === key && x.libraryID === library,
        ),
    },
    File: {
      getResourceAsync: async () => registryText,
      pathToFile: (value) => (typeof value === "string" ? file(value) : value),
      getBinaryContentsAsync: async (value) =>
        files.get(typeof value === "string" ? value : value.path),
      getContentsAsync: async (path) => files.get(path),
    },
    Attachments: {
      getFileResolvers: () => [],
      async downloadFirstAvailableFile(resolvers, path) {
        stats.native++;
        if (options.nativeDelay) await delay(options.nativeDelay);
        if (options.nativeFailure) return false;
        files.set(path, PDF);
        return { url: "https://www.nature.com/articles/native.pdf" };
      },
      async importFromFile({ file: path, parentItemID }) {
        if (options.importFailure)
          throw new Error("PDF attachment write failed");
        stats.imports++;
        await delay(2);
        const item = items.get(parentItemID);
        const attachment = {
          id: nextID++,
          key: `PDF${nextID}`,
          parentItemID,
          isPDFAttachment: () => true,
          getFilePathAsync: async () => `/storage/${parentItemID}.pdf`,
          setField() {},
          saveTx: async () => {},
        };
        files.set(`/storage/${parentItemID}.pdf`, files.get(path));
        items.set(attachment.id, attachment);
        item.attachments.push(attachment.id);
        return attachment;
      },
    },
    Server: { LocalAPI: { Schema: class {} } },
    Translate: {
      Search: class {
        setIdentifier(value) {
          this.doi = value.DOI;
        }
        setTranslator() {}
        async getTranslators() {
          return ["test"];
        }
        async translate(opts) {
          stats.translations++;
          stats.translationOptions = opts;
          await delay(5);
          const item = parent(this.doi);
          Object.assign(item.fields, options.translationFields);
          return [item];
        }
      },
    },
  };
  const ztoolkit = {
    /** Capture popup content and the number of attachments at display time. */
    ProgressWindow: class {
      constructor(header, config) {
        if (options.popupFailure)
          throw new Error("Progress window unavailable");
        this.notification = { header, config, descriptions: [], lines: [] };
      }
      addDescription(text) {
        this.notification.descriptions.push(text);
        return this;
      }
      createLine(line) {
        this.notification.lines.push(line);
        return this;
      }
      show() {
        this.notification.importsAtDisplay = stats.imports;
        stats.notifications.push(this.notification);
        return this;
      }
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle, {
    module,
    exports: module.exports,
    Zotero,
    ztoolkit,
    URL,
    rootURI: "/plugin/",
  });
  return { api: module.exports, Zotero, stats, files, parent, items };
}

test("staging retains successful files and cleans misses and teardown failures", async () => {
  const f = fixture();
  const successful = f.api.createPDFTemp("native");
  f.files.set(successful.path, PDF);
  const candidate = { ...successful, source: "native" };
  assert.equal(
    await f.api.stagePDF(successful, async () => candidate),
    candidate,
  );
  assert.ok(f.files.has(successful.path));
  candidate.cleanup();
  candidate.cleanup();
  assert.ok(!f.files.has(successful.path));

  const missing = f.api.createPDFTemp("nature");
  assert.equal(await f.api.stagePDF(missing, async () => undefined), undefined);
  assert.ok(!f.files.has(missing.path.slice(0, missing.path.lastIndexOf("/"))));

  const failed = f.api.createPDFTemp("pnas");
  f.files.set(failed.path, PDF);
  await assert.rejects(
    f.api.stagePDF(failed, async () => {
      try {
        return { ...failed, source: "pnas" };
      } finally {
        // Deliberately override a successful return to reproduce browser teardown failure.
        // eslint-disable-next-line no-unsafe-finally
        throw new Error("Browser teardown failed");
      }
    }),
    /Browser teardown failed/,
  );
  assert.ok(!f.files.has(failed.path));
  assert.equal(f.files.get("/input.pdf"), PDF);
  assert.equal(f.stats.imports, 0);
});

test("native success bypasses publisher and imports once", async () => {
  const f = fixture();
  const item = f.parent();
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "native");
  assert.equal(f.stats.requests.length, 0);
  assert.equal(f.stats.imports, 1);
  assert.equal(item.attachments.length, 1);
  assert.equal(f.stats.notifications.length, 0);
});

test("publisher notifications show green success only after import and deduplicate requests", async () => {
  for (const doi of [DOI, PNAS_DOI]) {
    const f = fixture({ nativeFailure: true, timerDivisor: 50 });
    const item = f.parent(doi);
    item.fields.title = "<title> " + "Long title ".repeat(20);
    const results = await Promise.all([
      f.api.findFullText(item),
      f.api.findFullText(item),
    ]);
    assert.ok(results.every((result) => result.status === "found"));
    assert.equal(f.stats.notifications.length, 1);
    const popup = f.stats.notifications[0];
    assert.equal(popup.header, "doi2pdf");
    assert.match(popup.descriptions[0], /color:#16803c.*✔ PDF 已保存/);
    assert.match(popup.descriptions[0], /href="https:\/\/doi.org\//);
    assert.equal(popup.importsAtDisplay, 1);
    assert.equal(popup.config.closeTime, 3000);
    assert.ok(popup.lines[0].text.length <= 70);
    assert.equal(popup.lines[1].text, doi);
    await f.api.findFullText(item);
    assert.equal(f.stats.notifications.length, 1);
  }
});

test("publisher failures show a red symbol and brief reason without claiming an import", async () => {
  for (const [doi, options, reason] of [
    [DOI, { hangPDF: true }, "下载超时（30 秒）"],
    [PNAS_DOI, { chromeMissing: true }, "未找到 Google Chrome"],
    [PNAS_DOI, { chromeChallenge: true }, "网站验证未完成"],
    [DOI, { importFailure: true }, "未能下载或保存 PDF"],
  ]) {
    const f = fixture({ nativeFailure: true, timerDivisor: 50, ...options });
    const result = await f.api.findFullText(f.parent(doi));
    assert.equal(result.status, "failed");
    assert.equal(f.stats.notifications.length, 1);
    const popup = f.stats.notifications[0];
    assert.match(popup.descriptions[0], /color:#c62828.*❌ PDF 下载失败/);
    assert.equal(popup.lines.at(-1).text, reason);
    assert.equal(popup.importsAtDisplay, 0);
    assert.equal(popup.config.closeTime, 5000);
    await delay(15);
  }
});

test("a popup error does not change a successful attachment result", async () => {
  const f = fixture({ nativeFailure: true, popupFailure: true });
  const result = await f.api.findFullText(f.parent());
  assert.equal(result.status, "found");
  assert.equal(f.stats.imports, 1);
});

test("early native failure invokes curl with one cookie jar and cleans temporary PDFs", async () => {
  const f = fixture({ nativeFailure: true });
  const item = f.parent();
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "nature");
  assert.equal(f.stats.imports, 1);
  assert.equal(f.stats.requests.length, 2);
  const jars = f.stats.requests.map(
    (x) => x.args[x.args.indexOf("--cookie-jar") + 1],
  );
  assert.equal(jars[0], jars[1]);
  assert.ok(f.stats.requests.every((x) => x.args[0] === "--disable"));
  assert.ok(f.stats.requests.every((x) => x.args.at(-2) === "--"));
  assert.ok(result.timings.totalMs >= 0);
  assert.ok(
    ![...f.files.keys()].some((x) => x.startsWith("/data/doi2pdf/downloads/")),
  );
});

test("Nature advance publication uses the main download button when metadata returns HTML", async () => {
  const doi = "10.1038/s41467-026-77942-x";
  const articleURL = "https://www.nature.com/articles/s41467-026-77942-x";
  const f = fixture({
    nativeFailure: true,
    pageDOI: doi,
    finalURL: articleURL,
    pdfURL: articleURL + ".pdf",
    nonPDFURL: articleURL + ".pdf",
    articlePDFURL: "/articles/s41467-026-77942-x_reference.pdf",
  });
  const item = f.parent(doi);
  const result = await f.api.findFullText(item);
  assert.equal(result.status, "found");
  assert.equal(result.source, "nature");
  assert.equal(f.stats.requests[1].url, articleURL + "_reference.pdf");
  assert.equal(f.stats.imports, 1);
  assert.equal(item.attachments.length, 1);
  assert.ok(
    ![...f.files.keys()].some((x) => x.startsWith("/data/doi2pdf/downloads/")),
  );
});

test("Nature download buttons still require an allowed HTTPS publisher URL", async () => {
  for (const articlePDFURL of [
    "https://example.com/article.pdf",
    "http://www.nature.com/articles/article.pdf",
  ]) {
    const f = fixture({ nativeFailure: true, articlePDFURL });
    const result = await f.api.findFullText(f.parent());
    assert.equal(result.status, "failed");
    assert.equal(f.stats.requests.length, 1);
    assert.equal(f.stats.imports, 0);
  }
});

test("8-second timer triggers publisher; a late native result cannot duplicate it", async () => {
  const f = fixture({ nativeDelay: 120 });
  const item = f.parent();
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "nature");
  assert.ok(f.stats.timers.includes(8000));
  await delay(140);
  assert.equal(f.stats.imports, 1);
  assert.equal(item.attachments.length, 1);
  assert.ok(
    ![...f.files.keys()].some((x) => x.startsWith("/data/doi2pdf/downloads/")),
  );
});

test("late native success can win while fallback is pending", async () => {
  const f = fixture({ nativeDelay: 85, publisherDelay: 80 });
  const item = f.parent();
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "native");
  assert.equal(f.stats.notifications.length, 1);
  assert.match(
    f.stats.notifications[0].descriptions[0],
    /✔ PDF 已保存（常规路线）/,
  );
  assert.ok(f.stats.requests.length > 0);
  await delay(200);
  assert.equal(f.stats.imports, 1);
  assert.ok(
    ![...f.files.keys()].some((x) => x.startsWith("/data/doi2pdf/downloads/")),
  );
});

test("30-second fallback budget aborts the request and creates no attachment", async () => {
  for (const options of [{ hang: true }, { hangPDF: true }]) {
    const f = fixture({ nativeFailure: true, ...options });
    const item = f.parent();
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "failed");
    assert.match(result.message, /30 seconds/);
    assert.equal(f.stats.timers.filter((x) => x === 30000).length, 1);
    assert.equal(f.stats.aborted, true);
    assert.equal(f.stats.imports, 0);
  }
});

test("curl process launched after expiry is killed and cleans its private directory", async () => {
  const f = fixture({ nativeFailure: true, launchDelay: 120, hang: true });
  const result = await f.api.findFullText(f.parent());
  assert.equal(result.status, "failed");
  await delay(150);
  assert.equal(f.stats.aborted, true);
  assert.equal(f.stats.imports, 0);
  assert.ok(
    ![...f.files.keys()].some((x) => x.startsWith("/data/doi2pdf/downloads/")),
  );
});

test("publisher DOI mismatch and HTML responses are rejected", async () => {
  for (const options of [{ pageDOI: "10.1038/wrong" }, { html: true }]) {
    const f = fixture({ ...options, nativeFailure: true });
    const result = await f.api.findFullText(f.parent());
    assert.equal(result.status, "failed");
    assert.equal(f.stats.imports, 0);
  }
});

test("manual import checks parent DOI, preserves original file, and serializes writers", async () => {
  const f = fixture();
  const item = f.parent();
  await assert.rejects(
    f.api.importPDF(item, "/input.pdf", "10.1000/wrong"),
    /does not match/,
  );
  await assert.rejects(f.api.importPDF(item, "/html.pdf", DOI), /PDF header/);
  const results = await Promise.all([
    f.api.importPDF(item, "/input.pdf", DOI),
    f.api.importPDF(item, "/input.pdf", DOI),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(f.stats.imports, 1);
  assert.equal(f.files.get("/input.pdf"), PDF);
});

test("snapshot and missing PDF never suppress download", async () => {
  const f = fixture();
  const item = f.parent();
  f.items.set(100, { id: 100, isPDFAttachment: () => false });
  item.attachments.push(100);
  f.items.set(101, {
    id: 101,
    isPDFAttachment: () => true,
    getFilePathAsync: async () => "/missing.pdf",
  });
  item.attachments.push(101);
  assert.equal((await f.api.findFullText(item)).source, "native");
  assert.equal(f.stats.imports, 1);
});

test("concurrent add-doi calls create one metadata-only parent and one PDF", async () => {
  const f = fixture();
  const endpoint = new f.api.AddDOIEndpoint();
  const req = {
    data: {
      doi: DOI,
      collectionKey: null,
      pdfPath: "/input.pdf",
      findFullText: false,
    },
  };
  const results = await Promise.all([endpoint.run(req), endpoint.run(req)]);
  const bodies = results.map((x) => JSON.parse(x[2]));
  assert.ok(results.every((x) => x[0] === 200));
  assert.equal(bodies[0].itemKey, bodies[1].itemKey);
  assert.equal(f.stats.translations, 1);
  assert.equal(f.stats.translationOptions.saveAttachments, false);
  assert.equal(f.stats.imports, 1);
  assert.equal(f.stats.native, 0);
});

test("import endpoint never creates a missing parent", async () => {
  const f = fixture();
  const result = await new f.api.ImportPDFEndpoint().run({
    data: { itemKey: "MISSING", expectedDOI: DOI, pdfPath: "/input.pdf" },
  });
  assert.equal(result[0], 404);
  assert.equal(f.stats.translations, 0);
  assert.equal(f.stats.imports, 0);
});

test("Windows paths are normalized before native file APIs", async () => {
  const f = fixture();
  f.Zotero.isWin = true;
  f.files.set("E:\\Downloads\\paper.pdf", PDF);
  const result = await f.api.importPDF(
    f.parent(),
    "E:/Downloads/paper.pdf",
    DOI,
  );
  assert.ok(result.id);
  assert.equal(f.stats.imports, 1);
});

test("missing curl and curl HTTP errors retain the parent without attachments", async () => {
  for (const options of [{ curlMissing: true }, { curlFailure: true }]) {
    const f = fixture({ nativeFailure: true, ...options });
    const item = f.parent();
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "failed");
    assert.match(result.message, /curl/);
    assert.equal(item.attachments.length, 0);
    assert.ok(
      ![...f.files.keys()].some((x) =>
        x.startsWith("/data/doi2pdf/downloads/"),
      ),
    );
  }
});

test("non-Nature article redirects and unsupported PDF hosts are rejected", async () => {
  for (const options of [
    { finalURL: "https://example.com/login" },
    { pdfURL: "http://www.nature.com/wrong.pdf" },
  ]) {
    const f = fixture({ nativeFailure: true, ...options });
    const result = await f.api.findFullText(f.parent());
    assert.equal(result.status, "failed");
    assert.equal(f.stats.requests.length, 1);
    assert.equal(f.stats.imports, 0);
  }
});

test("invalid supplied PDF creates no metadata parent", async () => {
  const f = fixture();
  const response = await new f.api.AddDOIEndpoint().run({
    data: {
      doi: DOI,
      collectionKey: null,
      pdfPath: "/html.pdf",
    },
  });
  assert.equal(response[0], 400);
  assert.equal(f.stats.translations, 0);
});

test("PNAS and Cell use the configured Chrome path before automatic detection", async () => {
  for (const doi of [PNAS_DOI, CELL_DOI]) {
    const path = "E:\\Portable Chrome\\chrome.exe";
    const f = fixture({
      nativeFailure: true,
      chromeMissing: true,
      chromePath: `  "${path}"  `,
      timerDivisor: 50,
    });
    f.files.set(path, "executable");
    const item = f.parent(doi);
    if (doi === CELL_DOI) Object.assign(item.fields, CELL_FIELDS);
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "found", JSON.stringify(result));
    assert.equal(f.stats.chromeCommand, path);
    assert.equal(f.stats.imports, 1);
    assert.equal(f.stats.activeChrome, 0);
  }
});

test("invalid configured Chrome paths fail without launching an automatically found browser", async () => {
  for (const contents of [undefined, "directory"]) {
    const path = "/custom/chrome.exe";
    const f = fixture({ nativeFailure: true, chromePath: path });
    if (contents) f.files.set(path, contents);
    const item = f.parent(PNAS_DOI);
    const result = await f.api.findFullText(item);
    assert.equal(result.code, "CHROME_NOT_FOUND");
    assert.equal(result.status, "failed");
    assert.ok(result.message.includes(path));
    assert.equal(f.stats.chrome, 0);
    assert.equal(item.attachments.length, 0);
    assert.ok(
      ![...f.files.keys()].some((file) =>
        file.startsWith("/data/doi2pdf/downloads/"),
      ),
    );
  }
});

test("clearing the Chrome path restores Windows installation discovery on the next start", async () => {
  const options = { chromePath: "/custom/chrome.exe" };
  const f = fixture(options);
  f.Zotero.isWin = true;
  const automaticPath = "/system/Google/Chrome/Application/chrome.exe";
  f.files.set(options.chromePath, "executable");
  f.files.set(automaticPath, "executable");
  for (const configured of ["/custom/chrome.exe", "", "   "]) {
    options.chromePath = configured;
    const browser = new f.api.ChromeSession({ check: () => 30_000 });
    try {
      await browser.start(f.Zotero.File.pathToFile("/temporary"), () => {});
      assert.equal(f.stats.chromeCommand, configured.trim() || automaticPath);
    } finally {
      await browser.close();
    }
  }
});

test("PNAS browser fallback uses runtime data directory and imports one PDF", async () => {
  const f = fixture({ nativeFailure: true, timerDivisor: 50 });
  f.Zotero.DataDirectory.dir = "/selected/zotero";
  const item = f.parent(PNAS_DOI);
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "pnas");
  assert.equal(f.stats.imports, 1);
  assert.equal(f.stats.requests.length, 0);
  assert.ok(
    f.stats.chromeArguments.includes(
      "--user-data-dir=/selected/zotero/doi2pdf/chrome_profile",
    ),
  );
  assert.ok(f.stats.chromeArguments.includes("--remote-debugging-port=45678"));
  assert.ok(!f.stats.chromeArguments.includes("--remote-debugging-port=0"));
  assert.equal(f.stats.activeChrome, 0);
  assert.ok(f.stats.chromeArguments.includes("--start-minimized"));
  assert.ok(
    f.stats.cdp.some(
      (request) => request.method === "Fetch.takeResponseBodyAsStream",
    ),
  );
  assert.ok(f.stats.cdp.some((request) => request.method === "IO.close"));
  assert.ok(
    f.stats.cdp.some((request) => request.method === "Fetch.failRequest"),
  );
  assert.ok(
    !f.stats.cdp.some(
      (request) =>
        request.method === "Browser.setDownloadBehavior" &&
        request.params.behavior !== "deny",
    ),
  );
  assert.ok(f.files.has("/selected/zotero/doi2pdf/chrome_profile"));
  assert.ok(
    ![...f.files.keys()].some((x) =>
      x.startsWith("/selected/zotero/doi2pdf/downloads/"),
    ),
  );
});

test("PNAS response stream failures retain metadata and clean private files", async () => {
  for (const [options, code] of [
    [{ pnasStatus: 403 }, "PNAS_PDF_UNAVAILABLE"],
    [
      {
        pnasStatus: 403,
        pnasHeaders: [
          { name: "Content-Type", value: "text/html" },
          { name: "CF-Mitigated", value: "CHALLENGE" },
        ],
      },
      "NEEDS_BROWSER_ACCESS",
    ],
    [{ streamError: true }, undefined],
    [{ streamNoEOF: true }, "PNAS_TIMEOUT"],
    [
      { pnasHeaders: [{ name: "Content-Type", value: "text/html" }] },
      "PNAS_TIMEOUT",
    ],
  ]) {
    const f = fixture({ nativeFailure: true, timerDivisor: 100, ...options });
    const item = f.parent(PNAS_DOI);
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "failed", JSON.stringify(options));
    assert.equal(result.code, code);
    assert.equal(f.stats.imports, 0);
    assert.equal(item.attachments.length, 0);
    await delay(20);
    assert.equal(f.stats.activeChrome, 0);
    assert.ok(
      ![...f.files.keys()].some((path) =>
        path.startsWith("/data/doi2pdf/downloads/"),
      ),
    );
    if (options.pnasStatus || options.pnasHeaders)
      assert.ok(
        !f.stats.cdp.some(
          (request) => request.method === "Fetch.takeResponseBodyAsStream",
        ),
      );
  }
});

test("PNAS failures retain metadata, close owned Chrome and clean downloads", async () => {
  for (const options of [
    { chromeMissing: true },
    { chromeChallenge: true },
    { chromeHangPDF: true },
    { pnasPageDOI: "10.1073/pnas.wrong" },
    { pnasPDFURL: "https://example.com/file.pdf" },
    { chromeHTML: true },
    { chromeSendFailure: true },
  ]) {
    const f = fixture({ nativeFailure: true, timerDivisor: 50, ...options });
    const item = f.parent(PNAS_DOI);
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "failed");
    assert.equal(item.attachments.length, 0);
    if (options.chromeMissing) assert.equal(result.code, "CHROME_NOT_FOUND");
    if (options.chromeChallenge)
      assert.equal(result.code, "NEEDS_BROWSER_ACCESS");
    if (options.chromeHangPDF) assert.equal(result.code, "PNAS_TIMEOUT");
    await delay(15);
    assert.equal(f.stats.activeChrome, 0);
    assert.ok(
      ![...f.files.keys()].some((x) =>
        x.startsWith("/data/doi2pdf/downloads/"),
      ),
    );
  }
});

test("PNAS rejects debugger addresses outside its reserved loopback endpoint", async () => {
  for (const debuggerURL of [
    "ws://example.com:45678/devtools/browser/other",
    "ws://127.0.0.1:45679/devtools/browser/other",
    "wss://127.0.0.1:45678/devtools/browser/other",
  ]) {
    const f = fixture({ nativeFailure: true, debuggerURL });
    const item = f.parent(PNAS_DOI);
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "failed");
    assert.match(result.message, /unexpected debugger address/);
    assert.equal(f.stats.activeChrome, 0);
    assert.equal(f.stats.imports, 0);
    assert.ok(f.files.has("/data/doi2pdf/chrome_profile"));
    assert.ok(
      ![...f.files.keys()].some((path) =>
        path.startsWith("/data/doi2pdf/downloads/"),
      ),
    );
  }
});

test("different PNAS parents serialize shared profile work without duplicate imports", async () => {
  const f = fixture({ nativeFailure: true, timerDivisor: 50 });
  const results = await Promise.all([
    f.api.findFullText(f.parent(PNAS_DOI)),
    f.api.findFullText(f.parent("10.1073/pnas.1234567890")),
  ]);
  assert.ok(results.every((result) => result.source === "pnas"));
  assert.equal(f.stats.maxChrome, 1);
  assert.equal(f.stats.imports, 2);
});

test("PNAS starts after 8 seconds and late native completion creates no extra PDF", async () => {
  const f = fixture({ nativeDelay: 650, timerDivisor: 50 });
  const item = f.parent(PNAS_DOI);
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "pnas");
  assert.ok(f.stats.timers.includes(8000));
  await delay(700);
  assert.equal(f.stats.imports, 1);
  assert.equal(item.attachments.length, 1);
});

test("PNAS late Chrome startup is killed and its task files are discarded", async () => {
  const f = fixture({
    nativeFailure: true,
    // The accelerated 30-second deadline is 600 ms; start Chrome after it.
    chromeLaunchDelay: 800,
    timerDivisor: 50,
  });
  const result = await f.api.findFullText(f.parent(PNAS_DOI));
  assert.equal(result.status, "failed");
  await delay(300);
  assert.equal(f.stats.activeChrome, 0);
  assert.equal(f.stats.imports, 0);
  assert.ok(
    ![...f.files.keys()].some((x) => x.startsWith("/data/doi2pdf/downloads/")),
  );
});

test("PNAS Nexus is not routed to the main-journal browser fallback", async () => {
  const f = fixture({ nativeFailure: true });
  await f.api.findFullText(f.parent("10.1093/pnasnexus/pgaf001"));
  assert.equal(f.stats.chrome, 0);
});

test("stopping the addon cancels active PNAS tasks but preserves the profile", async () => {
  const f = fixture({
    nativeFailure: true,
    chromeChallenge: true,
    timerDivisor: 50,
  });
  const pending = f.api.findFullText(f.parent(PNAS_DOI));
  await delay(60);
  f.api.stopChromeDownloads();
  const result = await pending;
  assert.equal(result.status, "failed");
  await delay(30);
  assert.equal(f.stats.activeChrome, 0);
  assert.equal(f.stats.imports, 0);
  assert.ok(f.files.has("/data/doi2pdf/chrome_profile"));
  assert.ok(
    ![...f.files.keys()].some((path) =>
      path.startsWith("/data/doi2pdf/downloads/"),
    ),
  );
});

test("canceling a connecting Chrome socket releases the PNAS queue", async () => {
  const options = {
    nativeFailure: true,
    chromeConnectionHang: true,
    timerDivisor: 50,
  };
  const f = fixture(options);
  const pending = f.api.findFullText(f.parent(PNAS_DOI));
  await delay(30);
  assert.equal(f.stats.activeChrome, 1);
  f.api.stopChromeDownloads();
  assert.equal((await pending).status, "failed");
  options.chromeConnectionHang = false;
  const result = await f.api.findFullText(f.parent(PNAS_DOI));
  assert.equal(result.source, "pnas");
  assert.equal(f.stats.imports, 1);
  assert.equal(f.stats.maxChrome, 1);
  assert.equal(f.stats.activeChrome, 0);
});

test("shutdown cancels queued PNAS tasks without launching another Chrome", async () => {
  const options = {
    nativeFailure: true,
    chromeChallenge: true,
    timerDivisor: 50,
  };
  const f = fixture(options);
  const first = f.api.findFullText(f.parent(PNAS_DOI));
  const queued = f.api.findFullText(f.parent("10.1073/pnas.1234567890"));
  await delay(30);
  f.api.stopChromeDownloads();
  assert.ok(
    (await Promise.all([first, queued])).every((x) => x.status === "failed"),
  );
  options.chromeChallenge = false;
  assert.equal((await f.api.findFullText(f.parent(PNAS_DOI))).source, "pnas");
  assert.equal(f.stats.chrome, 2);
  assert.equal(f.stats.maxChrome, 1);
  assert.equal(f.stats.imports, 1);
  assert.equal(f.stats.activeChrome, 0);
  assert.ok(
    ![...f.files.keys()].some((x) => x.startsWith("/data/doi2pdf/downloads/")),
  );
});

test("every registered Cell ISSN, title and alias matches one journal without DOI patterns", async () => {
  const f = fixture();
  const data = JSON.parse(registryText);
  assert.equal(data.journals.length, 65);
  let count = 0;
  for (const [name, issns, path, aliases] of data.journals) {
    for (const issn of issns) {
      assert.equal(
        (
          await f.api.matchCellJournal({
            issns: issn.replace("-", "").toLowerCase(),
          })
        ).path,
        path,
      );
      count++;
    }
    for (const title of [name, ...aliases]) {
      assert.equal(
        (
          await f.api.matchCellJournal({
            title: " " + title.toUpperCase() + " ",
          })
        ).path,
        path,
      );
    }
    assert.equal(
      (
        await f.api.matchCellJournal({
          url: `https://www.cell.com/${path}/home`,
        })
      ).path,
      path,
    );
  }
  assert.equal(count, 107);
  for (const fields of [
    { issns: "0140-6736", title: "The Lancet" },
    { title: "cell-like research" },
    { url: "https://www.cell.com.evil.test/neuron/home" },
    { url: "http://www.cell.com/neuron/home" },
  ])
    assert.equal(await f.api.matchCellJournal(fields), undefined);
  await assert.rejects(
    f.api.matchCellJournal({ issns: "0896-6273", title: "iScience" }),
    (error) => error.code === "JOURNAL_MISMATCH",
  );
});

test("PII parsing supports encoded and compact publisher identifiers", () => {
  const f = fixture();
  for (const value of [
    CELL_PII,
    "https://linkinghub.elsevier.com/retrieve/pii/S2589004226027690",
    "https://www.cell.com/action/showPdf?pii=" + encodeURIComponent(CELL_PII),
  ]) {
    assert.equal(f.api.cellPII(value), CELL_PII);
  }
  assert.equal(f.api.cellPII(CELL_DOI), undefined);
  assert.equal(f.api.cellPII("%broken"), undefined);
});

test("Cell add-doi saves the parent first then streams a minimized PDF without native lookup or 8-second wait", async () => {
  const f = fixture({ translationFields: CELL_FIELDS, timerDivisor: 50 });
  const req = { data: { doi: CELL_DOI, collectionKey: null } };
  const responses = await Promise.all([
    new f.api.AddDOIEndpoint().run(req),
    new f.api.AddDOIEndpoint().run(req),
  ]);
  for (const response of responses) {
    assert.equal(response[0], 200);
    const body = JSON.parse(response[2]);
    assert.equal(body.fullText.source, "cell");
    assert.equal(body.fullText.status, "found");
  }
  assert.equal(f.stats.translations, 1);
  assert.equal(f.stats.translationOptions.saveAttachments, false);
  assert.equal(f.stats.native, 0);
  assert.equal(f.stats.imports, 1);
  assert.equal(f.stats.chrome, 1);
  assert.ok(!f.stats.timers.includes(8000));
  // Ingestion now checks Crossref publisher metadata before identifier creation.
  assert.equal(f.stats.metadataRequests.length, 1);
  assert.ok(f.stats.timers.includes(60000));
  assert.ok(f.stats.chromeArguments.includes("--start-minimized"));
  assert.ok(
    !f.stats.chromeArguments.some((argument) => argument.includes("headless")),
  );
  assert.ok(
    f.stats.cdp.some(
      (request) =>
        request.method === "Target.createTarget" &&
        request.params.background === true,
    ),
  );
  assert.equal(
    f.stats.cdp.filter(
      (request) =>
        request.method === "Browser.setWindowBounds" &&
        request.params.bounds.windowState === "minimized",
    ).length,
    2,
  );
  assert.equal(
    f.stats.cdp.filter((request) => request.method === "IO.read").length,
    2,
  );
  assert.ok(
    f.stats.cdp.some((request) => request.method === "Fetch.failRequest"),
  );
  assert.equal(f.files.get("/storage/1.pdf"), PDF);
  assert.equal(f.stats.activeChrome, 0);
  assert.equal(f.stats.notifications.length, 1);
  assert.match(f.stats.notifications[0].descriptions[0], /Cell Press/);
  assert.ok(
    ![...f.files.keys()].some((path) =>
      path.startsWith("/data/doi2pdf/downloads/"),
    ),
  );
});

test("Cell PII lookup reads Crossref as metadata without following ScienceDirect links", async () => {
  const f = fixture({
    timerDivisor: 50,
    crossref: {
      DOI: CELL_DOI,
      ISSN: ["2589-0042"],
      "container-title": ["iScience"],
      resource: {
        primary: {
          URL: "https://linkinghub.elsevier.com/retrieve/pii/S2589004226027690",
        },
      },
      link: [
        {
          URL: "https://api.elsevier.com/content/article/PII:S2589004226027690?httpAccept=text/xml",
        },
      ],
    },
  });
  const item = f.parent(CELL_DOI);
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "cell");
  assert.equal(f.stats.metadataRequests.length, 1);
  assert.equal(f.stats.native, 0);
  assert.ok(
    !f.stats.cdp.some(
      (request) =>
        request.method === "Page.navigate" &&
        /sciencedirect|linkinghub|api\.elsevier/.test(request.params.url),
    ),
  );
});

test("missing Cell PII reuses the Crossref result instead of querying twice", async () => {
  for (const fields of [
    {},
    { ISSN: "2589-0042", publicationTitle: "iScience" },
  ]) {
    const f = fixture({
      crossref: {
        DOI: CELL_DOI,
        ISSN: ["2589-0042"],
        "container-title": ["iScience"],
      },
    });
    const item = f.parent(CELL_DOI);
    Object.assign(item.fields, fields);
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PII_NOT_FOUND");
    assert.equal(f.stats.metadataRequests.length, 1);
    assert.equal(f.stats.chrome, 0);
    assert.equal(f.stats.native, 0);
    assert.equal(f.stats.imports, 0);
    assert.ok(
      ![...f.files.keys()].some((path) =>
        path.startsWith("/data/doi2pdf/downloads/"),
      ),
    );
  }
});

test("shared response saving preserves binary chunks and plain-text responses", async () => {
  for (const options of [
    { streamData: PDF + "\x00\xff\x80" },
    { streamPlainText: true },
  ]) {
    for (const [doi, source] of [
      [CELL_DOI, "cell"],
      [PNAS_DOI, "pnas"],
    ]) {
      const f = fixture({ nativeFailure: true, timerDivisor: 50, ...options });
      const item = f.parent(doi);
      if (source === "cell") Object.assign(item.fields, CELL_FIELDS);
      const result = await f.api.findFullText(item);
      assert.equal(result.source, source);
      assert.equal(f.files.get("/storage/1.pdf"), options.streamData || PDF);
      assert.ok(f.stats.cdp.some((request) => request.method === "IO.close"));
      assert.ok(
        f.stats.cdp.some((request) => request.method === "Fetch.failRequest"),
      );
    }
  }
});

test("unknown Elsevier journal uses native retrieval despite a Cell-like DOI", async () => {
  const f = fixture();
  const item = f.parent(CELL_DOI);
  Object.assign(item.fields, {
    ISSN: "0140-6736",
    publicationTitle: "The Lancet",
  });
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "native");
  assert.equal(f.stats.chrome, 0);
  assert.equal(f.stats.metadataRequests.length, 1);
});

test("an incomplete parent with conflicting Crossref identity cannot fall through to native import", async () => {
  for (const metadata of [
    { DOI: "10.1016/wrong" },
    { DOI: CELL_DOI, ISSN: ["0896-6273"], "container-title": ["iScience"] },
  ]) {
    const f = fixture({ crossref: metadata });
    const result = await f.api.findFullText(f.parent(CELL_DOI));
    assert.equal(result.status, "failed");
    assert.ok(["DOI_MISMATCH", "JOURNAL_MISMATCH"].includes(result.code));
    assert.equal(f.stats.native, 0);
    assert.equal(f.stats.imports, 0);
  }
});

test("Cell metadata-only and explicit local PDF requests bypass browser download", async () => {
  for (const extra of [{ findFullText: false }, { pdfPath: "/input.pdf" }]) {
    const f = fixture({ translationFields: CELL_FIELDS });
    const response = await new f.api.AddDOIEndpoint().run({
      data: { doi: CELL_DOI, collectionKey: null, ...extra },
    });
    assert.equal(response[0], 200);
    assert.equal(f.stats.chrome, 0);
    assert.equal(f.stats.native, 0);
    assert.equal(f.stats.imports, extra.pdfPath ? 1 : 0);
  }
});

test("Cell identity, stream and access failures retain metadata and discard incomplete files", async () => {
  for (const [options, code] of [
    [{ cellPageDOI: "10.1016/j.isci.wrong" }, "DOI_MISMATCH"],
    [
      {
        cellFinalURL:
          "https://www.sciencedirect.com/science/article/pii/S2589004226027690",
      },
      "UNEXPECTED_PUBLISHER",
    ],
    [
      {
        cellPDFURL:
          "https://www.cell.com/action/showPdf?pii=S0896-6273(26)00639-2",
      },
      "PII_MISMATCH",
    ],
    [
      { cellRedirect: "https://www.sciencedirect.com/file.pdf" },
      "UNEXPECTED_PUBLISHER",
    ],
    [{ cellStatus: 403 }, "CELL_PDF_UNAVAILABLE"],
    [
      {
        cellStatus: 403,
        cellHeaders: [
          { name: "Content-Type", value: "text/html" },
          { name: "CF-Mitigated", value: "CHALLENGE" },
        ],
      },
      "NEEDS_BROWSER_ACCESS",
    ],
    [{ chromeHTML: true }, "INVALID_PDF"],
    [{ streamError: true }, undefined],
    [{ streamNoEOF: true }, "CELL_TIMEOUT"],
    [{ chromeChallenge: true }, "NEEDS_BROWSER_ACCESS"],
  ]) {
    const f = fixture({ timerDivisor: 100, ...options });
    const item = f.parent(CELL_DOI);
    Object.assign(item.fields, CELL_FIELDS);
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "failed", JSON.stringify(options));
    assert.equal(result.code, code);
    assert.equal(item.attachments.length, 0);
    assert.equal(f.stats.imports, 0);
    await delay(20);
    assert.equal(f.stats.activeChrome, 0);
    assert.ok(
      ![...f.files.keys()].some((path) =>
        path.startsWith("/data/doi2pdf/downloads/"),
      ),
    );
  }
});

test("Cell Crossref lookup rejects conflicting DOI, journal or PII before Chrome starts", async () => {
  for (const [metadata, code] of [
    [{ DOI: "10.1016/wrong" }, "DOI_MISMATCH"],
    [
      { DOI: CELL_DOI, ISSN: ["0896-6273"], "container-title": ["Neuron"] },
      "JOURNAL_MISMATCH",
    ],
    [
      {
        DOI: CELL_DOI,
        ISSN: ["2589-0042"],
        resource: { primary: { URL: CELL_PII } },
        link: [{ URL: "S0896627326006392" }],
      },
      "PII_MISMATCH",
    ],
  ]) {
    const f = fixture({ crossref: metadata });
    const item = f.parent(CELL_DOI);
    Object.assign(item.fields, {
      ISSN: "2589-0042",
      publicationTitle: "iScience",
    });
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "failed");
    assert.equal(result.code, code);
    assert.equal(f.stats.chrome, 0);
    assert.equal(f.stats.imports, 0);
  }
});

test("Cell and PNAS share one Chrome profile queue", async () => {
  const f = fixture({ nativeFailure: true, timerDivisor: 50 });
  const cell = f.parent(CELL_DOI);
  Object.assign(cell.fields, CELL_FIELDS);
  const results = await Promise.all([
    f.api.findFullText(cell),
    f.api.findFullText(f.parent(PNAS_DOI)),
  ]);
  assert.deepEqual(
    results.map((result) => result.source),
    ["cell", "pnas"],
  );
  assert.equal(f.stats.maxChrome, 1);
  assert.equal(f.stats.imports, 2);
});

test("an invalid PNAS PDF releases the shared queue for a valid Cell stream", async () => {
  const f = fixture({
    pnasStreamData: "<html>verification</html>",
    timerDivisor: 50,
  });
  const cell = f.parent(CELL_DOI);
  Object.assign(cell.fields, CELL_FIELDS);
  const article = await f.api.getCellArticle(cell);
  // Queue both transports before PDF validation rejects the first result.
  const [pnasResult, cellResult] = await Promise.allSettled([
    f.api.downloadPNASPDF(f.parent(PNAS_DOI)),
    f.api.downloadCellPDF(cell, article),
  ]);
  assert.equal(pnasResult.status, "rejected");
  assert.equal(pnasResult.reason.code, "INVALID_PDF");
  assert.equal(cellResult.status, "fulfilled");
  try {
    const candidate = cellResult.value;
    assert.equal(candidate.source, "cell");
    assert.equal(f.files.get(candidate.path), PDF);
    assert.equal(f.stats.chrome, 2);
    assert.equal(f.stats.maxChrome, 1);
    assert.equal(f.stats.activeChrome, 0);
    assert.equal(f.stats.imports, 0);
    const taskFiles = [...f.files.keys()].filter((path) =>
      path.startsWith("/data/doi2pdf/downloads/"),
    );
    assert.ok(taskFiles.length > 0);
    assert.ok(taskFiles.every((path) => path.includes("doi2pdf-cell-")));
  } finally {
    cellResult.value.cleanup();
  }
  assert.ok(
    ![...f.files.keys()].some((path) =>
      path.startsWith("/data/doi2pdf/downloads/"),
    ),
  );
});

test("shutdown cancels active Cell and queued PNAS downloads without a second browser", async () => {
  const f = fixture({
    chromeChallenge: true,
    nativeFailure: true,
    timerDivisor: 50,
  });
  const cell = f.parent(CELL_DOI);
  Object.assign(cell.fields, CELL_FIELDS);
  const active = f.api.findFullText(cell);
  const queued = f.api.findFullText(f.parent(PNAS_DOI));
  await delay(30);
  f.api.stopChromeDownloads();
  assert.ok(
    (await Promise.all([active, queued])).every(
      (result) => result.status === "failed",
    ),
  );
  await delay(20);
  assert.equal(f.stats.chrome, 1);
  assert.equal(f.stats.activeChrome, 0);
  assert.equal(f.stats.imports, 0);
  assert.ok(f.files.has("/data/doi2pdf/chrome_profile"));
});

test("a changed Cell parent DOI is rechecked before import", async () => {
  const f = fixture({ timerDivisor: 50 });
  const item = f.parent(CELL_DOI);
  Object.assign(item.fields, CELL_FIELDS);
  const pending = f.api.findFullText(item);
  await delay(5);
  item.fields.DOI = "10.1016/wrong";
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.code, "DOI_MISMATCH");
  assert.equal(f.stats.imports, 0);
});

test("a late PNAS stream write is cleaned after deadline cancellation", async () => {
  const f = fixture({
    nativeFailure: true,
    streamWriteDelay: 800,
    timerDivisor: 50,
  });
  const result = await f.api.findFullText(f.parent(PNAS_DOI));
  assert.equal(result.code, "PNAS_TIMEOUT");
  assert.ok(f.stats.cdp.some((request) => request.method === "IO.read"));
  await delay(850);
  assert.equal(f.stats.imports, 0);
  assert.equal(f.stats.activeChrome, 0);
  assert.ok(
    ![...f.files.keys()].some((path) =>
      path.startsWith("/data/doi2pdf/downloads/"),
    ),
  );
});

test("Annual Reviews bypasses identifier and native retrieval, deduplicating parents and PDFs", async () => {
  const f = fixture({ timerDivisor: 50, annualLoadingReads: 2 });
  const req = { data: { doi: ANNUAL_DOI, collectionKey: "TEST" } };
  const responses = await Promise.all([
    new f.api.AddDOIEndpoint().run(req),
    new f.api.AddDOIEndpoint().run(req),
  ]);
  for (const response of responses) {
    assert.equal(response[0], 200);
    const body = JSON.parse(response[2]);
    assert.equal(body.fullText.status, "found");
    assert.equal(body.fullText.source, "annualreviews");
  }
  assert.equal(f.stats.translations, 0);
  assert.equal(f.stats.native, 0);
  assert.equal(f.stats.metadataRequests.length, 1);
  assert.equal(f.stats.imports, 1);
  assert.equal(f.stats.chrome, 1);
  assert.equal(f.stats.maxChrome, 1);
  assert.ok(!f.stats.timers.includes(8000));
  const item = [...f.items.values()].find((x) => x.isRegularItem?.());
  assert.deepEqual([...item.collections], [99]);
  assert.equal(item.fields.publicationTitle, "Annual Review of Psychology");
  assert.equal(item.fields.url, ANNUAL_URL);
  assert.equal(item.fields.pages, undefined);
  assert.equal(item.fields.abstractNote, "Semantic knowledge review.");
  assert.equal(item.fields.ISSN, "0066-4308 1545-2085");
  assert.equal(f.stats.csl.type, "article-journal");
  assert.deepEqual([...f.stats.csl.issued["date-parts"][0]], [2026, 10, 2]);
  assert.equal(item.creators[0].lastName, "Rogers");
  assert.ok(
    f.stats.cdp.some((x) =>
      x.params?.expression?.includes("form.requestSubmit()"),
    ),
  );
  const repeat = JSON.parse((await new f.api.AddDOIEndpoint().run(req))[2]);
  assert.equal(repeat.created, false);
  assert.equal(repeat.fullText.source, "existing");
  assert.equal(f.stats.chrome, 1);
  assert.equal(f.stats.activeChrome, 0);
  assert.ok(
    ![...f.files.keys()].some((p) => p.startsWith("/data/doi2pdf/downloads/")),
  );
});

test("Annual Reviews metadata-only and local PDF requests skip the browser PDF form", async () => {
  for (const extra of [{ findFullText: false }, { pdfPath: "/input.pdf" }]) {
    const f = fixture({ timerDivisor: 50 });
    const response = await new f.api.AddDOIEndpoint().run({
      data: { doi: ANNUAL_DOI, collectionKey: null, ...extra },
    });
    assert.equal(response[0], 200);
    const body = JSON.parse(response[2]);
    assert.equal(body.fullText.status, extra.pdfPath ? "found" : "skipped");
    assert.equal(f.stats.chrome, 0);
    assert.equal(f.stats.translations, 0);
    assert.equal(f.stats.native, 0);
    assert.ok(
      !(f.stats.cdp || []).some((x) =>
        x.params?.expression?.includes("form.requestSubmit()"),
      ),
    );
  }
});

test("Annual Reviews identification uses API publisher metadata, never DOI prefixes or webpage journal labels", async () => {
  const otherDOI = "10.9999/shared-prefix-example";
  const f = fixture({ crossref: { ...ANNUAL_METADATA, DOI: otherDOI } });
  assert.equal(
    (await f.api.lookupAnnualReviewsMetadata(otherDOI)).publisher,
    "Annual Reviews",
  );
  const other = fixture({
    annualCrossref: { ...ANNUAL_METADATA, publisher: "Other Publisher" },
  });
  const response = await new other.api.AddDOIEndpoint().run({
    data: { doi: ANNUAL_DOI, collectionKey: null, findFullText: false },
  });
  assert.equal(response[0], 200);
  assert.equal(other.stats.translations, 1);
  assert.equal(other.stats.chrome, 0);
  const unavailable = fixture({ annualMetadataFailure: true });
  assert.equal(
    await unavailable.api.lookupAnnualReviewsMetadata(ANNUAL_DOI),
    undefined,
  );
  const item = other.parent(ANNUAL_DOI);
  Object.assign(item.fields, {
    publicationTitle: "Annual Review of Psychology",
    url: ANNUAL_URL,
    ISSN: "0066-4308",
  });
  assert.equal((await other.api.findFullText(item)).source, "native");
  assert.equal(other.stats.chrome, 0);
});

test("Annual Reviews validates metadata before saving a parent", async () => {
  for (const [options, code] of [
    [
      { annualCrossref: { ...ANNUAL_METADATA, DOI: "10.9999/wrong" } },
      "DOI_MISMATCH",
    ],
    [{ annualCrossref: { ...ANNUAL_METADATA, title: [] } }, "LOOKUP_FAILED"],
    [
      { annualCrossref: { ...ANNUAL_METADATA, "container-title": [] } },
      "LOOKUP_FAILED",
    ],
  ]) {
    const f = fixture({ ...options, timerDivisor: 100 });
    const response = await new f.api.AddDOIEndpoint().run({
      data: { doi: ANNUAL_DOI, collectionKey: null },
    });
    assert.equal(JSON.parse(response[2]).code, code);
    assert.equal(f.items.size, 0);
    assert.equal(f.stats.translations, 0);
    assert.equal(f.stats.activeChrome, 0);
    assert.ok(
      ![...f.files.keys()].some((p) =>
        p.startsWith("/data/doi2pdf/downloads/"),
      ),
    );
  }
});

test("Annual Reviews download failures retain the parent and clean streams", async () => {
  for (const [options, code] of [
    [{ annualPageDOI: "10.9999/wrong" }, "DOI_MISMATCH"],
    [
      {
        annualFinalURL:
          "https://www.annualreviews.org.evil.test/content/journals/" +
          ANNUAL_DOI,
      },
      "UNEXPECTED_PUBLISHER",
    ],
    [{ chromeChallenge: true }, "NEEDS_BROWSER_ACCESS"],
    [{ annualStatus: 403 }, "ANNUALREVIEWS_PDF_UNAVAILABLE"],
    [{ annualFormMissing: true }, "ANNUALREVIEWS_PDF_UNAVAILABLE"],
    [
      { annualFormAction: ANNUAL_PDF.replace(ANNUAL_DOI, "10.1146/wrong") },
      "UNEXPECTED_PUBLISHER",
    ],
    [
      { annualPDFURL: ANNUAL_PDF.replace(ANNUAL_DOI, "10.1146/wrong") },
      "UNEXPECTED_PUBLISHER",
    ],
    [{ chromeHTML: true }, "INVALID_PDF"],
    [{ chromeHangPDF: true }, "ANNUALREVIEWS_TIMEOUT"],
    [{ streamError: true }, undefined],
    [{ streamNoEOF: true }, "ANNUALREVIEWS_TIMEOUT"],
  ]) {
    const f = fixture({ ...options, timerDivisor: 100 });
    const item = f.parent(ANNUAL_DOI);
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "failed");
    // Cancellation replies immediately; the owned stream then releases its files.
    await delay(25);
    if (code) assert.equal(result.code, code);
    assert.ok(f.items.has(item.id));
    assert.equal(f.stats.native, 0);
    assert.equal(f.stats.imports, 0);
    assert.equal(f.stats.activeChrome, 0);
    assert.ok(
      ![...f.files.keys()].some((p) =>
        p.startsWith("/data/doi2pdf/downloads/"),
      ),
    );
  }
});

test("Annual Reviews, Cell and PNAS serialize their shared Chrome profile", async () => {
  const f = fixture({ nativeFailure: true, timerDivisor: 20 });
  const cell = f.parent(CELL_DOI);
  Object.assign(cell.fields, CELL_FIELDS);
  const results = await Promise.all([
    f.api.findFullText(f.parent(ANNUAL_DOI)),
    f.api.findFullText(cell),
    f.api.findFullText(f.parent(PNAS_DOI)),
  ]);
  assert.deepEqual(
    results.map((x) => x.source),
    ["annualreviews", "cell", "pnas"],
  );
  assert.equal(f.stats.maxChrome, 1);
  assert.equal(f.stats.activeChrome, 0);
});

test("a late Cell stream write is cleaned after deadline cancellation", async () => {
  const f = fixture({ streamWriteDelay: 180, timerDivisor: 500 });
  const item = f.parent(CELL_DOI);
  Object.assign(item.fields, CELL_FIELDS);
  const result = await f.api.findFullText(item);
  assert.equal(result.code, "CELL_TIMEOUT");
  await delay(200);
  assert.equal(f.stats.imports, 0);
  assert.equal(f.stats.activeChrome, 0);
  assert.ok(
    ![...f.files.keys()].some((path) =>
      path.startsWith("/data/doi2pdf/downloads/"),
    ),
  );
});
