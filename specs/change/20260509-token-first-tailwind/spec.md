---
id: 20260509-token-first-tailwind
name: Token First Tailwind
status: designed
created: '2026-05-09'
---

## Overview

### Problem Statement

- 当前前端样式集中在 `index.css`，贡献者改 UI 时容易集中修改同一个全局 CSS 文件，增加代码冲突概率。
- 项目已经有 CSS variable token 体系，需要把它作为视觉源头接入 Tailwind，让贡献者主要在 TSX 中用 Tailwind utilities 表达样式。
- 重构过程中需要保持现有前端展示稳定，尤其是整体页面风格和视觉调性。

### Goals

- 实现 token-first Tailwind：Tailwind 作为样式书写和组合工具，视觉 token 继续来自现有 CSS variables。
- 将现有 TSX 中依赖全局 CSS class 的组件样式迁移为 token-first Tailwind `className`，减少日常改动对 `index.css` 的依赖。
- 降低多人贡献时由全局 CSS 热点文件引起的冲突概率。
- 保持现有页面风格、明暗主题、暖色纸感调性和整体展示效果稳定。
- 建立可重复的 agent 视觉对比验证：每个开发 worktree 和基线 worktree 分别启动一套 web/daemon，由配备 agent-browser CLI 与 Chrome DevTools MCP 的 agent 对比两个服务中的前端展示，确认重构前后视觉效果一致且展示方式不漂移。

### Scope

- 接入 Tailwind，并将现有设计 token 映射为可用的 Tailwind token classes。
- 保留 `index.css` 中的基础 token、全局基础样式和必须全局管理的内容样式。
- 建立约束，让贡献者优先使用项目 token 和基础 UI primitives。
- 本次保持现有组件抽象；在现有 TSX 中把可迁移的全局 CSS class 全量替换为 token-first Tailwind class。
- 采用分批落地方式，先完成工具链、token 映射和约束，再按区域迁移现有 TSX class，并保留必须全局管理的样式。

### Constraints

- 迁移期间前端展示不能漂移，整体页面风格保持一致。
- 全量迁移以现有视觉等价为准，迁移粒度按页面/组件区域分批推进。
- Tailwind 接入验证和迁移在现有组件内完成，组件抽象保持现状。
- `index.css` 继续承载全局 token 和基础样式，视觉源头保持为项目 CSS variables。

### Success Criteria

- Baseline：迁移开始时记录 `apps/web/src/index.css` 当前约 16,038 行、1,415 个 CSS class selectors，`apps/web/src/**/*.tsx` 当前约 51 个文件、2,126 个 `className=` occurrences；最终 PR 需要在 implementation notes 中刷新这些数字。
- TSX 迁移目标：可替换的组件级全局 class 按 PR slice 迁移完成，每个 slice 的 migrated / retained / deferred class 清单完整记录；最终 slice 后普通组件 UI 改动路径以 TSX Tailwind utilities 为主。
- `index.css` 保留目标：最终只保留 tokens、base、keyframes、loading shell、内容级/第三方边界样式和明确记录的 retained global styles；组件级 retained global class 需要逐项说明原因和后续处理点。
- Guard 目标：默认 Tailwind palette utilities 和未登记硬编码 app UI colors 在 `pnpm guard` 中失败；每个 allowlist entry 包含 file scope、pattern scope 和 reason。
- 视觉一致性验收目标：每个开发 worktree 与基线 worktree 各启动一套独立 web/daemon 服务，agent 使用 agent-browser CLI 和 Chrome DevTools MCP 在两个服务间对比同一页面、同一 viewport、同一 theme/accent 状态和同一 fixture data；覆盖 Dashboard/app shell、project detail、settings dialog、file viewer/inspect overlay、sketch editor、live artifact card、modal/popover/control states 在 light、dark、system 和 custom accent 下的展示，确认重构前后视觉效果一致、前端展示方式不漂移；任一布局偏移、token 颜色漂移、radius/shadow 差异或主题状态差异都需要修复或记录为批准 deviation。

## Research

### Existing System

