import { createRoute } from '@tanstack/react-router';
import { loginPlugin } from '@niuulabs/plugin-login';
import { volundrPlugin } from '@niuulabs/plugin-volundr';
import { definePlugin, type PluginDescriptor } from '@niuulabs/plugin-sdk';
import { SettingsPage } from './SettingsPage';
import { ENABLED_PLUGINS, type PluginId } from './pluginConfig';

const settingsPlugin = definePlugin({
  id: 'settings',
  rune: '⚙',
  title: 'Settings',
  subtitle: 'configuration',
  position: 'bottom',
  routes: (rootRoute) => [
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/settings',
      component: SettingsPage,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/settings/$providerId',
      component: SettingsPage,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/settings/$providerId/$sectionId',
      component: SettingsPage,
    }),
  ],
});

// Always-on essentials are imported statically. Optional / heavy modules are
// LAZY: their import only runs when the id is listed in ENABLED_PLUGINS
// (pluginConfig.ts), so a disabled module is never compiled by the dev server
// or shipped in the bundle. This is the config-driven enable/disable mechanism
// — to toggle a module, edit ENABLED_PLUGINS, not this file.
const STATIC_PLUGINS: Partial<Record<PluginId, PluginDescriptor>> = {
  login: loginPlugin,
  volundr: volundrPlugin,
  settings: settingsPlugin,
};

const LAZY_PLUGINS: Partial<Record<PluginId, () => Promise<PluginDescriptor>>> = {
  guild: async () => (await import('./guild')).guildPlugin,
  bifrost: async () => (await import('@niuulabs/plugin-bifrost/plugin')).bifrostPlugin,
  ting: async () => (await import('@niuulabs/plugin-ting')).tingPlugin,
  mimir: async () => (await import('@niuulabs/plugin-mimir')).mimirPlugin,
  ravn: async () => (await import('@niuulabs/plugin-ravn')).ravnPlugin,
  observatory: async () => (await import('@niuulabs/plugin-observatory')).observatoryPlugin,
};

/** Resolve the enabled plugins (in ENABLED_PLUGINS order), lazy-loading any
 * optional modules. Disabled modules are never imported. */
export async function loadEnabledPlugins(): Promise<PluginDescriptor[]> {
  const out: PluginDescriptor[] = [];
  for (const id of ENABLED_PLUGINS) {
    const stat = STATIC_PLUGINS[id];
    if (stat) {
      out.push(stat);
      continue;
    }
    const lazy = LAZY_PLUGINS[id];
    if (lazy) out.push(await lazy());
  }
  return out;
}

/** Synchronous view of the statically-available enabled plugins (used by tests
 * and any sync consumer). The app uses loadEnabledPlugins() so lazy modules are
 * included too. */
export const plugins: PluginDescriptor[] = ENABLED_PLUGINS.map((id) => STATIC_PLUGINS[id]).filter(
  (p): p is PluginDescriptor => Boolean(p),
);
