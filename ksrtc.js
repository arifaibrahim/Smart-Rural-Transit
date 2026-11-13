let routes = JSON.parse(localStorage.getItem("rl_routes")) || structuredClone(INITIAL_ROUTES);
let depots = JSON.parse(localStorage.getItem("rl_depots")) || structuredClone(INITIAL_DEPOTS);
let blockedEdges = JSON.parse(localStorage.getItem("rl_blocked_edges")) || [];
let demandSurge = JSON.parse(localStorage.getItem("rl_surge")) || false;
let congestionLevel = localStorage.getItem("rl_congestion") || "clear";
let alertsLog = JSON.parse(localStorage.getItem("rl_alerts")) || [];

window.addEventListener("DOMContentLoaded", () => {
  if (sessionStorage.getItem("rl_ksrtc_auth") === "true") {
    showDashboard();
  }
});

function handleKsrtcLogin(e) {
  e.preventDefault();
  const u = document.getElementById("ksrtcUser").value.trim();
  const p = document.getElementById("ksrtcPass").value.trim();
  if (u === "admin" && p === "admin") {
    sessionStorage.setItem("rl_ksrtc_auth", "true");
    document.getElementById("ksrtcLoginError").classList.add("hidden");
    showDashboard();
  } else {
    document.getElementById("ksrtcLoginError").classList.remove("hidden");
  }
}

function showDashboard() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("ksrtcDashboard").classList.remove("hidden");
  populateControls();
  renderAllOps();
}

function logoutKsrtc() {
  sessionStorage.removeItem("rl_ksrtc_auth");
  document.getElementById("ksrtcUser").value = "";
  document.getElementById("ksrtcPass").value = "";
  document.getElementById("ksrtcDashboard").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
}

function populateControls() {
  document.getElementById("busSelect").innerHTML = routes
    .map(r => `<option value="${r.id}">${r.plate} — ${r.name}</option>`).join("");
  document.getElementById("roadSelect").innerHTML = ROAD_SEGMENTS
    .map(s => `<option value="${s.id}">${s.label}</option>`).join("");
}

