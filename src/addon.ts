// doi2pdf - Zotero DOI 元数据和全文扩展入口文件
// 提供通过标识符添加项目的 API 端点

import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { AddDOIEndpoint } from "./endpoints/addDOI";
import { FindFullTextEndpoint } from "./endpoints/findFullText";
import { ImportPDFEndpoint } from "./endpoints/importPDF";
import { resolveDestinationCollection } from "./services/identifier";

// 定义 AddItemEndpoint 类

// Plus 端点 - 检查 API 是否正常运行
Zotero.Server.LocalAPI.Plus = class extends Zotero.Server.LocalAPI.Schema {
  supportedMethods = ["GET"];

  async run(_: any): Promise<[number, string, string]> {
    return [200, "text/plain", "Zotero Local API Plus is running."];
  }
};

// 添加项目端点 - 通过标识符（如 DOI、ISBN 等）添加项目到 Zotero
Zotero.Server.LocalAPI.AddItemEndpoint = class extends (
  Zotero.Server.LocalAPI.Schema
) {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = true;

  // 处理添加项目请求
  // req.data.identifier: 标识符字符串（支持 DOI、ISBN、PMID 等）
  // req.data.collectionKey: 可选的收藏夹 key
  async run(req: {
    data: { identifier: string; collectionKey?: string };
  }): Promise<[number, string, string]> {
    try {
      const data = req.data;
      const identifierStr = data.identifier;
      const collectionKey = data.collectionKey;

      // 验证标识符是否提供
      if (!identifierStr) {
        return [400, "text/plain", "Error: No identifier provided"];
      }

      // 从字符串中提取标识符
      const identifiers = Zotero.Utilities.extractIdentifiers(identifierStr);
      if (!identifiers.length) {
        return [400, "text/plain", "Error: Could not parse identifier"];
      }

      // 获取用户的库 ID 和目标收藏夹；未指定 key 时使用插件设置。
      const libraryID = Zotero.Libraries.userLibraryID;
      const collections = await resolveDestinationCollection(collectionKey);

      // 遍历每个标识符并添加对应的项目
      const newItems: Zotero.Item[] = [];
      for (const identifier of identifiers) {
        const translate = new Zotero.Translate.Search();
        translate.setIdentifier(identifier);

        // 获取适用于该标识符的翻译器
        const translators = await translate.getTranslators();
        if (!translators.length) continue;

        translate.setTranslator(translators);

        try {
          // 执行翻译并保存项目，包括附件
          const items = await translate.translate({
            libraryID,
            collections,
            saveAttachments: true,
          });
          newItems.push(...items);
        } catch (e: any) {
          // 记录错误但继续处理其他标识符
          Zotero.logError(e);
        }
      }

      // 返回添加结果
      if (newItems.length > 0) {
        return [
          200,
          "application/json",
          JSON.stringify({
            status: "success",
            addedCount: newItems.length,
            titles: newItems.map((i) => i.getField("title")),
          }),
        ];
      } else {
        return [404, "text/plain", "Failed to find or save any items."];
      }
    } catch (e: any) {
      // 捕获并返回服务器错误
      return [500, "text/plain", "Internal Server Error: " + e.message];
    }
  }
};

// 添加项目端点 - 获取当前 Collection 列表
Zotero.Server.LocalAPI.GetSelectedCollectionEndpoint = class extends (
  Zotero.Server.LocalAPI.Schema
) {
  supportedMethods = ["GET"];

  async run(_: any): Promise<[number, string, string]> {
    try {
      // 没有活动窗口时与未选中收藏夹采用相同的响应，兼容可空的 Zotero 面板类型。
      const collection = Zotero.getActiveZoteroPane()?.getSelectedCollection();

      if (collection) {
        ztoolkit.log("当前 Collection 名称:", collection.name);
        ztoolkit.log("当前 Collection Key:", collection.key);
        return [
          200,
          "application/json",
          JSON.stringify({
            name: collection.name,
            key: collection.key,
          }),
        ];
      } else {
        // 如果用户选中了“我的出版物”或“未分类条目”，getSelectedCollection 会返回 null
        ztoolkit.log("当前未选中特定 Collection (可能在根目录或特殊分类下)");
        return [500, "text/plain", "No Collection selected."];
      }
    } catch (e: any) {
      // 捕获并返回服务器错误
      return [500, "text/plain", "Internal Server Error: " + e.message];
    }
  }
};

// 插件主类 - 管理插件的生命周期和数据
class Addon {
  public data: {
    alive: boolean; // 插件是否活跃
    config: typeof config; // 配置对象
    env: "development" | "production"; // 环境类型
    initialized?: boolean; // 插件是否已初始化
    ztoolkit: ZToolkit; // ZToolkit 实例
    locale?: {
      current: any;
    }; // 当前语言设置
    prefs?: {
      window: Window;
      columns: Array<ColumnOptions>;
      rows: Array<{ [dataKey: string]: string }>;
    }; // 偏好设置窗口信息
    dialog?: DialogHelper; // 对话框助手
  };
  // 生命周期钩子
  public hooks: typeof hooks;
  // 对外暴露的 API
  public api: object;

  // 构造函数 - 初始化插件
  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {};
  }

  // 注册 API 端点到 Zotero Server
  /** Register all local API routes exposed by the plugin. */
  public registerEndpoints() {
    Zotero.Server.LocalAPI.AddDOIEndpoint = AddDOIEndpoint;
    Zotero.Server.LocalAPI.FindFullTextEndpoint = FindFullTextEndpoint;
    Zotero.Server.Endpoints["/api/plus/add-item-by-id"] =
      Zotero.Server.LocalAPI.AddItemEndpoint;
    Zotero.Server.Endpoints["/api/plus/add-doi"] =
      Zotero.Server.LocalAPI.AddDOIEndpoint;
    Zotero.Server.Endpoints["/api/plus/find-fulltext"] =
      Zotero.Server.LocalAPI.FindFullTextEndpoint;
    Zotero.Server.Endpoints["/api/plus/import-pdf"] = ImportPDFEndpoint;
    Zotero.Server.Endpoints["/api/plus"] = Zotero.Server.LocalAPI.Plus;
    Zotero.Server.Endpoints["/api/plus/selected-collection"] =
      Zotero.Server.LocalAPI.GetSelectedCollectionEndpoint;
    ztoolkit.log("Registering Local API Plus endpoint");
    ztoolkit.log(Zotero.Server.LocalAPI.Plus);
  }

  /** Remove routes registered by this plugin during shutdown or reload. */
  public unregisterEndpoints() {
    delete Zotero.Server.Endpoints["/api/plus/add-item-by-id"];
    delete Zotero.Server.Endpoints["/api/plus/add-doi"];
    delete Zotero.Server.Endpoints["/api/plus/find-fulltext"];
    delete Zotero.Server.Endpoints["/api/plus/import-pdf"];
    delete Zotero.Server.Endpoints["/api/plus/selected-collection"];
    delete Zotero.Server.Endpoints["/api/plus"];
  }
}

export default Addon;
