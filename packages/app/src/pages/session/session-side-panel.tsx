import { For, Match, Show, Switch, createEffect, createMemo, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { useParams } from "@solidjs/router"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { DialogSelectFile } from "@/components/dialog-select-file"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, getTabReorderIndex } from "@/pages/session/helpers"
import { StickyAddButton } from "@/pages/session/review-tab"
import { setSessionHandoff } from "@/pages/session/handoff"
import type { PluginWebTab } from "@/utils/plugin-ui"
import { hashText, inScopes, isAllowedOrigin, normalizeBridgePath } from "@/pages/session/webview-bridge"

type WebviewRequest = {
  type: "opencode.bridge.request"
  requestId: string
  action: "file.read" | "file.write"
  token: string
  payload?: {
    path?: string
    content?: string
    expectedHash?: string
  }
}

export function SessionSidePanel(props: {
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  webTabs: () => PluginWebTab[]
  directory: string
}) {
  const params = useParams()
  const layout = useLayout()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const frames = new Map<string, HTMLIFrameElement>()
  const tokens = new Map<string, string>()

  const isRequest = (value: unknown): value is WebviewRequest => {
    if (!value || typeof value !== "object") return false
    if (!("type" in value) || value.type !== "opencode.bridge.request") return false
    if (!("requestId" in value) || typeof value.requestId !== "string") return false
    if (!("action" in value)) return false
    if (value.action !== "file.read" && value.action !== "file.write") return false
    if (!("token" in value) || typeof value.token !== "string") return false
    return true
  }

  const tabsByKey = createMemo(() => {
    const map = new Map<string, PluginWebTab>()
    for (const tab of props.webTabs()) {
      map.set(tab.tab, tab)
    }
    return map
  })

  const tokenFor = (tab: string) => {
    const current = tokens.get(tab)
    if (current) return current
    const next = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
    tokens.set(tab, next)
    return next
  }

  const postResponse = (input: {
    source: MessageEventSource | null
    requestId: string
    ok: boolean
    payload?: unknown
    error?: string
  }) => {
    const target = input.source
    if (!target || typeof (target as Window).postMessage !== "function") return
    ;(target as Window).postMessage(
      {
        type: "opencode.bridge.response",
        requestId: input.requestId,
        ok: input.ok,
        payload: input.payload,
        error: input.error,
      },
      "*",
    )
  }

  const resolveTabBySource = (source: MessageEventSource | null) => {
    for (const [tab, frame] of frames.entries()) {
      if (frame.contentWindow !== source) continue
      const item = tabsByKey().get(tab)
      if (item) return item
    }
  }

  const audit = (input: { tab: string; action: string; path?: string; origin: string; ok: boolean }) => {
    console.info("[plugin-bridge]", input)
  }

  const onWebviewMessage = (event: MessageEvent) => {
    const tab = resolveTabBySource(event.source)
    if (!tab) return
    if (!isAllowedOrigin(event.origin, tab.origins)) {
      audit({ tab: tab.tab, action: "unknown", origin: event.origin, ok: false })
      return
    }
    if (!isRequest(event.data)) return
    if (event.data.token !== tokenFor(tab.tab)) {
      postResponse({
        source: event.source,
        requestId: event.data.requestId,
        ok: false,
        error: "Invalid bridge token",
      })
      audit({ tab: tab.tab, action: event.data.action, origin: event.origin, ok: false })
      return
    }

    const request = event.data
    const path = normalizeBridgePath(props.directory, request.payload?.path ?? "")
    const scopes = request.action === "file.write" ? tab.permissions.file.write : tab.permissions.file.read
    if (path === undefined || !inScopes(path, scopes)) {
      postResponse({
        source: event.source,
        requestId: request.requestId,
        ok: false,
        error: "Path is not allowed by bridge policy",
      })
      audit({ tab: tab.tab, action: request.action, path, origin: event.origin, ok: false })
      return
    }

    if (request.action === "file.read") {
      file
        .load(path)
        .then(() => {
          const content = file.get(path)?.content?.content ?? ""
          return hashText(content).then((hash) => ({ content, hash }))
        })
        .then((payload) => {
          postResponse({
            source: event.source,
            requestId: request.requestId,
            ok: true,
            payload: {
              path,
              content: payload.content,
              hash: payload.hash,
            },
          })
          audit({ tab: tab.tab, action: request.action, path, origin: event.origin, ok: true })
        })
        .catch((error) => {
          postResponse({
            source: event.source,
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
          audit({ tab: tab.tab, action: request.action, path, origin: event.origin, ok: false })
        })
      return
    }

    const content = typeof request.payload?.content === "string" ? request.payload.content : undefined
    const expectedHash = typeof request.payload?.expectedHash === "string" ? request.payload.expectedHash : undefined
    if (content === undefined || !expectedHash) {
      postResponse({
        source: event.source,
        requestId: request.requestId,
        ok: false,
        error: "file.write requires content and expectedHash",
      })
      audit({ tab: tab.tab, action: request.action, path, origin: event.origin, ok: false })
      return
    }

    file
      .load(path, { force: true })
      .then(() => {
        const current = file.get(path)?.content?.content ?? ""
        return hashText(current)
      })
      .then((currentHash) => {
        if (currentHash !== expectedHash) {
          postResponse({
            source: event.source,
            requestId: request.requestId,
            ok: false,
            error: "Hash mismatch. File changed since last read.",
            payload: { path, hash: currentHash },
          })
          audit({ tab: tab.tab, action: request.action, path, origin: event.origin, ok: false })
          return
        }

        file
          .write({ path, content })
          .then((result) => {
            postResponse({
              source: event.source,
              requestId: request.requestId,
              ok: true,
              payload: {
                path: result.path,
                hash: result.hash,
              },
            })
            audit({ tab: tab.tab, action: request.action, path, origin: event.origin, ok: true })
          })
          .catch((error) => {
            postResponse({
              source: event.source,
              requestId: request.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
            audit({ tab: tab.tab, action: request.action, path, origin: event.origin, ok: false })
          })
      })
      .catch((error) => {
        postResponse({
          source: event.source,
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
        audit({ tab: tab.tab, action: request.action, path, origin: event.origin, ok: false })
      })
  }

  const registerFrame = (tab: PluginWebTab, frame: HTMLIFrameElement) => {
    frames.set(tab.tab, frame)
    const token = tokenFor(tab.tab)
    const origin = (() => {
      try {
        const next = new URL(tab.src).origin
        if (next === "null") return "*"
        return next
      } catch {
        return "*"
      }
    })()
    frame.contentWindow?.postMessage(
      {
        type: "opencode.bridge.host",
        tab: tab.tab,
        token,
      },
      origin,
    )
  }

  if (typeof window !== "undefined") {
    window.addEventListener("message", onWebviewMessage)
    onCleanup(() => window.removeEventListener("message", onWebviewMessage))
  }

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const open = createMemo(() => isDesktop() && (view().reviewPanel.opened() || layout.fileTree.opened()))
  const reviewTab = createMemo(() => isDesktop() && !layout.fileTree.opened())

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const diffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })

  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const webTabKeys = createMemo(() => new Set(props.webTabs().map((tab) => tab.tab)))
  const openedTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => tab !== "context" && tab !== "review" && !webTabKeys().has(tab)),
  )

  const activeTab = createMemo(() => {
    const active = tabs().active()
    if (active === "context") return "context"
    if (active && webTabKeys().has(active)) return active
    if (active === "review" && reviewTab()) return "review"
    if (active && file.pathFromTab(active)) return normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    const web = tabs()
      .all()
      .find((tab) => webTabKeys().has(tab))
    if (web) return web
    if (contextOpen()) return "context"
    if (reviewTab() && hasReview()) return "review"
    return "empty"
  })

  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={open()}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        class="relative min-w-0 h-full border-l border-border-weak-base flex"
        classList={{
          "flex-1": reviewOpen(),
          "shrink-0": !reviewOpen(),
        }}
        style={{ width: reviewOpen() ? undefined : `${layout.fileTree.width()}px` }}
      >
        <Show when={reviewOpen()}>
          <div class="flex-1 min-w-0 h-full">
            <Show
              when={layout.fileTree.opened() && fileTreeTab() === "changes"}
              fallback={
                <DragDropProvider
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  collisionDetector={closestCenter}
                >
                  <DragDropSensors />
                  <ConstrainDragYAxis />
                  <Tabs value={activeTab()} onChange={openTab}>
                    <div class="sticky top-0 shrink-0 flex">
                      <Tabs.List
                        ref={(el: HTMLDivElement) => {
                          const stop = createFileTabListSync({ el, contextOpen })
                          onCleanup(stop)
                        }}
                      >
                        <Show when={reviewTab()}>
                          <Tabs.Trigger value="review" classes={{ button: "!pl-6" }}>
                            <div class="flex items-center gap-1.5">
                              <div>{language.t("session.tab.review")}</div>
                              <Show when={hasReview()}>
                                <div class="text-12-medium text-text-strong h-4 px-2 flex flex-col items-center justify-center rounded-full bg-surface-base">
                                  {reviewCount()}
                                </div>
                              </Show>
                            </div>
                          </Tabs.Trigger>
                        </Show>
                        <Show when={contextOpen()}>
                          <Tabs.Trigger
                            value="context"
                            closeButton={
                              <Tooltip value={language.t("common.closeTab")} placement="bottom">
                                <IconButton
                                  icon="close-small"
                                  variant="ghost"
                                  class="h-5 w-5"
                                  onClick={() => tabs().close("context")}
                                  aria-label={language.t("common.closeTab")}
                                />
                              </Tooltip>
                            }
                            hideCloseButton
                            onMiddleClick={() => tabs().close("context")}
                          >
                            <div class="flex items-center gap-2">
                              <SessionContextUsage variant="indicator" />
                              <div>{language.t("session.tab.context")}</div>
                            </div>
                          </Tabs.Trigger>
                        </Show>
                        <For each={props.webTabs()}>
                          {(tab) => (
                            <Show when={tabs().all().includes(tab.tab)}>
                              <Tabs.Trigger
                                value={tab.tab}
                                closeButton={
                                  <Tooltip value={language.t("common.closeTab")} placement="bottom">
                                    <IconButton
                                      icon="close-small"
                                      variant="ghost"
                                      class="h-5 w-5"
                                      onClick={() => tabs().close(tab.tab)}
                                      aria-label={language.t("common.closeTab")}
                                    />
                                  </Tooltip>
                                }
                                hideCloseButton
                                onMiddleClick={() => tabs().close(tab.tab)}
                              >
                                <div class="flex items-center gap-1.5">
                                  <div>{tab.title}</div>
                                </div>
                              </Tabs.Trigger>
                            </Show>
                          )}
                        </For>
                        <SortableProvider ids={openedTabs()}>
                          <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                        </SortableProvider>
                        <StickyAddButton>
                          <TooltipKeybind
                            title={language.t("command.file.open")}
                            keybind={command.keybind("file.open")}
                            class="flex items-center"
                          >
                            <IconButton
                              icon="plus-small"
                              variant="ghost"
                              iconSize="large"
                              onClick={() =>
                                dialog.show(() => <DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
                              }
                              aria-label={language.t("command.file.open")}
                            />
                          </TooltipKeybind>
                        </StickyAddButton>
                      </Tabs.List>
                    </div>

                    <Show when={reviewTab()}>
                      <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                      </Tabs.Content>
                    </Show>

                    <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "empty"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <div class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-6">
                            <Mark class="w-14 opacity-10" />
                            <div class="text-14-regular text-text-weak max-w-56">
                              {language.t("session.files.selectToOpen")}
                            </div>
                          </div>
                        </div>
                      </Show>
                    </Tabs.Content>

                    <Show when={contextOpen()}>
                      <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "context"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <SessionContextTab />
                          </div>
                        </Show>
                      </Tabs.Content>
                    </Show>

                    <For each={props.webTabs()}>
                      {(tab) => {
                        let frame: HTMLIFrameElement | undefined
                        return (
                          <Tabs.Content value={tab.tab} class="flex flex-col h-full overflow-hidden contain-strict">
                            <Show when={activeTab() === tab.tab}>
                              <iframe
                                ref={(el) => {
                                  frame = el
                                  frames.set(tab.tab, el)
                                  onCleanup(() => frames.delete(tab.tab))
                                }}
                                onLoad={() => {
                                  if (!frame) return
                                  registerFrame(tab, frame)
                                }}
                                src={tab.src}
                                class="h-full w-full border-0 bg-background-base"
                                sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin"
                                referrerPolicy="no-referrer"
                                title={tab.title}
                              />
                            </Show>
                          </Tabs.Content>
                        )
                      }}
                    </For>

                    <Show when={activeFileTab()} keyed>
                      {(tab) => <FileTabContent tab={tab} />}
                    </Show>
                  </Tabs>
                  <DragOverlay>
                    <Show when={store.activeDraggable} keyed>
                      {(tab) => {
                        const path = createMemo(() => file.pathFromTab(tab))
                        return (
                          <div class="relative px-6 h-12 flex items-center bg-background-stronger border-x border-border-weak-base border-b border-b-transparent">
                            <Show when={path()}>{(p) => <FileVisual active path={p()} />}</Show>
                          </div>
                        )
                      }}
                    </Show>
                  </DragOverlay>
                </DragDropProvider>
              }
            >
              {props.reviewPanel()}
            </Show>
          </div>
        </Show>

        <Show when={layout.fileTree.opened()}>
          <div id="file-tree-panel" class="relative shrink-0 h-full" style={{ width: `${layout.fileTree.width()}px` }}>
            <div
              class="h-full flex flex-col overflow-hidden group/filetree"
              classList={{ "border-l border-border-weak-base": reviewOpen() }}
            >
              <Tabs
                variant="pill"
                value={fileTreeTab()}
                onChange={setFileTreeTabValue}
                class="h-full"
                data-scope="filetree"
              >
                <Tabs.List>
                  <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                    {reviewCount()}{" "}
                    {language.t(reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other")}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                    {language.t("session.files.all")}
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                  <Switch>
                    <Match when={hasReview()}>
                      <Show
                        when={diffsReady()}
                        fallback={
                          <div class="px-2 py-2 text-12-regular text-text-weak">
                            {language.t("common.loading")}
                            {language.t("common.loading.ellipsis")}
                          </div>
                        }
                      >
                        <FileTree
                          path=""
                          allowed={diffFiles()}
                          kinds={kinds()}
                          draggable={false}
                          active={props.activeDiff}
                          onFileClick={(node) => props.focusReviewDiff(node.path)}
                        />
                      </Show>
                    </Match>
                    <Match when={true}>
                      <div class="mt-8 text-center text-12-regular text-text-weak">
                        {language.t("session.review.noChanges")}
                      </div>
                    </Match>
                  </Switch>
                </Tabs.Content>
                <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                  <FileTree
                    path=""
                    modified={diffFiles()}
                    kinds={kinds()}
                    onFileClick={(node) => openTab(file.tab(node.path))}
                  />
                </Tabs.Content>
              </Tabs>
            </div>
            <ResizeHandle
              direction="horizontal"
              edge="start"
              size={layout.fileTree.width()}
              min={200}
              max={480}
              collapseThreshold={160}
              onResize={layout.fileTree.resize}
              onCollapse={layout.fileTree.close}
            />
          </div>
        </Show>
      </aside>
    </Show>
  )
}
