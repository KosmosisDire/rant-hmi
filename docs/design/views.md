# Pages inside pages

Asked 2026-11-11. Two needs, in the user's words: a page that switches between panels by a
selected view, and chrome built once and shown on many pages, each page still edited and built
on its own. The user proposed pages loaded into a viewport of another page, nested as deep as
needed, and asked what that does not allow or makes harder, naming one case: a page without
the chrome. The other idea they named was an element told to show on several pages, the chrome
then set to show on all.

## What there is today

- **Panels.** The user's HMI keeps its View well's panels in one page, each hidden by
  `repeat="viewSource == "X" ? 1 : 0"`. Since 2026-11-11 `visible` does it properly: a hidden
  panel draws nothing, reads nothing and takes no room. But every panel still sits in one file,
  stacked on one spot of the board, and only one is ever seen there.
- **Chrome.** Each page draws its own. On the packing line, Overview has a Header (title,
  lamps, mode, clock, Camera and Settings buttons) and Camera a title row with a Back button.
  A change to the header is made on every page.
- **A component** can hold the header, placed once per page. Each page still places it and
  leaves room for it, and its state starts over on each page, so a selected tab or an open menu
  forgets itself as the operator moves.
- **Navigation** is a stack per screen in `client/src/state/stack.ts`: `open(Pages.X)` pushes,
  `close(answer)` and Escape pop, an open page opened again is gone back to, and on `/run` the
  browser's back and forward walk it. `hmi.toml` names the `start` page. A page with
  `shows="over"` floats over the one beneath as a dialog.

## Two cases to test every option on

1. **Packing line chrome.** A Shell of header and nav around Overview, Camera and Trends. The
   operator moves between them, the header's state (mode, a selected nav button) stays, and
   Back goes to the page before. A Kiosk page for a wall screen shows without the header.
2. **The View well.** A card on Overview whose content is Camera, Twin or Plot by `viewSource`.
   Each panel is edited at its own size, on its own.

## Options for the chrome

### A. A shell with state

The screen opens a Shell page. It holds a `<view page="section"/>`, and the nav sets a var:
`section = Pages.Camera`.

- One new thing, the view, which also does the View well.
- `open()` still opens a whole page, so `open(Pages.Camera)` shows Camera without the shell.
  Two ways to go to a page, which give different screens.
- Moving between sections is not navigation: no Back, no browser history, no link to Camera.
  `start` names the Shell, and which section shows first is the var's `start`.
- A page without the chrome: open it, as today.
- The board shows content pages alone, so a designer never sees Camera with its header except
  by looking at the Shell.

### B. Elements shown on many pages

An element is marked to show on a list of pages, or on all.

- Navigation unchanged.
- The shared element needs a home: a page it belongs to, or a layer of its own outside every
  page. Neither is a file the user can open and edit alone.
- Pages are not all one size, so a header placed at `x=1 y=1 w=126` is wrong on a dialog or a
  wall screen. Each page leaves room for it by hand, and a taller header means editing every
  page.
- A page without the chrome: every shared element lists it as an exception, or lists every
  other page.
- It does not do the View well, which stays `visible`.
- It is the one option where a page adds its own buttons to the header easily: the page holds
  them.

### C. A page names its frame (recommended)

A page says which page frames it: `<page name="Camera" frame="Shell">`. The Shell is an
ordinary page holding one empty `<view/>`, where the page it frames goes.

- **Navigation unchanged.** `open(Pages.Camera)` shows the Shell with Camera in its view.
  Back, history, links, `start` and dialogs work as now. Opening another page of the same frame
  keeps the frame drawn, so its state stays.
- **A page without the chrome** leaves `frame` out.
- **Nesting.** A frame may name a frame: Camera in Cell, Cell in Shell.
- **The frame knows what it holds.** It reads the page in its view, so a nav button lights by
  `framed == Pages.Camera`.
- **Each page is its own file**, and the board draws it in its frame, so a designer sees what
  the operator sees.
