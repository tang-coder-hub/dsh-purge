#!/usr/bin/env node
// 走 api.github.com 的 git data API 发版。
//
// 为什么需要它：本机 github.com 的 git 协议（clone/fetch/push）全部连接超时，
// 只有 api.github.com 通。所以本地提交完之后，用这个脚本把内容"搬"到远端。
//
// 它不靠手写文件清单，而是比对两边的内容哈希：
//   本地 HEAD 的 tree  ↔  远端分支的 tree（recursive）
// 差集就是要上传/删除的文件。组装出的 tree 必须与本地 tree 哈希完全一致才继续，
// 所以传错、漏传都会在提交前就炸掉。
//
// 用法：
//   node scripts/release-via-api.mjs --dry-run     # 只打印会做什么
//   node scripts/release-via-api.mjs               # 推提交 + 打 tag + 建 Release + 传 zip
//   node scripts/release-via-api.mjs --no-release  # 只推提交和 tag，不建 Release
//   node scripts/release-via-api.mjs --branch beta # 推别的分支
//
// 前置：
//   1. 版本号已经写进 package.json
//   2. release-notes.md 顶部有 `# <版本号>` 那一节（Release 正文从这取）
//   3. 改动已经 commit 到当前 HEAD（脚本推的是 HEAD，不是工作区）
//   4. `git credential fill` 里有能写这个仓库的 token（gho_ 那种）

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

const DRY = has("--dry-run");
const NO_RELEASE = has("--no-release");
const BRANCH = opt("--branch", "main");
const VERSION = PKG.version;
const TAG = opt("--tag", `v${VERSION}`);

// 仓库地址：默认从 package.json 的 repository 推断，省得两处维护
function repoFromPkg() {
  const url = PKG.repository?.url || "";
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error("package.json 的 repository.url 解析不出 owner/repo，用 --repo 指定");
  return `${m[1]}/${m[2]}`;
}
const REPO = opt("--repo", repoFromPkg());

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

// ---------- git 与 token ----------
const git = (args, input) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });

function readToken() {
  let out;
  try {
    out = git(["credential", "fill"], "protocol=https\nhost=github.com\n\n");
  } catch {
    fail("拿不到 GitHub token：`git credential fill` 失败，先配置凭据或换 --token-env");
  }
  const m = out.match(/^password=(.+)$/m);
  if (!m) fail("凭据里没有 password 字段");
  return m[1].trim();
}

const TOKEN = DRY ? "" : readToken();

