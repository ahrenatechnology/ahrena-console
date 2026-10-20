export { Profiles, type ProfilesOptions, type Profile } from './profiles.ts';
export {
  defaultProfilesFile,
  discoverFolders,
  normalizeFolder,
  looksLikeConfigFolder,
  configFolder,
  configuredFolders,
  type DiscoveryOptions,
  type ProfileOrigin,
  type ConfigFolder,
} from './discovery.ts';
export { ACCOUNT_COLORS, freeColor } from './colors.ts';
export { accountFromClaudeJson, readClaudeJsonAccount, type ProfileAccount } from './reading.ts';
