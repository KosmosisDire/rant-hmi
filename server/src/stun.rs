//! Just enough STUN (RFC 8489) for the HMI to learn the address a NAT shows the outside for one
//! of its WebRTC ports: a binding request, and the address in its answer.

use std::net::{IpAddr, SocketAddr};

const REQUEST: u16 = 0x0001;
const ANSWER: u16 = 0x0101;
const COOKIE: [u8; 4] = 0x2112_a442u32.to_be_bytes();
const MAPPED: u16 = 0x0001;
const XOR_MAPPED: u16 = 0x0020;

/// A request's transaction, which its answer names.
pub type Id = [u8; 12];

pub fn request(id: &Id) -> [u8; 20] {
    let mut m = [0; 20];
    m[..2].copy_from_slice(&REQUEST.to_be_bytes());
    m[4..8].copy_from_slice(&COOKIE);
    m[8..].copy_from_slice(id);
    m
}

/// The transaction a binding answer names and the address it says the request came from.
pub fn answer(m: &[u8]) -> Option<(Id, SocketAddr)> {
    if m.len() < 20 || m[..2] != ANSWER.to_be_bytes() || m[4..8] != COOKIE {
        return None;
    }
    let id: Id = m[8..20].try_into().ok()?;
    // the xored address is masked with the cookie, and an IPv6 one with the transaction too
    let xor: [u8; 16] = m[4..20].try_into().ok()?;
    let mut rest = m.get(20..20 + usize::from(u16::from_be_bytes([m[2], m[3]])))?;
    let mut plain = None;
    while rest.len() >= 4 {
        let kind = u16::from_be_bytes([rest[0], rest[1]]);
        let n = usize::from(u16::from_be_bytes([rest[2], rest[3]]));
        let value = rest.get(4..4 + n)?;
        match kind {
            XOR_MAPPED => return Some((id, address(value, &xor)?)),
            MAPPED => plain = address(value, &[0; 16]),
            _ => {}
        }
        rest = rest.get(4 + n.next_multiple_of(4)..).unwrap_or_default();
    }
    Some((id, plain?))
}

/// An address attribute's value, its port and address xored with `mask` from its start.
fn address(v: &[u8], mask: &[u8; 16]) -> Option<SocketAddr> {
    let port = u16::from_be_bytes([v.get(2)? ^ mask[0], v.get(3)? ^ mask[1]]);
    let len = match v.get(1)? {
        1 => 4,
        2 => 16,
        _ => return None,
    };
    let mut ip = [0; 16];
    for (i, b) in v.get(4..4 + len)?.iter().enumerate() {
        ip[i] = b ^ mask[i];
    }
    let ip = match len {
        4 => IpAddr::from([ip[0], ip[1], ip[2], ip[3]]),
        _ => IpAddr::from(ip),
    };
    Some(SocketAddr::new(ip, port))
}

/// Where a STUN or TURN server's url that takes UDP asks to be reached, as `host:port`. A
/// TURN server answers a binding request as a STUN one does.
pub fn server(url: &str) -> Option<String> {
    let rest = url.strip_prefix("stun:").or_else(|| url.strip_prefix("turn:"))?;
    let (at, query) = rest.split_once('?').unwrap_or((rest, ""));
    if query.split('&').any(|q| q.starts_with("transport=") && q != "transport=udp") {
        return None;
    }
    // an IPv6 host comes in brackets, so a colon past them starts the port
    let ported = at.rsplit_once(':').is_some_and(|(host, port)| port.parse::<u16>().is_ok() && (!host.contains(':') || host.ends_with(']')));
    Some(if ported { at.to_owned() } else { format!("{at}:3478") })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A binding answer to `id` holding these attributes.
    fn answered(id: &Id, attributes: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut body = Vec::new();
        for (kind, value) in attributes {
            body.extend(kind.to_be_bytes());
            body.extend((value.len() as u16).to_be_bytes());
            body.extend(value);
            body.resize(body.len().next_multiple_of(4), 0);
        }
        let mut m = ANSWER.to_be_bytes().to_vec();
        m.extend((body.len() as u16).to_be_bytes());
        m.extend(COOKIE);
        m.extend(id);
        m.extend(body);
        m
    }

    #[test]
    fn a_request_is_a_binding_with_its_transaction() {
        let id = [7; 12];
        let m = request(&id);
        assert_eq!(&m[..4], &[0, 1, 0, 0]);
        assert_eq!(&m[4..8], &[0x21, 0x12, 0xa4, 0x42]);
        assert_eq!(&m[8..], &id);
    }

    #[test]
    fn an_answer_says_where_the_request_came_from() {
        let id = [3; 12];
        // RFC 5769 2.2: 192.0.2.1 port 32853, xored
        let v4 = vec![0, 1, 0xa1, 0x47, 0xe1, 0x12, 0xa6, 0x43];
        assert_eq!(answer(&answered(&id, &[(0x8022, b"test".to_vec()), (XOR_MAPPED, v4)])), Some((id, "192.0.2.1:32853".parse().unwrap())));
        let plain = vec![0, 1, 0x12, 0x34, 10, 0, 0, 1];
        assert_eq!(answer(&answered(&id, &[(MAPPED, plain)])), Some((id, "10.0.0.1:4660".parse().unwrap())));
    }

    #[test]
    fn an_ipv6_answer_is_xored_with_its_transaction_too() {
        let id: Id = [0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae];
        // RFC 5769 2.3: 2001:db8:1234:5678:11:2233:4455:6677 port 32853
        let v6 = vec![0, 2, 0xa1, 0x47, 0x01, 0x13, 0xa9, 0xfa, 0xa5, 0xd3, 0xf1, 0x79, 0xbc, 0x25, 0xf4, 0xb5, 0xbe, 0xd2, 0xb9, 0xd9];
        assert_eq!(answer(&answered(&id, &[(XOR_MAPPED, v6)])), Some((id, "[2001:db8:1234:5678:11:2233:4455:6677]:32853".parse().unwrap())));
    }

    #[test]
    fn what_is_not_a_binding_answer_says_nothing() {
        assert_eq!(answer(&request(&[1; 12])), None);
        assert_eq!(answer(&[0; 8]), None);
        assert_eq!(answer(&answered(&[1; 12], &[])), None);
        let mut cut = answered(&[1; 12], &[(XOR_MAPPED, vec![0, 1, 0, 0, 0, 0, 0, 0])]);
        cut.truncate(26);
        assert_eq!(answer(&cut), None);
    }

    #[test]
    fn a_server_url_names_its_host_and_port() {
        assert_eq!(server("stun:stun.l.google.com:19302").as_deref(), Some("stun.l.google.com:19302"));
        assert_eq!(server("stun:stun.example.com").as_deref(), Some("stun.example.com:3478"));
        assert_eq!(server("turn:[2001:db8::1]?transport=udp").as_deref(), Some("[2001:db8::1]:3478"));
        assert_eq!(server("turn:t.example.com:443?transport=tcp"), None);
        assert_eq!(server("turns:t.example.com:443"), None);
    }
}