- `apps/web` 的全局 CSS 入口是 Next root layout 中的 `../src/index.css` import。Source: `apps/web/app/layout.tsx:1-4`
- 产品主体通过 `dynamic(() => import('../../src/App'), { ssr: false })` 作为客户端 SPA 运行，loading shell 仍依赖全局 class `od-loading-shell`。Source: `apps/web/app/[[...slug]]/client-app.tsx:5-13`
- `apps/web` 当前依赖包含 Next、React、React DOM 和测试工具，未在 `dependencies` / `devDependencies` 中声明 Tailwind、PostCSS 或 Autoprefixer。Source: `apps/web/package.json:30-50`
- 根 package 只保留仓库级工具脚本和 TypeScript/tsx dev dependencies，未在 root devDependencies 中声明 Tailwind/PostCSS 相关包。Source: `package.json:12-29`
- 当前视觉源头集中在 `apps/web/src/index.css` 的 CSS variables：surface、border、text、accent、semantic colors、shadow、radius、font tokens 都在 `:root` 定义。Source: `apps/web/src/index.css:6-63`
- 暗主题通过 `[data-theme="dark"]` 覆盖同一批 token，系统模式通过 `@media (prefers-color-scheme: dark)` 和 `html:not([data-theme])` 覆盖 token。Source: `apps/web/src/index.css:65-157`
- 基础 reset、body 字体/背景/文字颜色和 loading shell 都在 `index.css` 中全局定义。Source: `apps/web/src/index.css:160-181`
- `index.css` 同时承担组件样式职责，例如 button base、primary、ghost 变体等全局选择器。Source: `apps/web/src/index.css:183-219`
- `index.css` 也承载全局 animation 和复杂组件区域样式，例如 settings modal keyframes 和 live artifact badge/card 样式。Source: `apps/web/src/index.css:1121-1143,6219-6299`
- 现有 TSX 通过大量语义化全局 class 连接到 `index.css`，全量迁移需要按功能区域把这些 class 的视觉语义内联为 token-first Tailwind utilities，同时把确需跨树生效的 loading shell、keyframes 和内容级样式留在全局 CSS。Source: `apps/web/src/index.css:183-219,1121-1143,6219-6299`; `apps/web/src/runtime/markdown.tsx:112-196`; `apps/web/src/components/SketchEditor.tsx:220-339`; `apps/web/src/components/pet/PetRail.tsx:58-170`
- 运行时支持用户自定义 accent color：`applyAppearanceToDocument()` 会向 `document.documentElement` 写入 `--accent*` CSS variables，且 mix ratios 要和 pre-hydration script 保持一致。Source: `apps/web/src/state/appearance.ts:17-25,28-52`; `apps/web/app/layout.tsx:21-29`
- 本仓库本地 web runtime 应通过 `pnpm tools-dev run web --daemon-port <port> --web-port <port>` 启动，端口由 `--daemon-port` 和 `--web-port` 控制，因此开发 worktree 与基线 worktree 可以使用不同端口同时运行各自的 web/daemon。Source: `AGENTS.md:40-45,82-89,91-104`

### Available Approaches

- Tailwind CSS v4 的 Next.js 官方接入路径使用 `tailwindcss`、`@tailwindcss/postcss`、`postcss`，PostCSS 配置加载 `@tailwindcss/postcss`，CSS 中使用 `@import "tailwindcss"`。Source: `https://tailwindcss.com/docs/guides/nextjs`; `https://tailwindcss.com/docs/installation/using-postcss`
- Tailwind CSS v4 支持 CSS-first theme variables，`@theme` 中的 `--color-*` namespace 会生成 `bg-*`、`text-*`、`border-*` 等颜色 utilities。Source: `https://tailwindcss.com/docs/theme`; `https://tailwindcss.com/docs/customizing-colors`
- Tailwind CSS v4 可以通过 `--color-*: initial` 清空默认颜色 namespace，再只声明项目 token 对应的 color variables。Source: `https://tailwindcss.com/docs/customizing-colors`
- Tailwind CSS v3 的主题颜色配置主要通过 `tailwind.config.js` / `theme.colors` 完成；v4 官方文档把主题值迁移到 CSS theme variables。Source: `https://v3.tailwindcss.com/docs/theme`; `https://tailwindcss.com/docs/upgrade-guide`
- 仓库现有 `guard` 机制已经以 TypeScript 脚本形式聚合检查，并在失败时设置非零 exit code，可扩展为 token/Tailwind 约束检查入口。Source: `scripts/guard.ts:6-9,401-422`
- Web 测试位于 `apps/web/tests/`，已有组件、runtime、state、provider 等 Vitest 覆盖，适合承载新工具函数和样式约束的轻量测试。Source: `apps/AGENTS.md:19-24`; `apps/web/package.json:23-29`
- 视觉一致性验证可以由具备浏览器自动化能力的 agent 对比两套本地服务：基线 worktree 运行迁移前代码，开发 worktree 运行当前 slice 代码，agent 在同一 scenario、viewport、theme/accent 和 fixture data 下检查两个服务的展示一致性。Source: `AGENTS.md:40-45,82-89,91-104`; `apps/web/src/index.css:65-157`; `apps/web/src/state/appearance.ts:28-52`

### Alternatives Considered

- Keep CSS variables plus CSS Modules or component-scoped CSS: this preserves the current token source and reduces selector leakage, while continuing to require a separate stylesheet edit path for most UI changes. The chosen path keeps CSS variables as the visual source and moves component composition into TSX where contributors already edit behavior.
- Introduce a smaller project utility layer without Tailwind: a custom utility layer could expose only approved tokens, while the team would own naming, variants, responsive states, editor tooling expectations, and guard behavior. Tailwind v4 provides the utility compiler and variant system while still allowing the project to clear the default color namespace.
- Use Tailwind with a JS config or compatibility layer: a JS config can centralize theme values, while this repository's TypeScript-first guard and Tailwind v4 CSS-first model favor `@theme` values colocated with existing CSS variables. The PostCSS `.mjs` entry remains a narrow tool compatibility file and must be explicitly allowlisted.
- Extract shared UI primitives before class migration: primitives would reduce repeated class strings, while they would also turn this spec into a component architecture migration. This plan keeps current component boundaries, migrates visual expression first, and leaves primitive extraction as a later refactor once token utilities are stable.

### Constraints & Dependencies

