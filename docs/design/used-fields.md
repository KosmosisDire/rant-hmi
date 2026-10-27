# Used fields

An import brings only the fields something reads, found from the code without running it, in
place of the boxes a person ticks for each field. Builds on `data-paths.md`, whose step 5 made
an import keep some fields.

## The question

The user's, on 2026-10-26: the Data tab shows a box per field of an import, but could the HMI
work out which fields are needed, and the backend stream only those?

Where it pays, from the code in `examples/packing-line`:

- The overview's box overlay reads `LabelCam.width` and `LabelCam.height`. LabelCam is a
  picture, so each screen showing that page gets every picture whole for two numbers.
- A scene's points read `x`, `y` and `z` of each point. A lidar's points carry more, as
  `intensity`. Measured in `data-paths.md`: 9.5 MB a second whole, 8.4 with x, y and z.
- Most other reads are one number of a small value, `Conveyor.speed`, where it saves little.

What it cannot save: Rant has no field filter on a subscription, only `max_rate_hz`, so the
publisher still sends every byte to the backend. The savings are the backend's decode, the
link to each screen and the page.

## Options

Runtime tracking, values read through proxies that note each field read:

- Precise, but a field is noted only once read, so the first read finds nothing, and code
  that has not run yet (a branch, an alarm's text) brings nothing until it runs.
- Proxies on every read of every value, point clouds too.

Static analysis of the code, on the parse acorn already makes for the operator rewrite:

- Knows every field before anything runs, so what a page reads is there when it first draws.
- Must assume the worst where it cannot follow a value: a field by a name worked out at
  runtime, a value handed to a function. It then brings all of that value.

Picked static analysis. Bringing too much costs bytes, bringing too little shows a page wrong.

Where it runs:

- On the screen, for what its pages read, as `watch` already does for names. The screen knows
  which pages it shows and reads its components and repeats.
- On the backend, for its own code: rules, page handlers, computed values, records.
- Both through one file, `client/src/lang/reads.js`, which the backend's QuickJS loads as it
  loads the operator rewrite. Only the syntax is there. Which of the paths are fields is
  settled on the backend alone, against the import's type, so it lives in one place.

What the backend decodes:

- The fields every screen reads now, and what its own code reads, or every field of an import
  to write or while a screen previews every value. An import nothing reads decodes no field.
- Or every field any page reads, shown or not. Simpler, but decodes what no screen shows.

Picked the first. An import nobody shows costs nearly nothing, as `hidden0` measured the
biggest lever. Its cost: what is decoded changes as screens move between pages, so the last
sample of each import is kept and decoded again at once, else a page opened on a variable that
seldom changes would wait for its next change.

## Decisions

- Static analysis, on acorn, in `lang/reads.js`, shared by the screen and the backend.
- A path is a name and the fields after it, `[]` an item of a list: `Labels.boxes[].min.x`.
  Code that reads a value in a way the analysis does not follow reads all of it.
- An item a list's function or a loop takes is followed, as are the list itself and a reduce's
  first item, since the big lists are read there. A let or a const reads all it is given:
  following one paid only where code names a small part first, and was the subtlest logic.
- An expression's value may be either branch of a choice, as `wide ? Camera : LabelCam`, so a
  component's input or a media source given one reads each branch as it is used there.
- Media reads none of an import whose Video child it plays, and all of any other it shows, as
  its pictures take every field. Its condition is read as anywhere.
- The screen sends the paths its shown pages read in `watch`, and gets values with only those
  fields. A name read at runtime that its pages' text does not show comes whole.
- The backend settles which paths are fields against each import's type. A path that goes on
  past a field to a name the type lacks, as `name.toUpperCase` or `points.length`, reads that
  field whole, and a list's `length` its items with none of their fields.
- The backend decodes what screens and its own code read, and decodes the last sample again
  when that grows. Its own code is its rules, its pages' handlers (a component's run on the
  screen), the computed values and the records. A rule waiting on a change reads `p.value` and
  `p.previous` as the name it waits on. Code that may read any name has every import whole.
- An import to write decodes whole, as a write of one field starts from all the others.
- A screen that has not said what it reads reads all, as a tool speaking the protocol may never
  say. So a screen that connects has every import decoded whole until its first `watch`.
- A new import decodes nothing until the backend says what is read, which follows its attach.
- Each value the mesh delivers counts up, so one decoded before the last was decoded again,
  and so older, is dropped.
- The `fields` key goes, and so do the boxes. `rate` stays, as a trade of data against delay
  that code cannot make.

## Steps

1. `reads.js`: the paths code reads, with tests run through QuickJS.
2. The screen sends paths, the backend types them and sends each screen only those.
3. The backend reads its own code, decodes the union, and decodes the last sample again.
   `fields` and the boxes go here, as what the backend decodes takes their place.
4. The Data tab shows which fields come, docs.
