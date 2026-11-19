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

// 抽风循环判定阈值。用户口径「抽风两三次就截断」：
// REPEAT_THRESHOLD 次相同调用算「一次抽风」，攒够 TRIP_LIMIT 次就 cancel。
// 调小更容易断（阈值 1 = 一出现重复立刻断），调大更宽容。
const REPEAT_THRESHOLD = 3
const TRIP_LIMIT = 2

// 参数序列化前做深 key 排序：同一个调用换参数书写顺序也算同一次。
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k])
    return out
  }
  return value
}

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
      const claimId = typeof payload?.claimId === 'string' ? payload.claimId : ''
      if (!sessionId) { try { rmSync(full, { force: true }) } catch {} continue }

      let agent = agents.get?.(sessionId)
      let fallback = false
      if (!agent) {
        // 目标会话已不在本进程：最常见是子代理干完被回收（ask 由它发出，
        // wake 写的就是它的 sessionId）。此时回退投给当前活跃主会话（root），
        // 别把回复丢在文件里没人处理。root = origin 非 subagent 的会话。
        const roots = (agents.list?.() ?? [])
          .filter((a) => a && a.session?.header?.origin !== 'subagent')
        agent = roots[0]
        fallback = roots.length > 0
        if (!agent) {
          // 一个活跃会话都没有：留着文件，等会话回来。
          diag({ phase: 'agent-missing', sessionId })
          continue
        }
        diag({ phase: 'fallback-root', sessionId, claimId, targetId: agent.id })
      }
      try {
        // 原会话已回收时，注入主会话的消息必须带 claimId 和明确接管指令，
        // 否则主会话收到一句「原会话已回收」不知道要干嘛，回复就悬空了。
        // 主会话按 AGENTS.md 流程 tba reply <claim> + tba events 读回 + 判断分派。
        const msgText = fallback
          ? `[tba 回复投递：原会话 ${sessionId} 已回收，该任务子代理已结束]\n用户回复：${text}\n${claimId ? `任务 claim：${claimId}\n` : ''}请按 tba 流程接管：tba reply ${claimId} 把任务推回进行中 → tba events --claim ${claimId} --full 读回原话 → 判断是继续原子代理还是新派任务。`
          : text
        const msg = makeUserMessage(msgText)
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
        logger.info?.(`dsh-tba-bridge: 已插队唤醒会话 ${agent.id}${fallback ? '（回退主会话）' : ''}`)
        diag({ phase: 'injected', mode: fallback ? 'fallback-root' : 'steer', sessionId, targetId: agent.id })
      } catch (e) {
        logger.warn?.(`dsh-tba-bridge: 注入会话 ${sessionId} 失败: ${e?.message ?? e}`)
        diag({ phase: 'inject-error', sessionId, error: String(e?.message ?? e) })
      }
      try { rmSync(full, { force: true }) } catch {}
    }
  }

  // ── 抽风循环截断 ────────────────────────────────────────────────
  // 子代理死磕同一个工具调用是常见的「抽风」：模型卡在同一个动作上反复重试。
  // tools/post-execute 是 waterfall，denied 的调用也会流经这里（模型反复撞一个
  // 被拒的调用正是要断的循环），所以在这里数「同一个 name + 同一份 arguments」
  // 连续出现多少次。
  //
  // 只管子代理：主代理重复调用常常是有意的多轮排查，误杀代价大。
  // origin === 'subagent' 是官方口径（dsh-session types.ts），delegationDepth 兜底。
  const chains = new WeakMap() // Agent -> { key, count }
  const trips = new WeakMap() // Agent -> number（累计抽风次数）

  const isSubagent = (a) =>
    a?.session?.header?.origin === 'subagent' ||
    (a?.session?.header?.delegationDepth ?? 0) > 0

  // agent.cancel(cause, { keepInbox }) 是官方给插件的截断口子（dsh-session types.ts）。
  // keepInbox: true 必须显式传：默认 false 会 inbox.clear() 丢掉还没跑的 user 消息。
  // idle 时 cancel 是 no-op，不会 throw。
  const truncate = (agent, detail, meta) => {
    const reason = `tba-bridge/loop-truncated: ${detail}`
    try {
      agent.cancel?.({ kind: 'hook', reason }, { keepInbox: true })
      logger.warn?.(`dsh-tba-bridge: 截断抽风子代理 ${agent?.id ?? '?'}（${detail}）`)
    } catch (e) {
      logger.warn?.(`dsh-tba-bridge: 截断子代理 ${agent?.id ?? '?'} 失败: ${e?.message ?? e}`)
    }
    diag({ phase: 'loop-truncated', agentId: agent?.id, ...meta })
    chains.delete(agent)
    trips.delete(agent)
  }

  // 永不阻断下游：先把结果放行，再做事后统计。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    try {
      const agent = exec?.agent
      if (agent && isSubagent(agent)) {
        const key = JSON.stringify([exec.name, canonicalize(exec.arguments)])
        const prev = chains.get(agent)
        const count = prev && prev.key === key ? prev.count + 1 : 1
        chains.set(agent, { key, count })
        if (count >= REPEAT_THRESHOLD) {
          const trip = (trips.get(agent) ?? 0) + 1
          trips.set(agent, trip)
          chains.delete(agent) // 同一个 key 不重复计同一次抽风
          if (trip >= TRIP_LIMIT) {
            truncate(agent, `${exec.name} 连续重复 ${count} 次，第 ${trip} 次抽风`, {
              tool: exec.name,
              count,
              trip,
            })
          } else {
            logger.warn?.(
              `dsh-tba-bridge: 子代理 ${agent.id ?? '?'} 抽风（${exec.name} 重复 ${count} 次），第 ${trip}/${TRIP_LIMIT} 次`,
            )
            diag({ phase: 'loop-detected', agentId: agent.id, tool: exec.name, count, trip })
          }
        }
      }
    } catch {}
    return downstream
  })

  // 用户插话即重置：人已经介入，交给模型重新判断，别拿旧账继续累积。
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages?.some((m) => m.source?.kind === 'user')) {
      chains.delete(agent)
      trips.delete(agent)
    }
    return next()
  })

  // WeakMap 本身会随 Agent 回收，显式删只是让语义明确。
  ctx.on('agent/disposed', ({ agent }) => {
    chains.delete(agent)
    trips.delete(agent)
  })

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
