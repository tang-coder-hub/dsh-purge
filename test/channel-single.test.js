/**
 * 回归：只保留「正式版」一个通道，beta 通道彻底下线。
 *
 * 背景：以前面板上有「正式版 / 测试版」两条道，测试版指向 beta 分支。
 * beta 分支不再维护之后，那条道只会让人误点、把插件换成陈旧的包
 * （真实事故：点了一下「切换版本」，插件被整目录覆盖回旧版，本地改动全丢）。
 * 所以通道表、远端探测、状态归一化三处一起删干净，这里是防复发的栏杆。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { sandboxHome } from "./helpers.mjs";
import {
  normalizeChannel,
  safeUpdateRef,
  hideListedVersion,
  readChannelState,
  channelPublic,
} from "../lib/update.js";

const CHANNEL_FILE = path.join(sandboxHome(), "dsh-purge", "channel.json");

function writeChannelJson(obj) {
  fs.mkdirSync(path.dirname(CHANNEL_FILE), { recursive: true });
  fs.writeFileSync(CHANNEL_FILE, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

test("normalizeChannel 一律折回正式版，beta 不再是合法通道", () => {
  assert.equal(normalizeChannel("beta"), "stable");
  assert.equal(normalizeChannel("BETA"), "stable");
  assert.equal(normalizeChannel("  beta  "), "stable");
  assert.equal(normalizeChannel("stable"), "stable");
  assert.equal(normalizeChannel(""), "stable");
  assert.equal(normalizeChannel(undefined), "stable");
  assert.equal(normalizeChannel(null), "stable");
});

test("beta 不再是合法的更新目标", () => {
  assert.equal(safeUpdateRef("beta"), "", "beta 分支已下线，不能当更新目标");
  assert.equal(safeUpdateRef("main"), "main");
  assert.equal(safeUpdateRef("v1.3.4"), "v1.3.4");
  assert.equal(safeUpdateRef("fccc1e3537fc24ad136751ac4ba08ff7d5e0bdd9").length, 40);
});

test("列表里不会出现 beta 通道的条目，预发布标签照样藏着", () => {
  // beta 通道条目（不管它自报什么 ref）一律不展示
  assert.equal(hideListedVersion({ channel: "beta", version: "1.2.0", ref: "beta", id: "beta" }), true);
  assert.equal(hideListedVersion({ channel: "beta", version: "9.9.9", ref: "v9.9.9", id: "v9.9.9" }), true);
  // 正式版条目正常展示
  assert.equal(hideListedVersion({ channel: "stable", version: "1.3.4", ref: "v1.3.4", id: "v1.3.4" }), false);
  assert.equal(hideListedVersion({ channel: "stable", version: "1.3.4", ref: "main", id: "main" }), false);
  // 旧的 beta / rc / pre 预发布标签仍然过滤掉
  assert.equal(hideListedVersion({ channel: "stable", version: "1.1.11-beta", ref: "v1.1.11-beta", id: "v1.1.11-beta" }), true);
  assert.equal(hideListedVersion({ channel: "stable", version: "2.0.0-rc1", ref: "v2.0.0-rc1", id: "v2.0.0-rc1" }), true);
  assert.equal(hideListedVersion(null), true);
});

test("旧状态文件写着 beta，读一次就自动改回正式版", () => {
  writeChannelJson({ channel: "beta", pin: "" });

  const state = readChannelState();
  assert.equal(state.channel, "stable", "beta 通道已下线，读到就得折回正式版");

  // 顺手把文件也改正过来，别让每次启动都再折一次
  const onDisk = JSON.parse(fs.readFileSync(CHANNEL_FILE, "utf8"));
  assert.equal(onDisk.channel, "stable");
});

test("pin 指向预发布标签时一并清掉", () => {
  writeChannelJson({ channel: "stable", pin: "beta" });

  const state = readChannelState();
  assert.equal(state.pin, "", "pin 指到 beta 分支的旧状态要清空");
  const onDisk = JSON.parse(fs.readFileSync(CHANNEL_FILE, "utf8"));
  assert.equal(onDisk.pin, "");
});

test("channelPublic 永远只报正式版，不再有「测试版」这种标签", () => {
  const normal = channelPublic({ channel: "stable", pin: "" });
  assert.equal(normal.channel, "stable");
  assert.equal(normal.channelLabel, "正式版");

  // 就算外部传进 beta（旧状态、旧请求），也不会漏出测试版字样
  const legacy = channelPublic({ channel: "beta", pin: "" });
  assert.equal(legacy.channel, "stable");
  assert.equal(legacy.channelLabel, "正式版");
  assert.notEqual(legacy.channelLabel, "测试版");
});
