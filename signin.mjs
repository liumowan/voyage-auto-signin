#!/usr/bin/env node
// Voyage 川意工具箱 —— 每日自动签到（支持多账号）
//
//   node signin.mjs                 跑所有账号
//   node signin.mjs --dry-run       只报告状态，不提交
//   node signin.mjs --force         已签到也提交一次（验证链路，服务端幂等）
//   node signin.mjs --only a@b.c    只跑某个账号（可重复给，或逗号分隔）
//   node signin.mjs --dump          保存已登录页面为 account.<账号>.html
//
// 凭据来源（两者会合并并按账号去重）：
//   1) accounts.txt   每行  账号::密码[::备注]   （# 开头为注释）
//   2) 环境变量       VOYAGE_ACCOUNTS="a::p1|b::p2"
//      或单账号       VOYAGE_ACCOUNT / VOYAGE_PASSWORD
//
// 设计要点：
//   1. action id 不硬编码 —— 它是构建哈希，重新部署就变，运行时从 JS chunk 现取
//   2. 判据读结构化数据（/api/session、flight 里的 signIn 与返回值），不靠中文文案猜
//   3. 幂等 —— 已签到时服务端返回 alreadySigned:true，重复跑无害
//   4. 状态与登录态**按账号隔离**，否则 A 签完会让 B 误判“今天已签到”而漏签

import fs from "node:fs";
import path from "node:path";
import { VoyageClient } from "./lib/voyage.mjs";
import {
  loadDotEnv,
  loadAccounts,
  readAuthCache,
  writeAuthCache,
  readState,
  writeState,
  dataDir,
  slotKey,
  sameAccount,
  readSiteCache,
  writeSiteCache,
} from "./lib/config.mjs";

loadDotEnv();

