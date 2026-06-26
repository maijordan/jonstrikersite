const TURSO_URL = "https://bintang-logins-bamster.aws-us-west-2.turso.io";
const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODIzNzIxNjksImlkIjoiMDE5ZWZkOTUtMGEwMS03MzI4LWE5NzItZGZmZjc2NTc2YTQ0IiwicmlkIjoiMWQzOWNlZDQtMGNlNS00ZWJhLWEzZWItYjkxZjFjODRjYTBjIn0.rRYYWCQwHi8VFY6c9oTLgmTuAVsnBfxBraE-chrOJhPgV7MV04E6OIim4flvJWFrFL1A0V4lRKFAXGy_h_KODQ";

/*
 * Court shape:
 *   {
 *     id:         string,
 *     name:       string,
 *     gymNumber:  number | null,  -- physical gym court number, 1-50, unique
 *     courtSize:  2 | 4,           -- players ON court
 *     onCourt:    [username, ...], -- currently playing (max courtSize)
 *     queue:      [                -- up to 4 groups waiting
 *       { size: 2|4, players: [username, ...] },
 *       ...
 *     ],
 *     timerEnd:   number | null,  -- Date.now()-style ms timestamp when the
 *                                    current session on this court expires
 *   }
 */

const SESSION_MS  = 45 * 60 * 1000; // 45 minutes
const MAX_GYM_NUM = 50;

let players      = [];
let courts       = [];
let courtCount   = 0;
let dragGroupSize = 1;

/* ── Turso helpers ── */
async function tursoQuery(sql) {
    const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${TURSO_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            requests: [
                { type: "execute", stmt: { sql } },
                { type: "close" }
            ]
        })
    });
    const data = await res.json();
    return data.results[0].response.result.rows;
}

async function tursoExecute(sql) {
    const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${TURSO_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            requests: [
                { type: "execute", stmt: { sql } },
                { type: "close" }
            ]
        })
    });
    return res.ok;
}

