import { errorResponse, jsonResponse } from "./helpers";
import {
  addByIdentifier,
  findItemByDOI,
  IdentifierError,
  normalizeDOI,
  resolveCollection,
  summarizeItem,
} from "../services/identifier";
import { findFullText } from "../services/fullText";

/** HTTP endpoint for idempotent DOI ingestion and optional full-text lookup. */
export class AddDOIEndpoint extends Zotero.Server.LocalAPI.Schema {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];

  /**
   * Add or reuse a DOI item and optionally resolve its full text.
   *
   * @param req Zotero local API request.
   * @returns HTTP response tuple.
   */
  async run(req: {
    data?: {
      doi?: unknown;
      collectionKey?: unknown;
      findFullText?: unknown;
      methods?: unknown;
    };
  }) {
    try {
      const doi = normalizeDOI(req.data?.doi);
      if (!doi) throw new IdentifierError("INVALID_DOI", "Could not parse DOI");
      const collectionKey = req.data?.collectionKey;
      const collections = resolveCollection(collectionKey);
      const shouldFindFullText = req.data?.findFullText !== false;
      if (
        req.data?.findFullText !== undefined &&
        typeof req.data.findFullText !== "boolean"
      ) {
        throw new IdentifierError(
          "INVALID_DOI",
          "findFullText must be a boolean",
        );
      }

      let methods: string[] | undefined;
      if (req.data?.methods !== undefined) {
        if (
          !Array.isArray(req.data.methods) ||
          !req.data.methods.every((method) => typeof method === "string")
        ) {
          throw new IdentifierError(
            "INVALID_DOI",
            "methods must be an array of strings",
          );
        }
        methods = req.data.methods as string[];
      }

      let item = await findItemByDOI(doi);
      const created = !item;
      if (!item) {
        item = await addByIdentifier(doi, collectionKey as string | undefined);
      } else if (collections !== false) {
        item.addToCollection(collections[0]);
        await item.saveTx();
      }

      const fullText = shouldFindFullText
        ? await findFullText(item, methods)
        : { status: "skipped" as const };
      return jsonResponse(200, {
        status: "success",
        item: summarizeItem(item),
        itemID: item.id,
        itemKey: item.key,
        created,
        fullText,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }
}
