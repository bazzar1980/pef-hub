//! Wire protocol v1 - mirror of packages/protocol/src/index.ts
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

fn default_v() -> u32 {
    PROTOCOL_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    #[serde(default = "default_v")]
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crm_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

impl Envelope {
    pub fn new(kind: &str, payload: Value) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            kind: kind.to_string(),
            id: Some(uuid::Uuid::new_v4().to_string()),
            correlation_id: None,
            crm_id: None,
            tab_id: None,
            payload,
        }
    }

    pub fn correlation(mut self, c: Option<String>) -> Self {
        self.correlation_id = c;
        self
    }

    pub fn tab(mut self, t: Option<String>) -> Self {
        self.tab_id = t;
        self
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}
