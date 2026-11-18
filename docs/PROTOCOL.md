# 协议笔记 / Protocol notes

本文件记录 `bili-subtitle` 依赖的 Bilibili 接口行为、依据与不确定性。
所有「本机验证」均为 **2026-08-29 的匿名（未登录）请求**，来自开发环境。
登录态行为无法在本环境验证，已明确标注。
2026-08-30 起补充了**真实浏览器（登录态）验证**结果，与「本机验证」分开标注
（见 §2b 与 §7）；单一案例验证不代表全场景验证。
2026-11-19 新增 §8「语音识别兜底」，其中接口行为均为**匿名本机验证**（无 Cookie）。

背景：社区接口文档仓库 [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) 已于 2026-01 因收到 B 站律师函而永久关停。
因此本文只记录本项目实际依赖的最小行为集合，而不是完整的接口文档。
本文不构成对 Bilibili 接口的完整描述；B 站随时可能修改这些接口，
这也是本脚本采用「策略链 + 诊断」而不是单一路径的原因。

## 验证状态图例

| 标记 | 含义 |
|---|---|
| ✅ 本机验证 | 开发环境匿名请求，2026-08-29 |
| 📚 Prior art | 由已发布的开源项目验证并公开记录（见文末） |
| ⚠️ 待浏览器验证 | 需要登录态/真实播放器环境，本环境无法确认 |

## 1. 视频信息

### `GET https://api.bilibili.com/x/web-interface/view?bvid=<BV>`

- ✅ 返回 `{"code":0,"data":{aid, cid, pages[], title, ...}}`
- ✅ 匿名可用；`pages[].cid` 用于多 P 选择
- 本项目用它解析 `aid` / `cid` / 分 P / 标题

页面内嵌的 `window.__INITIAL_STATE__.videoData` 提供同样的字段，
本项目优先使用它（零请求），并在 SPA 状态下校验 `bvid` 一致性，
不一致则回退到该 API。

## 2. 旧版字幕列表（legacy / 诊断探针，v1.0.2 起非权威）

### `GET https://api.bilibili.com/x/player/v2?bvid=<BV>&cid=<CID>`

- ✅ 匿名返回 `{"code":0,"data":{"subtitle":{"subtitles":[]}}}`
- ✅ 匿名访问 AI 字幕视频时 `subtitles` 为 **空数组**（不报错）——
  「列表为空」≠「视频没有字幕」，多半是 `need_login_subtitle` 登录门控；
  匿名可取的同源数据见 §2c（`dm/view`）
- 📚 登录后返回 `subtitle.subtitles[]`，每项含 `id / lan / lan_doc / subtitle_url / ai_type / ai_status`
- ⚠️ **非权威（non-authoritative）**：该接口无 WBI 签名。2026-08 有独立项目记录
  在风控降级时它可能返回 HTTP 200、`code = 0`、内容语法完全合法但**属于其他视频**
  的字幕（「AI 字幕张冠李戴」，见 adolescen-he/bilibili-video-transcriber 的 README）。
  本项目自身也未能在诊断中排除该来源（真实浏览器复现：同一视频连续提取结果漂移）。
- 因此 **v1.0.2 起本项目不再把该接口的结果作为最终答案**：它仅并发运行一个
  metadata-only 诊断探针，用于与可信接口对比与登录提示；其轨道标记
  `UNTRUSTED_LEGACY`，正文永不下载、永不成为 winner、永不进入可选取列表。

## 2b. WBI 签名与签名版 metadata（Strategy A'，v1.0.2 起首选）

### `GET https://api.bilibili.com/x/player/wbi/v2?aid=<AID>&cid=<CID>&wts=<ts>&w_rid=<md5>`

响应结构与 `x/player/v2` 相同（`data.subtitle.subtitles[]`）。签名协议（📚 prior art，
见文末 bilibili-API-collect 镜像文档，已由本项目确定性测试向量验证）：

- `GET https://api.bilibili.com/x/web-interface/nav` 返回 `data.wbi_img.img_url / sub_url`；
  **匿名（code -101）时同样携带**，文件名即 `img_key` / `sub_key`
- `mixin_key` = `img_key + sub_key` 按 64 位固定重排表 `MIXIN_KEY_ENC_TAB` 重排后取前 32 位
- 请求参数加入 `wts`（秒级时间戳），按 key 字典序排序、值去除 `!'()*` 后 URL 编码，
  拼接 `mixin_key` 取 MD5 得 `w_rid`
