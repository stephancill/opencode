/** @jsxImportSource @opentui/solid */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const execFileAsync = promisify(execFile)

const sum = (txt: string) => {
  return txt
    .trim()
    .split("\n")
    .filter(Boolean)
    .reduce(
      (acc, row) => {
        const col = row.split("\t")
        const add = Number(col[0])
        const del = Number(col[1])
        return {
          add: acc.add + (Number.isFinite(add) ? add : 0),
          del: acc.del + (Number.isFinite(del) ? del : 0),
        }
      },
      { add: 0, del: 0 },
    )
}

const runGit = async (worktree: string, args: string[]) => {
  const result = await execFileAsync("git", args, { cwd: worktree }).catch(() => undefined)
  if (!result) return ""
  return typeof result.stdout === "string" ? result.stdout.trim() : ""
}

const plugin: TuiPluginModule = {
  id: "git-diff-ui",
  tui: async (api) => {
    let text = ""
    let loading = false
    let activeSessionID: string | undefined

    const directory = async (sessionID?: string) => {
      if (!sessionID) return api.state.path.directory
      return (
        (await api.client.session.get({ sessionID }).catch(() => undefined))?.data?.directory ||
        api.state.path.directory
      )
    }

    const refresh = async (sessionID?: string) => {
      if (loading) return
      loading = true
      const cwd = await directory(sessionID)
      const ok = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])
      if (ok !== "true") {
        text = ""
        loading = false
        api.renderer.requestRender()
        return
      }

      const head = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])
      const branch = head || (await runGit(cwd, ["rev-parse", "--short", "HEAD"]))
      const unstaged = sum(await runGit(cwd, ["-c", "core.fsmonitor=false", "diff", "--numstat"]))
      const staged = sum(await runGit(cwd, ["-c", "core.fsmonitor=false", "diff", "--cached", "--numstat"]))
      const add = unstaged.add + staged.add
      const del = unstaged.del + staged.del
      text = [branch, add > 0 ? `+${add}` : "", del > 0 ? `-${del}` : ""].filter(Boolean).join(" ")
      loading = false
      api.renderer.requestRender()
    }

    const off = api.event.on("session.updated", () => {
      void refresh(activeSessionID)
    })
    const timer = setInterval(() => {
      void refresh(activeSessionID)
    }, 4000)
    api.lifecycle.onDispose(() => {
      off()
      clearInterval(timer)
    })

    api.slots.register({
      order: 220,
      slots: {
        session_prompt_right(ctx, value) {
          if (activeSessionID !== value.session_id) {
            activeSessionID = value.session_id
            void refresh(value.session_id)
          }
          if (!text) return <></>
          return <text fg={ctx.theme.current.textMuted}>{text}</text>
        },
      },
    })

    await refresh()
  },
}

export default plugin
