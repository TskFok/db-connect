use super::*;
use tokio_rustls::rustls::{
    pki_types::PrivatePkcs8KeyDer,
    server::{ClientHello, ResolvesServerCert},
    sign::{CertifiedKey, Signer, SigningKey},
    ServerConfig, SignatureAlgorithm, SignatureScheme, SupportedProtocolVersion,
};

const SERVER_CERT: &[u8] = include_bytes!("../../../test-fixtures/tls/server.der");
const SERVER_KEY: &[u8] = include_bytes!("../../../test-fixtures/tls/server-key.der");

fn config_with_ca(host: &str, ca: &str) -> Config {
    let mut config = Config::new();
    config.host(host);
    config.trust_cert_ca(format!(
        "{}/test-fixtures/tls/{ca}",
        env!("CARGO_MANIFEST_DIR")
    ));
    config
}

fn server_config(
    version: &'static SupportedProtocolVersion,
    invalid_signature: bool,
) -> ServerConfig {
    server_config_with_cert(version, invalid_signature, SERVER_CERT)
}

fn server_config_with_cert(
    version: &'static SupportedProtocolVersion,
    invalid_signature: bool,
    certificate: &'static [u8],
) -> ServerConfig {
    let builder = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_protocol_versions(&[version])
        .unwrap()
        .with_no_client_auth();
    let certs = vec![CertificateDer::from(certificate)];
    if invalid_signature {
        builder.with_cert_resolver(Arc::new(InvalidSignatureResolver(Arc::new(
            CertifiedKey::new(certs, Arc::new(InvalidSignatureKey)),
        ))))
    } else {
        builder
            .with_single_cert(certs, PrivatePkcs8KeyDer::from(SERVER_KEY).into())
            .unwrap()
    }
}

// A deliberately broken TLS peer: presents a valid certificate but does not
// prove possession of its private key. This exercises the real handshake.
#[derive(Debug)]
struct InvalidSignatureKey;
impl SigningKey for InvalidSignatureKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        offered
            .contains(&SignatureScheme::RSA_PSS_SHA256)
            .then(|| Box::new(Self) as Box<dyn Signer>)
    }
    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::RSA
    }
}
impl Signer for InvalidSignatureKey {
    fn sign(&self, _message: &[u8]) -> Result<Vec<u8>, RustlsError> {
        Ok(vec![0; 256])
    }
    fn scheme(&self) -> SignatureScheme {
        SignatureScheme::RSA_PSS_SHA256
    }
}
#[derive(Debug)]
struct InvalidSignatureResolver(Arc<CertifiedKey>);
impl ResolvesServerCert for InvalidSignatureResolver {
    fn resolve(&self, _: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }
}

async fn handshake(
    config: Config,
    version: &'static SupportedProtocolVersion,
    invalid_signature: bool,
) -> crate::Result<()> {
    let (client, server) = tokio::io::duplex(1024);
    let acceptor =
        tokio_rustls::TlsAcceptor::from(Arc::new(server_config(version, invalid_signature)));
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        tokio::join!(
            async { TlsStream::new(&config, client.compat()).await.map(|_| ()) },
            async { acceptor.accept(server).await.map(|_| ()) }
        )
    })
    .await
    .expect("TLS handshake must finish without blocking");
    result.0
}

#[tokio::test]
async fn custom_ca_accepts_matching_hostname() {
    handshake(
        config_with_ca("db-connect.test", "ca.pem"),
        &tokio_rustls::rustls::version::TLS12,
        false,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn custom_ca_rejects_wrong_hostname() {
    assert!(handshake(
        config_with_ca("wrong.test", "ca.pem"),
        &tokio_rustls::rustls::version::TLS12,
        false
    )
    .await
    .is_err());
}

#[tokio::test]
async fn custom_ca_rejects_unrelated_issuer() {
    assert!(handshake(
        config_with_ca("db-connect.test", "other-ca.pem"),
        &tokio_rustls::rustls::version::TLS12,
        false
    )
    .await
    .is_err());
}

#[tokio::test]
async fn validating_mode_rejects_invalid_tls12_and_tls13_signatures() {
    assert!(handshake(
        config_with_ca("db-connect.test", "ca.pem"),
        &tokio_rustls::rustls::version::TLS12,
        true
    )
    .await
    .is_err());
    assert!(handshake(
        config_with_ca("db-connect.test", "ca.pem"),
        &tokio_rustls::rustls::version::TLS13,
        true
    )
    .await
    .is_err());
}

#[tokio::test]
async fn trust_cert_accepts_untrusted_certificate_and_hostname() {
    let mut config = Config::new();
    config.host("wrong.test");
    config.trust_cert();
    handshake(config, &tokio_rustls::rustls::version::TLS12, false)
        .await
        .unwrap();
}

#[tokio::test]
async fn trust_cert_retains_explicit_tls12_verification_bypass() {
    let mut config = Config::new();
    config.host("wrong.test");
    config.trust_cert();
    handshake(config, &tokio_rustls::rustls::version::TLS12, true)
        .await
        .unwrap();
}

#[tokio::test]
async fn trust_cert_accepts_legacy_x509v1_self_signed_certificate() {
    let mut config = Config::new();
    config.host("wrong.test");
    config.trust_cert();
    let server_config = server_config_with_cert(
        &tokio_rustls::rustls::version::TLS12,
        false,
        include_bytes!("../../../test-fixtures/tls/legacy-self-signed.der"),
    );
    let (client, server) = tokio::io::duplex(1024);
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
    let (client, server) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        tokio::join!(
            TlsStream::new(&config, client.compat()),
            acceptor.accept(server)
        )
    })
    .await
    .unwrap();
    assert!(
        client.is_ok(),
        "explicit trust_cert must retain legacy SQL Server certificate compatibility"
    );
    assert!(server.is_ok());
}

