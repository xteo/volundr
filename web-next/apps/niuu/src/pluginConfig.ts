// Module visibility configuration (niuu-ux).
//
// This is the single place that curates which platform modules appear in the
// left rail. It is *config*, not commented-out code: edit ENABLED_PLUGINS to
// turn a module on/off. Modules not listed here are never imported by the app
// (see plugins.ts — disabled modules are lazy and thus not compiled in the dev
// server either), so this doubles as a load-time optimisation.
//
// Initially we support only Forge/Volundr + the essentials (auth + settings).
// To bring a module back, add its id to ENABLED_PLUGINS.
export type PluginId =
  | 'login'
  | 'volundr'
  | 'settings'
  | 'guild'
  | 'bifrost'
  | 'ting'
  | 'mimir'
  | 'ravn'
  | 'observatory';

export const ENABLED_PLUGINS: PluginId[] = ['login', 'volundr', 'settings'];
