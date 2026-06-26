const SUPABASE_URL = "PLACEHOLDER_URL";
const SUPABASE_KEY = "PLACEHOLDER_KEY";

/*
 * Court shape:
 *   {
 *     id:         string,
 *     name:       string,
 *     gymNumber:  number | null,
 *     courtSize:  2 | 4,
 *     onCourt:    [username, ...],
 *     queue:      [{ size: 2|4, players: [username, ...] }, ...],
 *     timerEnd:   number | null,
 *   }
 */

const SESSION_MS  = 45 * 60 * 1000;
const MAX_GYM_NUM = 50;

let players      = [];
let courts       = [];
let courtCount   = 0;
let dragGroupSize = 1;
let booting      = true;
let localVersion  = 0;
const sessionId   = Math.random().toString(36).slice(2);
let sb = null;

/* ── Supabase init ── */
function initSupabase() {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

/* ── Court state persistence ── */
let saveTimeout = null;
function scheduleSave() {
    if (booting) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveState, 600);
}

async function saveState() {
    if (booting) return;
    const myVersion = ++localVersion;
    try {
        const snapshot = courts.map(c => ({ ...c, timerEnd: c.timerEnd ?? null }));
        const { error } = await sb
            .from("court_state")
            .upsert({ id: "main", data: JSON.stringify(snapshot), version: myVersion, session: sessionId });
        if (error) console.error("saveState error:", error);
    } catch(e) {
        console.error("saveState exception:", e);
    }
}

async function loadState() {
    try {
        const { data, error } = await sb
            .from("court_state")
            .select("data")
            .eq("id", "main")
            .single();
        if (error || !data) return false;
        const snapshot = JSON.parse(data.data);
        if (!Array.isArray(snapshot) || snapshot.length === 0) return false;
        courts = snapshot.map(c => ({ ...c, timerEnd: c.timerEnd ?? null }));
        courtCount = courts.reduce((max, c) => {
            const n = parseInt(c.id.replace("court-", ""));
            return isNaN(n) ? max : Math.max(max, n);
        }, 0);
        return true;
    } catch(e) {
        console.error("loadState error:", e);
        return false;
    }
}

/* ── Realtime subscription ── */
function subscribeToChanges() {
    sb
        .channel("court_state_changes")
        .on("postgres_changes", {
            event: "UPDATE",
            schema: "public",
            table: "court_state",
            filter: "id=eq.main"
        }, (payload) => {
            if (booting) return;
            // Ignore updates from our own session
            if (payload.new.session === sessionId) return;
            try {
                const snapshot = JSON.parse(payload.new.data);
                courts = snapshot.map(c => ({ ...c, timerEnd: c.timerEnd ?? null }));
                courtCount = courts.reduce((max, c) => {
                    const n = parseInt(c.id.replace("court-", ""));
                    return isNaN(n) ? max : Math.max(max, n);
                }, 0);
                renderCourts();
                renderRoster();
                updateStats();
            } catch(e) {
                console.error("realtime parse error:", e);
            }
        })
        .subscribe();


    sb
        .channel("logins_changes")
        .on("postgres_changes", {
            event: "*",
            schema: "public",
            table: "logins"
        }, async () => {
            await loadTable();
        })
        .subscribe();
}

/* ── Load players from Supabase ── */
async function loadTable() {
    const { data, error } = await sb
        .from("logins")
        .select("username, password");
    if (error) { console.error("loadTable error:", error); return; }
    players = data.map(row => ({ username: row.username, password: row.password }));
    renderRoster();
    updateStats();
}

/* ── Utilities ── */
function initials(name) { return name.slice(0, 2).toUpperCase(); }

function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1800);
}

function isAssigned(username) {
    return courts.some(c =>
        c.onCourt.includes(username) ||
        c.queue.some(g => g.players.includes(username))
    );
}

function updateStats() {
    document.getElementById("stat-players").textContent = players.length;
    document.getElementById("stat-queued").textContent =
        players.filter(p => isAssigned(p.username)).length;
}

