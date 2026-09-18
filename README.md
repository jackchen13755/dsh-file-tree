# dsh-file-tree

**DSH 原生右侧栏里的文件面板** —— 工作区文件树、就地预览（文本 / 图片）、按文件名搜索，以及**一键 `@文件` 引用到输入框**。

```
会话 → 右侧栏 → 「+ 新标签页」 → 文件面板
```

## 为什么自己做一个

侧栏的文件树本来是 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 接管的，但在 DSH **0.1.6-alpha.2** 上它的文件行点击是**静默空操作**（实测：真实鼠标点击后不新增标签、无提示、无报错；切换会话再切回也不会补开）。修它等于改第三方编译产物，且它下次更新就被覆盖。

所以这个插件从零走**官方扩展点**，不接管任何布局：

| 面 | 用的接口 |
|---|---|
| 标签类型 | `ctx.sidebarRightTabs.register({ id, kind, title, guide })` |
| 标签体 | `ctx.slots.register` 挂 `sidebar.right.pane.tab`（key = 类型 id） |
| 文件读取 | `ctx.webServer.register({ kind: 'prefix' })` 一条会话级路由 |
| 会话工作区 | `ctx.sessions.get(id).header.cwd` |
| `@文件` | 产品自带的 mention 文法（纯文本 `@path` / `@"path with spaces"`） |
| 打开文件 | `dsh-resource://file/session/<id>/<path>` 地址 → 官方预览标签 |
| 图标 / 着色 | 产品的 `FileTypeIcon` / `CodeBlock`（`ui-primitives`，惰性加载） |

## 功能

**文件树**：懒加载（每展开一个目录才读一次），**官方彩色文件类型图标**（产品的 `FileTypeIcon`，按路径自动分类）、缩进导轨、目录 `▸/▾`、右侧文件大小；操作按钮**悬停才出现**（`▤` 行内预览 / `＠` 引用 / `⧉` 复制路径）；`.git`、`node_modules`、`dist` 等噪音目录不列入；符号链接**仅当真实解析仍在工作区内**才显示。

**打开文件**：
- **点文件行 → 在原生标签页用官方预览打开**（构造产品的 `dsh-resource://file/session/<id>/<path>` 地址交给侧栏控制器，等价于会话里点文件链接），带**完整语法着色**（实测 12 种 token 颜色 + CodeMirror 行号槽）
- 点行内 `▤` → 在本面板预览：文本用产品自带的 `CodeBlock`（shiki 着色 + 行号 + 复制按钮），图片内联（≤3MB），二进制/超大文件明确说明原因
- 面板不可视时（无侧栏控制器）自动回退到行内预览，不会静默失败

**搜索**：顶部输入框按文件名搜索（250ms 防抖、广度优先、跳过噪音目录、上限 200 命中），结果显示**所在目录**与大小，Esc 清空。

**`@文件` 引用**：
- 文件行右侧 `＠`，或预览头部的「＠ 引用」
- 插入的是工作区**相对路径**，带空格的路径自动用引号文法 `@"my file.txt"`
- 实测效果：插入后 DSH 直接把它渲染成**文件引用芯片**（`data-composer-text-ref`），不是一坨纯文本
- 另有 `⧉` 复制绝对路径

## 安装

```sh
dsh plugin --profile web add github:jackchen13755/dsh-file-tree
# 本地源码（开发用）
dsh plugin --profile web add link:/path/to/dsh-file-tree
```

装完硬刷新浏览器（Cmd/Ctrl+Shift+R）。

## 配置

写在 profile 的 `cordis.patch.yml` 行内（都有默认值）：

```yaml
- insert:
    - id: file-tree
      name: 'dsh-file-tree'
      config:
        readLimitBytes: 524288      # 文本预览上限（1KB–8MB）
        imageLimitBytes: 3145728    # 图片预览上限（0–16MB）
        listLimit: 2000             # 单目录条目上限
        searchLimit: 200            # 搜索命中上限
```

## 安全模型

1. **只监听本机**：非 loopback 请求一律 `403`。
2. **调用方不能指定工作区外的路径**：请求只带 `sessionId` + **工作区相对路径**；宿主从会话存储解析工作目录，再 `realpath` 规范化后做包含性校验 —— `../`、绝对路径 `/etc/hosts`、指向工作区外的符号链接**全部拒绝**（集成测试逐条断言）。
3. **只收 JSON POST**：GET、表单、`<img>` 触发不到任何操作。
4. **只读**：这个插件不写、不删、不移动任何文件。

## 开发

零依赖离线构建（不需要 `npm install`）：

```sh
bash scripts/build.sh          # host 半 tsc → lib/；client 半 tsc + 自写 CJS 内联 → lib/client.js
node scripts/smoke-client.mjs  # 浏览器半冒烟：按 ModuleLoader 契约加载并断言注册
```

类型来自真实 DSH 安装（脚本自动探测 `$DSH_HOME/profiles/*`、`$DSH_CHECKOUT`、npx 缓存，可用 `DSH_CHECKOUT=` 指定）。

## 架构

```
src/index.ts          host 插件体：配置 + 挂路由
src/host/files.ts     目录列举 / 预览读取 / 有界搜索（含路径包含性校验）
src/host/fence.ts     loopback + sessionId → 工作目录
src/host/routes.ts    POST /dsh-file-tree/{context,list,read,search}
src/client/index.ts   注册「文件面板」标签类型 + 标签体插槽
src/client/panel.ts   面板 UI（树 / 预览 / 搜索）
src/client/reference.ts  @文件 文法与插入输入框
```

选型依据（为什么必须走原生标签而不是自建列）：[docs/why-native-tabs.md](docs/why-native-tabs.md)。

## 兼容性

- 实测：**DSH 0.1.6-alpha.2**（macOS，web profile）——真机验证覆盖：指南入口出现、树展开、官方图标（10/10 行）、缩进导轨、悬停操作、搜索结果显示所在目录、`＠` 插入后输入框出现 `@<相对路径>` 且被渲染为**引用芯片**、点文件行在标签页用**官方预览**打开（12 种 token 颜色 + 行号）、行内 `▤` 预览同样着色、控制台 0 报错。
- 声明下限：`dsh >= 0.1.5-rc.1`。

## 已知边界

- 树是**懒加载**的：搜索才是全量（有界）遍历；改名/删除后请点 `↻` 刷新。
- 行内预览的着色由产品的 `CodeBlock` 提供（未自带高亮器）；若某个组合里产品没提供 `ui-primitives`，会自动降级为无着色的行号 `<pre>`。
- 二进制文件不预览（明确提示），不做下载/编辑/新建/删除 —— 这个插件的定位是"看"和"引用"。

## License

MIT
