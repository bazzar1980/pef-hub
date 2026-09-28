//! Loads the PEM certificate chain + private key used by every WSS listener.
//! Replace the test certificate by pointing tls.certPath / tls.keyPath to the customer's files.
use std::{fs::File, io::BufReader, sync::Arc};

use anyhow::{anyhow, Context};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::TlsAcceptor;

pub fn load_acceptor(cert_path: &str, key_path: &str) -> anyhow::Result<TlsAcceptor> {
    let certs: Vec<CertificateDer<'static>> =
        rustls_pemfile::certs(&mut BufReader::new(File::open(cert_path).with_context(|| format!("opening {cert_path}"))?))
            .collect::<Result<_, _>>()
            .with_context(|| format!("parsing certificates in {cert_path}"))?;
    if certs.is_empty() {
        return Err(anyhow!("no certificate found in {cert_path}"));
    }

    let key: PrivateKeyDer<'static> =
        rustls_pemfile::private_key(&mut BufReader::new(File::open(key_path).with_context(|| format!("opening {key_path}"))?))
            .with_context(|| format!("parsing {key_path}"))?
            .ok_or_else(|| anyhow!("no private key found in {key_path}"))?;

    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("certificate and private key do not match")?;

    log::info!("TLS certificate loaded from {cert_path}");
    Ok(TlsAcceptor::from(Arc::new(config)))
}
