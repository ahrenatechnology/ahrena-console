// Raw HTTP/1.0 with the core on 127.0.0.1, so as not to bring a whole HTTP client for four local
// routes. No `Origin`: the core refuses a request with `Origin` (decision 0003).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub struct Response {
    pub status: u16,
    pub body: String,
}

fn request(port: u16, method: &str, path: &str, body: Option<&str>, wait: Duration) -> Option<Response> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&address, Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(wait)).ok()?;
    let mut req = format!("{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: ahrena-console-desktop\r\n");
    if let Some(b) = body {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    req.push_str(body.unwrap_or(""));
    s.write_all(req.as_bytes()).ok()?;
    let mut bytes = Vec::new();
    s.read_to_end(&mut bytes).ok()?;
    let resp = String::from_utf8(bytes).ok()?;
    let (head, body) = resp.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    Some(Response { status, body: body.to_string() })
}

/// The body, if the response is 200.
pub fn get(port: u16, path: &str, wait: Duration) -> Option<String> {
    request(port, "GET", path, None, wait).filter(|r| r.status == 200).map(|r| r.body)
}

/// The whole response (status and body), for whoever must tell a 404 from "did not answer".
pub fn get_with_status(port: u16, path: &str, wait: Duration) -> Option<Response> {
    request(port, "GET", path, None, wait)
}

pub fn put_json(port: u16, path: &str, body: &str) -> Option<Response> {
    request(port, "PUT", path, Some(body), Duration::from_secs(10))
}

pub fn post_json(port: u16, path: &str, body: &str) -> Option<Response> {
    request(port, "POST", path, Some(body), Duration::from_secs(10))
}

/// Encodes a value for the query string (the cursor of `/api/changes`).
pub fn encode(v: &str) -> String {
    v.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_the_cursor() {
        assert_eq!(super::encode("abc-1_2.3~"), "abc-1_2.3~");
        assert_eq!(super::encode("a:b/c d"), "a%3Ab%2Fc%20d");
    }
}
