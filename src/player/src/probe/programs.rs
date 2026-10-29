//! The `programs` probe (Phase 3): every program as `state.programs` reports it, plus each
//! item's `skip`/`broken`/`failed` flags (`recipes::program::Programs::probe`).

use serde_json::Value;

use crate::graph::ApiError;
use crate::runtime::Runtime;

pub fn programs(rt: &mut Runtime, _args: &Value) -> Result<Value, ApiError> {
    Ok(rt.programs.probe())
}
