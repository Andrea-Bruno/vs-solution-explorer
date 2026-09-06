import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesFileName, normalizeSearchQuery } from "../../../src/solutionExplorer/search/fileNameMatch.js";

describe("normalizeSearchQuery", () => {
  it("trims surrounding whitespace", () => {
    assert.equal(normalizeSearchQuery("  Program  "), "program");
  });

  it("lowercases the query", () => {
    assert.equal(normalizeSearchQuery("Page.XAML"), "page.xaml");
  });
});

describe("matchesFileName", () => {
  it("matches a substring of the file name, case-insensitively", () => {
    assert.equal(matchesFileName("program", "Program.cs"), true);
    assert.equal(matchesFileName("PROGRAM", "program.cs"), true);
    assert.equal(matchesFileName("app", "appsettings.json"), true);
  });

  it("matches a file name with its extension when typed in full", () => {
    assert.equal(matchesFileName("Program.cs", "Program.cs"), true);
    assert.equal(matchesFileName("Program.cs", "Program.vb"), false);
  });

  it("matches file names only, not path segments", () => {
    // The function receives the bare file name, so a folder that contains the file cannot match.
    assert.equal(matchesFileName("Controllers", "HomeController.cs"), false);
    assert.equal(matchesFileName("controller", "HomeController.cs"), true);
  });

  it("does not match a partial name with the query split across segments", () => {
    assert.equal(matchesFileName("roler", "HomeController.cs"), false);
  });

  it("does not match when the name is unrelated", () => {
    assert.equal(matchesFileName("startup", "Program.cs"), false);
  });

  it("matches every file for an empty or blank filter", () => {
    assert.equal(matchesFileName("", "anything.txt"), true);
    assert.equal(matchesFileName("   ", "anything.txt"), true);
  });
});
