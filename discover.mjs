#!/usr/bin/env node
// 站点改版后用这个重新定位 server action。
// 用法： node discover.mjs            用 accounts.txt 里的第一个账号
//       node discover.mjs --only x@y.com
//
// 输出：
//   1. 登录并确认登录态
//   2. /account 的签到状态（从 flight 的 signIn 结构化读取）
//   3. 全站 createServerReference 的 id ↔ 函数名对照，并高亮疑似签到的
//      —— 同时把确认到的签到 action id 写进站点级缓存 .site.json，
//        这样 signin.mjs 不必再自己重扫。
import { VoyageClient } from "./lib/voyage.mjs";
import { loadAccounts, loadDotEnv, cookieFor, writeSiteCache } from "./lib/config.mjs";

loadDotEnv();

const onlyIdx = process.argv.indexOf("--only");
const only = (onlyIdx >= 0 && process.argv[onlyIdx + 1]) || "";
const accounts = loadAccounts();
if (!accounts.length) {
  console.error("没有可用账号：请在 accounts.txt 写 `账号::密码`，或设 VOYAGE_ACCOUNT/VOYAGE_PASSWORD");
  process.exit(1);
}
const acc = only ? accounts.find((a) => a.account.toLowerCase().includes(only.toLowerCase())) : accounts[0];
if (!acc) {
  console.error(`--only ${only} 在账号列表里找不到`);
  process.exit(1);
}
console.log(`使用账号：${acc.note} (${acc.account})`);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const c = new VoyageClient();

/* 1) 优先复用已缓存登录态，避免为诊断而多登一次（该站每次登录都新增一条登录设备记录） */
const cached = cookieFor(acc.account);
if (cached) {
  c.loadCookieString(cached);
  const s = await c.sessionInfo();
  if (s.signedIn) console.log(`[login] 复用已缓存登录态（${s.user?.account}）`);
  else await doLogin();
} else {
  await doLogin();
}

async function doLogin() {
  const L = await c.login(acc.account, acc.password);
  console.log(`[login] HTTP ${L.httpStatus} | signedIn=${L.ok} | ${L.session.user?.account || ""}`);
  if (!L.ok) {
    console.error("       登录失败：", L.status.message || "（无消息，可能被风控）");
    process.exit(2);
  }
}

/* 2) 签到状态（该站偶发返回空壳页，重试几次） */
let page = null;
let signIn = null;
for (let i = 1; i <= 4 && !signIn; i++) {
  page = await c.get("/account");
  if (/\/login/.test(page.finalUrl)) {
    console.error("[account] 被踢回登录页，登录态未生效");
    process.exit(2);
  }
  signIn = VoyageClient.parseSignInState(page.text);
  if (!signIn && i < 4) {
    console.log(`[account] 第 ${i} 次拿到空壳页，重试…`);
    await new Promise((r) => setTimeout(r, 2000 * i));
  }
}
console.log("[signin] ", JSON.stringify(signIn));
if (!signIn) console.warn("         仍解析不到 signIn —— 页面结构可能已大改，看下面 action 清单");

/* 3) action 清单 */
const all = new Map(); // id -> name
for await (const [, js] of c.allChunkSources()) {
  for (const m of js.matchAll(/createServerReference\)?\s*\(\s*"([0-9a-f]{40,64})"[^"]*"([A-Za-z_$][\w$]{2,60})"\s*\)/g)) {
    if (!all.has(m[1])) all.set(m[1], m[2]);
  }
}

const rows = [...all.entries()].sort((a, b) => a[1].localeCompare(b[1]));
console.log(`\n[actions] 全站发现 ${all.size} 个 server action：`);
for (const [id, name] of rows) {
  const mark = /sign|check|point|integral|reward/i.test(name) ? "  ← 疑似签到相关" : "";
  console.log(`  ${id}  ${name}${mark}`);
}

const hit = rows.filter(([, n]) => /^signInAction$/i.test(n));
if (hit.length) {
  const id = hit[0][0];
  writeSiteCache({ signInActionId: id, seenAt: new Date().toISOString() });
  console.log(
    `\n签到 action：${hit.map(([i, n]) => `${n}=${i}`).join(", ")}\n已写入站点级缓存 .site.json，` +
      "接下来直接跑 node signin.mjs --dry-run 验证即可。"
  );
} else {
  console.log(
    "\n⚠ 没找到名为 signInAction 的 action —— 站点可能改了函数名。" +
      "\n   从上面「疑似签到相关」里人工确认后，设环境变量 VOYAGE_ACTION_NAME=<新函数名> 再跑 signin.mjs。"
  );
}
