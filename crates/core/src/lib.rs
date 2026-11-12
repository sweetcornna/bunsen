//! Bunsen 核心库：服务器与密钥管理、在服务器的 tmux 里部署命令行编码代理、终端通道、工作区与科研面板。
//! 本机服务、命令行、MCP 三个入口都只调用这里的 `Core`。

pub mod agents;
pub mod core;
pub mod error;
pub mod import;
pub mod keys;
pub mod model;
pub mod plugins;
pub mod probe;
pub mod sessions;
pub mod shell;
pub mod ssh;
pub mod sshconfig;
pub mod store;
pub mod term;
pub mod tmux;
pub mod util;
pub mod workspace;

pub use crate::core::{Core, VERSION};
pub use crate::error::{Code, Error, Result};
