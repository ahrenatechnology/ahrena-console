// HTTP/1.0 cru com o núcleo em 127.0.0.1, para não trazer um cliente HTTP inteiro para quatro
// rotas locais. Sem `Origin`: o núcleo recusa pedido com `Origin` (decisão 0003).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub struct Resposta {
    pub status: u16,
    pub corpo: String,
}

fn pedir(porta: u16, metodo: &str, caminho: &str, corpo: Option<&str>, espera: Duration) -> Option<Resposta> {
    let endereco = SocketAddr::from(([127, 0, 0, 1], porta));
    let mut s = TcpStream::connect_timeout(&endereco, Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(espera)).ok()?;
    let mut pedido = format!("{metodo} {caminho} HTTP/1.0\r\nHost: 127.0.0.1:{porta}\r\nUser-Agent: ahrena-console-desktop\r\n");
    if let Some(c) = corpo {
        pedido.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", c.len()));
    }
    pedido.push_str("\r\n");
    pedido.push_str(corpo.unwrap_or(""));
    s.write_all(pedido.as_bytes()).ok()?;
    let mut bytes = Vec::new();
    s.read_to_end(&mut bytes).ok()?;
    let resp = String::from_utf8(bytes).ok()?;
    let (cabecalho, corpo) = resp.split_once("\r\n\r\n")?;
    let status = cabecalho.split_whitespace().nth(1)?.parse().ok()?;
    Some(Resposta { status, corpo: corpo.to_string() })
}

/// O corpo, se a resposta é 200.
pub fn get(porta: u16, caminho: &str, espera: Duration) -> Option<String> {
    pedir(porta, "GET", caminho, None, espera).filter(|r| r.status == 200).map(|r| r.corpo)
}

/// A resposta inteira (status e corpo), para quem precisa distinguir 404 de "não respondeu".
pub fn get_com_status(porta: u16, caminho: &str, espera: Duration) -> Option<Resposta> {
    pedir(porta, "GET", caminho, None, espera)
}

pub fn post_json(porta: u16, caminho: &str, corpo: &str) -> Option<Resposta> {
    pedir(porta, "POST", caminho, Some(corpo), Duration::from_secs(10))
}

/// Codifica um valor para a query string (o cursor de `/api/mudancas`).
pub fn codificar(v: &str) -> String {
    v.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod testes {
    #[test]
    fn codificar_o_cursor() {
        assert_eq!(super::codificar("abc-1_2.3~"), "abc-1_2.3~");
        assert_eq!(super::codificar("a:b/c d"), "a%3Ab%2Fc%20d");
    }
}
