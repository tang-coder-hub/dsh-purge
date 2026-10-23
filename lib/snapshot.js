/**
 * 插件自更新快照 / 回滚。
 *
 * 为什么要有这个：`update.js` 的 `overlayFromZip()` 是「先 rm -rf lib/docs/bin，再 cp」。
 * 中途失败（文件被占用、断电、下载的包不完整）就会留下一个半新半旧的 lib —— 插件直接起不来，
 * 而且没有任何自动恢复路径。这里在覆盖之前把整份发布内容复制一份，失败时原样搬回去。
 *
 * 快照放在 `$DSH_HOME/dsh-purge/snapshots/<stamp>/`，不放在插件目录里：
 * 一是不能被 overlay 一起删掉，二是不要把快照递归进自己的复制源。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findDshHome } from "./core.js";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 默认保留几份快照。留 3 份够回退两级，也不会让 ~/.dsh 无限长大。 */
export const DEFAULT_KEEP = 3;

/** package.json 的 files 读不出来时的兜底清单（与 1.3.x 的发布内容一致）。 */
const FALLBACK_NAMES = [
  "lib",
  "bin",
  "docs",
  "presets",
  "skills",
  "scripts",
  "client.js",
  "cordis.patch.yml",
  "screenshots.json",
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
];

export function pluginRoot() {
  return PLUGIN_ROOT;
}

export function snapshotsRoot(dshHome = findDshHome()) {
  return path.join(dshHome, "dsh-purge", "snapshots");
}

/**
 * 要进快照的名字。以 package.json 的 `files` 为准（那就是真正发布出去的内容），
 * 过滤掉 `!xxx` 这类 negation 条目，再补上 package.json 本身 —— npm 会自动带它，
 * 但回滚必须能还原版本号，不能漏。
 */
export function payloadNames(root = PLUGIN_ROOT) {
  let names = FALLBACK_NAMES;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (Array.isArray(pkg.files) && pkg.files.length) {
      const listed = pkg.files.filter((n) => typeof n === "string" && n.trim() && !n.startsWith("!"));
      if (listed.length) names = listed;
    }
  } catch {
    // package.json 读不到就用兜底清单：这时候更要能回滚。
  }
  const out = [...names];
  if (!out.includes("package.json")) out.push("package.json");
  return out;
}

