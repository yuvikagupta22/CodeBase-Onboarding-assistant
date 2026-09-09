const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { chunkSource, chunkDocument } = require("../src/services/chunker");

describe("chunkSource", () => {
  test("indexes top-level variable declarations alongside functions", () => {
    const chunks = chunkSource({
      source: [
        "const express = require(\"express\");",
        "const port = process.env.PORT || 3001;",
        "app.listen(port, () => console.log(port));",
      ].join("\n"),
      language: "javascript",
      filePath: "app.js",
    });

    assert.ok(
      chunks.some(
        (chunk) =>
          chunk.metadata.name === "port" &&
          chunk.content.includes("process.env.PORT || 3001")
      )
    );
  });
});

describe("chunkDocument", () => {
  test("indexes repository documentation with line metadata", () => {
    const chunks = chunkDocument({
      source: "# Axios\n\nA promise based HTTP client for the browser and Node.js.",
      filePath: "README.md",
    });

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].metadata.isDocumentation, true);
    assert.match(chunks[0].content, /promise based HTTP client/);
  });
});