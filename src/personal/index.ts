import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagents from "../../index.ts";
import { withFleetCosts } from "./fleet.ts";
import { withRoleOverview } from "./definitions.ts";

export const SUBAGENT_COMMANDS = new Set([
  "run", "subagents", "subagents-fleet", "subagents-detach", "subagents-doctor",
  "subagents-guide", "subagents-inspect-rpc",
]);

export function limitedCommands(api: ExtensionAPI): ExtensionAPI {
  return new Proxy(api, {
    get(target, property) {
      if (property === "registerCommand") {
        return (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
          if (SUBAGENT_COMMANDS.has(name)) target.registerCommand(name,
            name === "subagents-fleet" ? withFleetCosts(target, options) : name === "subagents" ? withRoleOverview(options) : options);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default function subagents(api: ExtensionAPI) {
  registerSubagents(limitedCommands(api));
}