- 迁移必须遵守 app 测试目录边界：`apps/web` 测试放在 `apps/web/tests/`；本 spec 的视觉一致性验证由 agent 对比两套本地服务完成，作为开发验收流程记录在 phase notes 中。Source: `apps/AGENTS.md:19-24`; `AGENTS.md:82-89`
- 双 worktree 对比需要为基线和开发 worktree 分配独立 daemon/web 端口；`tools-dev` 支持通过 flags 显式指定这两类端口。Source: `AGENTS.md:40-45,82-89,91-104`
- Root command boundary 保留 `pnpm guard`、`pnpm typecheck` 等仓库级检查；web 验证使用 package-scoped 命令。Source: `AGENTS.md#Root command boundary`; `apps/AGENTS.md:39-51`
- 添加 Tailwind/PostCSS 依赖或配置会改变 package manifest / build entry，需要运行 `pnpm install` 让 workspace links 和 lockfile 保持一致。Source: `AGENTS.md#Validation strategy`; `apps/web/package.json:23-29`
- 当前存在合理硬编码色值场景：Agent 品牌图标使用品牌渐变和 SVG 颜色；Sketch canvas 使用用户绘图颜色和画布绘制颜色；FileViewer `rgbToHex()` 面向用户内容颜色转换。Source: `apps/web/src/components/AgentIcon.tsx:46-99`; `apps/web/src/components/SketchEditor.tsx:72,144-149`; `apps/web/src/components/FileViewer.tsx:1448-1474`
- 当前也存在可治理的 token 偏离：`NewProjectPanel` SVG preview 使用与现有 token 值相同或相近的硬编码色；`SettingsDialog` 局部 inline styles 使用旧 token fallback。Source: `apps/web/src/components/NewProjectPanel.tsx:797-825`; `apps/web/src/components/SettingsDialog.tsx:3807-3953`
- `index.css` 中仍有组件状态色使用具体 hex/rgba，例如 live artifact refreshing/failed badge 使用蓝/红硬编码色；这类样式迁移前需要先区分状态 token、品牌色、用户内容色和一次性插画色。Source: `apps/web/src/index.css:6270-6288`

### Key References

- `apps/web/app/layout.tsx:1-44` - web layout、CSS import、pre-hydration theme/accent script。
- `apps/web/app/[[...slug]]/client-app.tsx:1-17` - client-only App 入口和 loading shell class。
- `apps/web/src/index.css:1-219,1121-1143,6219-6299` - token、base、global component styles、keyframes、live artifact styles。
- `apps/web/src/state/appearance.ts:1-52` - runtime theme/accent CSS variable 写入。
- `apps/web/package.json:23-50` - web scripts and dependency surface。
- `AGENTS.md:40-45,82-89,91-104` - tools-dev 本地 lifecycle、web/daemon 端口和验证命令边界。
- `scripts/guard.ts:138-151,205-221,328-350,401-422` - existing guard shape and failure behavior。
- `apps/AGENTS.md:19-24,39-51` - app test/layout and validation boundaries。
- `specs/change/20260509-token-first-tailwind/token.md` - Tailwind color/radius/shadow token vocabulary, existing CSS variable mapping, native font/spacing/type decision, and guardrail target。
- `https://tailwindcss.com/docs/guides/nextjs` - Tailwind v4 Next.js setup。
- `https://tailwindcss.com/docs/theme` - Tailwind v4 CSS-first theme variables and namespaces。

## Design

### Change Scope

- 范围：`apps/web` 样式工具链。影响：在 web package 边界添加 Tailwind v4/PostCSS 依赖和配置，因为 `@open-design/web` 拥有 `dev/build/typecheck/test` 脚本，当前尚未声明 Tailwind/PostCSS 依赖。Source: `apps/web/package.json:23-50`; `https://tailwindcss.com/docs/guides/nextjs`
- 范围：`apps/web/src/index.css`。影响：保留 CSS variables、dark/system 主题覆盖、reset、body 样式、loading shell、keyframes 和真正全局的内容样式；在同一入口加入 Tailwind import/theme 层，让现有 `layout.tsx` import 继续作为唯一全局 CSS 入口，并移除已经迁移到 TSX 的组件级全局 class。Source: `apps/web/app/layout.tsx:1-4`; `apps/web/src/index.css:6-181,1121-1143,6219-6299`
- 范围：现有 `apps/web/src/**/*.tsx`。影响：按页面/组件区域迁移可替换的全局 CSS class 到 token-first Tailwind `className`，保持 DOM 结构和组件职责稳定。Source: `apps/web/src/index.css:183-219`; `apps/web/src/**/*.tsx`
- 范围：token 映射。影响：把现有颜色、圆角和阴影 CSS variables 暴露成 Tailwind theme variables，同时保留运行时写入同一批 `--accent*` variables 的自定义 accent 行为；字体、间距和字号使用 Tailwind 原生 utilities。Source: `apps/web/src/index.css:6-63`; `apps/web/src/state/appearance.ts:17-52`; `apps/web/app/layout.tsx:21-29`; `specs/change/20260509-token-first-tailwind/token.md`; `https://tailwindcss.com/docs/theme`
- 范围：约束机制。影响：扩展 repository guard，显式检查默认 Tailwind palette classes 和未受控硬编码颜色，并为品牌/用户内容场景提供 allowlist。Source: `scripts/guard.ts:138-151,205-221`; `apps/web/src/components/AgentIcon.tsx:46-99`; `apps/web/src/components/SketchEditor.tsx:72,144-149`; `apps/web/src/components/FileViewer.tsx:1448-1474`
- 范围：测试与验证。影响：web 自有测试放在 `apps/web/tests/`；通过 `pnpm guard`、`pnpm typecheck`、`pnpm --filter @open-design/web test` 和 `pnpm --filter @open-design/web build` 验证。Source: `apps/AGENTS.md:19-24,39-51`; `AGENTS.md#Validation strategy`
- 范围：agent 视觉一致性验证。影响：每个开发 slice 使用基线 worktree 与开发 worktree 分别启动一套 web/daemon；agent 通过 agent-browser CLI 和 Chrome DevTools MCP 对比两个服务中的同一场景，验证重构前后前端展示一致。Source: `AGENTS.md:40-45,82-89,91-104`; `apps/web/src/index.css:65-157`; `apps/web/src/state/appearance.ts:28-52`