/* ── Roster ── */
let visibleUnassigned = [];

function renderRoster() {
    const list = document.getElementById("item-list");
    const q    = "";
    list.innerHTML = "";
    visibleUnassigned = [];

    players
        .forEach(p => {
            const assigned = isAssigned(p.username);
            const el = document.createElement("div");
            el.className = "draggable" + (assigned ? " is-assigned" : "");
            el.dataset.username = p.username;
            el.innerHTML = `
                <div class="player-avatar">${initials(p.username)}</div>
                <span class="col-username">${p.username}</span>
                <span class="col-password">${p.password}</span>
                ${assigned ? '<span class="queued-tag">assigned</span>' : ""}
                <button class="slot-remove player-delete-btn" onclick="deletePlayer('${p.username}')" title="Delete player">✕</button>
            `;
            list.appendChild(el);
            if (!assigned) {
                visibleUnassigned.push(p.username);
                initDraggable(el);
            }
        });

    document.getElementById("roster-count").textContent =
        `${players.length} player${players.length !== 1 ? "s" : ""}`;
}


function setDragGroupSize(size) {
    dragGroupSize = size;
    document.querySelectorAll(".drag-size-btn").forEach(btn => {
        btn.classList.toggle("active", +btn.dataset.size === size);
    });
}

function getDragBatch(username) {
    const startIdx = visibleUnassigned.indexOf(username);
    if (startIdx === -1) return [username];
    return visibleUnassigned.slice(startIdx, startIdx + dragGroupSize);
}

/* ── Courts ── */
function nextFreeGymNumber() {
    const used = new Set(courts.map(c => c.gymNumber).filter(n => n != null));
    for (let n = 1; n <= MAX_GYM_NUM; n++) {
        if (!used.has(n)) return n;
    }
    return null;
}

function addCourt() {
    courtCount++;
    courts.push({
        id:        "court-" + courtCount,
        name:      "Court " + courtCount,
        gymNumber: nextFreeGymNumber(),
        courtSize: 4,
        onCourt:   [],
        queue:     [],
        timerEnd:  null
    });
    refresh();
}

function setGymNumber(courtId, value) {
    const court = courts.find(c => c.id === courtId);
    if (!court) return;
    const num = value === "" ? null : parseInt(value, 10);
    if (num != null && courts.some(c => c.id !== courtId && c.gymNumber === num)) {
        showToast("Court #" + num + " is already in use");
        renderCourts();
        return;
    }
    court.gymNumber = num;
    refresh();
}

function removeCourt(id) {
    courts = courts.filter(c => c.id !== id);
    refresh();
    saveState();
}

function removeFromOnCourt(courtId, username) {
    const court = courts.find(c => c.id === courtId);
    if (!court) return;
    court.onCourt = court.onCourt.filter(u => u !== username);
    syncCourtTimer(court, null, false);
    refresh();
    showToast(username + " removed from court");
}

/* ── Timer ── */
function syncCourtTimer(court, startTime = null, autoStart = true) {
    if (court.onCourt.length > 0 && court.timerEnd == null && autoStart) {
        court.timerEnd = (startTime ?? Date.now()) + SESSION_MS;
    } else if (court.onCourt.length === 0) {
        court.timerEnd = null;
    }
}

function startCourtTimer(courtId) {
    const court = courts.find(c => c.id === courtId);
    if (!court || court.timerEnd != null || court.onCourt.length === 0) return;
    const input = document.getElementById("timer-input-" + courtId);
    const minutes = input ? Math.max(1, parseInt(input.value) || 10) : 10;
    court.warmupEnd = Date.now() + minutes * 60 * 1000;
    court.timerEnd = null;
    refresh();
}

function fillCourtFromQueue(court) {
    if (court.queue.length === 0) return;
    const group = court.queue[0];
    const space = court.courtSize - court.onCourt.length;
    const take = group.players.splice(0, space);
    court.onCourt.push(...take);
    if (group.players.length === 0) court.queue.shift();
}

