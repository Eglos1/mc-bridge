Minecraft OpenClaw bridge (MindCraft-style, "TheOracle")
========================================================

ARCHITECTURE
------------
In-game chat -> [oracle-brain.js (mineflayer "mod")] -> OpenClaw Gateway
  /v1/chat/completions (model openclaw/minecraft) -> Ollama (llama3.2:3b / 1b)
  -> reply -> in-game chat

- The Minecraft agent (openclaw/minecraft) is an ISOLATED OpenClaw agent with
  NO messaging-channel bindings. Its only inbound path is this bridge.
- Provider is Ollama at localhost:11434. Primary model llama3.2:3b, fallback
  llama3.2:1b (configured in ~/.openclaw/openclaw.json -> agents.list.minecraft).
- The agent has ALL OpenClaw host tools denied -> a pure brain (also blocks
  in-game prompt injection from running host commands). The bridge exposes a
  small set of Minecraft actions as function tools instead.

BRAIN (two-phase tool loop)
---------------------------
llama3.2 never terminates a naive multi-turn tool loop (it re-calls tools
with garbage args forever), so the brain is strictly two-phase:
1. Phase 1: the model may call ONE set of Minecraft tools OR answer directly.
2. If it acted, Phase 2 sends the tool results WITHOUT any tools offered,
   forcing a plain-chat reply. Verified converging with 3b/1b.
Tool fallback: hallucinated raw-JSON tool calls in "content" are caught and
executed (contentToolCall), not relayed to the player.

Minecraft tools: get_state, move_to, follow, stop, look_at, dig, inventory, jump

COMPONENTS
----------
- /home/user/mc-bridge/oracle-brain.js   the bridge (chat relay + tools)
- ~/.config/systemd/user/minecraft-oracle.service  auto-start + restart
- ~/.openclaw/workspace-minecraft/{SOUL,USER,AGENTS}.md  agent persona/rules

BEHAVIOR
--------
- Replies in-game when addressed ("oracle", "hey", "hi", "yo") or whispered.
- Acts in-game via LLM tool calls (jump, inventory, move, dig, follow...).
- Direct movement commands (no brain needed): "follow <name>", "come to <name>",
  "stop", "look at <name>", "dig", "jump".
- Autonomous aliveness: head-tracks nearest player, re-follows when they walk
  off, stuck watchdog, perception file for external tooling.

DIAGNOSTICS
-----------
- tool-probe.js: standalone loop-convergence probe against the gateway (no MC
  connection needed).
- [tool] lines in bridge.log show every tool call the brain executed.

OPERATE
-------
  systemctl --user status minecraft-oracle     # bridge status
  journalctl --user -u minecraft-oracle -f     # live logs
  tail -f /home/user/mc-bridge/bridge.log   # bridge log
  tail -f /home/user/mc-bridge/chat.log     # in-game chat log
  curl -s http://127.0.0.1:18789/v1/models \
    -H "Authorization: Bearer <gateway token>"   # confirm openclaw/minecraft

To force the 1B model for a turn, send header "x-openclaw-model: ollama/llama3.2:1b".


## Builds

Prebuilt Windows / Linux / macOS artifacts are produced by the GitHub Actions workflow in `.github/workflows/build.yml` on every tag.

## License

MIT