### Design Decisions

- 决策：在 `apps/web` 使用 Tailwind CSS v4，依赖 `tailwindcss`、`@tailwindcss/postcss` 和 `postcss`，通过 PostCSS 配置，并在现有全局 CSS 入口使用 `@import "tailwindcss"`。Source: `apps/web/package.json:23-50`; `apps/web/app/layout.tsx:1-4`; `https://tailwindcss.com/docs/guides/nextjs`
- 决策：通过 CSS 中的 `@theme` 定义 Tailwind theme values，因为 v4 会把 `--color-*` theme variables 转成 `bg-*`、`text-*`、`border-*` 等 utilities。Source: `https://tailwindcss.com/docs/theme`; `https://tailwindcss.com/docs/customizing-colors`
- 决策：把 Tailwind 颜色 tokens 映射到现有运行时 CSS variables，例如 `--color-bg: var(--bg)`、`--color-panel: var(--bg-panel)`、`--color-accent: var(--accent)`、`--color-danger: var(--red)` 和 `--color-success: var(--green)`。Source: `apps/web/src/index.css:6-63`; `apps/web/src/state/appearance.ts:17-52`; `specs/change/20260509-token-first-tailwind/token.md`
- 决策：声明项目颜色前，用 `--color-*: initial` 清空默认 Tailwind color namespace，让项目 classes 表达 Open Design token 集合。Source: `https://tailwindcss.com/docs/customizing-colors`; `apps/web/src/index.css:6-49`
- 决策：主题状态和自定义 accent 行为保持 CSS-variable-first；Tailwind utilities 通过 variables 解析，自动继承 light/dark/system/user accent 变化。Source: `apps/web/src/index.css:65-157`; `apps/web/src/state/appearance.ts:28-52`; `apps/web/app/layout.tsx:21-29`
- 决策：`index.css` 继续负责 token 定义、reset、基础元素行为、loading shell、keyframes 和跨内容区域样式；本次保持现有组件抽象，在现有 TSX 内全量迁移可替换的组件级全局 class 为 token-first Tailwind class。Source: `apps/web/src/index.css:160-219,1121-1143,6219-6299`; `apps/web/app/[[...slug]]/client-app.tsx:5-13`
- 决策：在 `scripts/guard.ts` 内添加项目自有样式约束检查，沿用现有 guard 聚合模型和 root command boundary。Source: `scripts/guard.ts:138-151,205-221,401-422`; `AGENTS.md#Root command boundary`
- 决策：品牌资产、SVG 插画、canvas/用户内容颜色和颜色转换 helper 允许显式例外；app UI chrome 使用 token classes 或 CSS variables。Source: `apps/web/src/components/AgentIcon.tsx:46-99`; `apps/web/src/components/SketchEditor.tsx:72,144-149`; `apps/web/src/components/FileViewer.tsx:1448-1474`
- 决策：项目自定义 Tailwind token 覆盖颜色、radius 和 shadow；radius/shadow utilities 解析到现有 CSS variables，确保卡片、弹窗、模态、输入、按钮和暗主题 shadow override 保持当前视觉；font、spacing 和 typography scale 使用 Tailwind 原生 utilities。Source: `specs/change/20260509-token-first-tailwind/token.md`
- 决策：添加依赖或配置相关 package 变更后运行 `pnpm install`，再执行 package-scoped web 验证和 repo 检查。Source: `AGENTS.md#Validation strategy`; `apps/web/package.json:23-29`
- 决策：迁移验收采用双 worktree agent 对比；每个迁移 PR 都让基线 worktree 和开发 worktree 同时运行独立 web/daemon，agent 在两个服务间检查同一场景的视觉一致性，发现展示漂移时修复样式或把差异记录为批准 deviation。Source: `AGENTS.md:40-45,82-89,91-104`; `apps/web/src/index.css:65-157`; `apps/web/src/state/appearance.ts:28-52`

### Why this design

- 视觉事实继续由现有 CSS variables 承载，因此 light/dark/system 主题和自定义 accent 行为保持稳定，同时 Tailwind 成为组件级组合语言。
- 现有 TSX 的组件级样式迁移到 Tailwind class 后，日常 UI 改动主要落在局部组件文件，减少全局 CSS 热点冲突。
- 贡献者获得受约束的 Tailwind 词汇表，词汇表直接匹配产品的暖色纸感视觉语言。
- Tailwind 基础能力先落地，再通过 guardrails 和按区域迁移完成全量 TSX class 替换，降低样式重构风险。
- 双 worktree agent 对比把“视觉等价”变成可复跑的迁移门禁，人工 review 聚焦在批准 deviation 和产品判断。

### Test Strategy

