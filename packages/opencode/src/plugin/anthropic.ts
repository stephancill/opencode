import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Auth } from "@/auth"

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"

type UsageWindow = {
  utilization?: number
  resets_at?: string
}

type UsageResponse = {
  five_hour?: UsageWindow
  seven_day?: UsageWindow
  seven_day_sonnet?: UsageWindow
  seven_day_opus?: UsageWindow
}

function timeLeft(iso?: string) {
  if (!iso) return undefined
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return undefined
  const total = Math.ceil(ms / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const mins = Math.max(1, Math.floor((total % 3600) / 60))
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

export async function AnthropicPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "tui.footer.model": async (input, output) => {
      if (input.mode !== "normal") return
      if (!input.model) return
      if (input.model.providerID !== "anthropic") return

      const auth = await Auth.get("anthropic")
      if (auth?.type !== "oauth") return

      const response = await fetch(USAGE_ENDPOINT, {
        method: "GET",
        headers: {
          authorization: `Bearer ${auth.access}`,
          "anthropic-beta": "oauth-2025-04-20",
          accept: "application/json",
        },
      }).catch(() => undefined)
      if (!response?.ok) {
        output.refresh_ms = 30_000
        return
      }

      const data = (await response.json().catch(() => undefined)) as UsageResponse | undefined
      const session = data?.five_hour
      if (typeof session?.utilization !== "number") {
        output.refresh_ms = 30_000
        return
      }

      const sessionPct = `${Math.round(session.utilization)}%`
      const sessionLeft = timeLeft(session.resets_at)
      const sessionStr = sessionLeft ? `${sessionPct} (${sessionLeft})` : sessionPct

      const weekly = data?.seven_day
      if (typeof weekly?.utilization === "number") {
        const weeklyPct = `${Math.round(weekly.utilization)}%`
        const weeklyLeft = timeLeft(weekly.resets_at)
        const weeklyStr = weeklyLeft ? `${weeklyPct} (${weeklyLeft})` : weeklyPct
        output.info.push(`${sessionStr} · ${weeklyStr}`)
      } else {
        output.info.push(sessionStr)
      }

      const resetMs = session.resets_at ? new Date(session.resets_at).getTime() - Date.now() : 0
      output.refresh_ms = resetMs > 0 ? Math.min(Math.max(resetMs, 10_000), 60_000) : 30_000
    },
  }
}
