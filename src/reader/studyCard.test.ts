import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";

test("a lookup card under #root is covered, and the same card on body is visible", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<!doctype html>
      <style>
        #root { position: relative; z-index: 1; }
        .page { animation: page-in 2s linear both; }
        @keyframes page-in { from { opacity: 0; transform: translateY(8px); } }
        .rd-aside { position: fixed; z-index: 80; top: 40px; right: 16px; width: 220px; height: 140px; background: #fff; }
        .desk { position: fixed; inset: 0; z-index: 40; background: #eee; }
        .rd-aside.rd-study-card { z-index: 80; background: #fff; }
      </style>
      <div id="root"><div class="page"><aside class="rd-aside" data-testid="card">how you get</aside></div></div>
      <div class="desk"></div>`);
    const covered = await page.evaluate(() => {
      const card = document.querySelector("[data-testid=card]")!;
      const box = card.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + 12, box.y + 12);
      return !(hit === card || card.contains(hit));
    });
    assert.equal(covered, true);
    await page.evaluate(() => {
      const card = document.querySelector("[data-testid=card]")!;
      card.classList.add("rd-study-card");
      document.body.appendChild(card);
    });
    const visible = await page.evaluate(() => {
      const card = document.querySelector("[data-testid=card]")!;
      const box = card.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + 12, box.y + 12);
      const style = getComputedStyle(card);
      return (hit === card || card.contains(hit)) && style.zIndex === "80" && style.backgroundColor === "rgb(255, 255, 255)";
    });
    assert.equal(visible, true);
  } finally {
    await browser.close();
  }
});
