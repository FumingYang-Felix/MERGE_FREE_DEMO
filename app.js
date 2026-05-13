// Portable static review site.
//
// Workflow: user imports a per-neuron bundle JSON (produced by
// export_review_bundle.py).  We load suspects, list them, and on
// click rebuild a spelunker URL with that window's centre + per-
// cluster token annotations.  Decisions go to localStorage keyed by
// (latest_root, idx) with two sub-fields:
//   merge — yes/no/skip/unsure  ("is this actually a real merge?")
//   split — yes/no/skip          ("does the spectral cut split off
//                                  at least one merge error?")

// ──────────────────────────── constants ─────────────────────────────
const SPELUNKER = "https://spelunker.cave-explorer.org/";
const UM_TO_VOXEL_X = 250.0;     // 4 nm xy → 1 voxel = 4nm; 1 µm = 250 vox
const UM_TO_VOXEL_Z = 25.0;      // 40 nm z → 1 voxel = 40nm; 1 µm = 25 vox
const VIEWER_DIMENSIONS = {
    x: [4e-9, "m"],
    y: [4e-9, "m"],
    z: [4e-8, "m"],
};
const MICRON_DIMENSIONS = {
    x: [1e-6, "m"],
    y: [1e-6, "m"],
    z: [1e-6, "m"],
};
// Cluster colour palette (max ~7 clusters in practice).
// Deliberately avoids red and blue families so the dots stay
// distinguishable from the underlying segmentation meshes
// (latest_root = #8888ff blue, old_root = #ff6688 pink).
const CLUSTER_COLORS = [
    "#ffe119",   // yellow
    "#3cb44b",   // saturated green
    "#ff8c00",   // orange
    "#aa44ff",   // purple
    "#bfef45",   // lime
    "#00d0a0",   // teal
    "#ee44ff",   // magenta-violet (distinct from the pinker old-root)
];

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
const splitContainer = $("split-buttons");
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
    // Migrate legacy entries:
    //   v1: {verdict, notes, ts} → {merge: verdict, ...}
    //   v2 (intermediate): affinity → split
    if (cur.verdict && !cur.merge) {
        cur.merge = cur.verdict;
        delete cur.verdict;
    }
    if (cur.affinity && !cur.split) {
        cur.split = cur.affinity;
        delete cur.affinity;
    }
    cur[field] = value;
    cur.ts = new Date().toISOString();
    all[idx] = cur;
    saveDecisions(root, all);
}
function splitTagText(splitV) {
    if (splitV === "skip") return { text: "S:S", title: "Split: skip" };
    if (splitV === "yes")  return { text: "S:Y", title: "Split: yes (legacy)" };
    if (splitV === "no")   return { text: "S:N", title: "Split: no (legacy)" };
    if (Array.isArray(splitV) && splitV.length > 0) {
        return {
            text: "S:" + splitV.length + "c",
            title: "Split clusters: " + splitV.join(","),
        };
    }
    return null;
}
function isSplitDecided(splitV) {
    // "skip" string — explicit skip
    if (splitV === "skip") return true;
    // legacy "yes"/"no" strings
    if (splitV === "yes" || splitV === "no") return true;
    // new schema: array of cluster ids; non-empty = decided
    if (Array.isArray(splitV) && splitV.length > 0) return true;
    return false;
}
function isDecided(d) {
    if (!d) return false;
    if (d.merge || d.verdict) return true;
    if (isSplitDecided(d.split)) return true;
    if (d.affinity) return true;  // legacy
    return false;
}
function clearDecisionField(root, idx, field) {
    const all = loadDecisions(root);
    const cur = (all[idx] && typeof all[idx] === "object")
              ? all[idx] : null;
    if (!cur) return;
    delete cur[field];
    cur.ts = new Date().toISOString();
    all[idx] = cur;
    saveDecisions(root, all);
}

function normalizeSplitSelection(splitV) {
    if (splitV === "yes" || splitV === "no" || splitV === "skip") {
        return splitV;
    }
    if (!Array.isArray(splitV)) return [];
    return Array.from(new Set(splitV.map(String)))
        .sort((a, b) => Number(a) - Number(b));
}

