// Portable static review site.
//
// Workflow: user imports a per-neuron bundle JSON (produced by
// export_review_bundle.py).  We load suspects, list them, and on
// click rebuild a spelunker URL with that window's centre + per-
// cluster token annotations.  Decisions go to localStorage keyed by
// (latest_root, idx) with two sub-fields:
//   merge    — yes/no/skip/unsure  ("is this actually a real merge?")
//   affinity — yes/no/skip          ("did spectral cut group correctly?")

// ──────────────────────────── constants ─────────────────────────────
const SPELUNKER = "https://spelunker.cave-explorer.org/";
const UM_TO_VOXEL_X = 250.0;     // 4 nm xy → 1 voxel = 4nm; 1 µm = 250 vox
const UM_TO_VOXEL_Z = 25.0;      // 40 nm z → 1 voxel = 40nm; 1 µm = 25 vox
// Cluster colour palette (max ~7 clusters in practice)
const CLUSTER_COLORS = ["#ff2d55", "#2cb1ff", "#ffe119", "#3cb44b",
                        "#9b59b6", "#ff8c00", "#42d4f4"];

// ──────────────────────────── state ─────────────────────────────────
let BUNDLE = null;        // the loaded JSON
let CURRENT_TAB = "suspect";
let CURRENT_IDX = null;

// ──────────────────────────── shorthands ────────────────────────────
const $ = (id) => document.getElementById(id);
const importInput = $("import-input");
const importDecisionsInput = $("import-decisions-input");
const winList = $("window-list");
const iframe = $("ng-iframe");
const mergeBtns = document.querySelectorAll("#merge-buttons button");
const affinityBtns = document.querySelectorAll("#affinity-buttons button");
const tabBtns = document.querySelectorAll("#tab-toggle button");
const notesInput = $("cur-notes");
const hideDecided = $("hide-decided");
const meta = $("bundle-meta");
const curMeta = $("cur-meta");
const welcome = $("welcome-overlay");
const nextBtn = $("btn-next");

