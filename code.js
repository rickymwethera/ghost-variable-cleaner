// Ghost Variable Cleaner — plugin logic
// ---------------------------------------------------------------------------
// This file runs inside Figma's plugin sandbox. It can read and change the
// document, but it has no window of its own; ui.html is the window, and the
// two talk by sending messages to each other.
//
// What happens, in order:
//   1. We open the plugin window.
//   2. The window asks for a scan. We walk every layer in the chosen scope and
//      record every place a variable is attached ("bound") to that layer:
//      fills, strokes, effects, layout grids, text ranges, plain fields like
//      padding or corner radius, and "variable modes" set on frames.
//   3. We look each variable up and sort it into one of these buckets:
//        local     – lives in this file                     (healthy)
//        library   – comes from a library this file uses    (healthy)
//        missing   – Figma can no longer find it at all     (ghost)
//        orphaned  – comes from a library that is NOT enabled
//                    in this file any more                   (ghost)
//        unknown   – from a library, but we could not check
//                    which libraries are enabled             (ask the user)
//   4. For each ghost we look for a replacement: a variable with the same name
//      and type (or a collection with the same name, for modes) in this file
//      or in an enabled library.
//   5. The window asks to fix a list of ghosts, in one of two ways:
//        detach    – the layer keeps exactly how it looks; only the link to
//                    the dead variable goes.
//        reconnect – the layer is linked to the replacement instead, so it
//                    stays connected to the design system.
// ---------------------------------------------------------------------------

figma.showUI(__html__, { width: 440, height: 620, themeColors: true });

var STATUS = {
  LOCAL: 'local',
  LIBRARY: 'library',
  MISSING: 'missing',
  ORPHANED: 'orphaned',
  UNKNOWN: 'unknown'
};

// Text properties that can differ letter by letter, so Figma stores them per
// "range" of characters instead of once per layer. They need special handling.
var TEXT_RANGE_FIELDS = [
  'fontFamily', 'fontSize', 'fontStyle', 'fontWeight',
  'letterSpacing', 'lineHeight', 'paragraphSpacing', 'paragraphIndent'
];

// Fields we handle with dedicated code below, so the generic pass skips them.
var HANDLED_ELSEWHERE = {};
['fills', 'strokes', 'effects', 'layoutGrids', 'textRangeFills', 'componentProperties']
  .concat(TEXT_RANGE_FIELDS)
  .forEach(function (f) { HANDLED_ELSEWHERE[f] = true; });

// Lookups are slow-ish and the same variable is usually bound to hundreds of
// layers, so we remember every answer for the length of one scan.
var variableCache = new Map();
var collectionCache = new Map();

// Collection key -> library name, for every library enabled in this file.
// Stays null if Figma would not tell us (no team library access).
var enabledLibraries = null;
// The same libraries as a list, kept so Reconnect can search inside them.
var enabledLibraryCollections = [];

