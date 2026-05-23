//! Native macOS passkey bridge via Apple `AuthenticationServices`.
//!
//! This is the "真正做 passkey" path: it drives `ASAuthorizationController` with
//! `ASAuthorizationPlatformPublicKeyCredentialProvider` and the WebAuthn **PRF**
//! extension (`ASAuthorizationPublicKeyCredentialPRF*Input/Output`) to derive a
//! symmetric key, bound to a real relying-party domain instead of `localhost`.
//!
//! It returns the same shape as the existing browser bridge
//! ([`crate::PasskeyBridgeResult`]) so the frontend can swap it in.
//!
//! ## Runtime status (read before testing)
//!
//! `ASAuthorizationController` only succeeds when the app is code-signed with the
//! `com.apple.developer.associated-domains` entitlement *and* that capability is
//! provisioned for the App ID. On a free Apple personal team this restricted
//! entitlement cannot be provisioned, so `performRequests` will call back with an
//! error at runtime. This module is therefore a **compiles-now, runtime-blocked**
//! scaffold: it will start working once `com.mykey.desktop` has the Associated
//! Domains capability enabled in a paid Apple Developer Program account and the
//! app is signed with the matching provisioning profile. See the v1-finishing plan
//! doc for the unblock checklist.
//!
//! Note: native passkeys are bound to the associated domain RP ID, so they are a
//! *separate* credential from any created via the localhost browser bridge.

use std::cell::RefCell;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;

use base64::Engine;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_authentication_services::{
    ASAuthorization, ASAuthorizationController, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding,
    ASAuthorizationPlatformPublicKeyCredentialAssertion,
    ASAuthorizationPlatformPublicKeyCredentialDescriptor,
    ASAuthorizationPlatformPublicKeyCredentialProvider,
    ASAuthorizationPlatformPublicKeyCredentialRegistration,
    ASAuthorizationPublicKeyCredentialPRFAssertionInput,
    ASAuthorizationPublicKeyCredentialPRFAssertionInputValues,
    ASAuthorizationPublicKeyCredentialPRFRegistrationInput, ASAuthorizationRequest,
    ASPresentationAnchor, ASPublicKeyCredential,
};
use objc2_foundation::{NSArray, NSData, NSError, NSString};
use rand::RngCore;
use tauri::{AppHandle, Manager};

use crate::PasskeyBridgeResult;

/// How long to wait for the user to complete the system passkey sheet.
const PASSKEY_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Register,
    Assert,
}

/// Plain-data request handed to the main thread (must be `Send`).
#[derive(Clone)]
struct Request {
    mode: Mode,
    rp_id: String,
    user_name: String,
    user_id: Vec<u8>,
    credential_id: Vec<u8>,
    prf_salt: Vec<u8>,
}

/// `Send`-safe result delivered from the delegate callback back to the caller.
enum Outcome {
    Ok {
        credential_id: Vec<u8>,
        prf_first: Vec<u8>,
    },
    Err(String),
}

/// Always `true` on macOS — the build target gates this whole module. Whether the
/// call *succeeds* still depends on the Associated Domains entitlement at runtime.
pub fn is_available() -> bool {
    true
}

/// Register a new platform passkey bound to `rp_id` and derive a PRF key.
/// `prf_salt_b64` is optional; when absent a fresh 32-byte salt is generated.
pub fn register(
    app: &AppHandle,
    rp_id: &str,
    user_name: &str,
    prf_salt_b64: Option<&str>,
) -> Result<PasskeyBridgeResult, String> {
    let prf_salt = match prf_salt_b64 {
        Some(value) if !value.trim().is_empty() => decode_b64_any(value)?,
        _ => random_bytes(32),
    };
    let user_id = random_bytes(32);
    let request = Request {
        mode: Mode::Register,
        rp_id: rp_id.to_string(),
        user_name: if user_name.trim().is_empty() {
            "MyKey".to_string()
        } else {
            user_name.to_string()
        },
        user_id,
        credential_id: Vec::new(),
        prf_salt,
    };
    run(app, request)
}

/// Assert an existing platform passkey (`credential_id_b64`) and re-derive its PRF key.
pub fn assert(
    app: &AppHandle,
    rp_id: &str,
    credential_id_b64: &str,
    prf_salt_b64: &str,
) -> Result<PasskeyBridgeResult, String> {
    let credential_id = decode_b64_any(credential_id_b64)?;
    let prf_salt = decode_b64_any(prf_salt_b64)?;
    let request = Request {
        mode: Mode::Assert,
        rp_id: rp_id.to_string(),
        user_name: String::new(),
        user_id: Vec::new(),
        credential_id,
        prf_salt,
    };
    run(app, request)
}

