// Limit remote FlowAuto task sessions to the Computer Use surface and task reporting.
// This gate is loaded only in the locally paired, dedicated execution bot.
export const name = 'amb-execution-node-gate'

const CU_PREFIX = 'mcp__computer-use__'
const SECTION = 'amb:execution-node'
const ORDER = 20_200
const RULES = [
  'FLOWAUTO EXECUTION MODE: This is a remote FlowAuto task running on the paired workstation.',
  'Only interact with the already-open Chrome window and the FlowAuto / Google Flow interface through Computer Use.',
  'Do not use shell, scripts, filesystem tools, browser debugging protocols, app connectors, web search, subagents, or any other tools. Those tools are unavailable by design.',
  'Every Computer Use input action is subject to the local owner approval gate. Never attempt to bypass or retry a denied action.',
  'Do not switch Chrome profiles or Google accounts, inspect credentials, change browser settings, install extensions, or open unrelated local files.',
  'Do not publish, share, purchase credits, submit paid jobs, change account settings, or delete content unless the owner explicitly approves that exact action through task_report(needs_you). After approval, perform only the approved action; ask again if scope or cost changes.',
  'Save downloads only into the dedicated bot workspace using the browser save dialog. If Chrome downloads automatically outside that workspace or the destination cannot be confirmed, stop and ask the owner.',
  'Inspect generated images and play videos through the Flow UI before reporting success. State clearly what you actually verified and any limitation.',
  'Use task_report to report progress, ask the owner for a decision, or finish. Be precise about what was actually inspected and verified.',
].join('\n')

const executionSession = (id) => /^task-/.test(String(id ?? ''))

export function apply(ctx) {
  const botId = process.env.AMB_BOT_ID ?? ''
  const pairedBotId = process.env.AMB_EXECUTION_BOT_ID ?? ''
  if (!botId || !pairedBotId || botId !== pairedBotId) return

  const guarded = new WeakSet()
  const roots = new Set()

  ctx.on('agent/created', ({ agent }) => {
    if (!agent || guarded.has(agent)) return
    guarded.add(agent)
    const id = String(agent.id ?? agent.session?.id ?? '')
    const parent = String(agent.session?.header?.parentSession ?? '')
    if (executionSession(id)) roots.add(id)
    else if (roots.has(parent)) roots.add(id)
    if (!roots.has(id)) return

    // A tool guard is fail-closed: only Computer Use and the host-owned task report survive.
    agent.ctx.tools.guard?.((exec) => {
      const name = String(exec?.name ?? exec?.tool?.name ?? '')
      if (name === 'task_report' || name.startsWith(CU_PREFIX)) return undefined
      return 'FlowAuto remote execution is restricted to Computer Use and task_report. This tool is disabled in the paired execution session.'
    })

    agent.ctx.systemPrompt?.section?.({
      name: SECTION,
      order: ORDER,
      interpolate: false,
      text: () => RULES,
    })
  })
}