function rotateCourt(court, startTime = null) {
    const rotatedOut = court.onCourt.slice();
    court.onCourt = [];
    court.timerEnd = null;
    fillCourtFromQueue(court);
    syncCourtTimer(court, startTime);
    refresh();
    if (rotatedOut.length) showToast(court.name + " rotated — next group is up");
}

function tickTimers() {
    const now = Date.now();
    let anyExpired = false;
    courts.forEach(court => {
        // Warmup finished → start session timer
        if (court.warmupEnd != null && now >= court.warmupEnd) {
            court.warmupEnd = null;
            court.timerEnd = Date.now() + SESSION_MS;
            anyExpired = true;
            refresh();
        }
        // Session timer expired → rotate
        if (court.timerEnd != null && now >= court.timerEnd) {
            anyExpired = true;
            rotateCourt(court);
        }
    });
    if (!anyExpired) updateTimerDisplays();
}

function formatCountdown(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m + ":" + String(s).padStart(2, "0");
}

function updateTimerDisplays() {
    const now = Date.now();
    courts.forEach(court => {
        // Manage tab timer
        const el = document.querySelector(`.court-timer[data-court="${court.id}"]`);
        if (el) {
            if (court.warmupEnd != null) {
                const remaining = court.warmupEnd - now;
                el.classList.remove("court-timer-hidden");
                el.classList.add("court-timer-warmup");
                el.classList.remove("court-timer-warn");
                el.textContent = formatCountdown(remaining);
            } else if (court.timerEnd != null) {
                const remaining = court.timerEnd - now;
                el.classList.remove("court-timer-hidden", "court-timer-warmup");
                el.textContent = formatCountdown(remaining);
                el.classList.toggle("court-timer-warn", remaining <= 5 * 60 * 1000);
            } else {
                el.textContent = "";
                el.classList.add("court-timer-hidden");
                el.classList.remove("court-timer-warmup");
            }
        }
        // Courts tab timer
        const roEl = document.querySelector(`.court-timer[data-court-ro="${court.id}"]`);
        if (roEl) {
            if (court.warmupEnd != null) {
                const remaining = court.warmupEnd - now;
                roEl.classList.remove("court-timer-hidden");
                roEl.classList.add("court-timer-warmup");
                roEl.textContent = formatCountdown(remaining);
            } else if (court.timerEnd != null) {
                const remaining = court.timerEnd - now;
                roEl.classList.remove("court-timer-hidden", "court-timer-warmup");
                roEl.textContent = formatCountdown(remaining);
                roEl.classList.toggle("court-timer-warn", remaining <= 5 * 60 * 1000);
            } else {
                roEl.textContent = "";
                roEl.classList.add("court-timer-hidden");
                roEl.classList.remove("court-timer-warmup");
            }
        }
    });
}

function removePlayerFromGroup(courtId, groupIdx, username) {
    const court = courts.find(c => c.id === courtId);
    if (!court) return;
    const group = court.queue[groupIdx];
    if (!group) return;
    group.players = group.players.filter(u => u !== username);
    if (group.players.length === 0) court.queue.splice(groupIdx, 1);
    refresh();
    showToast(username + " removed from queue");
}

function removeGroup(courtId, groupIdx) {
    const court = courts.find(c => c.id === courtId);
    if (!court) return;
    court.queue.splice(groupIdx, 1);
    refresh();
    showToast("Group removed");
}

function addGroupToQueue(courtId, size) {
    const court = courts.find(c => c.id === courtId);
    if (!court || court.queue.length >= 4) {
        showToast("Queue is full (4 groups max)");
        return;
    }
    court.queue.push({ size, players: [] });
    refresh();
}

function setGroupSize(courtId, groupIdx, size) {
    const court = courts.find(c => c.id === courtId);
    if (!court) return;
    const group = court.queue[groupIdx];
    if (!group) return;
    if (size < group.players.length) {
        showToast("Remove a player before shrinking this group");
        renderCourts();
        return;
    }
    group.size = size;
    refresh();
    showToast("Group " + (groupIdx + 1) + " set to " + (size === 2 ? "pair" : "quad"));
}