fn run(app: &AppHandle, request: Request) -> Result<PasskeyBridgeResult, String> {
    let (tx, rx) = mpsc::channel::<Outcome>();
    let app_main = app.clone();
    let request_main = request.clone();

    // `ASAuthorizationController` and its delegate are main-thread only.
    app.run_on_main_thread(move || {
        let err_tx = tx.clone();
        if let Err(message) = start_on_main(&app_main, &request_main, tx) {
            let _ = err_tx.send(Outcome::Err(message));
        }
    })
    .map_err(|e| format!("failed to dispatch passkey request to main thread: {e}"))?;

    match rx.recv_timeout(PASSKEY_TIMEOUT) {
        Ok(Outcome::Ok {
            credential_id,
            prf_first,
        }) => Ok(PasskeyBridgeResult {
            credential_id: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&credential_id),
            user_id: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&request.user_id),
            rp_id: request.rp_id,
            prf_salt: base64::engine::general_purpose::STANDARD_NO_PAD.encode(&request.prf_salt),
            prf_key_hex: to_hex(&prf_first),
        }),
        Ok(Outcome::Err(message)) => Err(message),
        Err(RecvTimeoutError::Timeout) => Err("native passkey timed out (120s)".to_string()),
        Err(RecvTimeoutError::Disconnected) => {
            Err("native passkey bridge closed unexpectedly".to_string())
        }
    }
}

/// Builds and fires the authorization controller. Runs on the main thread.
fn start_on_main(app: &AppHandle, request: &Request, tx: Sender<Outcome>) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("passkey bridge not on main thread")?;

    let window = app
        .get_webview_window("main")
        .ok_or("main window not available for passkey UI")?;
    let ns_window = window.ns_window().map_err(|e| e.to_string())?;
    if ns_window.is_null() {
        return Err("native window handle is null".to_string());
    }
    // The Tauri NSWindow is the presentation anchor for the system passkey sheet.
    let anchor: Retained<NSObject> = unsafe { Retained::retain(ns_window.cast::<NSObject>()) }
        .ok_or("failed to retain native window handle")?;

    let rp = NSString::from_str(&request.rp_id);
    let provider = unsafe {
        ASAuthorizationPlatformPublicKeyCredentialProvider::initWithRelyingPartyIdentifier(
            ASAuthorizationPlatformPublicKeyCredentialProvider::alloc(),
            &rp,
        )
    };
    let challenge = NSData::with_bytes(&random_bytes(32));
    let salt = NSData::with_bytes(&request.prf_salt);

    let auth_request: Retained<ASAuthorizationRequest> = match request.mode {
        Mode::Register => {
            let name = NSString::from_str(&request.user_name);
            let user_id = NSData::with_bytes(&request.user_id);
            let req = unsafe {
                provider.createCredentialRegistrationRequestWithChallenge_name_userID(
                    &challenge, &name, &user_id,
                )
            };
            let values = unsafe {
                ASAuthorizationPublicKeyCredentialPRFAssertionInputValues::initWithSaltInput1_saltInput2(
                    ASAuthorizationPublicKeyCredentialPRFAssertionInputValues::alloc(),
                    &salt,
                    None,
                )
            };
            let prf = unsafe {
                ASAuthorizationPublicKeyCredentialPRFRegistrationInput::initWithInputValues(
                    ASAuthorizationPublicKeyCredentialPRFRegistrationInput::alloc(),
                    Some(&values),
                )
            };
            unsafe { req.setPrf(Some(&prf)) };
            req.into_super()
        }
        Mode::Assert => {
            let req = unsafe { provider.createCredentialAssertionRequestWithChallenge(&challenge) };
            let cred_id = NSData::with_bytes(&request.credential_id);
            let descriptor = unsafe {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor::initWithCredentialID(
                    ASAuthorizationPlatformPublicKeyCredentialDescriptor::alloc(),
                    &cred_id,
                )
            };
            let allowed = NSArray::from_retained_slice(&[descriptor]);
            unsafe { req.setAllowedCredentials(&allowed) };

            let values = unsafe {
                ASAuthorizationPublicKeyCredentialPRFAssertionInputValues::initWithSaltInput1_saltInput2(
                    ASAuthorizationPublicKeyCredentialPRFAssertionInputValues::alloc(),
                    &salt,
                    None,
                )
            };
            // A single global salt is enough; no per-credential overrides needed.
            let prf = unsafe {
                ASAuthorizationPublicKeyCredentialPRFAssertionInput::initWithInputValues_perCredentialInputValues(
                    ASAuthorizationPublicKeyCredentialPRFAssertionInput::alloc(),
                    Some(&values),
                    None,
                )
            };
            unsafe { req.setPrf(Some(&prf)) };
            req.into_super()
        }
    };

    let delegate = PasskeyDelegate::new(mtm, request.mode, tx, anchor);
    let requests = NSArray::from_retained_slice(&[auth_request]);
    let controller = unsafe {
        ASAuthorizationController::initWithAuthorizationRequests(
            ASAuthorizationController::alloc(),
            &requests,
        )
    };
    let delegate_protocol = ProtocolObject::from_ref(&*delegate);
    unsafe {
        controller.setDelegate(Some(delegate_protocol));
        controller.setPresentationContextProvider(Some(ProtocolObject::from_ref(&*delegate)));
        controller.performRequests();
    }

    // The controller fires its delegate asynchronously on the run loop, so both
    // must outlive this function. Scaffold simplification: leak them (a few hundred
    // bytes per rare auth action). TODO: move to a thread-local registry that the
    // delegate evicts itself from on completion to avoid the leak.
    std::mem::forget(controller);
    std::mem::forget(delegate);
    Ok(())
}

