/** @jsxImportSource @opentui/solid */
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { JSX } from "@opentui/solid"
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace/"
const DASHBOARD_URL_SUFFIX = "/go"
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0"
const SCRAPE_TIMEOUT_MS = 10_000

const RE_ROLLING_PCT_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*\}`,
)
const RE_ROLLING_RESET_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*\}`,
)
const RE_WEEKLY_PCT_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*\}`,
)
const RE_WEEKLY_RESET_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*\}`,
)
const RE_MONTHLY_PCT_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*\}`,
)
const RE_MONTHLY_RESET_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*\}`,
)

const formatReset = (seconds: number) => {
  if (seconds <= 0) return "soon"
  const total = Math.ceil(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const mins = Math.max(1, Math.floor((total % 3600) / 60))
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

const configDirs = () => {
  const dirs: string[] = []
  if (process.env.XDG_CONFIG_HOME) dirs.push(path.join(process.env.XDG_CONFIG_HOME, "opencode"))
  if (process.env.HOME) dirs.push(path.join(process.env.HOME, ".config", "opencode"))
  return dirs
}

const resolveConfig = async () => {
  const wsEnv = process.env.OPENCODE_GO_WORKSPACE_ID?.trim()
  const authEnv = process.env.OPENCODE_GO_AUTH_COOKIE?.trim()
  if (wsEnv && authEnv) return { workspaceId: wsEnv, authCookie: authEnv, source: "env" }

  for (const dir of configDirs()) {
    const file = path.join(dir, "opencode-quota", "opencode-go.json")
    const data = await readFile(file, "utf8").then((r) => JSON.parse(r)).catch(() => undefined)
    if (!data || typeof data !== "object" || Array.isArray(data)) continue
    const workspaceId = typeof data.workspaceId === "string" ? data.workspaceId.trim() : ""
    const authCookie = typeof data.authCookie === "string" ? data.authCookie.trim() : ""
    if (workspaceId && authCookie) return { workspaceId, authCookie, source: file }
  }

  return null
}

const fetchWithTimeout = async (url: string, options: RequestInit, timeoutMs: number) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error(`Request timeout after ${Math.round(timeoutMs / 1000)}s`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

interface WindowUsage {
  usagePercent: number
  resetInSec: number
}

const parseWindow = (html: string, rePctFirst: RegExp, reResetFirst: RegExp): WindowUsage | null => {
  const pctFirst = rePctFirst.exec(html)
  if (pctFirst) {
    const usagePercent = Number(pctFirst[1])
    const resetInSec = Number(pctFirst[2])
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) return { usagePercent, resetInSec }
  }
  const resetFirst = reResetFirst.exec(html)
  if (resetFirst) {
    const resetInSec = Number(resetFirst[1])
    const usagePercent = Number(resetFirst[2])
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) return { usagePercent, resetInSec }
  }
  return null
}

interface UsageResult {
  rolling?: WindowUsage
  weekly?: WindowUsage
  monthly?: WindowUsage
}

const fetchUsage = async (workspaceId: string, authCookie: string): Promise<UsageResult | null> => {
  const url = `${DASHBOARD_URL_PREFIX}${encodeURIComponent(workspaceId)}${DASHBOARD_URL_SUFFIX}`
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html", Cookie: `auth=${authCookie}` },
    },
    SCRAPE_TIMEOUT_MS,
  )
  if (!response.ok) return null
  const html = await response.text()
  const rolling = parseWindow(html, RE_ROLLING_PCT_FIRST, RE_ROLLING_RESET_FIRST)
  const weekly = parseWindow(html, RE_WEEKLY_PCT_FIRST, RE_WEEKLY_RESET_FIRST)
  const monthly = parseWindow(html, RE_MONTHLY_PCT_FIRST, RE_MONTHLY_RESET_FIRST)
  if (!rolling && !weekly && !monthly) return null
  return { rolling: rolling ?? undefined, weekly: weekly ?? undefined, monthly: monthly ?? undefined }
}

const isOpenCodeGo = (api: Parameters<NonNullable<TuiPluginModule["tui"]>>[0], sessionID: string) => {
  const messages = api.state.session.messages(sessionID)
  const lastUser = [...messages].reverse().find((item) => item.role === "user")
  if (!lastUser || !("model" in lastUser)) return false
  return lastUser.model.providerID === "opencode-go"
}

const plugin: TuiPluginModule = {
  id: "opencode-go-usage-ui",
  tui: async (api) => {
    let text = ""
    let loaded = false
    let loading = false

    const render = () => api.renderer.requestRender()

    const log = (message: string, extra?: Record<string, unknown>) => {
      return api.client.app
        .log({ service: "opencode-go-usage-ui", level: "debug", message, extra })
        .catch(() => undefined)
    }

    const refresh = async () => {
      if (loading) return
      loading = true
      const config = await resolveConfig()
      if (!config) {
        text = "set OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE"
        loaded = true
        loading = false
        render()
        await log("missing config (env or opencode-go.json)")
        return
      }

      const result = await fetchUsage(config.workspaceId, config.authCookie)
      if (!result) {
        text = "unavailable"
        loaded = true
        loading = false
        render()
        await log("usage fetch failed")
        return
      }

      const parts: string[] = []
      if (result.rolling)
        parts.push(`5h ${Math.round(result.rolling.usagePercent)}% (${formatReset(result.rolling.resetInSec)})`)
      if (result.monthly)
        parts.push(`30d ${Math.round(result.monthly.usagePercent)}% (${formatReset(result.monthly.resetInSec)})`)
      text = parts.join(" · ")
      loaded = true
      loading = false
      render()
    }

    const stop = api.event.on("session.updated", () => {
      void refresh()
    })
    const timer = setInterval(() => {
      void refresh()
    }, 30_000)

    api.lifecycle.onDispose(() => {
      stop()
      clearInterval(timer)
    })

    api.slots.register({
      order: 220,
      slots: {
        session_prompt_right(ctx, value) {
          if (!isOpenCodeGo(api, value.session_id)) return <></>
          if (!loaded) return <text fg={ctx.theme.current.textMuted}>loading...</text>
          if (!text) return <></>
          return <text fg={ctx.theme.current.textMuted}>{text}</text>
        },
      },
    })

    await refresh()
  },
}

export default plugin
