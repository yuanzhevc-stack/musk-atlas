import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "node:test";
import type { Atlas } from "../atlas/types";
import { searchAtlas } from "../ui/searchAtlas";
import { resetDictForTests } from "./dict";
import { lookupEnglish } from "./englishLookup";

const root = path.resolve("public/dict");
let failShard = false;

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/dict/")) throw new Error(`offline ${url}`);
    if (failShard && url.includes("/ov.json")) return new Response("no", { status: 500 });
    const name = url.split("/dict/")[1].split("?")[0];
    const file = path.join(root, name);
    if (!existsSync(file)) return new Response("missing", { status: 404 });
    return new Response(readFileSync(file, "utf8"), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("quick english lookup", { concurrency: 1 }, () => {
  beforeEach(() => {
    failShard = false;
    resetDictForTests();
    installFetch();
  });

  test("lesson search misses overhear while the bundled dictionary has it", async () => {
    const atlas = {
      words: [{ id: "1", word: "serendipity", zh: "意外发现珍奇事物的能力", ipa: "", cefr: 1, topic: 0, media: 0, order: 0 }],
    } as Atlas;
    assert.equal(searchAtlas(atlas, "overhear").length, 0);
    assert.equal(searchAtlas(atlas, "seren")[0].word, "serendipity");

    const hit = await lookupEnglish("  Overhear  ");
    assert.equal(hit.kind, "hit");
    if (hit.kind !== "hit") return;
    assert.equal(hit.via, "dict");
    assert.equal(hit.view.headword, "overhear");
    assert.match(hit.view.senses.map((s) => s.text).join(" "), /无意中听到/);
    assert.equal(hit.view.senses.some((s) => s.src === "机器翻译"), false);
  });

  test("inflection and phrase whitespace resolve to the lemma entry", async () => {
    const heard = await lookupEnglish("OVERHEARD");
    assert.equal(heard.kind, "hit");
    if (heard.kind !== "hit") return;
    assert.equal(heard.view.headword, "overhear");
    assert.match(heard.view.formNote, /overheard/);
    assert.match(heard.view.meaning, /无意中听到/);

    const phrase = await lookupEnglish("  Give   UP ");
    assert.equal(phrase.kind, "hit");
    if (phrase.kind !== "hit") return;
    assert.equal(phrase.view.headword, "give up");
    assert.match(phrase.view.meaning, /放弃/);

    const looked = await lookupEnglish("looked at");
    assert.equal(looked.kind, "hit");
    if (looked.kind !== "hit") return;
    assert.equal(looked.view.headword, "look at");
    assert.match(looked.view.formNote, /looked at/);
  });

  test("a missing headword is not a network failure", async () => {
    const miss = await lookupEnglish("xyzzyplughqq");
    assert.equal(miss.kind, "miss");
    if (miss.kind !== "miss") return;
    assert.equal(miss.dictDown, false);
    assert.equal(miss.onlineDown, true);
  });

  test("a failed shard is reported separately and is not cached as a miss", async () => {
    failShard = true;
    const down = await lookupEnglish("overhear");
    assert.equal(down.kind, "miss");
    if (down.kind !== "miss") return;
    assert.equal(down.dictDown, true);
    assert.equal(down.onlineDown, true);

    failShard = false;
    resetDictForTests();
    const again = await lookupEnglish("overhear");
    assert.equal(again.kind, "hit");
  });
});