- 工具链：运行 `pnpm install`，再运行 `pnpm --filter @open-design/web build`，证明 Next/Tailwind/PostCSS 集成可编译。Source: `apps/web/package.json:23-29`; `AGENTS.md#Validation strategy`
- 类型安全：配置和 TS guard 变更后运行 `pnpm typecheck` 和 `pnpm --filter @open-design/web typecheck`。Source: `AGENTS.md#Validation strategy`; `apps/AGENTS.md:39-51`
- 约束机制：为禁用默认 palette classes 和硬编码 UI 颜色添加/扩展 guard 覆盖，用 `pnpm guard` 验证。Source: `scripts/guard.ts:138-151,205-221,401-422`
- Web 测试：新增 style-policy helper logic 时，在 `apps/web/tests/` 下添加聚焦的 Vitest 覆盖。Source: `apps/AGENTS.md:19-24`; `apps/web/package.json:23-29`
- Agent 视觉一致性验证：在基线 worktree 和开发 worktree 中分别运行 `pnpm tools-dev run web --daemon-port <port> --web-port <port>`；agent 使用 agent-browser CLI 和 Chrome DevTools MCP 对比两个服务中的主要页面/组件区域、固定 viewport、light/dark/system theme 和 custom accent。Source: `AGENTS.md:40-45,82-89,91-104`; `apps/web/src/index.css:65-157`; `apps/web/src/state/appearance.ts:28-52`
- 人工视觉复核：结合 agent 对比记录检查 Dashboard/app shell、project detail、settings dialog、file viewer/inspect overlay、sketch editor、live artifact card、modal/popover/control states，批准 deviation 必须进入 implementation notes。

### File Structure

- `apps/web/package.json` - 在 web package 边界添加 Tailwind/PostCSS dependencies。
- `apps/web/postcss.config.mjs` - 配置 Tailwind v4 PostCSS plugin；该文件需要在 residual JavaScript guard 中用精确路径 allowlist，因为 PostCSS 配置加载器消费 `.mjs` 配置入口。
- `apps/web/src/index.css` - 保留全局 tokens/base styles，并添加 Tailwind import/theme aliases。
- `specs/change/20260509-token-first-tailwind/token.md` - 记录 Tailwind color/radius/shadow token 命名、与现有 CSS variables 的对应关系，以及 font/spacing/type 使用 Tailwind 原生 utilities 的设计决策。
- `apps/web/src/**/*.tsx` - 将可迁移的全局 CSS class 全量替换为 token-first Tailwind class。
- `scripts/guard.ts` - 给现有 repo guard 添加 PostCSS config residual JavaScript allowlist 和 style policy checks。
- `apps/web/tests/` - 抽取 style policy helpers 时添加聚焦测试。
- `phase*-notes.md` - 每个 PR slice 记录双 worktree 服务地址、agent 对比覆盖场景、发现的视觉漂移和批准 deviations。

### Edge Cases

- Custom accent color 会更新 Tailwind 派生的 accent utilities，因为 utilities 通过 `var(--accent*)` 解析。
- Dark/system mode 继续工作，因为 token values 仍由 `[data-theme="dark"]` 和 `html:not([data-theme])` media overrides 提供。
- Brand icons、用户 sketch colors、canvas drawing colors 和 file color conversion helpers 需要显式 allowlist 处理。
- Loading shell 保持全局，因为它在 client SPA component tree 可用前渲染。
- 现有长尾全局 CSS 需要分类处理：组件级样式迁移到 TSX，loading shell、keyframes、第三方/内容渲染边界和真正跨树样式继续保留全局。

### Guardrail Rules

Guard 需要覆盖三类规则，并为每个例外记录文件范围、匹配模式和理由。

1. 默认 Tailwind palette class 检查：在 app UI 文件中拒绝 `text-red-500`、`bg-white`、`border-zinc-200`、`from-orange-500`、`ring-blue-400` 等默认 palette utilities。允许的颜色 utility 来自 `token.md` 中 `@theme` 暴露的项目 token。
2. 硬编码 UI color 检查：在 app UI chrome 和组件样式中拒绝未登记的 `#hex`、`rgb()`、`rgba()`、`hsl()`、`hsla()` 和真实命名色。CSS-wide/special keywords `transparent`、`currentColor` / `currentcolor`、`inherit`、`initial`、`unset` 和 `revert` 表达透明、继承或 reset 语义，guard 应显式豁免或按属性语义处理；命中真实未登记颜色后优先迁移到 Tailwind token class 或 CSS variable；重复出现的任意色需要新增命名 token。
3. 显式 allowlist 检查：允许品牌资产、SVG 插画、用户 accent 输入、canvas/sketch 用户色、文件/inspect 用户内容颜色转换、external document/iframe/popup runtime HTML、测试 fixture。allowlist 需要尽量窄，按文件、函数或 pattern 标注原因，避免路径级豁免覆盖普通 UI chrome。

### Open Questions

| Question | Resolution point |
| --- | --- |
| Exact style guard allowlist entries and path/pattern scopes | Phase 1 before strict guard lands |
| Exact dual-worktree port assignments, scenario matrix, and agent comparison note format | Phase 1 before Phase 2 merges |
| Final retained global CSS inventory | Phase 6 |
| Dynamic class handling policy for each migrated component | During each phase before replacing dynamic class composition |
| Threshold for promoting repeated arbitrary colors to named tokens | Phase 1; default policy is promotion after the second real app UI use |
| Deferred component areas | Before Phase 6 |

## Plan

Each phase maps to one PR. Every PR must be reviewable on its own, keep business logic stable, and include a migrated / retained / deferred class inventory for its slice. Rollback is handled by reverting the PR.

### Phase 1: Foundation PR

Goal: add Tailwind v4 infrastructure, expose Open Design tokens as Tailwind utilities, and land the first style guard scaffolding.

