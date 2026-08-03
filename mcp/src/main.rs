//! Phosphene's tools — the MCP half.
//!
//! A plugin IS a set of tools. This is that set. Everything specific to
//! running inside ObjectiveAI — the transport, the port binding, the
//! `initialize` reply, the command extension — is
//! [`objectiveai_mcp_plugin_framework`]'s job.
//!
//! **The viewer half never calls these.** An agent does, and the tab renders
//! what the agent is doing. That is the whole architecture: the work lives
//! behind tools, the daemon runs it, the human watches.
//!
//! Each tool does its work by spawning an agent completion back through the
//! host. A plugin has no network of its own and no business holding a key.
//!
//! The prompts, the JSON salvage, the anchor contract and the model choices
//! are ported from the TypeScript that proved them against a live daemon
//! (9/9 artboards, 0 failures, 74.5s). Where a line here looks arbitrary, the
//! reason is in the comment beside it.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

// Brings `rmcp` into scope under the name the `#[tool_router]` and `#[tool]`
// macros expand to. Depending on `rmcp` separately would risk two versions in
// one binary, where a `ToolRouter` built by the macros would not fit `serve`.
use objectiveai_mcp_plugin_framework::rmcp;
// Likewise the SDK, whose `CommandExecutor` trait every `execute` is generic
// over: a separately-resolved copy would be a different trait.
use objectiveai_mcp_plugin_framework::objectiveai_sdk;

use futures::StreamExt;
use objectiveai_mcp_plugin_framework::tools::Tools;
use objectiveai_sdk::cli::command::RequestBase;
use objectiveai_sdk::cli::command::agents::message::RequestMessage;
use objectiveai_sdk::cli::command::agents::selector::{AgentRef, AgentSelector};
use objectiveai_sdk::cli::command::agents::spawn;
use rmcp::handler::server::wrapper::{Json, Parameters};
use serde::{Deserialize, Serialize};

/// Must match `mcp.port` in `objectiveai.json`.
const PORT: u16 = 8080;
/// The routing prefix ObjectiveAI derives — tools reach an agent as
/// `phosphene_invent_directions` and `phosphene_render_state`.
const NAME: &str = "phosphene";
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Artboards are a fixed portrait viewport so columns compare like with like.
const ARTBOARD_WIDTH: u32 = 400;
const ARTBOARD_HEIGHT: u32 = 720;

/// Invention is a paragraph of JSON, so it stays cheap.
const INVENTION_MODEL: &str = "openai/gpt-4o-mini";

/// Generation is the step the whole product is judged on, so it does not.
///
/// Measured on this exact prompt, one direction, one state: `gpt-4o-mini`
/// returned 1.6 KB — valid, correctly sized, palette used properly, and a
/// placeholder: one centred card, one heading, one button. Adding an explicit
/// density clause to the prompt moved it to 1.57 KB, i.e. not at all.
/// `claude-sonnet-4.5` on the same prompt returned 5.3 KB with real furniture.
const GENERATION_MODEL: &str = "anthropic/claude-sonnet-4.5";

/// Hang detection belongs on the GAP BETWEEN CHUNKS, not on total duration.
/// The legacy app spent seven commits learning this: a healthy generation
/// legitimately runs for many minutes, while a wedged one goes silent at once.
const STALL: Duration = Duration::from_secs(120);
/// Labelled backstops. Every outer layer strictly outlasts every inner one.
const INVENT_TIMEOUT: Duration = Duration::from_secs(180);
const RENDER_TIMEOUT: Duration = Duration::from_secs(600);

/// An anchor rides in as INPUT on every sibling state, so it is paid for once
/// per sibling. Generous, but bounded.
const MAX_ANCHOR_CHARS: usize = 24_000;

// ── Prompts ─────────────────────────────────────────────────────────────
//
// Carried from the legacy app, the one part of it worth keeping. The
// hard-won details: "genuinely different… not variations on one theme" is
// what stops three near-identical directions; the palette contract shouts
// "JSON ARRAY … Never an object" because a live model returned an object
// keyed by slot and crashed the old app; and `states` are chosen per brief
// and SHARED across directions, which is what makes a comparison grid
// meaningful instead of a mosaic.

