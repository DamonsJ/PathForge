import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ships the NC renderer and streaming parser", async () => {
  const [page, renderer, parser] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/nc-renderer.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/nc-parser.worker.js", import.meta.url), "utf8"),
  ]);
  assert.match(page, /路径点/);
  assert.match(page, /point-list-spacer/);
  assert.match(renderer, /WebGL2RenderingContext/);
  assert.match(renderer, /pickFramebuffer/);
  assert.match(renderer, /CHUNK_POINTS/);
  assert.match(parser, /file\.stream\(\)/);
  assert.match(parser, /runPass\(2/);
});