- [ ] Step 1: 安装 Tailwind 基础能力
  - [ ] Substep 1.1 Implement: 向 `apps/web/package.json` 添加 Tailwind v4/PostCSS dependencies。
  - [ ] Substep 1.2 Implement: 为 `@tailwindcss/postcss` 添加 web-local PostCSS config。
  - [ ] Substep 1.3 Implement: 在 `scripts/guard.ts` 的 residual JavaScript 精确 allowlist 中加入 `apps/web/postcss.config.mjs`，并用注释说明 PostCSS/Tailwind 配置入口需要 `.mjs` 兼容格式，保持 `pnpm guard` 覆盖计划内配置文件。
  - [ ] Substep 1.4 Implement: 在 `apps/web/src/index.css` 中 import Tailwind，同时保留现有全局入口行为。
  - [ ] Substep 1.5 Verify: 运行 `pnpm install`。
  - [ ] Substep 1.6 Verify: 运行 `pnpm guard`，确认 PostCSS config allowlist 生效。
  - [ ] Substep 1.7 Verify: 运行 `pnpm --filter @open-design/web build`。
- [ ] Step 2: 把 Open Design tokens 暴露为 Tailwind utilities
  - [ ] Substep 2.1 Implement: 为 colors、core semantic status、selection/inspect overlays、radius 和 shadow tokens 添加 CSS-first `@theme` aliases；font、spacing 和 typography scale 使用 Tailwind 原生 utilities。
  - [ ] Substep 2.2 Implement: 清空默认 Tailwind colors，并声明项目批准的 color namespace。
  - [ ] Substep 2.3 Implement: 在 theme block 附近记录 token class vocabulary。
  - [ ] Substep 2.4 Verify: 确认 light、dark、system 和 custom accent modes 都通过同一套 CSS variables 解析。
  - [ ] Substep 2.5 Verify: 运行 `pnpm --filter @open-design/web build`。
- [ ] Step 3: 添加基础样式 guardrails
  - [ ] Substep 3.1 Implement: 在 `scripts/guard.ts` 中添加 app UI code 默认 Tailwind palette classes 检查。
  - [ ] Substep 3.2 Implement: 添加硬编码 UI color 检查，覆盖 `#hex`、`rgb()`、`rgba()`、`hsl()`、`hsla()` 和命名色。
  - [ ] Substep 3.2a Implement: 在命名色检查中豁免 CSS-wide/special keywords，例如 `transparent`、`currentColor` / `currentcolor`、`inherit`、`initial`、`unset` 和 `revert`，让 ghost button、SVG current-color 和继承/reset 状态按语义通过。
  - [ ] Substep 3.3 Implement: 添加显式 allowlist 机制，覆盖 brand assets、SVG illustrations、user accent input、canvas/sketch user colors、user-authored file/inspect colors、external runtime documents 和 tests/fixtures。
  - [ ] Substep 3.4 Implement: 需要抽取 helper 时，在 `apps/web/tests/` 下添加聚焦测试；测试 fixtures 必须覆盖 `transparent`、`currentColor` / `currentcolor`、`inherit`、`initial`、`unset` 和 `revert` 通过，以及真实未登记 named colors 失败。
  - [ ] Substep 3.5 Verify: 运行 `pnpm guard`。
  - [ ] Substep 3.6 Verify: 故意在一个 TSX 文件中临时写入默认 Tailwind 原生颜色 class（例如 `text-red-500`），确认 `pnpm guard` 能检出并失败，然后移除临时代码。
  - [ ] Substep 3.7 Verify: 故意在普通 app UI TSX 中临时写入未 allowlist 的硬编码色（例如 `style={{ color: '#ff0000' }}`），确认 `pnpm guard` 能检出并失败，然后移除临时代码。
  - [ ] Substep 3.8 Verify: 运行 `pnpm --filter @open-design/web test`。
- [ ] Step 4: 建立迁移清单和 agent 视觉对比准备
  - [ ] Substep 4.1 Implement: 生成 `apps/web/src/**/*.tsx` 中引用的全局 CSS class 清单，并映射到 `apps/web/src/index.css` 中的定义。
  - [ ] Substep 4.2 Implement: 将 class 分为组件级可迁移样式、全局基础样式、loading shell、keyframes/animation、内容级/第三方边界样式和需保留例外。
  - [ ] Substep 4.3 Implement: 为每个组件级 class 记录对应 token-first Tailwind utility 组合或迁移备注。
  - [ ] Substep 4.4 Implement: 明确 style guard allowlist entries、path/pattern scopes、重复 arbitrary color 晋升 token 阈值。
  - [ ] Substep 4.5 Verify: 确认迁移清单覆盖所有 TSX 引用的全局 class；迁移清单只作为实现参考，实际迁移范围和分类以实现时的当前代码为准，遇到 rebase 后新增或变化的 class 时现场重新判断。
  - [ ] Substep 4.6 Verify: 运行 `pnpm guard`、`pnpm typecheck`、`pnpm --filter @open-design/web test` 和 `pnpm --filter @open-design/web build`。
