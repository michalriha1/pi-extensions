import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverySkills, PolicyReader, skillCommandName } from "./policy.ts";

export default function claudeSkillPolicy(pi: ExtensionAPI) {
  const reader = new PolicyReader();
  const refresh = (ctx: ExtensionContext) => reader.refresh(
    ctx.cwd,
    typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true,
  );

  pi.on("input", (event, ctx) => {
    const policy = refresh(ctx);
    const name = skillCommandName(event.text);
    if (name !== undefined && policy.get(name) === "off") {
      console.warn(`[pi-claude-skill-policy] /skill:${name} blocked by skillOverrides.`);
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    event.systemPromptOptions.skills = discoverySkills(event.systemPromptOptions.skills, refresh(ctx));
  });
}