function clearAllCourts() {
    courts.forEach(c => { c.onCourt = []; c.queue = []; c.timerEnd = null; });
    refresh();
    showToast("All courts cleared");
}

function refresh() {
    renderRoster();
    updateStats();
    renderCourts();
    if (activeTab === "courts") renderCourtsReadonly();
    scheduleSave();
}

/* ── Render ── */
function renderCourts() {
    const grid = document.getElementById("courts-grid");
    grid.innerHTML = "";

    courts.forEach(court => {
        const onFull = court.onCourt.length >= court.courtSize;
        const qFull  = court.queue.length >= 4;

        const onSlotsHTML = Array.from({ length: court.courtSize }, (_, i) => {
            const username = court.onCourt[i];
            if (username) {
                return `<div class="slot slot-occupied">
                    <span class="slot-num">${i + 1}</span>
                    <div class="slot-avatar">${initials(username)}</div>
                    <span class="slot-name">${username}</span>
                    <span class="slot-password">${(players.find(p => p.username === username) || {}).password || ''}</span>
                    <button class="slot-remove" onclick="removeFromOnCourt('${court.id}','${username}')" title="Remove">✕</button>
                </div>`;
            }
            return `<div class="slot dropslot" data-court="${court.id}" data-target="oncourt" data-slot-index="${i}">
                <span class="slot-num">${i + 1}</span>
                <span class="slot-placeholder">Drop player here</span>
            </div>`;
        }).join("");

        const qGroupsHTML = court.queue.map((group, gi) => {
            const groupFull = group.players.length >= group.size;
            const playerSlotsHTML = Array.from({ length: group.size }, (_, pi) => {
                const username = group.players[pi];
                if (username) {
                    return `<div class="slot slot-occupied slot-queue">
                        <span class="slot-num q-num">${pi + 1}</span>
                        <div class="slot-avatar slot-avatar-queue">${initials(username)}</div>
                        <span class="slot-name">${username}</span>
                        <span class="slot-password slot-password-queue">${(players.find(p => p.username === username) || {}).password || ''}</span>
                        <button class="slot-remove" onclick="removePlayerFromGroup('${court.id}',${gi},'${username}')" title="Remove">✕</button>
                    </div>`;
                }
                return `<div class="slot slot-queue${groupFull ? " slot-full" : " dropslot"}"
                         data-court="${court.id}" data-target="queue" data-group="${gi}" data-slot-index="${pi}">
                    <span class="slot-num q-num">${pi + 1}</span>
                    <span class="slot-placeholder">Drop player here</span>
                </div>`;
            }).join("");

            const groupBadge = groupFull
                ? `<span class="court-badge badge-full">Full</span>`
                : `<span class="court-badge badge-ok">${group.players.length}/${group.size}</span>`;

            return `<div class="queue-group">
                <div class="queue-group-header">
                    <div class="queue-group-label-wrap">
                        <span class="queue-group-label">Group ${gi + 1}</span>
                        <select class="group-size-select" title="Group size" onchange="setGroupSize('${court.id}',${gi},+this.value)">
                            <option value="2" ${group.size === 2 ? "selected" : ""}>Pair</option>
                            <option value="4" ${group.size === 4 ? "selected" : ""}>Quad</option>
                        </select>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px">
                        ${groupBadge}
                        <button class="slot-remove" onclick="removeGroup('${court.id}',${gi})" title="Remove group">✕</button>
                    </div>
                </div>
                <div class="queue-slots">${playerSlotsHTML}</div>
            </div>`;
        }).join("");

        const addGroupHTML = !qFull ? `
            <div class="add-group-row">
                <span class="add-group-label">Add group to queue:</span>
                <button class="btn btn-add-group" onclick="addGroupToQueue('${court.id}', 2)">+ Pair</button>
                <button class="btn btn-add-group" onclick="addGroupToQueue('${court.id}', 4)">+ Quad</button>
            </div>` : `
            <div class="add-group-row">
                <span class="add-group-label" style="color:#c0392b">Queue full (4 groups)</span>
            </div>`;

        const onBadgeClass = onFull ? "badge-full" : court.onCourt.length === 0 ? "badge-empty" : "badge-ok";
        const onBadgeText  = `${court.onCourt.length}/${court.courtSize}`;
        const qBadgeClass  = qFull ? "badge-full" : court.queue.length === 0 ? "badge-empty" : "badge-ok";
        const qBadgeText   = `${court.queue.length}/4 groups`;

        const usedGymNums = new Set(
            courts.filter(c => c.id !== court.id).map(c => c.gymNumber).filter(n => n != null)
        );
        const gymOptionsHTML = [`<option value="" ${court.gymNumber == null ? "selected" : ""}>Select court…</option>`].concat(
            Array.from({ length: MAX_GYM_NUM }, (_, i) => i + 1).map(n => {
                const taken = usedGymNums.has(n) && court.gymNumber !== n;
                const label = "Court " + n + (taken ? " — in use" : "");
                return `<option value="${n}" ${court.gymNumber === n ? "selected" : ""} ${taken ? "disabled" : ""}>${label}</option>`;
            })
        ).join("");

        const hasTimer = court.timerEnd != null || court.warmupEnd != null;
        const showStartBtn = !hasTimer && court.onCourt.length > 0;
        const timerHidden = !hasTimer ? " court-timer-hidden" : "";
        const timerDisplay = court.warmupEnd != null
            ? formatCountdown(court.warmupEnd - Date.now())
            : court.timerEnd != null ? formatCountdown(court.timerEnd - Date.now()) : "";
        const warmupClass = court.warmupEnd != null ? " court-timer-warmup" : "";
        const timerHTML = showStartBtn
            ? `<div class="timer-start-wrap">
                <input type="number" class="timer-input" id="timer-input-${court.id}" value="10" min="1" max="999" title="Minutes before session">
                <span class="timer-input-label">min</span>
                <button class="btn btn-start-timer" onclick="startCourtTimer('${court.id}')">Start</button>
               </div>`
            : `<span class="court-timer${timerHidden}${warmupClass}" data-court="${court.id}">${timerDisplay}</span>`;

        const card = document.createElement("div");
        card.className = "court-card";
        card.innerHTML = `
            <div class="court-header">
                <select class="gym-select" title="Gym court number" onchange="setGymNumber('${court.id}', this.value)">
                    ${gymOptionsHTML}
                </select>
                <div class="court-header-right">
                    ${timerHTML}
                    <button class="btn btn-danger" onclick="removeCourt('${court.id}')" title="Remove court">✕</button>
                </div>
            </div>
            <div class="section-label">
                <span>${court.warmupEnd != null ? "In queue for court" : "On court"}</span>
                <span class="court-badge ${onBadgeClass}">${onBadgeText}</span>
            </div>
            <div class="queue-slots">${onSlotsHTML}</div>
            <div class="section-label section-label-queue">
                <span>Queue</span>
                <span class="court-badge ${qBadgeClass}">${qBadgeText}</span>
            </div>
            ${qGroupsHTML}
            ${addGroupHTML}
        `;

        grid.appendChild(card);
    });

    const addTile = document.createElement("button");
    addTile.className = "add-court-tile";
    addTile.innerHTML = `<span class="add-court-tile-icon">＋</span>Add court`;
    addTile.onclick   = addCourt;
    grid.appendChild(addTile);

    initDropzones();
}

