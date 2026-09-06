import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BUILD_CONFIGURATIONS,
  mergeBuildConfigurations,
  parseDeclaredConfigurations,
} from "../../../src/solutionExplorer/runControls/buildConfigurations.js";

describe("parseDeclaredConfigurations", () => {
  it("reads the semicolon-delimited Configurations element", () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <Configurations>Debug;Release;QA</Configurations>
  </PropertyGroup>
</Project>`;
    assert.deepEqual(parseDeclaredConfigurations(csproj), ["Debug", "Release", "QA"]);
  });

  it("tolerates commas and stray whitespace", () => {
    assert.deepEqual(parseDeclaredConfigurations(`<Configurations> Debug , Release </Configurations>`), [
      "Debug",
      "Release",
    ]);
  });

  it("returns nothing when no Configurations element exists", () => {
    assert.deepEqual(parseDeclaredConfigurations(`<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>`), []);
  });

  it("returns nothing for an empty element", () => {
    assert.deepEqual(parseDeclaredConfigurations(`<Configurations></Configurations>`), []);
  });
});

describe("mergeBuildConfigurations", () => {
  it("offers the defaults when the project declares none", () => {
    assert.deepEqual(mergeBuildConfigurations([]), [...DEFAULT_BUILD_CONFIGURATIONS]);
  });

  it("appends declared configurations without duplicating defaults", () => {
    assert.deepEqual(mergeBuildConfigurations(["QA", "Release"]), ["Debug", "Release", "QA"]);
  });
});
