/**
 * Orbit's browser shell, as a page mounts it, and the few agent helpers a page needs. A page
 * imports from here rather than `/agent`, whose modules would otherwise land in its bundle.
 */
export { DEFAULT_BRAND, type Brand } from "./agent/brand";
export { HttpError, segment, type Galaxy } from "./agent/galaxy";
export { isSessionDocument, SCHEMA, type SessionDocument } from "./agent/saved";
export {
  cannotStart,
  currentHistoryLaunch,
  mountOrbitBrowser,
  type ArtifactRenderer,
  type ArtifactRenderers,
  type LaunchContext,
  type OrbitBrowserHandle,
  type OrbitBrowserOptions,
  type SessionStore,
} from "./shell";
