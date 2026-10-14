import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverySkills, PolicyReader, skillCommandName, stateFor } from "./policy.ts";

export default function claudeSkillPolicy(pi: ExtensionAPI) {
  const reader = new PolicyReader();
  const refresh = (ctx: ExtensionContext) => reader.refresh(
    ctx.cwd,
    typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true,
  );

  pi.on("input", (event, ctx) => {
    const policy = refresh(ctx);
    const name = skillCommandName(event.text);
    // Skill commands carry the SKILL.md path, enabling directory-name matching.
    const path = name === undefined ? undefined : pi.getCommands?.()
      .find((command) => command.source === "skill" && command.name === `skill:${name}`)?.sourceInfo?.path;
    if (name !== undefined && stateFor(policy, name, path) === "off") {
      console.warn(`[pi-claude-skill-policy] /skill:${name} blocked by skillOverrides.`);
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    event.systemPromptOptions.skills = discoverySkills(event.systemPromptOptions.skills, refresh(ctx));
  });
}
