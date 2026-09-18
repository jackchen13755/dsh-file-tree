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

**打开文件（按类型自动分流）**：
- **文本类**：点文件行 → 在原生标签页用**官方预览**打开（构造产品的 `dsh-resource://file/session/<id>/<path>` 地址交给侧栏控制器，等价于会话里点文件链接），带**完整语法着色**（实测 12 种 token 颜色 + CodeMirror 行号槽）
- **图片 / SVG**：官方预览是**文本预览**，图片它只会报"二进制"、SVG 只显示 XML 源码 —— 所以这两类**自动改用本面板的行内图片预览**（`<img>` + data URL，SVG 也按图片渲染；SVG 还多一个「↗ 源码」按钮切到官方文本视图）
- 点行内 `▤` → 任意文件在本面板预览：文本用产品自带的 `CodeBlock`（shiki 着色 + 行号 + 复制按钮），图片内联（≤3MB），二进制/超大文件明确说明原因
- 面板不可视时（无侧栏控制器）自动回退到行内预览，不会静默失败
- 展开状态与搜索词按会话记住（`sessionStorage`）：切到别的标签再切回来，树还是你离开时那样

**Ctrl/Cmd + 点击跳转**（**行内 `▤` 预览**与**点文件行开出的官方预览标签**里都生效）：
- **import / require 的模块路径** → 宿主按工作区解析（`./b`、`./b.js`→`b.ts`、`./b.tsx`→`b.ts`、目录 `index.*`，含后缀替换这类 ESM/TS 互操作写法），解析到就**在该文件的标签页打开**（官方预览），解析不到会说明原因
- **标识符 / 方法** → 四级，逐级降级：
  1. **本文件内的声明** —— `function/class/interface/type/const/let/var/enum`，以及**方法/属性行**（`name(...)`、`name: (...) =>`、`get name()` 等），命中就滚动并高亮该行
  2. **直接 import 的符号** → 顺相对 import 到目标文件里找声明，**带行号打开**
  3. **成员方法**：`service.doThing()` 这类点 `doThing` —— 取 `.` 前的接收者 `service`，顺**它的** import 到目标文件里找 `doThing(...)` 并带行号打开（`this.xxx()` 走第 1 级）
  4. 都不成立就明说原因：接收者不是本文件导入的 / 需要语言服务 / 无法解析该模块
- 包名（`some-package`，含被引号包起来的）会明确回一句「是包名，本面板不做 node_modules 解析」，而不是假装找不到定义
- 按住 Ctrl/Cmd 悬停会**给可跳转的 token 加下划线**；同文件跳转会**滚动并高亮目标行**
- 预览头部常显「Ctrl/Cmd+点击跳转」；**普通点击**可跳转的 token 时会直接提示「按住 Ctrl（macOS 为 Cmd）…」（通知条 + 右下角浮层），不会静默无反应
- 标签页里没有本插件的通知条，跳转结果用右下角浮层提示；若该标签显示的文件与最近打开的不一致会明确提示而不是乱跳
- 取词按**光标坐标**（`caretRangeFromPoint`）而不是点击元素的文本 —— 高亮器可以把整行包成一个 span，按元素取词会把整行当 token

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
node scripts/test-jump.mjs     # 跳转判定逻辑单测（15 例：同文件方法/跨文件成员/接收者/import 追踪/路径识别）
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

- 实测：**DSH 0.1.6-alpha.2**（macOS，web profile）——真机验证覆盖：Ctrl+点 `./b.js` 跳开目标文件、Ctrl+点包名给出「不做 node_modules 解析」、同文件符号跳转滚动+高亮、PNG / SVG 点开即渲染（SVG 按 120×60 真实尺寸）、文本类走官方标签着色、切换标签后展开状态保留、指南入口出现、树展开、官方图标（10/10 行）、缩进导轨、悬停操作、搜索结果显示所在目录、`＠` 插入后输入框出现 `@<相对路径>` 且被渲染为**引用芯片**、点文件行在标签页用**官方预览**打开（12 种 token 颜色 + 行号）、行内 `▤` 预览同样着色、控制台 0 报错。
- 声明下限：`dsh >= 0.1.5-rc.1`。

## 已知边界

- 树是**懒加载**的：搜索才是全量（有界）遍历；改名/删除后请点 `↻` 刷新。
- 行内预览的着色由产品的 `CodeBlock` 提供（未自带高亮器）；若某个组合里产品没提供 `ui-primitives`，会自动降级为无着色的行号 `<pre>`。
- 跳转只跟随**相对** import/require：`tsconfig` 的 `paths` 别名、`node_modules`、以及**接收者不是本文件导入**的成员（局部变量、父类成员、动态对象）都定位不了，会明确说明而不是给错行。
- 成员定位是**同名匹配**（按 `name(...)` 声明形态在目标文件里找），不做类型/重载区分；同名方法多处声明时取第一处。
- 二进制文件（pdf/docx/zip 等）不预览（明确提示），不做下载/编辑/新建/删除 —— 这个插件的定位是"看"和"引用"。
- 图片按原始尺寸显示（大图受容器宽度限制），不做缩放/旋转/灯箱。

## License

MIT