/* ── Drag ── */
function initDraggable(el) {
    const pos = { x: 0, y: 0 };

    interact(el).draggable({
        listeners: {
            start(e) {
                e.target.classList.add("is-dragging");
                e.target.style.zIndex = 1000;
                const batch = getDragBatch(e.target.dataset.username);
                batch.forEach(username => {
                    const row = document.querySelector(`.draggable[data-username="${username}"]`);
                    if (row) row.classList.add("drag-batch-highlight");
                });
            },
            move(e) {
                pos.x += e.dx;
                pos.y += e.dy;
                e.target.style.transform = `translate(${pos.x}px,${pos.y}px)`;
            },
            end(e) {
                e.target.classList.remove("is-dragging");
                e.target.style.transition = "transform 0.15s ease";
                e.target.style.transform  = "translate(0,0)";
                e.target.style.zIndex     = "";
                pos.x = 0; pos.y = 0;
                setTimeout(() => { e.target.style.transition = ""; }, 150);
                document.querySelectorAll(".drag-batch-highlight").forEach(row => {
                    row.classList.remove("drag-batch-highlight");
                });
            }
        }
    });
}

/* ── Drop ── */
function initDropzones() {
    document.querySelectorAll(".dropslot").forEach(slot => {
        interact(slot).dropzone({
            accept:  ".draggable",
            overlap: 0.3,
            listeners: {
                dragenter(e) { e.target.classList.add("drop-over"); },
                dragleave(e) { e.target.classList.remove("drop-over"); },
                drop(e) {
                    e.target.classList.remove("drop-over");

                    const leadUsername = e.relatedTarget.dataset.username;
                    const courtId      = e.target.dataset.court;
                    const target       = e.target.dataset.target;
                    const court        = courts.find(c => c.id === courtId);
                    if (!court) return;

                    const batch = getDragBatch(leadUsername);
                    const toPlace = batch.filter(u =>
                        !court.onCourt.includes(u) &&
                        !court.queue.some(g => g.players.includes(u))
                    );
                    const skipped = batch.length - toPlace.length;

                    if (toPlace.length === 0) {
                        showToast(batch.length > 1 ? "Already on " + court.name : leadUsername + " is already on " + court.name);
                        return;
                    }

                    let placed = [];
                    if (target === "oncourt") {
                        const startIdx = parseInt(e.target.dataset.slotIndex);
                        placed = fillOnCourtFrom(court, startIdx, toPlace);
                    } else {
                        const startGroup = parseInt(e.target.dataset.group);
                        const startSlot  = parseInt(e.target.dataset.slotIndex);
                        placed = fillQueueFrom(court, startGroup, startSlot, toPlace);
                    }

                    if (placed.length === 0) {
                        showToast("No room for " + (toPlace.length > 1 ? "that group" : toPlace[0]) + " on " + court.name);
                        return;
                    }

                    syncCourtTimer(court, null, false);

                    const leftover = toPlace.length - placed.length;
                    let msg = placed.length > 1
                        ? placed.length + " players → " + court.name
                        : placed[0] + " → " + court.name;
                    if (target === "oncourt") msg += " (playing)";
                    if (leftover > 0) msg += " — " + leftover + " more didn't fit";
                    if (skipped > 0) msg += " (" + skipped + " already placed)";
                    showToast(msg);

                    refresh();
                }
            }
        });
    });
}

