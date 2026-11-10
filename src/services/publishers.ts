import { normalizeDOI } from "./identifier";

/** Bundled DOI route candidates; shared prefixes do not prove journal identity. */
export const DOI_PREFIX_PUBLISHERS = {
  "10.1038": "nature-family",
  "10.1016": "cell-press",
  "10.1126": "science-family",
  "10.1146": "annual-reviews",
  "10.1073": "pnas",
  "10.1037": "apa",
} as const;

export type DOIPublisher =
  (typeof DOI_PREFIX_PUBLISHERS)[keyof typeof DOI_PREFIX_PUBLISHERS];

/**
 * Find a packaged publisher hint from the exact DOI prefix.
 *
 * Args:
 *   value: DOI or DOI URL supplied by the caller.
 * Returns:
 *   The candidate publisher route, or undefined when the prefix is unknown.
 */
export function getDOIPublisher(value: unknown): DOIPublisher | undefined {
  const doi = normalizeDOI(value);
  if (!doi) return undefined;
  const prefix = doi.split("/", 1)[0] as keyof typeof DOI_PREFIX_PUBLISHERS;
  return DOI_PREFIX_PUBLISHERS[prefix];
}