- 本项目实现：`src/core/md5.js`（自实现 MD5，RFC 1321 常量表硬编码并通过 RFC/Node
  crypto 双重向量验证）与 `src/core/wbi.js`（密钥缓存 TTL 15 分钟；`-352`/`-403`/HTTP 412
  视为签名失效：清缓存、重新 nav、**恰好重试一次**）
- ✅ 签名算法与社区参考的确定性向量一致（mixin_key 与 w_rid 均有固定测试用例）
- ✅ **已直接验证（2026-08-30，真实浏览器，登录态，单一案例）**：
  `/x/player/wbi/v2` 对当前视频（aid/cid 绑定）返回有效字幕轨；
  `subtitle_url` 成功下载字幕正文；signed-wbi resolver 成为 Winner；
  未签名 legacy 探针结果被 `UNTRUSTED_LEGACY` 标记且未被采用
  （证据：仓库 `docs/screenshots/resolver-diagnostics.png`）
- ⚠️ 匿名态下 `wbi/v2` 的完整行为（空列表语义）：仍待系统验证
- ⚠️ 不同账号 / B 站风控状态 / 浏览器与 userscript manager 组合：未系统验证
  （verified once ≠ universally verified）
- ⚠️ 请求头：沿用页面语义（GM 请求带 `Referer: https://www.bilibili.com/`，
  与浏览器原生行为一致）；有服务端项目称 WBI 接口不应带 Referer，与浏览器行为矛盾，
  待实测确认

## 2c. 匿名字幕通道（Strategy A2，v1.2.0 起）

### `GET https://api.bilibili.com/x/v2/dm/view?aid=<AID>&oid=<CID>&type=1`

- ✅ 本机验证（2026-11-19，匿名）：`code 0`，`data.subtitle.subtitles[]` 与
  `/x/player/v2` 同构（`id / id_str / lan / lan_doc / subtitle_url / type / ai_type / ai_status`）
- ✅ 关键差异：播放器字幕列表受 `need_login_subtitle` 门控，未登录时
  `/x/player/v2`、`/x/player/wbi/v2` 都返回空数组；`dm/view`（弹幕视图接口）同样
  返回 `subtitle` 块，但**不做这个门控**
- ✅ 覆盖度实测（2026-11-19，匿名，9 个分区榜单各取前 12 条，共 96 个视频 /
  100 条轨道）：`ai-zh` 58 条、自动翻译（`ai-en` 27、`ai-ja` 3、`ai-es/ar/pt/th/id` 各 2）
  40 条、人工 CC（`zh-Hans` / `zh-CN`）2 条；58 条 `ai-zh` 全部能下载正文
- ✅ **归属可由 URL 校验**：`ai-zh` 的 `subtitle_url` 形如
  `http://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/<aid><cid><hash>?auth_key=…`，
  对象路径开头就是 `aid` 与 `cid` 的拼接，其后是定长十六进制摘要（实测 32 位
  md5）。本项目的分类与处理：

  | 分类 | 判据 | 处理 |
  |---|---|---|
  | `verified` | `prod/` 路径的十进制前缀**恰好**等于 `aid+cid`，其后是一个完整摘要 | 采信，排序优先 |
  | `foreign` | `prod/` 路径的数字前缀属于别的 `aid+cid`（其他分 P，或其他视频） | **丢弃**（防止串 P / 串视频） |
  | `query` | 路径无 id（自动翻译 `prod/<digest>`、CC `bfs/subtitle/<sha1>.json`） | 采信，诊断标注「仅查询绑定」 |

- ⚠️ 该接口没有签名，属于「查询绑定」信任级别（`CURRENT_VIDEO_METADATA`，与 §3 同级）；
  正文 URL 仍是短期签名地址，同样不缓存，403/404 触发重取
- ⚠️ 未验证：风控降级时它是否也会返回其他视频的字幕。缓解手段是上表规则：`prod/`
  路径按摘要长度切分数字前缀后与 `aid+cid` 精确比对，跨分 P / 跨视频的 id 一律判
  `foreign` 丢弃；只有无 id 的自动翻译与 CC 文件无法从 URL 证明归属，按 `query`
  保留（它们由请求里的 `oid` 绑定）
