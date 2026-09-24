//! Chinese script conversion of transcripts (whisper's base model often
//! answers in Simplified Chinese even with a Traditional prompt).
//! Character and standard-form conversion only, as OpenCC's s2tw / tw2s:
//! the phrase tables they consult only pick the right character for
//! one-to-many mappings (头发 → 頭髮); vocabulary is never reworded
//! (软件 → 軟件, not 軟體). Dictionaries are compiled into the binary.
//! One exception for Taiwan: s2tw writes 台 as the official 臺 (台湾 → 臺灣,
//! even 台灣 → 臺灣), but 台 is what people here write, so it is kept.

use std::sync::OnceLock;

use ferrous_opencc::{config::BuiltinConfig, OpenCC};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Script {
    /// Leave whisper's output as is.
    None,
    /// Traditional Chinese, Taiwan standard glyphs (OpenCC s2tw).
    HantTw,
    /// Simplified Chinese (OpenCC tw2s).
    Hans,
}

impl Script {
    /// The protocol value (`"hant-tw"`, `"hans"`, `"none"`).
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "hant-tw" => Some(Self::HantTw),
            "hans" => Some(Self::Hans),
            _ => None,
        }
    }

    pub fn convert(self, text: &str) -> String {
        static HANT_TW: OnceLock<OpenCC> = OnceLock::new();
        static HANS: OnceLock<OpenCC> = OnceLock::new();
        let (cell, config) = match self {
            Self::None => return text.to_string(),
            Self::HantTw => (&HANT_TW, BuiltinConfig::S2tw),
            Self::Hans => (&HANS, BuiltinConfig::Tw2s),
        };
        let converted = cell
            .get_or_init(|| OpenCC::from_config(config).expect("embedded OpenCC config"))
            .convert(text);
        // Simplified 台 is the same code point, so s2tw is where 臺 comes from.
        if self == Self::HantTw {
            converted.replace('臺', "台")
        } else {
            converted
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Script;

    #[test]
    fn parses_protocol_values() {
        assert_eq!(Script::parse("hant-tw"), Some(Script::HantTw));
        assert_eq!(Script::parse("hans"), Some(Script::Hans));
        assert_eq!(Script::parse("none"), Some(Script::None));
        assert_eq!(Script::parse("zh-TW"), None);
        assert_eq!(Script::parse(""), None);
    }

    #[test]
    fn simplified_to_taiwan_traditional() {
        assert_eq!(Script::HantTw.convert("简体中文测试"), "簡體中文測試");
        assert_eq!(Script::HantTw.convert("帮我分析项目结构"), "幫我分析項目結構");
        // Taiwan standard glyph forms, not generic OpenCC Traditional.
        assert_eq!(Script::HantTw.convert("为什么"), "為什麼");
        assert_eq!(Script::HantTw.convert("线"), "線");
    }

    #[test]
    fn taiwan_keeps_tai() {
        assert_eq!(Script::HantTw.convert("台湾"), "台灣");
        assert_eq!(Script::HantTw.convert("台北、台中、台南"), "台北、台中、台南");
        assert_eq!(Script::HantTw.convert("台灣"), "台灣");
        // Only 臺 is kept as 台; the other readings of 台 still convert.
        assert_eq!(Script::HantTw.convert("台风"), "颱風");
    }

    #[test]
    fn one_to_many_characters_use_phrase_context() {
        assert_eq!(Script::HantTw.convert("头发"), "頭髮");
        assert_eq!(Script::HantTw.convert("发现"), "發現");
    }

    #[test]
    fn vocabulary_is_not_reworded() {
        assert_eq!(Script::HantTw.convert("软件"), "軟件");
        assert_eq!(Script::HantTw.convert("鼠标"), "鼠標");
    }

    #[test]
    fn traditional_input_is_kept() {
        assert_eq!(Script::HantTw.convert("幫我分析專案結構"), "幫我分析專案結構");
    }

    #[test]
    fn punctuation_and_latin_untouched() {
        assert_eq!(
            Script::HantTw.convert(" 打开 README.md，然后 run `pnpm test`! 123"),
            " 打開 README.md，然後 run `pnpm test`! 123"
        );
    }

    #[test]
    fn traditional_to_simplified() {
        assert_eq!(Script::Hans.convert("簡體中文測試，台灣"), "简体中文测试，台湾");
        assert_eq!(Script::Hans.convert("軟體"), "软体");
    }

    #[test]
    fn none_is_identity() {
        assert_eq!(Script::None.convert("简体 繁體 mixed"), "简体 繁體 mixed");
    }
}
