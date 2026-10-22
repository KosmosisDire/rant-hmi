# Phone layout

A design record for item 27: the layout a page takes on an upright phone, made by the HMI
with nothing from the designer. Written for review, with the options weighed and why each
choice was made.

## The problem

A screen held upright shows a landscape page "stacked". Today `stacked()` in PageView takes
the page's top level elements, sorts them into rows by where they start, lists each row left
to right, puts every block one under another at its own size, and zooms the whole stack so its
widest block fits the screen.

On the packing line's Overview (128 by 72 units) that gives:

- The header is 126 units wide, so the stack is 130 wide and a 390 px phone zooms it to 0.3:
  a unit is 3 px and a 2 unit label is 6 px tall. Everything is too small to read or press.
- The Line panel is 40 wide and would fit the phone almost at its own size, but shrinks with
  the rest.
- Reading order runs Header, Line, Belt, Robot, Camera: the Robot started above the Line's
  foot, so it joined that row and came before the Camera beside the Belt.

Pages built by placing elements freely, with no frames, do worse:

- A label placed over a picture, or a value over a gauge, becomes a block of its own and is
  pulled away from what it marks.
- A panel with readings placed on it becomes an empty block, followed by its readings.
- A repeated element whose copies are spread by `index` puts every copy in one place, as the
  box the stack gives replaces its x and y.
- A row of small buttons becomes one button per line.

## Goals

- What an operator reads and presses is at its designed size where the phone has room, and
  never smaller than it must be.
- Reading order follows the page: top to bottom, and left to right within a band.
- What belongs together stays together: an overlay with what it marks, a panel with what sits
  on it, a frame with its parts.
- Keep what fits as it was designed. Change only what is too wide, from the outside in.
- No setting to learn. A designer who lays out with frames gets a good phone page for free,
  and the docs say so.
- One implementation, the same in the Run tab, on a phone and in the editor's phone preview.
- Leave room for the later step the user named: overrides a designer makes for phones.

## Options

### How the phone page is drawn

A. **Better boxes, as today.** Keep `Overrides`, a box per element, and compute better boxes:
   per block zoom, smarter order. Cheap, but every height must be known before drawing, so
   nothing may reflow: a frame given a narrower width cannot wrap its parts or grow taller,
   and a text cannot wrap. Per block zoom needs a scale per element, which a box cannot carry.

B. **A phone page in the page's own language.** A pure function turns the page into another
   page for a given width: the same elements with the same ids, a few properties changed, and
   new frames with `layout` that hold them. PageView draws it as any page, and the browser's
   flex layout works out every height. Picks, handlers and values work unchanged, as ids are
   kept. What the phone needs is written with what a designer already has: frames, `fill`,
   `hug`, `wrap` and CSS.

C. **CSS alone.** Draw the page in a grid or a wrapping flex box with media queries. Cannot
   know which elements belong together, nor keep an overlay on its picture.

D. **The designer makes the phone page.** Overrides or a second page per phone. The user put
   this after a better automatic layout, so it waits. Option B leaves the door open: overrides
   become a diff applied to the phone page B makes.

**Chosen: B.** It is the only one that lets frames reflow and texts wrap, it adds no second
drawing path, and its output is a page a later override can edit.

### How the order is found

1. Rows by where each block starts, as today. Breaks columns apart.
2. **XY cut**, as document layout analysis does: split the blocks where an empty band runs
   right across them, top to bottom first, else left to right, and split each part again.
   It finds the header, then the columns, then the rows inside a column.
3. Nearest neighbour chains. Harder to predict and explain.

**Chosen: 2, horizontal bands first.** Bands first reads a grid of cards row by row, as text
is read. A column that runs the whole height has no band across it, so it is cut into
columns, read left column first.

### What goes together

Elements are taken as one block when:

- **Overlay**: two boxes overlap. An element on a picture, a diagram, a component or a text
  marks it.
- **Moving**: an element whose `x` or `y` is live moves over what holds it, so it stays with
  every element its box overlaps.
- **Section**: a plain frame with no parts and no handlers, drawn under elements whose centres
  fall inside it, is a backdrop. The backdrop becomes a frame on the phone and what sits on it
  its parts, laid out again inside it. A backdrop with a moving element on it stays whole.
- **Group**: a group is one block.

Considered and left out: nearness alone. A label one unit above its gauge would join it, but
so would every card of a grid with one unit gaps.

### How each block fits

`W` is the room across: the screen's width in units less the margins, at a unit of 10 px.

- A block no wider than `W` keeps its size.
- A block too wide is narrowed when it can reflow, else scaled:

| Block | Too wide |
| --- | --- |
| frame with `layout` down or up | narrowed to `W`, its parts reflow as designed |
| frame with `layout` right or left | narrowed to `W` and wraps, growing as tall as it needs. Parts that fill take their share of the desktop width as their start, and a part that filled its height keeps that height |
| frame placing its parts freely | opened: its parts are laid out again inside it, as a section |
| text, field, a component that lays out in any box, a plain frame | narrowed to `W` |
| picture, diagram with a view box, a component that scales | narrowed to `W`, its height kept in proportion |
| overlay, group, diagram drawn in units, markup | scaled to `W` as a whole |

- A block that can reflow also grows to fill the line it is on, so a lone card spans the
  phone as phone screens do.

### How blocks are arranged

The XY cut gives bands and columns. On the phone:

- **Bands** become a frame laid out down: each band on its own lines, never beside another,
  so a label above a gauge stays above it.
- **Columns** become a frame laid out right that wraps: columns that fit side by side stay so,
  and the rest go under. A row of small buttons stays a row.
- What a frame holds is centred across it, so a lone gauge sits in the middle.

### Scale

A unit is 10 px on the phone, the size a page is designed at, and no zoom is applied. A wider
screen held upright gets a wider `W`, so more stays side by side. A screen wider than tall,
or a page taller than wide, shows the page as it is, as today.

## Rules kept from today

- Only the top full page stacks. A page shown over another, and a component, show as they are.
- Elements keep their ids, so the editor's preview picks them and handlers run as on any page.

## Open questions for the user

- Should a block that reflows always fill its line, or keep its designed width when that fits?
  Chosen: fill, as phone screens look.
- Should columns that fit side by side stay side by side? Chosen: yes. A pair of 18 unit cards
  stays a pair on a 39 unit phone.
