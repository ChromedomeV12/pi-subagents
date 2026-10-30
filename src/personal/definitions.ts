import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as discovery from "../agents/agents.ts";
import * as models from "../shared/model-info.ts";
import * as resolution from "../runs/shared/model-resolution.ts";

export const CONFIGURED_ROLES = ["scout", "planner", "worker", "reviewer"] as const;
export type RoleView = { name: string; source: string; filePath: string; model: string; modelSetting: string; thinking: string };
type Item = { value: string; label: string; badge?: string };
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

/** Resolve only the selected upstream roles using Nico's own configuration precedence. */
export async function configuredRoleViews(ctx: ExtensionCommandContext): Promise<RoleView[]> {
  const found = discovery.discoverAgents(ctx.cwd, "both", ctx.model?.provider, { projectTrusted: ctx.isProjectTrusted() });
  const available = ctx.modelRegistry.getAvailable().map(models.toModelInfo);
  const current = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  return CONFIGURED_ROLES.flatMap(name => {
    const agent = found.agents.find(agent => agent.name === name && agent.source !== "builtin" && !agent.disabled);
    if (!agent) return [];
    const model = resolution.resolveSubagentModelOverride(agent.model, current, available, agent.modelProvider ?? ctx.model?.provider);
    const thinking = models.resolveEffectiveThinking(model, agent.thinking) ?? (agent.thinking === false ? "off" : "default / unset");
    const modelSetting = !agent.model ? "inherit session model"
      : agent.override && agent.model !== agent.override.base.model ? `${agent.override.scope} override: ${agent.model}`
      : agent.modelSource ? `${agent.modelSource.scope} defaultModel: ${agent.model}` : `${agent.source} role: ${agent.model}`;
    return [{ name, source: agent.source, filePath: agent.filePath,
      model: model ?? "unresolved (no session model)", modelSetting, thinking }];
  });
}

/** Keep native selector values/save targets while showing the effective configuration. */
export function roleSelectorItems(items: Item[], views: RoleView[]): Item[] | undefined {
  if (!items.some(item => /^[\w-]+ \[(?:user|project|package|builtin|runtime)\]/.test(item.value))) return undefined;
  return views.flatMap(view => {
    const prefix = `${view.name} [${view.source}]`;
    const candidates = items.filter(item => item.value.startsWith(`${prefix} `));
    const item = candidates.find(item => item.value.endsWith(` · ${view.filePath}`)) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!item) return [];
    return [{ ...item, label: `${view.name} · ${view.model}${view.modelSetting === "inherit session model" ? " (session)" : ""} · thinking: ${view.thinking}`, badge: view.source }];
  });
}

/** Add model/thinking overview to the existing editor, retaining upstream editing. */
export function withRoleOverview(command: Command): Command {
  return { ...command, description: "View and edit scout/planner/worker/reviewer models, thinking and prompts", handler: async (args, ctx) => {
    const views = await configuredRoleViews(ctx);
    const requested = args.trim().split(/\s+/)[0];
    if (requested && !views.some(view => view.name === requested)) { ctx.ui.notify(`Available configured roles: ${views.map(view => view.name).join(", ") || "none"}`, "warning"); return; }
    if (!ctx.hasUI) { ctx.ui.notify(views.map(view => `${view.name}: ${view.model} | thinking: ${view.thinking} | ${view.source}`).join("\n"), "info"); return; }
    let roleSelectorSeen = false;
    const custom: typeof ctx.ui.custom = (factory, options) => ctx.ui.custom(async (tui, theme, keys, done) => {
      const component = await factory(tui, theme, keys, done);
      const selector = component as typeof component & { items?: Item[]; applyFilter?: (query: string) => void };
      if (!requested && !roleSelectorSeen && !Array.isArray(selector.items)) throw new Error("Upstream role selector changed; review the pinned adapter.");
      if (Array.isArray(selector.items)) {
        const filtered = roleSelectorItems(selector.items, views);
        if (filtered) {
          roleSelectorSeen = true;
          if (!filtered.length) throw new Error("No matching configured role definitions in the upstream selector.");
          if (typeof selector.applyFilter !== "function") throw new Error("Upstream role selector changed; review the pinned adapter.");
          selector.items = filtered;
          selector.applyFilter("");
        }
      }
      return component;
    }, options);
    const select: typeof ctx.ui.select = (title, options, settings) => {
      const view = views.find(view => title.startsWith(`Administer ${view.name}\n`));
      return ctx.ui.select(view ? `Administer ${view.name}\nModel: ${view.model}\nSetting: ${view.modelSetting}\nThinking: ${view.thinking}\nSource: ${view.source} (${view.filePath})` : title, options, settings);
    };
    const ui = new Proxy(ctx.ui, { get(target, property) {
      if (property === "custom") return custom;
      if (property === "select") return select;
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const context = new Proxy(ctx, { get(target, property) {
      if (property === "ui") return ui;
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    await command.handler(args, context);
  } };
}