- [ ] Step 5: 建立双 worktree agent 视觉对比流程
  - [ ] Substep 5.1 Implement: 明确 agent 对比 scenario 列表、viewport、theme/accent matrix、fixture data、双 worktree 端口分配和 phase notes 记录格式。
  - [ ] Substep 5.2 Implement: 准备基线 worktree 与开发 worktree 的启动说明：两边各运行 `pnpm tools-dev run web --daemon-port <port> --web-port <port>`，确保 web/daemon 独立运行。
  - [ ] Substep 5.3 Verify: 让配备 agent-browser CLI 和 Chrome DevTools MCP 的 agent 对比基线服务与开发服务中的 Dashboard/app shell、project detail、settings dialog、file viewer/inspect overlay、sketch editor、live artifact card、modal/popover/control states。
  - [ ] Substep 5.4 Verify: agent 对比必须覆盖 light、dark、system 和 custom accent；发现布局偏移、token 颜色漂移、radius/shadow 差异或主题状态差异时，修复样式或记录批准 deviation。
  - [ ] Substep 5.5 Implement: 在 `phase1-notes.md` 记录 foundation changes、迁移清单、双 worktree 服务地址、agent 对比覆盖场景、发现的问题和批准 deviations。

### Phase 2: Shell and common controls PR

Goal: migrate app shell, buttons, inputs, cards, popovers, and modals using token-backed colors/radius/shadows.

- [ ] Step 6: 迁移 shell 与通用 controls
  - [ ] Substep 6.1 Implement: 按迁移清单替换 app shell、button、input、card、popover 和 modal 的组件级全局 class 为 token-first Tailwind class。
  - [ ] Substep 6.2 Implement: 对依赖 `--radius*` 和 `--shadow*` 的通用 UI 使用 `rounded-card`、`rounded-panel`、`rounded-token-pill`、`shadow-token-sm`、`shadow-token-md` 等 variable-backed Tailwind utilities。
  - [ ] Substep 6.3 Implement: 保留必要的动态 class 组合时，使用完整静态 class map；需要运行时生成 class 的场景必须有显式 safelist 和 guard/test 覆盖。
  - [ ] Substep 6.4 Implement: 从 `index.css` 移除本 phase 已迁移的组件级 class 定义，保留仍被全局边界使用的样式。
  - [ ] Substep 6.5 Verify: 确认 light、dark、system 和 custom accent modes 下 shell/common controls 通过 CSS variables 保持视觉稳定。
  - [ ] Substep 6.6 Verify: 运行 `pnpm guard`、`pnpm typecheck`、`pnpm --filter @open-design/web test` 和 `pnpm --filter @open-design/web build`。
- [ ] Step 7: Agent 验证 shell 与通用 controls 视觉等价
  - [ ] Substep 7.1 Verify: 在基线 worktree 与开发 worktree 各启动一套 web/daemon，agent 使用 agent-browser CLI 和 Chrome DevTools MCP 对比 shell/common controls 视觉一致性。
  - [ ] Substep 7.2 Implement: 在 `phase2-notes.md` 记录本 phase 的 migrated / retained / deferred class 清单、双 worktree 服务地址、agent 对比结果和批准 deviations。

### Phase 3: Settings and project panels PR

Goal: migrate settings dialogs, project creation, project detail panels, and status surfaces.

- [ ] Step 8: 迁移 settings 与 project panel 区域
  - [ ] Substep 8.1 Implement: 替换 settings dialog、project creation、project detail panels 和 status surfaces 的组件级全局 class 为 token-first Tailwind class。
  - [ ] Substep 8.2 Implement: 将 `SettingsDialog` 中 legacy token fallback 和 project panel 中可治理硬编码色迁移到当前 tokens 或 Tailwind utilities。
  - [ ] Substep 8.3 Implement: 对状态 surface 使用 `success`、`info`、`discovery`、`danger`、`warning` 语义 token utilities。
  - [ ] Substep 8.4 Implement: 从 `index.css` 移除本 phase 已迁移的组件级 class 定义，保留明确记录的 retained styles。
  - [ ] Substep 8.5 Verify: 覆盖 settings dialog、project creation、project detail 和状态 surface 的 light/dark/system/custom accent 视觉检查。
  - [ ] Substep 8.6 Verify: 运行 `pnpm guard`、`pnpm typecheck`、`pnpm --filter @open-design/web test` 和 `pnpm --filter @open-design/web build`。
- [ ] Step 9: Agent 验证 settings 与 project panel 视觉等价
  - [ ] Substep 9.1 Verify: 在基线 worktree 与开发 worktree 各启动一套 web/daemon，agent 使用 agent-browser CLI 和 Chrome DevTools MCP 对比 settings/project panels 视觉一致性。
  - [ ] Substep 9.2 Implement: 在 `phase3-notes.md` 记录本 phase 的 migrated / retained / deferred class 清单、双 worktree 服务地址、agent 对比结果和批准 deviations。

### Phase 4: File viewer, inspect, and edit-mode PR

Goal: migrate file viewer chrome, inspect/comment overlays, and edit-mode integration to token-first utilities while keeping user-authored file color conversion helpers allowlisted.

- [ ] Step 10: 迁移 file viewer 与 inspect/edit-mode overlays
  - [ ] Substep 10.1 Implement: 替换 file viewer app chrome 的组件级全局 class 为 token-first Tailwind class。
  - [ ] Substep 10.2 Implement: 将 inspect/comment overlays 迁移到 `selection`/`inspect` tokens，例如 `bg-selection-overlay`、`border-selection-outline`、`ring-selection-outline` 和 `bg-inspect-overlay`。
  - [ ] Substep 10.3 Implement: 将 file color conversion helpers 和用户 authored content colors 保持在窄 allowlist 中，并标注 runtime/user-content reason。
  - [ ] Substep 10.4 Implement: 从 `index.css` 移除本 phase 已迁移的组件级 class 定义，保留 file/user-content 边界样式。
  - [ ] Substep 10.5 Verify: 覆盖 file viewer、inspect overlay、comment/selection overlay 和 edit-mode integration 的 light/dark/system/custom accent 视觉检查。
  - [ ] Substep 10.6 Verify: 运行 `pnpm guard`、`pnpm typecheck`、`pnpm --filter @open-design/web test` 和 `pnpm --filter @open-design/web build`。