function getSelectedSplitLabels(win, splitV) {
    if (!win || !win.tokens || !Array.isArray(win.tokens.labels)) return [];
    const selected = normalizeSplitSelection(splitV);
    if (!Array.isArray(selected)) return [];
    const present = new Set(win.tokens.labels.map((lab) => String(lab)));
    return selected.filter((lab) => present.has(String(lab)))
        .map(Number)
        .sort((a, b) => a - b);
}

function makeAbsoluteTokenPointUm(centerUm, relPosUm) {
    return [
        centerUm[0] + relPosUm[0],
        centerUm[1] + relPosUm[1],
        centerUm[2] + relPosUm[2],
    ];
}

function makeAbsoluteTokenPointViewer(centerUm, relPosUm) {
    return [
        (centerUm[0] + relPosUm[0]) * UM_TO_VOXEL_X,
        (centerUm[1] + relPosUm[1]) * UM_TO_VOXEL_X,
        (centerUm[2] + relPosUm[2]) * UM_TO_VOXEL_Z,
    ];
}

function makeIdentityTransformRows() {
    return [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
    ];
}

function getLabelAnnotationLayerTransform() {
    return {
        inputDimensions: MICRON_DIMENSIONS,
        outputDimensions: VIEWER_DIMENSIONS,
        matrix: [
            [UM_TO_VOXEL_X, 0, 0, 0],
            [0, UM_TO_VOXEL_X, 0, 0],
            [0, 0, UM_TO_VOXEL_Z, 0],
        ],
    };
}

function getSegmentationLayerTransform() {
    return {
        inputDimensions: VIEWER_DIMENSIONS,
        outputDimensions: VIEWER_DIMENSIONS,
        matrix: makeIdentityTransformRows(),
    };
}

function applyAffineTransform(point, rows) {
    return rows.map((row) =>
        row[0] * point[0] + row[1] * point[1] + row[2] * point[2] + row[3]);
}

function invertAffineTransformRows(rows) {
    const a = rows[0][0], b = rows[0][1], c = rows[0][2], tx = rows[0][3];
    const d = rows[1][0], e = rows[1][1], f = rows[1][2], ty = rows[1][3];
    const g = rows[2][0], h = rows[2][1], i = rows[2][2], tz = rows[2][3];
    const det = a * (e * i - f * h)
              - b * (d * i - f * g)
              + c * (d * h - e * g);
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
        throw new Error("Layer transform is singular");
    }
    const invDet = 1 / det;
    const inv = [
        [(e * i - f * h) * invDet,
         (c * h - b * i) * invDet,
         (b * f - c * e) * invDet,
         0],
        [(f * g - d * i) * invDet,
         (a * i - c * g) * invDet,
         (c * d - a * f) * invDet,
         0],
        [(d * h - e * g) * invDet,
         (b * g - a * h) * invDet,
         (a * e - b * d) * invDet,
         0],
    ];
    const invTranslation = applyAffineTransform([-tx, -ty, -tz], inv);
    inv[0][3] = invTranslation[0];
    inv[1][3] = invTranslation[1];
    inv[2][3] = invTranslation[2];
    return inv;
}

function mapPointBetweenLayerTransforms(point, fromTransform, toTransform) {
    const viewerPoint = applyAffineTransform(point, fromTransform.matrix
        || makeIdentityTransformRows());
    const toInverse = invertAffineTransformRows(toTransform.matrix
        || makeIdentityTransformRows());
    return applyAffineTransform(viewerPoint, toInverse);
}

function makeSegmentationTokenPoint(centerUm, relPosUm) {
    const labelPoint = makeAbsoluteTokenPointUm(centerUm, relPosUm);
    return labelPoint;
    // return mapPointBetweenLayerTransforms(
    //     labelPoint,
    //     getLabelAnnotationLayerTransform(),
    //     getSegmentationLayerTransform(),
    // );
}