function fillOnCourtFrom(court, startIdx, usernames) {
    const placed = [];
    let names = usernames.slice();

    for (let i = startIdx; i < court.courtSize && names.length > 0; i++) {
        if (court.onCourt[i] != null) continue;
        const u = names.shift();
        court.onCourt[i] = u;
        placed.push(u);
    }
    court.onCourt = court.onCourt.filter(u => u != null);

    if (names.length > 0) {
        const queuePlaced = fillQueueFrom(court, 0, 0, names);
        placed.push(...queuePlaced);
    }
    return placed;
}

function fillQueueFrom(court, startGroup, startSlot, usernames) {
    const placed = [];
    let names = usernames.slice();

    for (let gi = startGroup; gi < court.queue.length && names.length > 0; gi++) {
        const group = court.queue[gi];
        const fromSlot = gi === startGroup ? startSlot : 0;
        for (let pi = fromSlot; pi < group.size && names.length > 0; pi++) {
            if (group.players[pi] != null) continue;
            group.players[pi] = names.shift();
        }
        group.players = group.players.filter(u => u != null);
    }
    placed.push(...usernames.slice(0, usernames.length - names.length));
    return placed;
}

/* ── Drag batch size selector ── */
function injectDragSizeSelector() {
    const list = document.getElementById("item-list");
    if (!list || document.getElementById("drag-size-row")) return;

    const row = document.createElement("div");
    row.id = "drag-size-row";
    row.className = "drag-size-row";
    row.innerHTML = `
        <span class="drag-size-label">Drag</span>
        <div class="drag-size-btns">
            <button type="button" class="drag-size-btn active" data-size="1" onclick="setDragGroupSize(1)">1</button>
            <button type="button" class="drag-size-btn" data-size="2" onclick="setDragGroupSize(2)">2</button>
            <button type="button" class="drag-size-btn" data-size="4" onclick="setDragGroupSize(4)">4</button>
        </div>
        <span class="drag-size-label">at a time</span>
    `;
    list.parentNode.insertBefore(row, list);
}

