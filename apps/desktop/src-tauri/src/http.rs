// Raw HTTP/1.0 with the core on 127.0.0.1, so as not to bring a whole HTTP client for four local
// routes. The private owner lock supplies authentication; Origin is an additional UI check.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub struct Response {
    pub status: u16,
    pub body: String,
}

fn request(port: u16, method: &str, path: &str, body: Option<&str>, wait: Duration) -> Option<Response> {
    let mut req = format!("{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: ahrena-console-desktop\r\n");
    if let Some(token) = crate::owner_auth::token(port) {
        req.push_str(&format!("Authorization: Bearer {token}\r\n"));
    } else if path != "/api/overview" && path != "/api/hooks/health" {
        return None;
    }
    if let Some(b) = body {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    req.push_str(body.unwrap_or(""));
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&address, Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(wait)).ok()?;
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
    #[cfg(unix)]
    #[test]
    fn private_request_proves_owner_and_rejects_replaced_lock() {
        use std::io::{Read, Write};
        use std::os::unix::fs::PermissionsExt;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let dir = std::env::temp_dir().join(format!("ahrena-owner-http-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.join("nucleo.json");
        std::fs::write(&path, serde_json::json!({ "port": port, "pid": 42, "token": "a".repeat(64) }).to_string()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        crate::owner_auth::configure(Some(&dir), port, Some(42));
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            assert!(String::from_utf8(request).unwrap().contains(&format!("Authorization: Bearer {}\r\n", "a".repeat(64))));
            stream.write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        });
        assert_eq!(super::get(port, "/api/attention", std::time::Duration::from_secs(3)).as_deref(), Some("{}"));
        server.join().unwrap();
        std::fs::write(&path, serde_json::json!({ "port": port, "pid": 43, "token": "b".repeat(64) }).to_string()).unwrap();
        assert!(crate::owner_auth::token(port).is_none());
        assert!(super::post_json(port, "/api/new-session", "{}").is_none());
        let demo_file = dir.join("demo-token");
        std::fs::write(&demo_file, "b".repeat(64)).unwrap();
        std::fs::set_permissions(&demo_file, std::fs::Permissions::from_mode(0o600)).unwrap();
        // A PID-less normal owner context cannot use this file as an implicit fallback.
        crate::owner_auth::configure(Some(&dir), port, None);
        assert!(crate::owner_auth::token(port).is_none());
        crate::owner_auth::configure_demo(Some(&demo_file), port);
        assert_eq!(crate::owner_auth::token(port), Some("b".repeat(64)));
        assert!(crate::owner_auth::token(port.wrapping_add(1)).is_none());
        std::fs::remove_file(demo_file).unwrap();
        assert!(crate::owner_auth::token(port).is_none());
        crate::owner_auth::clear();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn encodes_the_cursor() {
        assert_eq!(super::encode("abc-1_2.3~"), "abc-1_2.3~");
        assert_eq!(super::encode("a:b/c d"), "a%3Ab%2Fc%20d");
    }
}