function stampNow() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-` +
    `${p(d.getMilliseconds(), 3)}`
  );
}

function dirSize(fp) {
  let total = 0;
  let files = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let items = [];
      try {
        items = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const name of items) walk(path.join(p, name));
      return;
    }
    if (st.isFile()) {
      total += st.size;
      files += 1;
    }
  };
  walk(fp);
  return { bytes: total, files };
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 建一份快照。
 * @returns {{ok:boolean, stamp?:string, dir?:string, names?:string[], bytes?:number, files?:number, error?:string}}
 */
export function createSnapshot({ reason = "", root = PLUGIN_ROOT, dshHome = findDshHome() } = {}) {
  const stamp = stampNow();
  const names = payloadNames(root);
  const base = snapshotsRoot(dshHome);
  let dir;
  try {
    fs.mkdirSync(base, { recursive: true });
    dir = path.join(base, stamp);
    // 同一毫秒撞名（测试里循环调用会遇到）时补一个后缀，绝不覆盖已有快照。
    let n = 1;
    while (fs.existsSync(dir)) {
      dir = path.join(base, `${stamp}-${n}`);
      n += 1;
    }
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `建快照目录失败：${e.message || e}` };
  }

  const saved = [];
  const skipped = [];
  for (const name of names) {
    const from = path.join(root, name);
    let st;
    try {
      st = fs.lstatSync(from);
    } catch {
      // 这个版本没带这个目录（比如没有 skills/），记下来但不报错。
      skipped.push(name);
      continue;
    }
    try {
      fs.cpSync(from, path.join(dir, name), { recursive: st.isDirectory(), force: true, preserveTimestamps: true });
      saved.push(name);
    } catch (e) {
      // 复制失败就把半份快照清掉：残缺快照比没有快照更危险，回滚时会把 lib 还原成缺文件的版本。
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      return { ok: false, error: `快照复制 ${name} 失败：${e.message || e}` };
    }
  }

  const size = dirSize(dir);
  const manifest = {
    stamp: path.basename(dir),
    at: new Date().toISOString(),
    reason,
    version: readVersion(root),
    names: saved,
    skipped,
    bytes: size.bytes,
    files: size.files,
    root,
  };
  try {
    fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (e) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: `写快照清单失败：${e.message || e}` };
  }

  return {
    ok: true,
    stamp: manifest.stamp,
    dir,
    root,
    names: saved,
    skipped,
    bytes: size.bytes,
    files: size.files,
  };
}

function readVersion(root = PLUGIN_ROOT) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
}

/** 由新到旧列出快照。读不出清单的目录（半份的残留）跳过。 */
export function listSnapshots(dshHome = findDshHome()) {
  const base = snapshotsRoot(dshHome);
  let items = [];
  try {
    items = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const dir = path.join(base, it.name);
    const m = readManifest(dir);
    if (!m) continue;
    rows.push({ ...m, dir });
  }
  // stamp 是 YYYYMMDD-HHmmss-SSS，字典序即时间序；不用 Date 解析，避免时区/格式坑。
  rows.sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)));
  return rows;
}

export function latestSnapshot(dshHome = findDshHome()) {
  return listSnapshots(dshHome)[0] || null;
}

/** 只留最新 keep 份，其余删掉。返回删掉的 stamp 列表。 */
export function pruneSnapshots(keep = DEFAULT_KEEP, dshHome = findDshHome()) {
  const rows = listSnapshots(dshHome);
  const drop = rows.slice(Math.max(0, keep));
  const removed = [];
  for (const row of drop) {
    try {
      fs.rmSync(row.dir, { recursive: true, force: true });
      removed.push(row.stamp);
    } catch {
      // 删不掉就留着，下次再删 —— 不因为清理失败影响主流程。
    }
  }
  return removed;
}

/**
 * 把某份快照搬回插件目录。
 * 还原策略是「先删后拷」，与 overlay 对称：这样 overlay 新增的文件不会残留成孤儿。
 */
export function restoreSnapshot(stamp, { root = PLUGIN_ROOT, dshHome = findDshHome() } = {}) {
  const rows = listSnapshots(dshHome);
  const row = stamp ? rows.find((r) => r.stamp === stamp) : rows[0];
  if (!row) {
    return { ok: false, error: stamp ? `找不到快照 ${stamp}` : "还没有任何快照" };
  }
  const restored = [];
  const errors = [];
  for (const name of row.names || []) {
    const from = path.join(row.dir, name);
    const to = path.join(root, name);
    try {
      let st;
      try {
        st = fs.lstatSync(to);
      } catch {
        st = null;
      }
      if (st) fs.rmSync(to, { recursive: st.isDirectory(), force: true });
      fs.cpSync(from, to, { recursive: true, force: true, preserveTimestamps: true });
      restored.push(name);
    } catch (e) {
      errors.push([name, String(e && e.message ? e.message : e)]);
    }
  }
  return { ok: errors.length === 0, stamp: row.stamp, restored, errors, version: row.version };
}

/**
 * 包一层：先快照，再跑 fn；fn 抛错就自动还原成快照并重新抛出（错误里带快照号）。
 * @returns {Promise<{value:any, snapshot:object}>}
 */
export async function withSnapshot(reason, fn, options = {}) {
  const snap = createSnapshot({ reason, ...options });
  if (!snap.ok) {
    // 快照都建不出来就别动文件了 —— 宁可这次不升级，也不要留下无法回滚的状态。
    const err = new Error(`无法创建更新快照，已取消本次操作：${snap.error}`);
    err.code = "SNAPSHOT_FAILED";
    throw err;
  }
  try {
    const value = await fn(snap);
    pruneSnapshots(options.keep ?? DEFAULT_KEEP, options.dshHome ?? findDshHome());
    return { value, snapshot: snap };
  } catch (e) {
    const rolled = restoreSnapshot(snap.stamp, options);
    if (rolled.ok) {
      const wrapped = new Error(`${e && e.message ? e.message : e}\n（已自动回滚到快照 ${snap.stamp}）`);
      wrapped.code = "ROLLED_BACK";
      wrapped.snapshot = snap.stamp;
      wrapped.cause = e;
      throw wrapped;
    }
    const wrapped = new Error(
      `${e && e.message ? e.message : e}\n（自动回滚也失败了：${rolled.errors.map((x) => x.join(": ")).join("; ")}。` +
        `请手动把 ${snap.dir} 拷回插件目录）`,
    );
    wrapped.code = "ROLLBACK_FAILED";
    wrapped.snapshot = snap.stamp;
    wrapped.cause = e;
    throw wrapped;
  }
}