struct DelegateIvars {
    mode: Mode,
    tx: RefCell<Option<Sender<Outcome>>>,
    anchor: Retained<NSObject>,
}

define_class!(
    // SAFETY:
    // - Superclass NSObject has no subclassing requirements.
    // - The class does not implement `Drop`; ivars are dropped by the generated dealloc.
    // - Delegate + presentation-context callbacks are main-thread only, matching the protocols.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MyKeyPasskeyDelegate"]
    #[ivars = DelegateIvars]
    struct PasskeyDelegate;

    unsafe impl NSObjectProtocol for PasskeyDelegate {}

    unsafe impl ASAuthorizationControllerDelegate for PasskeyDelegate {
        #[unsafe(method(authorizationController:didCompleteWithAuthorization:))]
        unsafe fn did_complete(
            &self,
            _controller: &ASAuthorizationController,
            authorization: &ASAuthorization,
        ) {
            let outcome = self.extract(authorization);
            self.send(outcome);
        }

        #[unsafe(method(authorizationController:didCompleteWithError:))]
        unsafe fn did_error(&self, _controller: &ASAuthorizationController, error: &NSError) {
            let message = error.localizedDescription().to_string();
            self.send(Outcome::Err(format!("native passkey failed: {message}")));
        }
    }

    unsafe impl ASAuthorizationControllerPresentationContextProviding for PasskeyDelegate {
        #[unsafe(method_id(presentationAnchorForAuthorizationController:))]
        unsafe fn presentation_anchor(
            &self,
            _controller: &ASAuthorizationController,
        ) -> Retained<ASPresentationAnchor> {
            self.ivars().anchor.clone()
        }
    }
);

impl PasskeyDelegate {
    fn new(
        mtm: MainThreadMarker,
        mode: Mode,
        tx: Sender<Outcome>,
        anchor: Retained<NSObject>,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(DelegateIvars {
            mode,
            tx: RefCell::new(Some(tx)),
            anchor,
        });
        unsafe { objc2::msg_send![super(this), init] }
    }

    fn send(&self, outcome: Outcome) {
        if let Some(tx) = self.ivars().tx.borrow_mut().take() {
            let _ = tx.send(outcome);
        }
    }

    fn extract(&self, authorization: &ASAuthorization) -> Outcome {
        let credential = unsafe { authorization.credential() };
        match self.ivars().mode {
            Mode::Register => {
                let registration = match credential
                    .downcast::<ASAuthorizationPlatformPublicKeyCredentialRegistration>(
                ) {
                    Ok(value) => value,
                    Err(_) => {
                        return Outcome::Err(
                            "unexpected credential type returned for registration".to_string(),
                        )
                    }
                };
                let credential_id = unsafe { registration.credentialID() }.to_vec();
                let prf = match unsafe { registration.prf() } {
                    Some(value) => value,
                    None => {
                        return Outcome::Err(
                            "this passkey did not return a PRF result on registration".to_string(),
                        )
                    }
                };
                match unsafe { prf.first() } {
                    Some(first) => Outcome::Ok {
                        credential_id,
                        prf_first: first.to_vec(),
                    },
                    None => Outcome::Err("PRF registration output was empty".to_string()),
                }
            }
            Mode::Assert => {
                let assertion = match credential
                    .downcast::<ASAuthorizationPlatformPublicKeyCredentialAssertion>()
                {
                    Ok(value) => value,
                    Err(_) => {
                        return Outcome::Err(
                            "unexpected credential type returned for assertion".to_string(),
                        )
                    }
                };
                let credential_id = unsafe { assertion.credentialID() }.to_vec();
                let prf = match unsafe { assertion.prf() } {
                    Some(value) => value,
                    None => {
                        return Outcome::Err(
                            "this passkey did not return a PRF result on assertion".to_string(),
                        )
                    }
                };
                let first = unsafe { prf.first() };
                Outcome::Ok {
                    credential_id,
                    prf_first: first.to_vec(),
                }
            }
        }
    }
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

/// Accept either standard or URL-safe base64, with or without padding.
fn decode_b64_any(value: &str) -> Result<Vec<u8>, String> {
    let trimmed = value.trim();
    let engines = [
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::STANDARD_NO_PAD,
        base64::engine::general_purpose::URL_SAFE,
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ];
    for engine in engines {
        if let Ok(bytes) = engine.decode(trimmed) {
            return Ok(bytes);
        }
    }
    Err(format!("invalid base64 value: {trimmed}"))
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