/* ── Sign up ── */
function openSignup() {
    document.getElementById("signup-username").value = "";
    document.getElementById("signup-password").value = "";
    document.getElementById("signup-error").style.display = "none";
    const el = document.getElementById("signup-toast");
    el.style.display = "flex";
    requestAnimationFrame(() => el.classList.add("show"));
    document.getElementById("signup-username").focus();
}

function closeSignup() {
    const el = document.getElementById("signup-toast");
    el.classList.remove("show");
    setTimeout(() => { el.style.display = "none"; }, 200);
}

function closeSignupIfOutside(e) {} // no longer needed

async function submitSignup() {
    const username = document.getElementById("signup-username").value.trim();
    const password = document.getElementById("signup-password").value.trim();
    const errEl = document.getElementById("signup-error");

    if (!username || !password) {
        errEl.textContent = "Both fields are required.";
        errEl.style.display = "block";
        return;
    }

    const { error } = await sb
        .from("logins")
        .insert({ username, password });

    if (error) {
        errEl.textContent = error.message.includes("duplicate") ? "Username already exists." : error.message;
        errEl.style.display = "block";
        return;
    }

    document.getElementById('signup-username').value = '';
    document.getElementById('signup-password').value = '';
    document.getElementById('signup-error').style.display = 'none';
    showToast(username + " signed up!");
}


/* ── Tabs ── */
let activeTab = "manage";

function switchTab(tab) {
    activeTab = tab;
    document.getElementById("view-manage").style.display = tab === "manage" ? "" : "none";
    document.getElementById("view-courts").style.display = tab === "courts" ? "" : "none";
    document.getElementById("tab-manage").classList.toggle("active", tab === "manage");
    document.getElementById("tab-courts").classList.toggle("active", tab === "courts");
    if (tab === "courts") renderCourtsReadonly();
}

