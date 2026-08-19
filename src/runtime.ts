// Runtime bridge. JSX in every module compiles (classic transform) to
// `React.createElement(...)`, resolving to the `React` binding re-exported
// here. The app injects its own React as `api.react`; we assign it once in
// activate() before any component renders, so all modules share the one
// instance (a second copy would break hooks).

import type { SafelightAPI, UiKit } from "./safelight";

export let React!: typeof import("react");
export let api!: SafelightAPI;
export let ui!: UiKit;

export function initRuntime(a: SafelightAPI): void {
  api = a;
  React = a.react;
  ui = a.ui;
}