function buildClusterAnnotationLayers(window_) {
    if (!window_ || !window_.tokens || !Array.isArray(window_.tokens.labels)
            || !Array.isArray(window_.tokens.pos_rel_um)) {
        return [];
    }
    const positions = window_.tokens.pos_rel_um;
    const labels = window_.tokens.labels;
    const byCluster = {};
    for (let i = 0; i < positions.length; i++) {
        const lab = labels[i];
        if (!byCluster[lab]) byCluster[lab] = [];
        const p = positions[i];
        byCluster[lab].push({
            pt: makeAbsoluteTokenPointViewer(window_.center_um, p),
            desc: `T${i} cluster=${lab}`,
        });
    }
    return Object.keys(byCluster).sort((a, b) => Number(a) - Number(b))
        .map((lab) => {
            const color = CLUSTER_COLORS[Number(lab) % CLUSTER_COLORS.length];
            return {
                type: "annotation",
                source: "local://annotations",
                tab: "annotations",
                annotationColor: color,
                annotationFillOpacity: 0.35,
                annotations: byCluster[lab].map((a, i) => ({
                    type: "ellipsoid",
                    center: a.pt,
                    radii: [50, 50, 5],
                    id: `c${lab}_t${i}`,
                    description: a.desc,
                })),
                name: `cluster-${lab}`,
            };
        });
}

function buildGrapheneMulticutState(multicutLabels, layers) {
    if (!Array.isArray(multicutLabels) || multicutLabels.length !== 2) {
        return null;
    }
    const rootId = String(BUNDLE.neuron.latest_root_id);
    const [sinkLabel, sourceLabel] = multicutLabels.map(Number);
    const toMulticutPosition = (center) => [center[0] / 2, center[1] / 2, center[2]];
    const makeSelections = (label) => {
        const layer = layers.find((candidate) =>
            candidate && candidate.type === "annotation"
            && candidate.name === `cluster-${label}`);
        if (!layer || !Array.isArray(layer.annotations)) return [];
        return layer.annotations
            .map((annotation) => annotation && annotation.center)
            .filter(Array.isArray)
            .map((center) => ({
                rootId,
                segmentId: rootId,
                position: toMulticutPosition(center),
            }));
    };
    const sinks = makeSelections(sinkLabel);
    const sources = makeSelections(sourceLabel);

    if (!sinks.length || !sources.length) return null;
    return {
        multicut: {
            focusSegment: rootId,
            sinks,
            sources,
        },
    };
}

