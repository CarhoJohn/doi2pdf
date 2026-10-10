import {
  BasicTool,
  ProgressWindowHelper,
  UITool,
  makeHelperTool,
  unregister,
} from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

/**
 * Create the toolkit used by the plugin and each main window.
 *
 * Returns:
 *   A configured toolkit with UI cleanup and startup progress helpers.
 */
function createZToolkit() {
  // Toolkit 6 removes ZoteroToolkit; compose only the modules this plugin uses.
  const _ztoolkit = new MyToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

/**
 * Apply the plugin's logging, UI and progress-window configuration.
 *
 * Args:
 *   _ztoolkit: Toolkit instance to configure.
 */
function initZToolkit(_ztoolkit: ReturnType<typeof createZToolkit>) {
  const env = __env__;
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = env === "production";
  _ztoolkit.UI.basicOptions.ui.enableElementJSONLog = __env__ === "development";
  _ztoolkit.UI.basicOptions.ui.enableElementDOMLog = __env__ === "development";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  _ztoolkit.ProgressWindow.setIconURI(
    "default",
    `chrome://${config.addonRef}/content/icons/favicon.png`,
  );
}

/** Compose the Toolkit 6 modules required by the existing plugin hooks. */
class MyToolkit extends BasicTool {
  UI: UITool;
  // Preserve the helper's version metadata and the existing constructor API.
  ProgressWindow = makeHelperTool(ProgressWindowHelper, this);

  /** Initialize UI with the same options as the base toolkit. */
  constructor() {
    super();
    this.UI = new UITool(this);
  }

  /** Remove UI elements owned by this toolkit during unload or shutdown. */
  unregisterAll() {
    unregister(this);
  }
}
