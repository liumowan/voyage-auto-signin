# Voyage 川意工具箱 · 每日自动签到

自动登录 `voyage-site.zeabur.app` 并完成每日签到。**零依赖**，Node 18+ 直接跑。

## 快速开始（多账号）

```bash
# 1) 写凭据：每行 账号::密码[::备注]，# 开头是注释
#    ⚠ 必须存成 UTF-8
notepad accounts.txt        # 或任何编辑器

# 2) 先看状态，确认账号都认出来了
node signin.mjs --dry-run

# 3) 签到
node signin.mjs
```

`accounts.txt` 示例：

```
someone1@example.com::密码A::账号1
someone2@example.com::密码B::账号2
```

也可以完全不建文件，用环境变量（GitHub Actions 上更顺手，多个账号用 `|` 分隔）：

```bash
VOYAGE_ACCOUNTS="a@x.com::pwd1::备注A|b@y.com::pwd2::备注B"
```

两个来源会合并并按账号去重。密码里可以含 `:`（分隔符是 `::`），但不能含 `|`。

跑单个账号：

```bash
node signin.mjs --only someone1@example.com
```

运行结果是一张汇总表，部分失败时退出码为 4，定时任务能感知：

```
本次处理 2 个账号：账号1, 账号2
[账号1] 今日已签到 | 连续 3 天 | 积分 52 | 经验 296
[账号2] ✗ 登录失败：账号或密码错误

================ 签到汇总 ================
☑️ 账号1       already  连续 3 天
❌ 账号2       failed   登录失败：账号或密码错误
共 2 个账号：新签 0 · 已签 1 · 失败 1
```

一个账号失败**不会**连累其他账号；登录失败也不重试（白刷对方的「登录设备」记录且无意义），只有网络类错误才退避重试。

## 多账号为什么要做隔离

这不是锦上添花，两个共用会导致**静默错误**：

| 隔离层 | 位置 | 共用的后果 |
|---|---|---|
| 登录态 | `.auth.json`（按账号分槽） | 互相顶掉 → 每次都不命中、反复重登（该站每登一次多一条设备记录），**而且有签错号的风险**：跑 B 账号却复用 A 的会话，日志看起来一切正常 |
| 签到状态 | `state.<账号>.json` | 账号 A 签完写入时间戳，账号 B 会误判"今天已签到"而**漏签** |
| 设备标识 | 各账号 state 内 | 保持稳定，重登只占同一条记录 |

反向地，action id 是**全站共享**的（Next.js 构建哈希，与账号无关），所以单独放 `.site.json`：第一个账号扫到就复用，其余账号不必各自下载十几个 JS chunk 重扫。

## 它是怎么工作的（真实协议）

这站是 Next.js App Router，**签到没有公开 REST 接口**，页面上那个「签到」按钮实际会调用
一个 **Server Action**（客户端 `createServerReference("00189d0a…", …, "signInAction")`，
**调用时不传业务参数**）。所以脚本流程是：

| 步骤 | 做法 |
|---|---|
| 1 登录 | `POST /login`（`$ACTION_REF_1` / `$ACTION_1:0` / `$ACTION_KEY` 降级格式）→ 成功返回 303 + Cookie `voyage_at`(30天) `voyage_rt`(7天) |
| 2 确认 | `GET /api/session` → `{"signedIn":true,"user":{…}}` |
| 3 读状态 | `GET /account`，从 RSC flight 里解析 `"signIn":{todaySigned,consecutiveDays,totalIntegral,totalExperience,currentReward}` |
| 4 提交 | `POST /account`，头带 `Next-Action: <actionId>` + `Accept: text/x-component`，体 `0=[]` |
| 5 校验 | 响应里读 `{"ok":true,"data":{record,reward,alreadySigned}}`，再回读页面确认 `todaySigned` |

几个设计要点：