const INVENT_PROMPT: &str = r##"You are a senior design director exploring visual directions for a design brief. Generate exactly 3 directions that are genuinely different from each other — not variations on one theme, but contrasting approaches in mood, visual weight, cultural reference, or era.

Consider the domain implied by the intent. A fintech product demands different visual language than a music festival poster or a children's app.

For each direction provide:
- name: Two-word evocative name (e.g. "Midnight Trust", "Paper Carnival")
- description: 2-3 sentences on visual strategy and emotional target. What does the viewer feel? What design tradition does this reference?
- palette: a JSON ARRAY of exactly 5 hex color strings in this order: background, surface, accent, text, muted — e.g. ["#101418", "#1b2129", "#ff6a3d", "#f2f2f2", "#7c8798"]. Never an object. Background and text MUST have sufficient contrast for readability. Accent should be distinct from background.
- typography: A system font stack for headings and body (e.g. "Georgia, serif / system-ui, sans-serif"). No Google Fonts or custom fonts — only fonts available without loading external resources.
- mood: 2-3 word mood descriptor

Also provide "states": a JSON array of exactly 3 state names (views/screens/compositions) that make sense for this brief — a fintech app might get ["landing", "portfolio", "transactions"]; a concert poster might get ["announce", "lineup", "tickets"]. These are SHARED across all directions: every direction will render exactly these 3 states so they can be compared side by side. Do not default to "hero/dashboard/settings" unless those genuinely fit.

Respond with a JSON object: {"directions": [...], "states": ["...", "...", "..."]}."##;

/// The `xmlns` clause costs the model nothing and is what makes the
/// SVG-`foreignObject` → canvas rasterization path work — verified available
/// in-page and untainted, and the thing that keeps vision-based judging on
/// the table. "No external resources" serves the same end: that technique is
/// exactly where remote fonts and images fall down.
fn requirements() -> String {
    format!(
        r##"Technical requirements:
- Complete HTML document with xmlns="http://www.w3.org/1999/xhtml" on the <html> tag
- Set html and body to width: {ARTBOARD_WIDTH}px; height: {ARTBOARD_HEIGHT}px; margin: 0; overflow: hidden
- All styles in a <style> tag — no inline styles except where unavoidable
- CSS flexbox and grid are both allowed. No media queries, no animations, no JavaScript
- No external resources (no Google Fonts, no images, no CDN links)
- Valid XHTML: self-closing tags (<meta/>, <br/>), quoted attributes, no bare ampersands
- Use the font stacks from the typography field (they are system fonts)

Design quality:
- Use the palette semantically: bg= for page background, surface= for cards/panels, accent= for buttons and interactive highlights, text= for body copy, muted= for secondary text and borders
- Visual density, whitespace, and copy tone should reflect the mood
- Use realistic placeholder content — real-looking names, dollar amounts, dates, titles — not "Lorem ipsum" or "John Doe"
- Typography hierarchy: clear distinction between headings, subheadings, body, and labels
- Composition: consider visual weight distribution, focal points, and reading flow

Completeness — this is a finished screen, not a wireframe:
- Fill the full {ARTBOARD_WIDTH}×{ARTBOARD_HEIGHT} frame. Deliberate empty space is fine; an unfinished screen is not
- Include the furniture a real screen of this kind has: header or nav, the primary content at real density (a list has several rows, a feed has several cards, a form has all its fields), and the supporting detail around it — labels, metadata, secondary actions, status
- Design the details rather than defaulting: borders, corner radii, dividers, iconography drawn in CSS, considered type sizes
- A single centered card with one heading and one button is a placeholder. Do better than that."##
    )
}

