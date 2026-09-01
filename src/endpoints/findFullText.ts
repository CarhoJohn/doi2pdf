import { errorResponse, jsonResponse } from "./helpers";
import { IdentifierError } from "../services/identifier";
import { findFullText } from "../services/fullText";

/** HTTP endpoint for finding full text for an existing Zotero item. */
export class FindFullTextEndpoint extends Zotero.Server.LocalAPI.Schema {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];

  /**
   * Resolve full text for a regular item by key.
   *
   * @param req Zotero local API request.
   * @returns HTTP response tuple.
   */
  async run(req: { data?: { itemKey?: unknown; methods?: unknown } }) {
    try {
      const itemKey = req.data?.itemKey;
      if (typeof itemKey !== "string" || !itemKey.trim()) {
        throw new IdentifierError("ITEM_NOT_FOUND", "itemKey is required");
      }
      const item = Zotero.Items.getByLibraryAndKey(
        Zotero.Libraries.userLibraryID,
        itemKey.trim(),
      ) as Zotero.Item | undefined;
      if (!item || item.isAttachment?.() || item.isNote?.()) {
        throw new IdentifierError(
          "ITEM_NOT_FOUND",
          `Item not found: ${itemKey}`,
        );
      }

      let methods: string[] | undefined;
      if (req.data?.methods !== undefined) {
        if (
          !Array.isArray(req.data.methods) ||
          !req.data.methods.every((method) => typeof method === "string")
        ) {
          throw new IdentifierError(
            "INVALID_IDENTIFIER",
            "methods must be an array of strings",
          );
        }
        methods = req.data.methods as string[];
      }

      const fullText = await findFullText(item, methods);
      return jsonResponse(200, {
        status: "success",
        item: { id: item.id, key: item.key },
        fullText,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }
}
