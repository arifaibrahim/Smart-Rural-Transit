let routes = JSON.parse(localStorage.getItem("rl_routes")) || structuredClone(INITIAL_ROUTES);
let depots = JSON.parse(localStorage.getItem("rl_depots")) || structuredClone(INITIAL_DEPOTS);
let blockedEdges = JSON.parse(localStorage.getItem("rl_blocked_edges")) || [];
let demandSurge = JSON.parse(localStorage.getItem("rl_surge")) || false;
let congestionLevel = localStorage.getItem("rl_congestion") || "clear"; // clear | moderate | heavy
let examUrgency = JSON.parse(localStorage.getItem("rl_exam_urgency")) || false;
let ticketMode = localStorage.getItem("rl_ticket_mode") || "";
let boardedBuses = JSON.parse(localStorage.getItem("rl_boarded")) || {};
let waitingUserStops = JSON.parse(localStorage.getItem("rl_waiting")) || {};
let alertsLog = JSON.parse(localStorage.getItem("rl_alerts")) || [];

let busPositions = {};
let map, busMarkers = {}, activePolyline = null, floodLayer = null;

function toMins(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }
function fromMins(m) {
  const safe = ((m % 1440) + 1440) % 1440;
  const hh = Math.floor(safe / 60), mm = safe % 60;
  return `${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${hh >= 12 ? "PM" : "AM"}`;
}
function getCongestionDelay() {
  if (congestionLevel === "heavy") return 25;
  if (congestionLevel === "moderate") return 12;
  return 0;
}

// --- Detour Engine ---
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
  routes.forEach(r => {
    for (let i = 0; i < r.stops.length - 1; i++) addLink(r.stops[i], r.stops[i + 1], 12);
  });
  EXTRA_ROAD_LINKS.forEach(([x, y, w]) => addLink(x, y, w));

  const dist = { [u]: 0 }, prev = {}, pq = [[0, u]];
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [d, cur] = pq.shift();
    if (cur === v) break;
    if (d > (dist[cur] ?? Infinity)) continue;
    for (const edge of (adj[cur] || [])) {
      const nd = d + edge.w;
      if (nd < (dist[edge.to] ?? Infinity)) {
        dist[edge.to] = nd;
        prev[edge.to] = cur;
        pq.push([nd, edge.to]);
      }
    }
  }
  if (!prev[v]) return null;
  const path = [];
  let c = v;
  while (c) { path.unshift(c); c = prev[c]; }
  return { path, extraMins: Math.max(10, dist[v] - 12) };
}
function getEffectiveRouteStops(route) {
  let effective = [route.stops[0]], extraMins = getCongestionDelay(), detoured = false;
  for (let i = 0; i < route.stops.length - 1; i++) {
    const u = route.stops[i], v = route.stops[i + 1];
    if (isEdgeBlocked(u, v)) {
      detoured = true;
      const detour = findDetourPath(u, v);
      if (detour) {
        effective.push(...detour.path.slice(1));
        extraMins += detour.extraMins;
      } else {
        effective.push(v);
        extraMins += 25;
      }
    } else {
      effective.push(v);
    }
  }
  return { stops: effective, extraMins, detoured };
}
function getStopTime(route, stopIdx, totalStops, extraMins = 0) {
  const start = toMins(route.dep);
  const end = toMins(route.arr) + extraMins;
  const ratio = totalStops > 1 ? stopIdx / (totalStops - 1) : 0;
  return Math.round(start + (end - start) * ratio);
}