- It costs one attribute and one meaning of the empty view, beyond A.

### The user on the mockup (2026-11-11)

- Likes A: the frame brings the content, and a page could be edited where the shell shows it.
- Dislikes C's board drawing a page inside its frame: it puts the outer page into the inner
  page's definition, when the inner page should not depend on what holds it. Naming the frame
  from inside inverts the natural way to think of it.
- Likes C's unique path per page, and asked whether A could give each shown set of pages its
  own path, for links and history.

### D. Views that navigate (Claude's answer to that)

A, with a view that holds its own page instead of following an expression, so the shown pages
can be written in an address and set again from one.

```html
<view id="e10" name="Content" x="1" y="9" w="126" h="62" start="Pages.Overview"/>
```

- `Content.open(Pages.Camera)` shows Camera there, and `Content.page == Pages.Camera` lights
  a nav button. `open()` in a page shown in a view opens in that view, as a link in a frame
  does, so a page never needs to know what holds it.
- The address is the path of pages through views: `/run/shell/camera`, or `/run/shell/cell/camera`
  nested. A link sets each view on the way. One history for the screen: Back and Escape undo
  the last change of any view.
- `/run/camera` is Camera with no chrome. Kiosk needs nothing special.
- A view with `page=` an expression, as the View well, follows its state and is not in the
  address.
- Dialogs, `shows="over"`, still cover the whole screen.
- Two showings of one page keep separate state, the user's call. Page state is kept per screen
  under `@page/name` today, so its key gains the views it is shown through. `per="hmi"` stays
  one value everywhere, the way to share on purpose.

### Paths

What is shown is a tree: a page holds views, each showing a page. A URL path is a line, so a
path alone writes a chain and needs something more once a page has two views that navigate.

Shapes tried, Shell's views named Content and Side, Cell's Station:

| Shown | Chain | Named views | Brackets | Query when ambiguous |
| --- | --- | --- | --- | --- |
| Kiosk alone | `/kiosk` | `/kiosk` | `/kiosk` | `/kiosk` |
| Shell, Camera in Content | `/shell/camera` | `/shell/content=camera` | `/shell/camera` | `/shell/camera` |
| Shell, Cell, Camera | `/shell/cell/camera` | `/shell/content=cell/content.station=camera` | `/shell/cell/camera` | `/shell/cell/camera` |
| Shell, Camera and Alarms in Side | not possible | `/shell/content=camera/side=alarms` | `/shell(content:camera,side:alarms)` | `/shell?content=camera&side=alarms` |
| Same, Cell and Camera in Content | not possible | `/shell/content=cell/content.station=camera/side=alarms` | `/shell(content:cell/camera,side:alarms)` | `/shell?content=cell/camera&side=alarms` |
| Trends in Left and Right | not possible | `/shell/left=trends/right=trends` | `/shell(left:trends,right:trends)` | `/shell?left=trends&right=trends` |

- **Chain**: a page has at most one view that navigates. Others follow an expression and are not
  in the address. Shortest, but a second navigating region can never be linked.
- **Named views**: every navigating view by its name, nested names joined by dots. One rule
  for every shape, any order typed, and adding a view to Shell never changes an old link.
  Longer, and view names show in the address.
- **Brackets**: a chain until it branches. Exact, but brackets in a URL are hard to type.
- **Query when ambiguous**: adding Side to Shell turns every `/shell/camera` link into
  `/shell?content=camera`, so old links break.
- The user (2026-11-11): what is shown must be in the address bar, to share a screen in that
  state. Named views are a query in another syntax, so a query. But a page with one view stays
  a plain path, and the query starts only at the level where a page has several.

#### The rule, as the user asked

Walk down from the open page. While a page has one view that navigates, the page it shows is the
next path segment. At a page with several, each view becomes a query key by its name, and its
value is the chain below it, again a path while it stays single. A page with several views
further down is a key of the names of the views that branched above it, joined by dots. Views
that follow an expression, as the View well, never count. Views at their `start` page are left
out from the end.

