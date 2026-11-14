// Builds src/profile/loaders/vssLeaves.json from the vehicle-profile-spec VSS catalog.
// Usage: node scripts/generate-vss-leaves.mjs <path to vehicle-profile-spec>
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const specRoot = process.argv[2];
if (specRoot === undefined) {
  throw new Error("Pass the path to a vehicle-profile-spec checkout");
}

const catalog = JSON.parse(readFileSync(join(specRoot, "catalog/vss-6.1.json"), "utf8"));
const leaves = {};

function visit(nodes, prefix) {
  for (const [name, node] of Object.entries(nodes)) {
    const path = prefix === "" ? name : `${prefix}.${name}`;
    if (node.children !== undefined) {
      visit(node.children, path);
      continue;
    }
    leaves[path] = {
      datatype: node.datatype,
      ...(node.unit !== undefined ? { unit: node.unit } : {}),
      ...(node.allowed !== undefined ? { allowed: node.allowed } : {}),
    };
  }
}

visit(catalog, "");

const output = new URL("../src/profile/loaders/", import.meta.url);
writeFileSync(new URL("vssLeaves.json", output), `${JSON.stringify(leaves)}\n`);
// The vocabulary is JSON under a .yaml name in the spec repository.
copyFileSync(join(specRoot, "docs/vocabulary.yaml"), new URL("vocabulary.json", output));
