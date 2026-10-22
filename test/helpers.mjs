/**
 * 测试夹具：所有宿主、dsh-home 都落在临时目录里。
 *
 * 沙箱靠 process.env.DSH_HOME —— core.js 的 findDshHome() 第一优先级读它
 * (core.js:1757)，所以凡是碰 dsh-home 的副作用（dropStaleUserProfilePatchBackups、
 * preset 路径、hook-deny 设置）都会落在临时目录，不会动真机。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须早于 lib/core.js 的模块求值：core.js 顶层就会算 findDshHome()。
// 每个测试文件第一行 import "./helpers.mjs"，这里就把 DSH_HOME 指到临时目录，
// 真机 ~/.dsh 不会被测试碰到。
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-home-"));
process.env.DSH_HOME = SANDBOX_HOME;

export function sandboxHome() {
  return SANDBOX_HOME;
}

/** 宿主根里必须有 dsh-agent-instructions/lib，否则 core.js 的 isAiBase 判否。 */
export const AGENT_INSTRUCTIONS_ORIGINAL = [
  "export const WORKSPACE_CONTEXT_INTRO =",
  "  'The following workspace instructions may be relevant to your work.';",
  "",
].join("\n");

/** 含 "system-prompt/assemble" 且不含被拦的两句 → hostCleanMarkersPresent 为真。 */
export const SYSTEM_PROMPT_CLEAN = [
  "// system-prompt/assemble",
  "export function assemble() { return []; }",
  "",
].join("\n");

/** 不含 "system-prompt/assemble" → hostCleanMarkersPresent 为假（宿主没洗干净）。 */
export const SYSTEM_PROMPT_DIRTY = [
  "export function assemble() { return []; }",
  "",
].join("\n");

/** 幂等测试用的合成补丁，结构与真补丁同形。 */
export const IDEMPOTENT_PATCH = {
  id: 9001,
  name: "TEST_IDEMPOTENT",
  file: "agent-instructions",
  rel: ["lib", "index.js"],
  skipIfMarked: true,
  markers: ["[cfg] TEST_IDEMPOTENT"],
  replacements: [
    {
      pattern: "The following workspace instructions may be relevant to your work.",
      replace:
        "The following workspace instructions may be relevant to your work.\n// [cfg] TEST_IDEMPOTENT",
    },
  ],
};

/** strictFiles 版：pattern 没命中就算 pattern_not_found（真补丁里也是这样标脏的）。 */
export const STRICT_IDEMPOTENT_PATCH = {
  ...IDEMPOTENT_PATCH,
  id: 9002,
  name: "TEST_IDEMPOTENT_STRICT",
  strictFiles: true,
};

export function writeFile(fp, content) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

export function makeTmpRoot(tag = "dsh-purge-test") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}

export function cleanupTmpRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔被占用，下一轮再说 */
  }
}

/**
 * 造一个宿主根。
 * @param {object} opts
 * @param {string} [opts.agentInstructions] agent-instructions/lib/index.js 的内容
 * @param {string} [opts.systemPrompt] dsh-system-prompt/lib/index.js 的内容
 * @param {boolean} [opts.withSystemPrompt] 是否创建 system-prompt 文件
 */
export function makeHost(root, name, opts = {}) {
  const base = path.join(root, name);
  writeFile(
    path.join(base, "dsh-agent-instructions", "lib", "index.js"),
    opts.agentInstructions ?? AGENT_INSTRUCTIONS_ORIGINAL,
  );
  if (opts.withSystemPrompt !== false) {
    writeFile(
      path.join(base, "dsh-system-prompt", "lib", "index.js"),
      opts.systemPrompt ?? SYSTEM_PROMPT_CLEAN,
    );
  }
  return base;
}

export function hostFile(base) {
  return path.join(base, "dsh-agent-instructions", "lib", "index.js");
}

export function hostSystemPromptFile(base) {
  return path.join(base, "dsh-system-prompt", "lib", "index.js");
}

export function readText(fp) {
  return fs.readFileSync(fp, "utf8");
}
