import assert from "node:assert/strict";
import test from "node:test";
import { handleAccount, type AccountBucket } from "./account";

function bucket(): AccountBucket & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      const value = store.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

const headers = { "Access-Control-Allow-Origin": "https://yuanzhevc-stack.github.io" };

async function auth(b: AccountBucket, path: string, email = "a@example.com") {
  return handleAccount(new Request("https://worker.test" + path, { method: "POST", body: JSON.stringify({ email, password: "correct-horse" }) }), b, headers, 1_000);
}

test("register, login, and a library stay on that account", async () => {
  const b = bucket();
  const created = await auth(b, "/auth/register");
  assert.equal(created.status, 200);
  const again = await auth(b, "/auth/register");
  assert.equal(again.status, 409);
  const bad = await handleAccount(new Request("https://worker.test/auth/login", { method: "POST", body: JSON.stringify({ email: "a@example.com", password: "wrong-password" }) }), b, headers, 2_000);
  assert.equal(bad.status, 401);
  const logged = await auth(b, "/auth/login");
  const { token } = (await logged.json()) as { token: string };
  const put = await handleAccount(
    new Request("https://worker.test/library", { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ baseRev: 0, lessons: [{ id: "l1", text: "Hello" }], items: {}, notes: { "l1:0": "note" }, progress: null }) }),
    b,
    headers,
    3_000,
  );
  assert.equal(put.status, 200);
  const saved = (await put.json()) as { rev: number };
  assert.equal(saved.rev, 1);
  const stale = await handleAccount(
    new Request("https://worker.test/library", { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ baseRev: 0, lessons: [], items: {}, notes: {}, progress: null }) }),
    b,
    headers,
    4_000,
  );
  assert.equal(stale.status, 409);
  const got = await handleAccount(new Request("https://worker.test/library", { headers: { Authorization: `Bearer ${token}` } }), b, headers, 5_000);
  const lib = (await got.json()) as { lessons: { text: string }[]; notes: Record<string, string> };
  assert.equal(lib.lessons[0].text, "Hello");
  assert.equal(lib.notes["l1:0"], "note");
  const stranger = await handleAccount(new Request("https://worker.test/library"), b, headers, 6_000);
  assert.equal(stranger.status, 401);
});
