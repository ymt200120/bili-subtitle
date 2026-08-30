# 发布与分发 / Publishing & Distribution

面向维护者的分发手册：GitHub Release、Greasy Fork 发布与同步策略。
本文不涉及 resolver 实现；协议细节见 [PROTOCOL.md](PROTOCOL.md)。

## 1. 发布节奏（release-oriented）

本项目依赖 B 站半公开接口，错误版本会直接影响真实用户，因此采用
**release-oriented** 分发，而不是 main 分支即发布：

```text
开发/修改 → npm test + 真实浏览器验证 → 版本号更新 + npm run build
        → push + GitHub Release → Greasy Fork 同步/发布
```

Greasy Fork 同步有两种可选模式：

- **Option A — 跟随 main 分支**：每次 push 都可能直接变成用户版本。快，但风险高。
- **Option B — 跟随 Release（推荐）**：只有完成浏览器验证的版本才进入 Greasy Fork。

本项目选择 **Option B**。若 Greasy Fork 配置了 GitHub 自动同步（导入源指向分支），
请在推送任何非发布性质的 main 提交前确认其不含 userscript 实质变化；
必要时可让 Greasy Fork 的导入源固定指向 release 资产而非分支。

## 2. Greasy Fork 初次发布

1. 登录 Greasy Fork →「发布你编写的脚本」→ 选择「从 GitHub 导入」或直接粘贴代码。
2. 导入源使用**分支 URL**（可持续同步，不要用具体 commit 的 raw URL）：

   ```text
   https://raw.githubusercontent.com/ymt200120/bili-subtitle/main/bili-subtitle.user.js
   ```

3. 简介可直接使用下文第 5 节的文案。
4. Greasy Fork 会为从它安装的副本重写 update/download URL，由其自行负责更新；
   GitHub Raw 的更新机制保留不冲突。不要写多个互相矛盾的 updateURL。
5. 合规自查（发布前确认）：
   - 代码未混淆/未压缩，保留可读变量名（本项目为源码拼接构建，天然满足）
   - 主要功能代码存在于发布脚本内（本项目为单文件完整实现，无远程加载）
   - 无外部代码依赖、无 analytics（零运行时依赖）
   - 文件体积 ≈ 70 KB，远低于 2 MB 限制
   - `@license MIT` 与仓库 LICENSE 一致

## 3. GitHub Release 步骤

```bash
# 在已验证的 commit 上打 tag（不要 tag 未经验证的 HEAD）
git tag -a v<VERSION> <TESTED_COMMIT> -m "bili-subtitle v<VERSION>"
git push origin v<VERSION>
```

然后在 GitHub → Releases → Draft a new release：

- 选择刚推送的 tag
- Title：`bili-subtitle v<VERSION>`
- Notes：基于 CHANGELOG 对应版本段落整理（不要写不存在的功能）
- 附件：上传该 tag 对应的 `bili-subtitle.user.js`
  （`git show v<VERSION>:bili-subtitle.user.js > bili-subtitle-v<VERSION>.user.js`），
  作为不可变的版本资产；README 中的安装链接仍指向 main 分支 raw 地址

## 4. 版本策略

- 只改文档/仓库元数据/模板：**不升 userscript 版本**。
- 改了 userscript metadata、`src/` 或构建产物：升 patch 版本，并在 CHANGELOG 中
  如实标注（例如 `Distribution / metadata`，不虚构 resolver 能力变化）。
- Greasy Fork 对同版本号但内容变化会警告，禁止「偷偷改代码不改版本号」。

## 5. Greasy Fork / 商店简介文案

### 中文简介

> 一个零配置的 Bilibili CC / AI 字幕提取 userscript。使用多级字幕解析策略
> （WBI 签名接口 → Protobuf 接口 → 播放器资源捕获），接口失效时自动回退；
> 每条字幕都绑定当前视频并通过信任校验，失败时给出精确诊断。
> 支持复制、TXT、SRT 和 JSON 导出。不读取 Cookie，无 telemetry。

### English summary

> A zero-config userscript that extracts Bilibili CC / AI subtitles. It walks a
> resolver chain (WBI-signed API → protobuf API → player resource capture) with
> automatic fallback; every subtitle is bound to the current video and checked
> against a trust model, with precise per-run diagnostics on failure.
> Exports: copy, TXT, SRT, JSON. No cookie access, no telemetry.

避免「最强 / 永久可用 / 100% 成功」类表述；未验证的能力（如登录态完整链路）
如实标注。

## 6. 截图

发布页配一张真实 UI 截图会显著降低理解成本。请从真实浏览器截取（不要伪造），
建议内容：面板打开且提取成功、可见「获取路径」诊断块。放入 `docs/screenshots/`
后在此处与 README 引用。
