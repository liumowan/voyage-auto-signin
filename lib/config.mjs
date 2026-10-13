// 多账号签到共用的配置/缓存工具（被 signin.mjs 与 discover.mjs 复用）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, "..");

/**
 * 运行时文件（登录态、站点缓存、各账号状态、accounts.txt）的存放目录。
 * 默认与代码同目录；容器部署时用 VOYAGE_DATA_DIR 指向挂载卷，
 * 否则容器一重建登录态就丢 → 每天被迫重新登录一次。
 *
 * **必须惰性求值**：VOYAGE_DATA_DIR 可能来自 .env，而 .env 是在 loadDotEnv()
 * 里才读进 process.env 的。若在模块加载时就算成常量，会读不到 .env 里的值，
 * 表现为“改了 .env 却不生效”,而且文件散落在两个目录里更难查。
 */
let _dataDir;
export function dataDir() {
  if (_dataDir) return _dataDir;
  _dataDir = process.env.VOYAGE_DATA_DIR ? path.resolve(process.env.VOYAGE_DATA_DIR) : ROOT;
  if (_dataDir !== ROOT) fs.mkdirSync(_dataDir, { recursive: true });
  return _dataDir;
}

/** 测试/调试用：重新解析数据目录 */
export function resetDataDir() {
  _dataDir = undefined;
  return dataDir();
}

/** 极简 .env 读取：已存在的环境变量优先。代码目录与 dataDir 都读（前者优先） */
export function loadDotEnv() {
  for (const dir of [ROOT, dataDir()]) {
    const f = path.join(dir, ".env");
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  resetDataDir(); // .env 里可能刚设了 VOYAGE_DATA_DIR，重新解析
}

/**
 * 账号是否同一个。站点回填的 user.account 可能与用户输入大小写不同，
 * 且允许邮箱或账号名任一种登录，所以做宽松比较。
 */
export function sameAccount(a, b) {
  const norm = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/[（]/g, "(")
      .replace(/[）]/g, ")");
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x === y || x.endsWith(`@${y}`) || y.endsWith(`@${x}`));
}

export function slotKey(account) {
  return String(account || "").trim().toLowerCase().replace(/[^a-z0-9.@_-]/g, "_") || "_default";
}

/* ---------------------------------------------- 登录态缓存（按账号分槽） */
/*
 * 为什么必须缓存：实测每次账密登录都会在该站“登录设备”里新增一条会话记录；
 * 复用 voyage_at(30天)/voyage_rt(7天) 可避免每天重登堆记录。
 * 按账号分槽：两个账号共用一份缓存会互相顶掉 → 每次都判不命中反复重登，
 * 甚至有签错号的风险。
 */
export function authFile() {
  return path.join(dataDir(), ".auth.json");
}

function readJsonMaybe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function readAuthStore() {
  const p = authFile();
  // dataDir 与代码目录不同时，旧位置的文件仍读一次并合并，
  // 免得升级后登录态“凭空消失”→ 触发无谓的重新登录
  let store = readJsonMaybe(p);
  if (!store) store = p === path.join(ROOT, ".auth.json") ? null : readJsonMaybe(path.join(ROOT, ".auth.json"));
  if (!store) return {};
  if (store.cookie) return { [String(store.account || "").toLowerCase()]: store }; // 旧版单账号结构
  return typeof store === "object" ? store : {};
}

export function readAuthCache(account) {
  const store = readAuthStore();
  return store[slotKey(account)] || null;
}

export function writeAuthCache(account, obj) {
  const store = readAuthStore();
  store[slotKey(account)] = obj;
  const p = authFile();
  fs.writeFileSync(p, JSON.stringify(store, null, 2));
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* Windows 上 chmod 作用有限 */
  }
}

/* ------------------------------------------------ state（按账号分文件） */
/*
 * state 若全局共用一份，账号 A 签完写入 lastSuccessDate 后，
 * 账号 B 会误判“今天已签到”而跳过 —— 静默漏签。
 */
