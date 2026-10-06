import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import process from "node:process";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { buildSync } from "esbuild";

const bundle = buildSync({
  stdin: {
    contents: `export * from './src/services/fullText';
      export * from './src/services/pdf';
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
      saveTx: async () => {},
    };
    items.set(item.id, item);
    return item;
  }
  const subprocess = {
    pathSearch: async () => {
      if (options.curlMissing) throw new Error("curl executable not found");
      return "/system/curl";
    },
    async call(config) {
      if (options.launchDelay) await delay(options.launchDelay);
      const args = config.arguments;
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
            : options.html
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
    Libraries: { userLibraryID: 1 },
    getMainWindow: () => ({
      URL,
      ChromeUtils: { importESModule: () => ({ Subprocess: subprocess }) },
      Services: { dirsvc: { get: () => file("/system") } },
      Ci: { nsIFile: {} },
      DOMParser: class {
        parseFromString() {
          return {
            querySelector(selector) {
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
        return setTimeout(callback, ms / 200);
      },
      clearTimeout,
    }),
    getTempDirectory: () => file("/temp"),
    Utilities: {
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
          return [parent(this.doi)];
        }
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle, { module, exports: module.exports, Zotero, URL });
  return { api: module.exports, Zotero, stats, files, parent, items };
}

test("native success bypasses publisher and imports once", async () => {
  const f = fixture();
  const item = f.parent();
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "native");
  assert.equal(f.stats.requests.length, 0);
  assert.equal(f.stats.imports, 1);
  assert.equal(item.attachments.length, 1);
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
  assert.ok(![...f.files.keys()].some((x) => x.startsWith("/temp/")));
});

test("15-second timer triggers publisher; a late native result cannot duplicate it", async () => {
  const f = fixture({ nativeDelay: 120 });
  const item = f.parent();
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "nature");
  assert.ok(f.stats.timers.includes(15000));
  await delay(140);
  assert.equal(f.stats.imports, 1);
  assert.equal(item.attachments.length, 1);
  assert.ok(![...f.files.keys()].some((x) => x.startsWith("/temp/")));
});

test("late native success can win while fallback is pending", async () => {
  const f = fixture({ nativeDelay: 85, publisherDelay: 80 });
  const item = f.parent();
  const result = await f.api.findFullText(item);
  assert.equal(result.source, "native");
  assert.ok(f.stats.requests.length > 0);
  await delay(200);
  assert.equal(f.stats.imports, 1);
  assert.ok(![...f.files.keys()].some((x) => x.startsWith("/temp/")));
});

test("20-second fallback budget aborts the request and creates no attachment", async () => {
  for (const options of [{ hang: true }, { hangPDF: true }]) {
    const f = fixture({ nativeFailure: true, ...options });
    const item = f.parent();
    const result = await f.api.findFullText(item);
    assert.equal(result.status, "failed");
    assert.match(result.message, /20 seconds/);
    assert.equal(f.stats.timers.filter((x) => x === 20000).length, 1);
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
  assert.ok(![...f.files.keys()].some((x) => x.startsWith("/temp/")));
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
    assert.ok(![...f.files.keys()].some((x) => x.startsWith("/temp/")));
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
