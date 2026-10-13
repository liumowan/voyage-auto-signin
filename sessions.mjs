// 列出各账号的“登录设备”会话，便于清理脚本探测留下的记录
// 用法： node sessions.mjs [--only 账号]
import { VoyageClient } from "./lib/voyage.mjs";
import { loadAccounts, readAuthCache, loadDotEnv } from "./lib/config.mjs";

loadDotEnv();

const only = (process.argv.find((a, i) => a === "--only" && process.argv[i + 1]) || process.argv[process.argv.indexOf("--only") + 1] || "").toLowerCase();
const accounts = loadAccounts().filter((a) => !only || a.account.toLowerCase().includes(only));

if (!accounts.length) {
  console.error("没有账号可查（检查 accounts.txt 或 VOYAGE_ACCOUNT）");
  process.exit(1);
}

for (const [i, acc] of accounts.entries()) {
  const cached = readAuthCache(acc.account);
  console.log(`\n===== ${acc.note} (${acc.account}) =====`);
  if (!cached?.cookie) {
    console.log("  无缓存登录态，跳过（先跑一次 node signin.mjs --only 该账号）");
    continue;
  }
  const c = new VoyageClient();
  c.loadCookieString(cached.cookie);
  const sess = await c.sessionInfo();
  if (!sess.signedIn) {
    console.log("  登录态已失效，跳过");
    continue;
  }
  const { text } = await c.get("/account");
  const clean = text.replace(/\\"/g, '"');
  const rows = [
    ...clean.matchAll(
      /"tokenHash":"([0-9a-f]{64})","current":(true|false),"account":"[^"]*","provider":"[^"]*"(?:,"deviceId":"([^"]*)")?,"ip":"([^"]*)","userAgent":"([^"]*)","issuedAt":"([^"]*)"/g
    ),
  ];
  if (!rows.length) {
    console.log("  没解析到会话列表（站点返回可能是空壳页，重试一次即可）");
    continue;
  }

  const byUa = new Map();
  for (const r of rows) {
    const short = /Chrome\/126\.0 Safari/.test(r[5])
      ? "脚本 UA（Chrome/126）"
      : /Chrome\/1\d\d\.0\.0\.\d+ Safari/.test(r[5])
        ? "浏览器 UA"
        : r[5].slice(0, 40);
    byUa.set(short, (byUa.get(short) || 0) + 1);
  }
  console.log(`  会话总数 ${rows.length}`);
  for (const [k, v] of byUa) console.log(`    ${v} × ${k}`);
  console.log("  明细：");
  for (const r of rows) {
    console.log(
      `    ${r[1].slice(0, 8)}…  current=${r[2].padEnd(5)}  ${r[6].slice(0, 19)}  ${/Chrome\/126\.0 Safari/.test(r[5]) ? "← 脚本" : ""}`
    );
  }
  if (i < accounts.length - 1) await new Promise((r) => setTimeout(r, 2000));
}

console.log("\n可在网页「账户中心 → 登录设备」撤销，或用 discover.mjs 查到的 revokeOtherSessionsAction 撤销其它会话。");