function renderCourtsReadonly() {
    const grid = document.getElementById("courts-grid-readonly");
    if (!grid) return;
    grid.innerHTML = "";

    courts.forEach(court => {
        const onSlotsHTML = Array.from({ length: court.courtSize }, (_, i) => {
            const username = court.onCourt[i];
            if (username) {
                const pw = (players.find(p => p.username === username) || {}).password || '';
                return `<div class="slot slot-occupied">
                    <span class="slot-num">${i + 1}</span>
                    <div class="slot-avatar">${initials(username)}</div>
                    <span class="slot-name">${username}</span>
                    <span class="slot-password">${pw}</span>
                </div>`;
            }
            return `<div class="slot">
                <span class="slot-num">${i + 1}</span>
                <span class="slot-placeholder">Empty</span>
            </div>`;
        }).join("");

        const qGroupsHTML = court.queue.map((group, gi) => {
            const playerSlotsHTML = Array.from({ length: group.size }, (_, pi) => {
                const username = group.players[pi];
                if (username) {
                    const pw = (players.find(p => p.username === username) || {}).password || '';
                    return `<div class="slot slot-occupied slot-queue">
                        <span class="slot-num q-num">${pi + 1}</span>
                        <div class="slot-avatar slot-avatar-queue">${initials(username)}</div>
                        <span class="slot-name">${username}</span>
                        <span class="slot-password slot-password-queue">${pw}</span>
                    </div>`;
                }
                return `<div class="slot slot-queue">
                    <span class="slot-num q-num">${pi + 1}</span>
                    <span class="slot-placeholder">Empty</span>
                </div>`;
            }).join("");

            return `<div class="queue-group">
                <div class="queue-group-header">
                    <span class="queue-group-label">Group ${gi + 1}</span>
                    <span class="court-badge badge-ok">${group.players.length}/${group.size}</span>
                </div>
                <div class="queue-slots">${playerSlotsHTML}</div>
            </div>`;
        }).join("");

        const timerHidden = court.timerEnd == null ? " court-timer-hidden" : "";
        const timerHTML = `<span class="court-timer${timerHidden}" data-court-ro="${court.id}">
            ${court.timerEnd != null ? formatCountdown(court.timerEnd - Date.now()) : ""}
        </span>`;

        const onBadgeClass = court.onCourt.length >= court.courtSize ? "badge-full" : court.onCourt.length === 0 ? "badge-empty" : "badge-ok";

        const card = document.createElement("div");
        card.className = "court-card";
        card.innerHTML = `
            <div class="court-header">
                <span class="readonly-court-name">${court.gymNumber != null ? "Court " + court.gymNumber : court.name}</span>
                <div class="court-header-right">${timerHTML}</div>
            </div>
            <div class="section-label">
                <span>${court.warmupEnd != null ? "In queue for court" : "On court"}</span>
                <span class="court-badge ${onBadgeClass}">${court.onCourt.length}/${court.courtSize}</span>
            </div>
            <div class="queue-slots">${onSlotsHTML}</div>
            ${court.queue.length > 0 ? `
            <div class="section-label section-label-queue">
                <span>Queue</span>
                <span class="court-badge badge-ok">${court.queue.length} group${court.queue.length !== 1 ? "s" : ""}</span>
            </div>
            ${qGroupsHTML}` : ""}
        `;
        grid.appendChild(card);
    });
}

/* ── Delete player ── */
async function deletePlayer(username) {
    if (!confirm("Delete " + username + "? This cannot be undone.")) return;

    courts.forEach(c => {
        c.onCourt = c.onCourt.filter(u => u !== username);
        c.queue.forEach(g => { g.players = g.players.filter(u => u !== username); });
        c.queue = c.queue.filter(g => g.players.length > 0);
        syncCourtTimer(c, null, false);
    });

    const { error } = await sb
        .from("logins")
        .delete()
        .eq("username", username);

    if (error) {
        showToast("Failed to delete " + username);
        console.error(error);
        return;
    }

    players = players.filter(p => p.username !== username);
    showToast(username + " deleted");
    refresh();
}

/* ── Boot ── */
async function boot() {
    initSupabase();
    injectDragSizeSelector();

    const restored = await loadState();
    if (!restored) {
        addCourt();
        addCourt();
    } else {
        renderCourts();
    }

    await loadTable();

    if (restored) {
        const now = Date.now();
        courts.forEach(court => {
            if (court.warmupEnd != null && now >= court.warmupEnd) {
                court.warmupEnd = null;
                court.timerEnd = Date.now() + SESSION_MS;
            }
            if (court.timerEnd != null && now >= court.timerEnd) {
                const expiredAt = court.timerEnd;
                court.timerEnd = null;
                rotateCourt(court, expiredAt);
            }
        });
        renderRoster();
        updateStats();
    }

    booting = false;
    subscribeToChanges();

    setInterval(() => {
        tickTimers();
        saveState();
    }, 1000);
}

boot();