/* ── Court state persistence ── */
async function initStateTable() {
    await tursoExecute(`CREATE TABLE IF NOT EXISTS court_state (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
}

let saveTimeout = null;
function scheduleSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveState, 600);
}

async function saveState() {
    const snapshot = courts.map(c => ({
        ...c,
        timerEnd: c.timerEnd ? c.timerEnd - Date.now() : null
    }));
    const json = JSON.stringify(snapshot).replace(/'/g, "''");
    await tursoExecute(`INSERT INTO court_state (id, data) VALUES ('main', '${json}') ON CONFLICT(id) DO UPDATE SET data = excluded.data`);
}

async function loadState() {
    try {
        const rows = await tursoQuery(`SELECT data FROM court_state WHERE id = 'main'`);
        if (!rows || rows.length === 0) return false;
        const snapshot = JSON.parse(rows[0][0].value);
        console.log("Loaded snapshot:", snapshot); // ADD THIS
        courts = snapshot.map(c => ({
            ...c,
            timerEnd: c.timerEnd ? Date.now() + c.timerEnd : null
        }));
        courtCount = courts.length;
        return true;
    } catch (e) {
        console.error("loadState error:", e); // ADD THIS
        return false;
    }
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

/* ── Load table ── */
async function loadTable() {
    const rows = await tursoQuery('SELECT * FROM "Bintang Logins"');
    players = rows.map(row => ({
        username: row[0].value,
        password: row[1].value
    }));
    renderRoster();
    updateStats();
}

/* ── Roster ── */
let visibleUnassigned = [];

function renderRoster(filter = "") {
    const list = document.getElementById("item-list");
    const q    = filter.toLowerCase();
    list.innerHTML = "";
    visibleUnassigned = [];

    players
        .filter(p => p.username.toLowerCase().includes(q))
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

function filterRoster() {
    renderRoster(document.getElementById("roster-search").value);
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
}

function removeFromOnCourt(courtId, username) {
    const court = courts.find(c => c.id === courtId);
    if (!court) return;
    court.onCourt = court.onCourt.filter(u => u !== username);
    syncCourtTimer(court);
    refresh();
    showToast(username + " removed from court");
}

/* ── Timer ── */
function syncCourtTimer(court) {
    if (court.onCourt.length > 0 && court.timerEnd == null) {
        court.timerEnd = Date.now() + SESSION_MS;
    } else if (court.onCourt.length === 0) {
        court.timerEnd = null;
    }
}

function fillCourtFromQueue(court) {
    while (court.onCourt.length < court.courtSize && court.queue.length > 0) {
        const group = court.queue[0];
        const space = court.courtSize - court.onCourt.length;
        const take  = group.players.splice(0, space);
        court.onCourt.push(...take);
        if (group.players.length === 0) {
            court.queue.shift();
        } else {
            break;
        }
    }
}

function rotateCourt(court) {
    const rotatedOut = court.onCourt.slice();
    court.onCourt = [];
    court.timerEnd = null;
    fillCourtFromQueue(court);
    syncCourtTimer(court);
    refresh();
    if (rotatedOut.length) {
        showToast(court.name + " rotated — next group is up");
    }
}

function tickTimers() {
    const now = Date.now();
    let anyExpired = false;
    courts.forEach(court => {
        if (court.timerEnd != null && now >= court.timerEnd) {
            anyExpired = true;
            rotateCourt(court);
        }
    });
    if (!anyExpired) {
        updateTimerDisplays();
    }
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
        const el = document.querySelector(`.court-timer[data-court="${court.id}"]`);
        if (!el) return;
        if (court.timerEnd == null) {
            el.textContent = "";
            el.classList.add("court-timer-hidden");
            return;
        }
        const remaining = court.timerEnd - now;
        el.classList.remove("court-timer-hidden");
        el.textContent = formatCountdown(remaining);
        el.classList.toggle("court-timer-warn", remaining <= 5 * 60 * 1000);
    });
}

function removePlayerFromGroup(courtId, groupIdx, username) {
    const court = courts.find(c => c.id === courtId);
    if (!court) return;
    const group = court.queue[groupIdx];
    if (!group) return;
    group.players = group.players.filter(u => u !== username);
    if (group.players.length === 0) {
        court.queue.splice(groupIdx, 1);
    }
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
    renderRoster(document.getElementById("roster-search").value);
    updateStats();
    renderCourts();
    scheduleSave();
}

/* ── Render ── */
function renderCourts() {
    const grid = document.getElementById("courts-grid");
    grid.innerHTML = "";

    courts.forEach(court => {
        const onFull  = court.onCourt.length >= court.courtSize;
        const qFull   = court.queue.length >= 4;

        const onSlotsHTML = Array.from({ length: court.courtSize }, (_, i) => {
            const username = court.onCourt[i];
            if (username) {
                return `<div class="slot slot-occupied">
                    <span class="slot-num">${i + 1}</span>
                    <div class="slot-avatar">${initials(username)}</div>
                    <span class="slot-name">${username}</span>
                    <button class="slot-remove"
                        onclick="removeFromOnCourt('${court.id}','${username}')"
                        title="Remove">✕</button>
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
                        <button class="slot-remove"
                            onclick="removePlayerFromGroup('${court.id}',${gi},'${username}')"
                            title="Remove">✕</button>
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
                        <select class="group-size-select" title="Group size"
                            onchange="setGroupSize('${court.id}',${gi},+this.value)">
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

        const timerHidden = court.timerEnd == null ? " court-timer-hidden" : "";
        const timerHTML = `<span class="court-timer${timerHidden}" data-court="${court.id}">
            ${court.timerEnd != null ? formatCountdown(court.timerEnd - Date.now()) : ""}
        </span>`;

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
                <span>On court</span>
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
    let ghosts = [];

    interact(el).draggable({
        listeners: {
            start(e) {
                e.target.classList.add("is-dragging");
                e.target.style.zIndex = 1000;

                const batch = getDragBatch(e.target.dataset.username);
                ghosts = createFannedGhosts(e.target, batch);
            },
            move(e) {
                pos.x += e.dx;
                pos.y += e.dy;
                e.target.style.transform = `translate(${pos.x}px,${pos.y}px)`;
                ghosts.forEach(g => {
                    g.style.transform =
                        `translate(${pos.x + g.dataset.offX}px,${pos.y + g.dataset.offY}px) rotate(${g.dataset.rot}deg)`;
                });
            },
            end(e) {
                e.target.classList.remove("is-dragging");
                e.target.style.transition = "transform 0.15s ease";
                e.target.style.transform  = "translate(0,0)";
                e.target.style.zIndex     = "";
                pos.x = 0; pos.y = 0;
                setTimeout(() => { e.target.style.transition = ""; }, 150);

                ghosts.forEach(g => g.remove());
                ghosts = [];
            }
        }
    });
}

function createFannedGhosts(originEl, batch) {
    if (batch.length <= 1) return [];

    const rect = originEl.getBoundingClientRect();
    const extras = batch.slice(1);

    return extras.map((username, i) => {
        const player = players.find(p => p.username === username);
        const ghost = originEl.cloneNode(true);
        ghost.classList.remove("is-dragging");
        ghost.classList.add("drag-ghost");
        ghost.removeAttribute("id");

        if (player) {
            ghost.dataset.username = player.username;
            const nameEl = ghost.querySelector(".col-username");
            const pwEl   = ghost.querySelector(".col-password");
            if (nameEl) nameEl.textContent = player.username;
            if (pwEl)   pwEl.textContent   = player.password;
            const avatarEl = ghost.querySelector(".player-avatar");
            if (avatarEl) avatarEl.textContent = initials(player.username);
        }

        const dir    = i % 2 === 0 ? 1 : -1;
        const step   = Math.ceil((i + 1) / 2);
        const rot    = dir * (6 * step);
        const offX   = dir * (10 * step);
        const offY   = 6 * step;

        ghost.style.position   = "fixed";
        ghost.style.left       = rect.left + "px";
        ghost.style.top        = rect.top + "px";
        ghost.style.width      = rect.width + "px";
        ghost.style.zIndex     = 999 - step;
        ghost.style.transform  = `translate(${offX}px,${offY}px) rotate(${rot}deg)`;
        ghost.dataset.offX = offX;
        ghost.dataset.offY = offY;
        ghost.dataset.rot  = rot;

        document.body.appendChild(ghost);
        return ghost;
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

                    syncCourtTimer(court);

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
        court.onCourt[i] = names.shift();
    }
    court.onCourt = court.onCourt.filter(u => u != null);
    placed.push(...usernames.slice(0, usernames.length - names.length));

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

/* ── Boot ── */
async function boot() {
    injectDragSizeSelector();
    await initStateTable();
    const restored = await loadState();
    if (!restored) {
        addCourt();
        addCourt();
    } else {
        renderCourts();
    }
    await loadTable();
    if (restored) {
        renderRoster(document.getElementById("roster-search").value);
        updateStats();
    }

    setInterval(() => {
        tickTimers();
        scheduleSave();
    }, 1000);
}

window.addEventListener("beforeunload", (e) => {
    const snapshot = courts.map(c => ({
        ...c,
        timerEnd: c.timerEnd ? c.timerEnd - Date.now() : null
    }));
    const json = JSON.stringify(snapshot).replace(/'/g, "''");
    navigator.sendBeacon(
        `${TURSO_URL}/v2/pipeline`,
        JSON.stringify({
            requests: [
                { type: "execute", stmt: { sql: `INSERT INTO court_state (id, data) VALUES ('main', '${json}') ON CONFLICT(id) DO UPDATE SET data = excluded.data` } },
                { type: "close" }
            ]
        })
    );
});
boot();