fn render_system_prompt(states: &[String], label: &str, anchor_html: Option<&str>) -> String {
    // Colour and type are already pinned by the palette and typography spec,
    // so what actually drifts across independently-generated screens is the
    // SHARED CHROME — nav, spacing scale, component styling. Pinning the
    // anchor's real markup rather than a description of it is what makes the
    // states read as one product.
    let consistency = match anchor_html {
        Some(html) => {
            let truncated: String = html.chars().take(MAX_ANCHOR_CHARS).collect();
            let anchor_label = states.first().map(String::as_str).unwrap_or(label);
            format!(
                "The \"{anchor_label}\" state of this direction is already rendered — \
                 match its visual language exactly: reuse the same header/nav markup, \
                 the same spacing scale and CSS, and the same component styling and \
                 palette usage. Only the content differs for this state. Here is that \
                 state's HTML to match:\n\n{truncated}"
            )
        }
        None => "Keep this direction's visual language consistent across the set (same \
                 header/nav treatment, spacing scale, and component styling) so the \
                 states read as one product."
            .to_string(),
    };

    let labels = states
        .iter()
        .map(|state| format!("\"{state}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let count = states.len();
    let requirements = requirements();

    format!(
        "You are a visual designer rendering design concepts as self-contained HTML \
         documents.\n\nThis exploration renders {count} states \
         (views/screens/compositions) per direction, using these EXACT labels shared \
         across every direction so results compare side by side: {labels}. Generate \
         ONLY the \"{label}\" state now — the other states are generated separately. \
         {consistency}\n\nKeep planning brief — put the design effort into the HTML \
         itself, not extended deliberation.\n\n{requirements}\n\nRespond with a JSON \
         object: {{\"label\": \"{label}\", \"html\": \"...\"}}."
    )
}

// ── Types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Direction {
    /// Two-word evocative name.
    pub name: String,
    /// 2-3 sentences on visual strategy and emotional target.
    pub description: String,
    /// Exactly 5 hex strings, in slot order: bg, surface, accent, text, muted.
    pub palette: Vec<String>,
    /// A system font stack — headings / body.
    pub typography: String,
    /// 2-3 word mood descriptor.
    pub mood: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Invention {
    pub directions: Vec<Direction>,
    /// Shared across every direction so columns compare like with like.
    pub states: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct InventArgs {
    /// The design brief, in the designer's own words — e.g. "a dating app
    /// where pickles match on brine compatibility".
    pub brief: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RenderArgs {
    /// The direction to render, exactly as `invent_directions` returned it.
    pub direction: Direction,
    /// Every shared state in the exploration, in order. The first is the
    /// anchor.
    pub states: Vec<String>,
    /// Which of `states` to render now.
    pub label: String,
    /// The anchor state's rendered HTML, when this is not the anchor itself.
    /// Supplying it is what keeps a direction's states looking like one
    /// product; omitting it costs coherence, not correctness.
    #[serde(default)]
    pub anchor_html: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Rendered {
    pub label: String,
    /// A complete, self-contained XHTML document, 400×720.
    pub html: String,
}

// ── Running an agent ────────────────────────────────────────────────────

/// A [`RequestBase`] carrying nothing but a wall-clock cap.
fn capped(timeout: Duration) -> RequestBase {
    RequestBase {
        // Whole seconds, and never zero — zero is rejected at parse time.
        timeout_seconds: Some(timeout.as_secs().max(1)),
        ..Default::default()
    }
}

fn internal(message: impl Into<String>) -> rmcp::ErrorData {
    rmcp::ErrorData::internal_error(message.into(), None)
}

/// Spawn one agent completion through the host and return everything it said.
///
/// The identity argument is `None` on purpose: the HOST decides who a plugin
/// is — it stamps the trio from the image coordinates and refuses any claim
/// off the wire — so a plugin passing its own would be asserting nothing.
async fn run_agent(
    system: &str,
    user: &str,
    model: &str,
    temperature: f64,
    max_tokens: u32,
    timeout: Duration,
) -> Result<String, rmcp::ErrorData> {
    // Built as JSON rather than by hand. The resolved-agent type is a deep
    // untagged enum whose mis-construction fails with an error naming the
    // whole union and pointing nowhere useful — and THIS JSON is the exact
    // shape already proven against a live daemon. Note `system_prompt` is
    // {role, content}; a bare string does not deserialize.
    let spec = serde_json::json!({
        "upstream": "openrouter",
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "plugins": [],
        "system_prompt": { "role": "system", "content": system },
    });
    let spec = serde_json::from_value(spec)
        .map_err(|error| internal(format!("agent spec did not deserialize: {error}")))?;

    let request = spawn::Request {
        path_type: spawn::Path::AgentsSpawn,
        message: RequestMessage::Simple(user.to_string()),
        agent: AgentSelector::Ref {
            agent: AgentRef::Resolved(spec),
        },
        // `execute_streaming` sets `stream` for us.
        dangerous_advanced: None,
        base: capped(timeout),
    };

    let stream = spawn::execute_streaming(
        &objectiveai_mcp_plugin_framework::command_executor(),
        request,
        None,
    )
    .await
    .map_err(|error| internal(format!("agents spawn: {error}")))?;
    let mut stream = std::pin::pin!(stream);

    // Assistant `content` arrives as DELTAS, accumulated by `index`.
    let mut parts: BTreeMap<u64, String> = BTreeMap::new();

    loop {
        let next = tokio::time::timeout(STALL, stream.next())
            .await
            .map_err(|_| internal(format!("the agent went silent for {}s", STALL.as_secs())))?;
        let Some(item) = next else { break };
        let item = item.map_err(|error| internal(format!("agents spawn: {error}")))?;

        // The first item is a bare id string; the rest are completion chunks.
        let spawn::ResponseItem::Chunk(chunk) = item else {
            continue;
        };

        // Walked as JSON deliberately. The wire shape is the contract we
        // verified live; the Rust struct is one implementation of it, and the
        // message chunk is an untagged enum whose tool variant shares this
        // index space. Reading `role` off the value is both the safest
        // discrimination and the one that cannot drift.
        let value = serde_json::to_value(&chunk)
            .map_err(|error| internal(format!("chunk did not serialize: {error}")))?;
        let Some(messages) = value.get("messages").and_then(|m| m.as_array()) else {
            continue;
        };
        for message in messages {
            // Tool chunks are NOT deltas — they arrive whole and share this
            // index space. Folding one into the assistant buffer corrupts the
            // output, so match `role` exactly.
            if message.get("role").and_then(|role| role.as_str()) != Some("assistant") {
                continue;
            }
            let Some(content) = message.get("content").and_then(|c| c.as_str()) else {
                continue;
            };
            let index = message.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            parts.entry(index).or_default().push_str(content);
        }
    }

    let text: String = parts.into_values().collect();
    if text.trim().is_empty() {
        // Distinguish "the model said nothing" from "we cannot parse" — the
        // legacy app reported the former as a parser bug for weeks.
        return Err(internal("the agent returned an empty response"));
    }
    Ok(text)
}

// ── Recovering structure from prose ─────────────────────────────────────

/// Remove ``` fences without disturbing anything else.
fn strip_fences(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("```") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 3..];
        // An opening fence may carry a language tag on the same line.
        let body = match after.find('\n') {
            Some(newline) if after[..newline].trim().chars().all(char::is_alphanumeric) => {
                &after[newline + 1..]
            }
            _ => after,
        };
        match body.find("```") {
            Some(close) => {
                out.push_str(&body[..close]);
                rest = &body[close + 3..];
            }
            None => {
                out.push_str(body);
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Recover a JSON value from a model's prose.
///
/// Agent completions cannot constrain output shape — `output_mode` is
/// documented "Vector completions only. Ignored for agent completions" — so
/// the contract is prose, and this is the cost of that. Two layers: strip
/// fences and parse, then scan for a balanced object. Measured: Sonnet
/// returns fenced JSON, gpt-4o-mini returns it bare.
fn parse_json_loose(text: &str) -> Result<serde_json::Value, String> {
    let stripped = strip_fences(text);
    let trimmed = stripped.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return Ok(value);
    }

    let chars: Vec<char> = trimmed.chars().collect();
    let start = chars
        .iter()
        .position(|c| *c == '{' || *c == '[')
        .ok_or_else(|| "no JSON found in the model's response".to_string())?;
    let open = chars[start];
    let close = if open == '{' { '}' } else { ']' };

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in chars[start..].iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if *ch == '\\' {
            escaped = true;
            continue;
        }
        if *ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        if *ch == open {
            depth += 1;
        } else if *ch == close {
            depth -= 1;
            if depth == 0 {
                let slice: String = chars[start..=start + offset].iter().collect();
                return serde_json::from_str(&slice)
                    .map_err(|error| format!("recovered JSON did not parse: {error}"));
            }
        }
    }
    Err("unterminated JSON in the model's response".to_string())
}

/// Pull the document out of a generation response.
///
/// Layer 1 is the contract, `{"label", "html"}`, plus the legacy wrapper
/// `{"states":[…]}` a model occasionally answers with anyway. Layer 2 is the
/// far more common miss — the model ignores the JSON envelope and simply
/// writes the document. Taking it is strictly better than failing the cell.
fn extract_html(text: &str, label: &str) -> Result<String, String> {
    if let Ok(value) = parse_json_loose(text) {
        if let Some(html) = value.get("html").and_then(|h| h.as_str()) {
            if !html.trim().is_empty() {
                return Ok(html.to_string());
            }
        }
        if let Some(states) = value.get("states").and_then(|s| s.as_array()) {
            let chosen = states
                .iter()
                .find(|state| state.get("label").and_then(|l| l.as_str()) == Some(label))
                .or_else(|| states.first());
            if let Some(html) = chosen.and_then(|s| s.get("html")).and_then(|h| h.as_str()) {
                if !html.trim().is_empty() {
                    return Ok(html.to_string());
                }
            }
        }
    }

    let lower = text.to_ascii_lowercase();
    let start = ["<!doctype html", "<html ", "<html>"]
        .iter()
        .filter_map(|needle| lower.find(needle))
        .min();
    match start {
        Some(start) => Ok(text[start..]
            .trim_end()
            .trim_end_matches('`')
            .trim_end()
            .to_string()),
        None => Err(format!("no HTML document in the \"{label}\" response")),
    }
}

/// Normalize one direction, defaulting rather than failing — a malformed
/// field should cost that field, not the whole run.
fn normalize_direction(raw: &serde_json::Value, index: usize) -> Direction {
    const SLOTS: [&str; 5] = ["background", "surface", "accent", "text", "muted"];
    const FALLBACK: [&str; 5] = ["#101418", "#1b2129", "#ff6a3d", "#f2f2f2", "#7c8798"];

    let palette: Vec<String> = match raw.get("palette") {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|c| c.as_str().map(str::to_string))
            .collect(),
        // The live failure the prompt shouts about: an object keyed by slot.
        Some(serde_json::Value::Object(map)) => SLOTS
            .iter()
            .filter_map(|slot| map.get(*slot).and_then(|c| c.as_str()).map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };

    let field = |key: &str| {
        raw.get(key)
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string()
    };

    Direction {
        name: match raw.get("name").and_then(|value| value.as_str()) {
            Some(name) => name.to_string(),
            None => format!("Direction {}", index + 1),
        },
        description: field("description"),
        palette: if palette.len() == 5 {
            palette
        } else {
            FALLBACK.iter().map(|hex| (*hex).to_string()).collect()
        },
        typography: match raw.get("typography").and_then(|value| value.as_str()) {
            Some(typography) => typography.to_string(),
            None => "system-ui, sans-serif".to_string(),
        },
        mood: field("mood"),
    }
}

fn normalize_invention(parsed: &serde_json::Value) -> Result<Invention, String> {
    let directions: Vec<Direction> = parsed
        .get("directions")
        .and_then(|directions| directions.as_array())
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, raw)| normalize_direction(raw, index))
                .collect()
        })
        .unwrap_or_default();
    if directions.is_empty() {
        return Err("the model returned no directions".to_string());
    }

    let mut seen: Vec<String> = Vec::new();
    let mut states: Vec<String> = Vec::new();
    if let Some(items) = parsed.get("states").and_then(|states| states.as_array()) {
        for state in items.iter().filter_map(|state| state.as_str()) {
            let key = state.to_lowercase();
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            states.push(state.to_string());
            if states.len() == 3 {
                break;
            }
        }
    }

    Ok(Invention { directions, states })
}

// ── The plugin ──────────────────────────────────────────────────────────

/// Whatever the tools need. Every tool receives `&Self`. Phosphene's tools
/// hold nothing between calls — each spawns an agent and returns what it said
/// — so this is empty, and the served set never changes.
#[derive(Clone)]
struct Plugin;

#[rmcp::tool_router]
impl Plugin {
    #[rmcp::tool(
        description = "Invent 3 genuinely contrasting visual design directions for a \
                       design brief. Each carries a name, a described visual strategy, \
                       a 5-colour palette (background, surface, accent, text, muted), \
                       a system font stack and a mood. Also picks 3 states \
                       (views/screens) that suit this particular brief and are SHARED \
                       across all directions, so results can be compared side by side. \
                       Follow with render_state once per (direction x state)."
    )]
    async fn invent_directions(
        &self,
        Parameters(args): Parameters<InventArgs>,
    ) -> Result<Json<Invention>, rmcp::ErrorData> {
        let brief = args.brief.trim();
        if brief.is_empty() {
            return Err(internal("brief is empty"));
        }

        let text = run_agent(
            INVENT_PROMPT,
            brief,
            INVENTION_MODEL,
            // High, deliberately: this step is asked for contrast.
            0.9,
            2000,
            INVENT_TIMEOUT,
        )
        .await?;

        let parsed = parse_json_loose(&text).map_err(internal)?;
        let invention = normalize_invention(&parsed).map_err(internal)?;
        Ok(Json(invention))
    }

    #[rmcp::tool(
        description = "Render ONE state of ONE design direction as a complete, \
                       self-contained 400x720 XHTML document — no external resources, \
                       no JavaScript. Render a direction's FIRST state with no \
                       anchor_html, then pass the document it returns as anchor_html \
                       for that direction's remaining states: it pins the shared \
                       chrome (nav, spacing scale, component styling) so the states \
                       read as one product. Different directions are independent and \
                       can be rendered in parallel."
    )]
    async fn render_state(
        &self,
        Parameters(args): Parameters<RenderArgs>,
    ) -> Result<Json<Rendered>, rmcp::ErrorData> {
        let label = args.label.trim();
        if label.is_empty() {
            return Err(internal("label is empty"));
        }
        let states = if args.states.is_empty() {
            vec![label.to_string()]
        } else {
            args.states.clone()
        };

        let slots = ["bg", "surface", "accent", "text", "muted"];
        let swatches = slots
            .iter()
            .enumerate()
            .map(|(index, slot)| {
                let hex = args
                    .direction
                    .palette
                    .get(index)
                    .map(String::as_str)
                    .unwrap_or("#000000");
                format!("{slot}={hex}")
            })
            .collect::<Vec<_>>()
            .join(", ");

        let user = format!(
            "Direction: \"{}\" — {}\nPalette: {swatches}\nTypography: {}\nMood: {}\n\
             State to render: \"{label}\"",
            args.direction.name,
            args.direction.description,
            args.direction.typography,
            args.direction.mood,
        );

        let text = run_agent(
            &render_system_prompt(&states, label, args.anchor_html.as_deref()),
            &user,
            GENERATION_MODEL,
            // Lower than invention's 0.9: the direction is already pinned, and
            // this step should execute the spec rather than reinterpret it.
            0.7,
            8000,
            RENDER_TIMEOUT,
        )
        .await?;

        let html = extract_html(&text, label).map_err(internal)?;
        Ok(Json(Rendered {
            label: label.to_string(),
            html,
        }))
    }
}

#[tokio::main]
async fn main() -> Result<Infallible, std::io::Error> {
    // Phosphene's tool set never changes, so the full router goes straight in.
    let tools: Arc<Tools<Plugin>> = Tools::new(Plugin::tool_router());

    objectiveai_mcp_plugin_framework::serve::serve(
        objectiveai_mcp_plugin_framework::config::Config::new(PORT, NAME, VERSION)
            .with_description("Design iteration and judgment.")
            .with_instructions(
                "Explore a design brief visually. Call invent_directions ONCE to get 3 \
                 contrasting directions and 3 shared states. Then, for each direction, \
                 call render_state for the FIRST state with no anchor_html, and pass \
                 the HTML it returns as anchor_html when rendering that direction's \
                 remaining states. Directions are independent — render them in \
                 parallel. Return the documents as they come back; a human is looking \
                 at them.",
            ),
        Plugin,
        tools,
    )
    .await
}
