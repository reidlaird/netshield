# NetShield Roadmap

Status as of 2026-07-06. NetShield today: live TCP polling via PowerShell, per-connection
byte counters + SNI/DNS capture via tshark, RDAP/ip-api/geoip endpoint investigation with
caching, tracert with Leaflet route maps, saved standalone HTML reports, LAN device
inventory from the Telus gateway, traffic sparklines, anomaly badges, process grouping,
and SNI domains in the inspector.

## Phase 1 — Finish & clean up

1. **Wire the reputation toggle.** The `optionalApisEnabled` setting is persisted and
   rendered but never read by the backend. Connect it to AbuseIPDB and/or VirusTotal,
   with API keys in a git-ignored `.env` (template in `.env.example`). Merge scores into
   the investigation `owner` block and drive a "flagged" badge from it.
2. **Split `App.tsx`.** It is ~1,700 lines holding ~15 components; move ConnectionTable,
   Inspector, sidebar panels, and StatStrip into `frontend/src/components/`.
3. **Small fixes.** ✅ Shipped 2026-07-06: `clearHistory` scoped to connection history
   (investigation/route caches survive), orphaned `WorldMapSvg.tsx` + map-generation
   leftovers deleted, sparkline now uses the backend's byte rates instead of
   recomputing client-side.

## Phase 2 — Put the "shield" in NetShield

4. **Alerting.** Promote anomaly badges into a rules engine (odd port, new country,
   reputation hit, upload-heavy ratio) with an in-app alert feed and Windows toast
   notifications.
5. **Baseline learning.** Use the SQLite history to flag first-time events: a process
   making its first outbound connection, or a first-seen destination country/ASN for a
   known process.
6. **One-click block.** Create a Windows Firewall rule for a remote IP from the
   inspector, with a confirmation step and a rules panel for review/undo.

## Phase 3 — History & analytics

7. **Timeline views.** Per-process bandwidth over time, connections per hour, top
   talkers — the data is already in SQLite but has no historical UI.
8. **Daily digest.** Scheduled email summary (new LAN devices, alerts fired, top
   destinations) via Gmail SMTP + a Windows Scheduled Task.

## Phase 4 — Hardening & always-on

9. **Auth/bind.** Bind to `127.0.0.1` by default or token-gate the server; today anyone
   on the LAN can read connection history, and router credentials sit in plaintext `.env`.
10. **Cheaper collection.** Keep a persistent PowerShell session streaming JSON instead
    of spawning a new process every 2-second poll.
11. **Run as a service.** Register a Scheduled Task at logon so monitoring and alerting
    work without a manually started terminal (prerequisite for Phase 2 alerts to matter).
12. **Tests.** Add server route tests and frontend tests around the alert rules, which
    become correctness-critical once they trigger notifications. Current coverage: 12
    backend unit tests, zero frontend tests.

## Known technical debt (tracked above)

- Monolithic `App.tsx` (Phase 1.2)
- Open, unauthenticated server on `0.0.0.0:3010` (Phase 4.9)
- Full PowerShell process spawned per poll (Phase 4.10)
- `clearHistory` over-deletes (Phase 1.3)
- Dead code: `WorldMapSvg.tsx` and root map-generation leftovers (Phase 1.3)
- `geoIpDatabasePath` setting stored/edited but unused
