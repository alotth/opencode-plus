import { For, Match, Show, Switch, createMemo, onCleanup, type JSX, type ValidComponent } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { DialogSelectFile } from "@/components/dialog-select-file"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { StickyAddButton } from "@/pages/session/review-tab"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis } from "@/utils/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useComments } from "@/context/comments"
import { useCommand } from "@/context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
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
  open: boolean
  reviewOpen: boolean
  language: ReturnType<typeof useLanguage>
  layout: ReturnType<typeof useLayout>
  command: ReturnType<typeof useCommand>
  dialog: ReturnType<typeof useDialog>
  file: ReturnType<typeof useFile>
  comments: ReturnType<typeof useComments>
  sync: ReturnType<typeof useSync>
  hasReview: boolean
  reviewCount: number
  reviewTab: boolean
  contextOpen: () => boolean
  openedTabs: () => string[]
  activeTab: () => string
  activeFileTab: () => string | undefined
  tabs: () => ReturnType<ReturnType<typeof useLayout>["tabs"]>
  openTab: (value: string) => void
  showAllFiles: () => void
  reviewPanel: () => JSX.Element
  messages: () => unknown[]
  visibleUserMessages: () => unknown[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  info: () => unknown
  handoffFiles: () => Record<string, SelectedLineRange | null> | undefined
  codeComponent: NonNullable<ValidComponent>
  addCommentToContext: (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => void
  activeDraggable: () => string | undefined
  onDragStart: (event: unknown) => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent) => void
  fileTreeTab: () => "changes" | "all"
  setFileTreeTabValue: (value: string) => void
  diffsReady: boolean
  diffFiles: string[]
  kinds: Map<string, "add" | "del" | "mix">
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  webTabs: () => PluginWebTab[]
  directory: string
}) {
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
    if (!path || !inScopes(path, scopes)) {
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
      props.file
        .load(path)
        .then(() => {
          const content = props.file.get(path)?.content?.content ?? ""
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

    props.file
      .load(path, { force: true })
      .then(() => {
        const current = props.file.get(path)?.content?.content ?? ""
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

        props.file
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

  return (
    <Show when={props.open}>
      <aside
        id="review-panel"
        aria-label={props.language.t("session.panel.reviewAndFiles")}
        class="relative min-w-0 h-full border-l border-border-weak-base flex"
        classList={{
          "flex-1": props.reviewOpen,
          "shrink-0": !props.reviewOpen,
        }}
        style={{ width: props.reviewOpen ? undefined : `${props.layout.fileTree.width()}px` }}
      >
        <Show when={props.reviewOpen}>
          <div class="flex-1 min-w-0 h-full">
            <Show
              when={props.layout.fileTree.opened() && props.fileTreeTab() === "changes"}
              fallback={
                <DragDropProvider
                  onDragStart={props.onDragStart}
                  onDragEnd={props.onDragEnd}
                  onDragOver={props.onDragOver}
                  collisionDetector={closestCenter}
                >
                  <DragDropSensors />
                  <ConstrainDragYAxis />
                  <Tabs value={props.activeTab()} onChange={props.openTab}>
                    <div class="sticky top-0 shrink-0 flex">
                      <Tabs.List
                        ref={(el: HTMLDivElement) => {
                          const stop = createFileTabListSync({ el, contextOpen: props.contextOpen })
                          onCleanup(stop)
                        }}
                      >
                        <Show when={props.reviewTab}>
                          <Tabs.Trigger value="review" classes={{ button: "!pl-6" }}>
                            <div class="flex items-center gap-1.5">
                              <div>{props.language.t("session.tab.review")}</div>
                              <Show when={props.hasReview}>
                                <div class="text-12-medium text-text-strong h-4 px-2 flex flex-col items-center justify-center rounded-full bg-surface-base">
                                  {props.reviewCount}
                                </div>
                              </Show>
                            </div>
                          </Tabs.Trigger>
                        </Show>
                        <Show when={props.contextOpen()}>
                          <Tabs.Trigger
                            value="context"
                            closeButton={
                              <Tooltip value={props.language.t("common.closeTab")} placement="bottom">
                                <IconButton
                                  icon="close-small"
                                  variant="ghost"
                                  class="h-5 w-5"
                                  onClick={() => props.tabs().close("context")}
                                  aria-label={props.language.t("common.closeTab")}
                                />
                              </Tooltip>
                            }
                            hideCloseButton
                            onMiddleClick={() => props.tabs().close("context")}
                          >
                            <div class="flex items-center gap-2">
                              <SessionContextUsage variant="indicator" />
                              <div>{props.language.t("session.tab.context")}</div>
                            </div>
                          </Tabs.Trigger>
                        </Show>
                        <For each={props.webTabs()}>
                          {(tab) => (
                            <Show when={props.tabs().all().includes(tab.tab)}>
                              <Tabs.Trigger
                                value={tab.tab}
                                closeButton={
                                  <Tooltip value={props.language.t("common.closeTab")} placement="bottom">
                                    <IconButton
                                      icon="close-small"
                                      variant="ghost"
                                      class="h-5 w-5"
                                      onClick={() => props.tabs().close(tab.tab)}
                                      aria-label={props.language.t("common.closeTab")}
                                    />
                                  </Tooltip>
                                }
                                hideCloseButton
                                onMiddleClick={() => props.tabs().close(tab.tab)}
                              >
                                <div class="flex items-center gap-1.5">
                                  <div>{tab.title}</div>
                                </div>
                              </Tabs.Trigger>
                            </Show>
                          )}
                        </For>
                        <SortableProvider ids={props.openedTabs()}>
                          <For each={props.openedTabs()}>
                            {(tab) => <SortableTab tab={tab} onTabClose={props.tabs().close} />}
                          </For>
                        </SortableProvider>
                        <StickyAddButton>
                          <TooltipKeybind
                            title={props.language.t("command.file.open")}
                            keybind={props.command.keybind("file.open")}
                            class="flex items-center"
                          >
                            <IconButton
                              icon="plus-small"
                              variant="ghost"
                              iconSize="large"
                              onClick={() =>
                                props.dialog.show(() => (
                                  <DialogSelectFile mode="files" onOpenFile={props.showAllFiles} />
                                ))
                              }
                              aria-label={props.language.t("command.file.open")}
                            />
                          </TooltipKeybind>
                        </StickyAddButton>
                      </Tabs.List>
                    </div>

                    <Show when={props.reviewTab}>
                      <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={props.activeTab() === "review"}>{props.reviewPanel()}</Show>
                      </Tabs.Content>
                    </Show>

                    <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={props.activeTab() === "empty"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <div class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-6">
                            <Mark class="w-14 opacity-10" />
                            <div class="text-14-regular text-text-weak max-w-56">
                              {props.language.t("session.files.selectToOpen")}
                            </div>
                          </div>
                        </div>
                      </Show>
                    </Tabs.Content>

                    <Show when={props.contextOpen()}>
                      <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={props.activeTab() === "context"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <SessionContextTab
                              messages={props.messages as never}
                              visibleUserMessages={props.visibleUserMessages as never}
                              view={props.view as never}
                              info={props.info as never}
                            />
                          </div>
                        </Show>
                      </Tabs.Content>
                    </Show>

                    <For each={props.webTabs()}>
                      {(tab) => {
                        let frame: HTMLIFrameElement | undefined
                        return (
                          <Tabs.Content value={tab.tab} class="flex flex-col h-full overflow-hidden contain-strict">
                            <Show when={props.activeTab() === tab.tab}>
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

                    <Show when={props.activeFileTab()} keyed>
                      {(tab) => (
                        <FileTabContent
                          tab={tab}
                          activeTab={props.activeTab}
                          tabs={props.tabs}
                          view={props.view}
                          handoffFiles={props.handoffFiles}
                          file={props.file}
                          comments={props.comments}
                          language={props.language}
                          codeComponent={props.codeComponent}
                          addCommentToContext={props.addCommentToContext}
                        />
                      )}
                    </Show>
                  </Tabs>
                  <DragOverlay>
                    <Show when={props.activeDraggable()}>
                      {(tab) => {
                        const path = createMemo(() => props.file.pathFromTab(tab()))
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

        <Show when={props.layout.fileTree.opened()}>
          <div
            id="file-tree-panel"
            class="relative shrink-0 h-full"
            style={{ width: `${props.layout.fileTree.width()}px` }}
          >
            <div
              class="h-full flex flex-col overflow-hidden group/filetree"
              classList={{ "border-l border-border-weak-base": props.reviewOpen }}
            >
              <Tabs
                variant="pill"
                value={props.fileTreeTab()}
                onChange={props.setFileTreeTabValue}
                class="h-full"
                data-scope="filetree"
              >
                <Tabs.List>
                  <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                    {props.reviewCount}{" "}
                    {props.language.t(
                      props.reviewCount === 1 ? "session.review.change.one" : "session.review.change.other",
                    )}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                    {props.language.t("session.files.all")}
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="changes" class="bg-background-base px-3 py-0">
                  <Switch>
                    <Match when={props.hasReview}>
                      <Show
                        when={props.diffsReady}
                        fallback={
                          <div class="px-2 py-2 text-12-regular text-text-weak">
                            {props.language.t("common.loading")}
                            {props.language.t("common.loading.ellipsis")}
                          </div>
                        }
                      >
                        <FileTree
                          path=""
                          allowed={props.diffFiles}
                          kinds={props.kinds}
                          draggable={false}
                          active={props.activeDiff}
                          onFileClick={(node) => props.focusReviewDiff(node.path)}
                        />
                      </Show>
                    </Match>
                    <Match when={true}>
                      <div class="mt-8 text-center text-12-regular text-text-weak">
                        {props.language.t("session.review.noChanges")}
                      </div>
                    </Match>
                  </Switch>
                </Tabs.Content>
                <Tabs.Content value="all" class="bg-background-base px-3 py-0">
                  <FileTree
                    path=""
                    modified={props.diffFiles}
                    kinds={props.kinds}
                    onFileClick={(node) => props.openTab(props.file.tab(node.path))}
                  />
                </Tabs.Content>
              </Tabs>
            </div>
            <ResizeHandle
              direction="horizontal"
              edge="start"
              size={props.layout.fileTree.width()}
              min={200}
              max={480}
              collapseThreshold={160}
              onResize={props.layout.fileTree.resize}
              onCollapse={props.layout.fileTree.close}
            />
          </div>
        </Show>
      </aside>
    </Show>
  )
}