// --- Exact 3-Tier Crowd Logic ---
function getCrowdInfo(route) {
  if (route.cancelled) {
    return { total: 0, pct: 0, label: "BROKEN DOWN / UNAVAILABLE", badgeClass: "bg-slate-900 text-rose-300 border-slate-700", dotColor: "#475569", risk: true };
  }
  const baseTotal = route.etmTickets + route.passCount;
  const total = demandSurge ? Math.round(baseTotal * 1.40) : baseTotal;
  const cap = route.cap;
  const overRatio = (total - cap) / cap;
  const pct = Math.round((total / cap) * 100);

  if (total < cap) {
    return { total, pct, label: `Empty / Seats Available (${total}/${cap} • ${pct}% Demand)`, badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-300", dotColor: "#10b981", risk: false };
  }
  if (overRatio <= 0.40) {
    const tag = overRatio >= 0.10 ? "Moderate (10–40% Over)" : "Moderate (Near Capacity)";
    return { total, pct, label: `${tag} (${total}/${cap} • ${pct}% Demand)`, badgeClass: "bg-amber-100 text-amber-800 border-amber-300", dotColor: "#f59e0b", risk: false };
  }
  return { total, pct, label: `Fully Crowded (>40% Over • ${pct}% Demand)`, badgeClass: "bg-rose-100 text-rose-800 border-rose-300", dotColor: "#e11d48", risk: true };
}

// --- Init & Cross-Tab Sync with KSRTC Portal ---
window.addEventListener("DOMContentLoaded", () => {
  populateDropdowns();
  initMap();
  if (!ticketMode) openModal("studentModal");
  updateHeaderBadges();
  routes.forEach((r, idx) => { busPositions[r.id] = (idx * 0.17) % 1; });
  refreshAllViews();
  setInterval(tickGPS, 2000);
});

window.addEventListener("storage", () => {
  routes = JSON.parse(localStorage.getItem("rl_routes")) || structuredClone(INITIAL_ROUTES);
  depots = JSON.parse(localStorage.getItem("rl_depots")) || structuredClone(INITIAL_DEPOTS);
  blockedEdges = JSON.parse(localStorage.getItem("rl_blocked_edges")) || [];
  demandSurge = JSON.parse(localStorage.getItem("rl_surge")) || false;
  congestionLevel = localStorage.getItem("rl_congestion") || "clear";
  alertsLog = JSON.parse(localStorage.getItem("rl_alerts")) || [];
  refreshAllViews();
});

function populateDropdowns() {
  const originEl = document.getElementById("originSelect");
  const collegeEl = document.getElementById("collegeSelect");

  originEl.innerHTML = Object.values(STOPS).sort((a, b) => a.name.localeCompare(b.name))
    .map(s => `<option value="${s.id}">${s.name}</option>`).join("");
  originEl.value = "kalladka";
  originEl.addEventListener("change", () => { updateWaitingUI(); findRoutes(); });

  collegeEl.innerHTML = [...INSTITUTIONS].sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${c.id}">${c.name}</option>`).join("");
  collegeEl.value = "st_aloysius";
  collegeEl.addEventListener("change", findRoutes);

  document.getElementById("examUrgencyCheck").checked = examUrgency;
  updateWaitingUI();
}

function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

function saveStudentMode(mode) {
  ticketMode = mode;
  examUrgency = document.getElementById("modalExamCheck").checked;
  document.getElementById("examUrgencyCheck").checked = examUrgency;
  localStorage.setItem("rl_ticket_mode", mode);
  localStorage.setItem("rl_exam_urgency", JSON.stringify(examUrgency));
  closeModal("studentModal");
  updateHeaderBadges();
  refreshAllViews();
}
function toggleExamUrgency() {
  examUrgency = document.getElementById("examUrgencyCheck").checked;
  localStorage.setItem("rl_exam_urgency", JSON.stringify(examUrgency));
  refreshAllViews();
}
function updateHeaderBadges() {
  const labels = { pass: "Bus Pass", normal: "Normal (ETM)" };
  document.getElementById("studentHeaderBtn").textContent = ticketMode ? `Student: ${labels[ticketMode]}` : "Student Login";
}

function renderAlerts() {
  const brokenCount = routes.filter(r => r.cancelled).length;
  const congActive = congestionLevel !== "clear" ? 1 : 0;
  const activeCount = brokenCount + blockedEdges.length + (demandSurge ? 1 : 0) + congActive;

  document.getElementById("navAlertBadge").textContent = alertsLog.length;
  document.getElementById("heroAlertText").textContent = `${activeCount} Active Alert(s)`;
  document.getElementById("heroLiveBusText").textContent = `${routes.filter(r => !r.cancelled).length} Buses Live`;
  const congNames = { clear: "Traffic: Clear", moderate: "Traffic: Moderate (+12m)", heavy: "Traffic: Heavy (+25m)" };
  document.getElementById("heroTrafficStatus").textContent = congNames[congestionLevel];

  const pill = document.getElementById("crisisStatusPill");
  if (activeCount > 0) {
    pill.textContent = "CRISIS / DELAYS ACTIVE";
    pill.className = "ml-2 text-[10px] px-2 py-0.5 rounded-full bg-rose-500/30 text-rose-200 border border-rose-400/50";
  } else {
    pill.textContent = "NORMAL OPS";
    pill.className = "ml-2 text-[10px] px-2 py-0.5 rounded-full bg-emerald-400/20 text-emerald-300";
  }

  const feed = document.getElementById("alertsFeedList");
  if (!alertsLog.length) {
    feed.innerHTML = `<div class="p-4 bg-slate-50 rounded-xl text-xs text-slate-500">No active disruptions or alerts.</div>`;
    return;
  }
  const styles = {
    breakdown: "bg-rose-50 border-rose-200 text-rose-900",
    spare: "bg-emerald-50 border-emerald-200 text-emerald-900",
    flood: "bg-amber-50 border-amber-200 text-amber-900",
    surge: "bg-purple-50 border-purple-200 text-purple-900"
  };
  feed.innerHTML = alertsLog.map(a => `
    <div class="p-3.5 rounded-2xl border ${styles[a.type] || "bg-slate-50 border-slate-200"}">
      <div class="flex justify-between items-center text-xs font-extrabold">
        <span>${a.title}</span><span class="opacity-70">${a.time}</span>
      </div>
      <div class="text-xs mt-1">${a.msg}</div>
    </div>
  `).join("");
}

function updateWaitingUI() {
  const stopId = document.getElementById("originSelect").value;
  const stop = STOPS[stopId];
  const base = demandSurge ? Math.round((stop?.waitBase || 0) * 1.4) : (stop?.waitBase || 0);
  const count = base + (waitingUserStops[stopId] ? 1 : 0);
  document.getElementById("waitingStopCount").textContent = `${count} students waiting${examUrgency ? " (Exam Priority)" : ""}`;
  document.getElementById("waitBtn").textContent = waitingUserStops[stopId] ? "Waiting Signal Active (Tap to Cancel)" : "I'm Waiting at This Stop";
}
function toggleWaitingBeacon() {
  const stopId = document.getElementById("originSelect").value;
  waitingUserStops[stopId] = !waitingUserStops[stopId];
  localStorage.setItem("rl_waiting", JSON.stringify(waitingUserStops));
  updateWaitingUI();
  findRoutes();
}
function applyPreset(originId, collegeId, time) {
  document.getElementById("originSelect").value = originId;
  document.getElementById("collegeSelect").value = collegeId;
  document.getElementById("targetTimeInput").value = time;
  updateWaitingUI();
  findRoutes();
}
function toggleBoarded(routeId) {
  const r = routes.find(x => x.id === routeId);
  if (!r) return;
  if (boardedBuses[routeId]) { r.passCount = Math.max(0, r.passCount - 1); delete boardedBuses[routeId]; }
  else { r.passCount += 1; boardedBuses[routeId] = true; }
  localStorage.setItem("rl_routes", JSON.stringify(routes));
  localStorage.setItem("rl_boarded", JSON.stringify(boardedBuses));
  refreshAllViews();
}

// --- Routing Engine ---
function findRoutes() {
  const originId = document.getElementById("originSelect").value;
  const collegeId = document.getElementById("collegeSelect").value;
  const college = INSTITUTIONS.find(c => c.id === collegeId);
  const destId = college.stopId;
  const rawTargetMins = toMins(document.getElementById("targetTimeInput").value || "09:15");
  const hasCrisis = routes.some(r => r.cancelled) || blockedEdges.length > 0 || demandSurge || congestionLevel !== "clear";
  const precautionaryAdded = examUrgency || hasCrisis;
  const effectiveTargetMins = precautionaryAdded ? rawTargetMins - 15 : rawTargetMins;

  const pBanner = document.getElementById("precautionBanner");
  if (precautionaryAdded) {
    pBanner.classList.remove("hidden");
    document.getElementById("precautionTitle").textContent = hasCrisis
      ? "Disruption / Traffic Alert: Start Earlier! (+15 Min Precautionary Time Added)"
      : "Exam Priority Active (+15 Min Precautionary Safety Buffer)";
    document.getElementById("precautionDesc").textContent =
      `Target adjusted from ${fromMins(rawTargetMins)} to ${fromMins(effectiveTargetMins)} for ${college.name}.`;
  } else {
    pBanner.classList.add("hidden");
  }
  document.getElementById("effectiveTargetBadge").innerHTML =
    `Target: <b>${fromMins(rawTargetMins)}</b> ${precautionaryAdded ? `<span class="text-amber-300">(Reach by ${fromMins(effectiveTargetMins)})</span>` : ""}`;

  if (originId === destId) {
    document.getElementById("directResults").innerHTML = `<div class="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-sm text-emerald-800">You are already at ${STOPS[destId].name}!</div>`;
    document.getElementById("backupResults").innerHTML = "";
    return;
  }

  const direct = [];
  routes.forEach(r => {
    const eff = getEffectiveRouteStops(r);
    const oIdx = eff.stops.indexOf(originId);
    const dIdx = eff.stops.indexOf(destId);
    if (oIdx !== -1 && dIdx !== -1 && oIdx < dIdx) {
      const depM = getStopTime(r, oIdx, eff.stops.length, eff.extraMins);
      const arrM = getStopTime(r, dIdx, eff.stops.length, eff.extraMins);
      const crowd = getCrowdInfo(r);
      const onTime = arrM <= effectiveTargetMins;
      const spareBonus = r.plate.includes("SPARE") ? 50 : 0;
      const score = (r.cancelled ? -1000 : 0) + spareBonus + (onTime ? 100 : 15) + (crowd.risk ? -35 : 30) - (eff.detoured ? 10 : 0);
      direct.push({ route: r, eff, depM, arrM, crowd, onTime, score });
    }
  });
  direct.sort((a, b) => b.score - a.score);

  const backups = [];
  const seen = new Set();
  routes.forEach(r1 => {
    if (r1.cancelled) return;
    const eff1 = getEffectiveRouteStops(r1);
    const oIdx = eff1.stops.indexOf(originId);
    if (oIdx === -1) return;
    for (let t = oIdx + 1; t < eff1.stops.length; t++) {
      const hubId = eff1.stops[t];
      if (hubId === destId) continue;
      const hubArr = getStopTime(r1, t, eff1.stops.length, eff1.extraMins);
      routes.forEach(r2 => {
        if (r2.id === r1.id || r2.cancelled) return;
        const eff2 = getEffectiveRouteStops(r2);
        const hIdx2 = eff2.stops.indexOf(hubId);
        const dIdx2 = eff2.stops.indexOf(destId);
        if (hIdx2 !== -1 && dIdx2 !== -1 && hIdx2 < dIdx2) {
          const hubDep = getStopTime(r2, hIdx2, eff2.stops.length, eff2.extraMins);
          const wait = hubDep - hubArr;
          if (wait >= 3 && wait <= 45) {
            const finalArr = getStopTime(r2, dIdx2, eff2.stops.length, eff2.extraMins);
            const key = `${r1.id}-${r2.id}-${hubId}`;
            if (!seen.has(key)) {
              seen.add(key);
              backups.push({
                r1, r2, hubId,
                depM: getStopTime(r1, oIdx, eff1.stops.length, eff1.extraMins),
                hubArr, hubDep, wait, finalArr,
                onTime: finalArr <= effectiveTargetMins,
                c1: getCrowdInfo(r1), c2: getCrowdInfo(r2)
              });
            }
          }
        }
      });
    }
  });
  backups.sort((a, b) => (b.onTime - a.onTime) || (a.finalArr - b.finalArr));

  renderDirect(direct, originId, destId, precautionaryAdded);
  renderBackups(backups.slice(0, 5));
  updateAIAdvisor(direct, backups, originId, college, precautionaryAdded);
}

function renderDirect(list, originId, destId, precautionaryAdded) {
  const el = document.getElementById("directResults");
  document.getElementById("directCount").textContent = `${list.length} route(s)`;
  if (!list.length) {
    el.innerHTML = `<div class="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-sm text-amber-900">No direct bus connects <b>${STOPS[originId].name}</b> to <b>${STOPS[destId].name}</b>. Use a 1-Transfer Backup Route below!</div>`;
    return;
  }
  el.innerHTML = list.map(({ route: r, eff, depM, arrM, crowd, onTime }) => {
    const isBoarded = !!boardedBuses[r.id];
    const isSpare = r.plate.includes("SPARE");
    const passBtn = ticketMode === "pass" && !r.cancelled
      ? `<button onclick="toggleBoarded('${r.id}')" class="px-3 py-1.5 rounded-xl text-xs font-bold ${isBoarded ? "bg-indigo-600 text-white" : "bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"}">${isBoarded ? "Boarded (Pass Checked-In)" : "I Boarded This Bus (Pass)"}</button>`
      : `<span class="text-[11px] text-slate-500">ETM Tickets: ${r.etmTickets} | Bus Pass App: ${r.passCount}${demandSurge ? " (+40% Surge)" : ""}</span>`;

    return `
      <div class="bg-white rounded-2xl border ${r.cancelled ? "border-rose-300 bg-rose-50/40" : isSpare ? "border-emerald-400 bg-emerald-50/30" : "border-slate-200"} p-4 shadow-sm">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-xs font-bold ${isSpare ? "bg-emerald-700" : "bg-slate-900"} text-white px-2.5 py-0.5 rounded-lg">${r.plate}</span>
              <span class="font-bold text-slate-900 text-sm">${r.name}</span>
              ${eff.detoured && !r.cancelled ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Detour (+${eff.extraMins}m)</span>` : ""}
              ${!r.cancelled ? `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full ${onTime ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}">${onTime ? (precautionaryAdded ? "Safe w/ +15m Buffer" : "On Time") : "Arrives Late"}</span>` : ""}
            </div>
            <div class="text-xs text-slate-600 mt-1.5">
              Departs <b>${STOPS[originId].name}</b>: <b>${fromMins(depM)}</b> &rarr; Arrives <b>${STOPS[destId].name}</b>: <b>${fromMins(arrM)}</b>
            </div>
          </div>
          <span class="text-xs font-bold px-2.5 py-1 rounded-full border ${crowd.badgeClass}">${crowd.label}</span>
        </div>
        ${crowd.risk && !r.cancelled ? `<div class="mt-2 text-xs bg-rose-50 text-rose-700 px-3 py-1.5 rounded-xl border border-rose-200 font-medium">Skip-Stop Risk (&gt;40% Over Capacity) — consider an earlier bus or backup route.</div>` : ""}
        <div class="mt-3 pt-2.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
          ${passBtn}
          <button onclick="focusBus('${r.id}')" class="text-xs font-bold text-indigo-600 hover:underline">Track Live GPS</button>
        </div>
      </div>`;
  }).join("");
}

function renderBackups(list) {
  const el = document.getElementById("backupResults");
  if (!list.length) {
    el.innerHTML = `<div class="p-4 bg-slate-100 border border-slate-200 rounded-2xl text-xs text-slate-700">No 1-transfer pairs available in this window. Keep your Waiting Beacon active for priority relief.</div>`;
    return;
  }
  el.innerHTML = list.map(b => `
    <div class="bg-white rounded-2xl border border-indigo-100 p-4 shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-1.5">
        <span class="text-xs font-bold text-indigo-700 bg-indigo-50 px-2.5 py-0.5 rounded-full">Transfer via ${STOPS[b.hubId].name}</span>
        <span class="text-xs font-bold ${b.onTime ? "text-emerald-700" : "text-slate-500"}">Arrives ${fromMins(b.finalArr)} (${b.wait}m wait)</span>
      </div>
      <div class="text-xs text-slate-700 space-y-1">
        <div><b>Leg 1:</b> <span class="font-mono font-bold">${b.r1.plate}</span> (${fromMins(b.depM)} &rarr; ${fromMins(b.hubArr)}) — <b>${b.c1.label}</b></div>
        <div><b>Leg 2:</b> <span class="font-mono font-bold">${b.r2.plate}</span> (${fromMins(b.hubDep)} &rarr; ${fromMins(b.finalArr)}) — <b>${b.c2.label}</b></div>
      </div>
    </div>`).join("");
}

function updateAIAdvisor(direct, backups, originId, college, precautionaryAdded) {
  const box = document.getElementById("aiAdvisorText");
  const best = direct.find(d => !d.route.cancelled && !d.crowd.risk && d.onTime) || direct.find(d => !d.route.cancelled && d.onTime);
  if (best) {
    box.innerHTML = `Take <b>${best.route.plate}</b> at <b>${fromMins(best.depM)}</b> to reach <b>${college.name}</b> by <b>${fromMins(best.arrM)}</b> (${best.crowd.pct}% demand${precautionaryAdded ? ", clears +15m buffer" : ""}).`;
  } else if (backups.length) {
    const b = backups[0];
    box.innerHTML = `Direct routes disrupted/full. <b>Backup Plan:</b> Take <b>${b.r1.plate}</b> at <b>${fromMins(b.depM)}</b> &rarr; transfer at <b>${STOPS[b.hubId].name}</b> to <b>${b.r2.plate}</b> (Arrives ${fromMins(b.finalArr)}).`;
  } else {
    box.innerHTML = `High disruption on this route. Keep your Waiting Beacon active at ${STOPS[originId].name}.`;
  }
}

// --- Map ---
function initMap() {
  map = L.map("map").setView([12.885, 75.05], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
  floodLayer = L.layerGroup().addTo(map);
  Object.values(STOPS).forEach(s => {
    L.circleMarker([s.lat, s.lng], { radius: 3.5, color: "#334155", fillColor: "#94a3b8", fillOpacity: 0.8, weight: 1 }).bindTooltip(s.name).addTo(map);
  });
}
function getBusLatLng(route) {
  const eff = getEffectiveRouteStops(route).stops;
  const p = busPositions[route.id] || 0;
  const n = Math.max(1, eff.length - 1);
  const exact = p * n;
  const i = Math.min(Math.floor(exact), n - 1);
  const f = exact - i;
  const s1 = STOPS[eff[i]], s2 = STOPS[eff[i + 1]] || s1;
  return [s1.lat + (s2.lat - s1.lat) * f, s1.lng + (s2.lng - s1.lng) * f, s1.name, s2.name];
}
function updateMapMarkers() {
  routes.forEach(r => {
    const [lat, lng, fromS, toS] = getBusLatLng(r);
    const crowd = getCrowdInfo(r);
    const popup = `<b>${r.plate}</b><br>${r.name}<br>Near: ${fromS} &rarr; ${toS}<br><b>${crowd.label}</b>`;
    if (busMarkers[r.id]) {
      busMarkers[r.id].setLatLng([lat, lng]).setStyle({ fillColor: crowd.dotColor }).setPopupContent(popup);
    } else {
      busMarkers[r.id] = L.circleMarker([lat, lng], {
        radius: 6.5, color: "#0f172a", weight: 1.5, fillColor: crowd.dotColor, fillOpacity: 0.95
      }).bindPopup(popup).on("click", () => focusBus(r.id)).addTo(map);
    }
  });
  floodLayer.clearLayers();
  blockedEdges.forEach(id => {
    const seg = ROAD_SEGMENTS.find(s => s.id === id);
    if (seg) {
      L.polyline([[STOPS[seg.a].lat, STOPS[seg.a].lng], [STOPS[seg.b].lat, STOPS[seg.b].lng]], { color: "#e11d48", weight: 6, opacity: 0.85 })
        .bindTooltip(`CLOSED: ${seg.label}`).addTo(floodLayer);
    }
  });
}
function tickGPS() {
  routes.forEach(r => { if (!r.cancelled) busPositions[r.id] = ((busPositions[r.id] || 0) + 0.015) % 1; });
  updateMapMarkers();
}
function focusBus(routeId) {
  const r = routes.find(x => x.id === routeId);
  if (!r) return;
  const eff = getEffectiveRouteStops(r);
  const [lat, lng, fromS, toS] = getBusLatLng(r);
  const crowd = getCrowdInfo(r);
  if (activePolyline) map.removeLayer(activePolyline);
  activePolyline = L.polyline(eff.stops.map(id => [STOPS[id].lat, STOPS[id].lng]), {
    color: eff.detoured ? "#d97706" : "#4f46e5", weight: 4, dashArray: "6,6"
  }).addTo(map);
  map.setView([lat, lng], 11);
  busMarkers[r.id].openPopup();
  document.getElementById("selectedBusDetail").innerHTML = `
    <div class="font-bold text-slate-900">${r.plate} — ${r.name}</div>
    <div class="mt-1">Segment: <b>${fromS} &rarr; ${toS}</b> | <b>${crowd.label}</b></div>
    ${eff.detoured ? `<div class="mt-1 text-amber-700 font-semibold">Detour Active (+${eff.extraMins}m): ${eff.stops.map(id => STOPS[id].name).join(" → ")}</div>` : ""}
  `;
}
function refreshAllViews() {
  renderAlerts();
  updateWaitingUI();
  updateMapMarkers();
  findRoutes();
}