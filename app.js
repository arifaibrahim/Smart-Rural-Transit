let routes = JSON.parse(localStorage.getItem("rl_routes")) || structuredClone(INITIAL_ROUTES);
let ticketMode = localStorage.getItem("rl_ticket_mode") || "";
let boardedBuses = JSON.parse(localStorage.getItem("rl_boarded")) || {};
let waitingUserStops = JSON.parse(localStorage.getItem("rl_waiting")) || {};
let busPositions = {}; // routeId -> 0..1 progress along route
let map, busMarkers = {}, activePolyline = null, stopMarkersLayer = null;

// --- Time Helpers ---
function toMins(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function fromMins(m) {
  const hh = Math.floor(m / 60) % 24;
  const mm = m % 60;
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}
function getStopTime(route, stopIdx) {
  const start = toMins(route.dep);
  const end = toMins(route.arr);
  const ratio = route.stops.length > 1 ? stopIdx / (route.stops.length - 1) : 0;
  return Math.round(start + (end - start) * ratio);
}

// --- Exact Crowd Classification Rule ---
function getCrowdInfo(route) {
  if (route.cancelled) {
    return {
      total: 0, pct: 0, label: "CANCELLED / DISRUPTED",
      badgeClass: "bg-slate-800 text-rose-300 border-slate-700",
      dotColor: "#475569", risk: true
    };
  }
  const total = route.etmNormal + route.etmAadhaar + route.passCount;
  const cap = route.cap;
  const overRatio = (total - cap) / cap;
  const pct = Math.round((total / cap) * 100);

  if (total < cap) {
    return {
      total, pct, label: `Empty / Seats Available (${total}/${cap})`,
      badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-300",
      dotColor: "#10b981", risk: false
    };
  }
  if (overRatio <= 0.40) {
    const tag = overRatio >= 0.10 ? "Moderate (10–40% Over)" : "Moderate (Near Capacity)";
    return {
      total, pct, label: `${tag} (${total}/${cap})`,
      badgeClass: "bg-amber-100 text-amber-800 border-amber-300",
      dotColor: "#f59e0b", risk: false
    };
  }
  return {
    total, pct, label: `Fully Crowded (>40% Over: ${total}/${cap})`,
    badgeClass: "bg-rose-100 text-rose-800 border-rose-300",
    dotColor: "#e11d48", risk: true
  };
}

// --- Initialization ---
window.addEventListener("DOMContentLoaded", () => {
  populateDropdowns();
  initMap();
  if (!ticketMode) openTicketModal();
  else updateModeBadge();

  routes.forEach((r, idx) => { busPositions[r.id] = (idx * 0.17) % 1; });
  updateMapMarkers();
  findRoutes();
  setInterval(tickGPS, 2000);
});

function populateDropdowns() {
  const originEl = document.getElementById("originSelect");
  const collegeEl = document.getElementById("collegeSelect");
  const simEl = document.getElementById("simBusSelect");

  const sortedStops = Object.values(STOPS).sort((a, b) => a.name.localeCompare(b.name));
  originEl.innerHTML = sortedStops.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
  originEl.value = "kalladka";

  const sortedColleges = [...INSTITUTIONS].sort((a, b) => a.name.localeCompare(b.name));
  collegeEl.innerHTML = sortedColleges.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
  collegeEl.value = "st_aloysius";

  simEl.innerHTML = routes.map(r => `<option value="${r.id}">${r.plate} — ${r.name}</option>`).join("");
  document.getElementById("statRoutes").textContent = routes.length;
  document.getElementById("statColleges").textContent = INSTITUTIONS.length;

  originEl.addEventListener("change", updateWaitingUI);
  updateWaitingUI();
}

// --- Ticket Mode Modal ---
function openTicketModal() { document.getElementById("ticketModal").classList.remove("hidden"); }
function setTicketMode(mode) {
  ticketMode = mode;
  localStorage.setItem("rl_ticket_mode", mode);
  document.getElementById("ticketModal").classList.add("hidden");
  updateModeBadge();
  findRoutes();
}
function updateModeBadge() {
  const names = { pass: "Student Bus Pass (App Check-In)", aadhaar: "Women Free / Aadhaar (ETM)", normal: "Normal Ticket (ETM)" };
  document.getElementById("currentModeBadge").textContent = `Mode: ${names[ticketMode] || "Select"}`;
}

// --- Waiting Beacon ---
function updateWaitingUI() {
  const stopId = document.getElementById("originSelect").value;
  const stop = STOPS[stopId];
  const count = (stop?.waitBase || 0) + (waitingUserStops[stopId] ? 1 : 0);
  document.getElementById("waitingStopCount").textContent = `${count} students waiting at ${stop?.name}`;
  const btn = document.getElementById("waitBtn");
  btn.textContent = waitingUserStops[stopId] ? "Waiting Signal Active (Tap to Cancel)" : "I'm Waiting at This Stop";
}
function toggleWaitingBeacon() {
  const stopId = document.getElementById("originSelect").value;
  waitingUserStops[stopId] = !waitingUserStops[stopId];
  localStorage.setItem("rl_waiting", JSON.stringify(waitingUserStops));
  updateWaitingUI();
  findRoutes();
}

// --- Presets ---
function applyPreset(originId, collegeId, time) {
  document.getElementById("originSelect").value = originId;
  document.getElementById("collegeSelect").value = collegeId;
  document.getElementById("targetTimeInput").value = time;
  updateWaitingUI();
  findRoutes();
}

// --- Routing Engine (All Direct + 1-Transfer Backup Routes) ---
function findRoutes() {
  const originId = document.getElementById("originSelect").value;
  const collegeId = document.getElementById("collegeSelect").value;
  const college = INSTITUTIONS.find(c => c.id === collegeId);
  const destId = college.stopId;
  const targetMins = toMins(document.getElementById("targetTimeInput").value || "09:15");

  if (originId === destId) {
    document.getElementById("directResults").innerHTML = `<div class="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800">You are already at the institution's nearest bus stop (${STOPS[destId].name})!</div>`;
    document.getElementById("backupResults").innerHTML = "";
    return;
  }

  // 1. All Direct Routes
  const direct = [];
  routes.forEach(r => {
    const oIdx = r.stops.indexOf(originId);
    const dIdx = r.stops.indexOf(destId);
    if (oIdx !== -1 && dIdx !== -1 && oIdx < dIdx) {
      const depM = getStopTime(r, oIdx);
      const arrM = getStopTime(r, dIdx);
      const crowd = getCrowdInfo(r);
      const onTime = arrM <= targetMins;
      let score = (r.cancelled ? -1000 : 0) + (onTime ? 100 : 20) + (crowd.risk ? -40 : 30) - (arrM - depM) * 0.2;
      direct.push({ route: r, depM, arrM, crowd, onTime, score });
    }
  });
  direct.sort((a, b) => b.score - a.score);

  // 2. Backup 1-Transfer Routes
  const backups = [];
  const seenPairs = new Set();
  routes.forEach(r1 => {
    if (r1.cancelled) return;
    const oIdx = r1.stops.indexOf(originId);
    if (oIdx === -1) return;
    for (let t = oIdx + 1; t < r1.stops.length; t++) {
      const hubId = r1.stops[t];
      if (hubId === destId) continue;
      const hubArr = getStopTime(r1, t);
      routes.forEach(r2 => {
        if (r2.id === r1.id || r2.cancelled) return;
        const hIdx2 = r2.stops.indexOf(hubId);
        const dIdx2 = r2.stops.indexOf(destId);
        if (hIdx2 !== -1 && dIdx2 !== -1 && hIdx2 < dIdx2) {
          const hubDep = getStopTime(r2, hIdx2);
          const wait = hubDep - hubArr;
          if (wait >= 3 && wait <= 45) {
            const finalArr = getStopTime(r2, dIdx2);
            const key = `${r1.id}-${r2.id}-${hubId}`;
            if (!seenPairs.has(key)) {
              seenPairs.add(key);
              backups.push({
                r1, r2, hubId,
                depM: getStopTime(r1, oIdx),
                hubArr, hubDep, wait, finalArr,
                onTime: finalArr <= targetMins,
                c1: getCrowdInfo(r1), c2: getCrowdInfo(r2)
              });
            }
          }
        }
      });
    }
  });
  backups.sort((a, b) => (b.onTime - a.onTime) || (a.finalArr - b.finalArr));

  renderDirect(direct, originId, destId);
  renderBackups(backups.slice(0, 5), originId, destId, direct);
  updateAIAdvisor(direct, backups, originId, college, targetMins);
}

function renderDirect(list, originId, destId) {
  const container = document.getElementById("directResults");
  document.getElementById("directCount").textContent = `${list.length} route(s) found`;
  if (!list.length) {
    container.innerHTML = `<div class="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900">No single direct bus connects <b>${STOPS[originId].name}</b> to <b>${STOPS[destId].name}</b>. Check the 1-Transfer Backup Routes below!</div>`;
    return;
  }

  container.innerHTML = list.map(item => {
    const { route: r, depM, arrM, crowd, onTime } = item;
    const isBoarded = !!boardedBuses[r.id];
    const passBtn = ticketMode === "pass" && !r.cancelled
      ? `<button onclick="toggleBoarded('${r.id}')" class="px-3 py-1.5 rounded-lg text-xs font-bold transition ${isBoarded ? "bg-indigo-600 text-white" : "bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"}">${isBoarded ? "Boarded (Pass Checked-In)" : "I Boarded This Bus (Pass)"}</button>`
      : `<span class="text-[11px] text-slate-500">ETM Live: ${r.etmNormal} Normal + ${r.etmAadhaar} Women Free | Pass App: ${r.passCount}</span>`;

    return `
      <div class="bg-white rounded-2xl border ${r.cancelled ? "border-rose-300 bg-rose-50/30" : "border-slate-200"} p-4 shadow-sm hover:border-indigo-300 transition">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-xs font-bold bg-slate-900 text-white px-2 py-0.5 rounded">${r.plate}</span>
              <span class="font-bold text-slate-900 text-sm">${r.name}</span>
              <span class="text-[11px] font-bold px-2 py-0.5 rounded-full ${onTime ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}">${onTime ? "Reaches On Time" : "Arrives After Target"}</span>
            </div>
            <div class="text-xs text-slate-600 mt-1.5">
              Departs <b>${STOPS[originId].name}</b>: <b>${fromMins(depM)}</b> → Arrives <b>${STOPS[destId].name}</b>: <b>${fromMins(arrM)}</b>
            </div>
          </div>
          <span class="text-xs font-bold px-2.5 py-1 rounded-full border ${crowd.badgeClass}">${crowd.label}</span>
        </div>
        ${crowd.risk && !r.cancelled ? `<div class="mt-2 text-xs bg-rose-50 text-rose-700 px-3 py-1.5 rounded-lg border border-rose-200 font-medium">Skip-Stop Risk Alert: Exceeds +40% capacity. Driver may skip intermediate rural stops—consider backup routes below.</div>` : ""}
        <div class="mt-3 pt-2.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
          ${passBtn}
          <button onclick="focusBus('${r.id}')" class="text-xs font-semibold text-indigo-600 hover:underline">Track Live GPS</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderBackups(list, originId, destId, direct) {
  const container = document.getElementById("backupResults");
  if (!list.length) {
    container.innerHTML = `
      <div class="p-4 bg-slate-100 border border-slate-200 rounded-xl text-xs text-slate-700">
        <b>Last-Mile Rural Contingency:</b> No 1-transfer bus pairs found in this window. If direct buses are disrupted, your waiting beacon alerts KSRTC dispatchers, or coordinate a shared student auto/feeder to the nearest hub (BC Road / Puttur / Pumpwell / Moodabidri).
      </div>`;
    return;
  }
  container.innerHTML = list.map(b => `
    <div class="bg-white rounded-2xl border border-indigo-100 p-4 shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-1.5">
        <span class="text-xs font-bold text-indigo-700 bg-indigo-50 px-2.5 py-0.5 rounded-full">1-Transfer Backup via ${STOPS[b.hubId].name}</span>
        <span class="text-xs font-semibold ${b.onTime ? "text-emerald-700" : "text-slate-500"}">Final Arrival: ${fromMins(b.finalArr)} (${b.wait} min transfer)</span>
      </div>
      <div class="text-xs text-slate-700 space-y-1">
        <div><b>Leg 1:</b> <span class="font-mono font-bold">${b.r1.plate}</span> (${fromMins(b.depM)} → ${fromMins(b.hubArr)}) — <span class="font-semibold">${b.c1.label}</span></div>
        <div><b>Leg 2:</b> <span class="font-mono font-bold">${b.r2.plate}</span> (${fromMins(b.hubDep)} → ${fromMins(b.finalArr)}) — <span class="font-semibold">${b.c2.label}</span></div>
      </div>
    </div>
  `).join("");
}

function updateAIAdvisor(direct, backups, originId, college, targetMins) {
  const box = document.getElementById("aiAdvisorText");
  const goodDirect = direct.find(d => !d.route.cancelled && !d.crowd.risk && d.onTime);
  const stopWait = (STOPS[originId]?.waitBase || 0) + (waitingUserStops[originId] ? 1 : 0);

  if (goodDirect) {
    box.innerHTML = `Recommended: Board <b>${goodDirect.route.plate}</b> (${goodDirect.route.name}) at <b>${fromMins(goodDirect.depM)}</b> to reach <b>${college.name}</b> by <b>${fromMins(goodDirect.arrM)}</b>. Crowd is safe (${goodDirect.crowd.pct}% of capacity). ${stopWait} students currently flagged waiting at ${STOPS[originId].name}.`;
  } else if (backups.length && backups[0].onTime) {
    const b = backups[0];
    box.innerHTML = `Direct buses are either overcrowded (&gt;40%), cancelled, or miss ${fromMins(targetMins)}. <b>AI Reroute:</b> Take <b>${b.r1.plate}</b> to <b>${STOPS[b.hubId].name}</b> and transfer (${b.wait} min wait) to <b>${b.r2.plate}</b> arriving at <b>${fromMins(b.finalArr)}</b>.`;
  } else {
    box.innerHTML = `High congestion or limited direct capacity to <b>${college.name}</b>. ${stopWait} students waiting at <b>${STOPS[originId].name}</b> — keep your Waiting Beacon active and check available later buses or backup hubs.`;
  }
}

// --- Pass Check-in ---
function toggleBoarded(routeId) {
  const r = routes.find(x => x.id === routeId);
  if (!r) return;
  if (boardedBuses[routeId]) {
    r.passCount = Math.max(0, r.passCount - 1);
    delete boardedBuses[routeId];
  } else {
    r.passCount += 1;
    boardedBuses[routeId] = true;
  }
  saveState();
  updateMapMarkers();
  findRoutes();
}

// --- Conductor Simulator Controls ---
function toggleSimulator() { document.getElementById("simulatorPanel").classList.toggle("hidden"); }
function simAddTicket(type, qty) {
  const id = document.getElementById("simBusSelect").value;
  const r = routes.find(x => x.id === id);
  if (!r) return;
  if (type === "aadhaar") r.etmAadhaar += qty;
  else r.etmNormal += qty;
  saveState();
  updateMapMarkers();
  findRoutes();
  focusBus(id);
}
function simToggleCancel() {
  const id = document.getElementById("simBusSelect").value;
  const r = routes.find(x => x.id === id);
  if (!r) return;
  r.cancelled = !r.cancelled;
  saveState();
  updateMapMarkers();
  findRoutes();
  focusBus(id);
}
function resetTelemetry() {
  localStorage.removeItem("rl_routes");
  localStorage.removeItem("rl_boarded");
  routes = structuredClone(INITIAL_ROUTES);
  boardedBuses = {};
  updateMapMarkers();
  findRoutes();
}
function saveState() {
  localStorage.setItem("rl_routes", JSON.stringify(routes));
  localStorage.setItem("rl_boarded", JSON.stringify(boardedBuses));
}

// --- Leaflet Live GPS Map ---
function initMap() {
  map = L.map("map").setView([12.885, 75.05], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
  stopMarkersLayer = L.layerGroup().addTo(map);
  Object.values(STOPS).forEach(s => {
    L.circleMarker([s.lat, s.lng], { radius: 4, color: "#334155", fillColor: "#94a3b8", fillOpacity: 0.8, weight: 1 })
      .bindTooltip(s.name)
      .addTo(stopMarkersLayer);
  });
}

function getBusLatLng(route) {
  const p = busPositions[route.id] || 0;
  const n = route.stops.length - 1;
  const exact = p * n;
  const i = Math.min(Math.floor(exact), n - 1);
  const f = exact - i;
  const s1 = STOPS[route.stops[i]];
  const s2 = STOPS[route.stops[i + 1]];
  return [s1.lat + (s2.lat - s1.lat) * f, s1.lng + (s2.lng - s1.lng) * f, s1.name, s2.name];
}

function updateMapMarkers() {
  routes.forEach(r => {
    const [lat, lng, fromStop, toStop] = getBusLatLng(r);
    const crowd = getCrowdInfo(r);
    const popupHtml = `<b>${r.plate}</b><br>${r.name}<br>Near: ${fromStop} → ${toStop}<br><b>${crowd.label}</b>`;
    if (busMarkers[r.id]) {
      busMarkers[r.id].setLatLng([lat, lng]).setStyle({ fillColor: crowd.dotColor, color: "#0f172a" }).setPopupContent(popupHtml);
    } else {
      busMarkers[r.id] = L.circleMarker([lat, lng], {
        radius: 7, color: "#0f172a", weight: 1.5, fillColor: crowd.dotColor, fillOpacity: 0.95
      }).bindPopup(popupHtml).on("click", () => focusBus(r.id)).addTo(map);
    }
  });
}

function tickGPS() {
  routes.forEach(r => {
    if (!r.cancelled) {
      busPositions[r.id] = (busPositions[r.id] + 0.015) % 1;
    }
  });
  updateMapMarkers();
}

function focusBus(routeId) {
  const r = routes.find(x => x.id === routeId);
  if (!r) return;
  const [lat, lng, fromStop, toStop] = getBusLatLng(r);
  const crowd = getCrowdInfo(r);
  if (activePolyline) map.removeLayer(activePolyline);
  const coords = r.stops.map(id => [STOPS[id].lat, STOPS[id].lng]);
  activePolyline = L.polyline(coords, { color: "#4f46e5", weight: 4, dashArray: "6,6" }).addTo(map);
  map.setView([lat, lng], 11);
  busMarkers[r.id].openPopup();
  document.getElementById("selectedBusDetail").innerHTML = `
    <div class="font-bold text-slate-900">${r.plate} — ${r.name}</div>
    <div class="mt-1">Live GPS Segment: <b>${fromStop} → ${toStop}</b> | Status: <b>${crowd.label}</b></div>
    <div class="mt-1 text-slate-500">Breakdown: Normal ETM (${r.etmNormal}) + Women Free Aadhaar (${r.etmAadhaar}) + Student Pass App Check-ins (${r.passCount}) / ${r.cap} seats</div>
  `;
}