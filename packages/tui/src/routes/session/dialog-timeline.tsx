import { createMemo, createSignal, onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const [loading, setLoading] = createSignal(true)

  onMount(() => {
    dialog.setSize("large")
    void sync.session
      .loadAllMessages(props.sessionID)
      .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
      .finally(() => setLoading(false))
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (sync.data.part[message.id] ?? []).find(
        (x): x is TextPart => x.type === "text" && !x.synthetic && !x.ignored,
      )
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => {
          dialog.replace(() => (
            <DialogMessage messageID={message.id} sessionID={props.sessionID} setPrompt={props.setPrompt} />
          ))
        },
      })
    }
    result.reverse()
    return result
  })

  return (
    <DialogSelect
      emptyView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <text>{loading() ? "Loading full timeline..." : "No results found"}</text>
        </box>
      }
      onMove={(option) => props.onMove(option.value)}
      title="Timeline"
      options={options()}
    />
  )
}