- ⚠️ 2026-11-19 审计修正：早期实现用 `includes()` 在整个 URL 上找数字子串，cid 前缀
  相同（`400656` 与 `40065631429`）会误判 `verified`；完全不同的视频则因两个 id 都
  不出现而落入 `query` 被静默采信。v1.2.1 起改为按摘要长度精确切分与全等比较，
  并补了前缀碰撞、跨视频两类回归测试
- ⚠️ 96 个视频样本来自榜单（热门内容），长尾视频的命中率、`dm/view` 与播放器
  可见性是否永远一致：未验证

## 3. 新版字幕 metadata（Strategy B，Protobuf）

### `GET https://api.bilibili.com/x/v2/subtitle/web/view?oid=<CID>&pid=<AID>&type=1&context_ext={"video_type":1}&cur_production_type=0&playlist_switch=0`

- ✅ 匿名返回 `HTTP 200`，`Content-Type: application/octet-stream`，
  内容为 **2 字节 protobuf**：`0x0A 0x00`（顶层 field 1 = data，长度 0 = 空 data message）
- ✅ 参数非法时返回 JSON `{"code":-400,...}`（因此解析前先嗅探首字节）
- 📚 登录后 data message 内含 repeated 字段 3 = 字幕轨道

字段映射（本项目解析的唯一字段集合，未知字段一律跳过）：

```text
顶层
└── field 1 (length-delimited) = data message
    └── field 3 (repeated, length-delimited) = 字幕轨道
        ├── field 1 (varint)  = id
        ├── field 2 (string)  = id_str
        ├── field 3 (string)  = lan        例："ai-zh"、"zh-Hans"
        ├── field 4 (string)  = lan_doc    显示名，例："中文（AI）"
        ├── field 5 (string)  = subtitle_url（可能以 // 开头）
        └── field 8 (string)  = 标签（可选，本项目仅展示用）
```

