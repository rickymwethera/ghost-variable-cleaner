# Ghost Variable Cleaner

A Figma plugin that finds variables from deleted or disconnected libraries that
are still attached to your layers, and either detaches them without changing
how anything looks or reconnects them to the same-named variables in your
current library.

Version 0.2, October 2026.

---

## The problem it solves

Figma variables are named values (a colour, a spacing size, a font size) that
layers can be linked to. Change the variable and every linked layer updates.

Trouble starts when designs move between files. Copy a card from an old design
system into a new one and the card keeps its links to the **old** variables.
Later the old library gets deleted or switched off, but the links stay. Figma
keeps listing those variables under "Used variables", and there is no good way
to find which layers still hold them. These leftover links are the "ghosts".

Designers have complained about this on Figma's forum for years, in a thread
that runs to at least nine pages. Running Figma's own "Detach deleted
variables" command often reports "0 instances found". When one user asked for a
plugin that finds and removes these leftovers, a Figma staff member said they
could not find one built for it.

## What the plugin does

1. **Scan** a selection, the current page, or every page.
2. **List the ghosts**, grouped by variable, with how many layers use each one.
   Healthy variables (local, or from a library that is still enabled) are
   counted but never listed or touched.
3. **Show layers**: selects every layer using a ghost so you can look before
   you change anything.
4. **Reconnect** (new in 0.2): for each ghost, the scan looks for a variable
   with the same name and type in this file or in an enabled library (for
   example `color/accent` in your new design system). Ghosts with a match say
   "Can reconnect to …". Reconnect links the layers to that variable instead,
   importing it from the library if needed. Frames set to a dead collection's
   mode ("Dark") are switched to the mode with the same name in the new
   collection. Layers then take the new variable's value, which may look
   slightly different if the new library changed it.
5. **Detach**: removes the link. The layer keeps its current colour, size or
   spacing. Use it for ghosts with no match, or when you don't want the new
   library's values.

Each clean-up is one undo step. Both buttons need two clicks, so nothing
changes by accident.

If more than one variable could match a ghost (say two libraries both have
`color/accent`), the plugin only picks one when exactly one sits in a
collection with the same name as the ghost's. Otherwise it suggests nothing,
and you can detach or fix that ghost by hand.

### How it decides what is a ghost

| Label in the plugin | What it means | Ticked by default? |
|---|---|---|
| **Missing** | Figma can no longer find the variable or collection at all. | Yes |
| **Library disconnected** | The variable comes from a library that is not enabled in this file. | Yes |
| **Check library** | The variable comes from a library, but Figma would not tell the plugin which libraries are enabled (for example, no team library access). | No: you decide |

### What it checks on each layer

- Fill and stroke colours, including each stop of a gradient
- Effects: shadow colour, radius, spread, offsets
- Layout grids
- Text, range by range: font family, size, weight, style, line height, letter
  spacing, paragraph spacing, text colour
- Single values: width, height, padding, gap, corner radius, opacity,
  visibility, text content, and anything else Figma allows to be bound
- **Variable modes** set on frames ("Apply variable mode"). A mode from a dead
  collection is often the last thing keeping a ghost in the "Used variables"
  list.

---

## How to try it in Figma

You need the **Figma desktop app** to load a plugin from your computer.

1. Unzip `ghost-variable-cleaner-v0.2.zip` somewhere you will keep it.
2. Open any Figma design file.
3. Main menu → **Plugins → Development → Import plugin from manifest…**
4. Pick `manifest.json` from the unzipped folder.
5. Run it from **Plugins → Development → Ghost Variable Cleaner**.

To test it properly, make a test file with a ghost in it: create a second file
with a variable, publish it as a library, use the variable in your test file,
then unpublish or disable that library. Scan the test file.

---

## The files, and why each one exists

```
ghost-variable-cleaner/
├── manifest.json     The plugin's ID card
├── code.js           The logic: scans and edits the document
├── ui.html           The window you see and click
├── test/mock-test.js A fake Figma file used to test code.js
└── README.md         This file
```

### `manifest.json`

Tells Figma the plugin's name, which file holds the logic, which holds the
window, and what it is allowed to do.

- `"documentAccess": "dynamic-page"`: Figma requires this for new plugins. It
  means pages load only when needed, which is why the code calls
  `figma.loadAllPagesAsync()` before scanning every page.