// ──────────────────────────── spelunker state builder ───────────────
function buildSpelunkerUrl(window_, options = {}) {
    const n = BUNDLE.neuron;
    const c = window_.center_um;
    const datastack = n.datastack || "minnie65_public";
    const clusterLayers = buildClusterAnnotationLayers(window_);
    const graphUrl = ("graphene://middleauth+https://minnie.microns-daf"
        + ".com/segmentation/table/" + datastack);
    const skeletonUrl = ("precomputed://middleauth+https://minnie.microns"
        + "-daf.com/skeletoncache/api/v1/" + datastack
        + "/precomputed/skeleton/");

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
                graphUrl,
                skeletonUrl,
            ],
            tab: "source",
            segments: segs,
            segmentColors: segColors,
            toolBindings: undefined,
            name: "segmentation",
        },
    ];
    layers.push(...clusterLayers);

    const graphState = buildGrapheneMulticutState(
        options.multicutLabels,
        layers,
    );
    const segmentationLayer = layers.find((layer) =>
        layer && layer.type === "segmentation" && layer.name === "segmentation");
    if (segmentationLayer) {
        segmentationLayer.source = [
            graphState ? { url: graphUrl, state: graphState } : graphUrl,
            skeletonUrl,
        ];
        segmentationLayer.toolBindings = graphState
            ? { M: "grapheneMulticutSegments" }
            : undefined;
    }

    const state = {
        dimensions: VIEWER_DIMENSIONS,
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

function showWindowInSpelunker(window_, options = {}) {
    const url = buildSpelunkerUrl(window_, options);
    const forceReload = options.forceReload === true;
    if (iframe.src === url || forceReload) {
        iframe.src = "about:blank";
    }
    if (options.multicutLabels) {
        iframe.addEventListener("load", () => iframe.focus(), { once: true });
    }
    if (forceReload) {
        requestAnimationFrame(() => {
            iframe.src = url;
        });
        return;
    }
    iframe.src = url;
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
        const splitV = d.split || d.affinity;  // affinity is legacy
        const splitTag = splitTagText(splitV);
        if (splitTag) {
            const tag2 = document.createElement("span");
            tag2.className = "verdict-tag affinity-tag";
            tag2.textContent = splitTag.text;
            tag2.title = splitTag.title;
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
    showWindowInSpelunker(w);

    // Reflect existing decision
    const root = BUNDLE.neuron.latest_root_id;
    const d = loadDecisions(root)[idx] || {};
    const mergeV = d.merge || d.verdict;     // verdict is legacy
    notesInput.value = d.notes || "";
    mergeBtns.forEach(b =>
        b.classList.toggle("active", b.dataset.v === mergeV));
    renderSplitButtons(w);

    // Scroll the selected row into the centre of the visible list,
    // even if the panel was resized down to a few rows tall.
    const sel = winList.querySelector(".win-row.selected");
    if (sel) {
        try {
            sel.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch (_e) {
            sel.scrollIntoView();
        }
    }
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
// Render the per-window cluster buttons inside #split-buttons.
// One colored button per unique cluster label in this window's
// tokens, plus a Skip button on the right.  All multi-toggleable.
function renderSplitButtons(win) {
    splitContainer.innerHTML = "";
    if (!win || !win.tokens || !Array.isArray(win.tokens.labels)
            || win.tokens.labels.length === 0) {
        const span = document.createElement("span");
        span.className = "dim";
        span.textContent = "(no token labels for this window)";
        splitContainer.appendChild(span);
        return;
    }

    const root = BUNDLE.neuron.latest_root_id;
    const d = loadDecisions(root)[win.idx] || {};
    let splitV = d.split;
    // Legacy: string "yes"/"no" map to no-cluster-selection (the
    // user has to re-decide under the new schema).
    if (splitV === "yes" || splitV === "no") splitV = [];
    const isSkip = splitV === "skip";
    const selSet = (Array.isArray(splitV))
                 ? new Set(normalizeSplitSelection(splitV)) : new Set();

    const uniqLabels = Array.from(new Set(win.tokens.labels))
                            .map(Number)
                            .sort((a, b) => a - b);
    uniqLabels.forEach((lab) => {
        const color = CLUSTER_COLORS[lab % CLUSTER_COLORS.length];
        const btn = document.createElement("button");
        btn.className = "split-cluster-btn"
                       + (selSet.has(String(lab)) ? " active" : "");
        btn.dataset.cluster = String(lab);
        btn.style.background = color;
        btn.style.borderColor = color;
        btn.title = "Split off cluster " + lab;
        btn.textContent = "C" + lab;
        btn.addEventListener("click", () => toggleSplitCluster(lab));
        splitContainer.appendChild(btn);
    });

    const selectedLabels = getSelectedSplitLabels(win, splitV);
    if (!isSkip && selectedLabels.length === 2) {
        const [sinkLabel, sourceLabel] = selectedLabels;
        const splitBtn = document.createElement("button");
        splitBtn.className = "create-split-btn";
        splitBtn.textContent = "Create split";
        splitBtn.title = "Open multicut with C" + sinkLabel
            + " as sinks (red) and C" + sourceLabel
            + " as sources (blue). Press M in Spelunker to activate it.";
        splitBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            showWindowInSpelunker(win, {
                multicutLabels: selectedLabels,
                forceReload: true,
            });
        });
        splitContainer.appendChild(splitBtn);
    }

    const skipBtn = document.createElement("button");
    skipBtn.className = "v-skip" + (isSkip ? " active" : "");
    skipBtn.dataset.v = "skip";
    skipBtn.textContent = "Skip";
    skipBtn.title = "Defer this window";
    skipBtn.addEventListener("click", () => toggleSplitSkip());
    splitContainer.appendChild(skipBtn);
}

function _persistSplit(value) {
    if (!BUNDLE || CURRENT_IDX == null) return;
    const root = BUNDLE.neuron.latest_root_id;
    if (Array.isArray(value) && value.length === 0) {
        // Empty → clear the field so the window is "undecided" again.
        clearDecisionField(root, CURRENT_IDX, "split");
    } else {
        setDecisionField(root, CURRENT_IDX, "split", value);
    }
    if (notesInput.value) {
        setDecisionField(root, CURRENT_IDX, "notes", notesInput.value);
    }
    const w = BUNDLE.windows.find(x => x.idx === CURRENT_IDX);
    if (w) renderSplitButtons(w);
    renderWindows();
}

function toggleSplitCluster(lab) {
    if (!BUNDLE || CURRENT_IDX == null) return;
    const root = BUNDLE.neuron.latest_root_id;
    const d = loadDecisions(root)[CURRENT_IDX] || {};
    let arr;
    // Picking a cluster cancels Skip and discards legacy yes/no.
    if (Array.isArray(d.split)) arr = d.split.slice();
    else arr = [];
    const labStr = String(lab);
    const i = arr.indexOf(labStr);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(labStr);
    arr.sort((a, b) => Number(a) - Number(b));
    _persistSplit(arr);
}

function toggleSplitSkip() {
    if (!BUNDLE || CURRENT_IDX == null) return;
    const root = BUNDLE.neuron.latest_root_id;
    const d = loadDecisions(root)[CURRENT_IDX] || {};
    if (d.split === "skip") {
        // Toggle off → clear (back to undecided).
        _persistSplit([]);
    } else {
        // Skip overrides any cluster selection.
        _persistSplit("skip");
    }
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
        // Auto-select the first window in the visible list so the
        // reviewer is dropped straight into the EM view instead of
        // a blank iframe.
        const firstRow = winList.querySelector(".win-row");
        if (firstRow) {
            const firstIdx = Number(firstRow.dataset.idx);
            if (Number.isFinite(firstIdx)) selectWindow(firstIdx);
        }
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
                                                || v.split || v.affinity)) {
                // Normalise legacy:
                //   "verdict" → "merge"
                //   "affinity" → "split"
                if (v.verdict && !v.merge) {
                    v.merge = v.verdict;
                    delete v.verdict;
                }
                if (v.affinity && !v.split) {
                    v.split = v.affinity;
                    delete v.affinity;
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

// Read a File as text, transparently gunzip-ing if the filename
// ends with .gz / .json.gz.  Hugging Face serves small files with
// Content-Disposition: inline so plain .json links render in the
// browser instead of downloading; the workaround is to publish
// .json.gz instead (always downloads), and have the import handler
// decompress in-browser via the standard DecompressionStream API.
async function _readBundleFile(f) {
    const isGz = /\.gz(?:ip)?$/i.test(f.name)
                 || f.type === "application/gzip"
                 || f.type === "application/x-gzip";
    if (!isGz) return f.text();
    if (typeof DecompressionStream === "undefined") {
        throw new Error("This browser cannot decompress .gz files "
                         + "(needs DecompressionStream).  Please "
                         + "use Chrome/Edge/Firefox 113+/Safari 16.4+.");
    }
    const stream = f.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
}

$("btn-import").addEventListener("click", () => importInput.click());
importInput.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
        const t = await _readBundleFile(f);
        importBundleFromText(t, f.name);
    } catch (err) {
        alert("Could not read bundle: " + err.message);
    }
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
// split buttons are dynamic (per-window); wired in renderSplitButtons.
nextBtn.addEventListener("click", goNextUndecided);
const _backBtn = $("btn-back");
// BACK is a plain "step one window back" — symmetric with the
// up-arrow / k navigation keys, NOT a "previous-undecided" jump.
if (_backBtn) _backBtn.addEventListener("click", () => jumpRow(-1));

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
    // SPLIT WHICH? — digit keys toggle the per-window cluster
    // buttons.  1 → cluster index 0, 2 → cluster index 1, etc.
    // 0 toggles Skip.  Mapped against the buttons currently in
    // the DOM so unused digits silently no-op.
    else if (/^[0-9]$/.test(k)) {
        if (k === "0") {
            toggleSplitSkip();
        } else {
            const i = Number(k) - 1;
            const btn = splitContainer.querySelector(
                `.split-cluster-btn:nth-of-type(${i + 1})`);
            if (btn && btn.dataset.cluster != null) {
                toggleSplitCluster(Number(btn.dataset.cluster));
            }
        }
    }
    // Navigation
    else if (k === "arrowright" || k === "enter") goNextUndecided();
    else if (k === "arrowleft") jumpRow(-1);     // BACK = step back
    else if (k === "arrowdown" || k === "j") jumpRow(+1);
    else if (k === "arrowup"   || k === "k") jumpRow(-1);
});

