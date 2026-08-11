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

mod fonts;

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
use objectiveai_mcp_plugin_framework::{db, sqlx};

use futures::StreamExt;
use tokio::sync::OnceCell;
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

/// Which upstream runs a completion. They take different specs, and mixing
/// them is silent rather than an error — see `run_agent`.
#[derive(Clone, Copy)]
enum Upstream {
    OpenRouter,
    /// Runs on the machine's own Claude Code login. No key, and BYOK is
    /// rejected outright. Reports ZERO cost and ZERO tokens through
    /// ObjectiveAI — measured 2026-08-03 on a real artboard: 9,280 chars in
    /// 33s at no charge, against 6,179 for the same direction and state on
    /// openrouter. Denser and free. The trade is no token metering either, so
    /// a spend ceiling cannot be enforced from usage; and it needs a live
    /// `claude` login, whose lapse ObjectiveAI reports as the nonsense string
    /// "Claude Code returned an error result: success".
    ClaudeAgentSdk,
}

/// Invention is the TASTE step — it picks the palettes and type stacks that
/// everything downstream executes — so it runs on the same Claude login as
/// generation rather than on a dated mini model whose aesthetic defaults
/// (Comic Sans MS, Impact) kept surfacing in directions. Free either way on
/// the subscription. Contrast between directions comes from the prompt;
/// this upstream has no temperature to lean on.
const INVENTION_UPSTREAM: Upstream = Upstream::ClaudeAgentSdk;
const INVENTION_MODEL: &str = "sonnet";

/// Generation is the step the whole product is judged on, so it does not.
///
/// Measured on this exact prompt, one direction, one state: `gpt-4o-mini`
/// returned 1.6 KB — valid, correctly sized, palette used properly, and a
/// placeholder: one centred card, one heading, one button. Adding an explicit
/// density clause to the prompt moved it to 1.57 KB, i.e. not at all.
/// `claude-sonnet-4.5` on the same prompt returned 5.3 KB with real furniture.
///
/// Then measured again on 2026-08-03 with the upstream as the only variable:
/// `claude_agent_sdk` returned 9,280 chars in 33s at zero reported cost,
/// against 6,179 on openrouter for the same direction and state. Denser AND
/// free, because it runs on the machine's own Claude Code login.
const GENERATION_UPSTREAM: Upstream = Upstream::ClaudeAgentSdk;
const GENERATION_MODEL: &str = "sonnet";

/// Thinking ON for generation, which is the opposite of the first instinct.
///
/// It was disabled first, to stay clear of the 32K ceiling. Wrong call: at
/// ~10 KB of HTML we are nowhere near it, and deliberation is exactly what
/// makes a model budget vertical space. Same brief, same directions, four
/// configurations, counting cells whose content falls off the 400×720 frame or
/// is clipped inside it:
///
///   openrouter                      0 overflow · 3 clipped (183px) · 6/9 clean
///   openrouter + flex-column prompt 0 overflow · 7 clipped (291px) · 2/9 clean
///   claude_agent_sdk, thinking off  3 overflow (worst 1439px)      · 5/9 clean
///   claude_agent_sdk, thinking ON   0 overflow · 1 clipped (46px)  · 8/9 clean
///
/// The cost is wall-clock — 121s for nine cells against 79s — and nothing
/// else, since this upstream reports no tokens and no charge.
const GENERATION_THINKING: bool = true;

/// Hang detection belongs on the GAP BETWEEN CHUNKS, not on total duration.
/// The legacy app spent seven commits learning this: a healthy generation
/// legitimately runs for many minutes, while a wedged one goes silent at once.
const STALL: Duration = Duration::from_secs(120);
/// Labelled backstops. Every outer layer strictly outlasts every inner one.
const INVENT_TIMEOUT: Duration = Duration::from_secs(180);
const RENDER_TIMEOUT: Duration = Duration::from_secs(600);
/// A judge reads ~30 KB and writes ~2 KB — longer than invention, far shorter
/// than generation.
const SCORE_TIMEOUT: Duration = Duration::from_secs(300);

/// An anchor rides in as INPUT on every sibling state, so it is paid for once
/// per sibling. Generous, but bounded. Raised from 24K with the unboxing:
/// SVG-rich documents are legitimately bigger, and font payloads are elided
/// before the anchor ever reaches a prompt, so the budget buys real markup.
const MAX_ANCHOR_CHARS: usize = 48_000;

// ── Prompts ─────────────────────────────────────────────────────────────
//
// Carried from the legacy app, the one part of it worth keeping. The
// hard-won details: "genuinely different… not variations on one theme" is
// what stops three near-identical directions; the palette contract shouts
// "JSON ARRAY … Never an object" because a live model returned an object
// keyed by slot and crashed the old app; and `states` are chosen per brief
// and SHARED across directions, which is what makes a comparison grid
// meaningful instead of a mosaic.
//
// The closing REQUIRED clause states the real consequence, because there is
// no longer a safety net underneath it: `normalize_direction` rejects a
// direction missing a palette or a type choice rather than inventing one.
// Note the example palette is still an example — it is safe to keep now that
// nothing substitutes it silently when a model declines to answer.

const INVENT_PROMPT: &str = r##"You are a senior design director exploring visual directions for a design brief. Generate exactly 3 directions that are genuinely different from each other — not variations on one theme, but contrasting approaches in mood, visual weight, cultural reference, or era.

Consider the domain implied by the intent. A fintech product demands different visual language than a music festival poster or a children's app.

For each direction provide:
- name: Two-word evocative name (e.g. "Midnight Trust", "Paper Carnival")
- description: 2-3 sentences on visual strategy and emotional target. What does the viewer feel? What design tradition does this reference?
- palette: a JSON ARRAY of exactly 5 hex color strings in this order: background, surface, accent, text, muted — e.g. ["#101418", "#1b2129", "#ff6a3d", "#f2f2f2", "#7c8798"]. Never an object. Background and text MUST have sufficient contrast for readability. Accent should be distinct from background.
- families: a JSON ARRAY of 0-2 REAL typeface families from this kit (exact names; they will be embedded in the rendered documents): %FONT_MENU%. Pick faces that ARE the direction's voice — a direction that would sing in one of these should claim it; a direction whose era or culture calls for plain system type should take none.
- typography: how the type behaves — pairing, scale, contrast, case (e.g. "Fraunces display at poster scale over quiet grotesque body, generous smallcap labels"). If families is empty, name a system stack for headings and body (e.g. "Georgia, serif / system-ui, sans-serif").
- mood: 2-3 word mood descriptor
- voice: the copy tone this interface speaks in, with 1-2 example phrases in that voice — real UI copy, not description
- texture: the direction's material language — CSS surfaces (gradients, grain, layered shadows, border treatments, repeating patterns) AND drawn matter: inline SVG illustration, ornament, patterned grounds, decorative rules. Name what should be DRAWN, not just tinted
- motifs: the 2-3 repeatable marks that make this direction recognizable at a glance (e.g. "hairline double-rules, illuminated initial caps, wax-seal badges")
- audience: one sentence on who this direction is FOR — their taste, their context

Also provide "states": a JSON array of exactly 3 state names (views/screens/compositions) that make sense for this brief — a fintech app might get ["landing", "portfolio", "transactions"]; a concert poster might get ["announce", "lineup", "tickets"]. These are SHARED across all directions: every direction will render exactly these 3 states so they can be compared side by side. Do not default to "hero/dashboard/settings" unless those genuinely fit.

`palette` and `typography` are REQUIRED on every direction and are not filled in for you: a direction missing either is rejected and the whole invention fails, so give all 3 directions a full 5-colour array and a type description rather than leaving one thin.

Respond with a JSON object: {"directions": [...], "states": ["...", "...", "..."]}."##;

/// [`INVENT_PROMPT`] with the font-kit menu spliced in. A placeholder rather
/// than `format!` because the prompt is full of literal JSON braces.
fn invent_prompt() -> String {
    INVENT_PROMPT.replace("%FONT_MENU%", &fonts::menu())
}

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
- No external resources: nothing fetched over http(s) — no CDN links, no remote images, no Google Fonts. Everything the document needs lives inside it
- Inline SVG is a first-class material: illustration, iconography, ornament, patterned or textured grounds, decorative rules, expressive display lettering. Draw with <svg> elements, gradients, filters and <pattern> freely — a direction whose texture or motifs call for drawn matter should get REAL drawn matter, not a plain tinted rectangle standing in for it
- If the direction lists embedded font families, they are ALREADY loaded in this document by the tool — just use them: font-family: 'Family Name', <sensible fallback>. Do NOT write @font-face yourself. If it lists none, use the typography field's system stacks
- Valid XHTML: self-closing tags (<meta/>, <br/>), quoted attributes, no bare ampersands

Design quality:
- Use the palette semantically: bg= for page background, surface= for cards/panels, accent= for buttons and interactive highlights, text= for body copy, muted= for secondary text and borders
- Visual density, whitespace, and copy tone should reflect the mood
- Use realistic placeholder content — real-looking names, dollar amounts, dates, titles — not "Lorem ipsum" or "John Doe"
- Typography hierarchy: clear distinction between headings, subheadings, body, and labels
- Composition: consider visual weight distribution, focal points, and reading flow
- The DIRECTION leads — its era, culture, materials and motifs decide what this screen looks like, not web convention. Default-web grammar (a header bar, a hero, three rounded cards, a full-width button) is a failure of the assignment unless this direction genuinely calls for it. Ask: could this board belong to any product? If yes, push the direction's character harder — into the layout itself, not just the colours
- Craft still counts: whatever the era, the screen must be legible, composed, and deliberate. Character is not an excuse for mess

