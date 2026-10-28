# Objects and scopes

Every import, variable, computed value and record is global today. This record weighs a model
of objects for the things the HMI controls, and of state kept where it is used. The clickable
mockups are in [objects/](objects/index.html), served by any static server from that folder.

## The problem, measured

On the cage project (`scratch/classic`):

- 22 imports in one flat list, grouped only by invented prefixes such as `CageMonitorVideo`.
- 6 variables, all read on the Overview page, offered by completion on every page.
- 29 names in every completion.
- The horn pulse on `SafetyCmd.chirp` written by hand in 3 handlers, since pages write
  `SafetyCmd` directly.

## The model

### Objects

- One object per thing controlled, one instance each for the whole HMI.
- Members: mesh entities (read, write, send, call), state, computed values, records,
  functions and logic. Logic and functions run on the system.
- An object has an optional mesh root. Mesh members keep paths from it, so one line points
  the object at another machine.
- Pages see the interface. A member marked inside is read only by the object's own code:
  Safety keeps `Cmd` inside and offers `stop()`, `reset()` and `chirp()`.
- Read as `Robot.State.servo_power`, `await Robot.run(job)`. Inside, bare: `State.start`.
- Mesh members keep PascalCase and their kind colours, local members camelCase and blue, as
  settled for imports and local things.

### State where it is used

- The page, any element, and each copy of a repeat keep state, as a component does today.
- Code reads bare names, nearest first: the event, the copy, each holding element, the page,
  the objects, the library.
- A component still stops at its own edge.
- Where a value lives decides who reads it. How it is kept is a separate choice: each
  screen, all screens, each opening, and kept across restarts with all screens. This builds
  the 2026-10-19 decision that scope is lexical and sharing separate.

### Rules

- A move that would hide a value from a reader is refused, naming the reader.
- A rename follows every reference.
- Logic is never read by name and never shows in completion.

### Files

Pages keep `<var>` in the element that keeps it, the tag a component already uses:

```html
<div id="e1" name="Robot panel">
  <Toggle id="e21" name="Servos" value="Robot.State.servo_power">
    <var name="servoPending" start="false"/>
```

Objects go in `objects/<name>.html` in the same format, or in their own syntax (design 3).

## Options weighed

| Design | Idea | For | Against |
| --- | --- | --- | --- |
| 1 Objects and panels | An Objects tab replaces Data. Any layer has a State section. | One clear home per machine. | Two places to look. |
| 2 One tree | Objects, pages, layers and values in one tree. Drag to move. The canvas outlines where a value lives and who reads it. | Scope is visible. Data only hides the rest. | Long on a big project. |
| 3 Object files | A short syntax per object (`read`, `send`, `call`, `var`, `fn`, `on`, `inside`). Pages keep `<var>`. | Fast to write and diff, good for an AI. | A second syntax. |
| 4 Made where used | Type a new name, pick where to keep it. Tidy up suggests objects from mesh paths and scopes from readers. | Least to see, migrates today's projects. | The model is never laid out whole. |

Considered and not mocked:

- Stores imported by name into each page, as in web frameworks. Rejected: lexical scope
  already says who sees what, and imports add a list to keep.
- A frame that hands an object down to what it holds. Kept as a later idea, close to letting
  a component take an object.
- Types with several instances. The model allows it: an object is a type with one instance.

## Decisions

The user's, on 2026-10-27:

- Design 1 is the base.
- Pages sit in the layers tree as its top nodes, with no separate page list.
- Design shows every page at once on one board, panned and zoomed, so moving between pages
  is moving in 2D. A page clicked in the tree is flown to. The wheel still zooms, as it always
  has: the mockup's wheel scroll was Claude's, and the user kept zoom.
- The tree does not list values. It marks what keeps state, what repeats and what has
  handlers.
- The Pages see it switch confused: its label and the text beside it disagreed when off. It
  is now Visibility, Global or Local, the chosen button being the state, each with a tooltip
  saying who reads it. It sits right after Intent (Read or Write), as public and private
  access control does.
