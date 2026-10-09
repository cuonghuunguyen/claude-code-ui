// TODO(GH-248): replace this file with the imports from @claude-ui/protocol once the daemon half (branch GH-248-side-check) is merged.
/** Progress of a side that is starting (SideInfo.phase). */
export type SidePhase = "packing" | "copying" | "installing" | "starting";
/** `side.start` setup mode: "never" runs only an installed build, "needed" installs when missing (absent = this), "force" reinstalls. */
export type SideSetup = "never" | "needed" | "force";
export type SideCheckReason =
  | "gone"
  | "not_running"
  | "unreachable"
  | "no_build"
  | "package_unreadable"
  | "node_missing"
  | "node_old"
  | "build_tools_missing"
  | "not_logged_in"
  | "no_writable_path"
  | "check_failed";
/** Reply of the read-only `side.check` request. */
export type SideCheck = {
  verdict: "running" | "starting" | "installed" | "install" | "update" | "blocked";
  reason?: SideCheckReason;
  message?: string;
  key: string;
  facts: {
    reachable: boolean;
    running?: boolean;
    node?: string;
    nodeOk?: boolean;
    buildTools?: { make: boolean; python3: boolean; cxx: boolean };
    credentialsFile?: boolean;
    installed: "current" | "other" | "none";
    installedKey?: string;
    writable?: string[];
  };
  phase?: SidePhase;
};
