# Problems

A design record for the problems list, built on branch `problems`. Written for review.

## The ask

The user's words, 2026-10-26:

> The hmi needs some way of taking any and all issues that exist on the hmi's frontend and then
> making them visible to the user or an agent trying to develop the hmi to catch frontend bugs,
> or runtime issues.

Before it, a problem ended up in one of four places: a red outline with a hover title in Design
only, a notice that fades in seconds, the browser console, or the backend log.

## The user's choices

- The list shows in the editor only. The operator's screen keeps its notices, and still sends
  its problems.
- The editor shows every screen's problems, each saying which screen found it.
- An agent reads them at `GET /problems`, in the log, and as `Hmi/Problems` on the mesh.
- Page faults come from what screens draw. A check of the whole project, open or not, is a
  later item.

## Claude's choices

- Three sources: `page` (holds while shown, goes once fixed), `run` and `hmi` (each counted
  as it comes again). Notices are not all problems: a gesture hint such as "Pick elements that
  sit in one frame" is not one, so each fault is reported where it happens.
- The console's error and warn are wrapped, in the page and its data worker, the originals
  still called. The worker tells its own faults and stops its errors from reaching the page a
  second time.
- An error event that carries no error is a warning, since nothing threw it: the browser's
  "ResizeObserver loop completed with undelivered notifications", which phone layouts raise
  (design-phone found it), is one.
- An error boundary around each editor tab, the operator's run view and each drawn page, so a
  render error shows what broke, with "Draw it again", in place of a blank screen.
- A video a screen cannot play is a page warning, not a red outline, since the page is not at
  fault.
- A screen sends its whole list at most 4 times a second. The backend stamps each problem with
  its own clock when it is new or comes again, so every screen's share one clock, and logs each
  new one. A run on the system is logged by its end already, so it is not logged twice.
- A row groups one problem found on several screens. A page's fault counts once however many
  screens show it.
- Rows keep the order each first came, new ones below, so no row moves under the pointer.
- The eraser clears those that passed from this viewer's list only: it remembers the newest it
  cleared, and an agent and other screens still see them.
- `Hmi/Problems` holds the newest 100, words cut to fit its fixed sizes, without stacks, which
  `/problems` and the log carry.
- The scenario runner fails a scenario on a fault in the HMI's own code, read at `/problems`,
  as an error boundary's catch logs nothing to the console. Project faults never fail one,
  since scenarios make them on purpose.

## Open

- A screen's problems go with it when it closes. The log keeps them.
- Why a screen's WebRTC did not open stays its own banner and status, not a problem.
- `/problems` has no login, as nothing else has yet.
