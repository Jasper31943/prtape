import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { VERSION } from "../src/version.js";
import { root } from "./helpers.js";

describe("package", () => {
  it("keeps the CLI version aligned with package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      name: string;
      version: string;
      bin: { prtape: string; "prtape-cli": string };
    };
    assert.equal(pkg.name, "prtape-cli");
    assert.equal(VERSION, pkg.version);
    assert.equal(pkg.bin.prtape, "./dist/cli.js");
    assert.equal(pkg.bin["prtape-cli"], "./dist/cli.js");
  });
});
