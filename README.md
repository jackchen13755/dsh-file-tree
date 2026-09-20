# dsh-file-tree

**DSH 右侧栏里的文件面板 + 内置 code-server 编辑器** —— 工作区文件树、就地预览（文本 / 图片）、按文件名搜索、**一键 `@文件` 引用到输入框**，以及**直接编辑文件的 VS Code 网页版**。

```
会话 → 右侧栏 → 「+ 新标签页」 → 编辑器（code-server，整个面板都是编辑器）
                              → 文件面板（只读浏览 / 预览 / @引用）
```

两个入口都注册进 **dsh-better-sidebar** 的标签家族，与「文件变动 / 任务管理 / 源代码管理 / 终端」并列。

## 为什么自己做一个

侧栏的文件树本来是 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 接管的，但在 DSH **0.1.6-alpha.2** 上它的文件行点击是**静默空操作**（实测：真实鼠标点击后不新增标签、无提示、无报错；切换会话再切回也不会补开）。修它等于改第三方编译产物，且它下次更新就被覆盖。

所以这个插件从零走**官方扩展点**，不接管任何布局：

| 面 | 用的接口 |
|---|---|
| 两个标签入口 | `ctx.betterSidebar.registerTab({ id, title, description, order, single, component })` |
| 文件地址认领 | `ctx.sidebarRightTabs.register({ id, kind, title })`（无 `guide`，只认领 `dsh-resource://file/…`） |
| 文件读取 | `ctx.webServer.register({ kind: 'prefix' })` 一条会话级路由 |
| 编辑器进程 | 每个工作区一个 code-server 子进程（`spawn`，端口由 OS 分配，只绑 `127.0.0.1`） |
| 编辑器反代 | `ctx.webServer.register({ kind: 'prefix' })` + 拦截原始 http server 的 `upgrade` 事件转发 WebSocket |
| 会话工作区 | `ctx.sessions.get(id).header.cwd` |
| `@文件` | 产品自带的 mention 文法（纯文本 `@path` / `@"path with spaces"`） |
| 打开文件 | `dsh-resource://file/session/<id>/<path>` 地址 → 官方预览标签 |
| 图标 / 着色 | 产品的 `FileTypeIcon` / `CodeBlock`（`ui-primitives`，惰性加载） |

## 编辑器（code-server）

「编辑器」标签页打开的是**真正的 VS Code 网页版**（code-server 4.138.0）：多文件编辑、集成终端、全局搜索、Git、扩展市场都可用，工作区就是当前会话的 cwd。

**二进制是随插件打包的**：`vendor/code-server/`（约 640MB，`package.json#files` 已包含），装好即用，**不再需要任何下载**。查找顺序是
`codeServer.binaryPath` → `codeServer.searchPaths` → `vendor/code-server/` → `PATH` 上的 `code-server`，
所以想用系统自带的（Homebrew 等）也能直接生效。重新灌装用 `npm run install-code-server`。

**为什么是路径前缀反代**：code-server 4.138 **移除了 `--base-path`**，但它的 workbench HTML 与配置全用相对路径（`serverBasePath: "."`），所以把它的前缀剥掉转发即可——实测 workbench 的全部子请求都落在插件前缀内，**零越界请求**。三个必须踩对的点（缺一个就 404/403，均已实测）：
1. 必须转发 `sec-websocket-key`，否则升级请求退化成普通 GET → **404**；
2. 上游那一段必须显式写 `Connection: Upgrade` + `Upgrade: websocket`，不能指望 http client 自动补 → 同样 **404**；
3. 必须**原样保留调用方的 `Host`**：code-server 的 `authenticateOrigin()` 拿 `Origin` 的 host 与请求 `Host` 比对，改写 Host 就永远不相等 → **403**。

**进程生命周期**：按**工作区**（不是按会话）池化——同一仓库的多个会话共用一个 workbench，因此共享一份文件监听与编辑历史；空闲 `codeServerIdleMinutes`（默认 120 分钟）后回收，插件卸载时全部终止。每个工作区的 user-data / extensions 在 `codeServerDataDir` 下分目录存放。

**主题**：不代管。想改配色请在 workbench 内自行设置（设置会持久化在该工作区的 user-data 里）。

## 功能

**文件树**：懒加载（每展开一个目录才读一次），**官方彩色文件类型图标**（产品的 `FileTypeIcon`，按路径自动分类）、缩进导轨、目录 `▸/▾`、右侧文件大小；操作按钮**悬停才出现**（`▤` 行内预览 / `＠` 引用 / `⧉` 复制路径）；`.git`、`node_modules`、`dist` 等噪音目录不列入；符号链接**仅当真实解析仍在工作区内**才显示。