Completeness — a finished screen that FITS:
- The frame is exactly {ARTBOARD_WIDTH}×{ARTBOARD_HEIGHT} and DOES NOT SCROLL. `overflow: hidden` means anything past the bottom edge is invisible, not reachable. Everything you draw must fit inside it.
- Budget the vertical space before you write: header + content + any footer must sum to {ARTBOARD_HEIGHT}px or less. A list that runs off the bottom is WORSE than a shorter list — choose fewer rows over cut-off rows, and never let a row, card or button be sliced by the edge
- Do NOT rely on a scrollable or clipped region to absorb the excess. Content hidden inside an `overflow: hidden` box reads as cut off, exactly like content past the page edge
- Within that budget, compose to fill the frame. Deliberate whitespace is fine; an unfinished screen is not
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
    /// How the type behaves — pairing, scale, contrast; or a system stack
    /// when no kit families are claimed.
    pub typography: String,
    /// Embedded font-kit families (exact kit names, ≤2) — the tool injects
    /// their `@font-face` blocks into every rendered document. Optional so
    /// pre-kit stored explorations still parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub families: Option<Vec<String>>,
    /// 2-3 word mood descriptor.
    pub mood: String,
    /// Copy voice: the tone the interface speaks in, with 1-2 example
    /// phrases. Moodboard field — optional so pre-2026-08-04 stored
    /// explorations still parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    /// Material and texture language, in CSS-achievable terms (gradients,
    /// grain, layered shadows, border treatments, repeating patterns).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture: Option<String>,
    /// The repeatable marks that make the direction recognizable at a glance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motifs: Option<String>,
    /// Who this direction is for — feeds the fitness judges something real.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
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
    /// Caller-minted id for this whole exploration. Every later tool call —
    /// render, score, refine, across any number of agent runs — uses the SAME
    /// id; it is the key the daemon-database rows are scoped by.
    pub exploration_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RenderArgs {
    /// The direction to render, exactly as `invent_directions` returned it.
    pub direction: Direction,
    /// The exploration this render belongs to — same id given to
    /// `invent_directions`.
    pub exploration_id: String,
    /// Which direction this is, by its index in `invent_directions`' result.
    /// Keys the database rows that `score_direction` and `refine_state` read —
    /// artboards are ~9 KB each and do NOT travel through the agent's context.
    pub direction_index: u32,
    /// Every shared state in the exploration, in order. The first is the
    /// anchor.
    pub states: Vec<String>,
    /// Which of `states` to render now.
    pub label: String,
    /// Normally OMIT this. When rendering a non-anchor state, the tool reuses
    /// the direction's already-rendered first state from its own cache — the
    /// anchor's markup pins the shared chrome so the states read as one
    /// product, and it must never be echoed through the agent's context to
    /// get there. Pass this only to override the cache with different markup.
    #[serde(default)]
    pub anchor_html: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetExplorationArgs {
    /// The exploration to look up.
    pub exploration_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetStateArgs {
    /// The exploration — same id given to `invent_directions`.
    pub exploration_id: String,
    /// Which direction, by its `invent_directions` index.
    pub direction_index: u32,
    /// Which state to read back.
    pub label: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RefineArgs {
    /// The exploration — same id given to `invent_directions`.
    pub exploration_id: String,
    /// Which direction, by its `invent_directions` index.
    pub direction_index: u32,
    /// Which state to revise.
    pub label: String,
    /// The feedback to apply, verbatim — the user's words, or a judge's
    /// note. The revision changes ONLY what this demands.
    pub feedback: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Rendered {
    pub label: String,
    /// The stored document with font payloads ELIDED (`base64,ELIDED` stubs) —
    /// full bytes live only in the database and never ride an agent's context
    /// (the lean-transit rule). Viewers re-attach the kit at display time.
    pub html: String,
    /// Size of the FULL stored document, payloads included.
    pub bytes_stored: u64,
    /// Kit families whose embedded payload is in the stored document.
    pub fonts_embedded: Vec<String>,
    /// Inline `<svg>` elements in this document — drawn matter, measured.
    pub svg_used: u32,
}

/// The lean transit form of a stored document: payloads elided, real size and
/// materials reported. Every tool that hands a board to an agent returns THIS —
/// the full bytes stay in the database.
fn lean_rendered(label: &str, stored: &str) -> Rendered {
    Rendered {
        label: label.to_string(),
        bytes_stored: stored.len() as u64,
        fonts_embedded: fonts::embedded_families(stored),
        svg_used: stored.to_lowercase().matches("<svg").count() as u32,
        html: fonts::elide_font_payloads(stored),
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ScoreArgs {
    /// The design brief the direction was invented for — fitness is judged
    /// against THIS text, so pass it verbatim.
    pub brief: String,
    /// The exploration — same id given to `invent_directions`.
    pub exploration_id: String,
    /// Which direction to score, by its `invent_directions` index. Its
    /// artboards must already have been rendered (any run of this
    /// exploration) — `render_state` stores them in the daemon's database,
    /// and this tool reads those rows.
    pub direction_index: u32,
    /// The judge. REQUIRED, no default: the agent (and its human) choose the
    /// jury; phosphene owns only the rubric. Call this tool once per judge —
    /// the spread between judges is the signal, so pick models that differ.
    pub model: String,
    /// "openrouter" (default) or "claude_agent_sdk". Note claude also
    /// GENERATES the artboards, so a claude judge marks its own homework.
    #[serde(default)]
    pub upstream: Option<String>,
}

/// One judge's verdict on one direction. Four numbers, no aggregate — an
/// overall score would reintroduce the halo effect the separate dimensions
/// exist to prevent (docs/scoring.md §1).
#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Scores {
    /// Is it well made? Hierarchy, spacing, type, colour discipline, detail.
    pub craft: f64,
    /// Genuinely its own direction, or a generic template reskinned?
    pub distinctiveness: f64,
    /// Does it serve THIS brief, or would it suit any brief?
    pub fitness: f64,
    /// Do the states read as one product?
    pub coherence: f64,
}

/// The written why for each score, in Sadler form: the expected standard, the
/// gap, and how to close it — naming the element it is about.
#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Notes {
    pub craft: String,
    pub distinctiveness: String,
    pub fitness: String,
    pub coherence: String,
}

/// Computed, never judged — asking a model to eyeball arithmetic is strictly
/// worse than doing the arithmetic (docs/scoring.md §3). Frame fit is the one
/// fact NOT here: it needs layout, so the viewer computes it where the
/// artboards already render.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Facts {
    /// WCAG contrast ratios between declared palette slots (1.0–21.0).
    /// 4.5:1 is the AA threshold for body text.
    pub contrast: ContrastFacts,
    /// Does the document actually use its declared palette, or drift?
    pub palette: PaletteFacts,
    /// Do the declared fonts appear in the CSS? With kit families claimed,
    /// every family must be USED (outside the injected blocks); otherwise the
    /// declared stacks are checked.
    pub fonts_declared_used: bool,
    /// Kit families whose embedded payload is actually in the documents.
    pub fonts_embedded: Vec<String>,
    /// Inline `<svg>` elements across the states — drawn matter, measured.
    pub svg_used: u32,
    /// `<script` never appears (the sandbox enforces it; this reports it).
    pub javascript_free: bool,
    /// No `src=`/`href=`/`url(` pointing at http(s). The xmlns URI is exempt.
    pub external_free: bool,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ContrastFacts {
    pub text_on_bg: Option<f64>,
    pub text_on_surface: Option<f64>,
    pub muted_on_bg: Option<f64>,
    pub accent_on_bg: Option<f64>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct PaletteFacts {
    /// How many of the 5 declared colours appear in the markup.
    pub declared_used: u32,
    /// Distinct hex colours in the markup that are NOT in the palette.
    /// Palette drift is the failure Stitch is publicly known for, and it is
    /// invisible to a judge reading prose.
    pub foreign_colours: u32,
    /// Share of hex occurrences that are declared colours (0–1). Colours
    /// written as rgb()/named escape this net — an approximation, and labelled
    /// as one.
    pub adherence: f64,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ScoreResult {
    pub direction: String,
    /// The model that judged — echoed so a panel's results self-describe.
    pub judge: String,
    pub scores: Scores,
    pub notes: Notes,
    pub facts: Facts,
    /// Which states the judge saw, in order. Fewer than the full set means
    /// coherence was judged from a partial board — visible, not hidden.
    pub states_seen: Vec<String>,
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
// Eight arguments is at clippy's threshold, deliberately: every call site
// reads as a table of what differs between invention, generation and judging.
// A params struct would hide exactly that comparison.
#[allow(clippy::too_many_arguments)]
/// Translate a spawn failure into something the person reading it can act on.
///
/// The platform reports a lapsed Claude Code login as the literal string
/// "Claude Code returned an error result: success" — the runner surfaces the
/// result *subtype* rather than the 401. It is upstream's bug and cannot be
/// fixed here, but it is also the FIRST failure anyone who is not the author
/// hits, and a message containing the word "success" sends them looking
/// anywhere but at their login. So phosphene absorbs it.
fn spawn_error(upstream: Upstream, error: impl std::fmt::Display) -> rmcp::ErrorData {
    let raw = error.to_string();
    let lapsed_login = raw.contains("Claude Code returned an error result")
        || (raw.contains("error result") && raw.contains("success"));
    if lapsed_login && matches!(upstream, Upstream::ClaudeAgentSdk) {
        return internal(format!(
            "the daemon host's Claude Code login is not usable — run `claude` there and \
             sign in, then retry. (The platform reports this as \"{raw}\", which is the \
             result subtype rather than the auth error; it does not mean the call \
             succeeded.)"
        ));
    }
    internal(format!("agents spawn: {raw}"))
}

async fn run_agent(
    system: &str,
    user: &str,
    upstream: Upstream,
    model: &str,
    thinking: bool,
    temperature: f64,
    max_tokens: u32,
    timeout: Duration,
) -> Result<String, rmcp::ErrorData> {
    // Built as JSON rather than by hand. The resolved-agent type is a deep
    // untagged enum whose mis-construction fails with an error naming the
    // whole union and pointing nowhere useful — and THIS JSON is the exact
    // shape already proven against a live daemon.
    //
    // The two upstreams take DIFFERENT specs and getting it wrong is SILENT:
    // there is no `deny_unknown_fields`, so a stray `temperature` on a
    // claude_agent_sdk agent is dropped with no error, and since the agent id
    // hashes the normalized struct there is no signal at all.
    let spec = match upstream {
        Upstream::ClaudeAgentSdk => serde_json::json!({
            "upstream": "claude_agent_sdk",
            // A short alias, not a dated model id — the runner hands it
            // straight to the local `claude` binary.
            "model": model,
            // Required, and the only legal value.
            "output_mode": "instruction",
            // The ONLY lever on the 32K output ceiling: thinking tokens are
            // what consumed the legacy app's budget, and this upstream has no
            // `max_tokens` to raise instead.
            "thinking": thinking,
            "plugins": [],
            // A bare string. NOT {role, content} — that is openrouter's shape.
            "system_prompt": system,
        }),
        Upstream::OpenRouter => serde_json::json!({
            "upstream": "openrouter",
            "model": model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "plugins": [],
            // `system_prompt` is {role, content} here; a bare string does not
            // deserialize.
            "system_prompt": { "role": "system", "content": system },
        }),
    };
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
    .map_err(|error| spawn_error(upstream, error))?;
    let mut stream = std::pin::pin!(stream);

    // Assistant `content` arrives as DELTAS, accumulated by `index`.
    let mut parts: BTreeMap<u64, String> = BTreeMap::new();

    loop {
        let next = tokio::time::timeout(STALL, stream.next())
            .await
            .map_err(|_| internal(format!("the agent went silent for {}s", STALL.as_secs())))?;
        let Some(item) = next else { break };
        let item = item.map_err(|error| spawn_error(upstream, error))?;

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
    if let Some(value) = try_parse(trimmed) {
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
                return try_parse(&slice)
                    .ok_or_else(|| "recovered JSON did not parse".to_string());
            }
        }
    }
    let tail: String = trimmed.chars().rev().take(80).collect::<Vec<_>>().into_iter().rev().collect();
    Err(format!(
        "unterminated JSON in the model's response (likely truncated by the \
         token budget) — ends: …{tail}"
    ))
}

/// Parse, and if that fails, parse again with trailing commas removed.
///
/// A trailing comma before `}` or `]` is the one malformation models produce
/// often enough to be worth repairing, and the only one that is unambiguous:
/// JSON has no construct where it is meaningful, so removing it cannot change
/// what the model meant. Anything beyond this is guessing, and guessing is how
/// the legacy salvage ladder grew to four layers. Observed live.
fn try_parse(slice: &str) -> Option<serde_json::Value> {
    if let Ok(value) = serde_json::from_str(slice) {
        return Some(value);
    }
    serde_json::from_str(&strip_trailing_commas(slice)).ok()
}

/// Remove `,` that only separates nothing from a closing brace or bracket.
/// String contents are skipped, so a comma inside a value is untouched.
fn strip_trailing_commas(json: &str) -> String {
    let chars: Vec<char> = json.chars().collect();
    let mut out = String::with_capacity(json.len());
    let mut in_string = false;
    let mut escaped = false;
    for (i, ch) in chars.iter().enumerate() {
        if in_string {
            out.push(*ch);
            if escaped {
                escaped = false;
            } else if *ch == '\\' {
                escaped = true;
            } else if *ch == '"' {
                in_string = false;
            }
            continue;
        }
        if *ch == '"' {
            in_string = true;
            out.push(*ch);
            continue;
        }
        if *ch == ',' {
            // Look past whitespace: a comma before a closer separates nothing.
            let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
            if matches!(next, Some('}') | Some(']')) {
                continue;
            }
        }
        out.push(*ch);
    }
    out
}

/// Pull the document out of a generation response.
///
/// Layer 1 is the contract, `{"label", "html"}`, plus the legacy wrapper
/// `{"states":[…]}` a model occasionally answers with anyway. Layer 2 is the
/// far more common miss — the model ignores the JSON envelope and simply
/// writes the document. Taking it is strictly better than failing the cell.
fn extract_html(text: &str, label: &str) -> Result<String, String> {
    if let Ok(value) = parse_json_loose(text) {
        if let Some(html) = value.get("html").and_then(|h| h.as_str())
            && !html.trim().is_empty()
        {
            return Ok(html.to_string());
        }
        if let Some(states) = value.get("states").and_then(|s| s.as_array()) {
            let chosen = states
                .iter()
                .find(|state| state.get("label").and_then(|l| l.as_str()) == Some(label))
                .or_else(|| states.first());
            if let Some(html) = chosen.and_then(|s| s.get("html")).and_then(|h| h.as_str())
                && !html.trim().is_empty()
            {
                return Ok(html.to_string());
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

/// Normalize one direction. Optional flavour defaults; the DESIGN DECISIONS
/// do not — see `normalize_direction`.
fn opt_field(raw: &serde_json::Value, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// NO FABRICATED DESIGN DECISIONS. A palette and a type choice are the
/// direction — if the model did not make them, phosphene does not make them
/// on its behalf and call the result a direction.
///
/// This used to substitute a FALLBACK palette that was byte-for-byte the
/// example in `INVENT_PROMPT`, unflagged, and `compute_facts` then measured
/// "palette adherence" against colours no model ever chose. The same lie had
/// a twin in `viewer/src/lib/directions.ts`. Both are gone: a direction
/// missing either decision is an error naming the direction and the field.
///
/// Flavour (name, description, mood, voice, texture, motifs, audience) still
/// defaults — those are labels and prose, not decisions, and a missing one
/// costs that field rather than the run.
fn normalize_direction(raw: &serde_json::Value, index: usize) -> Result<Direction, String> {
    const SLOTS: [&str; 5] = ["background", "surface", "accent", "text", "muted"];

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

    let name = match raw.get("name").and_then(|value| value.as_str()) {
        Some(name) => name.to_string(),
        None => format!("Direction {}", index + 1),
    };

    if palette.len() != 5 {
        return Err(format!(
            "direction {} (\"{name}\") returned {} usable palette colours, not 5 — \
             phosphene will not invent the rest. Expected an array of 5 hex strings \
             in slot order (background, surface, accent, text, muted), or an object \
             keyed by those slot names.",
            index, palette.len()
        ));
    }

    // A silent "system-ui, sans-serif" here would quietly undo the font kit for
    // that direction — the exact system-stack look E1 shipped to escape.
    let typography = match raw.get("typography").and_then(|value| value.as_str()) {
        Some(typography) if !typography.trim().is_empty() => typography.to_string(),
        _ => {
            return Err(format!(
                "direction {index} (\"{name}\") returned no typography — phosphene \
                 will not substitute a system font stack. Expected a font-family \
                 string."
            ))
        }
    };

    Ok(Direction {
        name,
        description: field("description"),
        palette,
        typography,
        families: raw
            .get("families")
            .and_then(|value| value.as_array())
            .map(|items| {
                let names: Vec<String> = items
                    .iter()
                    .filter_map(|f| f.as_str().map(str::to_string))
                    .collect();
                // Unknown names cost themselves, not the direction.
                fonts::canonical(&names)
            })
            .filter(|families| !families.is_empty()),
        mood: field("mood"),
        voice: opt_field(raw, "voice"),
        texture: opt_field(raw, "texture"),
        motifs: opt_field(raw, "motifs"),
        audience: opt_field(raw, "audience"),
    })
}

/// The embedded-families line, wherever a direction is described to a
/// working model. The families are a FACT about the document (the tool
/// injects them), so every reader — renderer, reviser, judge — is told.
fn families_line(direction: &Direction) -> String {
    match &direction.families {
        Some(families) if !families.is_empty() => format!(
            "\nEmbedded fonts (already loaded in the document — use via font-family): {}",
            families
                .iter()
                .map(|f| format!("'{f}'"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        _ => String::new(),
    }
}

/// The moodboard lines, appended wherever a direction is described to a
/// working model — render, refine, judge. Personality is INPUT: the renderer
/// produces exactly as much of it as the direction carries.
fn moodboard_lines(direction: &Direction) -> String {
    let mut out = String::new();
    if let Some(v) = &direction.voice {
        out.push_str(&format!("\nVoice: {v}"));
    }
    if let Some(t) = &direction.texture {
        out.push_str(&format!("\nTexture & materials (render these in CSS): {t}"));
    }
    if let Some(m) = &direction.motifs {
        out.push_str(&format!("\nMotifs (repeat these marks): {m}"));
    }
    if let Some(a) = &direction.audience {
        out.push_str(&format!("\nAudience: {a}"));
    }
    out
}

fn normalize_invention(parsed: &serde_json::Value) -> Result<Invention, String> {
    // One bad direction fails the invention rather than being dropped: the
    // whole procedure downstream is a fixed 3x3 grid keyed by direction_index,
    // so silently returning two directions would desync every render call.
    let directions: Vec<Direction> = parsed
        .get("directions")
        .and_then(|directions| directions.as_array())
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, raw)| normalize_direction(raw, index))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
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

// ── Judging ─────────────────────────────────────────────────────────────
//
// One call = one judge on one direction. The rubric here is phosphene's; the
// jury is the agent's. Dimensions are Maya's four; calibration and critique
// form are the legacy research's (docs/scoring.md).

/// The judge's brief. Deliberately NOT asked for: an overall score (halo
/// effect), usability/interaction judgments (documented unreliable from
/// static markup), or anything the facts compute (arithmetic is not opinion).
fn judge_system_prompt() -> String {
    "You are one judge on a design jury, scoring ONE design direction rendered as \
     static screens. Other judges score independently; disagreement between judges \
     is expected and valuable, so score from your own reading, not from what a \
     typical reviewer would say.\n\n\
     Score EXACTLY these four dimensions, each 0.0-1.0:\n\
     - craft: is it well made? Visual hierarchy, spacing rhythm, typographic \
     discipline, colour usage, drawn detail.\n\
     - distinctiveness: is this genuinely its own direction, or a generic \
     template with the palette swapped?\n\
     - fitness: does it serve THIS brief specifically, or would it suit any \
     brief? Judge against the brief text you are given.\n\
     - coherence: do the states read as one product? Same chrome, same spacing \
     scale, same component language.\n\n\
     Calibration — anchor to these, and use the whole scale:\n\
     0.5 = generic (competent, forgettable) · 0.7 = good · 0.85 = \
     portfolio-worthy · 0.95 = exceptional.\n\n\
     For each dimension write ONE note in exactly three parts: the expected \
     standard, the gap between this design and that standard, and how to close \
     it. Name the specific element each note is about (a selector, a component, \
     a region) — a note that names nothing is not actionable. Write improvement \
     instructions, not opinions.\n\n\
     Do NOT score usability or interactions (you are reading static markup), do \
     NOT compute contrast ratios (they are measured separately), and do NOT give \
     an overall score.\n\n\
     Respond with ONLY this JSON object:\n\
     {\"scores\": {\"craft\": 0.0, \"distinctiveness\": 0.0, \"fitness\": 0.0, \
     \"coherence\": 0.0}, \"notes\": {\"craft\": \"...\", \"distinctiveness\": \
     \"...\", \"fitness\": \"...\", \"coherence\": \"...\"}}"
        .to_string()
}

fn judge_user_prompt(brief: &str, d: &Direction, ordered: &[(String, String)]) -> String {
    let slots = ["bg", "surface", "accent", "text", "muted"];
    let palette = slots
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{s}={}", d.palette.get(i).map(String::as_str).unwrap_or("?")))
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = format!(
        "Brief: {brief}\n\nDirection: \"{}\" — {}\nPalette: {palette}\nTypography: {}\nMood: {}{}{}\n",
        d.name,
        d.description,
        d.typography,
        d.mood,
        families_line(d),
        // The judges see the same moodboard the renderer aimed for — audience
        // gives fitness something real; texture and motifs give craft and
        // distinctiveness a stated intent to hold the pixels against.
        moodboard_lines(d),
    );
    for (label, html) in ordered {
        // Payloads elided: a judge needs the @font-face NAME, never its bytes.
        let lean = fonts::elide_font_payloads(html);
        out.push_str(&format!("\n─── state \"{label}\" ───\n{lean}\n"));
    }
    out
}

/// Read one 0–1 score, clamped. A missing dimension fails the judge — a
/// four-dimension rubric with three answers is not a partial success.
fn read_score(scores: &serde_json::Value, key: &str) -> Result<f64, String> {
    scores
        .get(key)
        .and_then(|v| v.as_f64())
        .map(|v| v.clamp(0.0, 1.0))
        .ok_or_else(|| format!("judge returned no numeric \"{key}\" score"))
}

fn read_note(notes: &serde_json::Value, key: &str) -> String {
    notes
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

// ── Computed facts ──────────────────────────────────────────────────────

/// Parse `#rgb` / `#rrggbb` to bytes. Anything else — rgb(), named colours,
/// alpha channels — is out of scope and the facts say so where it matters.
fn parse_hex(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim().trim_start_matches('#');
    let expand = |s: &str| -> Option<Vec<u8>> {
        s.chars()
            .map(|c| c.to_digit(16).map(|d| (d * 17) as u8))
            .collect()
    };
    match h.len() {
        3 => expand(h).map(|v| [v[0], v[1], v[2]]),
        6 => {
            let bytes = (0..3)
                .map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).ok())
                .collect::<Option<Vec<u8>>>()?;
            Some([bytes[0], bytes[1], bytes[2]])
        }
        _ => None,
    }
}

/// WCAG 2.x relative luminance → contrast ratio, 1.0–21.0. 4.5:1 is the AA
/// floor for body text. Arithmetic, not judgment — which is why it is a fact.
fn contrast_ratio(a: &str, b: &str) -> Option<f64> {
    fn luminance(rgb: [u8; 3]) -> f64 {
        let lin = |c: u8| {
            let c = c as f64 / 255.0;
            if c <= 0.03928 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
    }
    let (la, lb) = (luminance(parse_hex(a)?), luminance(parse_hex(b)?));
    let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
    Some(((hi + 0.05) / (lo + 0.05) * 100.0).round() / 100.0)
}

/// Every 6-char-normalized hex colour in the markup, with occurrence counts.
fn hex_occurrences(html: &str) -> std::collections::HashMap<String, u32> {
    let mut out: std::collections::HashMap<String, u32> = Default::default();
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            let run: String = html[i + 1..]
                .chars()
                .take_while(|c| c.is_ascii_hexdigit())
                .take(8)
                .collect();
            let key = match run.len() {
                3 => Some(run.chars().flat_map(|c| [c, c]).collect::<String>()),
                6 | 8 => Some(run[..6].to_string()),
                _ => None,
            };
            if let Some(k) = key {
                *out.entry(k.to_lowercase()).or_insert(0) += 1;
            }
            i += 1 + run.len();
        } else {
            i += 1;
        }
    }
    out
}

fn compute_facts(direction: &Direction, artboards: &[(String, String)]) -> Facts {
    let p = |i: usize| direction.palette.get(i).map(String::as_str).unwrap_or("");
    let (bg, surface, accent, text, muted) = (p(0), p(1), p(2), p(3), p(4));

    let all_html: String = artboards.iter().map(|(_, h)| h.as_str()).collect();
    let seen = hex_occurrences(&all_html);
    let declared: Vec<String> = direction
        .palette
        .iter()
        .filter_map(|h| parse_hex(h).map(|[r, g, b]| format!("{r:02x}{g:02x}{b:02x}")))
        .collect();

    let declared_used = declared.iter().filter(|d| seen.contains_key(*d)).count() as u32;
    let foreign_colours = seen.keys().filter(|k| !declared.contains(k)).count() as u32;
    let total: u32 = seen.values().sum();
    let declared_hits: u32 = declared.iter().filter_map(|d| seen.get(d)).sum();
    let adherence = if total == 0 {
        0.0
    } else {
        (declared_hits as f64 / total as f64 * 100.0).round() / 100.0
    };

    // Declared-type usage is measured OUTSIDE the injected kit blocks — an
    // embedded face nobody set in a `font-family` rule was declared, not used.
    let lean_lower: String = artboards
        .iter()
        .map(|(_, h)| fonts::strip_kit_faces(h).to_lowercase())
        .collect();
    let lower = all_html.to_lowercase();
    let fonts_declared_used = match &direction.families {
        // Kit families claimed: every one must actually be USED in the css.
        Some(families) if !families.is_empty() => families
            .iter()
            .all(|family| lean_lower.contains(&family.to_lowercase())),
        // No kit claim: first family of each declared stack ("Georgia, serif /
        // system-ui, …" → Georgia, system-ui), case-insensitively.
        _ => direction
            .typography
            .split('/')
            .filter_map(|half| half.split(',').next())
            .map(|f| f.trim().trim_matches(|c| c == '"' || c == '\'').to_lowercase())
            .filter(|f| !f.is_empty())
            .all(|f| lean_lower.contains(&f)),
    };

    // What the kit actually delivered: families whose @font-face payload is
    // present in the stored documents.
    let fonts_embedded: Vec<String> = direction
        .families
        .iter()
        .flatten()
        .filter(|family| {
            lower.contains(&format!("font-family:'{}';", family).to_lowercase())
                && lower.contains("data:font/woff2;base64,")
        })
        .cloned()
        .collect();

    // Drawn matter, counted — the unboxing's other material.
    let svg_used = lower.matches("<svg").count() as u32;

    // The required xmlns URI is `xmlns="http…"` — none of these needles match
    // it, so compliant documents pass without an exemption list.
    let external_free = !["src=\"http", "src='http", "href=\"http", "href='http", "url(http"]
        .iter()
        .any(|needle| lower.contains(needle));

    Facts {
        contrast: ContrastFacts {
            text_on_bg: contrast_ratio(text, bg),
            text_on_surface: contrast_ratio(text, surface),
            muted_on_bg: contrast_ratio(muted, bg),
            accent_on_bg: contrast_ratio(accent, bg),
        },
        palette: PaletteFacts { declared_used, foreign_colours, adherence },
        fonts_declared_used,
        fonts_embedded,
        svg_used,
        javascript_free: !lower.contains("<script"),
        external_free,
    }
}

#[cfg(test)]
mod lean_rendered_tests {
    use super::*;

    #[tokio::test]
    async fn lean_result_reports_the_stored_document() {
        let html = "<html xmlns=\"x\"><head><style>b{}</style></head>\
                    <body><svg viewBox=\"0 0 8 8\"><circle r=\"4\"/></svg>\
                    <svg viewBox=\"0 0 4 4\"/></body></html>";
        let stored = fonts::inject(html, &["Space Mono".to_string()]).await;
        let lean = lean_rendered("night map", &stored);
        assert_eq!(lean.label, "night map");
        assert_eq!(lean.bytes_stored, stored.len() as u64);
        assert_eq!(lean.fonts_embedded, vec!["Space Mono"]);
        assert_eq!(lean.svg_used, 2);
        // The transit form carries the stub, never a payload.
        assert!(lean.html.contains("base64,ELIDED"));
        assert!(fonts::embedded_families(&lean.html).is_empty());
        assert!((lean.html.len() as u64) < lean.bytes_stored / 2);
    }
}

/// The no-fabrication rule, which is a product decision and not an
/// implementation detail: if a model did not make a design decision,
/// phosphene does not make it on the model's behalf. These exist so the
/// FALLBACK palette cannot quietly come back.
#[cfg(test)]
mod no_fabrication_tests {
    use super::*;

    fn good() -> serde_json::Value {
        serde_json::json!({
            "name": "Ink Lantern",
            "description": "warm paper, cold ink",
            "palette": ["#101418", "#1b2129", "#ff6a3d", "#f2f2f2", "#7c8798"],
            "typography": "Fraunces, serif",
            "mood": "quiet"
        })
    }

    #[test]
    fn a_complete_direction_is_accepted_verbatim() {
        let d = normalize_direction(&good(), 0).expect("complete direction");
        assert_eq!(d.name, "Ink Lantern");
        assert_eq!(d.palette.len(), 5);
        assert_eq!(d.palette[2], "#ff6a3d");
        assert_eq!(d.typography, "Fraunces, serif");
    }

    #[test]
    fn a_slot_keyed_palette_object_still_works() {
        let mut raw = good();
        raw["palette"] = serde_json::json!({
            "background": "#101418", "surface": "#1b2129", "accent": "#ff6a3d",
            "text": "#f2f2f2", "muted": "#7c8798"
        });
        let d = normalize_direction(&raw, 0).expect("slot-keyed palette");
        assert_eq!(d.palette.len(), 5);
    }

    #[test]
    fn a_short_palette_fails_instead_of_being_filled_in() {
        let mut raw = good();
        raw["palette"] = serde_json::json!(["#101418", "#1b2129"]);
        let err = normalize_direction(&raw, 1).expect_err("must not invent colours");
        assert!(err.contains("2 usable palette colours"), "{err}");
        assert!(err.contains("Ink Lantern"), "names the direction: {err}");
    }

    #[test]
    fn a_missing_palette_fails_instead_of_being_filled_in() {
        let mut raw = good();
        raw.as_object_mut().unwrap().remove("palette");
        assert!(normalize_direction(&raw, 0).is_err());
    }

    #[test]
    fn missing_typography_fails_instead_of_defaulting_to_a_system_stack() {
        let mut raw = good();
        raw.as_object_mut().unwrap().remove("typography");
        let err = normalize_direction(&raw, 2).expect_err("must not invent type");
        assert!(err.contains("no typography"), "{err}");
        // The whole point of E1: never silently return to system-ui.
        assert!(!err.contains("system-ui"));
    }

    #[test]
    fn blank_typography_is_treated_as_missing() {
        let mut raw = good();
        raw["typography"] = serde_json::json!("   ");
        assert!(normalize_direction(&raw, 0).is_err());
    }

    #[test]
    fn flavour_still_defaults_a_missing_name_is_not_a_failure() {
        let mut raw = good();
        raw.as_object_mut().unwrap().remove("name");
        raw.as_object_mut().unwrap().remove("mood");
        let d = normalize_direction(&raw, 4).expect("flavour is not a design decision");
        assert_eq!(d.name, "Direction 5");
        assert_eq!(d.mood, "");
    }

    #[test]
    fn one_bad_direction_fails_the_whole_invention() {
        // Dropping it instead would desync the fixed 3x3 grid, which is keyed
        // by direction_index on every downstream render call.
        let mut bad = good();
        bad["palette"] = serde_json::json!([]);
        let parsed = serde_json::json!({
            "directions": [good(), bad, good()],
            "states": ["home", "detail", "empty"]
        });
        let err = normalize_invention(&parsed).expect_err("one bad direction fails the set");
        assert!(err.contains("direction 1"), "names which one: {err}");
    }

    #[test]
    fn a_lapsed_claude_login_stops_saying_success() {
        let raw = "Claude Code returned an error result: success";
        let msg = format!("{:?}", spawn_error(Upstream::ClaudeAgentSdk, raw));
        assert!(msg.contains("login is not usable"), "{msg}");
        assert!(msg.contains("run `claude`"), "actionable: {msg}");
        // On openrouter the same string means nothing — do not mistranslate.
        let other = format!("{:?}", spawn_error(Upstream::OpenRouter, raw));
        assert!(other.contains("agents spawn:"), "{other}");
        assert!(!other.contains("login is not usable"));
    }

    #[test]
    fn an_ordinary_spawn_error_is_passed_through() {
        let msg = format!("{:?}", spawn_error(Upstream::ClaudeAgentSdk, "connection refused"));
        assert!(msg.contains("agents spawn: connection refused"), "{msg}");
    }

    #[test]
    fn a_whole_good_invention_passes() {
        let parsed = serde_json::json!({
            "directions": [good(), good(), good()],
            "states": ["home", "detail", "empty"]
        });
        let inv = normalize_invention(&parsed).expect("all directions complete");
        assert_eq!(inv.directions.len(), 3);
        assert_eq!(inv.states.len(), 3);
    }
}

#[cfg(test)]
mod facts_tests {
    use super::*;

    #[test]
    fn contrast_hits_wcag_reference_points() {
        // Black on white is the definitional maximum.
        assert_eq!(contrast_ratio("#000000", "#ffffff"), Some(21.0));
        // Same colour is the definitional minimum.
        assert_eq!(contrast_ratio("#ffffff", "#ffffff"), Some(1.0));
        // #767676 on white is the canonical "just passes AA" grey (~4.54).
        let aa = contrast_ratio("#767676", "#ffffff").unwrap();
        assert!((4.4..4.7).contains(&aa), "got {aa}");
        // Order must not matter.
        assert_eq!(
            contrast_ratio("#123456", "#fedcba"),
            contrast_ratio("#fedcba", "#123456")
        );
        // 3-char shorthand expands.
        assert_eq!(contrast_ratio("#000", "#fff"), Some(21.0));
        // Garbage is None, not a wrong number.
        assert_eq!(contrast_ratio("plaid", "#ffffff"), None);
    }

    #[test]
    fn hex_occurrences_normalizes_and_counts() {
        let html = r##"<style>body{background:#FDF6E3;color:#2b2a26}.a{color:#fdf6e3}
                       .b{border-color:#ABC}.c{outline:#aabbcc80}</style>"##;
        let seen = hex_occurrences(html);
        assert_eq!(seen.get("fdf6e3"), Some(&2)); // case-folded, counted
        assert_eq!(seen.get("2b2a26"), Some(&1));
        assert_eq!(seen.get("aabbcc"), Some(&2)); // #ABC expands; #aabbcc80 drops alpha
    }

    #[test]
    fn palette_facts_measure_drift() {
        let direction = Direction {
            name: "t".into(),
            description: String::new(),
            palette: ["#111111", "#222222", "#333333", "#444444", "#555555"]
                .map(String::from)
                .to_vec(),
            typography: "Georgia, serif / system-ui, sans-serif".into(),
            mood: String::new(),
            families: None,
            voice: None,
            texture: None,
            motifs: None,
            audience: None,
        };
        let html = "<style>a{color:#111111}b{color:#111111}c{color:#999999}\
                    d{font-family:Georgia,serif}e{font-family:system-ui}</style>";
        let facts = compute_facts(&direction, &[("s".into(), html.into())]);
        assert_eq!(facts.palette.declared_used, 1); // only #111111 appears
        assert_eq!(facts.palette.foreign_colours, 1); // #999999
        assert!((facts.palette.adherence - 0.67).abs() < 0.01); // 2 of 3 occurrences
        assert!(facts.fonts_declared_used);
        assert!(facts.javascript_free);
        assert!(facts.external_free);
    }

    #[test]
    fn external_and_script_detection() {
        let dirty = r#"<script>x()</script><img src="https://cdn.example/x.png"/>"#;
        let d = Direction {
            name: "t".into(),
            description: String::new(),
            palette: vec!["#000000".into(); 5],
            typography: "serif".into(),
            mood: String::new(),
            families: None,
            voice: None,
            texture: None,
            motifs: None,
            audience: None,
        };
        let facts = compute_facts(&d, &[("s".into(), dirty.into())]);
        assert!(!facts.javascript_free);
        assert!(!facts.external_free);
        // The mandatory xmlns URI must NOT trip the external check.
        let clean = r#"<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>"#;
        let facts = compute_facts(&d, &[("s".into(), clean.into())]);
        assert!(facts.external_free);
    }

    #[test]
    fn kit_facts_measure_embedding_usage_and_svg() {
        let d = Direction {
            name: "t".into(),
            description: String::new(),
            palette: vec!["#000000".into(); 5],
            typography: "Oswald poster display over quiet body".into(),
            families: Some(vec!["Oswald".into(), "Fraunces".into()]),
            mood: String::new(),
            voice: None,
            texture: None,
            motifs: None,
            audience: None,
        };
        // Oswald: injected AND used in body css. Fraunces: injected, never used.
        let html = "<style>\
                    @font-face{font-family:'Oswald';font-style:normal;font-weight:400;\
                    src:url(data:font/woff2;base64,AAAA) format('woff2')}\n\
                    @font-face{font-family:'Fraunces';font-style:normal;font-weight:400;\
                    src:url(data:font/woff2;base64,BBBB) format('woff2')}\n\
                    h1{font-family:'Oswald',sans-serif}</style>\
                    <svg viewBox=\"0 0 8 8\"><circle r=\"4\"/></svg>";
        let facts = compute_facts(&d, &[("s".into(), html.into())]);
        assert_eq!(
            facts.fonts_embedded,
            vec!["Oswald".to_string(), "Fraunces".to_string()]
        );
        assert_eq!(facts.svg_used, 1);
        // Fraunces is claimed but never set in a rule — declared-used fails.
        assert!(!facts.fonts_declared_used);
        // An embedded data: font must never trip the external check.
        assert!(facts.external_free);

        // With only the used family claimed, the check passes.
        let d_used = Direction {
            families: Some(vec!["Oswald".into()]),
            ..d
        };
        let facts = compute_facts(&d_used, &[("s".into(), html.into())]);
        assert!(facts.fonts_declared_used);
        assert_eq!(facts.fonts_embedded, vec!["Oswald".to_string()]);
    }

    #[test]
    fn scores_are_clamped_and_required() {
        let v: serde_json::Value =
            serde_json::json!({ "craft": 1.7, "fitness": -0.2, "coherence": "high" });
        assert_eq!(read_score(&v, "craft"), Ok(1.0));
        assert_eq!(read_score(&v, "fitness"), Ok(0.0));
        assert!(read_score(&v, "coherence").is_err()); // string is not a score
        assert!(read_score(&v, "distinctiveness").is_err()); // absent fails loudly
    }
}

// ── The plugin ──────────────────────────────────────────────────────────

/// The plugin server itself. It holds no artboards — the struct that once
/// cached them per direction is gone; storage is the daemon's postgres.
///
/// The reason artboards are stored rather than passed still stands: ~9 KB per
/// artboard cannot ride back through the orchestrating agent's context — it
/// would have to echo ~27 KB verbatim into tool arguments, which is expensive
/// and which models get wrong.
/// Every tool receives `&Self`. Phosphene's tools hold NOTHING in-process:
/// artboards live in the daemon's postgres, because ITERATION outlives the
/// container. This is the pre-written reversal of the `postgres: false`
/// deviation — the in-process cache died with each completion's container,
/// and a refine round is by definition a later completion. The database is
/// the daemon's, shared: distinctly-named tables, rows scoped by
/// exploration_id.
#[derive(Clone)]
struct Plugin;

/// One guard for all DDL — created on first use; a plugin container has
/// nowhere to run a migration.
///
/// ACCESS MODEL, deliberate: rows are keyed by `exploration_id` alone and NOT
/// scoped by `identity().agent_instance_hierarchy`, which is what `mcp/README.md`
/// otherwise tells plugin authors to do. Scoping by agent would make an
/// exploration readable only by the agent that made it, and that is exactly
/// what `resume` and `refine` must cross — every later run is a different
/// agent instance. So the id IS the capability: the viewer mints it with
/// `crypto.randomUUID()` (v4, 122 bits of entropy), holding one grants read
/// and write, and guessing one is not a threat model. The database is shared
/// with every other plugin, so this is a real decision rather than an
/// oversight — see `mcp/README.md`.
static TABLES: OnceCell<()> = OnceCell::const_new();

const CREATE_TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS phosphene_explorations (
    exploration_id TEXT PRIMARY KEY,
    brief          TEXT NOT NULL,
    directions     JSONB NOT NULL,
    states         JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS phosphene_artboards (
    exploration_id  TEXT NOT NULL,
    direction_index INT  NOT NULL,
    label           TEXT NOT NULL,
    html            TEXT NOT NULL,
    round           INT  NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (exploration_id, direction_index, label)
);
"#;

/// The pool, with the DDL guaranteed to have run once. Plain `sqlx::query`,
/// never the compile-time-checked macro — the database a plugin talks to does
/// not exist until a host creates its container.
async fn pool() -> Result<db::Pool, rmcp::ErrorData> {
    let pool = db::connect(Default::default())
        .await
        .map_err(|error| internal(error_chain("connect to the database", &*error)))?;
    TABLES
        .get_or_try_init(|| async {
            // One statement per query — the pg wire protocol rejects
            // multi-statement prepared queries.
            for ddl in CREATE_TABLES.split(';').filter(|d| !d.trim().is_empty()) {
                sqlx::query(ddl).execute(&pool).await.map(|_| ())?;
            }
            Ok::<(), sqlx::Error>(())
        })
        .await
        .map_err(|error| internal(error_chain("create the tables", &error)))?;
    Ok(pool)
}

/// sqlx's top-level Display is often just "error returned from database
/// server" — the cause lives in the source chain, and whoever reads this
/// gets one string.
fn error_chain(doing: &str, error: &dyn std::error::Error) -> String {
    let mut message = format!("{doing}: {error}");
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    message
}

/// One direction + the shared state list, from the exploration row.
async fn load_direction(
    pool: &db::Pool,
    exploration_id: &str,
    index: u32,
) -> Result<(Direction, Vec<String>), rmcp::ErrorData> {
    use sqlx::Row as _;
    let row = sqlx::query(
        "SELECT directions, states FROM phosphene_explorations WHERE exploration_id = $1",
    )
    .bind(exploration_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| internal(error_chain("read the exploration", &e)))?
    .ok_or_else(|| {
        internal(format!(
            "no exploration {exploration_id} — invent_directions creates it, \
             with this same exploration_id"
        ))
    })?;
    let directions: Vec<Direction> = serde_json::from_value(row.get("directions"))
        .map_err(|e| internal(format!("stored directions did not parse: {e}")))?;
    let states: Vec<String> = serde_json::from_value(row.get("states"))
        .map_err(|e| internal(format!("stored states did not parse: {e}")))?;
    let direction = directions.into_iter().nth(index as usize).ok_or_else(|| {
        internal(format!("exploration {exploration_id} has no direction {index}"))
    })?;
    Ok((direction, states))
}

/// (label, html) pairs in INVENTION order — what a judge is shown.
async fn load_artboards(
    pool: &db::Pool,
    exploration_id: &str,
    index: u32,
    states: &[String],
) -> Result<Vec<(String, String)>, rmcp::ErrorData> {
    use sqlx::Row as _;
    let rows = sqlx::query(
        "SELECT label, html FROM phosphene_artboards
         WHERE exploration_id = $1 AND direction_index = $2",
    )
    .bind(exploration_id)
    .bind(index as i32)
    .fetch_all(pool)
    .await
    .map_err(|e| internal(error_chain("read the artboards", &e)))?;
    let mut by_label: std::collections::HashMap<String, String> = rows
        .into_iter()
        .map(|r| (r.get::<String, _>("label"), r.get::<String, _>("html")))
        .collect();
    Ok(states
        .iter()
        .filter_map(|label| by_label.remove(label).map(|html| (label.clone(), html)))
        .collect())
}

/// Revision, not redesign — the system prompt's whole job is restraint.
fn refine_system_prompt(states: &[String], label: &str, anchor_html: Option<&str>) -> String {
    let consistency = match anchor_html {
        Some(html) => {
            let truncated: String = html.chars().take(MAX_ANCHOR_CHARS).collect();
            format!(
                "The direction's anchor state is already rendered — the revision must \
                 keep matching its visual language (header/nav markup, spacing scale, \
                 component styling). Here it is:\n\n{truncated}"
            )
        }
        None => "This is the direction's ANCHOR state — its sibling states are pinned \
                 to its markup, so preserve the shared chrome (header/nav, spacing \
                 scale, component styling) unless the feedback explicitly targets it."
            .to_string(),
    };
    let requirements = requirements();
    format!(
        "You are revising ONE state of an existing design direction. You will receive \
         the current document and one piece of feedback. Apply the feedback precisely \
         and change NOTHING else — same layout, same content, same visual language \
         except where the feedback demands otherwise. This is a revision, not a \
         redesign.\n\n{consistency}\n\n{requirements}\n\nRespond with a JSON \
         object: {{\"label\": \"{label}\", \"html\": \"...\"}}. \
         (States in this exploration: {}.)",
        states
            .iter()
            .map(|s| format!("\"{s}\""))
            .collect::<Vec<_>>()
            .join(", "),
    )
}

fn refine_user_prompt(
    direction: &Direction,
    label: &str,
    current: &str,
    feedback: &str,
) -> String {
    format!(
        "Direction: \"{}\" — {}\nTypography: {}\nMood: {}{}\nState being revised: \
         \"{label}\"\n\nCURRENT DOCUMENT:\n{current}\n\nFEEDBACK TO APPLY:\n{feedback}",
        direction.name,
        direction.description,
        direction.typography,
        direction.mood,
        moodboard_lines(direction),
    )
}

#[rmcp::tool_router]
impl Plugin {
    #[rmcp::tool(
        description = "Invent 3 genuinely contrasting visual design directions for a \
                       design brief. Each carries a name, a described visual strategy, \
                       a 5-colour palette (background, surface, accent, text, muted), \
                       typeface families drawn from the kit embedded in every \
                       rendered document, a described type treatment and a mood. \
                       Also picks 3 states \
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
            &invent_prompt(),
            brief,
            INVENTION_UPSTREAM,
            INVENTION_MODEL,
            // Thinking on: choosing three genuinely different, tasteful
            // directions is judgment, and deliberation is where taste lives.
            true,
            // Ignored on claude_agent_sdk; kept for the openrouter branch.
            0.9,
            2000,
            INVENT_TIMEOUT,
        )
        .await?;

        let parsed = parse_json_loose(&text).map_err(internal)?;
        let invention = normalize_invention(&parsed).map_err(internal)?;

        // Persist — refine rounds are later completions and must find this.
        let pool = pool().await?;
        sqlx::query(
            "INSERT INTO phosphene_explorations (exploration_id, brief, directions, states)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (exploration_id)
             DO UPDATE SET brief = EXCLUDED.brief, directions = EXCLUDED.directions,
                           states = EXCLUDED.states",
        )
        .bind(args.exploration_id.trim())
        .bind(brief)
        .bind(serde_json::to_value(&invention.directions).map_err(|e| internal(e.to_string()))?)
        .bind(serde_json::to_value(&invention.states).map_err(|e| internal(e.to_string()))?)
        .execute(&pool)
        .await
        .map_err(|e| internal(error_chain("store the exploration", &e)))?;

        Ok(Json(invention))
    }

    #[rmcp::tool(
        description = "Render ONE state of ONE design direction as a complete, \
                       self-contained 400x720 XHTML document — no external resources, \
                       no JavaScript. The full document is STORED server-side; the \
                       result echoes it with font payloads elided plus what was \
                       delivered (bytes_stored, fonts_embedded, svg_used). Render a \
                       direction's FIRST state first; when you then render its \
                       remaining states, the tool automatically reuses that first \
                       document from storage to pin the shared chrome (nav, \
                       spacing scale, component styling), so the states read as one \
                       product. You never pass HTML between calls. Different \
                       directions are independent — order within a direction, anchor \
                       first, is all that matters."
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

        // The anchor: explicit override first, else the direction's cached
        // first state. Pinning happens plugin-side so ~9 KB of markup never
        // rides through the orchestrating agent's context — the same
        // cache-not-context rule score_direction lives by.
        let anchor_html: Option<String> = match (&args.anchor_html, states.first()) {
            (Some(explicit), _) => Some(explicit.clone()),
            (None, Some(anchor_label)) if label != anchor_label => {
                let pool = pool().await?;
                sqlx::query_scalar::<_, String>(
                    "SELECT html FROM phosphene_artboards
                     WHERE exploration_id = $1 AND direction_index = $2 AND label = $3",
                )
                .bind(args.exploration_id.trim())
                .bind(args.direction_index as i32)
                .bind(anchor_label)
                .fetch_optional(&pool)
                .await
                .map_err(|e| internal(error_chain("read the anchor", &e)))?
            }
            _ => None, // the anchor itself renders unpinned
        };

        // Zipped, not indexed-with-a-default: the old `unwrap_or("#000000")`
        // padded a short palette with black and told the renderer it was the
        // direction's colour. `normalize_direction` now guarantees five, so a
        // short palette cannot reach here — and if one ever does, it renders
        // as fewer swatches rather than as invented ones.
        let slots = ["bg", "surface", "accent", "text", "muted"];
        let swatches = slots
            .iter()
            .zip(args.direction.palette.iter())
            .map(|(slot, hex)| format!("{slot}={hex}"))
            .collect::<Vec<_>>()
            .join(", ");

        let user = format!(
            "Direction: \"{}\" — {}\nPalette: {swatches}\nTypography: {}\nMood: {}{}{}\n\
             State to render: \"{label}\"",
            args.direction.name,
            args.direction.description,
            args.direction.typography,
            args.direction.mood,
            families_line(&args.direction),
            // The renderer gets the WHOLE moodboard — voice, texture, motifs,
            // audience. It never did before E1; the fields flowed to judges
            // while the one model actually drawing pixels was told only the
            // palette and the mood. (The formulaic-output diagnosis, cause 4.)
            moodboard_lines(&args.direction),
        );

        // Anchors reach prompts with font payloads elided — the declaration
        // (and family name) survives; 30 KB of base64 does not.
        let lean_anchor = anchor_html.as_deref().map(fonts::elide_font_payloads);
        let text = run_agent(
            &render_system_prompt(&states, label, lean_anchor.as_deref()),
            &user,
            GENERATION_UPSTREAM,
            GENERATION_MODEL,
            GENERATION_THINKING,
            // Both ignored on claude_agent_sdk — those fields do not exist
            // there. Kept for the openrouter branch, where 0.7 is lower than
            // invention's 0.9 because the direction is already pinned and this
            // step should execute the spec rather than reinterpret it.
            0.7,
            8000,
            RENDER_TIMEOUT,
        )
        .await?;

        let html = extract_html(&text, label).map_err(internal)?;
        // The kit keeps its promise: the families the direction claims are
        // embedded HERE, server-side — the model only ever names them.
        let html = match &args.direction.families {
            Some(families) => fonts::inject(&html, families).await,
            None => html,
        };

        // Persist for score_direction and refine_state — the document must
        // never ride through the agent's context, and it must OUTLIVE this
        // container so a later round can revise it.
        let pool = pool().await?;
        sqlx::query(
            "INSERT INTO phosphene_artboards (exploration_id, direction_index, label, html)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (exploration_id, direction_index, label)
             DO UPDATE SET html = EXCLUDED.html,
                           round = phosphene_artboards.round + 1,
                           updated_at = now()",
        )
        .bind(args.exploration_id.trim())
        .bind(args.direction_index as i32)
        .bind(label)
        .bind(&html)
        .execute(&pool)
        .await
        .map_err(|e| internal(error_chain("store the artboard", &e)))?;

        Ok(Json(lean_rendered(label, &html)))
    }

    #[rmcp::tool(
        description = "Read back a stored exploration's brief, directions and shared \
                       states — no generation, instant. Call this FIRST when \
                       replaying a stored exploration, then get_state per cell."
    )]
    async fn get_exploration(
        &self,
        Parameters(args): Parameters<GetExplorationArgs>,
    ) -> Result<Json<Invention>, rmcp::ErrorData> {
        use sqlx::Row as _;
        let pool = pool().await?;
        let row = sqlx::query(
            "SELECT directions, states FROM phosphene_explorations WHERE exploration_id = $1",
        )
        .bind(args.exploration_id.trim())
        .fetch_optional(&pool)
        .await
        .map_err(|e| internal(error_chain("read the exploration", &e)))?
        .ok_or_else(|| {
            internal(format!("no exploration {}", args.exploration_id.trim()))
        })?;
        let directions: Vec<Direction> = serde_json::from_value(row.get("directions"))
            .map_err(|e| internal(format!("stored directions did not parse: {e}")))?;
        let states: Vec<String> = serde_json::from_value(row.get("states"))
            .map_err(|e| internal(format!("stored states did not parse: {e}")))?;
        Ok(Json(Invention { directions, states }))
    }

    #[rmcp::tool(
        description = "Read back ONE already-rendered state of ONE direction from \
                       storage — no generation, instant. Used to replay a stored \
                       exploration into a fresh display: call it once per \
                       (direction_index, label) and the documents stream back \
                       exactly as render_state's results do — font payloads elided, \
                       with bytes_stored/fonts_embedded/svg_used reporting what is \
                       actually stored."
    )]
    async fn get_state(
        &self,
        Parameters(args): Parameters<GetStateArgs>,
    ) -> Result<Json<Rendered>, rmcp::ErrorData> {
        let label = args.label.trim();
        let pool = pool().await?;
        let html: Option<String> = sqlx::query_scalar(
            "SELECT html FROM phosphene_artboards
             WHERE exploration_id = $1 AND direction_index = $2 AND label = $3",
        )
        .bind(args.exploration_id.trim())
        .bind(args.direction_index as i32)
        .bind(label)
        .fetch_optional(&pool)
        .await
        .map_err(|e| internal(error_chain("read the artboard", &e)))?;
        match html {
            Some(html) => Ok(Json(lean_rendered(label, &html))),
            None => Err(internal(format!(
                "no stored artboard for direction {} state \"{label}\" in \
                 exploration {}",
                args.direction_index,
                args.exploration_id.trim()
            ))),
        }
    }

    #[rmcp::tool(
        description = "Revise ONE rendered state of ONE direction by applying \
                       feedback — the user's words, or a judge's note. Changes only \
                       what the feedback demands, preserves the direction's visual \
                       language, and updates the stored board so later scoring sees \
                       the revision. Requires the state to have been rendered \
                       already (any earlier run of the same exploration_id)."
    )]
    async fn refine_state(
        &self,
        Parameters(args): Parameters<RefineArgs>,
    ) -> Result<Json<Rendered>, rmcp::ErrorData> {
        let label = args.label.trim();
        let feedback = args.feedback.trim();
        if feedback.is_empty() {
            return Err(internal("feedback is empty — nothing to apply"));
        }
        let eid = args.exploration_id.trim();
        let pool = pool().await?;
        let (direction, states) = load_direction(&pool, eid, args.direction_index).await?;

        let current: Option<String> = sqlx::query_scalar(
            "SELECT html FROM phosphene_artboards
             WHERE exploration_id = $1 AND direction_index = $2 AND label = $3",
        )
        .bind(eid)
        .bind(args.direction_index as i32)
        .bind(label)
        .fetch_optional(&pool)
        .await
        .map_err(|e| internal(error_chain("read the current state", &e)))?;
        let Some(current) = current else {
            return Err(internal(format!(
                "state \"{label}\" of direction {} has never been rendered in \
                 exploration {eid} — render_state comes first",
                args.direction_index
            )));
        };

        // Pin the anchor exactly as render does, unless we ARE the anchor.
        let anchor_html: Option<String> = match states.first() {
            Some(anchor_label) if label != anchor_label => sqlx::query_scalar(
                "SELECT html FROM phosphene_artboards
                 WHERE exploration_id = $1 AND direction_index = $2 AND label = $3",
            )
            .bind(eid)
            .bind(args.direction_index as i32)
            .bind(anchor_label)
            .fetch_optional(&pool)
            .await
            .map_err(|e| internal(error_chain("read the anchor", &e)))?,
            _ => None,
        };

        // Both the anchor and the document under revision reach the prompt
        // with font payloads elided — the model re-emits the markup it is
        // given, and 30 KB of echoed base64 would burn budget AND corrupt on
        // the way through. Injection restores the real fonts afterwards.
        let lean_anchor = anchor_html.as_deref().map(fonts::elide_font_payloads);
        let lean_current = fonts::elide_font_payloads(&current);
        let text = run_agent(
            &refine_system_prompt(&states, label, lean_anchor.as_deref()),
            &refine_user_prompt(&direction, label, &lean_current, feedback),
            GENERATION_UPSTREAM,
            GENERATION_MODEL,
            // Revision is judgment about what NOT to touch — thinking on.
            true,
            0.7,
            8000,
            RENDER_TIMEOUT,
        )
        .await?;
        let html = extract_html(&text, label).map_err(internal)?;
        // Re-embed: the revision echoed elided payloads (or dropped the
        // blocks); inject strips any kit block first, then adds the real ones.
        let html = match &direction.families {
            Some(families) => fonts::inject(&html, families).await,
            None => html,
        };

        sqlx::query(
            "UPDATE phosphene_artboards
             SET html = $4, round = round + 1, updated_at = now()
             WHERE exploration_id = $1 AND direction_index = $2 AND label = $3",
        )
        .bind(eid)
        .bind(args.direction_index as i32)
        .bind(label)
        .bind(&html)
        .execute(&pool)
        .await
        .map_err(|e| internal(error_chain("store the revision", &e)))?;

        Ok(Json(lean_rendered(label, &html)))
    }

    #[rmcp::tool(
        description = "Score ONE rendered direction with ONE judge model, on four \
                       dimensions: craft, distinctiveness, fitness to brief, and \
                       coherence across states. Returns four separate 0-1 scores \
                       (deliberately no overall), a written why per dimension, and \
                       computed facts (WCAG contrast, palette adherence). The \
                       direction's states must already have been rendered via \
                       render_state under this exploration_id — by this run or an \
                       earlier one; the artboards are stored plugin-side and are \
                       never passed as arguments. `model` is required: you choose the \
                       jury. Call once per judge with genuinely DIFFERENT models — \
                       the spread between judges is the signal, so never average \
                       their scores and never hide their disagreement."
    )]
    async fn score_direction(
        &self,
        Parameters(args): Parameters<ScoreArgs>,
    ) -> Result<Json<ScoreResult>, rmcp::ErrorData> {
        let model = args.model.trim();
        if model.is_empty() {
            return Err(internal(
                "model is required — the agent picks the jury, phosphene owns only the rubric",
            ));
        }
        let upstream = match args.upstream.as_deref() {
            None | Some("openrouter") => Upstream::OpenRouter,
            Some("claude_agent_sdk") => Upstream::ClaudeAgentSdk,
            Some(other) => {
                return Err(internal(format!(
                    "unknown upstream \"{other}\" — valid: openrouter, claude_agent_sdk"
                )));
            }
        };

        // Read everything needed out of the cache, then DROP the lock before
        // the await below — a std::sync::Mutex may never be held across one.
        let eid = args.exploration_id.trim();
        let pool = pool().await?;
        let (direction, states) = load_direction(&pool, eid, args.direction_index).await?;
        // Present states in invention order, not render order, and record
        // exactly what the judge saw.
        let ordered = load_artboards(&pool, eid, args.direction_index, &states).await?;
        if ordered.is_empty() {
            return Err(internal(format!(
                "direction {} has no rendered states in exploration {eid} — \
                 call render_state first",
                args.direction_index
            )));
        }

        let text = run_agent(
            &judge_system_prompt(),
            &judge_user_prompt(args.brief.trim(), &direction, &ordered),
            upstream,
            model,
            // Judging benefits from deliberation; on claude judges this is the
            // same lever that fixed generation's space budgeting.
            true,
            // Low temperature on openrouter judges: the rubric wants a careful
            // read, not creative variance — the panel's diversity comes from
            // MODELS, not sampling.
            0.2,
            // Generous, deliberately: on reasoning models (gemini-2.5-pro
            // measured) thinking tokens draw from THIS budget, and 3000 was
            // truncating replies mid-JSON — "unterminated JSON", 29 retries,
            // a 25-minute loop. The legacy 32K lesson, still collecting rent.
            16000,
            SCORE_TIMEOUT,
        )
        .await?;

        let parsed = parse_json_loose(&text).map_err(internal)?;
        let scores = parsed
            .get("scores")
            .ok_or_else(|| internal("judge returned no \"scores\" object"))?;
        let notes = parsed.get("notes").cloned().unwrap_or_default();

        let result = ScoreResult {
            direction: direction.name.clone(),
            judge: model.to_string(),
            scores: Scores {
                craft: read_score(scores, "craft").map_err(internal)?,
                distinctiveness: read_score(scores, "distinctiveness").map_err(internal)?,
                fitness: read_score(scores, "fitness").map_err(internal)?,
                coherence: read_score(scores, "coherence").map_err(internal)?,
            },
            notes: Notes {
                craft: read_note(&notes, "craft"),
                distinctiveness: read_note(&notes, "distinctiveness"),
                fitness: read_note(&notes, "fitness"),
                coherence: read_note(&notes, "coherence"),
            },
            facts: compute_facts(&direction, &ordered),
            states_seen: ordered.iter().map(|(l, _)| l.clone()).collect(),
        };
        Ok(Json(result))
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
                "Explore a design brief visually, then judge it. Call \
                 invent_directions ONCE to get 3 \
                 contrasting directions and 3 shared states — mint one \
                 exploration_id first and pass the SAME id to every tool call. \
                 Then call render_state once per (direction x state), the FIRST \
                 state of each direction before its others; the tool pins the \
                 shared chrome from stored state, so you never pass HTML between \
                 calls. score_direction judges a direction with a judge model the \
                 user names; refine_state applies feedback to one rendered state. \
                 A human is watching the board fill in as you work. To judge, call score_direction once per (direction x \
                 judge model) — you and your human choose the judges; pick models \
                 that genuinely differ, report every judge's scores separately, \
                 and NEVER average across judges: the disagreement is the point.",
            ),
        Plugin,
        tools,
    )
    .await
}
