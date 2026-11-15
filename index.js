/**
 * dsh-tba-bridge — 让 tba 的 detached 监听在收到任意回复时主动唤醒 DSH 会话。
 *
 * 背景：DSH 只有「后台 job 退出」一条 agent 唤醒通道。tba 的 `wait --listen`
 * 监听收到非「回 1」的回复不退出（要一直等到收尾），于是 DSH 不会唤醒，
 * 只能靠用户去聊天框打字。本插件用「文件握手」绕开：
 *
 *   tba 监听（继承 DSH_SESSION_ID，进程内已知目标会话）收到任意回复
 *     → 在 <tba-data>/wakes/<sessionId>.json 写 { text, ts }
 *   dsh-tba-bridge（跑在 DSH 进程内，持有 agents 服务）轮询该目录
 *     → 读文件 → agents.get(sessionId).steer(msg) 插队到当前轮、立刻唤醒
 *     → 删文件
 *
 * 这样 tba 收到的每一条回复（自由文本 / 自定义选项 / 写记忆）都能立刻唤醒会话，
 * 不必等 job 退出，也不必让用户手动去聊天框打字。
 *
 * @module index.js
 */

import { readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

// tba 的数据根：本地数据在 tba exe 同目录的 data\。
// 用 TBA_DATA_DIR 指向该目录；缺省回落到用户目录下的 tba\data
// （与 tba config.rs 的回落一致）。
function tbaDataDir() {
  if (process.env.TBA_DATA_DIR) return resolve(process.env.TBA_DATA_DIR)
  return join(homedir(), 'tba', 'data')
}

function wakesDir() {
  return join(tbaDataDir(), 'wakes')
}

// dsh-llm 的 createUserMessage 只是：{...input, role:'user', id: randomUUID()}
// + structuredClone + deepFreeze。link 包解析不到 @deepseek-ai/dsh-llm（只对 host
// bundle 内的 dsh-ops 可见），所以这里手工构造等价结构，绕开模块解析。
// agent.send(message, target, wakeup) 直接 splice 进 inbox，不校验 brand symbol。
function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'tba-bridge', contributor: 'tba-bridge', revision: '0.1.0', turn: 0, step: 0 },
    content: [{ type: 'text', text }],
  }
}

const WAKE_INTERVAL_MS = 2000

export const name = 'dsh-tba-bridge'
export const inject = ['agents', 'timer']

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const dir = wakesDir()
  logger.info?.(`dsh-tba-bridge: 唤醒目录 ${dir}`)

  let stop = false
  // 诊断：只在启动 / 注入 / 出问题时落盘，空轮询不产生 IO。
  const diagPath = join(dir, '_bridge-status.json')
  const diag = (extra) => {
    try {
      writeFileSync(diagPath, JSON.stringify({
        at: new Date().toISOString(),
        dir,
        ctxHasAgents: !!ctx.agents,
        ...extra,
      }, null, 2))
    } catch {}
  }
  diag({ phase: 'started' })

  const tick = async () => {
    if (stop) return
    // inject:['agents'] 把服务挂到 ctx.agents；ctx.get('agents') 是等价回退。
    const agents = ctx.agents ?? ctx.get?.('agents')
    if (!agents) { diag({ phase: 'no-agents' }); return }

    let files = []
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_bridge-status.json') }
    catch {
      try { mkdirSync(dir, { recursive: true }) } catch {}
      diag({ phase: 'no-dir' })
      return
    }
    if (files.length) diag({ phase: 'scan', files })

    for (const file of files) {
      const full = join(dir, file)
      let payload
      try {
        payload = JSON.parse(readFileSync(full, 'utf8'))
      } catch {
        // 半写的文件：跳过，下一轮再读；读不了格式的删掉别留垃圾。
        try { rmSync(full, { force: true }) } catch {}
        continue
      }
      const sessionId = payload?.sessionId
      const text = typeof payload?.text === 'string' ? payload.text : ''
      if (!sessionId) { try { rmSync(full, { force: true }) } catch {} continue }

      const agent = agents.get?.(sessionId)
      if (!agent) {
        // 目标会话不在本进程（可能已归档/别处）：留着文件，不删，等会话回来。
        diag({ phase: 'agent-missing', sessionId })
        continue
      }
      try {
        const msg = makeUserMessage(text)
        // 插队执行，不排队下一轮。
        // send(..., 'next-turn', true) = followup 语义：排到「下一轮」，当前轮结束才执行，
        // 实测表现为「消息进队列但不发送」。改用 steer = send(msg, 'next-step', true)：
        // 插到当前轮的步骤队列，wakeup=true 立刻唤醒 driver，步骤间即被消费。
        // 老版本 agent 没 steer 时回退到 send('next-step', true)，语义等价。
        if (typeof agent.steer === 'function') {
          agent.steer(msg)
        } else {
          agent.send(msg, 'next-step', true)
        }
        logger.info?.(`dsh-tba-bridge: 已插队唤醒会话 ${sessionId}`)
        diag({ phase: 'injected', mode: 'steer', sessionId })
      } catch (e) {
        logger.warn?.(`dsh-tba-bridge: 注入会话 ${sessionId} 失败: ${e?.message ?? e}`)
        diag({ phase: 'inject-error', sessionId, error: String(e?.message ?? e) })
      }
      try { rmSync(full, { force: true }) } catch {}
    }
  }

  // 用 cordis 的 ctx.interval：定时器注册到当前 fiber，随插件 dispose 自动清理，
  // 不会像裸 setInterval 那样在 fiber  quiesce 后被吞掉。
  ctx.interval(() => {
    if (stop) return
    tick().catch(() => {})
  }, WAKE_INTERVAL_MS)
  tick().catch(() => {})

  // cordis effect：外层是 setup，返回的函数才是 dispose 回调（照 dsh-mortis 写法）。
  // 写成 ctx.effect(() => { stop = true }) 会被当成 setup 立即执行，loop 当场停。
  ctx.effect(() => () => { stop = true }, 'dsh-tba-bridge: dispose')
}
