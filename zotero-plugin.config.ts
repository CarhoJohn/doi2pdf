import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  // Include the package version so builds remain identifiable in this directory.
  xpiName: `${pkg.config.addonRef}-v${pkg.version}`,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        // Keep this path relative to `dist` so custom build destinations also
        // package the bundle into the XPI instead of leaving it behind.
        outfile: `addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  release: {
    bumpp: {
      // The changelog generator excludes the version commit using this template.
      commit: "chore(publish): release v%s",
    },
    github: {
      /**
       * Normalize historical aliases in the generated contributor list.
       *
       * Args:
       *   ctx: Scaffold context containing the generated changelog.
       *
       * Returns:
       *   Release notes with deduplicated canonical contributor names.
       */
      releaseNote(ctx) {
        const heading = "### ❤️ Contributors";
        const [notes, contributors] = ctx.release.changelog.split(heading);
        if (!contributors) return ctx.release.changelog;

        // Scaffold reads raw Git names, so .mailmap alone cannot merge aliases.
        const authors = contributors
          .trim()
          .split("\n")
          .map((line) =>
            line.replace(
              /^- (?:Carho|CarhoJohn|JiangJiahao)(?:\s.*)?$/,
              "- Carho",
            ),
          );
        return `${notes}${heading}\n\n${[...new Set(authors)].join("\n")}`;
      },
    },
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
