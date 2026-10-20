// O que o menu do Tauri não expõe e o AppKit tem: o item alternativo do ⌥, a dica e o recuo.
//
// O Tauri (muda) não dá acesso ao `NSMenu` da bandeja. O app ouve `NSMenuDidAddItemNotification`,
// que o AppKit posta a cada item inserido com o próprio menu como objeto, e assim acha o `NSMenu`
// recém-montado. Tudo roda na thread principal: a montagem do menu e a notificação também.
//
// Um item alternativo (`setAlternate`) toma o lugar do item de cima enquanto ⌥ está pressionado;
// os dois precisam do mesmo atalho (aqui, nenhum) e de máscaras diferentes (⌘ e ⌥).

use std::cell::RefCell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSBitmapImageRep, NSEventModifierFlags, NSImage, NSMenu, NSMenuDidAddItemNotification, NSStatusItem};
use objc2_foundation::{NSData, NSNotification, NSNotificationCenter, NSObjectProtocol, NSSize, NSString};

thread_local! {
    static NOVOS: RefCell<Vec<Retained<NSMenu>>> = const { RefCell::new(Vec::new()) };
    static OUVINTE: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone)]
pub enum Ajuste {
    /// O item com este título vira o alternativo (⌥) do item de cima.
    Alternativo(String),
    Dica { titulo: String, dica: String },
    Recuo(String),
}

/// Começa a ouvir. Na thread principal, antes de montar o primeiro menu.
pub fn ouvir() {
    let bloco = RcBlock::new(|n: NonNull<NSNotification>| {
        // SAFETY: o AppKit entrega uma notificação válida durante a chamada.
        let n = unsafe { n.as_ref() };
        let Some(menu) = n.object().and_then(|o| o.downcast::<NSMenu>().ok()) else { return };
        NOVOS.with(|v| {
            let mut v = v.borrow_mut();
            if !v.iter().any(|m| Retained::as_ptr(m) == Retained::as_ptr(&menu)) {
                v.push(menu);
            }
        });
    });
    // SAFETY: nome e bloco válidos; sem fila, o bloco roda na thread que posta (a principal).
    let ouvinte = unsafe { NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(Some(NSMenuDidAddItemNotification), None, None, &bloco) };
    OUVINTE.with(|o| *o.borrow_mut() = Some(ouvinte));
}

/// Aplica os ajustes no menu montado desde a última chamada que tem o item `marca`.
pub fn ajustar(marca: &str, ajustes: &[Ajuste]) {
    let menus = NOVOS.with(|v| std::mem::take(&mut *v.borrow_mut()));
    let marca = NSString::from_str(marca);
    let Some(menu) = menus.iter().rev().find(|m| m.itemArray().iter().any(|i| i.title().isEqualToString(&marca))) else { return };
    let itens = menu.itemArray();
    let achar = |t: &str| {
        let t = NSString::from_str(t);
        itens.iter().find(|i| i.title().isEqualToString(&t))
    };
    for a in ajustes {
        match a {
            Ajuste::Alternativo(t) => {
                if let Some(i) = achar(t) {
                    i.setKeyEquivalentModifierMask(NSEventModifierFlags::Option);
                    i.setAlternate(true);
                }
            }
            Ajuste::Dica { titulo, dica } => {
                if let Some(i) = achar(titulo) {
                    i.setToolTip(Some(&NSString::from_str(dica)));
                }
            }
            Ajuste::Recuo(t) => {
                if let Some(i) = achar(t) {
                    i.setIndentationLevel(1);
                }
            }
        }
    }
}

/// O ícone da bandeja como template, com as duas resoluções (18 px e 36 px para 18 pt): o
/// `tray-icon` aceita uma imagem só, e o macOS escolhe a nítida para cada tela e a pinta conforme
/// a barra.
pub fn icone_template(item: &NSStatusItem, resolucoes: &[&[u8]]) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let Some(botao) = item.button(mtm) else { return };
    let tamanho = NSSize::new(18.0, 18.0);
    let imagem = NSImage::initWithSize(NSImage::alloc(), tamanho);
    for png in resolucoes {
        if let Some(rep) = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(png)) {
            rep.setSize(tamanho);
            imagem.addRepresentation(&rep);
        }
    }
    imagem.setTemplate(true);
    botao.setImage(Some(&imagem));
}