依据：
- 📚 字段结构与真实登录态行为：[ccBilly-aipm/bilibili-ai-subtitle 的 FLOW 文档](https://github.com/ccBilly-aipm/bilibili-ai-subtitle/blob/main/docs/FLOW_CN.md)
  与 [JoeyTeng/bilibili-helper#4](https://github.com/JoeyTeng/bilibili-helper/pull/4)（该 PR 在真实 Chrome + Tampermonkey 环境验证了此端点为二进制响应）
- ✅ 「匿名返回空 data message 的 protobuf」为本机直接观测（`0x0A 0x00`）
- ⚠️ 登录态下实际返回的轨道内容、`preferred_language` 参数的效果：待浏览器验证
- 本项目独立实现了最小 wire-format 解码（`src/core/protobuf.js`），
  只解码上表字段，不引入 protobuf runtime

## 4. 字幕正文 JSON

字幕正文（无论来源）为 JSON：

```json
{ "body": [ { "from": 0.0, "to": 1.2, "content": "字幕文本" } ] }
```

- 📚 长视频 AI 字幕可能分段返回，需要按时间排序并去重
- 正文域名包括 `aisubtitle.hdslb.com`、`subtitle.bilibili.com`、`/bfs/subtitle/` 路径

## 5. 字幕 URL 生命周期

- 📚 `subtitle_url` 通常带短期 `auth_key` 签名参数；过期后返回 403/404
- 本项目因此：**不缓存签名 URL**；正文请求 403/404 时自动重新获取
  metadata（第二轮 discovery）再重试
- 日志与诊断中所有签名参数值一律遮蔽（`auth_key=***`）

## 6. 播放器行为（Strategy C 依据）

- 📚 播放器打开 CC/AI 字幕时会真实请求上述正文 URL，
  这些请求会出现在 `performance.getEntriesByType("resource")` 中
- 📚 播放器未开启字幕时，这些 URL 不会出现
- 本项目在页面 `document-end` 安装 `PerformanceObserver({buffered:true})`
  （可回放早于脚本启动的条目），事件驱动、无轮询；
  SPA 导航时清空捕获列表，避免上一部视频的 URL 污染当前视频
- ⚠️ 资源缓冲区仍可能包含**其他视频**的字幕 URL（合集/自动连播预加载、
  脚本更新后免刷新重注入时的整页回放）。因此 v1.0.1 起归属校验严格且无条件：
  捕获 URL 只有内嵌当前 `cid`（或单 P 视频内嵌当前 `aid`）才会被探测，
  其余一律拒绝并在诊断中说明；合并进面板轨道列表前再做一次同样的过滤。
  代价：不内嵌 aid/cid 的捕获 URL（个别人工 CC 可能如此）不再参与兜底。

## 7. 已知边界 / 未验证项

- ✅ signed-wbi 登录态路径已在真实浏览器验证一次（返回 `ai-zh` 轨道并完成正文提取，
  见 §2b）；⚠️ 完整策略链矩阵（多账号 / Strategy B `web-view` 的实际轨道内容 /
  匿名完整链路）仍待系统验证
- ⚠️ Firefox + Violentmonkey 的 `GM_xmlhttpRequest` `arraybuffer` 支持
  （Tampermonkey / Violentmonkey 均声称支持，未实测）
- ✅ v1.2.0 起匿名字幕通道（§2c）已验证，96 个榜单视频样本；长尾命中率与
  风控降级行为仍未验证
- ⚠️ 番剧页（`/bangumi/play/`）、国际化站、移动端页面：v1.0.0 明确不支持
- 本脚本不读取、不存储、不输出 Cookie；登录态由浏览器在请求时自动携带

## 8. 语音识别兜底（ASR，v1.1.0）

UP 主未开启 CC / AI 字幕时，§2–§3 的字幕接口只会返回空列表；但视频音轨仍然可取。
本项目因此新增一条与字幕无关的兜底链路：**音轨 → 必剪语音识别 → cues**。
整条链路**不需要登录、不读 Cookie、不接第三方服务**。

### 8.1 音轨：`GET /x/player/wbi/playurl`

- ✅ 本机验证（2026-11-19，匿名）：WBI 签名参数
  `avid` / `cid` / `fnval=4048` / `fnver=0` / `fourk=1` 返回 `data.dash.audio[]`，
  每项含 `id` / `baseUrl` / `bandwidth` / `mimeType` / `codecs`
- ✅ 实测音频 id：`30216`（66 kbps）/ `30232`（70 kbps）/ `30280`（86 kbps）；
  本项目固定优先 `30216`（语音识别足够、上传量最小），缺省时选最小带宽
- ✅ CDN 支持 `Range`：返回 `206` 与 `Content-Range: bytes 0-0/6156764`，
  因此采用 2 MiB 分片下载：真实进度、单分片失败只重试该片
- ⚠️ 匿名可取音轨是否覆盖所有视频（付费/互动/番剧/需要登录的清晰度）：未验证；
  取不到独立音轨时会给出明确提示而不是静默失败
- 音轨 URL 同样是短期签名 CDN 链接，**不缓存**

### 8.2 必剪（Bcut）语音识别

`https://member.bilibili.com/x/bcut/rubick-interface`，`model_id = 7`（中文 / 中英混合）：

| 步骤 | 请求 | 关键字段 |
|---|---|---|
| 申请上传 | `POST /resource/create`（form） | `type=2`、`name`、`size`、`resource_file_type=m4a`、`model_id=7` → `resource_id` / `in_boss_key` / `upload_id` / `upload_urls[]` / `per_size` |
| 上传分片 | `PUT upload_urls[i]` | 原始音频字节；响应头 `ETag` |
| 提交上传 | `POST /resource/create/complete`（form） | `in_boss_key`、`resource_id`、`etags`（逗号分隔）、`upload_id`、`model_id=7` → `download_url` |
| 创建任务 | `POST /task`（JSON） | `{"resource": download_url, "model_id": "7"}` → `task_id` |
| 查询结果 | `GET /task/result?model_id=7&task_id=…` | `state`：0 未开始 / 1 运行中 / 3 失败 / 4 完成；完成时 `result` 是 JSON 字符串 |

结果 JSON（`start_time` / `end_time` 单位为**毫秒**，与字幕 JSON 的秒不同）：

```json
{
  "utterances": [
    {
      "start_time": 0,
      "end_time": 1100,
      "transcript": "…",
      "words": [{ "label": "中", "start_time": 0, "end_time": 120 }]
    }
  ],
  "version": "1.2.0"
}
```

- ✅ 本机验证（2026-11-19，**匿名、无 Cookie、无 CSRF 参数**）：
  `create` / `complete` / `task` / `result` 全部返回 `code 0`
- ✅ 预签名上传 URL 给的是 `http://…biliapi.net`；改写为 `https://` 后 PUT 仍返回
  `200` + `ETag`（SigV4 只签 `host`，不含 scheme），因此本项目始终升级为 https
- ✅ 端到端实测：12 分 25 秒视频（音频 5.9 MB、2 个分片）→ `state=4`、
  357 条 utterances、约 7 秒（解析 + 下载 + 上传 + 识别）
- ✅ 上传的音频就是 DASH 的 `.m4s`（fragmented MP4）字节，**未转码**；
  以 `resource_file_type=m4a` 提交即可被识别
- ⚠️ **风控**：同一地址连续约 4 次完整流程后，`/task/result` 返回 `HTTP 412`，
  先是人机验证 HTML（响应头带 `x-sec-request-id`、`server: openresty`），
  之后带 `Origin` / `Sec-Fetch-*` 时变成 JSON `{"code":-412,"message":"request was banned"}`。
  同一时刻 `/resource/create`、`/task` 仍返回 `code 0`（`api.bilibili.com` 也正常），
  说明是**单端点、按地址/频次**的风控，而不是接口变更或全局封禁。
  本项目因此：显式点击才运行、轮询间隔从 1.5 s 逐步放慢到 6 s、总时长上限 10 分钟，
  并把 412 翻译成「先完成人机验证再重试」的提示。浏览器常态（携带 `buvid3` / `_uuid`
  等 Cookie，可能已登录）下的阈值未验证
- ⚠️ 服务端限流、并发上限、单任务时长上限、登录态是否表现不同：未验证
- ⚠️ 必剪属于 B 站内部业务接口，可能随时变化；失败时面板显示具体步骤与 code
  （`asr-bcut-create` / `asr-bcut-upload` / `asr-bcut-complete` / `asr-bcut-task` /
  `asr-bcut-result`）

### 8.3 归属与信任

- 音轨来自 **WBI 签名且 aid+cid 绑定** 的 `playurl`，所以「这段音频属于这个视频」
  由请求构造保证，而不是从响应内容推断（与 §2b 的思路一致）
- 生成轨道的 trust 为 `ASR_TRANSCRIPT`：可采信、参与 `isSelectableTrack`，
  但必须带 `contextKey = bvid:cid`；轨道自带 cues（没有 `subtitle_url`），
  与下载型轨道并列进入预览 / 导出 / 诊断
- 未签名 legacy 接口的 `UNTRUSTED_LEGACY` 规则不变：ASR 的存在不会让未采信来源
  变得可采信
- ASR 文本是**生成内容**，可能与视频原话有出入；面板与导出 JSON 都会标注
  `source: "asr"`，与 B 站官方字幕区分

## Prior art 依据清单

- [ccBilly-aipm/bilibili-ai-subtitle](https://github.com/ccBilly-aipm/bilibili-ai-subtitle)（MIT）：
  `/x/v2/subtitle/web/view` protobuf 字段结构、匿名空列表/登录可见行为、403 重取策略
- [JoeyTeng/bilibili-helper PR #4](https://github.com/JoeyTeng/bilibili-helper/pull/4)：
  真实 Chrome/Tampermonkey 环境验证该端点为二进制响应
- [YukinoAsuna/bilibili-subtitle-extractor](https://github.com/YukinoAsuna/bilibili-subtitle-extractor)：
  播放器资源捕获（aid/cid 匹配）思路
- [1494948/bilibili-ai-subtitle-forcer](https://github.com/1494948/bilibili-ai-subtitle-forcer)（MIT）：
  `x/v2/dm/view` 匿名通道与 `view/conclusion/get` 服务端生成队列的线索；§2c 的
  样本统计、`verified/foreign/query` 归属分级由本项目自行实测与实现
- [SocialSisterYi/bcut-asr](https://github.com/SocialSisterYi/bcut-asr)（MIT）：
  必剪 `/x/bcut/rubick-interface` 的 create → 分片上传 → complete → task → result 流程与
  字段名（§8 的接口形状依据；本项目用 JS 重新实现，并补测了「匿名可用」与「http→https 升级」）
- [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)（已关停）：
  历史社区文档，未直接引用