Shell has `main`, Shell2 `main` and `side`, Cell `station`, Split `left` and `right`:

| Shown | Address |
| --- | --- |
| Kiosk alone | `/run/kiosk` |
| Shell, Overview at start | `/run/shell` |
| Shell, Camera | `/run/shell/camera` |
| Shell, Cell, Camera | `/run/shell/cell/camera` |
| Shell, Split, Trends and Camera | `/run/shell/split?left=trends&right=camera` |
| Shell, Cell, Split, Trends and Camera | `/run/shell/cell/split?left=trends&right=camera` |
| Shell2, Camera and Alarms | `/run/shell2?main=camera&side=alarms` |
| Shell2, side at start | `/run/shell2?main=camera` |
| Shell2, Cell and Camera in main, Alarms | `/run/shell2?main=cell/camera&side=alarms` |
| Shell2, Split in main, Alarms | `/run/shell2?main=split&main.left=trends&main.right=camera&side=alarms` |
| Shell2, Cell then Split in main, Alarms | `/run/shell2?main=cell/split&main.left=trends&main.right=camera&side=alarms` |
| Split, Trends twice | `/run/split?left=trends&right=trends` |

- A URL keeps every one of these as typed, the slash inside a query value too.
- Each shown set has one address, and reading it back finds each page's view with no guess.
- The cost: a page gaining a second view turns `/run/shell/camera` into
  `/run/shell?main=camera`. Proposed softening: the query form is read at every level, so
  `/run/shell?main=camera` works while Shell has one view, and the address bar then shows the
  path. A link made after the change keeps working, an older path link to a page that has
  since gained a view opens what it can and raises a problem for the rest.
- A name is written in small letters with `-` for a space, as `main-content`, the way a page is
  written by its file name.
- In every shape a view showing its `start` page may be left out: `/shell` is Shell with
  Overview. A link then follows a changed `start`, as `hmi.toml`'s does today.

### Run on its own port

The user (2026-11-11): screens on a port of their own, so a port forwarded for screens never
reaches the editor, and addresses lose `/run`: `http://host:6738/shell/camera`.

- Today both share one port, one `/ws` and one client, and `authorize.rs` allows every message.
  A screen's socket could send edits however it was reached, so a second port is a boundary
  only if the backend knows which port a screen came in on and refuses there all but what a
  run does: reads, handler fires, writes its pages may make, `/files`, `/bulk`.
- The screens' port: its own WebTransport on its UDP number, its own TLS. `/app`, `/problems`
  and `/probe` stay on the editor's.
- The editor's Run tab and run board stay on the editor's port.
- It is no login: anyone who reaches the editor's port still edits.
- Open: which keeps 6739. Screens and native apps made with `runs=screen` know `host:6739/run`
  today, and the port block names 6739 the HMI designer, the next down being 6738. Also whether
  the screens' port serves a client built without the editor, smaller for panel PCs.

### Editing a page where it is shown

- Allowed under A and D: the view shows the page's own file, so an edit there is the same edit
  as on its own artboard. There is no override, unlike a component instance.
- On the board the view shows its `start` page, and a chip on it picks another to see and edit.
  Double click into the view edits that page there, the outer page dimmed meanwhile.
- Open: whether an element may be dragged across the view's edge, which moves it to the other
  file.

## The view element

The View well needs a page drawn inside part of another page, chosen by code. The same element
is C's slot:

```html
<view id="e7" name="Well" x="42" y="40" w="44" h="30" page='viewSource == "Twin" ? Pages.Twin : Pages.Camera'/>
```

- `page` takes any expression giving a page, as `open()` does. Left out, the view is where the
  pages this page frames go.
- Only the page shown is drawn, so a hidden camera streams nothing.
- The page it shows runs as it would alone: its own state and handlers, the objects. It reads
  nothing of the page around it. What both need lives in an object.
