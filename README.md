# NetShield

NetShield is a local Windows 11 TCP/IP connection investigator. It runs a Node backend and React dashboard on localhost, polls Windows networking APIs, maps active TCP sessions to owning processes, stores rolling history in SQLite, and supports endpoint investigation with reverse DNS, RDAP/ASN lookup, and `tracert` route inspection.

## Run

```powershell
npm run install:all
npm start
```

Open http://localhost:3010.

For development:

```powershell
npm run dev
```

## Test

```powershell
npm test
```

This runs backend unit tests and a frontend production build.

## Notes

- V1 monitors the local Windows machine, not whole-LAN packet capture.
- No Npcap or tshark dependency is required.
- Runtime data is stored in `backend/data/` and is intentionally ignored by git.
