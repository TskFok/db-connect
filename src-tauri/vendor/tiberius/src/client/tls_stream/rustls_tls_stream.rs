use crate::{
    client::{config::Config, TrustConfig},
    error::IoErrorKind,
    Error,
};
use futures_util::io::{AsyncRead, AsyncWrite};
use std::{
    fs, io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio_rustls::{
    rustls::{
        client::{
            danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
            WantsClientCert,
        },
        crypto::{ring, verify_tls13_signature, WebPkiSupportedAlgorithms},
        pki_types::{CertificateDer, ServerName, UnixTime},
        ClientConfig, ConfigBuilder, DigitallySignedStruct, Error as RustlsError, RootCertStore,
        SignatureScheme, WantsVerifier,
    },
    TlsConnector,
};
use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use tracing::{event, Level};

#[cfg(test)]
#[path = "rustls_tls_tests.rs"]
mod tests;

impl From<tokio_rustls::rustls::Error> for Error {
    fn from(e: tokio_rustls::rustls::Error) -> Self {
        crate::Error::Tls(e.to_string())
    }
}

pub(crate) struct TlsStream<S: AsyncRead + AsyncWrite + Unpin + Send>(
    Compat<tokio_rustls::client::TlsStream<Compat<S>>>,
);

#[derive(Debug)]
struct NoCertVerifier(WebPkiSupportedAlgorithms);

impl ServerCertVerifier for NoCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        // Preserve tiberius 0.12.3's explicit trust_cert TLS 1.2 bypass;
        // changing that contract is outside this dependency migration.
        // Validating modes never use this verifier. TLS 1.3 keeps the
        // upstream 0.12.3 signature check below.
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, dss, &self.0)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_schemes()
    }
}

fn get_server_name(config: &Config) -> crate::Result<ServerName<'static>> {
    match (ServerName::try_from(config.get_host()), &config.trust) {
        (Ok(sn), _) => Ok(sn.to_owned()),
        (Err(_), TrustConfig::TrustAll) => {
            Ok(ServerName::try_from("placeholder.domain.com").unwrap())
        }
        (Err(e), _) => Err(crate::Error::Tls(e.to_string())),
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> TlsStream<S> {
    pub(super) async fn new(config: &Config, stream: S) -> crate::Result<Self> {
        event!(Level::INFO, "Performing a TLS handshake");

        // Select a provider locally: other clients may also enable aws-lc-rs,
        // and a library must not replace the application's process-wide choice.
        let provider = Arc::new(ring::default_provider());
        let builder = ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()?;

        let client_config = match &config.trust {
            TrustConfig::CaCertificateLocation(path) => {
                if let Ok(buf) = fs::read(path) {
                    let cert = match path.extension() {
                            Some(ext)
                            if ext.to_ascii_lowercase() == "pem"
                                || ext.to_ascii_lowercase() == "crt" =>
                                {
                                    let pem_cert = rustls_pemfile::certs(&mut buf.as_slice())
                                        .collect::<io::Result<Vec<_>>>()?;
                                    if pem_cert.len() != 1 {
                                        return Err(crate::Error::Io {
                                            kind: IoErrorKind::InvalidInput,
                                            message: format!("Certificate file {} contain 0 or more than 1 certs", path.to_string_lossy()),
                                        });
                                    }

                                    pem_cert.into_iter().next().unwrap()
                                }
                            Some(ext) if ext.to_ascii_lowercase() == "der" => {
                                CertificateDer::from(buf)
                            }
                            Some(_) | None => return Err(crate::Error::Io {
                                kind: IoErrorKind::InvalidInput,
                                message: "Provided CA certificate with unsupported file-extension! Supported types are pem, crt and der.".to_string(),
                            }),
                        };
                    let mut cert_store = RootCertStore::empty();
                    cert_store.add(cert)?;
                    builder
                        .with_root_certificates(cert_store)
                        .with_no_client_auth()
                } else {
                    return Err(Error::Io {
                        kind: IoErrorKind::InvalidData,
                        message: "Could not read provided CA certificate!".to_string(),
                    });
                }
            }
            TrustConfig::TrustAll => {
                event!(
                    Level::WARN,
                    "Trusting the server certificate without validation."
                );
                let mut config = builder
                    .with_root_certificates(RootCertStore::empty())
                    .with_no_client_auth();
                config
                    .dangerous()
                    .set_certificate_verifier(Arc::new(NoCertVerifier(
                        provider.signature_verification_algorithms,
                    )));
                // config.enable_sni = false;
                config
            }
            TrustConfig::Default => {
                event!(Level::INFO, "Using default trust configuration.");
                builder.with_native_roots()?.with_no_client_auth()
            }
        };

        let connector = TlsConnector::from(Arc::new(client_config));

        let tls_stream = connector
            .connect(get_server_name(config)?, stream.compat())
            .await?;

        Ok(TlsStream(tls_stream.compat()))
    }

    pub(crate) fn get_mut(&mut self) -> &mut S {
        self.0.get_mut().get_mut().0.get_mut()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> AsyncRead for TlsStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        let inner = Pin::get_mut(self);
        Pin::new(&mut inner.0).poll_read(cx, buf)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> AsyncWrite for TlsStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let inner = Pin::get_mut(self);
        Pin::new(&mut inner.0).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let inner = Pin::get_mut(self);
        Pin::new(&mut inner.0).poll_flush(cx)
    }

    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let inner = Pin::get_mut(self);
        Pin::new(&mut inner.0).poll_close(cx)
    }
}

trait ConfigBuilderExt {
    fn with_native_roots(self) -> crate::Result<ConfigBuilder<ClientConfig, WantsClientCert>>;
}

impl ConfigBuilderExt for ConfigBuilder<ClientConfig, WantsVerifier> {
    fn with_native_roots(self) -> crate::Result<ConfigBuilder<ClientConfig, WantsClientCert>> {
        let mut roots = RootCertStore::empty();
        let mut valid_count = 0;
        let mut invalid_count = 0;

        let native = rustls_native_certs::load_native_certs();
        for error in native.errors {
            tracing::event!(
                Level::DEBUG,
                "could not load platform certificate: {:?}",
                error
            );
        }
        for cert in native.certs {
            match roots.add(cert) {
                Ok(_) => valid_count += 1,
                Err(err) => {
                    tracing::event!(Level::DEBUG, "certificate parsing failed: {:?}", err);
                    invalid_count += 1
                }
            }
        }
        tracing::event!(
            Level::TRACE,
            "with_native_roots processed {} valid and {} invalid certs",
            valid_count,
            invalid_count
        );
        if roots.is_empty() {
            return Err(Error::Tls(
                "no usable CA certificates found in the platform trust store".into(),
            ));
        }

        Ok(self.with_root_certificates(roots))
    }
}
