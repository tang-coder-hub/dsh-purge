// 场景一：patch 幂等。
//
// 「同一条补丁反复 apply，宿主文件不能越变越长」——这是插件最要命的回归类型：
// 替换链里常有「新版是旧版前缀」的自匹配 pattern，一旦 skipIfMarked 失效，
// 每点一次应用就多叠一层（core.js:2707 注释里记的实测 +841 字符/次）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, it } from "node:test";

import {
  IDEMPOTENT_PATCH,
  cleanupTmpRoot,
  hostFile,
  makeHost,
  makeTmpRoot,
  readText,
} from "./helpers.mjs";

import {
  applyPatches,
  applyReplacementsToText,
  patchApplied,
} from "../lib/core.js";

const ORIGINAL = readText; // 占位，避免误用未定义变量

describe("patch 幂等 · 纯函数层", () => {
  it("同一补丁连跑两次：第二次 changed=false，文本逐字节不变", () => {
    const source = [
      "export const WORKSPACE_CONTEXT_INTRO =",
      "  'The following workspace instructions may be relevant to your work.';",
      "",
    ].join("\n");

    const first = applyReplacementsToText(source, IDEMPOTENT_PATCH, "index.js");
    assert.equal(first.changed, true, "第一次必须改内容");
    assert.ok(first.text.includes("[cfg] TEST_IDEMPOTENT"), "第一次必须写进标记");

    const second = applyReplacementsToText(first.text, IDEMPOTENT_PATCH, "index.js");
    assert.equal(second.changed, false, "第二次不能再改内容");
    assert.equal(second.text, first.text, "第二次文本必须逐字节相同");

    const third = applyReplacementsToText(second.text, IDEMPOTENT_PATCH, "index.js");
    assert.equal(third.changed, false, "第三次也不能改");
    assert.equal(third.text, first.text);
  });

  it("pattern 是 replace 的前缀时也不能反复叠加（自匹配型替换）", () => {
    const source = "const X = 'The following workspace instructions may be relevant to your work.';\n";
    const patch = {
      id: 9101,
      name: "TEST_SELF_MATCH",
      file: "agent-instructions",
      skipIfMarked: true,
      markers: ["[cfg] TEST_SELF_MATCH"],
      replacements: [
        {
          pattern: "The following workspace instructions may be relevant to your work.",
          // 产物里仍然含 pattern（自匹配）——没有 skipIfMarked 就会无限叠。
          replace:
            "The following workspace instructions may be relevant to your work. [cfg] TEST_SELF_MATCH",
        },
      ],
    };

    const first = applyReplacementsToText(source, patch, "index.js");
    assert.equal(first.changed, true);
    const second = applyReplacementsToText(first.text, patch, "index.js");
    assert.equal(second.changed, false, "自匹配 pattern 必须被 skipIfMarked 挡住");
    assert.equal(second.text, first.text);
  });

  it("旧标记 [dsh-purge] 只迁移一次，第二次不再改", () => {
    const source = "// [dsh-purge] legacy marker\nconst A = 1;\n";
    const patch = {
      id: 9102,
      name: "TEST_MARK_MIGRATION",
      file: "agent-instructions",
      replacements: [{ pattern: "const A = 1;", replace: "const A = 2;" }],
    };

    const first = applyReplacementsToText(source, patch, "index.js");
    assert.equal(first.changed, true, "迁移本身算一次改动");
    assert.ok(first.text.includes("[cfg] legacy marker"), "旧标记应被换成中性标记");
    assert.ok(!first.text.includes("[dsh-purge]"));

    const second = applyReplacementsToText(first.text, patch, "index.js");
    assert.equal(second.changed, false, "迁移过一次就该收敛");
    assert.equal(second.text, first.text);
  });

  it("patchApplied 在打完之后为真，能当幂等判据", () => {
    const source = "The following workspace instructions may be relevant to your work.\n";
    const applied = applyReplacementsToText(source, IDEMPOTENT_PATCH, "index.js");
    assert.equal(patchApplied(applied.text, IDEMPOTENT_PATCH), true);
    assert.equal(patchApplied(source, IDEMPOTENT_PATCH), false);
  });
});

describe("patch 幂等 · 落盘层", () => {
  let root = "";
  let base = "";

  before(() => {
    root = makeTmpRoot("dsh-purge-idem");
    base = makeHost(root, "host-a");
  });

  after(() => cleanupTmpRoot(root));

  it("第二次 apply 报 already，文件字节不变", async () => {
    const fp = hostFile(base);
    const beforeFirst = fs.readFileSync(fp);

    const first = await applyPatches(base, [IDEMPOTENT_PATCH]);
    assert.equal(first.length, 1);
    assert.equal(first[0].status, "applied", `第一次应报 applied，实际 ${first[0].status}`);
    assert.equal(first[0].applied, 1);

    const afterFirst = fs.readFileSync(fp);
    assert.ok(afterFirst.length > beforeFirst.length, "第一次应该写进内容");
    assert.ok(afterFirst.toString("utf8").includes("[cfg] TEST_IDEMPOTENT"));

    const second = await applyPatches(base, [IDEMPOTENT_PATCH]);
    assert.equal(second[0].status, "already", `第二次应报 already，实际 ${second[0].status}`);
    assert.equal(second[0].applied, 0);
    assert.equal(second[0].already, 1);

    const afterSecond = fs.readFileSync(fp);
    assert.ok(afterSecond.equals(afterFirst), "第二次 apply 不能改文件字节");

    const third = await applyPatches(base, [IDEMPOTENT_PATCH]);
    assert.equal(third[0].status, "already");
    assert.ok(fs.readFileSync(fp).equals(afterFirst), "第三次同样不能改字节");
  });

  it("连打十次，文件长度不增长", async () => {
    const fp = hostFile(base);
    const start = fs.readFileSync(fp);
    for (let i = 0; i < 10; i += 1) {
      await applyPatches(base, [IDEMPOTENT_PATCH]);
    }
    const end = fs.readFileSync(fp);
    assert.equal(end.length, start.length, "重复 apply 不得让文件变长");
    assert.ok(end.equals(start));
  });
});
