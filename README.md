# bili-subtitle

> 弹性提取 Bilibili CC / AI 字幕的单文件 userscript。
> A resilient, zero-config Bilibili CC & AI subtitle userscript.

[English](#english) · 协议笔记见 [docs/PROTOCOL.md](docs/PROTOCOL.md)

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
策略链自动尝试：旧版 JSON API → 新版 Protobuf API → 播放器已加载资源
    ↓
成功提取，或给出精确诊断
```

用户不需要理解 `aid` / `cid` / `subtitle_url` / Protobuf / DevTools。

### 明确不做的事

- ❌ 不下载视频 / 音频，不调用任何 ASR / Whisper
- ❌ 不读取、不保存、不输出 Cookie（登录态由浏览器自动携带）
- ❌ 不上传任何数据，无 analytics / telemetry
- ❌ 不提供十种导出格式、批量下载、搜索中心（这些已有成熟项目，见下文）

**导出仅有**：复制纯文本、复制带时间轴文本、TXT、SRT、JSON。

## 安装 / Install

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome/Edge）或 [Violentmonkey](https://violentmonkey.github.io/)（Firefox）
2. 安装脚本：<https://raw.githubusercontent.com/ymt200120/bili-subtitle/main/bili-subtitle.user.js>
3. 打开任意 <https://www.bilibili.com/video/…> 页面，右下角出现「字幕」

## Resolver 架构 / Resolver architecture

```mermaid
flowchart TD
    A[点击「字幕」] --> B[VideoContext resolver<br/>__INITIAL_STATE__ → view API]
    B -->|失败| Z[精确诊断：哪个环节失败]
    B --> C[Strategy A: Legacy JSON<br/>x/player/v2]
    C -->|轨道 + 正文可用| OK[✓ 字幕]
    C -->|空列表 / 正文 403·404| D[Strategy B: Web Subtitle<br/>x/v2/subtitle/web/view · Protobuf]
    D -->|轨道 + 正文可用| OK
    D -->|空 / 失败| E[Strategy C: Player Resource<br/>PerformanceObserver 捕获]
    E -->|捕获 URL 可解析| OK
    E -->|无捕获| Z
    C -.正文 403/404 时.-> C2[自动重新获取 metadata 再试一轮]
```

要点：

- **Strategy B（Protobuf）不需要用户先手动打开 AI 字幕**——登录后脚本直接请求新版 metadata 接口并解析（匿名时该接口返回空 data message，诊断会提示「需要登录」）
- 签名字幕 URL 短期有效（403/404）：脚本**不缓存**，自动重取 metadata
- 播放器资源捕获是**最后兜底**，SPA 切换视频时清空，不会误用上一部视频的字幕
- 每一步的 ✓/✗/○ 都显示在面板「获取路径」中，Console 使用 `[bili-subtitle]` 前缀，签名参数一律遮蔽

诊断示例：

```text
✓ video-context · BV1BbKw6XEWq · cid 40065631429 · P1
✓ legacy-json · 字幕列表为空（AI 轨道通常需要登录）
✓ web-view · 1 条轨道
✓ web-view#fetch · 中文（AI） · 1342 条
```

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
- 日志（Console 与面板）中的短期签名参数一律遮蔽为 `***`
- 仅提取 B 站已提供给当前用户的字幕

## 验证状态 / Verification status

诚实声明，不做过度承诺：

| 层级 | 状态 |
|---|---|
| 单元测试（44 项：URL/字幕解析/SRT/Protobuf/策略链/日志脱敏） | ✅ `npm test` 全部通过 |
| 匿名接口行为（view API、player/v2 空列表、web/view 空protobuf） | ✅ 本机验证 2026-08-29，见 [docs/PROTOCOL.md](docs/PROTOCOL.md) |
| 登录态完整链路（重点：Strategy B 返回 ai-zh 轨道） | ⚠️ **需要浏览器验证**，协议依据见 PROTOCOL.md |
| Firefox + Violentmonkey 的 GM arraybuffer | ⚠️ 管理器声明支持，未实测 |

## 兼容性 / Compatibility

- 目标环境：Chrome + Tampermonkey；Firefox + Violentmonkey/Tampermonkey
- 匹配页面：`https://www.bilibili.com/video/*`、`/list/*`
- **不支持**：番剧页、移动端 m 站、国际化站
- `GM_xmlhttpRequest` 不可用时回退到页面内 `fetch`（部分场景可能受 CORS 限制，诊断会显示）

## 故障排查 / Troubleshooting

| 现象 | 诊断 | 处理 |
|---|---|---|
| 两个接口都显示「空轨道」 | 多数情况是未登录 | 登录 B 站后点「提取字幕」 |
| `legacy-json#fetch` 显示 HTTP 403/404 | 签名 URL 过期 | 脚本会自动重取；若仍失败，稍后重试 |
| `player-resource` 显示 ○（无捕获） | 播放器还没加载过字幕 | 在播放器打开「字幕/CC」选 AI 字幕，让字幕出现一次，再点「提取字幕」 |
| 面板不出现 | 脚本未注入 | 确认脚本管理器已启用且匹配当前页面 |
| 切换视频后字幕不对 | — | 不会发生：SPA 导航会重置全部状态；如遇异常请提 issue 附「获取路径」内容 |

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
├── core/                # 纯逻辑：日志脱敏/模型/URL/网络/protobuf/导出/诊断/SPA
├── resolvers/           # video-context · legacy · web-view · player-resource · pipeline
├── ui/panel.js          # 轻量面板
└── main.js              # 装配与导出动作
```

修改 `src/` 后运行 `npm run build` 重新生成安装文件；测试与构建共用同一拼接规则（`scripts/pack.mjs`）。

## 历史 / History

`docs/prototype/1.js` 是本项目 v1.0.0 之前的真实可运行原型（已在真实 B 站视频上验证过基础链路），现归档作参考，不参与构建。

## Acknowledgements / Prior Art

本项目的技术路径站在以下公开项目的肩膀上，特此致谢（均为独立实现，未复制源码）：

- [ccBilly-aipm/bilibili-ai-subtitle](https://github.com/ccBilly-aipm/bilibili-ai-subtitle)：`/x/v2/subtitle/web/view` Protobuf 字段结构与 403 重取策略（协议依据详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)）
- [JoeyTeng/bilibili-helper PR #4](https://github.com/JoeyTeng/bilibili-helper/pull/4)：真实 Chrome/Tampermonkey 环境对二进制 metadata 响应的验证
- [YukinoAsuna/bilibili-subtitle-extractor](https://github.com/YukinoAsuna/bilibili-subtitle-extractor)：播放器资源捕获思路
- [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)（已关停）：历史社区文档

本项目不是哔哩哔哩官方项目。仅处理当前用户有权访问的字幕内容，不负责字幕的重新分发；AI 字幕可能存在识别错误，请以视频原文为准。

## License

[MIT](LICENSE)

---

## English

A single-file userscript that extracts Bilibili CC & AI subtitles with automatic fallback:

```text
Legacy JSON API (x/player/v2)
  ↓ empty / expired?
Web Subtitle metadata API (x/v2/subtitle/web/view, protobuf)
  ↓ empty / failed?
Player resource capture (PerformanceObserver)
  ↓ failed?
Precise per-strategy diagnostics (✓ / ✗ / ○ with reasons and next steps)
```

- Zero configuration, no cookie access, no telemetry, no video/audio download, no ASR
- Signed subtitle URLs are never cached; 403/404 triggers automatic metadata re-fetch
- Player resource capture is cleared on SPA navigation (no cross-video contamination)
- Exports: copy plain text, copy timestamped text, TXT, SRT, JSON
- Only 4 formats by design — the value is resilience and diagnostics, not feature count

**Why another extractor?** Other projects already cover multi-format export, batch download, CLI, Chrome extensions and AI-agent workflows (see the table above). This project targets one narrow goal: a single userscript that follows Bilibili's shifting subtitle endpoints automatically and tells you exactly why when it cannot. It is not affiliated with Bilibili; it only reads subtitles already offered to the current user.

**Verification status:** 44 unit tests pass (`npm test`); anonymous endpoint behavior verified from a dev environment on 2026-08-29; the full logged-in path (especially the protobuf strategy) is **pending real-browser validation** — see [docs/PROTOCOL.md](docs/PROTOCOL.md) for protocol evidence and open items.

**Install:** <https://raw.githubusercontent.com/ymt200120/bili-subtitle/main/bili-subtitle.user.js>
