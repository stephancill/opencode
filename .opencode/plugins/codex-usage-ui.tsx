/** @jsxImportSource @opentui/solid */
import { readFile } from "node:fs/promises"
import { writeFile } from "node:fs/promises"
import os from "node:os"
import type { JSX } from "@opentui/solid"
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const issuer = "https://auth.openai.com"
const client_id = "app_EMoamEEZ73f0CkXaXp7hrann"
const usage_endpoint = "https://chatgpt.com/backend-api/codex/usage"

const authPath = () => {
  if (process.env.OPENCODE_AUTH_FILE) return process.env.OPENCODE_AUTH_FILE
  if (process.env.XDG_DATA_HOME) return `${process.env.XDG_DATA_HOME}/opencode/auth.json`
  if (process.env.HOME) return `${process.env.HOME}/.local/share/opencode/auth.json`
}

type OpenAIOAuth = {
  type: "oauth"
  refresh: string
  access?: string
  expires: number
  accountId?: string
}

type TokenResponse = {
  id_token?: string
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

const format = (seconds: unknown) => {
  if (typeof seconds !== "number" || seconds <= 0) return "soon"
  const total = Math.ceil(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const mins = Math.max(1, Math.floor((total % 3600) / 60))
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

const parseJwtClaims = (token: string) => {
  const parts = token.split(".")
  if (parts.length !== 3) return
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return
  }
}

const extractAccountId = (tokens: TokenResponse) => {
  const fromId = typeof tokens.id_token === "string" ? parseJwtClaims(tokens.id_token) : undefined
  if (fromId?.chatgpt_account_id) return fromId.chatgpt_account_id as string
  const authClaim = fromId?.["https://api.openai.com/auth"]
  if (authClaim?.chatgpt_account_id) return authClaim.chatgpt_account_id as string
  if (Array.isArray(fromId?.organizations) && typeof fromId.organizations[0]?.id === "string") {
    return fromId.organizations[0].id as string
  }

  const fromAccess = typeof tokens.access_token === "string" ? parseJwtClaims(tokens.access_token) : undefined
  if (fromAccess?.chatgpt_account_id) return fromAccess.chatgpt_account_id as string
  const accessAuthClaim = fromAccess?.["https://api.openai.com/auth"]
  if (accessAuthClaim?.chatgpt_account_id) return accessAuthClaim.chatgpt_account_id as string
  if (Array.isArray(fromAccess?.organizations) && typeof fromAccess.organizations[0]?.id === "string") {
    return fromAccess.organizations[0].id as string
  }
}

const refreshAccessToken = async (refreshToken: string) => {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id,
    }).toString(),
  }).catch(() => undefined)
  if (!response?.ok) return
  return (await response.json().catch(() => undefined)) as TokenResponse | undefined
}

const getAuth = async () => {
  const file = authPath()
  if (!file) return
  const data = await readFile(file, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => undefined)
  const auth = data?.openai
  if (auth?.type !== "oauth") return
  return {
    file,
    root: data,
    oauth: auth as OpenAIOAuth,
  }
}

const isOpenAI = (api: Parameters<NonNullable<TuiPluginModule["tui"]>>[0], sessionID: string) => {
  const messages = api.state.session.messages(sessionID)
  const lastUser = [...messages].reverse().find((item) => item.role === "user")
  if (!lastUser || !("model" in lastUser)) return false
  return lastUser.model.providerID === "openai"
}

const plugin: TuiPluginModule = {
  id: "codex-usage-ui",
  tui: async (api) => {
    let text = ""
    let loaded = false
    let loading = false

    const render = () => {
      api.renderer.requestRender()
    }

    const log = (message: string, extra?: Record<string, unknown>) => {
      return api.client.app
        .log({
          service: "codex-usage-ui",
          level: "debug",
          message,
          extra,
        })
        .catch(() => undefined)
    }

    const refresh = async () => {
      if (loading) return
      loading = true
      const auth = await getAuth()
      if (!auth?.oauth.refresh) {
        text = "unavailable"
        loaded = true
        loading = false
        render()
        await log("missing openai oauth")
        return
      }

      let oauth = auth.oauth
      if (!oauth.access || oauth.expires < Date.now()) {
        const tokens = await refreshAccessToken(oauth.refresh)
        if (!tokens?.access_token) {
          text = "unavailable"
          loaded = true
          loading = false
          render()
          await log("oauth refresh failed")
          return
        }

        const accountId = extractAccountId(tokens) || oauth.accountId
        oauth = {
          type: "oauth",
          refresh: tokens.refresh_token || oauth.refresh,
          access: tokens.access_token,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          ...(accountId ? { accountId } : {}),
        }

        await writeFile(
          auth.file,
          JSON.stringify(
            {
              ...auth.root,
              openai: oauth,
            },
            null,
            2,
          ),
        ).catch(() => undefined)
      }

      const headers = new Headers({
        authorization: `Bearer ${oauth.access}`,
        originator: "opencode",
        accept: "application/json",
        "User-Agent": `opencode/tui (${os.platform()} ${os.release()}; ${os.arch()})`,
      })
      if (oauth.accountId) headers.set("ChatGPT-Account-Id", oauth.accountId)

      const response = await fetch(usage_endpoint, { method: "GET", headers }).catch(() => undefined)
      if (!response?.ok) {
        text = "unavailable"
        loaded = true
        loading = false
        render()
        await log("usage request failed", { status: response?.status })
        return
      }

      const data = await response.json().catch(() => undefined)
      const primary = data?.rate_limit?.primary_window
      const secondary = data?.rate_limit?.secondary_window
      if (typeof primary?.used_percent !== "number") {
        text = "unavailable"
        loaded = true
        loading = false
        render()
        await log("missing primary window", { data })
        return
      }

      const primaryPct = `${Math.round(primary.used_percent)}%`
      const secondaryPct = typeof secondary?.used_percent === "number" ? `${Math.round(secondary.used_percent)}%` : "-"
      text = `${primaryPct} (${format(primary.reset_after_seconds)}) · ${secondaryPct} (${format(secondary?.reset_after_seconds)})`
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
      order: 200,
      slots: {
        session_prompt_right(ctx, value) {
          if (!isOpenAI(api, value.session_id)) return <></>
          if (!loaded) return <text fg={ctx.theme.current.textMuted}>loading...</text>
          return <text fg={ctx.theme.current.textMuted}>{text}</text>
        },
      },
    })

    await refresh()
  },
}

export default plugin