**打开文件（按类型自动分流）**：
- **文本类**：点文件行 → 在原生标签页用**官方预览**打开（构造产品的 `dsh-resource://file/session/<id>/<path>` 地址交给侧栏控制器，等价于会话里点文件链接），带**完整语法着色**（实测 12 种 token 颜色 + CodeMirror 行号槽）
- **图片 / SVG**：官方预览是**文本预览**，图片它只会报"二进制"、SVG 只显示 XML 源码 —— 所以这两类**自动改用本面板的行内图片预览**（`<img>` + data URL，SVG 也按图片渲染；SVG 还多一个「↗ 源码」按钮切到官方文本视图）
- 点行内 `▤` → 任意文件在本面板预览：文本用产品自带的 `CodeBlock`（shiki 着色 + 行号 + 复制按钮），图片内联（≤3MB），二进制/超大文件明确说明原因
- 面板不可视时（无侧栏控制器）自动回退到行内预览，不会静默失败
- 展开状态与搜索词按会话记住（`sessionStorage`）：切到别的标签再切回来，树还是你离开时那样

**Ctrl/Cmd + 点击跳转**（**行内 `▤` 预览**与**点文件行开出的官方预览标签**里都生效）：
- **import / require 的模块路径** → 宿主按工作区解析，解析到就**在该文件的标签页打开**（官方预览），解析不到会说明原因。解析顺序：
  1. **相对路径** `./x` `../x`（含 `..` 归一化）
  2. **工作区别名**：读项目自己的配置 —— `tsconfig.json`/`jsconfig.json` 的 `compilerOptions.paths`+`baseUrl`（如 `isomorph/*`、`@models/*`、`IndexRouter` 这种精确映射），以及 webpack 风格配置里的 `resolve.alias` 与 `resolve.modules`
  3. **顶层目录**：首个路径段是本工作区的真实目录就直接解析（如 `isomorph/components/X`）
  4. **源码根**：`src` 等（webpack `resolve.modules` 里声明的也算）
  每一条都按「原样 → 追加后缀 → 替换后缀（`./b.js`→`./b.ts`）→ 目录 `index.*`（含 `index.vue`）」逐级尝试，且**只返回文件**：命名到目录时给它的 `index.*`，绝不返回目录本身。命中哪条规则会写进提示里
- **标识符 / 方法** → 四级，逐级降级：
  1. **本文件内的声明** —— `function/class/interface/type/const/let/var/enum`、**解构绑定** `const { a, b } = …` / `const [x] = …`、**行内对象键** `{ retries: 3 }`、**方法/属性行**（`name(...)`、`name = () =>`、`get name()`、Vue options 的 `methods: { doIt() {} }`）、**参数解构** `function Card({ title, onClick }: Props)`、**hook 绑定** `const [open, setOpen] = useState()`、**一行内的类型字面量** `type Props = { a: string; b: number }`、`export default function App()`、`React.FC<Props>` 常量组件、类字段箭头函数；**LESS/SCSS 变量** `@gap:` / `$brand:`、**样式规则** `.wrapper {`（Vue 模板里点 `class="wrapper box"` 也能落到该规则）。命中就滚动并高亮该行
     `import … from` / `export … from` 这类**模块语句永不算"声明行"**（否则 import 里的 `{ X, Y }` 会被当成对象键而误报"定义就在本行"）
  2. **直接 import 的符号** → 顺相对 import 到目标文件里找声明，**带行号打开**
  3. **成员方法**：`service.doThing()` 这类点 `doThing` —— 取 `.` 前的接收者 `service`，顺**它的** import 到目标文件里找 `doThing(...)` 并带行号打开（`this.xxx()` 走第 1 级）
  3.5 **barrel 文件**（React 工程到处都是 `components/index.ts`）：目标文件只是 `export { X } from './X'` / `export * from './X'` 时**继续往下跳**（最多 3 跳），落到真正声明它的文件与行；万一再导出指向的模块解析不到，就停在那一行。点 import 行上的**符号**会跳符号（不会误开模块），点**引号里的路径**才开模块
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

`cordis.patch.yml` 里 `file-tree` 一行的 `config`（全部可选）：

| 键 | 默认 | 说明 |
|---|---|---|
| `codeServerEnabled` | `true` | 关掉后不注册「编辑器」入口，也不启动任何 code-server 进程 |
| `codeServerPath` | `''` | 指定 code-server（启动器 / `bin/` 目录 / 安装根目录均可） |
| `codeServerSearchPaths` | `[]` | 追加查找目录 |
| `codeServerDataDir` | `$DSH_HOME/cache/dsh-file-tree/code-server` | 工作区 user-data / extensions 的根 |
| `codeServerArgs` | `[]` | 追加到每次启动的 CLI 参数 |
| `codeServerStartTimeoutSeconds` | `45` | 启动等待上限 |
| `codeServerIdleMinutes` | `120` | 空闲回收；`0` 关闭回收 |

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
node scripts/test-jump.mjs     # 跳转判定单测（40+ 例：变量/方法/解构/props/接口成员/barrel/别名/路径识别）
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
- 普通函数参数（非解构）、跨文件但本文件没 import 的符号、`node_modules` 里的包、动态计算的别名都定位不了，会明确说明。
- 二进制文件（pdf/docx/zip 等）不预览（明确提示），不做下载/编辑/新建/删除 —— 这个插件的定位是"看"和"引用"。
- 图片按原始尺寸显示（大图受容器宽度限制），不做缩放/旋转/灯箱。

## License

MIT