- **action id 不写死**。Next.js 的 id 是构建哈希，站长每次重新部署都会变，写死一周内必失效。
  脚本把上次成功的 id 记在 `.site.json` 里优先复用；若服务端拒绝（`Failed to find Server Action`），
  自动重新扫描 `/account` 引用的 JS chunk 找 `signInAction` 的新 id。
- **复用登录态**。实测发现**每次账密登录都会在「登录设备」里新增一条会话记录**，
  所以脚本把 cookie 缓存到 `.auth.json`，只在失效时才重新登录；同时固定 `voyage_did`
  设备标识，让重新登录也只占同一条记录。
- **幂等安全**。已签到时服务端返回 `alreadySigned: true` 而不是报错，重复跑不会多领奖励。
- **抗站点抖动**。实测该站会偶发返回「空壳页」：HTTP 200、`<title>` 正常，但整块账户数据缺失
  （疑似它请求 Aegis 后端超时）。脚本对读状态、读登录态、取登录页三处都做了重试，
  并且**只在明确读到 `signedIn:false` 时**才判定登录态失效——误判会触发多余的重登，
  而每登一次就会在你账号的「登录设备」里多堆一条记录。

## 参数

| 参数 | 说明 |
|---|---|
| `--dry-run` | 只读状态，不提交 |
| `--force` | 今天已签到也照样提交一次，用来验证整条链路（服务端幂等，不会多领） |
| `--only <账号>` | 只跑匹配的账号，可重复给或逗号分隔（`VOYAGE_ONLY`） |
| `--dump` | 把已登录页面存成 `account.<账号>.html` 便于排查 |
| `--parallel` | 并发跑多账号。**默认关闭**：并发打同一站点会放大它本就存在的抖动 |

账号之间默认留 3 秒间隔（`VOYAGE_GAP_MS` 可调）。

## 环境变量

```ini
VOYAGE_ACCOUNTS="a@x.com::pwd::备注|b@y.com::pwd2"  # 多账号（推荐）
VOYAGE_ACCOUNT / VOYAGE_PASSWORD                    # 旧版单账号，仍支持
VOYAGE_TZ=Asia/Shanghai          # “今天”的时区基准
VOYAGE_RETRIES=2                 # 网络类失败的重试次数
VOYAGE_GAP_MS=3000               # 账号之间的间隔
VOYAGE_ONLY=账号1                # 只跑这些账号
VOYAGE_ACTION_NAME=signInAction  # 仅当站点改版改了函数名才需要改
VOYAGE_COOKIE=voyage_at=…; voyage_rt=…   # 可选：直接复用浏览器登录态，绕过账密
VOYAGE_DATA_DIR=/data            # 运行时文件目录（容器挂卷时用）
```

`VOYAGE_DATA_DIR` 决定 `.auth.json` / `.site.json` / `state.*.json` / `accounts.txt` 的存放位置，
默认就是代码目录。容器部署务必指向挂载卷，否则重建后登录态丢失、会退化成每天重新登录。

## 挂定时任务

### 方案 A：GitHub Actions（推荐，不占本机、免费）

**前提：仓库必须是 private**，Secrets 里存的是明文密码。

1. 在 GitHub 新建 **Private** 仓库（不要勾选自动生成 README，方便直接推本地目录）
2. 本目录推上去（见下面"推送命令"）
3. 仓库 Settings → Secrets and variables → Actions → New repository secret，加一个：

   | Name | Secret |
   |---|---|
   | `VOYAGE_ACCOUNTS` | `someone1@example.com::密码1::账号1\|someone2@example.com::密码2::账号2` |

   多个账号用 `|` 分隔，**整个值写在同一行**（不要换行）。
   注意 `accounts.txt` 已被 gitignore、不会进仓库，所以云上必须靠这个 secret 传凭据。
4. Actions 页 → "Voyage 每日签到（多账号）" → **Run workflow** 手动跑一次，看汇总表
5. 之后每天**北京时间 09:30** 自动跑（cron 写的是 UTC `30 1 * * *`）

推送命令（PowerShell）：