- A page that would show itself, through any depth, draws an error box in its place.

## Open, for the user

Nothing is decided yet. Claude proposes one element, `view`, for both cases, with whole panels
swapped by a view and small things hidden by `visible`.

1. **Chrome:** A, B or C. Claude recommends C.
2. **Board:** a framed page drawn inside its frame, the frame dimmed and not editable from
   there, or drawn alone with its frame's name above it.
3. **Size:** a page in a view laid out at the view's size, as a component with `sizing="fill"`,
   or scaled whole into it, as `sizing="scale"`. A framed page could take its size from its
   frame's view and give up its own `size`.
4. **Content in the chrome:** a page putting a title or its own buttons into the header. Under
   C the frame can read `framed.name` at once. More than that needs named views a page fills,
   which can wait.
5. **The name** the frame reads its page by: `framed` is a placeholder.
6. **Phone:** a framed page on an upright screen, frame and page reflowed together or each on
   its own.

## Building it

The user chose D on 2026-11-11 and said to start, keeping `/run` and leaving the port split for
later. In Design every view shows a dotted line at all times, unlike the selection's, so it
reads as another page's. On 2026-11-12 the user asked for it in a colour apart from the
selection's accent and round where the view is, then in the blue variables use, a tad thicker:
it is a 2 px blue dotted line that takes the view's radius.

1. **The view element.** `<view page="...">` showing the page an expression gives, laid out at
   the view's size. `Pages` read in every page expression. Each showing keeps its own state:
   a key gains the views it is shown through, `@shell/e10>overview/name`, and a fire names
   them. A page that would show itself draws a fault. A component holds no view. On the board
   a view draws its page without taking presses, and runs it in run mode.
2. **Views that navigate.** `start`, `View.open()`, `View.page`, `open()` in a viewed page going
   to its view, one history per screen, and the address by the rule above.
3. **Editing in place.** Double click into a view on the board edits the page it shows, the
   outer page dimmed. A chip picks which page it shows there.

### Step 1 as built

- Backend: `Tag::View`, written `<view ... page="..."/>`. A component holding one is refused.
  `Fire.via`, `HandlerKey.via` and `Held.via` carry the showing, `Pages::bound` keys state under
  it, `unviewed` reads a key as the page alone keeps it, so `state()` and restarts still find
  it. `ServerMsg::PageKeys` gives screens what code calls each page.
- Client: `Place.via`, `viaView`, `docScope(page, via)`, `pageAct(page, via)`. `Pages` is a
  screen name, read in every expression. `Shown` in `PageView.tsx` draws the page at the view's
  size, counted by `drawnInView` so what it reads is watched. On the board it is drawn
  `inside`, so none of it is picked and a press picks the view. A dotted accent line over it
  marks it. Faults: not a page, a component, a page it is shown in already.
- Inspector: a View section with Page, offering every other page. Add menu: View. A phone
  lays a view out as one block, scaled.
- Scenario `design-view`.

### Step 2 as built

The user agreed on 2026-11-11 that a view navigates when its `page` is a bare name of state
kept each screen, `<view page="section"/>` with `<var name="section" start='"overview"'/>`, in
place of a `Content.open()`. Its start is a page id, as a var's start is JSON.

- `client/src/state/address.ts`: `navViews` finds such views outside repeats, `address()`
  writes the address by the rule above, `openAddress` opens one, the query form read at a
  single level too, `showViews` puts back a step's views, `openInView` takes `open()` from a
  page a view shows, and `followViews` makes each change of a view a step of history.
- `stack.ts`: each step holds how many pages were open, its place and every view's page. `back`
  goes to the last step with that many open, `undo` (Escape) to the step before. The address
  module is handed in from `main.tsx` through `onViews`, as the store imports the stack.
- Backend: `ServerMsg::Open.via`, the run's, so a full page opens in the view its opener's page
  is shown through, its wait answered at once. A page that shows `over` opens over the screen.
