# 协议笔记 / Protocol notes

本文件记录 `bili-subtitle` 依赖的 Bilibili 接口行为、依据与不确定性。
所有「本机验证」均为 **2026-08-29 的匿名（未登录）请求**，来自开发环境。
登录态行为无法在本环境验证，已明确标注。

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
  「列表为空」≠「视频没有字幕」，很可能是登录门控
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
- ⚠️ 匿名 / 登录态下 `wbi/v2` 的实际返回（空列表语义、风控行为）：**待浏览器验证**
- ⚠️ 请求头：沿用页面语义（GM 请求带 `Referer: https://www.bilibili.com/`，
  与浏览器原生行为一致）；有服务端项目称 WBI 接口不应带 Referer，与浏览器行为矛盾，
  待实测确认

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

- ⚠️ 登录态下的完整策略链（重点：Strategy B 返回 `ai-zh` 轨道）
- ⚠️ Firefox + Violentmonkey 的 `GM_xmlhttpRequest` `arraybuffer` 支持
  （Tampermonkey / Violentmonkey 均声称支持，未实测）
- ⚠️ 番剧页（`/bangumi/play/`）、国际化站、移动端页面：v1.0.0 明确不支持
- 本脚本不读取、不存储、不输出 Cookie；登录态由浏览器在请求时自动携带

## Prior art 依据清单

- [ccBilly-aipm/bilibili-ai-subtitle](https://github.com/ccBilly-aipm/bilibili-ai-subtitle)（MIT）：
  `/x/v2/subtitle/web/view` protobuf 字段结构、匿名空列表/登录可见行为、403 重取策略
- [JoeyTeng/bilibili-helper PR #4](https://github.com/JoeyTeng/bilibili-helper/pull/4)：
  真实 Chrome/Tampermonkey 环境验证该端点为二进制响应
- [YukinoAsuna/bilibili-subtitle-extractor](https://github.com/YukinoAsuna/bilibili-subtitle-extractor)：
  播放器资源捕获（aid/cid 匹配）思路
- [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)（已关停）：
  历史社区文档，未直接引用
