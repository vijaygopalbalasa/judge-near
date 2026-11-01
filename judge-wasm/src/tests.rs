//! Unit tests for the internal text, type, url/email and hashing helpers. The
//! end-to-end parity against the JS oracle lives in tests/parity.rs.

use crate::shape::{domain_of, is_email, is_url};
use crate::{
    has_whole_word, is_js_space, is_word_code_point, sha256_hex, utf16_len, word_count,
};

#[test]
fn sha256_empty_is_the_known_vector() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn utf16_len_counts_code_units_like_js_string_length() {
    assert_eq!(utf16_len("abc"), 3);
    assert_eq!(utf16_len("\u{1F600}"), 2); // one emoji = a surrogate pair = 2 units
    assert_eq!(utf16_len("a\u{1F600}b"), 4);
    assert_eq!(utf16_len("\u{00E9}"), 1); // é is one BMP unit
}

#[test]
fn word_count_matches_trim_split_whitespace() {
    assert_eq!(word_count(""), 0);
    assert_eq!(word_count("   "), 0);
    assert_eq!(word_count("a b c"), 3);
    assert_eq!(word_count("  a   b  "), 2);
    // NBSP, ideographic space and BOM all split words.
    assert_eq!(word_count("a\u{00A0}b\u{3000}c\u{FEFF}d"), 4);
    assert_eq!(word_count("a\tb\nc\r\nd"), 4);
}

#[test]
fn is_js_space_differs_from_rust_whitespace() {
    assert!(is_js_space('\u{FEFF}')); // BOM is JS whitespace, not Rust whitespace
    assert!(!is_js_space('\u{0085}')); // NEL is Rust whitespace, not JS whitespace
    assert!(is_js_space(' '));
    assert!(is_js_space('\u{3000}'));
    assert!(!is_js_space('x'));
}

#[test]
fn whole_word_boundary_cases_from_the_js_suite() {
    // "Arc" standing on its own vs inside other tokens.
    assert!(!has_whole_word("A software Architecture paid in USDC.", "Arc"));
    for ok in [
        "Built on Arc.",
        "Arc, the chain",
        "(Arc)",
        "Arc-based",
        "ERC-8183 on Arc",
    ] {
        assert!(has_whole_word(ok, "Arc"), "{ok}");
    }
    for no in ["Arcade", "reArc", "Arc_2", "Arc\u{00e9}", "ARC"] {
        assert!(!has_whole_word(no, "Arc"), "{no}");
    }
    // Regex characters are literal.
    assert!(has_whole_word("a.b?c", "b?c"));
    assert!(!has_whole_word("abbc", "b?c"));
    // Pinned-table edges.
    assert!(!has_whole_word("pay \u{10940}USDC now", "USDC")); // U+10940 is a letter in Unicode 17
    assert!(has_whole_word("Paid in USDC\u{0378}", "USDC")); // U+0378 unassigned, not a word char
    assert!(!has_whole_word("x_USDC", "USDC")); // underscore is a word char
    assert!(!has_whole_word("\u{1D7D8}USDC", "USDC")); // a mathematical digit (Nd)
}

#[test]
fn whole_word_empty_term_matches_only_between_non_words() {
    assert!(has_whole_word("", "")); // the sole position has edges on both sides
    assert!(has_whole_word("a  b", "")); // the gap between the two spaces has non-word neighbours
    assert!(!has_whole_word("a b", "")); // every single gap touches a word char
    assert!(!has_whole_word("ab", "")); // every gap touches a word char
}

#[test]
fn word_code_point_table_spot_checks() {
    assert!(is_word_code_point('_' as u32));
    assert!(is_word_code_point('0' as u32));
    assert!(is_word_code_point('Z' as u32));
    assert!(is_word_code_point('\u{00E9}' as u32)); // é
    assert!(!is_word_code_point(' ' as u32));
    assert!(!is_word_code_point('-' as u32));
    assert!(!is_word_code_point(0x0378)); // unassigned
    assert!(is_word_code_point(0x10940)); // assigned letter in Unicode 17
}

#[test]
fn url_rules_match_the_js_suite() {
    for u in [
        "https://a.co",
        "http://sub.example.org:8080/path?q=1#f",
        "https://xn--80ak6aa92e.com",
        "HTTPS://EXAMPLE.COM",
        "https://team0.xyz/",
        "https://a-b.c-d.io/x_y~z%20",
    ] {
        assert!(is_url(u), "should be url: {u}");
    }
    for u in [
        "ftp://a.co",
        "https://localhost",
        "https://a.co/a b",
        "https://user@a.co",
        "https://a..co",
        "https://-a.co",
        "https://a-.co",
        "https://a.co.",
        "https://1.2.3.4",
        "https://a.co:123456",
        "https://a.co:",
        "https://[::1]/",
        "https://",
        "a.co",
        "https://ex\u{00e4}mple.com",
        "https://a.co/\u{00e9}",
        " https://a.co",
        "https://a.co\n",
    ] {
        assert!(!is_url(u), "should not be url: {u}");
    }
}

#[test]
fn email_rules_match_the_js_suite() {
    for e in [
        "hello@team.xyz",
        "first.last+tag@sub.example.org",
        "o'brien@x.io",
        "a@b.co",
    ] {
        assert!(is_email(e), "should be email: {e}");
    }
    for e in [
        "@a.co",
        "a@",
        "a@@b.co",
        "a@b@c.co",
        "a.@b.co",
        ".a@b.co",
        "a..b@c.co",
        "a b@c.co",
        "a@localhost",
        "mailto:a@b.co",
        "a@1.2.3.4",
        "a@b.co ",
    ] {
        assert!(!is_email(e), "should not be email: {e}");
    }
}

#[test]
fn domain_of_lowercases_and_drops_one_leading_www() {
    assert_eq!(domain_of("https://WWW.Example.COM:8080/x"), "example.com");
    assert_eq!(domain_of("https://www.www.a.co"), "www.a.co");
    assert_eq!(domain_of("https://blog.a.co/x"), "blog.a.co");
    assert_eq!(domain_of("https://www.co"), "www.co");
}
