import { assert, describe, it } from "@effect/vitest";

import { resolveProjectFileSchemaUrl } from "../project/projectFileSchemaUrl.ts";
import {
  buildProjectFileInstructions,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_HTML_EMBED_INSTRUCTIONS,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./T3OrchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "different provider");
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("teaches the t3-html embed fence, including CSS/JS support and sizing", () => {
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "`t3-html`");
    assert.include(
      T3_HTML_EMBED_INSTRUCTIONS,
      "Embedded CSS and JavaScript are fully supported and executed",
    );
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "locked-down sandbox with no access to the app");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "popups and link navigation are blocked");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "blocks all network requests");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "grows to your content's full height");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "Design responsively");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "expand button to open the embed in a large popup");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "stack multiple independent embeds");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, T3_HTML_EMBED_INSTRUCTIONS);
  });

  it("names the situations that should trigger an embed", () => {
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "### When to use it");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "Reach for an embed by default");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "The user asks what something looks like");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "You changed UI");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "You are proposing UI");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "A visual change has a meaningful before");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "Skip it for code the user is meant to read");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, "not evidence that the app behaves that way");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, ">BEFORE<");
    assert.include(T3_HTML_EMBED_INSTRUCTIONS, ">AFTER<");
  });

  it("teaches t3.json as part of the orchestration instructions", () => {
    // Without this an agent writes the field set and schema URL it remembers
    // from training, which belongs to a different build.
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "## Project configuration (t3.json)");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "do not invent fields");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "rewrites `scripts`");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "t3.codes/schema");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      buildProjectFileInstructions(resolveProjectFileSchemaUrl()),
    );
  });

  it("points at the schema URL this install serves, and omits it when there is none", () => {
    const hosted = buildProjectFileInstructions("https://relay.example.test/schema/t3.json");
    assert.include(hosted, '"$schema": "https://relay.example.test/schema/t3.json"');
    assert.include(hosted, "the only correct source");

    // A local-only install has no schema to point at, but the field discipline
    // still applies — that is the part that keeps an agent from guessing.
    const local = buildProjectFileInstructions(null);
    assert.notInclude(local, "$schema");
    assert.include(local, "do not invent fields");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });
});