// The last scan, kept so "Show layers" and "Detach" know where everything is.
var lastScan = { scope: 'page', groups: new Map() };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function tick() {
  // Hands control back to Figma for a moment so the app does not freeze
  // during long scans.
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function send(msg) {
  figma.ui.postMessage(msg);
}

function withBase(base, extra) {
  return Object.assign({}, base, extra);
}

async function getVariable(id) {
  if (!variableCache.has(id)) {
    var v = null;
    try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { v = null; }
    variableCache.set(id, v);
  }
  return variableCache.get(id);
}

async function getCollection(id) {
  if (!collectionCache.has(id)) {
    var c = null;
    try { c = await figma.variables.getVariableCollectionByIdAsync(id); } catch (e) { c = null; }
    collectionCache.set(id, c);
  }
  return collectionCache.get(id);
}

async function loadEnabledLibraries() {
  try {
    var cols = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    enabledLibraryCollections = cols;
    var map = new Map();
    cols.forEach(function (c) { map.set(c.key, c.libraryName); });
    return map;
  } catch (e) {
    enabledLibraryCollections = [];
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2: find every place a variable is attached to a layer
// ---------------------------------------------------------------------------

// Checks a list of paints. A solid paint can have its colour bound; a
// gradient can have the colour of each of its stops bound separately.
// `kind` is 'paint' for layer fills/strokes or 'textPaint' for a text range.
function collectFromPaints(paints, base, kind, addVar) {
  paints.forEach(function (paint, i) {
    var alias = paint.boundVariables && paint.boundVariables.color;
    if (alias) addVar(alias.id, withBase(base, { kind: kind, index: i }));
    (paint.gradientStops || []).forEach(function (stop, k) {
      var stopAlias = stop.boundVariables && stop.boundVariables.color;
      if (stopAlias) addVar(stopAlias.id, withBase(base, { kind: kind, index: i, stop: k }));
    });
  });
}

// Looks at ONE layer and reports each binding it finds.
//   addVar(variableId, usage)      – a variable bound to some property
//   addMode(collectionId, usage)   – a variable mode chosen on this layer
// A "usage" records exactly where the binding is, so we can undo it later.
function collectFromNode(node, pageId, addVar, addMode) {
  var base = { nodeId: node.id, pageId: pageId, nodeName: node.name };

  // Fills and strokes are lists of paints; each paint can have its colour
  // bound to a variable. Text fills are handled per range further down.
  ['fills', 'strokes'].forEach(function (field) {
    if (field === 'fills' && node.type === 'TEXT') return;
    if (!(field in node)) return;
    var paints = node[field];
    if (!Array.isArray(paints)) return; // figma.mixed: varies across the layer
    collectFromPaints(paints, withBase(base, { field: field }), 'paint', addVar);
  });

  // Effects (shadows, blurs): colour, radius, spread and offsets can be bound.
  if ('effects' in node && Array.isArray(node.effects)) {
    node.effects.forEach(function (effect, i) {
      var bv = effect.boundVariables || {};
      Object.keys(bv).forEach(function (f) {
        if (bv[f]) addVar(bv[f].id, withBase(base, { kind: 'effect', field: f, index: i }));
      });
    });
  }

  // Layout grids: count, gutter, offset and size can be bound.
  if ('layoutGrids' in node && Array.isArray(node.layoutGrids)) {
    node.layoutGrids.forEach(function (grid, i) {
      var bv = grid.boundVariables || {};
      Object.keys(bv).forEach(function (f) {
        if (bv[f]) addVar(bv[f].id, withBase(base, { kind: 'grid', field: f, index: i }));
      });
    });
  }

  // Text: one text layer can mix styles, so Figma splits it into segments.
  // We ask for every segment and check each one's bindings and fills.
  if (node.type === 'TEXT') {
    var segments = [];
    try { segments = node.getStyledTextSegments(['boundVariables', 'fills']); } catch (e) { segments = []; }
    segments.forEach(function (seg) {
      var bv = seg.boundVariables || {};
      Object.keys(bv).forEach(function (f) {
        if (bv[f]) {
          addVar(bv[f].id, withBase(base, { kind: 'textRange', field: f, start: seg.start, end: seg.end }));
        }
      });
      if (Array.isArray(seg.fills)) {
        collectFromPaints(seg.fills, withBase(base, { start: seg.start, end: seg.end }), 'textPaint', addVar);
      }
    });
  }

  // Everything else is a single value per layer: width, padding, gap,
  // corner radius, opacity, visibility, text content, and so on.
  var bound = node.boundVariables || {};
  Object.keys(bound).forEach(function (f) {
    if (HANDLED_ELSEWHERE[f]) return;
    var v = bound[f];
    if (v && v.type === 'VARIABLE_ALIAS') {
      addVar(v.id, withBase(base, { kind: 'field', field: f }));
    }
  });

  // Variable modes picked on a frame (the "Apply variable mode" menu).
  // A mode from a dead collection is the ghost designers see listed under
  // "Used variables" long after everything else has been removed.
  var modes = node.explicitVariableModes;
  if (modes) {
    Object.keys(modes).forEach(function (collectionId) {
      addMode(collectionId, withBase(base, { kind: 'mode', collectionId: collectionId }));
    });
  }
}

// Visits every layer under the given roots, one at a time. We use our own
// stack instead of recursion so very deep files cannot overflow, and we pause
// every few hundred layers so Figma stays responsive and the window can show
// progress.
async function walk(roots, pageId, visit, counter) {
  var stack = roots.slice();
  while (stack.length) {
    var node = stack.pop();
    visit(node, pageId);
    counter.n++;
    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) stack.push(node.children[i]);
    }
    if (counter.n % 400 === 0) {
      send({ type: 'progress', text: 'Scanned ' + counter.n + ' layers…' });
      await tick();
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: decide which bindings are ghosts
// ---------------------------------------------------------------------------

async function classifyCollection(collectionId) {
  var col = await getCollection(collectionId);
  if (!col) {
    return { status: STATUS.MISSING, collection: 'Deleted collection', library: 'Not found' };
  }
  if (!col.remote) {
    return { status: STATUS.LOCAL, collection: col.name, library: 'This file' };
  }
  if (!enabledLibraries) {
    return { status: STATUS.UNKNOWN, collection: col.name, library: 'Could not check libraries' };
  }
  if (enabledLibraries.has(col.key)) {
    return { status: STATUS.LIBRARY, collection: col.name, library: enabledLibraries.get(col.key) };
  }
  return { status: STATUS.ORPHANED, collection: col.name, library: 'Library not enabled in this file' };
}

async function classifyVariable(variableId) {
  var v = await getVariable(variableId);
  if (!v) {
    return {
      status: STATUS.MISSING, name: 'Deleted variable', type: '',
      collection: 'Unknown', library: 'Not found'
    };
  }
  var c = await classifyCollection(v.variableCollectionId);
  return {
    status: v.remote ? c.status : STATUS.LOCAL,
    name: v.name,
    type: v.resolvedType,
    collection: c.collection,
    library: c.library
  };
}

// ---------------------------------------------------------------------------
// Finding a replacement for each ghost (used by Reconnect)
// ---------------------------------------------------------------------------

// Lists every variable and collection the file can use right now: its own
// local ones and those in enabled libraries. Variables are filed under
// "name|type" (a colour can only replace a colour), collections under name.
async function buildMatchIndex() {
  var vars = new Map();
  var cols = new Map();
  function add(map, key, candidate) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(candidate);
  }

  try {
    var localCols = await figma.variables.getLocalVariableCollectionsAsync();
    var colNames = new Map();
    localCols.forEach(function (c) {
      colNames.set(c.id, c.name);
      add(cols, c.name, { source: 'local', id: c.id, name: c.name, collection: c.name, library: 'This file' });
    });
    var localVars = await figma.variables.getLocalVariablesAsync();
    localVars.forEach(function (v) {
      var colName = colNames.get(v.variableCollectionId) || '';
      add(vars, v.name + '|' + v.resolvedType,
        { source: 'local', id: v.id, name: v.name, collection: colName, library: 'This file' });
    });
  } catch (e) { /* no local variables we can read: carry on with libraries */ }

  for (var i = 0; i < enabledLibraryCollections.length; i++) {
    var c = enabledLibraryCollections[i];
    add(cols, c.name, { source: 'library', key: c.key, name: c.name, collection: c.name, library: c.libraryName });
    var libVars = [];
    try { libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key); } catch (e) { libVars = []; }
    libVars.forEach(function (v) {
      add(vars, v.name + '|' + v.resolvedType,
        { source: 'library', key: v.key, name: v.name, collection: c.name, library: c.libraryName });
    });
  }
  return { vars: vars, cols: cols };
}

// One candidate is a match. With several, we only pick one if exactly one
// sits in a collection with the same name as the ghost's; otherwise it is
// ambiguous and we leave the choice to the designer (detach or fix by hand).
function pickMatch(candidates, collectionName) {
  if (!candidates || !candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  var same = candidates.filter(function (c) { return c.collection === collectionName; });
  return same.length === 1 ? same[0] : null;
}

function isHealthy(status) {
  return status === STATUS.LOCAL || status === STATUS.LIBRARY;
}

async function scan(scope) {
  variableCache.clear();
  collectionCache.clear();
  send({ type: 'progress', text: 'Checking which libraries this file uses…' });
  enabledLibraries = await loadEnabledLibraries();

  var pages;
  if (scope === 'document') {
    send({ type: 'progress', text: 'Loading all pages…' });
    await figma.loadAllPagesAsync(); // required before touching other pages
    pages = figma.root.children.slice();
  } else {
    pages = [figma.currentPage];
  }

  if (scope === 'selection' && figma.currentPage.selection.length === 0) {
    send({ type: 'error', text: 'Select some layers first, or switch the scope to "This page".' });
    return;
  }

  var varUsages = new Map();  // variableId   -> [usage]
  var modeUsages = new Map(); // collectionId -> [usage]
  function push(map, key, usage) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(usage);
  }
  function visit(node, pageId) {
    collectFromNode(
      node, pageId,
      function (id, u) { push(varUsages, id, u); },
      function (id, u) { push(modeUsages, id, u); }
    );
  }

  var counter = { n: 0 };
  for (var p = 0; p < pages.length; p++) {
    var page = pages[p];
    var roots = scope === 'selection' ? page.selection.slice() : [page];
    await walk(roots, page.id, visit, counter);
  }

  send({ type: 'progress', text: 'Checking ' + (varUsages.size + modeUsages.size) + ' variables and modes…' });

  var groups = new Map();
  var healthy = { local: 0, library: 0 };

  var varIds = Array.from(varUsages.keys());
  for (var i = 0; i < varIds.length; i++) {
    var id = varIds[i];
    var info = await classifyVariable(id);
    if (isHealthy(info.status)) { healthy[info.status]++; continue; }
    groups.set('var:' + id, Object.assign({ key: 'var:' + id, kind: 'variable', id: id }, info, {
      usages: varUsages.get(id)
    }));
  }

  var colIds = Array.from(modeUsages.keys());
  for (var j = 0; j < colIds.length; j++) {
    var cid = colIds[j];
    var cinfo = await classifyCollection(cid);
    if (isHealthy(cinfo.status)) continue;
    groups.set('mode:' + cid, {
      key: 'mode:' + cid, kind: 'mode', id: cid, status: cinfo.status,
      name: 'Variable mode: ' + cinfo.collection, type: 'MODE',
      collection: cinfo.collection, library: cinfo.library,
      usages: modeUsages.get(cid)
    });
  }

  // Look for a same-named replacement for each ghost we know the name of.
  // A deleted variable or collection has no name left, so it cannot match.
  var nameable = Array.from(groups.values()).filter(function (g) { return g.status !== STATUS.MISSING; });
  if (nameable.length) {
    send({ type: 'progress', text: 'Looking for replacements in this file and its libraries…' });
    var index = await buildMatchIndex();
    nameable.forEach(function (g) {
      g.match = g.kind === 'variable'
        ? pickMatch(index.vars.get(g.name + '|' + g.type), g.collection)
        : pickMatch(index.cols.get(g.collection), g.collection);
    });
  }

  lastScan = { scope: scope, groups: groups };

  // The window only needs a summary of each ghost, not every usage.
  var summary = Array.from(groups.values()).map(function (g) {
    var layers = new Set(g.usages.map(function (u) { return u.nodeId; }));
    var pagesUsed = new Set(g.usages.map(function (u) { return u.pageId; }));
    return {
      key: g.key, kind: g.kind, id: g.id, status: g.status, name: g.name, type: g.type,
      collection: g.collection, library: g.library,
      bindings: g.usages.length, layers: layers.size, pages: pagesUsed.size,
      match: g.match ? { name: g.match.name, collection: g.match.collection, library: g.match.library } : null
    };
  });

  send({
    type: 'results',
    scope: scope,
    groups: summary,
    scannedLayers: counter.n,
    healthy: healthy,
    librariesChecked: enabledLibraries !== null
  });
}

// ---------------------------------------------------------------------------
// Step 4: fix the ghosts, either by detaching or by reconnecting
// ---------------------------------------------------------------------------

var loadedFonts = new Set();
async function loadFontsFor(textNode) {
  var len = textNode.characters.length;
  if (len === 0) return;
  var fonts = textNode.getRangeAllFontNames(0, len);
  for (var i = 0; i < fonts.length; i++) {
    var key = fonts[i].family + '|' + fonts[i].style;
    if (loadedFonts.has(key)) continue;
    await figma.loadFontAsync(fonts[i]); // Figma refuses text edits until fonts load
    loadedFonts.add(key);
  }
}

// Returns a copy of `paint` with its colour (or one gradient stop's colour)
// bound to `variable`, or unbound when `variable` is null.
function rebindPaint(paint, u, variable) {
  if (u.stop === undefined) {
    return figma.variables.setBoundVariableForPaint(paint, 'color', variable);
  }
  // Figma has no helper for gradient stops, so we rebuild the stop list.
  // Each stop keeps its current colour; only the link changes.
  var stops = paint.gradientStops.map(function (s) { return Object.assign({}, s); });
  var stop = stops[u.stop];
  if (!stop) throw new Error('Gradient changed since the scan');
  if (variable) stop.boundVariables = { color: figma.variables.createVariableAlias(variable) };
  else delete stop.boundVariables;
  return Object.assign({}, paint, { gradientStops: stops });
}

// Changes ONE binding. With `variable` = null this detaches: passing null is
// how the Figma API says "unbind", and the property keeps its current value.
// With a variable it rebinds to that variable instead (used by Reconnect).
async function applyUsage(u, variable) {
  var node = await figma.getNodeByIdAsync(u.nodeId);
  if (!node || node.removed) throw new Error('Layer no longer exists');

  switch (u.kind) {
    case 'field':
      node.setBoundVariable(u.field, variable);
      return;

    case 'paint': {
      var paints = node[u.field].slice();
      paints[u.index] = rebindPaint(paints[u.index], u, variable);
      node[u.field] = paints;
      return;
    }

    case 'effect': {
      var effects = node.effects.slice();
      effects[u.index] = figma.variables.setBoundVariableForEffect(effects[u.index], u.field, variable);
      node.effects = effects;
      return;
    }

    case 'grid': {
      var grids = node.layoutGrids.slice();
      grids[u.index] = figma.variables.setBoundVariableForLayoutGrid(grids[u.index], u.field, variable);
      node.layoutGrids = grids;
      return;
    }

    case 'textRange':
      await loadFontsFor(node);
      node.setRangeBoundVariable(u.start, u.end, u.field, variable);
      return;

    case 'textPaint': {
      await loadFontsFor(node);
      var fills = node.getRangeFills(u.start, u.end);
      if (!Array.isArray(fills)) throw new Error('Text fills changed since the scan');
      fills = fills.slice();
      fills[u.index] = rebindPaint(fills[u.index], u, variable);
      node.setRangeFills(u.start, u.end, fills);
      return;
    }

    case 'mode': {
      var col = await getCollection(u.collectionId);
      // Newer API takes the collection; for a deleted collection we only
      // have its id, which the older form of the call accepts.
      node.clearExplicitVariableModeForCollection(col || u.collectionId);
      return;
    }

    default:
      throw new Error('Unknown binding type: ' + u.kind);
  }
}

// Reconnecting a variable mode: the frame was set to, say, "Dark" in the dead
// collection, so we set it to the mode called "Dark" in the new collection.
async function reconnectMode(u, newCollection) {
  var node = await figma.getNodeByIdAsync(u.nodeId);
  if (!node || node.removed) throw new Error('Layer no longer exists');
  var oldCol = await getCollection(u.collectionId);
  var oldModeId = (node.explicitVariableModes || {})[u.collectionId];
  var oldMode = oldCol && oldCol.modes.find(function (m) { return m.modeId === oldModeId; });
  if (!oldMode) throw new Error('Could not read the old mode name');
  var newMode = newCollection.modes.find(function (m) { return m.name === oldMode.name; });
  if (!newMode) throw new Error('No mode called "' + oldMode.name + '" in ' + newCollection.name);
  // Set the new mode first, so a failure leaves the layer as it was.
  node.setExplicitVariableModeForCollection(newCollection, newMode.modeId);
  node.clearExplicitVariableModeForCollection(oldCol);
}

// Turns a scan-time match into the real variable or collection to link to.
// Library variables have to be imported into the file before they can be used.
async function resolveTarget(group) {
  var m = group.match;
  if (group.kind === 'variable') {
    var v = m.source === 'local'
      ? await figma.variables.getVariableByIdAsync(m.id)
      : await figma.variables.importVariableByKeyAsync(m.key);
    if (!v) throw new Error('Could not load ' + m.name);
    return v;
  }
  if (m.source === 'local') {
    var col = await figma.variables.getVariableCollectionByIdAsync(m.id);
    if (!col) throw new Error('Could not load ' + m.name);
    return col;
  }
  // A library collection can only be reached through one of its variables.
  var libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(m.key);
  if (!libVars.length) throw new Error(m.name + ' has no variables to import');
  var first = await figma.variables.importVariableByKeyAsync(libVars[0].key);
  var imported = await figma.variables.getVariableCollectionByIdAsync(first.variableCollectionId);
  if (!imported) throw new Error('Could not load ' + m.name);
  return imported;
}

// action is 'detach' or 'reconnect'. Reconnect only touches ghosts that
// found a match during the scan; the rest are left alone.
async function fix(keys, action) {
  var done = 0;
  var failed = 0;
  var reasons = new Map();
  function fail(e, count) {
    failed += count;
    var msg = (e && e.message) ? e.message : String(e);
    reasons.set(msg, (reasons.get(msg) || 0) + count);
  }

  var groups = keys
    .map(function (k) { return lastScan.groups.get(k); })
    .filter(function (g) { return g && (action === 'detach' || g.match); });
  var total = groups.reduce(function (s, g) { return s + g.usages.length; }, 0);

  for (var i = 0; i < groups.length; i++) {
    var group = groups[i];
    var target = null;
    if (action === 'reconnect') {
      try { target = await resolveTarget(group); } catch (e) { fail(e, group.usages.length); continue; }
    }
    for (var j = 0; j < group.usages.length; j++) {
      var u = group.usages[j];
      try {
        if (action === 'reconnect' && group.kind === 'mode') await reconnectMode(u, target);
        else await applyUsage(u, target);
        done++;
      } catch (e) {
        fail(e, 1);
      }
      if ((done + failed) % 100 === 0) {
        send({ type: 'progress', text: (action === 'reconnect' ? 'Reconnected ' : 'Detached ') + (done + failed) + ' of ' + total + '…' });
        await tick();
      }
    }
  }

  // Groups every change above into a single step, so one Cmd/Ctrl+Z undoes it.
  figma.commitUndo();

  figma.notify(
    (action === 'reconnect' ? 'Reconnected ' : 'Detached ') + done + ' ghost binding' + (done === 1 ? '' : 's') +
    (failed ? ' · ' + failed + ' could not be changed' : '')
  );

  send({
    type: 'cleaned',
    action: action,
    done: done,
    failed: failed,
    reasons: Array.from(reasons.entries()).map(function (e) { return { reason: e[0], count: e[1] }; })
  });

  // Scan again so the list reflects what is left.
  await scan(lastScan.scope);
}

// ---------------------------------------------------------------------------
// "Show layers": select every layer that uses a ghost so the designer can
// see it before deciding to clean it.
// ---------------------------------------------------------------------------

async function showLayers(key) {
  var group = lastScan.groups.get(key);
  if (!group) return;

  var byPage = new Map();
  group.usages.forEach(function (u) {
    if (!byPage.has(u.pageId)) byPage.set(u.pageId, new Set());
    byPage.get(u.pageId).add(u.nodeId);
  });

  // Prefer the page the designer is already on.
  var pageId = byPage.has(figma.currentPage.id) ? figma.currentPage.id : byPage.keys().next().value;
  var page = await figma.getNodeByIdAsync(pageId);
  if (!page) return;
  if (page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);

  var nodes = [];
  var ids = Array.from(byPage.get(pageId));
  for (var i = 0; i < ids.length; i++) {
    var n = await figma.getNodeByIdAsync(ids[i]);
    if (n && !n.removed && n.type !== 'PAGE') nodes.push(n);
  }
  figma.currentPage.selection = nodes;
  if (nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);

  var otherPages = byPage.size - 1;
  figma.notify(
    'Selected ' + nodes.length + ' layer' + (nodes.length === 1 ? '' : 's') + ' on "' + page.name + '"' +
    (otherPages > 0 ? ' · also used on ' + otherPages + ' other page' + (otherPages === 1 ? '' : 's') : '')
  );
}

// ---------------------------------------------------------------------------
// Messages from the window
// ---------------------------------------------------------------------------

figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === 'scan') await scan(msg.scope);
    else if (msg.type === 'show') await showLayers(msg.key);
    else if (msg.type === 'clean') await fix(msg.keys, 'detach');
    else if (msg.type === 'reconnect') await fix(msg.keys, 'reconnect');
    else if (msg.type === 'close') figma.closePlugin();
  } catch (e) {
    send({ type: 'error', text: (e && e.message) ? e.message : String(e) });
  }
};
