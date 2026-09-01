// ===== 依赖导入 =====
import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

// ===== 初始化全局工具实例 =====
// BasicTool 提供对 Zotero 全局对象的访问接口
const basicTool = new BasicTool();

// ===== 插件初始化检查与实例创建 =====
/**
 * 检查插件是否已经初始化
 * - 使用 config.addonInstance 从 package.json 获取插件实例名称（"Doi2Pdf"）
 * - 如果 Zotero 全局对象中不存在该插件实例，则进行初始化
 *
 * 这种设计用来防止在多次加载时重复初始化插件
 */
// @ts-expect-error - Plugins instance not typed.
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  // 创建插件主实例，所有业务逻辑都由 Addon 类处理
  _globalThis.addon = new Addon();

  // 为 ztoolkit 定义全局访问器
  // 这样在其他模块中可以直接访问 ztoolkit，而实际访问的是 addon.data.ztoolkit
  // 使用 getter 确保总是获取最新的引用
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });

  // 将插件实例注册到 Zotero 全局对象中
  // 这使得插件实例在整个应用生命周期内持久化和可访问
  // @ts-expect-error - Plugins instance not typed.
  Zotero[config.addonInstance] = addon;
}

// ===== 全局属性定义工具函数 =====
/**
 * 在全局作用域（_globalThis）上定义属性
 * 支持两种用法：
 * 1. defineGlobal("name") - 从 BasicTool 的全局对象中获取属性
 * 2. defineGlobal("name", getter) - 使用自定义 getter 函数获取属性值
 *
 * 优点：
 * - 延迟初始化：只有在实际访问时才执行 getter，节省资源
 * - 动态引用：通过 getter 总能获取最新值，适用于可能动态变化的对象
 * - 全局访问：定义在 _globalThis 上使得属性在全局作用域可访问
 */
function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      // 如果提供了自定义 getter，使用自定义 getter；否则从 BasicTool 的全局对象获取
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
