import type { Role } from "./api";

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
