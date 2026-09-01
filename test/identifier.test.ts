import { assert } from "chai";
import { normalizeDOI } from "../src/services/identifier";

describe("normalizeDOI", function () {
  it("normalizes DOI prefixes, URLs, case, and citation punctuation", function () {
    assert.equal(
      normalizeDOI(" https://doi.org/10.1038/S41562-026-02563-9. "),
      "10.1038/s41562-026-02563-9",
    );
    assert.equal(normalizeDOI("doi:10.1000/ABC123)"), "10.1000/abc123");
  });

  it("rejects values that are not DOI identifiers", function () {
    assert.isNull(normalizeDOI("not-a-doi"));
    assert.isNull(normalizeDOI(undefined));
  });
});
