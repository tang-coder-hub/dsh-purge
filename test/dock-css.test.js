// 守住「面板顶部标签间距」这类回归：它坏在样式表的生命周期上，肉眼在清洗页看不出来，
// 一切到演练台才暴露。这里直接盯生成产物 client.js 的三条不变量。
import "./helpers.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLIENT = path.join(ROOT, "client.js");

function clientText() {
  return fs.readFileSync(CLIENT, "utf8");
}

test("dock 自己渲染一份 PURGE_CSS，不依赖清洗页那个会卸载的组件", () => {
  const t = clientText();
  assert.ok(
    t.includes('h("style", { "data-dsh-purge-dock-css": "1" }, PURGE_CSS)'),
    "PurgeDock 的渲染树里必须有一份 PURGE_CSS：清洗页的 SettingsRoot 切到演练台时会被卸载，" +
      "只靠它带的内联 <style> 会让演练台页退回 head 里那份旧样式表",
  );
});

test("head 里的样式表每次同步内容，不会一直用旧的", () => {
  const t = clientText();
  assert.ok(t.includes('style[data-dsh-purge-ui="2"]'), "标记应已升到 2");
  assert.ok(
    t.includes("if (uiTag.textContent !== PURGE_CSS) uiTag.textContent = PURGE_CSS;"),
    "必须每次比对并重写；只在标签不存在时写，会让热更新之后一直用旧 CSS",
  );
  assert.ok(
    t.includes("document.querySelectorAll('style[data-dsh-purge-ui=\"1\"]')"),
    "要能清掉遗留的 1 号标记，否则旧样式表和新的同时生效",
  );
});

test("两个顶层标签的间距值与实现对得上", () => {
  const t = clientText();
  assert.ok(t.includes(".dshp-dock-tabs{display:flex;gap:8px;"), "容器 gap 应为 8px");
  assert.ok(
    t.includes(".dshp-dock-tab{border-radius:0;border-bottom:2px solid transparent;font-family:var(--dshp-sans);font-size:13px;font-weight:550;padding:0 14px 8px;min-height:28px}"),
    "tab 左右内边距应为 14px",
  );
  assert.ok(
    t.includes(".dshp-dock .dshp-dock-tab{font-size:12.5px;padding:0 14px 8px}"),
    "宿主作用域那条覆盖规则也要带同样的内边距，否则会把基础规则压回去",
  );
  assert.ok(t.includes(".dshp-dock-tab:first-child{padding-left:0}"), "首个标签左缘对齐内容");
});