function haversineKm(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function findNearestDepot(route) {
  const midStop = STOPS[route.stops[Math.floor(route.stops.length / 2)]];
  return depots.map(d => ({ depot: d, dist: haversineKm(midStop, STOPS[d.stopId]) }))
    .sort((a, b) => a.dist - b.dist)[0];
}

function pushAlert(type, title, msg) {
  alertsLog.unshift({ id: Date.now() + Math.random(), type, title, msg, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
  if (alertsLog.length > 25) alertsLog.pop();
}

// --- 1. Bus Breakdown & ETM ---
function toggleBreakdown() {
  const id = document.getElementById("busSelect").value;
  const r = routes.find(x => x.id === id);
  if (!r) return;
  r.cancelled = !r.cancelled;
  if (r.cancelled) {
    const nearest = findNearestDepot(r);
    pushAlert("breakdown", `Bus Breakdown: ${r.plate}`,
      `${r.name} unavailable. Nearest station alerted: ${nearest.depot.name} (${nearest.dist.toFixed(1)} km).`
    );
  } else {
    pushAlert("spare", `Bus Restored: ${r.plate}`, `${r.name} resumed operations.`);
  }
  saveAndRender();
}

function addEtmTickets(qty) {
  const id = document.getElementById("busSelect").value;
  const r = routes.find(x => x.id === id);
  if (!r) return;
  r.etmTickets += qty;
  saveAndRender();
}

// --- 2. Spare Bus Dispatch ---
function deploySpareBus(routeId, depotId) {
  const broken = routes.find(r => r.id === routeId);
  const depot = depots.find(d => d.id === depotId);
  if (!broken || !depot || !depot.spares.length) return;
  const sparePlate = depot.spares.shift();
  routes.unshift({
    ...structuredClone(broken),
    id: `SPARE_${Date.now()}`,
    plate: `${sparePlate} (SPARE)`,
    name: `[SPARE DISPATCH] ${broken.name}`,
    etmTickets: 14, passCount: 4, cancelled: false
  });
  pushAlert("spare", `Spare Bus Deployed: ${sparePlate}`,
    `${depot.name} deployed ${sparePlate} to replace ${broken.plate} (${broken.name}).`
  );
  populateControls();
  saveAndRender();
}

// --- 3. Road / Route Closure ---
function isEdgeBlocked(u, v) {
  return blockedEdges.includes(`${u}__${v}`) || blockedEdges.includes(`${v}__${u}`);
}
function findDetourPath(u, v) {
  const adj = {};
  const addLink = (x, y, w) => {
    if (isEdgeBlocked(x, y)) return;
    (adj[x] = adj[x] || []).push({ to: y, w });
    (adj[y] = adj[y] || []).push({ to: x, w });
  };
  routes.forEach(r => { for (let i = 0; i < r.stops.length - 1; i++) addLink(r.stops[i], r.stops[i + 1], 12); });
  EXTRA_ROAD_LINKS.forEach(([x, y, w]) => addLink(x, y, w));
  const dist = { [u]: 0 }, prev = {}, pq = [[0, u]];
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [d, cur] = pq.shift();
    if (cur === v) break;
    for (const e of (adj[cur] || [])) {
      if (d + e.w < (dist[e.to] ?? Infinity)) { dist[e.to] = d + e.w; prev[e.to] = cur; pq.push([dist[e.to], e.to]); }
    }
  }
  if (!prev[v]) return null;
  const path = []; let c = v;
  while (c) { path.unshift(c); c = prev[c]; }
  return path.map(id => STOPS[id].name).join(" → ");
}

function toggleRoadClosure() {
  const segId = document.getElementById("roadSelect").value;
  const seg = ROAD_SEGMENTS.find(s => s.id === segId);
  const idx = blockedEdges.indexOf(segId);
  if (idx > -1) {
    blockedEdges.splice(idx, 1);
    pushAlert("spare", `Road Reopened: ${seg.label}`, "Conductors notified to resume standard corridor.");
  } else {
    blockedEdges.push(segId);
    const detour = findDetourPath(seg.a, seg.b) || "Nearest Hub Bypass";
    pushAlert("flood", `Road Closure: ${seg.label}`, `Conductors rerouted via fastest detour: ${detour}. Start 15 mins early.`);
  }
  saveAndRender();
}

// --- 4. Traffic Congestion & Surge ---
function setCongestion(level) {
  congestionLevel = level;
  if (level !== "clear") {
    const mins = level === "heavy" ? 25 : 12;
    pushAlert("surge", `Traffic Congestion: ${level.toUpperCase()}`, `Expected +${mins} min highway delay across Dakshina Kannada corridors.`);
  }
  saveAndRender();
}

function toggleSurge() {
  demandSurge = !demandSurge;
  if (demandSurge) pushAlert("surge", "Demand Surge (+40%)", "Student rush increased by 40%. Commuters see live demand % across routes.");
  saveAndRender();
}

function triggerExamDayCrisis() {
  routes = structuredClone(INITIAL_ROUTES);
  depots = structuredClone(INITIAL_DEPOTS);
  routes[0].cancelled = true;
  routes[4].cancelled = true;
  blockedEdges = ["bc_road__kalladka"];
  demandSurge = true;
  congestionLevel = "moderate";
  alertsLog = [];
  pushAlert("breakdown", "Breakdown 1: KA-19-F-3101", "Nearest station B.C. Road Counter alerted for spare dispatch.");
  pushAlert("breakdown", "Breakdown 2: KA-19-F-3105", "Nearest station Moodabidri Counter alerted for spare dispatch.");
  pushAlert("flood", "Road Closure: B.C. Road ↔ Kalladka", "Detour active via Vittla → Mudipu → B.C. Road. Start 15 mins early.");
  pushAlert("surge", "Exam Day Crisis: +40% Surge & Moderate Congestion", "Precautionary +15 min buffer pushed to student apps.");
  populateControls();
  saveAndRender();
}

function resetAllOps() {
  routes = structuredClone(INITIAL_ROUTES);
  depots = structuredClone(INITIAL_DEPOTS);
  blockedEdges = [];
  demandSurge = false;
  congestionLevel = "clear";
  alertsLog = [];
  populateControls();
  saveAndRender();
}

function saveAndRender() {
  localStorage.setItem("rl_routes", JSON.stringify(routes));
  localStorage.setItem("rl_depots", JSON.stringify(depots));
  localStorage.setItem("rl_blocked_edges", JSON.stringify(blockedEdges));
  localStorage.setItem("rl_surge", JSON.stringify(demandSurge));
  localStorage.setItem("rl_congestion", congestionLevel);
  localStorage.setItem("rl_alerts", JSON.stringify(alertsLog));
  renderAllOps();
}

function renderAllOps() {
  const broken = routes.filter(r => r.cancelled);
  document.getElementById("breakdownList").innerHTML = broken.length
    ? broken.map(b => `<div class="p-2.5 bg-rose-950/50 border border-rose-800 rounded-xl text-rose-200 font-semibold">${b.plate} — ${b.name}</div>`).join("")
    : `<div class="text-emerald-400">All buses operational.</div>`;

  document.getElementById("depotQueue").innerHTML = broken.length
    ? broken.map(b => {
        const { depot, dist } = findNearestDepot(b);
        return `
          <div class="p-3 bg-slate-800 rounded-xl border border-slate-700 space-y-2">
            <div class="font-bold text-rose-300">Alert for ${b.plate}</div>
            <div class="text-slate-300">Nearest: <b>${depot.name}</b> (${dist.toFixed(1)} km) • Spares Left: <b>${depot.spares.length}</b></div>
            ${depot.spares.length
              ? `<button onclick="deploySpareBus('${b.id}','${depot.id}')" class="w-full bg-emerald-600 hover:bg-emerald-500 py-1.5 rounded-lg font-bold text-white">Deploy Spare (${depot.spares[0]})</button>`
              : `<div class="text-amber-300 font-bold">No Spare Available — Demand % shown to commuters</div>`}
          </div>`;
      }).join("")
    : `<div class="text-slate-400">No pending spare bus requests.</div>`;

  document.getElementById("depotInventory").innerHTML = depots.map(d =>
    `<div class="bg-slate-800 px-3 py-2 rounded-xl flex justify-between"><span>${d.name.split(" ")[0]}</span><b class="${d.spares.length ? "text-emerald-400" : "text-rose-400"}">${d.spares.length}</b></div>`
  ).join("");

  document.getElementById("closedRoadList").innerHTML = blockedEdges.length
    ? blockedEdges.map(id => {
        const seg = ROAD_SEGMENTS.find(s => s.id === id);
        return `<div class="p-2 bg-amber-950/50 border border-amber-700 rounded-xl text-amber-200">${seg?.label || id}</div>`;
      }).join("")
    : `<div class="text-emerald-400">All district highways open.</div>`;

  const btns = { clear: "congClearBtn", moderate: "congModBtn", heavy: "congHeavyBtn" };
  Object.entries(btns).forEach(([lvl, elId]) => {
    const el = document.getElementById(elId);
    el.className = `py-2.5 rounded-xl text-xs font-bold border ${congestionLevel === lvl ? "bg-cyan-500 text-slate-950 border-cyan-400" : "bg-slate-800 text-slate-300 border-slate-700"}`;
  });

  const sBtn = document.getElementById("surgeBtn");
  sBtn.textContent = demandSurge ? "+40% Demand Surge: ACTIVE (Tap to Disable)" : "+40% Demand Surge: OFF (Tap to Activate)";
  sBtn.className = `w-full py-3 rounded-xl text-xs font-extrabold transition ${demandSurge ? "bg-rose-600 hover:bg-rose-500 text-white" : "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"}`;
}