// Voyage 川意工具箱 —— Next.js Server Action 客户端
//
// 真实协议（从浏览器 HAR + 反混淆 chunk 实测得出）：
//   POST <页面路径>
//   Accept: text/x-component
//   next-action: <42位hex actionId>
//   Content-Type: multipart/form-data
//   字段： 0 = 序列化参数数组；有 FormData 参数时字段名为 _<索引>_<字段名>
//   响应： text/x-component（RSC flight），里面含 action 返回值
//
// 零依赖，Node 18+。

const BASE = "https://voyage-site.zeabur.app";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const decode = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

export class VoyageClient {
  constructor({ base = BASE, cookie = null } = {}) {
    this.base = base;
    /** @type {Map<string,string>} */
    this.jar = new Map();
    if (cookie) this.loadCookieString(cookie);
    /** 缓存 函数名 -> actionId */
    this.actionCache = new Map();
  }

  loadCookieString(str) {
    for (const part of String(str).split(/;\s*/)) {
      const eq = part.indexOf("=");
      if (eq > 0) this.jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    return this;
  }

  get cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  _store(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async get(path, opts = {}) {
    const res = await fetch(this.base + path, {
      headers: { "User-Agent": UA, Cookie: this.cookieHeader, ...(opts.headers || {}) },
      redirect: opts.redirect ?? "follow",
    });
    this._store(res);
    return { res, text: await res.text(), finalUrl: res.url };
  }

  /* ------------------------------------------------ 提交 Server Action */

  /**
   * @param {string} path        页面路径，如 "/account"
   * @param {string} actionId    40~64 位 hex
   * @param {Array}  args        位置参数（会被序列化进字段 "0"）
   * @param {Object} formFields  挂在某个参数索引上的 FormData 字段
   *                             { index: {name: value} } → 字段名 _<index>_<name>
   */
  async callAction(path, actionId, args = [], formFields = {}, { headers = {} } = {}) {
    const fd = new FormData();
    fd.append("0", JSON.stringify(args));
    for (const [idx, fields] of Object.entries(formFields)) {
      for (const [k, v] of Object.entries(fields)) {
        if (v != null) fd.append(`_${idx}_${k}`, String(v));
      }
    }
    const url = new URL(this.base + path);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Accept: "text/x-component",
        "Next-Action": actionId,
        // 不要手写 Content-Type：FormData 需要自己生成带 boundary 的头
        Cookie: this.cookieHeader,
        Origin: this.base,
        Referer: url.href,
        ...headers,
      },
      body: fd,
      redirect: "manual",
    });
    this._store(res);
    return { res, body: await res.text(), redirect: res.headers.get("x-action-redirect") };
  }

  /* ------------------------------------------------ 解析返回值 */

  /**
   * 从 RSC flight 响应里读出 action 的返回值。
   * 站点统一返回 {ok, message, data}（前端 handleResult 依赖此结构）。
   * flight 形如：
   *   0:{...}
   *   1:{"ok":true,"data":{"record":{...},"alreadySigned":true},"message":"$undefined"}
   */
  static parseActionResult(body) {
    for (const m of body.matchAll(/^(\d+):(\{.*\})$/gm)) {
      let obj;
      try {
        obj = JSON.parse(m[2]);
      } catch {
        continue;
      }
      if (typeof obj.ok !== "boolean") continue;
      const clean = (v) => (v === "$undefined" || v == null ? "" : String(v));
      return {
        ok: obj.ok,
        message: clean(obj.message) || clean(obj.error),
        data: obj.data ?? {},
        alreadySigned: !!(obj.data && obj.data.alreadySigned),
        record: (obj.data && obj.data.record) || null,
        reward: (obj.data && obj.data.reward) || null,
        totalSignIns: obj.data ? Number(obj.data.totalSignIns) || 0 : 0,
      };
    }
    return null;
  }

  /** 兜底：登录页等无 JS 降级提交时的状态解析 */
  static parseResult(body) {
    const t = decode(body).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const m =
      t.match(/\{"status":"([a-z]+)","message":"([^"]*)"/) ||
      t.match(/\\"status\\":\\"([a-z]+)\\",\\"message\\":\\"([^\\"]*)/);
    const alert = (t.match(/data-slot="alert-description"[^>]*>([^<]{1,200})/) || [])[1];
    const message = (m && m[2]) || (alert ? alert.trim() : "");
    return {
      ok: m ? m[1] !== "error" : /"ok"\s*:\s*true/.test(t),
      failed: m ? m[1] === "error" : /"ok"\s*:\s*false/.test(t),
      message,
      alreadySigned: /"alreadySigned"\s*:\s*true/.test(t),
      expired: /"expired"\s*:\s*true/.test(t),
    };
  }

  /* ------------------------------------------------ 发现 action id */

  /**
   * action id 是构建产物哈希，每次部署都会变，所以运行时现取：
   * 扫描页面引用的 JS chunk，找 createServerReference("<id>", ..., "<函数名>")
   */
  async findActionId(functionName, { pagePath = "/account" } = {}) {
    if (this.actionCache.has(functionName)) return this.actionCache.get(functionName);

    const { text: html } = await this.get(pagePath);
    const chunks = new Set();
    for (const m of html.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9._\-]+\.js/g)) chunks.add(m[0]);
    for (const m of html.matchAll(/\\\/_next\\\/static\\\/chunks\\\/[A-Za-z0-9._\\\-]+\.js/g))
      chunks.add(m[0].replace(/\\\//g, "/"));

    // 压缩后形如 (0,b.createServerReference)("00189d…",b.callServer,void 0,b.findSourceMapURL,"signInAction")
    const re = new RegExp(
      `createServerReference\\)?\\s*\\(\\s*"([0-9a-f]{40,64})"[^"]*"${functionName}"\\s*\\)`,
      "g"
    );
    let found = null;
    for (const c of chunks) {
      const r = await fetch(this.base + c, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const m = re.exec(await r.text());
      if (m) {
        found = m[1];
        break;
      }
    }
    if (found) this.actionCache.set(functionName, found);
    return found;
  }

  /* ------------------------------------------------ 页面状态 */

  /**
   * 抓取站点可见的全部 JS chunk。
   * @param {string[]} pages 用来收集 chunk 引用的页面
   * @yields {[string, string]} [chunk 路径, 源码文本]
   */
  async *allChunkSources(pages = ["/", "/login", "/register", "/account"]) {
    const chunks = new Set();
    for (const p of pages) {
      try {
        const { text } = await this.get(p);
        for (const m of text.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9._\-]+\.js/g)) chunks.add(m[0]);
        for (const m of text.matchAll(/\\\/_next\\\/static\\\/chunks\\\/[A-Za-z0-9._\\\-]+\.js/g))
          chunks.add(m[0].replace(/\\\//g, "/"));
      } catch {
        /* 单页失败不影响其余 */
      }
    }
    for (const c of chunks) {
      try {
        const r = await fetch(this.base + c, { headers: { "User-Agent": UA } });
        if (r.ok) yield [c, await r.text()];
      } catch {
        /* 跳过取不到的 */
      }
    }
  }

  /**
   * 登录态判据：/api/session 的 signedIn。
   *
   * 注意：站点会偶发返回空壳响应（与 /account 同样的抖动）。此时**不能**判定为
   * “未登录”——误判会触发一次多余的账密登录，而该站每登录一次就新增一条
   * “登录设备”记录。因此这里重试，并区分 false（真未登录）与 unknown（读不到）。
   */
  async sessionInfo({ attempts = 3 } = {}) {
    let last = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        const { res, text } = await this.get("/api/session");
        const j = JSON.parse(text);
        if (typeof j.signedIn === "boolean") {
          return { httpStatus: res.status, signedIn: j.signedIn, user: j.user || null, certain: true };
        }
        last = { httpStatus: res.status, signedIn: false, user: null, certain: false };
      } catch {
        last = { httpStatus: 0, signedIn: false, user: null, certain: false };
      }
      if (i < attempts) await new Promise((r) => setTimeout(r, 1200 * i));
    }
    return last;
  }

  /**
   * 从已登录页面读出签到状态。数据以 JSON 形式内联在 RSC flight 中：
   *   "signIn":{"todaySigned":true,"signDate":"...","consecutiveDays":1,
   *             "totalSignIns":1,"totalIntegral":12,"totalExperience":184,
   *             "currentReward":{"integralReward":12,"experienceReward":24}}
   */
  static parseSignInState(html) {
    const t = decode(html).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const i = t.indexOf('"signIn":{');
    if (i < 0) return null;
    // 取出这一段直到括号配平
    let depth = 0;
    let end = i + 9;
    for (; end < t.length; end++) {
      if (t[end] === "{") depth++;
      else if (t[end] === "}") {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }
    try {
      const o = JSON.parse(t.slice(i + 9, end));
      return {
        todaySigned: !!o.todaySigned,
        signDate: o.signDate || null,
        consecutiveDays: Number(o.consecutiveDays) || 0,
        totalSignIns: Number(o.totalSignIns) || 0,
        totalIntegral: Number(o.totalIntegral) || 0,
        totalExperience: Number(o.totalExperience) || 0,
        reward: o.currentReward || null,
      };
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------ 登录 / 注册 */

  /**
   * 解析 <form> 的无 JS 降级元数据。
   * 注意：这只是备用信息——真正提交走 callAction 的浏览器格式。
   */
  parseFormActions(html) {
    const out = [];
    for (const fm of html.matchAll(/<form[\s\S]*?<\/form>/g)) {
      const block = fm[0];
      const raw = decode(block.match(/name="\$ACTION_1:0"\s+value="([^"]*)"/)?.[1] ?? "");
      let meta = null;
      try {
        meta = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!meta?.id) continue;
      out.push({
        actionId: meta.id,
        bound: meta.bound ?? "$@1",
        key: block.match(/name="\$ACTION_KEY"\s+value="([^"]*)"/)?.[1] ?? null,
        fields: [...block.matchAll(/<input[^>]*?name="([^$"][^"]*)"/g)].map((m) => m[1]),
        buttons: [...block.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
          .map((m) => m[1].replace(/<[^>]*>/g, "").trim())
          .filter(Boolean),
      });
    }
    return out;
  }

  /**
   * 账号密码登录。
   *
   * 实测结论：这个站的 form 提交，服务端同时接受浏览器 flight 格式
   * （Next-Action 头 + _1_account 字段）和降级格式
   * （$ACTION_REF_1 / $ACTION_1:0 / $ACTION_KEY + 裸字段名）。
   * 但 flight 格式里参数 0 要引用 $K1（客户端闭包），脚本拿不到 → 服务端 E 报错。
   * 降级格式的 $ACTION_1:1 直接内联前态，脚本可完全自包含，因此这里用降级格式。
   * 成功特征：HTTP 303 + Set-Cookie voyage_at / voyage_rt。
   */
  async login(account, password) {
    // /login 也可能是空壳页（拿不到 <form>），重试几次再判定站点结构变了
    let form = null;
    let last = null;
    for (let i = 1; i <= 3 && !form; i++) {
      const { text } = await this.get("/login?next=%2Faccount");
      last = text;
      form = this.parseFormActions(text)[0] || null;
      if (!form && i < 3) await new Promise((r) => setTimeout(r, 1500 * i));
    }
    if (!form) throw new Error(`登录页连续 3 次解析不到 action（len=${last?.length}），站点结构可能已变`);

    const fd = new FormData();
    fd.append("$ACTION_REF_1", "");
    fd.append("$ACTION_1:0", JSON.stringify({ id: form.actionId, bound: form.bound }));
    fd.append("$ACTION_1:1", '[{"status":"idle"}]');
    if (form.key) fd.append("$ACTION_KEY", form.key);
    fd.append("next", "/account");
    fd.append("account", account);
    fd.append("password", password);

    const res = await fetch(this.base + "/login?next=%2Faccount", {
      method: "POST",
      headers: { "User-Agent": UA, Cookie: this.cookieHeader, Origin: this.base, Referer: this.base + "/login" },
      body: fd,
      redirect: "manual",
    });
    this._store(res);
    const body = await res.text();

    // 303 = 成功；200 = 页面回显错误（如“账号或密码错误”）
    const st = VoyageClient.parseResult(body);
    const sess = await this.sessionInfo();
    // /api/session 偶发读不到（certain:false）时不能算失败——303 + 下发 voyage_at
    // 已经是明确的成功信号，误判会白白重登一次、多堆一条登录设备记录。
    const gotTokens = this.jar.has("voyage_at") && this.jar.has("voyage_rt");
    const ok = sess.signedIn || (res.status === 303 && gotTokens);
    return {
      ok,
      status: st,
      httpStatus: res.status,
      session: sess,
      actionId: form.actionId,
    };
  }

  /**
   * 触发每日签到。
   * @param {string} [hintId] 上次记住的 action id；若已失效会自动重新发现。
   * @returns {Promise<{ok:boolean, alreadySigned:boolean, result:Object|null, httpStatus:number, actionId:string}>}
   */
  async checkIn(hintId) {
    // 先确认登录态：未登录时 /account 会被 307 踢回 /login，
    // 扫不到 chunk，报“找不到 action”会误导排查方向。
    const sess = await this.sessionInfo();
    if (!sess.signedIn && sess.certain) {
      const e = new Error("登录态无效（/api/session 明确返回 signedIn:false）。凭据可能已失效，请检查账号密码");
      e.code = "NOT_LOGGED_IN";
      throw e;
    }

    let id = hintId || null;

    // 有上次的 id 就先直接试，省掉一轮 chunk 扫描（每次扫描要下十几个 JS 文件）。
    // 站点重新部署后 id 变化会命中 "Failed to find Server Action"，那时再重扫。
    if (id) {
      const probe = await this._submitCheckIn(id);
      if (!VoyageClient._isUnknownAction(probe)) return { ...probe, actionId: id };
    }

    // 函数名可能被站长改掉，允许用 VOYAGE_ACTION_NAME 覆盖（先用 discover.mjs 查新名字）
    const fnName = process.env.VOYAGE_ACTION_NAME || "signInAction";
    id = await this.findActionId(fnName, { pagePath: "/account" });
    if (!id) {
      const e = new Error(
        `在 /account 引用的 JS 里找不到名为 ${fnName} 的 server action。` +
          "跑 node discover.mjs 看新的函数名，再用 VOYAGE_ACTION_NAME 指定。"
      );
      e.code = "ACTION_NOT_FOUND";
      throw e;
    }

    const out = await this._submitCheckIn(id);
    if (VoyageClient._isUnknownAction(out)) {
      const e = new Error(`action ${id} 被服务端拒绝（找不到该 server action），站点很可能刚重新部署`);
      e.code = "ACTION_STALE";
      throw e;
    }
    return { ...out, actionId: id };
  }

  static _isUnknownAction(probe) {
    // 明确的 404/415，或 flight 里出现 "Failed to find Server Action"
    if (
      probe.httpStatus === 404 ||
      probe.httpStatus === 415 ||
      /Failed to find Server Action|failed-to-find-server-action/i.test(probe.body || "")
    ) {
      return true;
    }
    // 有效 action 一定返回可解析的 {ok:...}；解析不出且响应是错误条目 → 视为 id 已失效
    if (!probe.result && /(?:^|\n)\d+:E\{/.test(probe.body || "")) return true;
    return false;
  }

  async _submitCheckIn(id) {
    const r = await this.callAction("/account", id, []);
    const result = VoyageClient.parseActionResult(r.body);
    return {
      httpStatus: r.res.status,
      result,
      body: r.body,
      ok: !!result?.ok,
      alreadySigned: !!result?.alreadySigned,
      message: result?.message || "",
    };
  }
}
