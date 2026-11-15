# dsh-tba-bridge

让 [tba](https://github.com/Rei1mu/teambition-agent-orchestrator) 的 detached 监听在收到任意回复时主动唤醒 DSH 会话，无需等待后台 job 退出。

## 用途

DSH 原本只有「后台 job 退出」一条 agent 唤醒通道。tba 的监听收到非「回 1」的回复不会退出（要一直等到收尾），于是 DSH 不会唤醒。本插件用「文件握手」绕开：

1. tba 监听收到任意回复 → 写 `data/wakes/<sessionId>.json`，内容 `{ sessionId, text, ts }`。
2. 本插件（跑在 DSH 进程内，持有 `agents` 服务）每 2 秒轮询该目录。
3. 读到文件 → `agents.get(sessionId).steer(msg)` 插队注入对应会话、立刻唤醒 → 删文件。

目标会话不在本进程时保留文件，等会话回来再注入。

## 唤醒目录

- 默认：用户目录下的 `tba/data/wakes`（即 `~/.tba` 的同级 `tba\data\wakes`）。
- 覆盖：设环境变量 `TBA_DATA_DIR` 指向 tba 的数据根目录（即包含 `wakes/` 的 `data/` 目录）。

## 安装（DSH profile bundle）

本仓库是一个 [DSH](https://github.com/deepseek-ai/DeepSeek-Harness) host 插件 bundle。在 DSH 的 profile 里以 link 方式安装：

```
git clone https://github.com/Rei1mu/dsh-tba-bridge.git
```

在 profile 的 bundle 配置里加入（路径按实际 clone 位置调整）：

```json
{
  "name": "dsh-tba-bridge",
  "source": "link:/absolute/path/to/dsh-tba-bridge"
}
```

`cordis.patch.yml` 会挂载 `dsh-tba-bridge` 插件；运行期不产生配置参数。`catalog/dsh-plugin.json` 是插件目录元数据。

## 验证

```
node --check index.js
```

启动后插件会在 `wakes/` 目录写 `_bridge-status.json`，记录启动、扫描、注入等诊断阶段。

## License

MIT（见 [LICENSE](LICENSE)）。