- Fewer hint sentences everywhere.
- A page row is a band of its own in the tree, pinned while its layers scroll.
- The layers tree and the mesh tree start collapsed. Selecting on the board opens the tree
  down to the selection.
- The mesh tree marks no folder with an object, since an object's members may come from
  anywhere. An entity row still names the member it is.

Still proposed by Claude, not yet answered:

- design 4's create where typed and Tidy up inside Design,
- design 2's canvas outline of where a value lives,
- objects stored in the HTML like format, so the project keeps one format.

## Build plan

In the worktree `objects-app`, in steps the user reviews. The user approved steps 1 and 2
before a review, on 2026-10-27.

1. Design board and one layers tree: pages as the tree's top rows, banded, starting
   collapsed, rows marked for state, repeat and handlers. Every page side by side on one
   board that pans and zooms, Fit, a page clicked in the tree flown to. Editor only.
2. State on pages and elements: `<var>` on a page or any element, kept for each screen, each
   copy of a repeat, or all screens. The engine and the screens read the nearest first. The
   inspector's State section, completion nearest first, Move to with the reader check.
3. Objects in `objects/<name>.html`, the Objects tab in place of Data, logic inside objects.
   Only `examples/packing-line` is converted by hand. The user converts their own projects.
4. Renames that follow every reference across objects and scopes.

Kept across restarts does not exist yet and waits.

### Step 1 as built

- Every page sits side by side on one board, the open one editable, the others drawn while in
  sight. A component opens alone, as before. The wheel zooms as it always has.
- New: Space with a drag pans, Shift 1 fits every page, a press on another page opens it in
  place, a page's label opens and fits it. Fit fits every page.
- The layers tree holds every page as a pinned band, all folded at first. A pick opens its
  band and frames and scrolls its row into sight. A row dropped into a frame opens it. Rows
  mark a repeat and the events handled.
- The open page keeps its place on screen as pages before it come, go or are renamed.

### Step 2 as built

- State is a `Variable` as the Data tab's (name, start as a JSON literal, `per` each screen or
  every screen), kept in a page's or an element's `state`, written `<var name start>` first
  inside its tag, `per="hmi"` when every screen shares it. A component and what it holds keep
  none, as a component has its own variables.
- The backend keeps it as it keeps variables, under a key no alias can be: `@page/name` or
  `@page/element/name`, then `#index` for each copy of a repeat it sits in, outermost first.
  A screen's fire now names the copy by every index, so nested repeats keep apart.
- A run binds the names its element sees, nearest first, as globals over the project's. The
  screen's scopes do the same, reading the start until a value comes.
- A handler touching only state each screen keeps runs on the screen. Handlers now run in
  their element's own scope, so one inside a repeated frame reads its copy's `index` and `item`.
- Inspector: a State list on the page and on each element: name, Kept (Each screen or Every
  screen), Start, a move button and remove. The tree marks a row or a page band with a count.
- Completion offers the state an element sees first, and a nearer name hides one further out.
- A rename follows what reads it, stopping where something keeps a name of its own. A move is
  refused while something reading it would lose it or would read it in place of another,
  naming that reader. Changing a state's name, start or kept starts its values over.
- Not yet: renaming a page starts its state's values over, as its key changes.

### Step 3 plan

The user's choices on 2026-10-28:

- 3a and 3b are built straight through, stopping once the Objects tab works.
- The Logic tab goes. Logic about a thing lives in its object.
- A built-in object `Hmi`, never removed, holds what is about the HMI itself: the only home of
  logic on a screen connecting or leaving and on the HMI starting, and HMI-wide state such as
  `Hmi.visits`. Timers, conditions and changes may go in any object.
- The Theme moves into the Objects sidebar. Hmi and Theme sit at the top with icons of their
  own, a separator under them, then the user's objects.
- Claude converts `scratch/classic` and `scratch/demo` with a one-off script kept out of the
  codebase, and never commits them.

Objects replace the global imports, variables, records, computed values and the HMI's
handlers, with no second model beside them. In two parts:

3a. Model and engine. `objects/<name>.html` holds an object: its mesh root, its mesh members
   (kind, entity, Intent, Visibility), state, computed values, records, functions with what
   they take, and logic. The backend reads them in place of `data/imports.toml`,
   `variables.toml`, `records.toml`, `computed.toml` and `logic/handlers.html`. Code reads
   `Robot.State.servo_power` and calls `await Robot.run(job)`, an object's own code its members
   bare, Local ones only there. Pages run, complete and check names as before.
   `examples/packing-line` is converted by hand, and the scenarios that set data up move to
   objects.
3b. The Objects tab in place of Data, as design 1 shows: objects and the mesh in the left
   sidebar, a mesh row's + adding a member or making an object, the object's sheet by section,
   the member and object inspectors, Used by.

```html
<object name="Robot" mesh="Cage/Gp12">
  <variable name="State" entity="RobotState"/>
  <topic name="JogJoint" entity="Jog/Joint" intent="write" local="true"/>
  <function name="SetServo" entity="SetServo"/>
  <var name="selectedJob" start='"Home249"' per="hmi"/>
  <computed name="busy" get="State.start"/>
  <fn name="run" takes="job">
    await SetServo(true);
    await RunJob({ job_name: job });
  </fn>
  <on name="Alarm" when="State.alarm">
    log("robot alarm", State.alarm_no[0]);
  </on>
</object>
```

### Step 3 design

- Every member's value is kept under its key, `Robot.State`, which the wire, the engine and
  screens use as they used an alias. An import's entity counts from its object's mesh root,
  or from the mesh's own when it starts with `/`.
- Code outside an object reads `Robot.State` and only Global members. An object's own code,
  its computed values, setters, records, functions and logic, also reads its members bare,
  Local ones too, nearest first: `p`, its own members, then objects, enums, the library.
- A function runs on the system. A call starts a run of it in its object, for the caller's
  screen, and gives back what it returns. It takes the names its `takes` lists.
- Logic is `<on>` as the Logic tab wrote it, ids unique across objects. Start, connects and
  leaves go only in Hmi.
- Objects are edited as the Data tab's lists were, by messages outside undo.
- Members of one object share one space of names. Mesh members are PascalCase, the rest
  camelCase, objects PascalCase.

### Step 3 as built

- `objects/<name>.html` replaces `data/imports.toml`, `variables.toml`, `computed.toml`,
  `records.toml` and `logic/handlers.html`, which nothing reads now. The format is in
  [files.md](../files.md#objects). `Hmi`, its mesh at `Hmi`, is in every project and keeps
  its name.
- The backend keeps the objects and a flat view by key for the wire, the engine and screens.
  A rename of an object or a member follows every reference in objects and pages, its values
  and history going along.
- An object read from outside only reads: a set through it says so. A screen's write of a
  Local member is refused. An object's name hides an enum of that name.
- The Objects tab: the left sidebar holds the objects (Hmi and Theme first) and the mesh, each
  folding by its head and scrolling apart, as the user asked on 2026-10-28. The sheet shows a
  section per kind with each member's value now, a lock for Local, whose value it is and how
  many places name it. Member and object inspectors, Visibility, Used by, Remove refused while
  something names it. A mesh row's + adds it to the open object, a folder's + makes an object
  rooted there. The Data tab's right click items carried over: intent, Reset to its start,
  Remove from a mesh row, Copy the name.
- Design, asked mid build: page and element state are rows with their value now, each
  opening a view of its own with Kept, the value of each copy, Used by, Move to, and Remove
  refused while something reads it.
- Gone with the Logic tab: undo of logic, and its list of the open page's handlers with what
  each reads and writes. Element handlers stay in Design's inspector.
- A new scene's view is its page's state.
- The browser scenarios speak objects: the test client's `import(key, entity)`,
  `setVariable(key, start)` and `setRule(object, id, rule)`, and the Data and Logic scenarios
  became `objects-*`.
- Step 4: renames of objects, members and state already follow every reference. Left from it:
  a page renamed starts its state over, as the state's key holds the page.

## Open for the user

- Several instances of an object type later?
- May a component take an object as an input?
- Should mesh members start inside?
- Is each opening worth a third choice?
- Names with no owner: an object such as Shift, or a small Everywhere list?