```powershell
cd "D:\0 ai玩耍\voyage-auto-signin"
git status --short          # ← 先看一眼，确认没有 accounts.txt / .auth.json / state.*.json
git init
git add .
git commit -m "Voyage 自动签到"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

> 推之前**务必**看一眼 `git status --short` 的输出：那三个文件含明文密码/会话令牌。
> [.gitignore](.gitignore) 已排除它们，但这是唯一一道防线，亲眼确认一次更稳妥。

workflow 已配好把 `.auth.json`、`.site.json`、`state.*.json` 用 artifact 在多次运行之间传递，
所以正常情况下不会每天重新登录（避免在你的「登录设备」里堆记录）。
artifact 保留 60 天，而 `voyage_at` 有效期 30 天，够用。

### 方案 B：Zeabur（一定要挂持久卷）

[Dockerfile](Dockerfile) 已配好 alpine + crond（每天 09:30）并设了 `VOYAGE_DATA_DIR=/data`。

**关键：给 `/data` 挂持久卷。** 不挂的话容器每次重建就丢登录态，
退化成"每次重新登录一次",在你的「登录设备」里堆记录（仍能签到，只是脏）。

1. 代码推到 GitHub 仓库（同样必须 private）
2. Zeabur 控制台 → Create Service → 选该仓库 → 会自动按 Dockerfile 构建
3. Service 的环境变量里加 `VOYAGE_ACCOUNTS`（格式同方案 A）
4. Storage → 给这个服务挂一个 Volume，挂载路径填 `/data`
5. 看日志确认输出里有汇总表（`zeabur logs --service-id <服务id>`，或在控制台看）

不想用 Dockerfile 的话，也可以直接用 Zeabur 的定时任务：命令 `node signin.mjs`,
cron `30 1 * * *`（**Zeabur cron 按 UTC 解析**,要北京时间 09:30 就写 `30 1 * * *`,建好后确认时区）。

本机装了 Docker 的话，推上去之前可以先验证镜像：

```bash
docker build -t voyage-signin .
docker run --rm -e VOYAGE_ACCOUNTS="a@x.com::密码::账号1" voyage-signin node signin.mjs --dry-run
```

### 方案 C：本机 Windows 任务计划程序

最省事，不用建仓库、不用传凭据到云上；代价是电脑关机就不跑。

```powershell
$action  = New-ScheduledTaskAction -Execute "node" `
  -Argument "signin.mjs" `
  -WorkingDirectory "D:\0 ai玩耍\voyage-auto-signin"
$trigger = New-ScheduledTaskTrigger -Daily -At 9:30am
Register-ScheduledTask -TaskName VoyageSignin -Action $action -Trigger $trigger -Force
```

凭据直接读同目录的 `accounts.txt`,不需要环境变量。手动测一次：

```powershell
Invoke-ScheduledTask -TaskName VoyageSignin
Get-ScheduledTaskInfo -TaskName VoyageSignin | Select-Object LastTaskResult   # 0 = 成功
```

任务计划不显示 stdout，想留日志就包一层 PowerShell：

```powershell
$action = New-ScheduledTaskAction -Execute "powershell" `
  -Argument "-NoProfile -Command `"cd 'D:\0 ai玩耍\voyage-auto-signin'; node signin.mjs *>> signin.log 2>&1`"" `
  -WorkingDirectory "D:\0 ai玩耍\voyage-auto-signin"
