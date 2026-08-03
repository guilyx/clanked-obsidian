# Security model

Your vault is personal data; this document is honest about what protects it and what doesn't.

## Layers

1. **Network reachability.**
   - Server binds to `127.0.0.1` — never directly reachable from any network interface.
   - `tailscale serve`: only devices authenticated into *your* tailnet can even open a TCP connection. This is the strongest posture; prefer it.
   - `tailscale funnel`: the URL is reachable from the whole internet. The hostname is guessable-ish (`<machine>.<tailnet>.ts.net`), so assume it will be probed and rely on the token, not obscurity.

2. **Transport encryption.** Tailscale terminates HTTPS with a real certificate for `*.ts.net`. The token never travels in cleartext.

3. **Application auth.** Every `/mcp` request needs `Authorization: Bearer <AUTH_TOKEN>` (or `x-api-key`). Comparison is timing-safe. The server refuses to start in HTTP mode without a token — there is no "open" mode to misconfigure. Only `/healthz` is unauthenticated, and it reveals nothing but liveness.

4. **Vault jail.** Every path is resolved against the vault root; `..`, absolute paths, and symlinks pointing outside the vault are refused. `EXCLUDE_DIRS` (default `.obsidian`, `.trash`, `.git`) are invisible to listing, search, read and write.

5. **Capability gates.**
   - `READ_ONLY=true` removes the write tools entirely (they're not registered, so Claude can't even see them).
   - `delete_note` doesn't exist unless `ALLOW_DELETE=true`. Deletes are permanent — there is no trash.
   - Writes only touch `.md` files; reads are capped at `MAX_READ_BYTES`.

6. **OS-level containment (optional, recommended).** The systemd unit uses `ProtectSystem=strict` + `ReadWritePaths=<vault>` so even a bug in this server can't write outside the vault. The Docker setup can mount the vault `:ro` for a hardware-guaranteed read-only mode.

## Threats this handles

- Random internet scanners hitting the funnel URL → 401, timing-safe.
- A prompt-injected Claude trying to read `~/.ssh` or `/etc/passwd` → vault jail refuses.
- Claude being talked into deleting notes → tool doesn't exist unless you opted in.
- Token leaking into logs via URL → token travels in a header, never the URL.

## Threats this does NOT handle

- **Whoever has the token has your vault.** Rotating it is cheap: change `AUTH_TOKEN`, restart, update the connector. Rotate if you ever paste it somewhere dubious.
- **Prompt injection *within* the vault scope.** A note containing malicious instructions could influence what Claude does with your other notes (exfiltrating content into a conversation, overwriting notes if writes are enabled). If your vault contains web clippings or shared content, run `READ_ONLY=true`.
- **Anthropic sees vault content you ask Claude about.** Same trust decision as pasting a note into the chat, made continuously.

## Recommended postures

| Situation | Setting |
|---|---|
| Trying it out | `tailscale serve` only, `READ_ONLY=true` |
| Daily driver, own devices | `serve` only, writes on, `ALLOW_DELETE=false` |
| claude.ai / phone access | `funnel`, writes on if you want them, keep private folders in `EXCLUDE_DIRS` |
| Vault with sensitive folders | Add them to `EXCLUDE_DIRS`, or point `VAULT_PATH` at a sub-folder |

## Rotating the token

```bash
openssl rand -hex 32          # new token
nano /opt/clanked-obsidian/.env
sudo systemctl restart clanked-obsidian
# then update the header in Claude Code / Desktop / claude.ai connector
```
