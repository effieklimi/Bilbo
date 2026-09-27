use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod collector;
pub use collector::*;

/// Correlates one operation across Rust, the frontend, and a recovered draft.
/// This identifies an attempt, independently of the saved capture's identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationContext {
    pub operation_id: Uuid,
}

impl OperationContext {
    pub fn new() -> Self {
        Self {
            operation_id: Uuid::new_v4(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_round_trips_with_a_valid_camel_case_uuid() {
        let operation = OperationContext::new();
        let json = serde_json::to_value(&operation).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "operationId": operation.operation_id.to_string(),
            })
        );
        assert_eq!(
            serde_json::from_value::<OperationContext>(json).unwrap(),
            operation
        );
        assert_ne!(OperationContext::new(), operation);
    }

    #[test]
    fn context_requires_a_valid_operation_id() {
        for json in [
            serde_json::json!({}),
            serde_json::json!({ "operationId": "not-a-uuid" }),
            serde_json::json!({ "operationId": null }),
        ] {
            assert!(serde_json::from_value::<OperationContext>(json).is_err());
        }
    }
}
