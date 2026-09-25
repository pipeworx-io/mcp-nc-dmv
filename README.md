# @pipeworx/nc-dmv

North Carolina DMV MCP — **live** wait times at every NCDMV driver license office and
license plate agency, plus the office directory the same feed carries. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

North Carolina and Oregon are the only two US states whose DMV publishes a
machine-readable live wait feed. Every other state's is captcha-gated, blocked to cloud
egress, broken, or only inside a phone app.

## Tools

- `nc_dmv_wait_times(office?, service?, open_only?, sort?, limit?)` — current average wait,
  longest wait, and open/closed status per office. 148 driver license offices; `service:
  "vehicle"` switches to the vehicle services / license plate agency units.
- `nc_dmv_offices(office?, city?, zip?, service?, district?, limit?)` — address, city, ZIP,
  phone, posted hours and NCDMV district. This feed is the only machine-readable NCDMV
  office directory that exists, so it doubles as the state's office locator.

## Auth

None. Keyless and unauthenticated.

## Data source

`https://wait.services.ncdot.gov/IWT/IWTWeb/XmlStats.aspx?controller=IWT_UnitsListXML&UnitID=<n>`

| UnitID | Root | Contents |
|--------|------|----------|
| `2` | Driver Services | 148 driver license offices |
| `182` | Vehicle Services | license plate agency units (1 as of 2026-07-29) |

## Gotchas this pack handles for you

### Closed-hours zeros are data, not gaps

Outside posted business hours **every** office reports `OfficeStatus` `Closed` with
`AvgWT`/`MaxWT` of `0:00:00`. That is NCDMV reporting an idle queue — it is neither an
error nor a missing value, and it must not be read as "walk right in".

Responses therefore always carry `offices_open`, and when nothing is open the `note` says
the wait figures are idle-queue zeros. `sort: "wait"` puts open offices ahead of closed
ones for the same reason: a shortest-wait ranking would otherwise be won by 148 closed
offices tied at zero.

### The feed is a tree, and the sentinel row lies about its parent

`UnitID=2` returns 161 `<Unit>` blocks: one root (`Driver Services`, `UnitLevel` 1), eleven
districts (level 2), the 148 real offices (level 3), and a sentinel named `Invalid`. For
`UnitID=182` the real unit sits at level 2 instead.

So the pack keeps **leaves** — any `UnitId` never named as another unit's `ParentUnitId` —
rather than filtering on `UnitLevel`, which survives NCDOT re-organising the tree.

The ordering matters: the `Invalid` sentinel hangs off a **real office** (Greensboro West,
`ParentUnitId=143`). Computing the parent set before dropping `Invalid` demotes that office
out of the results and yields 147 offices where NCDMV publishes 148. `Invalid` is dropped
first.

### Addresses

`--` is the feed's null. The separate `<ZipCode>` tag is empty on every single unit, so the
ZIP has to be parsed out of the one-line `Address` string
(`"521 S. Sandhills Blvd., Aberdeen, NC 28315"`). That line is not consistently punctuated:
some offices embed newlines, omit the comma before the city, or drop `NC` altogether
(`"2479 E. Fifth St., Lumberton  28358"`). The parser peels from the right — ZIP, then the
state token, then the city at the last comma — and returns the whole string in `address`
with `city: null` when the city cannot be separated from the street safely.

Current coverage: 118 of 148 offices carry an address at all (NCDMV leaves 30 blank);
of those, 118 ZIPs and 116 cities parse. `offices_missing_address` reports the gap.

Some entries are stale on NCDMV's side — `Greensboro Express OLD` still appears in the
feed. They are returned as published rather than second-guessed.

### Wait units

`AvgWT` / `MaxWT` are `H:MM:SS`; the pack converts them to whole minutes.

## Related

- `or_dmv_wait_times` / `or_dmv_offices` — Oregon, the other live state wait feed.
- `ca_dmv_offices` — California field offices (no wait feed published).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nc-dmv": {
      "url": "https://gateway.pipeworx.io/nc-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/nc-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nc_dmv_wait_times \
  -H 'Content-Type: application/json' \
  -d '{"office":"Raleigh"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nc_dmv_wait_times`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "nc-dmv": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-nc-dmv"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-nc-dmv
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Nc Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
