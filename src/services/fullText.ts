/** Full-text resolution through Zotero's native attachment resolver. */

export type FullTextStatus = "found" | "not_found" | "failed";

export interface FullTextResult {
  status: FullTextStatus;
  attachmentID?: number;
  attachmentKey?: string;
  message?: string;
}

/**
 * Return the first child file attachment that can represent full text.
 *
 * @param item Zotero regular item.
 * @returns Matching attachment, or undefined when none exists.
 */
function getFileAttachment(item: Zotero.Item): Zotero.Item | undefined {
  return (item.getAttachments?.() ?? [])
    .map(
      (attachmentID: number) =>
        Zotero.Items.get(attachmentID) as Zotero.Item | undefined,
    )
    .find((attachment) => {
      if (!attachment || !attachment.isAttachment?.()) return false;
      if (attachment.isPDFAttachment?.()) return true;
      if (attachment.getField("contentType") === "application/pdf") return true;
      return (
        attachment.attachmentLinkMode !== 0 && !!attachment.getField("path")
      );
    });
}

/**
 * Check whether an item already has a file attachment.
 *
 * @param item Zotero regular item.
 * @returns True when a child file attachment is present.
 */
export function hasFullTextAttachment(item: Zotero.Item): boolean {
  return !!getFileAttachment(item);
}

/**
 * Find and attach full text using Zotero's DOI, URL, OA, and custom resolvers.
 *
 * @param item Zotero regular item.
 * @param methods Optional resolver order.
 * @returns Structured full-text result.
 */
export async function findFullText(
  item: Zotero.Item,
  methods?: string[],
): Promise<FullTextResult> {
  if (hasFullTextAttachment(item)) {
    const attachment = getFileAttachment(item);
    return {
      status: "found",
      attachmentID: attachment?.id,
      attachmentKey: attachment?.key,
    };
  }

  try {
    const options = methods?.length ? { methods } : undefined;
    const attachment = await Zotero.Attachments.addAvailableFile(
      item,
      options as any,
    );
    if (!attachment) return { status: "not_found" };
    return {
      status: "found",
      attachmentID: attachment.id,
      attachmentKey: attachment.key,
    };
  } catch (error: any) {
    Zotero.logError(error);
    return {
      status: "failed",
      message: error?.message || "Full-text download failed",
    };
  }
}