const OPT = {
  dryRun: process.argv.includes("--dry-run") || process.env.VOYAGE_DRY_RUN === "1",
  // 即使今天已签到也照样提交一次，用于验证整条链路；服务端幂等不会多领奖励
  force: process.argv.includes("--force"),
  dump: process.argv.includes("--dump"),
  parallel: process.argv.includes("--parallel"),
  tz: process.env.VOYAGE_TZ || "Asia/Shanghai",
  retries: Number(process.env.VOYAGE_RETRIES || 2),
  gapMs: Number(process.env.VOYAGE_GAP_MS || 3000),
  only: process.argv
    .flatMap((a, i) => (a === "--only" && process.argv[i + 1] ? [process.argv[i + 1]] : []))
    .concat((process.env.VOYAGE_ONLY || "").split(","))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

const log = (tag, ...a) => console.log(`${new Date().toISOString()} [${tag}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------- 重试 */

async function withRetry(tag, label, fn, attempts = OPT.retries + 1) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // 凭据/登录问题重试无意义，还会白刷对方的“登录设备”记录，立刻放弃
      if (["LOGIN_FAILED", "NO_CREDENTIALS", "NOT_LOGGED_IN"].includes(e.code)) throw e;
      log(tag, `[${label}] 第 ${i}/${attempts} 次失败：${e.message}`);
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw lastErr;
}

/* ------------------------------------------- 登录态：复用缓存，失效才重登 */

async function ensureAuth(tag, c, acc) {
  const cached = readAuthCache(acc.account);
  if (cached?.cookie) {
    c.loadCookieString(cached.cookie);
    const s = await c.sessionInfo();
    const actual = s.user?.account;

    // 缓存的登录态必须属于这个账号：换账号时直接复用会**静默签错号**
    if (s.signedIn && actual && !sameAccount(actual, acc.account)) {
      log(tag, `缓存登录态属于 ${actual}，与 ${acc.account} 不符，丢弃重登`);
      c.jar.clear();
    } else if (s.signedIn) {
      log(tag, `复用已存登录态（${actual || "?"}）`);
      return { reused: true, session: s };
    } else if (!s.certain) {
      // 站点抖动会返回读不到的空响应。只有明确 signedIn:false 才算过期，
      // 否则白白重登一次、给对方后台多堆一条登录设备记录。
      if (cached.account && !sameAccount(cached.account, acc.account)) {
        log(tag, `缓存账号(${cached.account})与 ${acc.account} 不符且无法确认登录态，丢弃重登`);
        c.jar.clear();
      } else {
        log(tag, "无法确认登录态（站点响应异常），暂按已登录处理，不重登");
        return { reused: true, session: { signedIn: true, user: null, uncertain: true } };
      }
    } else {
      log(tag, "缓存登录态已失效，改用账密登录");
      c.jar.clear();
    }
  }

  if (!acc.account || !acc.password) {
    const e = new Error("没有可用登录态，且该账号未配密码");
    e.code = "NO_CREDENTIALS";
    throw e;
  }

  // 设备标识按账号稳定：该站按 deviceId 记录“登录设备”，保持稳定可让重登只占同一条
  const state = readState(acc.account);
  if (!state.deviceId) {
    const rnd = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
    state.deviceId = `web-${rnd.slice(0, 8)}-${rnd.slice(8, 12)}-4${rnd.slice(13, 16)}-8${rnd.slice(17, 20)}-${rnd.slice(20, 32)}`;
    writeState(acc.account, state);
  }
  if (!c.jar.has("voyage_did")) c.jar.set("voyage_did", state.deviceId);

  const L = await c.login(acc.account, acc.password);
  if (!L.ok) {
    const e = new Error(`登录失败：${L.status.message || `HTTP ${L.httpStatus}`}`);
    e.code = "LOGIN_FAILED";
    throw e;
  }
  if (L.session.user?.account && !sameAccount(L.session.user.account, acc.account)) {
    const e = new Error(`登录得到 ${L.session.user.account}，与要求的 ${acc.account} 不一致，中止`);
    e.code = "LOGIN_FAILED";
    throw e;
  }
  const keep = ["voyage_at", "voyage_rt", "voyage_did"].filter((k) => c.jar.has(k));
  writeAuthCache(acc.account, {
    savedAt: new Date().toISOString(),
    account: L.session.user?.account || acc.account,
    cookie: keep.map((k) => `${k}=${c.jar.get(k)}`).join("; "),
  });
  log(tag, `账密登录成功（${L.session.user?.account || acc.account}），已缓存登录态`);
  return { reused: false, session: L.session };
}

/* --------------------------------------- 读签到状态（站点会偶发返回空壳页） */

async function readSignIn(tag, c, attempts = 4) {
  let lastText = null;
  for (let i = 1; i <= attempts; i++) {
    const r = await c.get("/account");
    if (/\/login/.test(r.finalUrl)) {
      const e = new Error("/account 被踢回登录页，登录态已失效");
      e.code = "NOT_LOGGED_IN";
      throw e;
    }
    lastText = r.text;
    const st = VoyageClient.parseSignInState(r.text);
    if (st) return { state: st, text: r.text, tries: i };
    if (i < attempts) {
      log(tag, `第 ${i} 次拿到空壳页（无 signIn 数据，len=${r.text.length}），重试…`);
      await sleep(2000 * i);
    }
  }
  return { state: null, text: lastText, tries: attempts };
}

/* ------------------------------------------------------------- 单账号流程 */

async function runAccount(acc) {
  const tag = acc.note.slice(0, 24);
  const out = { account: acc.account, note: acc.note, status: "failed", detail: "", consecutive: null };
  const c = new VoyageClient();
  const state = readState(acc.account);

  try {
    // 1) 登录态
    await withRetry(tag, "auth", () => ensureAuth(tag, c, acc));

    // 2) 状态
    const b = await readSignIn(tag, c);
    if (OPT.dump && b.text) fs.writeFileSync(path.join(dataDir(), `account.${slotKey(acc.account)}.html`), b.text);
    if (!b.state) {
      out.detail = "多次重试仍读不到 signIn 数据（站点抖动或页面结构变更）→ 跑 discover.mjs";
      log(tag, out.detail);
      return out;
    }
    const before = b.state;
    out.consecutive = before.consecutiveDays;
    log(
      tag,
      `今日${before.todaySigned ? "已" : "未"}签到 | 连续 ${before.consecutiveDays} 天 | ` +
        `累计 ${before.totalSignIns} 次 | 积分 ${before.totalIntegral} | 经验 ${before.totalExperience}`
    );

    if (before.todaySigned && !OPT.force) {
      out.status = "already";
      out.detail = `连续 ${before.consecutiveDays} 天`;
      return out;
    }
    if (OPT.dryRun) {
      out.status = before.todaySigned ? "already" : "dry";
      out.detail = "dry-run 未提交";
      return out;
    }

    // 3) 提交
    // action id 是全站共享的构建哈希，优先用各账号 state 里没记录时的站点级缓存
    const hintId = state.signInActionId || readSiteCache().signInActionId;
    const r = await withRetry(tag, "checkin", async () => {
      const res = await c.checkIn(hintId);
      if (!res.result) throw new Error(`签到响应解析失败（HTTP ${res.httpStatus}）`);
      return res;
    });
    if (r.actionId && r.actionId !== hintId) {
      // 新 id 写站点级缓存，后续账号（以及明天的运行）就不必再重扫
      writeSiteCache({ signInActionId: r.actionId, seenAt: new Date().toISOString() });
      state.signInActionId = r.actionId;
      writeState(acc.account, state);
      log(tag, `已更新站点级 action id：${r.actionId.slice(0, 12)}…`);
    }

    const rec = r.result.record;
    log(tag, `ok=${r.ok} alreadySigned=${r.alreadySigned} action=${r.actionId.slice(0, 12)}…`);
    if (rec) {
      log(
        tag,
        `本次奖励：${rec.integralReward ?? "?"} 积分 + ${rec.experienceReward ?? "?"} 经验 | ` +
          `连续 ${rec.consecutiveDays} 天 | ${rec.bonusDescription || rec.bonusType || ""}`
      );
    }
    if (!r.ok) {
      out.detail = `服务端拒绝：${r.message || JSON.stringify(r.result).slice(0, 160)}`;
      log(tag, out.detail);
      return out;
    }

    // 4) 回读校验
    await sleep(800);
    const after = (await readSignIn(tag, c)).state;
    if (!after) {
      log(tag, "⚠ 回读撞上空壳页，采信接口 ok:true");
    } else if (!after.todaySigned) {
      out.detail = "接口说成功，但页面仍显示未签到";
      log(tag, `⚠ ${out.detail}`);
      return out;
    } else {
      out.consecutive = after.consecutiveDays;
      log(
        tag,
        `✅ 连续 ${after.consecutiveDays} 天 | 累计 ${after.totalSignIns} 次 | 积分 ${after.totalIntegral} | 经验 ${after.totalExperience}`
      );
    }

    out.status = r.alreadySigned ? "already" : "signed";
    out.detail = rec ? `+${rec.integralReward} 积分 / +${rec.experienceReward} 经验` : "ok";

    // 5) 记录（幂等命中不重复写历史）
    if (!r.alreadySigned) {
      const today = (() => {
        try {
          return new Intl.DateTimeFormat("en-CA", { timeZone: OPT.tz }).format(new Date());
        } catch {
          return new Date().toISOString().slice(0, 10);
        }
      })();
      state.lastSuccessDate = today;
      state.history = [
        {
          date: after?.signDate || today,
          integral: rec?.integralReward ?? null,
          experience: rec?.experienceReward ?? null,
          consecutiveDays: after?.consecutiveDays ?? rec?.consecutiveDays ?? null,
          at: new Date().toISOString(),
        },
        ...(state.history || []),
      ].slice(0, 60);
      writeState(acc.account, state);
    }
    return out;
  } catch (e) {
    out.detail = e.message;
    log(tag, "✗", e.message);
    return out;
  }
}

/* --------------------------------------------------------------- 汇总 */

const ICON = { signed: "✅", already: "☑️", dry: "· ", failed: "❌" };

function summarize(results) {
  console.log("\n================ 签到汇总 ================");
  const w = Math.max(8, ...results.map((r) => r.note.length));
  for (const r of results) {
    console.log(`${ICON[r.status] || "  "} ${r.note.padEnd(w)}  ${r.status.padEnd(7)}  ${r.detail}`);
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(
    `------------------------------------------\n共 ${results.length} 个账号：` +
      `新签 ${n("signed")} · 已签 ${n("already")} · 失败 ${n("failed")}`
  );
}

async function main() {
  let accounts = loadAccounts();

  if (OPT.only.length) {
    accounts = accounts.filter((a) => OPT.only.some((o) => sameAccount(a.account, o)));
    if (!accounts.length) {
      console.error(`--only 指定的账号在凭据列表里找不到：${OPT.only.join(", ")}`);
      process.exit(1);
    }
  }

  if (!accounts.length) {
    console.error(
      "没有可用账号。请在 accounts.txt 里写 `账号::密码`，或设环境变量 VOYAGE_ACCOUNTS=\"a::p|b::p\""
    );
    process.exit(1);
  }

  console.log(`本次处理 ${accounts.length} 个账号：${accounts.map((a) => a.note).join(", ")}`);

  const results = [];
  if (OPT.parallel) {
    // 并发会同时打同一个站点，且它的后端本来就偶发抖动；默认不开
    const rs = await Promise.all(accounts.map(runAccount));
    results.push(...rs);
  } else {
    for (let i = 0; i < accounts.length; i++) {
      if (i > 0) await sleep(OPT.gapMs); // 账号之间留点间隔，别连续打
      results.push(await runAccount(accounts[i]));
    }
  }

  summarize(results);
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length) process.exitCode = 4;
}

main().catch((e) => {
  log("fatal", e.message);
  process.exit(1);
});
