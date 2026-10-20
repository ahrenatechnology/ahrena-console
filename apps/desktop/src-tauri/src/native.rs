// What Tauri's menu does not expose and AppKit has: the ⌥ alternate item, the tooltip and the indent.
//
// Tauri (muda) gives no access to the tray's `NSMenu`. The app listens to
// `NSMenuDidAddItemNotification`, which AppKit posts for every inserted item with the menu itself as
// the object, and so finds the freshly built `NSMenu`. Everything runs on the main thread: the menu
// building and the notification too.
//
// An alternate item (`setAlternate`) takes the place of the item above while ⌥ is pressed; both
// need the same key equivalent (here, none) and different masks (⌘ and ⌥).

use std::cell::RefCell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSBitmapImageRep, NSEventModifierFlags, NSImage, NSMenu, NSMenuDidAddItemNotification, NSStatusItem};
use objc2_foundation::{NSData, NSNotification, NSNotificationCenter, NSObjectProtocol, NSSize, NSString};

thread_local! {
    static NEW_MENUS: RefCell<Vec<Retained<NSMenu>>> = const { RefCell::new(Vec::new()) };
    static OBSERVER: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone)]
pub enum Tweak {
    /// The item with this title becomes the alternate (⌥) of the item above.
    Alternate(String),
    Tooltip { title: String, tooltip: String },
    Indent(String),
}

/// Starts listening. On the main thread, before building the first menu.
pub fn listen() {
    let block = RcBlock::new(|n: NonNull<NSNotification>| {
        // SAFETY: AppKit hands a valid notification during the call.
        let n = unsafe { n.as_ref() };
        let Some(menu) = n.object().and_then(|o| o.downcast::<NSMenu>().ok()) else { return };
        NEW_MENUS.with(|v| {
            let mut v = v.borrow_mut();
            if !v.iter().any(|m| Retained::as_ptr(m) == Retained::as_ptr(&menu)) {
                v.push(menu);
            }
        });
    });
    // SAFETY: valid name and block; without a queue, the block runs on the posting thread (the main one).
    let observer = unsafe { NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(Some(NSMenuDidAddItemNotification), None, None, &block) };
    OBSERVER.with(|o| *o.borrow_mut() = Some(observer));
}

/// Applies the tweaks to the menu built since the last call that has the item `marker`.
pub fn apply(marker: &str, tweaks: &[Tweak]) {
    let menus = NEW_MENUS.with(|v| std::mem::take(&mut *v.borrow_mut()));
    let marker = NSString::from_str(marker);
    let Some(menu) = menus.iter().rev().find(|m| m.itemArray().iter().any(|i| i.title().isEqualToString(&marker))) else { return };
    let items = menu.itemArray();
    let find = |t: &str| {
        let t = NSString::from_str(t);
        items.iter().find(|i| i.title().isEqualToString(&t))
    };
    for tweak in tweaks {
        match tweak {
            Tweak::Alternate(t) => {
                if let Some(i) = find(t) {
                    i.setKeyEquivalentModifierMask(NSEventModifierFlags::Option);
                    i.setAlternate(true);
                }
            }
            Tweak::Tooltip { title, tooltip } => {
                if let Some(i) = find(title) {
                    i.setToolTip(Some(&NSString::from_str(tooltip)));
                }
            }
            Tweak::Indent(t) => {
                if let Some(i) = find(t) {
                    i.setIndentationLevel(1);
                }
            }
        }
    }
}

/// The tray icon as a template, with both resolutions (18 px and 36 px for 18 pt): `tray-icon`
/// takes a single image, and macOS picks the sharp one for each screen and paints it to match the
/// bar.
pub fn template_icon(item: &NSStatusItem, resolutions: &[&[u8]]) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let Some(button) = item.button(mtm) else { return };
    let size = NSSize::new(18.0, 18.0);
    let image = NSImage::initWithSize(NSImage::alloc(), size);
    for png in resolutions {
        if let Some(rep) = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(png)) {
            rep.setSize(size);
            image.addRepresentation(&rep);
        }
    }
    image.setTemplate(true);
    button.setImage(Some(&image));
}
