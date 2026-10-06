import { errorResponse, jsonResponse } from "./helpers";
import { IdentifierError, normalizeDOI } from "../services/identifier";
import { importPDF } from "../services/pdf";

/** Import a local PDF as a child of an existing DOI-matched item. */
export class ImportPDFEndpoint extends Zotero.Server.LocalAPI.Schema {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];

  /**
   * Validate the explicit parent and copy the supplied PDF into its storage.
   *
   * Args:
   *   req: JSON request with itemKey, expectedDOI, and absolute pdfPath.
   * Returns:
   *   A JSON response containing the parent and attachment identifiers.
   */
  async run(req: {
    data?: { itemKey?: unknown; expectedDOI?: unknown; pdfPath?: unknown };
  }) {
    try {
      const { itemKey, expectedDOI, pdfPath } = req.data ?? {};
      if (typeof itemKey !== "string" || !itemKey.trim()) {
        throw new IdentifierError("ITEM_NOT_FOUND", "itemKey is required");
      }
      const doi = normalizeDOI(expectedDOI);
      if (!doi)
        throw new IdentifierError("INVALID_DOI", "expectedDOI is required");
      if (typeof pdfPath !== "string" || !pdfPath.trim()) {
        throw new IdentifierError("INVALID_PDF", "pdfPath is required");
      }
      const item = Zotero.Items.getByLibraryAndKey(
        Zotero.Libraries.userLibraryID,
        itemKey.trim(),
      );
      if (!item || item.deleted || !item.isRegularItem()) {
        throw new IdentifierError("ITEM_NOT_FOUND", "Parent item not found");
      }
      const attachment = await importPDF(item, pdfPath, doi);
      return jsonResponse(200, {
        status: "success",
        itemID: item.id,
        itemKey: item.key,
        fullText: {
          status: "found",
          attachmentID: attachment.id,
          attachmentKey: attachment.key,
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  }
}