- `"permissions": ["teamlibrary"]`: lets the plugin ask which libraries are
  enabled in the file. Without it, we could not tell a disconnected library
  from a healthy one.
- `"networkAccess": "none"`: the plugin never sends anything anywhere. Design
  teams at companies care about this, and it makes review easier.

### `code.js`

Runs inside Figma's sandbox. It can read and change the document but has no
window of its own. It works in four steps:

1. **Walk the layers.** It visits every layer in the chosen scope using its
   own list instead of recursion, so very deep files cannot crash it. Every 400
   layers it pauses briefly so Figma does not freeze and the window can show
   progress.
2. **Record every binding.** For each layer, `collectFromNode` notes exactly
   where each variable is attached: which property, which paint in a list, which
   character range of a text layer. Recording the exact spot is what makes the
   later clean-up precise.
3. **Classify.** Each variable is looked up once and the answer is cached,
   because the same variable is usually linked to hundreds of layers. Its
   collection is then checked against the list of enabled libraries.
4. **Detach.** For each binding, it calls Figma's "unbind" form of the API by
   passing `null` instead of a variable. Figma then keeps the value the layer
   currently shows. Text needs its fonts loaded before Figma allows edits, so
   the code loads them first. At the end, `figma.commitUndo()` groups
   everything into one undo step.
5. **Reconnect.** `buildMatchIndex` lists every variable the file can use
   (local ones, plus those in enabled libraries via
   `figma.teamLibrary.getVariablesInLibraryCollectionAsync`) under
   "name|type", and `pickMatch` chooses one per ghost. When you press
   Reconnect, the chosen library variable is imported with
   `figma.variables.importVariableByKeyAsync`, and the same code that detaches
   (`applyUsage`) is called with that variable instead of `null`, which
   rebinds instead of unbinding. Modes are matched by collection name and then
   by mode name.

Anything that cannot be changed (a locked instance override, a missing font) is
counted and reported, not allowed to stop the rest.

### `ui.html`

An ordinary web page shown inside Figma. It cannot touch the document; it sends
requests to `code.js` (`scan`, `show`, `clean`, `reconnect`) and draws what comes back
(`progress`, `results`, `cleaned`, `error`).

Design choices:

- **Nothing changes until you ask.** Scan only reads.
- **Two-click detach and reconnect.** The first click arms the button and
  turns it red; the second runs it. This guards against accidental clicks without a pop-up.
- **Uses Figma's own theme colours**, so it looks native in light and dark mode.

### `test/mock-test.js`

There is no way to run a Figma plugin outside Figma, so this file builds a fake
Figma file in memory and runs `code.js` against it. The fake file has a local
variable and a healthy library variable (which must be ignored), an old
library "DS v1" that is no longer enabled, a new library "DS v2" with some
same-named variables, a deleted variable, and frames set to dead modes. It
checks 45 things, including that:

- exactly the six ghosts are found, across fills, strokes, effects, a gradient
  stop, padding, text and modes, on two pages;
- the right replacements are suggested, and none for deleted variables or
  ambiguous names;
- Reconnect rebinds only matched ghosts, switches "Dark" to the new "Dark",
  and leaves everything else alone;
- Detach keeps every colour and value, including gradient stops;
- every clean-up is one undo step, and a scan changes nothing;
- without library access, library variables are marked "Check library".

Run it with Node.js after any change to `code.js`:

```
node test/mock-test.js code.js
```

---

## Known limits of v0.2

- **Not yet run in real Figma.** Everything above is checked against a
  simulated file only. Reconnect in particular uses library calls that need a
  real team library to confirm.
- **Styles are not covered yet.** Colour, text and effect styles from dead
  libraries are a related problem.
- **Component property bindings** on instances are not touched, because
  unbinding them means rewriting the instance's properties.
- **Deleted variables can't be reconnected**: Figma no longer knows their
  name, so there is nothing to match on. They can only be detached.

## Roadmap

1. Test in real files; fix whatever breaks.
2. Add styles from dead libraries, then component properties.
3. Publish free on the Figma Community, collect feedback from the forum thread
   and r/FigmaDesign.
4. Put Reconnect behind a Pro licence key, sold through a payment provider
   that works from Kenya.
