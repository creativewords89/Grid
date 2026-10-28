import type { Role, Run } from "./api";

export const ROLE_NAMES: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  viewer: "Viewer",
};

export const ROLE_HINTS: Record<Role, string> = {
  owner: "Everything, including API keys, budgets and people.",
  admin: "Imports, agents (on/off, settings, run) and benchmarks.",
  viewer: "Can look at everything, change nothing.",
};

export const RUN_STATUS: Record<Run["status"], string> = {
  queued: "Waiting for the agent",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  timed_out: "Stopped answering",
};

export const CONNECTION_NAMES: Record<string, string> = {
  dataforseo: "DataForSEO",
  pagespeed: "PageSpeed Insights",
  email: "Email",
  telegram: "Telegram",
};