#[tokio::test]
async fn trust_cert_rejects_invalid_tls13_handshake_signature() {
    let mut config = Config::new();
    config.host("wrong.test");
    config.trust_cert();
    assert!(
        handshake(config, &tokio_rustls::rustls::version::TLS13, true)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn trust_cert_accepts_valid_tls13_signature() {
    let mut config = Config::new();
    config.host("wrong.test");
    config.trust_cert();
    handshake(config, &tokio_rustls::rustls::version::TLS13, false)
        .await
        .unwrap();
}

#[tokio::test]
async fn custom_ca_accepts_tls13_and_preserves_async_stream_io() {
    use futures_util::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    // Allow TLS 1.3 session tickets to drain before application writes; the
    // 128 KiB payload still exceeds both this buffer and a TLS record.
    let (client, server) = tokio::io::duplex(1024);
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config(
        &tokio_rustls::rustls::version::TLS13,
        false,
    )));
    let config = config_with_ca("db-connect.test", "ca.pem");
    let payload = vec![0x5a; 128 * 1024];
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let (client_result, server_result) = tokio::join!(
            async {
                let mut tls = TlsStream::new(&config, client.compat()).await.unwrap();
                tls.write_all(&payload).await.unwrap();
                tls.flush().await.unwrap();
                let mut received = vec![0; payload.len()];
                tls.read_exact(&mut received).await.unwrap();
                assert_eq!(received, payload);
                tls.close().await.unwrap();
            },
            async {
                let mut tls = acceptor.accept(server).await.unwrap();
                let mut received = vec![0; payload.len()];
                tls.read_exact(&mut received).await.unwrap();
                assert_eq!(received, payload);
                tls.write_all(&received).await.unwrap();
                tls.flush().await.unwrap();
                let mut byte = [0];
                assert_eq!(
                    tls.read(&mut byte).await.unwrap(),
                    0,
                    "client close must reach the TLS peer"
                );
            }
        );
        let _ = (client_result, server_result);
    })
    .await
    .expect("fragmented TLS read/write/flush/close must not deadlock");
}

#[tokio::test]
async fn custom_ca_rejects_missing_and_malformed_files() {
    let missing = config_with_ca("db-connect.test", "missing.pem");
    assert!(
        handshake(missing, &tokio_rustls::rustls::version::TLS12, false)
            .await
            .is_err()
    );
    // A private key is well-formed DER but is not a CA certificate.
    let malformed = config_with_ca("db-connect.test", "server-key.der");
    assert!(
        handshake(malformed, &tokio_rustls::rustls::version::TLS12, false)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn native_roots_fail_closed_without_panicking() {
    const CHILD: &str = "DB_CONNECT_TIBERIUS_EMPTY_ROOTS_TEST";
    if std::env::var_os(CHILD).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("client::tls_stream::rustls_tls_stream::tests::native_roots_fail_closed_without_panicking")
            .arg("--nocapture")
            .env(CHILD, "1")
            .env("SSL_CERT_FILE", "/db-connect-test-no-such-cert-file")
            .env("SSL_CERT_DIR", "/db-connect-test-no-such-cert-directory")
            .status().unwrap();
        assert!(
            status.success(),
            "missing native roots must return an error instead of panicking or trusting the peer"
        );
        return;
    }
    let (client, _server) = tokio::io::duplex(1024);
    let result = TlsStream::new(&Config::new(), client.compat()).await;
    assert!(
        matches!(result, Err(Error::Tls(message)) if message.contains("no usable CA certificates"))
    );
}

#[test]
fn invalid_hostname_only_has_a_fallback_for_explicit_trust_cert() {
    let mut config = Config::new();
    config.host("invalid host name");
    assert!(get_server_name(&config).is_err());
    config.trust_cert();
    assert!(get_server_name(&config).is_ok());
}