- [ ] Step 11: Agent 验证 file viewer 与 inspect/edit-mode overlays 视觉等价
  - [ ] Substep 11.1 Verify: 在基线 worktree 与开发 worktree 各启动一套 web/daemon，agent 使用 agent-browser CLI 和 Chrome DevTools MCP 对比 file viewer/inspect/edit-mode 视觉一致性。
  - [ ] Substep 11.2 Implement: 在 `phase4-notes.md` 记录本 phase 的 migrated / retained / deferred class 清单、双 worktree 服务地址、agent 对比结果和批准 deviations。

### Phase 5: Sketch, runtime content, and external document PR

Goal: migrate app chrome around sketch canvases and runtime surfaces while retaining user content, iframe, popup, generated runtime HTML, and fixtures under explicit exceptions.

- [ ] Step 12: 迁移 sketch 与 runtime content 边界
  - [ ] Substep 12.1 Implement: 替换 sketch editor app chrome、runtime surfaces、live artifact card 和相关 controls 的组件级全局 class 为 token-first Tailwind class。
  - [ ] Substep 12.2 Implement: 将 sketch/canvas 用户绘图颜色、external document、iframe、popup、generated runtime HTML 和 fixtures 保持在显式 allowlist 中，并标注边界 reason。
  - [ ] Substep 12.3 Implement: 对 canvas 周边 UI 使用 app token utilities；画布数据和用户内容保持数据语义。
  - [ ] Substep 12.4 Implement: 从 `index.css` 移除本 phase 已迁移的组件级 class 定义，保留 content-wide、iframe/runtime 和 fixture 边界样式。
  - [ ] Substep 12.5 Verify: 覆盖 sketch editor、runtime content surface、live artifact card、iframe/popup boundary 和 generated runtime HTML 的 light/dark/system/custom accent 视觉检查。
  - [ ] Substep 12.6 Verify: 确认 `index.css` 中的 global loading shell、base styles、keyframes 和 content-wide CSS 继续有效。
  - [ ] Substep 12.7 Verify: 运行 `pnpm guard`、`pnpm typecheck`、`pnpm --filter @open-design/web test` 和 `pnpm --filter @open-design/web build`。
- [ ] Step 13: Agent 验证 sketch 与 runtime content 边界视觉等价
  - [ ] Substep 13.1 Verify: 在基线 worktree 与开发 worktree 各启动一套 web/daemon，agent 使用 agent-browser CLI 和 Chrome DevTools MCP 对比 sketch/runtime/live artifact 视觉一致性。
  - [ ] Substep 13.2 Implement: 在 `phase5-notes.md` 记录本 phase 的 migrated / retained / deferred class 清单、双 worktree 服务地址、agent 对比结果和批准 deviations。

### Phase 6: Cleanup and enforcement PR

Goal: remove migrated component-level selectors, tighten guard allowlists, refresh baseline counts, and record retained/deferred globals.

- [ ] Step 14: 收尾清理与强约束
  - [ ] Substep 14.1 Implement: 汇总所有 phase 的 migrated / retained / deferred class 清单，确认 retained global CSS inventory、原因和后续处理点。
  - [ ] Substep 14.2 Implement: 删除剩余已迁移组件级 selectors，并收紧 style guard allowlist 到实际需要的 file scope、pattern scope 和 reason。
  - [ ] Substep 14.3 Implement: 刷新 `apps/web/src/index.css` 行数、CSS class selector 数、`apps/web/src/**/*.tsx` 文件数和 `className=` occurrence baseline。
  - [ ] Substep 14.4 Implement: 在 `phase6-notes.md` 记录最终 implementation notes、迁移清单结果和任何批准的 deviations。
  - [ ] Substep 14.5 Verify: 运行 `pnpm guard`。
  - [ ] Substep 14.6 Verify: 运行 `pnpm typecheck`。
  - [ ] Substep 14.7 Verify: 运行 `pnpm --filter @open-design/web test`。
  - [ ] Substep 14.8 Verify: 运行 `pnpm --filter @open-design/web build`。
- [ ] Step 15: Agent 验证最终视觉等价
  - [ ] Substep 15.1 Verify: 在基线 worktree 与开发 worktree 各启动一套 web/daemon，agent 使用 agent-browser CLI 和 Chrome DevTools MCP 运行完整 scenario matrix，确认重构前后视觉一致或 deviation 已批准。
  - [ ] Substep 15.2 Implement: 在 `phase6-notes.md` 记录最终双 worktree 服务地址、agent 对比结果和任何批准的 deviations。

## Notes

Phase notes are split by PR phase so each implementation slice can update its own notes file:

- `phase1-notes.md` - Foundation PR notes, migration inventory, and agent visual comparison setup.
- `phase2-notes.md` - Shell/common controls migration notes and agent visual comparison results.
- `phase3-notes.md` - Settings/project panels migration notes and agent visual comparison results.
- `phase4-notes.md` - File viewer/inspect/edit-mode migration notes and agent visual comparison results.
- `phase5-notes.md` - Sketch/runtime content migration notes and agent visual comparison results.
- `phase6-notes.md` - Cleanup/enforcement notes, final retained global CSS inventory, final agent visual comparison results, and approved deviations.
