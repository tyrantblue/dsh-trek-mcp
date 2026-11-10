# dsh-trek-mcp

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that
connects a self-hosted [TREK](https://github.com/liketrek/TREK) travel planner to
the agent over MCP.

Enter the MCP endpoint, a TREK **machine OAuth client** id and its secret in
**Settings → TREK MCP**; the plugin obtains and renews the short-lived access
token itself and keeps the MCP session alive. No credentials, no `cordis.patch.yml`
editing.

![license](https://img.shields.io/badge/license-MIT-blue)
![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.2--rc.1-4D6BFE)
![topic](https://img.shields.io/badge/topic-dsh--plugin-8250df)

## What you get

- TREK's MCP tools as `mcp__trek__*` — trips, days, places, tours, bookings,
  budgets, packing lists, collections, journeys and the rest of the TREK MCP
  surface — plus its resources and help prompts.
- A **Settings → TREK MCP** page with three inputs (endpoint, client id, client
  secret), an optional token URL, **Test connection** and **Save and reconnect**.
- Automatic OAuth 2.1 `client_credentials` tokens: renewed 5 minutes before
  expiry, refreshed after a 401, held in process memory only.
- Idle-session recovery: TREK ends an MCP session after an hour without requests
  (`MCP_SESSION_TTL`); the plugin owns the session mapping and re-initializes it
  transparently, so the next tool call keeps working instead of answering
  `Session not found`.
- A loopback Streamable-HTTP proxy, so all MCP protocol handling stays in the
  shipped `@deepseek-ai/dsh-mcp-client` plugin and the client secret never
  reaches the model.

## Requirements

- DeepSeek Harness 0.2.2-rc.1 or newer (0.2.x line), Web profile.
- A TREK instance with the **MCP** addon enabled (Admin → Addons).
- A TREK **machine client** (Settings → Integrations → MCP Configuration →
  OAuth 2.1 Clients → New Client → tick *Machine client (no browser login)*).
  Grant the scopes the agent may use (`trips:*`, `places:*`, `budget:*`, …).
  Copy the `client_id` and the `client_secret` (`trekcs_…`, shown once).

## Install

DSH ships no default plugin index; install straight from this repository.

**Web (recommended).** Open **Plugins**, install the bundle from this spec:

```
github:tyrantblue/dsh-trek-mcp
```

or, pinned to a release:

```
git+https://github.com/tyrantblue/dsh-trek-mcp.git#v1.0.0
```

Then **reload the Web page once** so the browser picks up the new Settings page.

**CLI.** Install into a profile, then switch the bundle on in the Plugins page:

```sh
dsh plugin --profile web add github:tyrantblue/dsh-trek-mcp
```

## Configure

Open **Settings → TREK MCP**:

| Field | Meaning |
|---|---|
| MCP endpoint | `http://127.0.0.1:3000/mcp` for a local TREK docker install, or `https://<your-trek>/mcp` |
| Client ID | the machine client's UUID |
| Client secret | write-only; the page only shows whether one is saved, and leaving it empty keeps the stored one |
| Token URL | optional; defaults to the endpoint origin + `/oauth/token` |

**Test connection** mints a token with the entered values without saving.
**Save and reconnect** persists them into the harness profile patch (not into
the bundle) and restarts the connection; tools are unavailable for a few
seconds while the MCP session is rebuilt.

The page appears as a section in Settings; the section label follows the UI
language (`TREK MCP`).

## How it works

```mermaid
flowchart LR
  A[Agent] --> C[<b>@deepseek-ai/dsh-mcp-client</b><br/>Streamable HTTP]
  C -->|127.0.0.1:17890/mcp| B[<b>trek-mcp-broker</b><br/>Host plugin]
  B -->|client_credentials| T[TREK /oauth/token]
  B -->|Bearer token + session| M[TREK /mcp]
  S[<b>Settings → TREK MCP</b><br/>browser plugin] -->|config editor| P[(profile patch)]
  P -.restart.-> B
```

Three Loader rows are installed by `cordis.patch.yml`:

| Row | Role |
|---|---|
| `trek-mcp-ui` | The row named after the package; carries the browser half (`dsh.client`) with the Settings page. |
| `trek-mcp-broker` | Host plugin. Mints and renews the token, serves the settings JSON API (`/api/trek-mcp/*`), and proxies the loopback endpoint to TREK. |
| `trek-mcp` | The shipped `@deepseek-ai/dsh-mcp-client`, pointed at the loopback proxy. Tool naming (`mcp__trek__…`), reconnects and resource handling are its job. |

The settings page never receives the secret back. Saves go through the harness
config editor, so they survive bundle reinstalls.

## Configuration reference

The `trek-mcp-broker` row accepts (all optional except where noted):

| Key | Default | Meaning |
|---|---|---|
| `endpoint` | `http://127.0.0.1:3000/mcp` | MCP endpoint of the TREK instance |
| `tokenUrl` | `<endpoint origin>/oauth/token` | OAuth token endpoint |
| `clientId` | — | machine client id (filled from Settings) |
| `clientSecret` | — | machine client secret (filled from Settings, or `TREK_MCP_CLIENT_SECRET` in the environment) |
| `listenPort` | `17890` | loopback proxy port; keep the `trek-mcp` row URL in sync |
| `scope` | client's allowed scopes | optional space-separated scope narrowing |

A plain-HTTP endpoint gets `X-Forwarded-Proto: https` added, because TREK runs
with `FORCE_HTTPS=true` behind a proxy and would otherwise redirect a POST to
its public HTTPS URL. Point `endpoint` at the public URL instead if you prefer
the Cloudflare/reverse-proxy path.

## Security

- The secret is stored in the harness profile patch (mode `600`), written by the
  settings page; it is never returned to the browser, logged, or sent to the model.
- The proxy binds `127.0.0.1` only. Anything local that can reach that port can
  use the token's scopes — the same trust boundary as the profile directory.
- The machine client acts as the TREK user who created it, limited to the scopes
  you selected. Grant only what the agent needs.
- Delete the TREK OAuth client (or rotate its secret) to revoke access; rotate in
  TREK and paste the new secret into Settings.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `TREK is not configured yet` / no `mcp__trek__*` tools | Fill the endpoint, client id and secret in Settings → TREK MCP and save. |
| `TREK token request rejected (HTTP 401)` | Wrong or rotated client secret, or the client is not a machine client. |
| `TREK token request rejected (HTTP 400)` | The client lacks one of the requested `scope`s. |
| Endpoint answers 301 instead of MCP | Plain-HTTP endpoint behind `FORCE_HTTPS`; the broker adds `X-Forwarded-Proto` for `http:` endpoints — or use the public HTTPS URL. |
| Tools vanish after a long idle period | Should recover automatically; if it does not, save the settings page again (reconnects) and report the log line. |
| `listenPort` already in use | Change `listenPort` and the `trek-mcp` row URL together. |

## Development

```
broker.js               Host plugin: token mint/renew, settings API, loopback proxy, session recovery
client.js               Browser plugin: Settings → TREK MCP page
cordis.patch.yml        the three Loader rows
locale/{en,zh}.json     plugin title/description shown by the plugin manager
icon.svg                plugin icon
test/                   node --test suite with a mock TREK MCP server
```

```sh
npm test          # node --test, no dependencies
```

The tests start a mock MCP upstream and exercise session mapping/recovery plus
the settings API (first-run boot, secret-free view, connection test, save).

## Links

- TREK: <https://github.com/liketrek/TREK> — built-in MCP server docs:
  <https://github.com/liketrek/TREK/wiki/MCP-Overview>
- DeepSeek Harness: <https://github.com/deepseek-ai/deepseek-harness>

## License

[MIT](LICENSE)