// ──────────────────────────── floating-panel chrome ─────────────────
// Drag by header.  We pin the panel to absolute left/top during drag
// (cancelling the right/bottom anchor) so it follows the mouse from
// any starting corner.  iframe pointer-events get suppressed while
// dragging so the mouse doesn't get captured by spelunker.
function makeDraggable(panelId) {
    const panel = $(panelId);
    if (!panel) return;
    const header = panel.querySelector("[data-drag-target='" + panelId + "']");
    if (!header) return;
    let dragging = false, ox = 0, oy = 0;
    header.addEventListener("mousedown", (e) => {
        // Don't start drag when clicking nested buttons.
        if (e.target.closest("button")) return;
        dragging = true;
        const r = panel.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.left = r.left + "px";
        panel.style.top = r.top + "px";
        // Block iframe from eating mouse moves while we drag.
        iframe.style.pointerEvents = "none";
        e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const w = panel.offsetWidth, h = panel.offsetHeight;
        const HEADER_PX = 41;            // the page header height
        const HEADER_MARGIN = 4;         // breathing room beneath it
        let x = e.clientX - ox, y = e.clientY - oy;
        x = Math.max(2, Math.min(window.innerWidth - w - 2, x));
        // Top edge is clamped to BELOW the page header — otherwise
        // the drag grip slides under the header bar and can't be
        // grabbed back.  Bottom edge keeps a tiny strip of header
        // visible so a too-tall panel still has a draggable handle.
        const minY = HEADER_PX + HEADER_MARGIN;
        const maxY = window.innerHeight - HEADER_PX - HEADER_MARGIN;
        y = Math.max(minY, Math.min(maxY, y));
        panel.style.left = x + "px";
        panel.style.top = y + "px";
    });
    document.addEventListener("mouseup", () => {
        if (dragging) {
            dragging = false;
            iframe.style.pointerEvents = "";
        }
    });
}
makeDraggable("left-panel");
makeDraggable("decision-panel");