export function statePath(account) {
  return path.join(dataDir(), `state.${slotKey(account)}.json`);
}

export function readState(account) {
  const p = statePath(account);
  const here = readJsonMaybe(p);
  if (here) return here;
  // 换了 VOYAGE_DATA_DIR 之后，旧位置的状态读一次并迁过来，
  // 否则会被当成“从没签过”而重复提交、并丢掉历史
  if (p !== path.join(ROOT, `state.${slotKey(account)}.json`)) {
    const legacy = readJsonMaybe(path.join(ROOT, `state.${slotKey(account)}.json`));
    if (legacy) return legacy;
  }
  return { lastSuccessDate: null, history: [] };
}

export function writeState(account, s) {
  fs.writeFileSync(statePath(account), JSON.stringify(s, null, 2));
}

/* ------------------------------------------------------ 账号列表解析 */

/**
 * 支持两种凭据来源（合并去重，文件在前）：
 *  1) accounts.txt：每行 `账号::密码[::备注]`，# 开头为注释；也可 `账号<TAB>密码`
 *  2) 环境变量 VOYAGE_ACCOUNTS="a::p1|b::p2"，以及旧版单账号 VOYAGE_ACCOUNT/VOYAGE_PASSWORD
 * 密码可以含 ':'，所以用 '::' 作分隔符（密码里别出现 '|' 和 '::'）。
 */
export function loadAccounts() {
  const out = [];
  const seen = new Set();
  const push = (account, password, note) => {
    account = String(account || "").trim();
    if (!account) return;
    const k = account.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ account, password: String(password || "").trim(), note: String(note || "").trim() || account });
  };

  // 代码目录与 dataDir 都找一遍（容器部署时 accounts.txt 常挂在卷上）
  const dirs = dataDir() === ROOT ? [ROOT] : [ROOT, dataDir()];
  for (const dir of dirs) {
    const f = path.join(dir, "accounts.txt");
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      let parts = t.split("::");
      if (parts.length === 1) parts = t.split(/\t+/);
      if (parts.length >= 2) push(parts[0], parts[1], parts[2]);
      else console.warn(`⚠ accounts.txt 该行缺少密码，已忽略: ${t.slice(0, 30)}…`);
    }
  }

  if (process.env.VOYAGE_ACCOUNTS) {
    for (const seg of process.env.VOYAGE_ACCOUNTS.split("|")) {
      const [a, p, n] = seg.split("::");
      push(a, p, n);
    }
  }
  if (process.env.VOYAGE_ACCOUNT && process.env.VOYAGE_PASSWORD) {
    push(process.env.VOYAGE_ACCOUNT, process.env.VOYAGE_PASSWORD, process.env.VOYAGE_NOTE);
  }

  return out;
}

/** 从缓存/环境里找一个可用 cookie（供 discover/sessions 这类单账号工具用） */
export function cookieFor(account) {
  if (process.env.VOYAGE_COOKIE) return process.env.VOYAGE_COOKIE;
  return readAuthCache(account)?.cookie || null;
}

/* --------------------------------------------- 站点级缓存（action id 等） */
/*
 * action id 是 Next.js 构建产物哈希，**全站共享**、与账号无关。
 * 若只存在各账号自己的 state 里，站点重新部署后每个账号都要各自失败并重扫
 * 一遍（每次重扫要下载十几个 JS 文件）。所以单独放一个站点级文件共享。
 */
export function siteFile() {
  return path.join(dataDir(), ".site.json");
}

export function readSiteCache() {
  const here = readJsonMaybe(siteFile());
  if (here) return here;
  // 旧位置（代码目录）的缓存读一次，避免换 dataDir 后白重扫一遍 chunk
  if (dataDir() !== ROOT) return readJsonMaybe(path.join(ROOT, ".site.json")) || {};
  return {};
}

export function writeSiteCache(obj) {
  fs.writeFileSync(siteFile(), JSON.stringify({ ...readSiteCache(), ...obj }, null, 2));
}
