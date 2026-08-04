# Pass 6 — agent identity: agents, tools, and what a plugin is

> **Stale detail (2026-08-03):** written when phosphene had two tools;
> three ship (`invent_directions`, `render_state`, `score_direction`).
> The identity/versioning findings are unaffected.

**Read at:** `ObjectiveAI/objectiveai@649b1d7cf2976036ddcec11d8be1001880d2ca87`
(HEAD, verified unmoved) — 2026-08-03.

**Why this pass exists.** Ronald described agents as "a json and tools — if one
tool is different to an otherwise identical agent, that's a whole new agent."
Maya asked where plugins fit: is phosphene a tool, a group of tools, and what
does "the agent uses it" mean? Deep-researched against source; every claim below
is cited in the underlying report, the load-bearing ones re-cited here.

---

## 1. The one-sentence ontology

**An agent is a JSON recipe, fingerprinted; a plugin is one named, versioned
supplier of tools (ONE plugin = ONE MCP server); the recipe names its suppliers,
never their menus.**

```
Agent (JSON definition, content-addressed id)
  └─ declares plugins by COORDINATES: {owner, name, version, arguments?}
        └─ ONE plugin IS ONE MCP server (one container, one image)
              └─ serves a SET of tools
                    └─ which reach the agent prefixed:  phosphene_invent_directions,
                       phosphene_render_state, …
```

So: **phosphene is a group of tools** — one plugin, one server, currently two
tools (soon three). An agent "uses phosphene" by writing
`{"owner":"mayagore","name":"phosphene","version":"v0.1.0"}` into its `plugins`
array. At run time the platform builds/starts phosphene's container, reads its
menu, and hands the tools to the model with the `phosphene_` prefix.

Two other ways an agent can get tools, for completeness: plain `mcp_servers`
URL entries, and `laboratories` (a container with `Bash`). Both are also part of
the definition. Per-request `extra_mcp_servers` exist and are deliberately NOT
part of identity.

## 2. What exactly makes it "a whole new agent"

The agent id is a **fingerprint of the definition's serialized JSON** —
XxHash3-128 over the normalized struct, base62, 22 chars
(`agent/openrouter/agent.rs:429-433`, same for every upstream). Everything in the
JSON is in the hash:

- model, prompts, decoding params, output mode
- **the `plugins` array — owner, name, version, AND arguments**
- `mcp_servers`, `laboratories`

Consequences, each verified:

| Change | New agent? |
|---|---|
| Same everything, plugin `v0.1.0` → `v0.2.0` | **YES** — version is hashed bytes |
| Same plugin, `arguments: {switch: true}` vs absent | **YES** — arguments are hashed (and gate which tools the server serves) |
| Plugin author changes the TOOLS under the same tag | **NO** — the tool list is never in the hash |
| Editing a remote agent's `description` | NO — description sits outside the hashed inner |
| `arguments: {}` vs no arguments at all | NO — normalization collapses them |

So Ronald's statement is exactly right **at the level of the JSON**: change one
character of the definition — a version, an argument, a prompt — and it is a
different agent with a different id. The one precision worth having: **the tools
themselves are not in the JSON.** The definition names *suppliers*; the menu is
read fresh each run.

## 3. "Preloaded" — when tools actually arrive

Never at definition time. Per run: the request boots a fresh MCP proxy, the
daemon materializes each declared plugin as an **ephemeral container** (one per
response id, evaporating when the connection drops), connects, and `tools/list`
is fetched and cached on that connection. "Preloaded" is accurate per-run —
eagerly listed at connect — but tools are **discovered, not stored**, and can
even change mid-run: the framework's `Tools::replace` fires
`notifications/tools/list_changed` and the proxy republishes. Same agent id,
same instance, different live tools — supported by design (the scaffold ships a
demo of exactly this).

## 4. Definitions vs instances

Same definition spawned twice = same `agent_id`, two different instances:
instance identity is `{agent_id}-{response_id}` plus the spawner lineage joined
by `/` (the agent instance hierarchy). Instance identity lives only in transport
(reserved headers/env the definition cannot smuggle into its hash). This is why
the board can key its cache by agent instance: it is unique per run.

## 5. Sharp edges found on the way (worth knowing, not blocking)

- **Tag immutability is convention, not enforced.** Builds fetch the tag from
  GitHub and record the SHA only after the fact; the image fast-path is keyed by
  coordinates alone. A force-moved tag ships different tools under the same
  agent id on fresh hosts while stale hosts keep old bits. No tag→SHA pinning
  exists platform-wide.
- The `phosphene_` prefix comes from the server's **self-declared** name
  (scaffold aligns it with the repo name); it is convention, not enforced
  equality with the coordinates.
- `Plugin.name` is "slated for removal in a later iteration of the plugin
  model" — the identity triple may become a pair.

## 6. For a designer, in five lines

1. An agent is a **recipe card**: model, instructions, settings, and a list of
   *suppliers* (plugins, by name and version). The card's ID is a fingerprint of
   its text — change any word, even one version number, and it is a different
   card.
2. A plugin is **one supplier**: a sealed box that opens when the agent runs and
   offers a menu of actions (tools).
3. The card never lists the menu — it lists the supplier. The menu is read fresh
   every run, and the supplier may even change it mid-meal.
4. So Ronald is right: any difference in the card = a whole new agent.
   "Preloaded" has one wrinkle — tools are fetched at run start, not baked in.
5. **Phosphene is one supplier box**, and every action it offers reaches the
   agent named `phosphene_something`.
