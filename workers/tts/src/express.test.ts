import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { handleExpress, resetExpressForTests, type ExpressBucket, type ExpressEnv } from "./express";

function bucket(): ExpressBucket & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      const value = store.get(key);
      if (value === undefined) return null;
      return { async json() { return JSON.parse(value) as unknown; } };
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function env(extra: Partial<ExpressEnv> = {}): ExpressEnv & { BUCKET: ReturnType<typeof bucket> } {
  return { BUCKET: bucket(), XAI_API_KEY: "super-secret-key", EXPRESS_DAILY: "200", ...extra };
}

function post(body: unknown) {
  return new Request("https://worker.test/express", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.5" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function modelFor(user: string) {
  const context = user.split("\n")[1] ?? "";
  const expression = context.includes("歌") ? "happen to hear" : "set aside";
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            primary: {
              expression,
              usage: "只贴合当前这句，换个情境可能是另一个词。",
              example: { en: `Try to ${expression}.`, zh: "先用这个说法。" },
            },
            alternatives: [{ expression: "let go", usage: "更偏松开，不是放弃一件事。" }],
            clips: [{ fake: true }],
          }),
        },
      },
    ],
  };
}

describe("POST /express", { concurrency: 1 }, () => {
  beforeEach(() => resetExpressForTests());

  test("passes arbitrary chinese through, strips extras, and caches", async () => {
    const e = env();
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.max_tokens, 400);
      assert.equal(String(payload.messages[0].content).includes("偶然听到"), false);
      assert.equal(String(payload.messages[0].content).includes("overhear"), false);
      assert.equal(String(init?.headers && (init.headers as Record<string, string>).Authorization).startsWith("Bearer "), true);
      return new Response(JSON.stringify(modelFor(payload.messages[1].content)), { status: 200, headers: { "content-type": "application/json" } });
    };
    const first = await handleExpress(post({ q: "把这件事放下" }), e, {}, { fetchImpl });
    const body = await first.json();
    assert.equal(first.status, 200);
    assert.equal(body.primary.expression, "set aside");
    assert.equal(body.alternatives[0].expression, "let go");
    assert.equal(body.clips, undefined);
    assert.equal(JSON.stringify(body).includes("super-secret-key"), false);
    assert.equal(JSON.stringify(body).includes("fake"), false);

    const song = await handleExpress(post({ q: "不小心听见", context: "是一首歌" }), e, {}, { fetchImpl });
    const songBody = await song.json();
    assert.equal(songBody.primary.expression, "happen to hear");
    assert.notEqual(songBody.primary.expression, body.primary.expression);

    const again = await handleExpress(post({ q: "把这件事放下" }), e, {}, { fetchImpl });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).cached, true);
    assert.equal(calls, 2);
  });

  test("rejects non-chinese, missing key, bad model output, and the daily cap", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not call the model");
    };
    const missing = await handleExpress(post({ q: "放下" }), env({ XAI_API_KEY: "" }), {}, { fetchImpl });
    assert.equal(missing.status, 503);
    assert.equal((await missing.json()).error, "unconfigured");

    const english = await handleExpress(post({ q: "overhear" }), env(), {}, { fetchImpl });
    assert.equal(english.status, 400);
    assert.equal((await english.json()).error, "not_chinese");

    const e = env();
    const bad = await handleExpress(post({ q: "放下" }), e, {}, {
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json and not a card" } }] }), { status: 200 }),
    });
    assert.equal(bad.status, 502);
    assert.equal((await bad.json()).error, "bad_model");
    assert.equal([...e.BUCKET.store.keys()].some((k) => k.startsWith("express/v1/")), false);

    const capped = env({ EXPRESS_DAILY: "1" });
    const okFetch: typeof fetch = async () => new Response(JSON.stringify(modelFor("中文：甲\n情境：（没有补充）")), { status: 200 });
    assert.equal((await handleExpress(post({ q: "第一句说法" }), capped, {}, { fetchImpl: okFetch })).status, 200);
    const limited = await handleExpress(post({ q: "第二句说法" }), capped, {}, { fetchImpl: okFetch });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, "rate");
  });

  test("times out instead of inventing a card", async () => {
    const fetchImpl: typeof fetch = (_url, init) => {
      assert.ok(init?.signal);
      return new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error("timeout");
          err.name = "TimeoutError";
          reject(err);
        };
        // AbortSignal.timeout() does not keep Node's event loop alive; arm our own timer too.
        init?.signal?.addEventListener("abort", fail);
        setTimeout(fail, 15);
      });
    };
    const res = await handleExpress(post({ q: "放下" }), env(), {}, { fetchImpl, timeoutMs: 30 });
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error, "timeout");
  });
});
