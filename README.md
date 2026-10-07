# dsh-session-delete

一个 DeepSeek Harness（DSH）插件：**在"归档"的基础上更进一步，加入真正的删除能力**。

DSH 桌面端的"归档"只是把会话从左侧栏隐藏——会话记录依然完完整整地保存在
`~/.dsh/sessions/<工作区>/session-<uuid>/` 下，日积月累占用可观的空间。这个插件提供：

1. **会话管理页**：侧栏新增一个图标，点开进入独立主面板，按工作区分组浏览全部会话；
2. **勾选删除**：多选会话后批量从硬盘上永久删除（单个会话也可行内直接删）；
3. **批量归档 / 取消归档**：与侧栏行为完全一致（走同一条 `uiWorkspace` 代码路径）；
4. **归档筛选**：与侧栏一致的三档筛选——**隐藏已归档 / 全部显示 / 仅显示已归档**；
5. **侧栏 "…" 菜单删除项**：每个会话菜单里、紧跟官方"归档"项之后的"删除会话…"。

## 当前版本

| | |
| --- | --- |
| 插件版本 | **0.1.2** |
| 兼容 DSH | `0.2.0-rc.2`（`dsh.engines: ">=0.2.0-rc.2"`） |
| 运行时依赖 | 无（宿主注入 react / UI primitives；Node 半部仅用内置模块） |

### 版本历史

- **0.1.2** — 删除判定改用与归档同款的活动瀑布（`workspace/session-activity`），修复空闲会话被误报"正在运行"；删除成功后转发 `api-session/removed`，客户端立即移除摘要，侧栏不再残留"未分组"幽灵会话；磁盘已不存在的陈旧归档条目可一键清理（purge）；侧栏菜单删除项对运行中/已打开会话禁用。
- **0.1.1** — 修复打开删除确认框即黑屏的问题（翻译函数收到数字参数抛 `TypeError`）；未分组会话服从三档归档筛选；头部统计包含未分组会话。
- **0.1.0** — 首个版本：会话管理页、批量删除/归档/取消归档、三档筛选、侧栏菜单删除项。

## 安装

### 方式一：profile 本地链接（推荐本机开发）

1. 编辑 `~/.dsh/profiles/desktop/package.json`：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "…",
           "dsh-session-delete"
         ]
       }
     },
     "dependencies": {
       "dsh-session-delete": "link:/Users/syn/my/projects/dsh-session-delete"
     }
   }
   ```

2. 在 profile 目录安装并重启 DSH：

   ```bash
   cd ~/.dsh/profiles/desktop && pnpm install
   ```

### 方式二：npm / file 依赖

```bash
# npm 发布后：
cd ~/.dsh/profiles/desktop
pnpm add dsh-session-delete
# 或本地目录：pnpm add file:/Users/syn/my/projects/dsh-session-delete
```

并把 `"dsh-session-delete"` 加入该 profile `package.json` 的 `dsh.profile.bundles` 数组，然后重启 DSH。

安装后：左侧栏出现新的**会话管理**图标（排在定时任务之后）；每个会话的 "…" 菜单里出现"删除会话…"。

## 使用

- **会话管理**主面板：
  - 顶部：三档归档筛选 + 会话总数 / 归档数 / 磁盘占用统计 + 刷新；
  - 按工作区分组的会话列表，支持整组全选；
  - 底部批量栏：归档、取消归档、删除（红色，需确认）；已选数量与合计体积；
  - 每行：相对时间、磁盘占用、归档 / 置顶 / 运行中 / 已打开徽标，行内归档与删除按钮。
- 侧栏任意会话的 **"…" → 删除会话…**：弹确认框后删除。

## 安全设计

| 防线 | 说明 |
| --- | --- |
| 活动判定 | 与归档同款的活动瀑布（`workspace/session-activity`）：只有真正有工作在跑才拒绝，空闲的内存残留不误伤 |
| 打开会话禁删 | 页面行与侧栏菜单均对运行中/已打开会话禁用删除 |
| 删除需确认 | 页面批量删除与菜单删除都必须经过确认对话框 |
| 路径三重校验 | 目录名必须等于会话 id 编码、必须位于会话根目录内、id 必须是 `session-` 前缀 |
| 先删盘、后清账 | rm 失败时不改动任何注册表状态；成功后再清理归档集 / 置顶集 / 工作区账目 |
| 同源 + 回环守卫 | API 只接受本机回环、同源（非跨站）请求 |
| 幂等可重入 | 每一步幂等；磁盘已不存在的会话执行残留清理（purge）而非报错 |

删除的正确性说明：

- 会话在硬盘上的唯一事实来源是 `~/.dsh/sessions/.../session-<uuid>/` 目录，删除目录即删除会话；
- sqlite 全文检索索引（`session-query-sqlite`）在下一次查询时对持久层做 reconcile，会自动清掉已删会话的条目；
- 注册表清理通过 `workspaceRegistry` 自身的域写链完成（`unarchiveSession` / `unpinSession` / `detachSession`），
  因此侧栏会通过 follow 流实时刷新，`workspace.json` 不留幽灵条目；
- 删除完成后 Host 会转发 `api-session/removed` 事件（与会话控制器在 `session/disposed` 时发的同一事件），
  客户端立即从会话列表移除对应摘要——否则由于 jsonl 持久层没有删除事件，
  已删会话会以幽灵形式留在侧栏"未分组"里直到重启。

## 架构

```
lib/index.js   Node 半部：/api/dsh-session-delete/{list,delete} JSON 桥
               - list   → workspaceRegistry 投影 + 每会话磁盘占用
               - delete → 活动瀑布判定 → 路径校验 → rm → 注册表清理
                 → 转发 api-session/removed
                 目录定位优先用后端 locate()，回退到与
                 dsh-session-persistence-jsonl 完全一致的 projectKey/encodeSegment 规则
lib/client.js  浏览器半部（dsh.client 平台 web）：
               - main 键槽 (key=session-delete)     → 会话管理页
               - sidebar.panellist                  → 侧栏入口图标
               - sidebar.workspaces.session.menu.item (order 500) → 菜单删除项
               - shell.overlay                      → 菜单删除确认浮层
               数据全部来自侧栏同款投影（ctx.workspaces.list / ctx.sessions.list），
               归档/取消归档走 ctx.uiWorkspace（与官方按钮同一条代码路径）
```

## 开发与测试

```bash
node test/test-host.mjs    # Host 半部：真实临时目录上的删除管线端到端测试
node test/test-client.mjs  # Client 半部：加载/注册/字典/组件渲染/交互回归测试
```

## License

MIT
