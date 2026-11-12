# Editing objects and their names

The user asked on 2026-11-12, after trying karbon's HMI, for names in fields that say what they
are, pages beside the objects, and mesh members that can be changed instead of removed and
added again.

## What they ran into

A function on the mesh became a task. Its member could not change kind, and could not be
removed while pages named it, so every place naming it had to go, the member be removed and
added again, and every place put back.

## Decisions

The user chose these on 2026-11-12:

- Removing never blocks. A member, an object or a page's state that something still names is
  removed, with a warning saying how many places name it. Those places then show their own
  faults.
- The mesh tree leaves the sidebar. An object's Mesh section has a + that opens the tree as a
  picker, as every other section adds its own.
- A mesh member's Entity is picked again in place, from the same tree, its kind following the
  entity, its name kept, so everything naming it still does.
- A name in a field shows what it is: coloured by its kind, and with the caret in it or the
  pointer on it a card with its kind, type, value and where it is defined. Ctrl click, or the
  card's link, goes there.
- Pages show in the Objects tab apart from the objects. A page's sheet holds all its state, its
  own and each element's under that element, each edited there with the editor the Design
  inspector uses.

## Steps

1. Removing warns instead of refusing.
2. The mesh as a picker, and a member's entity picked again.
3. Pages in the Objects tab.
4. Names in fields: colour, card, going to the definition.

### Step 1 as built

`removeMember` and an object's and a page state's Remove warn with the count of places that
still name it and remove it.

### Step 2 as built

- `MeshTree` is a picker: a filter, folders that open, each entity with the member bringing it,
  and a press picks. `MeshPopover` floats it under the Mesh section's + and the member's
  Entity field. The sidebar keeps the objects alone.
- Picking an entity adds it at once, so the entity's preview before adding went, and a folder's
  + making an object rooted there went with the sidebar's tree.
- The backend's `Project::change` takes a new entity and kind, so `change_import` points a
  member elsewhere under its name. `pathOf` in `state/names.ts` writes an entity's path from the
  object's root, as `entityOf` reads it.
- Scenario `objects-repoint`, and the scenarios that used the sidebar's tree use the picker.

### Step 3 as built

- The Design inspector's state list and a piece of state's pane moved to `design/State.tsx`
  as `StateRows` and `StateView`, which take what opening and going back do, so the Design
  inspector and the Objects tab show one editor.
- `objects/PageSheet.tsx` is a page's sheet: its own state, then each element that keeps some
  under that element's name. `PageInspector` shows the piece picked, else the page with its
  count and Open in Design. A pick of kind `state` names it by its holder.
- Scenario `objects-pages`.

### The sidebar as a tree

The user asked on 2026-11-12, once the mesh had left it, for the sidebar to be one tree with no
heads: Hmi and Theme at its top, then an Objects and a Pages folder, each an ordinary row with a
folder icon, opened and closed by a press as this browser remembers. The Objects folder's +
makes an object, shown always at its row's end. No row counts anything: an object's row marks
each kind of mesh member it brings and whether it has state, computed values, records, functions
and logic, and a page's row whether it keeps state and holds views. Scenario `objects-folds`.

### Step 4 as built

- `state/about.ts` says what the name at a point of a field's text is: a page, state from the
  field's scope with the page and element keeping it, a member with its value now and its fields,
  an object, a token. Completion's state names carry where they are defined.
- `nameHelp` in `ui/highlight.ts` gives a code field its colours, now with the names its scope
  reads and `Pages` blue, and its `about`. Every code field takes it.
- `DraftInput` shows `AboutCard` for the caret's name while no list or hint shows, and for the
  pointer's, and Ctrl click goes to the definition. `openInObjects` in `state/view.ts` asks the
  Objects tab to show a member, a token or a page's state.
- Scenario `design-name-card`.

## Folders, one tree, and phones on the whole board

The user asked on 2026-11-12 for pages and objects kept in folders that match folders on disk.
Their choices: a folder is only where a file is kept, never part of a name, id or address, so
ids stay one of a kind across folders. Components take folders too. Design's sidebar groups by
the same folders, as one generic tree with the Objects tab's, and components join the layers
tree as rows. A row's picture shows while the pointer rests on it. The phone preview shows every
page on the board as a phone lays it out, not only the open one.

- Backend: `Page.folder` and `Object.folder` come from where the file is and are never written
  into it. `files.rs` reads `.html` files at any depth, lists folders, and makes, moves and
  removes them, a removed folder's contents going up. `Pages::save` writes a page in its folder
  and takes its file away anywhere else, `move_to` and `Project::move_object` move one in place.
  `MoveToFolder` moves an item without a reload, `MakeFolder`, `MoveFolder` and `RemoveFolder`
  change the disk and reload. `ServerMsg::Folders` lists every folder, empty ones too.
- `ui/Tree.tsx`: `TreeRow`, every row of every tree, its classes in one `classList` as a spread
  would wipe them, its end against the right edge, its picture after a rest. `FolderTree` draws
  a kind's folders, each with New folder, Rename and Remove, folds remembered as `tree-shut`.
  `dragToFolder` moves a row onto a folder, or hands the point on, as a component placed on the
  board, Escape letting go. `moveRow` is each item's Move to.
- The Objects tab: Hmi and Theme, then the Objects and Pages folders. Design: the Components and
  Pages folders, each page or component a row with its layers under it, the open one pinned and
  its + adding an element. Component cards went, `PagePicture.tsx` holding the picture and the
  drop on the board. `Fold.tsx` went with the last pane heads.
- A press that closes a phone's sheet swallows the click after it, as it fell through to what
  lay under the dimmed screen.
- A 3D component's artboard draws no grid.
- Scenarios `design-folders`, `design-folds`, `design-component-rows`, `objects-folds`, and
  `design-phone-preview` checks a page not open.