Set-ScheduledTask -TaskName VoyageSignin -Action $action
```

## 三个方案怎么选

| | GitHub Actions | Zeabur | 本机任务计划 |
|---|---|---|---|
| 关机/离线影响 | 不影响 | 不影响 | **电脑关机就不跑** |
| 配置量 | 中（建仓库 + 1 个 secret） | 高（要挂卷，不挂会堆登录记录） | 最低 |
| 凭据存放 | GitHub Secrets | Zeabur 环境变量 | 只在本地文件里 |
| 适合 | 推荐默认选它 | 你已有 Zeabur 服务顺带加 | 想先本机跑几天再上云 |

**建议先用方案 C 本机跑一两天**，确认每天汇总表都正常，再换 GitHub Actions 长期挂着 ——
凭据也只在需要时才上传到云端。

## 站点改版后怎么修

```bash
node discover.mjs                    # 用 accounts.txt 里第一个账号
node discover.mjs --only someone1@example.com
```

会打印当前签到状态，并把**全站 server action 的 id ↔ 函数名对照表**列出来，
标出疑似签到的那几个，同时把确认到的签到 action id 写进 `.site.json`。据此：

- 只是 id 变了 → 什么都不用做，脚本会自动重新发现
- 函数名改了 → 设环境变量 `VOYAGE_ACTION_NAME=<新函数名>`
- 页面结构大变（解析不到 `signIn`）→ 加 `--dump` 存下页面，人工核对字段名

## 清理登录设备记录

```bash
node sessions.mjs          # 遍历 accounts.txt 里所有账号
node sessions.mjs --only someone2
```

列出各账号当前的登录会话（按 UA 区分脚本与浏览器）。每次账密登录都会新增一条，
攒多了可在网页「账户中心 → 登录设备」里撤销。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `登录失败：账号或密码错误` | 账号要填注册时用的账号/邮箱，不是昵称 |
| `没有可用账号` | `accounts.txt` 没建/没被读到，或环境变量格式不对（注意分隔符是 `::` 和 `\|`） |
| `账号N` 显示成乱码 | `accounts.txt` 被存成了 ANSI/GBK。用 UTF-8 重存即可；账号密码是 ASCII 所以登录不受影响，只是备注乱码 |
| `登录态无效` 且密码没错 | 可能被风控；改用 `VOYAGE_COOKIE` 从浏览器复制登录态 |
| 日志出现 `第 N 次拿到空壳页` | **正常现象**。该站会偶发返回 HTTP 200、标题正常但账户数据整块缺失的页面（疑似它请求 Aegis 后端超时），脚本会自动重试；连续 4 次都读不到才报错退出 |
| `注册：IP已注册过账号` | 这站限制每个 IP 只能注册 1 个账号，用已有的即可 |
| `签到响应解析失败` | 站点刚重新部署导致 id 失效，脚本会自动重扫；仍失败就跑 `discover.mjs` |
| `解析不到 signIn 数据` | 页面结构变了，见「站点改版后怎么修」 |
| Actions 里每次都是 `账密登录成功` | artifact 没恢复成功（名字不对或首次运行），检查 workflow 里 `voyage-state` 是否一致 |

## 退出码

多账号改写后，单账号那套按错误类型分档的退出码已经合并了 —— 每个账号的失败都变成汇总表里的一行，进程只在"有账号没成功"时返回非零：

| 码 | 含义 |
|---|---|
| `0` | 全部成功，或全部是"今天已签到"（幂等，不算失败） |
| `1` | 配置/致命错误：没有可用账号、`--only` 指定的账号不存在、未捕获异常 |
| `4` | **至少一个账号失败**，具体哪个看汇总表 |

想知道失败原因就查汇总表里的 `failed` 行，或各账号的 `state.<账号>.json`。
定时任务里判 `$?` 是否为 0 即可（方案 C 用 `Get-ScheduledTaskInfo` 看 `LastTaskResult`)。

## 注意

- 只用于**自己账号**的自动化，频率已压到每天一次，不要改成高频轮询。
- `accounts.txt`（明文密码）、`.auth.json`（会话令牌）、`state.*.json` 都已在
  [.gitignore](.gitignore) 里排除，**推仓库前仍要亲眼确认一次** `git status --short` 里没有它们。
- 云端部署时凭据走 GitHub Secret `VOYAGE_ACCOUNTS`,不要把 `accounts.txt` 提交上去。
- 签到成功后奖励明细会写进各账号的 `state.<账号>.json`（最近 60 条），可用来核对是否漏签。
