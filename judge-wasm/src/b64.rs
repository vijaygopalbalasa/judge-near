//! Standard base64 (RFC 4648 section 4), strict and canonical: alphabet A-Z a-z
//! 0-9 + /, length a multiple of 4, `=` padding only at the end and required, no
//! whitespace, and unused trailing bits zero. So each byte string has exactly one
//! accepted encoding. No dependency; a few lines each way.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decode canonical standard base64; None for anything else.
pub(crate) fn decode(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 4 != 0 {
        return None;
    }
    let groups = b.len() / 4;
    let mut out = Vec::with_capacity(groups * 3);
    for (i, chunk) in b.chunks(4).enumerate() {
        let pad = if i + 1 == groups {
            chunk.iter().rev().take_while(|&&c| c == b'=').count()
        } else {
            0
        };
        if pad > 2 {
            return None;
        }
        let mut n = 0u32;
        for (j, &c) in chunk.iter().enumerate() {
            let v = if j < 4 - pad { value(c)? } else { 0 };
            n |= v << (18 - 6 * j as u32);
        }
        match pad {
            0 => out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]),
            1 if n & 0xff == 0 => out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8]),
            2 if n & 0xffff == 0 => out.push((n >> 16) as u8),
            _ => return None, // non-zero trailing bits
        }
    }
    Some(out)
}

/// Encode as standard base64 with padding.
pub(crate) fn encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        let chars = [n >> 18, n >> 12, n >> 6, n].map(|x| char::from(ALPHABET[(x & 63) as usize]));
        let keep = chunk.len() + 1;
        for (i, c) in chars.iter().enumerate() {
            out.push(if i < keep { *c } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{decode, encode};

    #[test]
    fn rfc4648_test_vectors_round_trip() {
        for (plain, enc) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode(plain.as_bytes()), enc);
            assert_eq!(decode(enc).as_deref(), Some(plain.as_bytes()));
        }
    }

    #[test]
    fn byte_strings_round_trip_exhaustively_to_two_bytes_and_sampled_at_three() {
        for len in 0..=3usize {
            let total = 1usize << (8 * len);
            let step = if len == 3 { 4093 } else { 1 }; // prime stride through 2^24
            for x in (0..total).step_by(step) {
                let data: Vec<u8> = (0..len).map(|i| (x >> (8 * i)) as u8).collect();
                assert_eq!(decode(&encode(&data)), Some(data));
            }
        }
    }

    #[test]
    fn non_canonical_or_malformed_input_is_refused() {
        for bad in [
            "Zg=", "Zg", "Zh==", "Zm9=", "Zm9v\n", "Zm9v YmFy", " Zm9v", "Zm=v", "=Zm9", "Zm9vYmFy====",
            "Zm9vY===", "Zg==Zg==", "Zm-v", "Zm_v", "Zm9v=", "\u{00e9}AAA",
        ] {
            assert_eq!(decode(bad), None, "{bad:?}");
        }
    }
}
