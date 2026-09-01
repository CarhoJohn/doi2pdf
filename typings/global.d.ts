declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

declare namespace Zotero {
  namespace Server {
    namespace LocalAPI {
      class Schema {
        supportedMethods?: string[];
        supportedDataTypes?: string[];
        permitBookmarklet?: boolean;
        run(request: any): Promise<[number, string, string]>;
      }
      let Plus: new () => Schema;
      let AddItemEndpoint: new () => Schema;
      let GetSelectedCollectionEndpoint: new () => Schema;
      let AddDOIEndpoint: new () => Schema;
      let FindFullTextEndpoint: new () => Schema;
    }
    const Endpoints: {
      [key: string]: any;
    };
  }
}
