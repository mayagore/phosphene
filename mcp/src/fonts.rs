//! The font kit — real typefaces as a material.
//!
//! A model cannot emit binary font data and the container has no network, so
//! embedded fonts must come from somewhere real: this kit, baked into the
//! plugin image (latin-subset woff2, all OFL — see ../fonts/LICENSE.md). The
//! renderer NAMES a family; the render tool injects the matching
//! `@font-face` blocks server-side after generation. The model never sees a
//! byte of base64 — and neither do the anchor prompts or the judges, who get
//! the payloads elided (`elide_font_payloads`) because 30 KB of base64 in a
//! judge's context is pure noise.
//!
//! Safety is unchanged: an embedded data: URI is self-contained by
//! definition — `external_free` still hunts http, the sandbox still allows
//! nothing, the rasterizer (which historically CHOKES on remote fonts)
//! actively prefers inlined ones.

use base64::Engine as _;
use tokio::sync::OnceCell;

pub struct Face {
    /// Exact CSS family name — what a direction's `families` entry must say.
    pub family: &'static str,
    /// One line of character, for the invention menu.
    pub blurb: &'static str,
    /// (weight, woff2 bytes).
    pub weights: &'static [(u16, &'static [u8])],
}

pub static KIT: &[Face] = &[
    Face {
        family: "Fraunces",
        blurb: "characterful old-style display serif, warm and a little wonky",
        weights: &[
            (400, include_bytes!("../fonts/fraunces-400.woff2")),
            (700, include_bytes!("../fonts/fraunces-700.woff2")),
        ],
    },
    Face {
        family: "Playfair Display",
        blurb: "high-contrast romantic display serif",
        weights: &[
            (400, include_bytes!("../fonts/playfair-display-400.woff2")),
            (700, include_bytes!("../fonts/playfair-display-700.woff2")),
        ],
    },
    Face {
        family: "EB Garamond",
        blurb: "renaissance old-style text serif",
        weights: &[
            (400, include_bytes!("../fonts/eb-garamond-400.woff2")),
            (700, include_bytes!("../fonts/eb-garamond-700.woff2")),
        ],
    },
    Face {
        family: "Space Grotesk",
        blurb: "techy grotesque with drawn quirks",
        weights: &[
            (400, include_bytes!("../fonts/space-grotesk-400.woff2")),
            (700, include_bytes!("../fonts/space-grotesk-700.woff2")),
        ],
    },
    Face {
        family: "Oswald",
        blurb: "tall condensed display sans, poster energy",
        weights: &[
            (400, include_bytes!("../fonts/oswald-400.woff2")),
            (700, include_bytes!("../fonts/oswald-700.woff2")),
        ],
    },
    Face {
        family: "Work Sans",
        blurb: "quiet humanist workhorse sans",
        weights: &[
            (400, include_bytes!("../fonts/work-sans-400.woff2")),
            (700, include_bytes!("../fonts/work-sans-700.woff2")),
        ],
    },
    Face {
        family: "Bricolage Grotesque",
        blurb: "loud contemporary display sans with attitude",
        weights: &[
            (400, include_bytes!("../fonts/bricolage-grotesque-400.woff2")),
            (700, include_bytes!("../fonts/bricolage-grotesque-700.woff2")),
        ],
    },
    Face {
        family: "Zilla Slab",
        blurb: "sturdy slab serif",
        weights: &[
            (400, include_bytes!("../fonts/zilla-slab-400.woff2")),
            (700, include_bytes!("../fonts/zilla-slab-700.woff2")),
        ],
    },
    Face {
        family: "Space Mono",
        blurb: "characterful monospace",
        weights: &[
            (400, include_bytes!("../fonts/space-mono-400.woff2")),
            (700, include_bytes!("../fonts/space-mono-700.woff2")),
        ],
    },
    Face {
        family: "Abril Fatface",
        blurb: "fat didone display, one weight, maximum presence",
        weights: &[(400, include_bytes!("../fonts/abril-fatface-400.woff2"))],
    },
];

/// A direction may carry at most this many embedded families — display +
/// body is the design idiom; three embedded faces is usually noise and
/// always bytes.
pub const MAX_FAMILIES: usize = 2;

pub fn find(name: &str) -> Option<&'static Face> {
    let wanted = name.trim().to_lowercase();
    KIT.iter().find(|face| face.family.to_lowercase() == wanted)
}

/// Filter to kit faces (canonical casing), dedupe, cap at [`MAX_FAMILIES`].
pub fn canonical(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names {
        if let Some(face) = find(name)
            && !out.iter().any(|existing| existing == face.family)
        {
            out.push(face.family.to_string());
            if out.len() == MAX_FAMILIES {
                break;
            }
        }
    }
    out
}

/// The invention menu: every face, one line each.
pub fn menu() -> String {
    KIT.iter()
        .map(|face| format!("\"{}\" — {}", face.family, face.blurb))
        .collect::<Vec<_>>()
        .join("; ")
}

