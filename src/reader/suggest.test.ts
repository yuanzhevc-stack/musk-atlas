import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { resetSuggestForTests, suggestExpression } from "./suggest";

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  },
});

const suggestion = {
  source: "xai",
  model: "test-model",
  primary: {
    expression: "set aside",
    usage: "先放到一边，不是扔掉。",
    example: { en: "Set it aside for now.", zh: "先放到一边。" },
  },
  alternatives: [{ expression: "let go", usage: "更偏松开手里的东西。" }],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("suggestExpression", { concurrency: 1 }, () => {
  beforeEach(() => {
    store.clear();
    resetSuggestForTests();
  });

  test("caches a real suggestion and refuses a body that is not one", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return json(suggestion);
    };
    const first = await suggestExpression("放下", "", fetchImpl);
    const second = await suggestExpression("放下", "", fetchImpl);
    assert.equal(first.ok && first.data.primary.expression, "set aside");
    assert.equal(second.ok && second.cached, true);
    assert.equal(calls, 1);
    resetSuggestForTests();
    const third = await suggestExpression("放下", "", fetchImpl);
    assert.equal(third.ok && third.cached, true);
    assert.equal(calls, 1);

    const bad = await suggestExpression("另一句", "别的情境", async () => json({ primary: suggestion.primary }));
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error, "invalid");
  });

  test("an old TTS empty response is not treated as a failed suggestion", async () => {
    const res = await suggestExpression("放下", "", async () => new Response("empty", { status: 400, headers: { "content-type": "text/plain" } }));
    assert.deepEqual(res, { ok: false, error: "unconfigured" });
  });

  test("rate, timeout, and network stay distinct", async () => {
    assert.deepEqual(await suggestExpression("放下", "", async () => json({ error: "rate" }, 429)), { ok: false, error: "rate" });
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.deepEqual(await suggestExpression("放下", "x", async () => Promise.reject(abort)), { ok: false, error: "timeout" });
    assert.deepEqual(await suggestExpression("放下", "y", async () => Promise.reject(new Error("network"))), { ok: false, error: "unreachable" });
  });
});
