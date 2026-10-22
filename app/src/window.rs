//! The window: one webview on the system's own engine, WebView2 on Windows and WebKit
//! elsewhere, showing an HMI's screen.

use std::borrow::Cow;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::Request;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use tokio::runtime::Handle;
use tower::ServiceExt;
use wry::http::Response;
use wry::{WebContext, WebViewBuilder};

/// The scheme a screen in this process is served on, which no other program can reach.
const SCHEME: &str = "hmi";

/// What the window shows.
pub enum Screen {
    /// The HMI in this process, its files and link served by `router` on `runtime`.
    Here { title: String, router: Router, runtime: Handle },
    /// The screen of an HMI elsewhere, at this address.
    There(String),
    /// Why there is nothing to show.
    Fault(String),
}

/// What reaches the window from its page or another thread.
enum Told {
    Title(String),
    Close,
}

/// Closes the window from any thread.
pub struct Closer(EventLoopProxy<Told>);

impl Closer {
    pub fn close(&self) {
        let _ = self.0.send_event(Told::Close);
    }
}

pub struct Shell(EventLoop<Told>);

impl Shell {
    pub fn new() -> Shell {
        Shell(EventLoopBuilder::with_user_event().build())
    }

    pub fn closer(&self) -> Closer {
        Closer(self.0.create_proxy())
    }

    /// Shows `screen` until the window closes, then runs `closed` and ends the process.
    pub fn show(self, screen: Screen, closed: impl FnOnce() + 'static) -> ! {
        let event_loop = self.0;
        let title = match &screen {
            Screen::Here { title, .. } => title.clone(),
            _ => "Rant HMI".to_owned(),
        };
        let window = WindowBuilder::new().with_title(title).with_inner_size(LogicalSize::new(1280.0, 800.0)).build(&event_loop).expect("a window on this desktop");
        // WebView2 keeps its data beside the exe unless told, where an installed app may not write
        let mut context = WebContext::new(rant_hmi::kept().map(|kept| kept.join("webview")));
        let proxy = event_loop.create_proxy();
        let builder = WebViewBuilder::new_with_web_context(&mut context).with_document_title_changed_handler(move |title| {
            let _ = proxy.send_event(Told::Title(title));
        });
        #[cfg(windows)]
        let builder = with_variable_arguments(builder);
        let builder = match screen {
            Screen::Here { router, runtime, .. } => served(builder, router, runtime).with_initialization_script("window.rantHmiApp = true;").with_url(format!("{SCHEME}://localhost/run")),
            Screen::There(address) => builder.with_url(address),
            Screen::Fault(why) => builder.with_html(fault(&why)),
        };
        let webview = builder.build(&window).expect("a webview: on Windows the WebView2 runtime");
        let mut closed = Some(closed);
        event_loop.run(move |event, _, flow| {
            *flow = ControlFlow::Wait;
            let close = match event {
                Event::WindowEvent { event: WindowEvent::CloseRequested, .. } | Event::UserEvent(Told::Close) => true,
                Event::UserEvent(Told::Title(title)) => {
                    window.set_title(&title);
                    false
                }
                _ => false,
            };
            if close {
                window.set_visible(false);
                if let Some(closed) = closed.take() {
                    closed();
                }
                // both live as long as the window
                let _ = (&webview, &context);
                *flow = ControlFlow::Exit;
            }
        })
    }
}

/// Serves `router` on the window's own scheme, each request in a task of its own on `runtime`.
fn served(builder: WebViewBuilder<'_>, router: Router, runtime: Handle) -> WebViewBuilder<'_> {
    // https, so the page is a secure context where video decodes and gamepads work
    #[cfg(windows)]
    let builder = wry::WebViewBuilderExtWindows::with_https_scheme(builder, true);
    builder.with_asynchronous_custom_protocol(SCHEME.into(), move |_, request, responder| {
        let router = router.clone();
        runtime.spawn(async move {
            let (parts, body) = request.into_parts();
            let Ok(response) = router.oneshot(Request::from_parts(parts, Body::from(body))).await;
            let (parts, body) = response.into_parts();
            let body = to_bytes(body, usize::MAX).await.unwrap_or_default();
            responder.respond(Response::from_parts(parts, Cow::Owned(body.to_vec())));
        });
    })
}

/// Adds WebView2's own variable for browser arguments, as a debugger sets to reach the page,
/// which the arguments wry gives would replace. wry's are kept.
#[cfg(windows)]
fn with_variable_arguments(builder: WebViewBuilder<'_>) -> WebViewBuilder<'_> {
    const WRY: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
    match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        Ok(more) => wry::WebViewBuilderExtWindows::with_additional_browser_args(builder, format!("{WRY} {more}")),
        Err(_) => builder,
    }
}

/// A plain page that says why the HMI could not start.
fn fault(why: &str) -> String {
    let why = why.replace('&', "&amp;").replace('<', "&lt;");
    format!(
        "<!doctype html><meta charset=utf-8><title>Rant HMI</title>\
         <body style=\"font: 15px system-ui; margin: 32px; color: #e4e6ea; background: #17191c\">\
         <h3>This HMI could not start</h3><pre style=\"white-space: pre-wrap\">{why}</pre>"
    )
}