/// The `@font-face` blocks for one family, base64 built once per process.
async fn face_css(face: &'static Face) -> &'static str {
    static CSS: OnceCell<std::collections::HashMap<&'static str, String>> = OnceCell::const_new();
    let all = CSS
        .get_or_init(|| async {
            KIT.iter()
                .map(|face| {
                    let blocks = face
                        .weights
                        .iter()
                        .map(|(weight, bytes)| {
                            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                            format!(
                                "@font-face{{font-family:'{}';font-style:normal;\
                                 font-weight:{weight};font-display:swap;\
                                 src:url(data:font/woff2;base64,{b64}) format('woff2')}}",
                                face.family
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    (face.family, blocks)
                })
                .collect()
        })
        .await;
    all.get(face.family).map(String::as_str).unwrap_or_default()
}

/// Remove every `@font-face` block whose src is a `data:font` URL — those
/// are OURS by construction (real, or an elided echo a revision model sent
/// back; the prompts forbid models writing their own `@font-face`). Blocks
/// contain no nested braces, so the first `}` after the opener closes it.
pub fn strip_kit_faces(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find("@font-face") {
        let Some(close) = rest[at..].find('}') else {
            break; // unterminated — leave the tail untouched
        };
        let block = &rest[at..at + close + 1];
        out.push_str(&rest[..at]);
        if !block.contains("data:font/") {
            out.push_str(block); // not ours — keep it
        }
        rest = &rest[at + close + 1..];
        if block.contains("data:font/") && rest.starts_with('\n') {
            rest = &rest[1..]; // and the newline that followed ours
        }
    }
    out.push_str(rest);
    out
}

/// Inject the requested families' `@font-face` blocks into a generated
/// document — right after the first `<style` tag opens, else before
/// `</head>`, else prepended. Strip-then-add: any earlier kit block (real,
/// or an elided echo from a revision) is removed first, so the result is
/// correct and idempotent by construction.
pub async fn inject(html: &str, families: &[String]) -> String {
    let html = strip_kit_faces(html);
    let mut css = String::new();
    for name in families {
        let Some(face) = find(name) else { continue };
        css.push_str(face_css(face).await);
        css.push('\n');
    }
    if css.is_empty() {
        return html;
    }

    let lower = html.to_lowercase();
    if let Some(open) = lower.find("<style") {
        if let Some(end) = html[open..].find('>') {
            let at = open + end + 1;
            return format!("{}\n{css}{}", &html[..at], &html[at..]);
        }
    }
    if let Some(head) = lower.find("</head>") {
        return format!("{}<style>\n{css}</style>{}", &html[..head], &html[head..]);
    }
    format!("<style>\n{css}</style>{html}")
}

/// Replace embedded font payloads with a stub so prompts and judges never
/// carry base64 — the `@font-face` declaration (and its family name) stays
/// visible, which is exactly what a reader needs to know.
pub fn elide_font_payloads(html: &str) -> String {
    const NEEDLE: &str = "data:font/woff2;base64,";
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find(NEEDLE) {
        let payload_start = at + NEEDLE.len();
        out.push_str(&rest[..payload_start]);
        out.push_str("ELIDED");
        let tail = &rest[payload_start..];
        let end = tail
            .find(|c| c == ')' || c == '"' || c == '\'')
            .unwrap_or(tail.len());
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kit_lookup_is_case_insensitive_and_canonical() {
        assert_eq!(find("fraunces").unwrap().family, "Fraunces");
        assert_eq!(find(" SPACE MONO ").unwrap().family, "Space Mono");
        assert!(find("Comic Sans MS").is_none());
        let picked = canonical(&[
            "playfair display".into(),
            "nonsense".into(),
            "Playfair Display".into(),
            "oswald".into(),
            "Zilla Slab".into(), // over the cap — dropped
        ]);
        assert_eq!(picked, vec!["Playfair Display".to_string(), "Oswald".to_string()]);
    }

    #[tokio::test]
    async fn inject_lands_in_style_and_elide_strips_payloads() {
        let html = "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head>\
                    <style>body{color:#111}</style></head><body/></html>";
        let injected = inject(html, &["Oswald".to_string()]).await;
        assert!(injected.contains("font-family:'Oswald';"));
        assert!(injected.contains("data:font/woff2;base64,"));
        // Payload is real base64, not the stub.
        assert!(!injected.contains("base64,ELIDED"));
        // Idempotent: a second pass adds nothing.
        let twice = inject(&injected, &["Oswald".to_string()]).await;
        assert_eq!(twice.matches("@font-face").count(), injected.matches("@font-face").count());

        let lean = elide_font_payloads(&injected);
        assert!(lean.contains("base64,ELIDED) format('woff2')"));
        assert!(lean.len() < injected.len() / 2);
        assert!(lean.contains("font-family:'Oswald';")); // the name survives
    }

    #[tokio::test]
    async fn inject_without_style_uses_head() {
        let html = "<html xmlns=\"x\"><head><title>t</title></head><body/></html>";
        let injected = inject(html, &["Fraunces".to_string()]).await;
        let head_close = injected.find("</head>").unwrap();
        let face = injected.find("@font-face").unwrap();
        assert!(face < head_close);
    }
}
