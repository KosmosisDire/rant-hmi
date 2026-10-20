//! The one gate every screen's action passes. It allows everything until users and roles
//! exist, and then roles plug in here and nowhere else.

use crate::protocol::ClientMsg;

/// Who asks: a screen's session now, a user and a role later.
pub struct Who {
    pub session: u32,
}

pub fn authorize(_who: &Who, _action: &ClientMsg) -> Result<(), String> {
    Ok(())
}