// ──────────────────────────── decisions store ───────────────────────
function _decisionsKey(root) { return `decisions.${root}`; }
function loadDecisions(root) {
    try {
        const raw = localStorage.getItem(_decisionsKey(root));
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}
function saveDecisions(root, decisions) {
    localStorage.setItem(_decisionsKey(root), JSON.stringify(decisions));
}
function getDecision(root, idx) {
    return loadDecisions(root)[idx] || null;
}
function setDecisionField(root, idx, field, value) {
    const all = loadDecisions(root);
    const cur = (all[idx] && typeof all[idx] === "object") ? all[idx] : {};
    // Migrate legacy v1 entries: {verdict, notes, ts} → {merge, ...}
    if (cur.verdict && !cur.merge) {
        cur.merge = cur.verdict;
        delete cur.verdict;
    }
    cur[field] = value;
    cur.ts = new Date().toISOString();
    all[idx] = cur;
    saveDecisions(root, all);
}
function isDecided(d) {
    return !!(d && (d.merge || d.affinity));
}

// ──────────────────────────── spelunker state builder ───────────────
function buildSpelunkerUrl(window_) {
    const n = BUNDLE.neuron;
    const c = window_.center_um;
    const datastack = n.datastack || "minnie65_public";

    // Build the segments list: latest root in blue + every old root
    // in red.  Old roots come from `old_root_ids` (preferred) or the
    // legacy single-string `old_root_id` (back-compat).
    const segs = [String(n.latest_root_id)];
    const segColors = {};
    segColors[String(n.latest_root_id)] = "#8888ff";

    let oldRoots = [];
    if (Array.isArray(n.old_root_ids)) {
        oldRoots = n.old_root_ids.filter(Boolean).map(String);
    } else if (n.old_root_id) {
        oldRoots = [String(n.old_root_id)];
    }
    for (const oid of oldRoots) {
        if (oid && oid !== String(n.latest_root_id)) {
            segs.push(oid);
            segColors[oid] = "#ff6688";
        }
    }

    const layers = [
        {
            type: "image",
            source: ("precomputed://https://bossdb-open-data."
                     + "s3.amazonaws.com/iarpa_microns/minnie/"
                     + "minnie65/em"),
            tab: "source",
            name: "imagery",
        },
        {
            type: "segmentation",
            source: [
                ("graphene://middleauth+https://minnie.microns-daf"
                 + ".com/segmentation/table/" + datastack),
                ("precomputed://middleauth+https://minnie.microns"
                 + "-daf.com/skeletoncache/api/v1/" + datastack
                 + "/precomputed/skeleton/"),
            ],
            tab: "source",
            segments: segs,
            segmentColors: segColors,
            name: "segmentation",
        },
    ];

    if (window_.tokens && window_.tokens.pos_rel_um
            && window_.tokens.labels) {
        const positions = window_.tokens.pos_rel_um;
        const labels = window_.tokens.labels;
        const byCluster = {};
        for (let i = 0; i < positions.length; i++) {
            const lab = labels[i];
            if (!byCluster[lab]) byCluster[lab] = [];
            const p = positions[i];
            byCluster[lab].push({
                pt: [(c[0] + p[0]) * UM_TO_VOXEL_X,
                     (c[1] + p[1]) * UM_TO_VOXEL_X,
                     (c[2] + p[2]) * UM_TO_VOXEL_Z],
                desc: `T${i} cluster=${lab}`,
            });
        }
        Object.keys(byCluster).sort((a, b) => Number(a) - Number(b))
              .forEach((lab) => {
            const color = CLUSTER_COLORS[Number(lab) % CLUSTER_COLORS.length];
            layers.push({
                type: "annotation",
                source: "local://annotations",
                tab: "annotations",
                annotationColor: color,
                annotations: byCluster[lab].map((a, i) => ({
                    point: a.pt,
                    type: "point",
                    id: `c${lab}_t${i}`,
                    description: a.desc,
                })),
                name: `cluster-${lab}`,
            });
        });
    }

    const state = {
        dimensions: { x: [4e-9, "m"], y: [4e-9, "m"], z: [4e-8, "m"] },
        position: [c[0] * UM_TO_VOXEL_X,
                   c[1] * UM_TO_VOXEL_X,
                   c[2] * UM_TO_VOXEL_Z],
        crossSectionScale: 1.0,
        projectionScale: 12000,
        layers,
        selectedLayer: { layer: "segmentation", visible: true },
        layout: "xy-3d",
    };
    return SPELUNKER + "#!" + encodeURIComponent(JSON.stringify(state));
}

// ──────────────────────────── rendering ─────────────────────────────
function updateMeta() {
    if (!BUNDLE) {
        meta.textContent = "No bundle loaded.";
        return;
    }
    const n = BUNDLE.neuron;
    const md = BUNDLE.metadata || {};
    const decisions = loadDecisions(n.latest_root_id);
    const nDone = Object.values(decisions).filter(isDecided).length;
    const oldStr = (Array.isArray(n.old_root_ids) && n.old_root_ids.length)
        ? ` + ${n.old_root_ids.length} old`
        : (n.old_root_id ? ` + 1 old` : "");
    meta.textContent = `root=${n.latest_root_id}${oldStr}  · `
        + `${md.n_suspects || 0} suspects / `
        + `${md.n_windows || 0} windows · `
        + `${nDone} reviewed`;
}

function renderWindows() {
    winList.innerHTML = "";
    if (!BUNDLE) return;
    const root = BUNDLE.neuron.latest_root_id;
    const decisions = loadDecisions(root);

    let windows = BUNDLE.windows.slice();
    if (CURRENT_TAB === "suspect") {
        windows = windows.filter(w => w.is_suspect);
        windows.sort((a, b) => (b.verify_prob || 0) - (a.verify_prob || 0));
    } else {
        windows.sort((a, b) => a.idx - b.idx);
    }
    if (hideDecided.checked) {
        windows = windows.filter(w => !isDecided(decisions[w.idx]));
    }

    for (const w of windows) {
        const row = document.createElement("div");
        row.className = "win-row" + (w.is_suspect ? " is-suspect" : "");
        row.dataset.idx = w.idx;
        if (CURRENT_IDX === w.idx) row.classList.add("selected");

        const idxSpan = document.createElement("span");
        idxSpan.className = "idx";
        idxSpan.textContent = `#${w.idx}`;
        row.appendChild(idxSpan);

        const probSpan = document.createElement("span");
        probSpan.className = "prob";
        probSpan.textContent = (w.verify_prob == null) ? "—"
                              : w.verify_prob.toFixed(3);
        row.appendChild(probSpan);

        const d = decisions[w.idx] || {};
        const mergeV = d.merge || d.verdict;  // verdict is legacy
        if (mergeV) {
            const tag = document.createElement("span");
            tag.className = "verdict-tag " + mergeV;
            tag.textContent = mergeV.toUpperCase();
            row.appendChild(tag);
        }
        if (d.affinity) {
            const tag2 = document.createElement("span");
            tag2.className = "verdict-tag affinity-tag";
            tag2.textContent = "A:" + d.affinity[0].toUpperCase();
            tag2.title = "Affinity: " + d.affinity;
            row.appendChild(tag2);
        }
        row.addEventListener("click", () => selectWindow(w.idx));
        winList.appendChild(row);
    }
    if (!windows.length) {
        winList.innerHTML = '<div style="padding:10px;color:#666">'
            + '(no matching windows)</div>';
    }
    updateMeta();
}

function selectWindow(idx) {
    if (!BUNDLE) return;
    CURRENT_IDX = idx;
    document.querySelectorAll(".win-row").forEach(r =>
        r.classList.toggle("selected", Number(r.dataset.idx) === idx));
    const w = BUNDLE.windows.find(x => x.idx === idx);
    if (!w) return;
    const has_tokens = !!(w.tokens && w.tokens.labels);
    const sp = (w.tokens && w.tokens.spectral) || {};
    const sp_str = (sp.k != null)
        ? `  k=${sp.k} score=${(sp.score || 0).toFixed(3)}`
        : "";
    curMeta.textContent =
        `W#${w.idx}  center=${w.center_um.map(c => c.toFixed(1)).join(",")} µm`
        + `  prob=${w.verify_prob == null ? "—" : w.verify_prob.toFixed(3)}`
        + `  ${w.is_suspect ? "SUSPECT" : "non-suspect"}`
        + (has_tokens ? sp_str : "  (no token affinity)");
    iframe.src = buildSpelunkerUrl(w);

    // Reflect existing decision
    const root = BUNDLE.neuron.latest_root_id;
    const d = loadDecisions(root)[idx] || {};
    const mergeV = d.merge || d.verdict;  // verdict is legacy
    notesInput.value = d.notes || "";
    mergeBtns.forEach(b =>
        b.classList.toggle("active", b.dataset.v === mergeV));
    affinityBtns.forEach(b =>
        b.classList.toggle("active", b.dataset.v === d.affinity));
}

// ──────────────────────────── verdict + nav ─────────────────────────
function applyMerge(verdict) {
    if (!BUNDLE || CURRENT_IDX == null) return;
    setDecisionField(BUNDLE.neuron.latest_root_id, CURRENT_IDX,
                     "merge", verdict);
    if (notesInput.value) {
        setDecisionField(BUNDLE.neuron.latest_root_id, CURRENT_IDX,
                         "notes", notesInput.value);
    }
    mergeBtns.forEach(b =>
        b.classList.toggle("active", b.dataset.v === verdict));
    renderWindows();
}
function applyAffinity(verdict) {
    if (!BUNDLE || CURRENT_IDX == null) return;
    setDecisionField(BUNDLE.neuron.latest_root_id, CURRENT_IDX,
                     "affinity", verdict);
    if (notesInput.value) {
        setDecisionField(BUNDLE.neuron.latest_root_id, CURRENT_IDX,
                         "notes", notesInput.value);
    }
    affinityBtns.forEach(b =>
        b.classList.toggle("active", b.dataset.v === verdict));
    renderWindows();
}

function jumpRow(delta) {
    if (!BUNDLE) return;
    const visible = Array.from(winList.querySelectorAll(".win-row"))
                         .map(r => Number(r.dataset.idx));
    if (!visible.length) return;
    let i = visible.indexOf(CURRENT_IDX);
    i = (i < 0) ? 0
                : Math.min(visible.length - 1, Math.max(0, i + delta));
    selectWindow(visible[i]);
}

function goNextUndecided() {
    if (!BUNDLE) return;
    const root = BUNDLE.neuron.latest_root_id;
    const decisions = loadDecisions(root);
    const visible = Array.from(winList.querySelectorAll(".win-row"))
                         .map(r => Number(r.dataset.idx));
    if (!visible.length) return;
    const startPos = visible.indexOf(CURRENT_IDX);
    // Search from the row AFTER the current one for the next undecided.
    for (let off = 1; off <= visible.length; off++) {
        const idx = visible[(startPos + off) % visible.length];
        if (!isDecided(decisions[idx])) {
            selectWindow(idx);
            return;
        }
    }
    // All decided — just step one row down.
    if (startPos >= 0 && startPos + 1 < visible.length) {
        selectWindow(visible[startPos + 1]);
    } else {
        selectWindow(visible[0]);
    }
}

// ──────────────────────────── import / export ───────────────────────
function importBundleFromText(text, source) {
    try {
        const obj = JSON.parse(text);
        if (!obj.neuron || !obj.windows) {
            alert("That JSON doesn't look like a review bundle.");
            return;
        }
        BUNDLE = obj;
        CURRENT_IDX = null;
        iframe.src = "about:blank";
        welcome.classList.add("hidden");
        renderWindows();
        updateMeta();
    } catch (e) {
        alert("Failed to parse bundle JSON: " + e.message);
    }
}

function importDecisionsFromText(text) {
    if (!BUNDLE) {
        alert("Import a bundle first, then a decisions JSON.");
        return;
    }
    try {
        const obj = JSON.parse(text);
        const root = String(BUNDLE.neuron.latest_root_id);
        let entries = null;
        if (obj && typeof obj === "object") {
            if (obj[root] && typeof obj[root] === "object") {
                entries = obj[root];
            } else if (obj.root_id != null && obj.decisions != null) {
                entries = obj.decisions;
            } else {
                entries = obj;
            }
        }
        if (!entries || typeof entries !== "object") {
            alert("Could not find decisions for root " + root);
            return;
        }
        const cur = loadDecisions(root);
        let n = 0;
        for (const k of Object.keys(entries)) {
            const v = entries[k];
            if (v && typeof v === "object" && (v.merge || v.verdict
                                                || v.affinity)) {
                // Normalise legacy "verdict" → "merge"
                if (v.verdict && !v.merge) {
                    v.merge = v.verdict;
                    delete v.verdict;
                }
                cur[k] = v;
                n++;
            }
        }
        saveDecisions(root, cur);
        renderWindows();
        alert(`Merged ${n} prior decision(s).`);
    } catch (e) {
        alert("Failed to parse decisions JSON: " + e.message);
    }
}

function exportDecisions() {
    if (!BUNDLE) return;
    const root = BUNDLE.neuron.latest_root_id;
    const decisions = loadDecisions(root);
    const payload = {
        schema: "merge-review-decisions/v2",
        root_id: root,
        exported_at: new Date().toISOString(),
        n_decisions: Object.values(decisions).filter(isDecided).length,
        decisions,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)],
                          { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${root}_decisions.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ──────────────────────────── auth warmup ───────────────────────────
function openCaveWarmup() {
    const state = {
        dimensions: { x: [4e-9, "m"], y: [4e-9, "m"], z: [4e-8, "m"] },
        crossSectionScale: 1.0,
        projectionScale: 50000,
        layers: [
            { type: "image",
              source: ("precomputed://https://bossdb-open-data."
                       + "s3.amazonaws.com/iarpa_microns/minnie/"
                       + "minnie65/em"),
              tab: "source", name: "imagery" },
            { type: "segmentation",
              source: [
                  ("graphene://middleauth+https://minnie.microns-"
                   + "daf.com/segmentation/table/minnie65_public"),
                  ("precomputed://middleauth+https://minnie.microns-"
                   + "daf.com/skeletoncache/api/v1/minnie65_public/"
                   + "precomputed/skeleton/"),
              ],
              tab: "source", name: "segmentation" },
        ],
        selectedLayer: { layer: "segmentation", visible: true },
        layout: "xy-3d",
    };
    const url = SPELUNKER + "#!" + encodeURIComponent(
        JSON.stringify(state));
    window.open(url, "_blank", "noopener");
}

// ──────────────────────────── wiring ────────────────────────────────
const _warmupBtn = $("btn-warmup");
if (_warmupBtn) _warmupBtn.addEventListener("click", openCaveWarmup);

$("btn-import").addEventListener("click", () => importInput.click());
importInput.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then(t => importBundleFromText(t, f.name));
    importInput.value = "";
});
const _welImport = $("btn-welcome-import");
if (_welImport) _welImport.addEventListener(
    "click", () => importInput.click());

