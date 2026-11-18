# bili-subtitle

> 弹性提取 Bilibili CC / AI 字幕的单文件 userscript；UP 主没开字幕时，用语音识别补上。
> A resilient, zero-config Bilibili CC & AI subtitle userscript — with an ASR fallback for videos that have no subtitles at all.

[English](#english) · 协议笔记见 [docs/PROTOCOL.md](docs/PROTOCOL.md)

**安装 / Install →** 推荐 [Greasy Fork](https://greasyfork.org/zh-CN/scripts/593554-bilibili-cc-ai-subtitle-extractor) · 备用 [GitHub Raw](https://raw.githubusercontent.com/ymt200120/bili-subtitle/main/bili-subtitle.user.js)
（需先安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)；步骤见下文）

---

## 这是什么 / What it is

安装一个 `.user.js`，打开 B 站视频页，点右下角「字幕」，脚本自动在多条获取路径之间回退，把 B 站已经提供给当前用户的字幕取出来；取不出来时，明确告诉你**哪条路径失败、为什么、下一步做什么**。

```text
安装 userscript
    ↓
打开 Bilibili 视频
    ↓
点击「字幕」（自动开始提取）
    ↓
策略链自动尝试：WBI 签名 API → 弹幕视图匿名通道 → 新版 Protobuf API → 播放器已加载资源
    （未签名的旧版 /x/player/v2 仅作诊断对比，不作为字幕来源）
    ↓
全部为空（UP 主没开 CC / AI 字幕）？面板给出「语音识别生成字幕」
    ↓                              点击后：音轨 → 必剪 ASR → 带时间轴字幕
成功提取，或给出精确诊断
```

用户不需要理解 `aid` / `cid` / `subtitle_url` / Protobuf / DevTools。

### 明确不做的事

- ❌ 不下载视频画面，不碰 ASR / Whisper 本地模型
- ❌ 不读取、不保存、不输出 Cookie（登录态由浏览器自动携带）
- ❌ 不上传任何数据到第三方；唯一的例外是**你主动点击**的语音识别兜底——音频只上传到 B 站自己的必剪接口（见下文）
- ❌ 无 analytics / telemetry
- ❌ 不提供十种导出格式、批量下载、搜索中心（这些已有成熟项目，见下文）

**导出仅有**：复制纯文本、复制带时间轴文本、TXT、SRT、JSON。

## 安装 / Install

- **推荐（普通用户）：[Greasy Fork 安装](https://greasyfork.org/zh-CN/scripts/593554-bilibili-cc-ai-subtitle-extractor)** — 从 Greasy Fork 安装的副本由 Greasy Fork 管理更新
- **备用（开发/测试）：[GitHub Raw](https://raw.githubusercontent.com/ymt200120/bili-subtitle/main/bili-subtitle.user.js)** — 直接跟随仓库的 userscript metadata 更新

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome/Edge）或 [Violentmonkey](https://violentmonkey.github.io/)（Firefox）
2. 点击上方任一链接安装脚本
3. 打开任意 <https://www.bilibili.com/video/…> 页面，右下角出现「字幕」

## 截图 / Screenshots

### 字幕面板 / Subtitle panel

![Subtitle panel](docs/screenshots/subtitle-panel.png)

### 解析诊断 / Resolver diagnostics

![Resolver diagnostics](docs/screenshots/resolver-diagnostics.png)

> 实际浏览器诊断示例：unsigned legacy metadata 被标记为 `UNTRUSTED_LEGACY` 并忽略，`signed-wbi` 以 `SIGNED_METADATA` 身份成为 Winner。

## Resolver 架构 / Resolver architecture

```mermaid
flowchart TD
    A[点击「字幕」] --> B[VideoContext resolver<br/>__INITIAL_STATE__ → view API]
    B -->|失败| Z[精确诊断：哪个环节失败]
    B --> A1[Strategy A': Signed WBI<br/>x/player/wbi/v2]
    A1 -->|轨道 + 正文可用| OK[✓ 字幕]
    A1 -->|空列表 / 正文 403·404| A2N[Strategy A2: dm-view 匿名通道<br/>x/v2/dm/view<br/>ai-zh URL 内嵌 aid+cid 可校验]
    A2N -->|轨道 + 正文可用| OK
    A2N -->|空 / 失败| D[Strategy B: Web Subtitle<br/>x/v2/subtitle/web/view · Protobuf]
    D -->|轨道 + 正文可用| OK
    D -->|空 / 失败| E[Strategy C: Player Resource<br/>PerformanceObserver 捕获<br/>epoch + 归属双重校验]
    E -->|捕获 URL 可解析| OK
    E -->|无捕获| Z
    Z -->|用户点击| ASR[语音识别兜底<br/>WBI playurl 音轨 → 必剪 ASR<br/>→ 带时间轴 cues]
    ASR --> OK
    A1 -.正文 403/404 时.-> A2[自动重新获取 metadata 再试一轮]
    L[legacy /x/player/v2<br/>仅诊断探针 · 未采信]
    B -.并发对比.-> L
```

要点：

- **字幕归属是 correctness 问题**：v1.0.2 引入 trust model——`SIGNED_METADATA`（WBI 签名）> `CURRENT_VIDEO_METADATA`（请求显式绑定 aid+cid）> `CURRENT_PLAYER_RESOURCE`（捕获 URL 已证明内嵌当前 cid/aid）；每条轨道、每个结果都绑定 `contextKey`（bvid:cid），面板与轨道选择只接受「可信 + 归属匹配」的内容
- **匿名也能拿到 AI 字幕**（v1.2.0）：播放器的字幕列表受 `need_login_subtitle` 门控，未登录时 `/x/player/wbi/v2`、`/x/player/v2` 一律空数组；但弹幕视图接口 `/x/v2/dm/view` 带同样的 `subtitle` 块且不做该门控。实测 96 个榜单视频里 58 条 `ai-zh` 轨道可匿名获取并下载正文，且 `subtitle_url` 形如 `prod/<aid><cid><hash>`，**归属可由 URL 直接校验**；内嵌了本 aid 但不含本 cid（其他分 P）的轨道会被丢弃
- **未签名旧版接口 `/x/player/v2` 降级为诊断探针**：有独立项目记录它在风控降级时返回 HTTP 200、内容合法但**属于其他视频**的字幕；它的结果只用于对比诊断与登录提示，永不作为字幕来源（详见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §2/§2b）
- **fail-closed 原则**：宁可提示「无法可靠确认字幕归属」，也不显示可能来自其他视频的字幕
- 签名字幕 URL 短期有效（403/404）：脚本**不缓存**，自动重取 metadata
- 每次提取有 `run #N` 编号，面板「获取路径」显示 Context / 各策略 / Winner；Console 日志带 `[bili-subtitle] [run:N]` 前缀，`auth_key`/`w_rid`/`wts` 等一律遮蔽

诊断示例：

```text
Extract run #17
Context · BV1BbKw6XEWq · aid 116… · cid 40065631429 · P1 · key BV1BbKw6XEWq:40065631429

✓ video-context · BV1BbKw6XEWq · aid … · cid 40065631429 · P1 · key BV1BbKw6XEWq:40065631429
✓ [SIGNED_METADATA] signed-wbi · 1 条轨道
✓ signed-wbi#fetch · 中文（AI） · 1342 条
✓ [UNTRUSTED_LEGACY] legacy-json(诊断) · 1 条轨道（未采信：未签名接口不作为结果来源）

Winner · signed-wbi · trust SIGNED_METADATA · key BV1BbKw6XEWq:40065631429
Ignored · legacy-json（UNTRUSTED_LEGACY：未签名接口不作为结果来源）
```

## 无字幕视频：语音识别兜底 / No subtitles? ASR fallback

UP 主没开启 CC / AI 字幕时，三条可信路径都会返回空轨道。此时面板不会只留一句「提取失败」，而是给出一个明确的按钮：**语音识别生成字幕**。

```text
WBI 签名的 playurl（aid + cid 绑定，只取 DASH 独立音轨，默认 64 kbps）
    ↓ 2 MiB 分片 Range 下载：真实进度、单分片失败仅重试该片
B 站「必剪」语音识别：resource/create → 分片 PUT → complete → task → result 轮询
    ↓ 毫秒级时间戳 → 常规 cues
预览 / 复制 / TXT / SRT / JSON —— 与官方字幕完全同一条通路
```

实测（**2026-11-19，匿名、未登录**，BV1aVs267E8Z，时长 12 分 25 秒）：音频 5.9 MB，解析 + 下载 + 上传 + 识别 + 整理 **约 7 秒**，得到 357 条带时间轴字幕，内容与视频语音一致。

> 风控提示：必剪接口带风控。实测**同一地址连续跑约 4 次完整流程后**，`task/result` 开始返回 `HTTP 412`（人机验证页）。所以这个功能被设计成「一次点击、一次运行」：失败时明确告诉你 412 需要先完成验证，轮询间隔也会逐步放慢。浏览器常态（带 `buvid3` 等 Cookie、已登录）下的阈值未验证；遇到 412 先用浏览器打开 <https://member.bilibili.com> 过一次验证再重试。

设计边界：

- **只在点击时运行**：不自动下载、不自动上传；面板上的说明会先写清「约 N 分钟音频 / 约 X MB / 上传至 B 站必剪接口」
- **不经第三方**：音频只发往 B 站自己的 `member.bilibili.com` 必剪接口，识别结果直接回到面板；不接入任何第三方 ASR / 云服务
- **无需登录、无需 Cookie**：资源上传走预签名 URL，任务接口匿名可用（实测结论，协议与证据见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §8）
- **不落盘**：音频仅存在于内存（`ArrayBuffer`），识别结束后丢弃；不写 `localStorage`、不缓存识别结果
- **来源可辨**：ASR 轨道标记为 `asr` / `中文（语音识别）` / trust `ASR_TRANSCRIPT`，与 B 站官方字幕分开展示；导出 JSON 也带 `source: asr`
- **可能出错**：同音字、专有名词、口音都会影响准确率；必剪 `model_id=7` 面向中文/中英混合，其他语种效果未验证
- **上限**：一次上传完整音轨（64 kbps 约 0.5 MB/分钟），内置 200 MB 上限；超长视频请自行权衡
- 可随时在进度条旁点「取消」，已上传的分片不会复用

## 为什么又造一个轮子？/ Why another subtitle extractor?

调研过的同类项目（截至 2026-08）：

| 项目 | 形态 | 已解决 | 未解决 |
|---|---|---|---|
| [DFameMaster/bilibili-transcript](https://github.com/DFameMaster/bilibili-transcript) | userscript | 10 种导出格式、分 P/合集、批量、搜索 | 无 AI 字幕回退、无诊断 |
| [YukinoAsuna/bilibili-subtitle-extractor](https://github.com/YukinoAsuna/bilibili-subtitle-extractor) | Chrome 扩展 + Python | 捕获播放器已加载的 AI 字幕 URL | 需开发者模式装扩展；需手动开 CC 后才能捕获 |
| [ainigo123/bilibili-subtitle](https://github.com/ainigo123/bilibili-subtitle) | TRAE Skill | AI Agent CLI 流程 | 非浏览器工具 |
| [ccBilly-aipm/bilibili-ai-subtitle](https://github.com/ccBilly-aipm/bilibili-ai-subtitle) | Python CLI | Protobuf 接口解析、403 重取 | 需从浏览器读 SESSDATA；CLI 形态 |
| [huanweide/bili-subtitle](https://github.com/huanweide/bili-subtitle) | userscript（已归档） | 普通 API 直取、语言选择 | 无 AI 回退；已停止维护 |

多格式导出、批量下载、Chrome 扩展、CLI、AI Agent 工作流——这些已经有更成熟的项目。本项目选择一个更窄的目标：

> **一个不需要 CLI、不需要扩展开发者模式、不需要导出 Cookie、尽可能自动跟随 Bilibili 接口变化的单文件 userscript。**

核心价值不在功能数量，而在：automatic fallback · diagnostics · zero configuration · small surface area。社区接口文档仓库 bilibili-API-collect 已于 2026-01 关停，接口漂移只会更频繁——这正是「策略链 + 诊断」设计存在的理由。

## 隐私 / Privacy

- 不读取、不存储、不输出 Cookie 或 SESSDATA；请求登录态由浏览器自动携带
- 不向任何第三方服务器发送数据；无 analytics / telemetry
- 语音识别兜底是**显式选择**：只有点击「语音识别生成字幕」才会下载该视频的 DASH 音轨并上传到 B 站自己的必剪接口；音频只存在于内存，不写磁盘、不缓存
- 日志（Console 与面板）中的短期签名参数一律遮蔽为 `***`
- 仅处理当前用户有权访问的内容（字幕，或用户自己点播的音频）

## 验证状态 / Verification status

诚实声明，不做过度承诺：

| 层级 | 状态 |
|---|---|
| 单元测试（105 项：URL/字幕解析/SRT/Protobuf/策略链/WBI 签名向量/归属校验/日志脱敏/dm-view/ASR 全流程） | ✅ `npm test` 全部通过 |
| WBI 签名算法（mixin_key 重排、w_rid 计算） | ✅ 与社区参考的确定性测试向量一致 |
| **跨视频字幕 bug（此前真实复现场景）** | ✅ **v1.0.2 已在真实浏览器验证：不再复现**（真实浏览器验证，2026-08-30） |
| 匿名接口行为（view API、player/v2 空列表、web/view 空protobuf） | ✅ 本机验证 2026-08-29，见 [docs/PROTOCOL.md](docs/PROTOCOL.md) |
| **signed-wbi 真实浏览器字幕提取** | ✅ **已验证**：真实视频页成功返回字幕轨并完成正文提取（见下方截图） |
| **trust model / Winner 行为** | ✅ **已验证**：`signed-wbi` 以 `SIGNED_METADATA` 成为 Winner，未签名 legacy metadata 被 `UNTRUSTED_LEGACY` 标记并忽略 |
| wbi/v2 匿名态完整行为、多账号/多风控场景矩阵 | ⚠️ 单一真实案例已验证，尚需更广覆盖 |
| 登录态系统性矩阵（多账号 / Strategy B web-view 轨道内容） | ⚠️ 尚需更多验证，协议依据见 PROTOCOL.md |
| **dm-view 匿名通道（免登录拿 AI 字幕）** | ✅ **已验证**：2026-11-19 匿名实测 96 个榜单视频 / 100 条轨道（58 条 `ai-zh` 全部可下载正文）；同一份 `src/` 代码跑通 3 个视频，180–700 ms 出结果（见 PROTOCOL §2c） |
| **ASR 兜底全流程（playurl → 下载 → 必剪 → cues）** | ✅ **已验证**：2026-11-19 匿名端到端跑通，12 分 25 秒视频 → 357 条字幕，约 7 秒（同一份 `src/` 代码，见 PROTOCOL §8）；同日观测到连续多轮后 `HTTP 412` 人机验证 |
| ASR 风控阈值（浏览器 Cookie / 登录态 / 不同 IP） | ⚠️ 未验证：匿名同 IP 约 4 轮后 `/task/result` 返回 412（其余端点仍正常） |
| ASR 在真实浏览器的 GM 二进制 PUT（Tampermonkey / Violentmonkey） | ⚠️ 管理器声明支持 ArrayBuffer 请求体，未实测 |
| 超长视频（>1 小时）的必剪上传/识别表现 | ⚠️ 未实测 |
| Firefox + Violentmonkey 的 GM arraybuffer | ⚠️ 管理器声明支持，未实测 |

## 兼容性 / Compatibility

- 目标环境：Chrome + Tampermonkey；Firefox + Violentmonkey/Tampermonkey
- 匹配页面：`https://www.bilibili.com/video/*`、`/list/*`
- **不支持**：番剧页、移动端 m 站、国际化站
- `GM_xmlhttpRequest` 不可用时回退到页面内 `fetch`（部分场景可能受 CORS 限制，诊断会显示）

## 故障排查 / Troubleshooting

| 现象 | 诊断 | 处理 |
|---|---|---|
| `signed-wbi` 显示 code -352 / HTTP 412 | WBI 签名被风控拒绝 | 脚本会自动刷新密钥并重试一次；若反复出现，稍后重试并提 issue |
| 所有可信接口都显示「空轨道」 | 该视频确实没有 CC / AI 字幕（UP 未开启），不是登录问题 | 用面板上的「语音识别生成字幕」现场生成 |
| `dm-view` 显示「N 条属于其他分 P，已丢弃」 | 响应里混入了同投稿其他分 P 的轨道 | 预期保护行为：只保留内嵌当前 aid+cid 的轨道 |
| 提示「未签名接口返回了轨道，但无法证明归属」 | legacy 探针有轨道但未采信 | 这是预期保护行为；以可信接口/播放器捕获结果为准 |
| `signed-wbi#fetch` / `web-view#fetch` 显示 HTTP 403/404 | 签名字幕 URL 过期 | 脚本会自动重取；若仍失败，稍后重试 |
| `player-resource` 显示 ○（无捕获） | 播放器还没加载过字幕 | 在播放器打开「字幕/CC」选 AI 字幕，让字幕出现一次，再点「提取字幕」 |
| `player-resource` 显示「与当前视频不匹配」 | 捕获到的字幕 URL 无法证明属于当前视频 | 在播放器打开「字幕/CC」让播放器实际加载一次，再点「提取字幕」 |
| 面板出现「语音识别生成字幕」 | UP 主未开启 CC / AI 字幕，三条可信路径都为空 | 点击即开始：音轨 → 必剪 ASR → 带时间轴字幕（无需登录） |
| 「语音识别」步骤显示 code -4xx / 超时 | 必剪接口异常、音频过大或网络中断 | 稍后重试；长视频注意 200 MB 上限；「获取路径」里有每一步的明细 |
| 「语音识别」提示 `HTTP 412` 人机验证 | 必剪接口按地址触发风控（连续多次识别后出现） | 用浏览器打开 <https://member.bilibili.com> 完成一次验证，稍后重试 |
| 「语音识别」上传卡住 | 音频经 B 站对象存储上传 | 点「取消」后重试；检查是否被网络/代理拦截 `*.biliapi.net` |
| 面板不出现 | 脚本未注入 | 确认脚本管理器已启用且匹配当前页面 |
| 提取结果疑似不属于自己的视频 | — | v1.0.2 起未签名接口的结果永远不会展示；如仍遇到，复制面板「获取路径」整块内容（含 run #N）提 issue |

## 开发 / Development

零运行时依赖、零开发依赖：

```bash
npm test           # node --test，纯逻辑测试（无网络请求）
npm run build      # 拼接 src/ -> bili-subtitle.user.js
npm run build:check
```

```text
src/
├── 00-namespace.js      # BS 命名空间 + 版本
├── core/                # 纯逻辑：日志脱敏/模型/URL/网络/音轨/protobuf/导出/诊断/SPA
├── asr/                 # 语音识别兜底：bcut 客户端 + 音轨到 cues 的编排
├── resolvers/           # video-context · legacy · web-view · player-resource · pipeline
├── ui/panel.js          # 轻量面板
└── main.js              # 装配与导出动作
```

修改 `src/` 后运行 `npm run build` 重新生成安装文件；测试与构建共用同一拼接规则（`scripts/pack.mjs`）。

## 社区 / Community

本项目认可并感谢 [LINUX DO](https://linux.do/) 作为开发者交流与开源分享的社区。
This project recognizes and appreciates [LINUX DO](https://linux.do/) as an open community for developer discussion and open-source sharing.

## Acknowledgements / Prior Art

本项目的技术路径站在以下公开项目的肩膀上，特此致谢（均为独立实现，未复制源码）：

- [ccBilly-aipm/bilibili-ai-subtitle](https://github.com/ccBilly-aipm/bilibili-ai-subtitle)：`/x/v2/subtitle/web/view` Protobuf 字段结构与 403 重取策略（协议依据详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)）
- [JoeyTeng/bilibili-helper PR #4](https://github.com/JoeyTeng/bilibili-helper/pull/4)：真实 Chrome/Tampermonkey 环境对二进制 metadata 响应的验证
- [YukinoAsuna/bilibili-subtitle-extractor](https://github.com/YukinoAsuna/bilibili-subtitle-extractor)：播放器资源捕获思路
- [1494948/bilibili-ai-subtitle-forcer](https://github.com/1494948/bilibili-ai-subtitle-forcer)：`x/v2/dm/view` 匿名通道与 `view/conclusion/get` 服务端生成队列的发现（本项目独立实现了解析、归属校验与信任分级）
- [SocialSisterYi/bcut-asr](https://github.com/SocialSisterYi/bcut-asr)：必剪语音识别接口流程（`resource/create` → 分片上传 → `complete` → `task` → `task/result`）的协议依据，本项目用 JS 重新实现并补测了匿名可用性
- [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)（已关停）：历史社区文档

本项目不是哔哩哔哩官方项目。仅处理当前用户有权访问的字幕内容，不负责字幕的重新分发；AI 字幕可能存在识别错误，请以视频原文为准。

## License

[MIT](LICENSE)

---

## English

A single-file userscript that extracts Bilibili CC & AI subtitles with automatic fallback:

```text
WBI-signed player metadata API (x/player/wbi/v2)
  ↓ empty / expired?
Danmaku-view subtitle channel (x/v2/dm/view — works signed out; AI URLs embed aid+cid for ownership checks)
  ↓ empty / failed?
Web Subtitle metadata API (x/v2/subtitle/web/view, protobuf)
  ↓ empty / failed?
Player resource capture (PerformanceObserver, epoch + ownership proof)
  ↓ failed?
Precise per-strategy diagnostics (✓ / ✗ / ○ with runId, context and winner)
```

- Zero configuration, no cookie access, no telemetry, no video download
- **No subtitles at all?** An opt-in ASR fallback reads the video's DASH audio stream (WBI-signed `playurl`, aid+cid bound), downloads it in 2 MiB Range chunks and posts it to Bilibili's own Bcut speech-recognition service — no login required, no third party, nothing fetched or uploaded until you click. Audio lives only in memory. Verified end to end anonymously on 2026-11-19: a 12m25s video (5.9 MB audio) produced 357 timestamped cues in ~7 s.
- Every track is bound to the video context (`contextKey` = bvid:cid) and a trust level; only trusted, context-matching tracks can be shown or selected — **fail closed: no subtitle is better than a valid subtitle from the wrong video**
- The unsigned legacy endpoint (`/x/player/v2`) is diagnostic-only: it has been reported (risk-control degradation) to return valid-looking subtitles belonging to a different video
- Works **without logging in**: the danmaku-view payload carries the same subtitle block as the player API but skips the `need_login_subtitle` gate, so already-generated AI subtitles stay reachable (96 sampled videos → 58 anonymous `ai-zh` tracks, all fetchable). Tracks whose URL embeds the current aid+cid are verified; other parts of the same upload are dropped
- Signed subtitle URLs are never cached; 403/404 triggers automatic metadata re-fetch
- Player resource capture is reset on SPA navigation, and a captured URL is only used when it provably belongs to the current video (embeds the current cid, or the current aid on single-page videos)
- Exports: copy plain text, copy timestamped text, TXT, SRT, JSON
- Only 4 formats by design — the value is resilience and diagnostics, not feature count

**Why another extractor?** Other projects already cover multi-format export, batch download, CLI, Chrome extensions and AI-agent workflows (see the table above). This project targets one narrow goal: a single userscript that follows Bilibili's shifting subtitle endpoints automatically and tells you exactly why when it cannot. It is not affiliated with Bilibili; it only reads subtitles already offered to the current user.

**Verification status:** 105 unit tests pass (`npm test`), including deterministic WBI signing vectors and a regression test for the valid-but-wrong unsigned legacy response; anonymous endpoint behavior verified from a dev environment on 2026-08-29. The v1.0.2 resolver trust model was additionally validated in a real browser against the previously reproduced cross-video subtitle case. ✅ The signed-WBI path has been validated in a real browser: it returned a subtitle track, fetched the subtitle body, and became the authoritative winner, with the trust model observed working as intended (unsigned legacy metadata ignored). ⚠️ Anonymous sessions and additional browser / userscript-manager combinations still require broader validation — see [docs/PROTOCOL.md](docs/PROTOCOL.md) for protocol evidence and open items.

**Install:** [Greasy Fork](https://greasyfork.org/zh-CN/scripts/593554-bilibili-cc-ai-subtitle-extractor) (recommended, updates managed by Greasy Fork) or [GitHub Raw](https://raw.githubusercontent.com/ymt200120/bili-subtitle/main/bili-subtitle.user.js) (development, follows the repo metadata).
