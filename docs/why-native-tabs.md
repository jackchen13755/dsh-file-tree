# 为什么用原生标签，而不是自建一列

这份笔记记录了本插件选型的实测依据（DSH **0.1.6-alpha.2**，macOS，web profile）。

## 起点：官方之外的文件树在 0.1.6 上点不动

侧栏文件树原本由第三方插件（dsh-better-sidebar）接管，实测它的文件行点击是**静默空操作**：真实鼠标点击后不新增标签、无提示、console 无报错；切换会话再切回也不会补开。它的打开链路要经过一层"放置"逻辑，依赖"该会话在屏上"的判断，判断不成立时**静默丢弃**。

修它等于改第三方编译产物，且下次 `npm update` 就被覆盖；而产品的公开扩展点已经够用，于是重做为独立插件。

## 官方正路

| 面 | 接口 |
|---|---|
| 标签类型 | `ctx.sidebarRightTabs.register({ id, kind, title, guide })` |
| 标签体 | `ctx.slots.register` 挂 `sidebar.right.pane.tab`（key = 类型 id） |
| 打开文件 | `ctx.get('sidebarRight').openResource('dsh-resource://file/session/<id>/<path>')` |
| 宿主读取 | `ctx.webServer.register({ kind: 'prefix' })` + `ctx.sessions.get(id).header.cwd` |

要点与坑（都是实测）：

- 插槽 `sidebar.right.pane.tab` 是 **keyed** 槽，`key` 必须等于类型定义里的 `id`；组件是 React 组件（`(props) => ReactNode`）。
- `inject` 工厂的参数是**当前标签所在会话的 sessionId**；宿主能力（打开文件）宜在这个工厂里闭包注入，并按次探测服务是否存在，避免 profile 组合不同就整体失效。
- 服务 `sidebarRightTabs` 可能比插件晚出现，必须 `ctx.inject([...], cb)` 等它。
- 宿主侧服务要写进插件自己的 `inject`，否则运行时抛 `cannot get property "x" without inject`；可选服务用 `ctx.get()` 探测。
- 宿主 `ctx.webServer` 会把路由里逃逸的异常吞成 **400 空响应**，路由必须自兜异常成 JSON 信封。
- **产品的 `FileTypeIcon` 只认它声明的 kind**（`code/excel/folder/html/image/markdown/other/pdf/ppt/video/word`）：传 `folderOpen` 这类想当然的值会让组件抛错，把整个标签体渲染成空白（本次实测踩到，症状是"面板全空且无报错"）。
- 文件地址就是产品自己的 `sessionFileAddress`：`dsh-resource://file/session/<encoded sessionId>/<encoded path>`，路径可绝对可相对（相对工作区），冒号保持字面量以兼容 Windows 盘符。
- `@文件` 不是私有 API，而是**文本 mention 文法**：`@path` / `@"path with spaces"`；用 `document.execCommand('insertText')` 往 composer（contenteditable）里插入后，产品会把它渲染成引用芯片。

## 对本插件的意义

`dsh-file-tree` 因此不碰 frame / 网格 / 别人的 DOM：它只是一个标签类型 + 一个标签体 + 一条会话级只读路由。外壳调整布局时，它最多被挪位置，不会被压成 1px。
