import { tool } from "@opencode-ai/plugin"

const loadEngine = () => import("kanban-sync-engine").catch(() => undefined)

const pickConfig = async (directory) => {
  const candidates = [
    `${directory}/kanban-sync-engine.json`,
    `${directory}/kanban-sync-engine.dev.json`,
    `${directory}/.kanban-sync-engine/config.json`,
  ]
  for (const file of candidates) {
    const ok = await Bun.file(file)
      .exists()
      .catch(() => false)
    if (ok) return file
  }
}

const runEngine = async (input) => {
  const engine = await loadEngine()
  if (!engine) return "kanban-sync-engine not installed in .opencode"

  const fn = engine[input.command]
  if (typeof fn !== "function") return `kanban-sync-engine is missing ${input.command}`

  const configPath = await pickConfig(input.directory)
  if (!configPath) {
    return [
      "Missing kanban-sync-engine config in project",
      "Expected one of:",
      "- kanban-sync-engine.json",
      "- kanban-sync-engine.dev.json",
      "- .kanban-sync-engine/config.json",
    ].join("\n")
  }

  return Promise.resolve(
    fn({
      configPath,
      tasksFile: `${input.directory}/TASKS.md`,
      dryRun: input.dryRun,
    }),
  )
    .then((value) => (typeof value === "string" ? value : `${input.command} ok`))
    .catch((error) => `kanban-sync-engine failed: ${error instanceof Error ? error.message : String(error)}`)
}

export const TasksRoadmapPlugin = async () => {
  return {
    async config(input) {
      input.command ??= {}
      input.command.tasks_roadmap = {
        description: "Open tasks roadmap dashboard",
        template: "http://localhost:3000",
      }
      input.command.tasks_status = {
        description: "Check kanban sync status for TASKS.md",
        template: "Use the kanban_status tool",
      }
      input.command.tasks_pull = {
        description: "Run kanban pull in dry-run mode",
        template: "Use the kanban_pull_dry_run tool",
      }
    },
    tool: {
      kanban_status: tool({
        description: "Run kanban-sync-engine status for current project",
        args: {},
        async execute(_, context) {
          return runEngine({
            command: "statusCommand",
            directory: context.directory,
          })
        },
      }),
      kanban_pull_dry_run: tool({
        description: "Run kanban-sync-engine pull dry-run for current project",
        args: {},
        async execute(_, context) {
          return runEngine({
            command: "pullCommand",
            directory: context.directory,
            dryRun: true,
          })
        },
      }),
    },
  }
}

export default TasksRoadmapPlugin