$("btn-import-decisions").addEventListener("click",
    () => importDecisionsInput.click());
importDecisionsInput.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then(t => importDecisionsFromText(t));
    importDecisionsInput.value = "";
});
const _welImportDec = $("btn-welcome-import-decisions");
if (_welImportDec) _welImportDec.addEventListener(
    "click", () => importDecisionsInput.click());

$("btn-export").addEventListener("click", exportDecisions);

tabBtns.forEach(b => b.addEventListener("click", () => {
    tabBtns.forEach(x => x.classList.toggle("active", x === b));
    CURRENT_TAB = b.dataset.tab;
    renderWindows();
}));
hideDecided.addEventListener("change", renderWindows);

mergeBtns.forEach(b =>
    b.addEventListener("click", () => applyMerge(b.dataset.v)));
affinityBtns.forEach(b =>
    b.addEventListener("click", () => applyAffinity(b.dataset.v)));
nextBtn.addEventListener("click", goNextUndecided);

let _notesT = null;
notesInput.addEventListener("input", () => {
    clearTimeout(_notesT);
    _notesT = setTimeout(() => {
        if (!BUNDLE || CURRENT_IDX == null) return;
        setDecisionField(BUNDLE.neuron.latest_root_id, CURRENT_IDX,
                         "notes", notesInput.value || "");
    }, 800);
});

document.addEventListener("keydown", (e) => {
    if (document.activeElement === notesInput) return;
    if (welcome && !welcome.classList.contains("hidden")) return;
    const k = e.key.toLowerCase();
    // Real-merge verdict
    if (k === "y") applyMerge("yes");
    else if (k === "n") applyMerge("no");
    else if (k === "s") applyMerge("skip");
    else if (k === "u") applyMerge("unsure");
    // Affinity verdict
    else if (k === "1") applyAffinity("yes");
    else if (k === "2") applyAffinity("no");
    else if (k === "3") applyAffinity("skip");
    // Navigation
    else if (k === "arrowright" || k === "enter") goNextUndecided();
    else if (k === "arrowdown" || k === "j") jumpRow(+1);
    else if (k === "arrowup"   || k === "k") jumpRow(-1);
});

updateMeta();