async function api(p, init = {}) {
  const res = await fetch(`https://api.github.com${p}`, {
    ...init,
    headers: {
      // --dry-run 没有 token，省略这个头走匿名读（公开仓库可读）
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dsh-purge-release",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404 && init.allow404) return null;
    fail(`${init.method || "GET"} ${p} → ${res.status}\n${text.slice(0, 600)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------- 1. 本地 HEAD 的完整文件表 ----------
function localFiles() {
  const out = git(["ls-tree", "-r", "HEAD"]);
  const map = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/);
    if (!m) continue;
    const [, mode, type, sha, p] = m;
    if (type !== "blob") fail(`不支持 tree 条目类型 ${type}：${p}`);
    map.set(p, { mode, sha });
  }
  return map;
}

const LOCAL_TREE = git(["show", "-s", "--format=%T", "HEAD"]).trim();
const LOCAL = localFiles();

// ---------- 2. 远端分支现状 ----------
const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`, { allow404: true });
if (!ref) fail(`远端没有分支 ${BRANCH}：${REPO}`);

const remoteHead = ref.object.sha;
const remoteCommit = await api(`/repos/${REPO}/git/commits/${remoteHead}`);

log(`仓库   ${REPO}`);
log(`版本   ${VERSION}（tag ${TAG}）`);
log(`分支   ${BRANCH}`);
log(`本地   HEAD tree = ${LOCAL_TREE}`);
log(`远端   ${remoteHead.slice(0, 8)} tree = ${remoteCommit.tree.sha}`);

// tree 哈希相同就是内容逐字节相同，不必再拉全量列表。
// 这一步同时挡住了 GitHub 的短暂延迟：刚建好的 tree 有时还会返回旧内容，
// 按条目比对会误报「要重传」，按 tree 哈希比对不会。
if (remoteCommit.tree.sha === LOCAL_TREE) {
  log(`\n✔ 内容已经一致（tree ${LOCAL_TREE}），没有需要推送的改动。`);
  process.exit(0);
}

const remoteTree = await api(`/repos/${REPO}/git/trees/${remoteCommit.tree.sha}?recursive=1`);
if (remoteTree.truncated) fail("远端 tree 太大被截断，无法安全比对");

const REMOTE = new Map(
  remoteTree.tree.filter((e) => e.type === "blob").map((e) => [e.path, { mode: e.mode, sha: e.sha }]),
);

// ---------- 3. 算差集 ----------
const toWrite = [];
const toDelete = [];
for (const [p, v] of LOCAL) {
  const r = REMOTE.get(p);
  if (!r || r.sha !== v.sha) toWrite.push(p);
}
for (const p of REMOTE.keys()) {
  if (!LOCAL.has(p)) toDelete.push(p);
}

if (toWrite.length === 0 && toDelete.length === 0) {
  log(`\n✔ 内容已经一致（tree ${LOCAL_TREE}），没有需要推送的改动。`);
  process.exit(0);
}

log(`\n需要上传 ${toWrite.length} 个，删除 ${toDelete.length} 个：`);
for (const p of toWrite) log(`  + ${p}`);
for (const p of toDelete) log(`  - ${p}`);

if (DRY) {
  log("\n--dry-run：到此为止，什么都没写。");
  process.exit(0);
}

// ---------- 4. 上传 blob ----------
const entries = [];
for (const p of toWrite) {
  const abs = path.join(ROOT, p.split("/").join(path.sep));
  const blob = await api(`/repos/${REPO}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: fs.readFileSync(abs).toString("base64"), encoding: "base64" }),
  });
  const localSha = LOCAL.get(p).sha;
  if (blob.sha !== localSha) fail(`${p}: 远端 blob ${blob.sha} ≠ 本地 ${localSha}（换行符被改写？）`);
  entries.push({ path: p, mode: LOCAL.get(p).mode, type: "blob", sha: blob.sha });
}
for (const p of toDelete) entries.push({ path: p, mode: "100644", type: "blob", sha: null });
log(`\n✔ ${toWrite.length} 个 blob 已上传，哈希逐个对得上`);

// ---------- 5. 组 tree 并校验 ----------
const tree = await api(`/repos/${REPO}/git/trees`, {
  method: "POST",
  body: JSON.stringify({ base_tree: remoteCommit.tree.sha, tree: entries }),
});
if (tree.sha !== LOCAL_TREE) {
  fail(`组装出的 tree ${tree.sha} ≠ 本地 ${LOCAL_TREE}：远端还有本地没有的东西，先同步回来`);
}
log(`✔ tree 校验通过：${tree.sha}`);

// ---------- 6. 提交 ----------
const msgFile = opt("--message-file", "");
const msg = msgFile
  ? fs.readFileSync(path.resolve(ROOT, msgFile), "utf8").replace(/\r\n/g, "\n").trimEnd()
  : git(["log", "-1", "--format=%B"]).replace(/\r\n/g, "\n").trimEnd();

const commit = await api(`/repos/${REPO}/git/commits`, {
  method: "POST",
  body: JSON.stringify({ message: msg, tree: tree.sha, parents: [remoteHead] }),
});
log(`✔ commit ${commit.sha}`);

await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
  method: "PATCH",
  body: JSON.stringify({ sha: commit.sha, force: false }),
});
log(`✔ ${BRANCH} 已指向 ${commit.sha.slice(0, 8)}`);

// ---------- 7. tag ----------
const existingTag = await api(`/repos/${REPO}/git/ref/tags/${TAG}`, { allow404: true });
if (existingTag) {
  log(`· tag ${TAG} 已存在，跳过`);
} else {
  const tagObj = await api(`/repos/${REPO}/git/tags`, {
    method: "POST",
    body: JSON.stringify({ tag: TAG, message: TAG, object: commit.sha, type: "commit" }),
  });
  await api(`/repos/${REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/tags/${TAG}`, sha: tagObj.sha }),
  });
  log(`✔ tag ${TAG} 已创建`);
}

// ---------- 8. Release 与附件 ----------
if (NO_RELEASE) {
  log("\n--no-release：不建 Release。");
} else {
  const notesPath = path.join(ROOT, "release-notes.md");
  let body = `版本 ${VERSION}`;
  if (fs.existsSync(notesPath)) {
    const notes = fs.readFileSync(notesPath, "utf8").replace(/\r\n/g, "\n");
    const start = notes.search(new RegExp(`^# ${VERSION.replace(/\./g, "\\.")}\\s*$`, "m"));
    if (start === -1) {
      log(`· release-notes.md 里没有 "# ${VERSION}" 小节，Release 正文用默认一句话`);
    } else {
      const nextIdx = notes.slice(start + 1).search(/^# /m);
      body = notes.slice(start, nextIdx === -1 ? undefined : start + 1 + nextIdx).trim();
    }
  }

  const release = await api(`/repos/${REPO}/releases`, {
    method: "POST",
    body: JSON.stringify({
      tag_name: TAG,
      name: TAG,
      body,
      draft: false,
      prerelease: /-(beta|rc|alpha)/i.test(VERSION),
    }),
  });
  log(`✔ Release ${release.html_url}`);

  // 附件：现场用 git archive 打包，保证和 tag 内容一致
  const zipPath = path.join(os.tmpdir(), `dsh-purge-${VERSION}.zip`);
  execFileSync("git", ["archive", "--format=zip", `-o`, zipPath, "HEAD"], { cwd: ROOT });
  const size = fs.statSync(zipPath).size;
  const res = await fetch(`${release.upload_url.replace(/\{.*$/, "")}?name=${path.basename(zipPath)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/zip",
      "User-Agent": "dsh-purge-release",
    },
    body: fs.readFileSync(zipPath),
  });
  const asset = await res.json();
  if (!res.ok) fail(`附件上传失败 ${res.status}：${JSON.stringify(asset).slice(0, 300)}`);
  fs.unlinkSync(zipPath);
  log(`✔ 附件 ${asset.name}（${size} 字节，state=${asset.state}）`);
}

log(`\n完成。本地 HEAD 与远端 ${BRANCH} 内容一致，tree = ${LOCAL_TREE}`);
log(`提醒：本地 commit sha 与远端不同是正常的 —— 远端 commit 由 API 重建，tree 相同即内容逐字节一致。`);
