# Routeless: The Last Mile — Dakshina Kannada AI Rural Student Bus Platform

An AI-assisted rural student transportation platform built for **Dakshina Kannada** covering **52 educational institutions**, **45 rural/urban stops**, and **50 KSRTC-style corridors**.

## Key Features
- **First-Time Ticket Mode Setup**: Differentiates **Student Bus Pass** (1-tap "I Boarded" app check-in) from **Normal Paid Tickets** & **Women Free (Aadhaar/Shakti)** tickets (tracked via Conductor Smart ETM).
- **Exact 3-Tier Crowd Logic**:
  - `< 100%` Capacity: Green (Empty / Seats Available)
  - `100% – 140%` Capacity: Amber (Moderate / Standing)
  - `> 140%` Capacity: Red (Fully Crowded — Skip-Stop Risk Alert)
- **All Direct + 1-Transfer Backup Routes**: Finds every direct route and suggests 1-transfer hub backups (BC Road, Puttur, Pumpwell, Moodabidri, Uppinangady) if primary buses are overcrowded or cancelled.
- **Live Simulated GPS & Conductor ETM Simulator**: Interactive Leaflet map with 2-second GPS ticks and a built-in Conductor ETM drawer for live testing.
- **Rural "Students Waiting" Beacon**: Aggregates stranded student counts at rural stops.

## Prototype Disclosure
Live KSRTC schedules, hardware GPS streams, and live ETM server webhooks are simulated in `data.js` / `app.js` for prototype demonstration. Production rollout requires connecting these feeds to official KSRTC/Government APIs.