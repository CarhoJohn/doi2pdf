import { errorResponse, jsonResponse } from "./helpers";
import {
  getOrCreateDOIItem,
  IdentifierError,
  normalizeDOI,
  resolveDestinationCollection,
  summarizeItem,
} from "../services/identifier";
import { findFullText } from "../services/fullText";
import { importPDF, validatePDF } from "../services/pdf";

/** HTTP endpoint for idempotent DOI ingestion and optional full-text lookup. */
export class AddDOIEndpoint extends Zotero.Server.LocalAPI.Schema {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];

  /**
   * Add or reuse a DOI item and optionally resolve its full text.
   *
   * Args:
   *   req: JSON request with DOI, destination, and optional local PDF path.
   * Returns:
   *   HTTP response tuple containing the parent and PDF result.
   */
  async run(req: {
    data?: {
      doi?: unknown;
      collectionKey?: unknown;
      findFullText?: unknown;
      methods?: unknown;
      shortTitle?: unknown;
      pdfPath?: unknown;
    };
  }) {
    try {
      const doi = normalizeDOI(req.data?.doi);
      if (!doi) throw new IdentifierError("INVALID_DOI", "Could not parse DOI");
      const collectionKey = req.data?.collectionKey;
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

      const pdfPath = req.data?.pdfPath;
      if (pdfPath !== undefined) {
        if (typeof pdfPath !== "string" || !pdfPath.trim()) {
          throw new IdentifierError(
            "INVALID_PDF",
            "pdfPath must be a nonempty string",
          );
        }
        await validatePDF(pdfPath);
      }
      const collections = await resolveDestinationCollection(collectionKey);
      const { item, created } = await getOrCreateDOIItem(doi, collectionKey);
      if (!created && collections !== false) {
        item.addToCollection(collections[0]);
        await item.saveTx();
      }

      const shortTitle = req.data?.shortTitle;
      // Preserve translator or existing values unless a usable override is sent.
      if (typeof shortTitle === "string" && shortTitle.trim()) {
        item.setField("shortTitle", shortTitle.trim());
        await item.saveTx();
      }

      // An explicit PDF bypasses network lookup and is attached to this exact parent.
      let fullText;
      if (typeof pdfPath === "string") {
        const attachment = await importPDF(item, pdfPath, doi);
        fullText = {
          status: "found" as const,
          source: "local" as const,
          attachmentID: attachment.id,
          attachmentKey: attachment.key,
        };
      } else {
        fullText = shouldFindFullText
          ? await findFullText(item, methods)
          : { status: "skipped" as const };
      }
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