// While the user drags the panel's bottom-right resize handle, the
// iframe also tries to grab pointer events; mute it during resize.
[document.getElementById("left-panel"),
 document.getElementById("decision-panel")].forEach((p) => {
    if (!p) return;
    p.addEventListener("mousedown", (e) => {
        const r = p.getBoundingClientRect();
        // Bottom-right 16×16 region is where the CSS resize grip is.
        if (e.clientX >= r.right - 16 && e.clientY >= r.bottom - 16) {
            iframe.style.pointerEvents = "none";
        }
    });
});
document.addEventListener("mouseup",
    () => { iframe.style.pointerEvents = ""; });

// Minimize / Close handlers (also re-open from the header buttons).
document.querySelectorAll("[data-min-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
        const panel = $(btn.dataset.minTarget);
        if (panel) panel.classList.toggle("collapsed");
    });
});
document.querySelectorAll("[data-close-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
        const panel = $(btn.dataset.closeTarget);
        if (panel) panel.classList.add("hidden");
    });
});
$("btn-show-windows").addEventListener("click", () => {
    const p = $("left-panel");
    p.classList.remove("hidden");
    p.classList.remove("collapsed");
});
$("btn-show-decision").addEventListener("click", () => {
    const p = $("decision-panel");
    p.classList.remove("hidden");
    p.classList.remove("collapsed");
});

updateMeta();
