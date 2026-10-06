import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { stopPNASDownloads } from "./services/pnasPDF";

let preferencePaneID: string | undefined;

/**
 * Register the plugin's settings pane with Zotero's preferences window.
 *
 * The pane is loaded from the packaged XHTML fragment and is automatically
 * removed by Zotero when the plugin shuts down.
 */
async function registerPreferencePane(): Promise<void> {
  preferencePaneID = await Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: `${rootURI}content/preferences.xhtml`,
    label: addon.data.config.addonName,
  });
}

/**
 * Handle preference pane lifecycle events emitted by the XHTML fragment.
 *
 * @param event Preference pane event name.
 * @param data Event payload containing the pane window.
 */
function onPrefsEvent(event: string, data: { window?: Window }): void {
  if (event !== "load" || !data.window) return;

  addon.data.prefs = {
    window: data.window,
    columns: [],
    rows: [],
  };
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  await registerPreferencePane();

  addon.registerEndpoints();
  Zotero.addShutdownListener(stopPNASDownloads);

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString("startup-begin"),
      type: "default",
      progress: 0,
    })
    .show();

  await Zotero.Promise.delay(1000);
  popupWin.changeLine({
    progress: 30,
    text: `[30%] ${getString("startup-begin")}`,
  });

  await Zotero.Promise.delay(1000);

  popupWin.changeLine({
    progress: 100,
    text: `[100%] ${getString("startup-finish")}`,
  });
  popupWin.startCloseTimer(5000);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  stopPNASDownloads();
  if (preferencePaneID) {
    Zotero.PreferencePanes.unregister(preferencePaneID);
    preferencePaneID = undefined;
  }
  addon.unregisterEndpoints();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export { onPrefsEvent };

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