- `/run/...` is the operator's screen, and `index.html` has `<base href="/">` so a project's
  files keep resolving from the root.
- Scenario `run-view-address`.

### Step 3 as built

The user said on 2026-11-12 that moving the artboard into the view was wrong: every artboard
stays where it is and a page is edited where a view shows it as naturally as a frame is.

- A press picks a view, a press again on it goes into the page it shows and picks what lies
  under the pointer there, at any depth, as a press again goes further into a frame. A double
  click and the chip's "Edit here" go in too.
- `inPlace` in `state/view.ts` holds the views the open page is edited through, outermost
  first, and `placesIn` in `tree.ts` finds their boxes, each page laid out at its view's size.
  Design hands the board the open page at that size and the board draws what edits it over the
  view. The view under it draws nothing meanwhile.
- The page keeps its own artboard, label and lines where they are, and a press on that artboard
  edits it there again. Nothing is dimmed. Escape with nothing picked steps out a level with
  the view picked, a press on the page around opens the innermost page under it, and opening a
  page any other way leaves.
- The chip under one picked view lists the pages the board may show in it, kept in
  `boardShows` by the view's showing and never saved.
- A view in a repeat is not gone into, nor a web page, and the phone preview is off meanwhile.
- Scenario `design-view-edit`.

### Web pages in a view

The user asked on 2026-11-11 for a view to show a web page too, and to leave URLs out of the
address. They also asked how an address picks a view whose page is any expression: it never
does. Only a view whose `page` is a bare name of state kept each screen is in the address, and
the address sets that state, as the nav does. Any other view follows its expression.

- Text with `://`, or starting with `/`, is a URL, since a page's id has neither. The view
  draws it in an iframe. One on the HMI's own host is sandboxed without its origin, so it
  cannot drive the screen.
- The address leaves it out and refuses one it names. The history keeps it, so Back and
  Forward step through it.
- The board draws it, never edits it in place, and the chip names its URL.
- Scenario `view-web`.

### The board as a graph

The user asked on 2026-11-12 for the board to lay the pages out top down from the start page, by
what each shows and opens. Their choices: links only from `Pages.X`, a warning wherever a page
is shown or opened by a name worked out as it runs, lines drawn, and pages nothing reaches
heading their own trees to the right.

- `state/links.ts` reads every value and handler with acorn: each `Pages.X` is a link, `open`
  when inside an `open()` and `view` otherwise, starting at that view or the element that opens
  it. A view's variable's start and page ids written into it count too. `open()` given no named
  page, a view's variable set to none, and a view's `page` naming none warn on that element.
- `screens/design/graph.ts` makes a tree by a breadth first walk, each page under the first to
  reach it, rows as tall as their tallest page, a page centred over what it leads to. Trees sit
  twice the gap apart.
- The board draws each link from the bottom of its page under its element into the top of the
  page it leads to, in the quarter its label leaves free, as a label takes at most three
  quarters of its page's width and names it without its size. Its text is 14 units tall, at
  most 12 px, so zoomed out about half a name still shows. The line stops where its head
  begins, 4 units long and 4 to 10 px on screen. A link back up curves out to the side.
- A press on a line picks its link, as the user asked: it turns the accent, its page opens with
  every element that makes it ringed, and `LinkInspector` lists them, the view first, each
  with what of it does, a row picking its element. A link keeps every place that makes it as
  `by`. Escape, a pick or another page lets it go.
- Karbon's AppBar takes page ids and labels, bound to the shell's `section`, as the ModeSwitch.
- Scenario `board-graph`.

Defaults taken where the user has not said: a page in a view lays out at the view's size, an
element is never dragged across a view's edge, header content from a page and phone reflow
wait.

## Mockup

`docs/design/views/index.html` tries C against A and B on the packing line: the board as the
Design tab would draw it, a run where the nav, Back and the View well work, and the file each
page would be.
