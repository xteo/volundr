import { createElement } from 'react';
import { createRoute } from '@tanstack/react-router';
import { definePlugin } from '@niuulabs/plugin-sdk';
import { GuildPage } from './GuildPage';

// Guild plugin definition lives in its own module so it is only imported when
// 'guild' is enabled in pluginConfig.ts (lazy). When disabled, GuildPage (a
// large component) is never pulled into the bundle / dev compile.

function GuildTopbar() {
  return createElement(
    'button',
    {
      type: 'button',
      onClick: () => {
        window.dispatchEvent(new Event('guild:open-register'));
      },
      className:
        'niuu-inline-flex niuu-items-center niuu-gap-2 niuu-rounded-lg niuu-border niuu-border-brand/35 niuu-bg-brand/12 niuu-px-3 niuu-py-1.5 niuu-text-[12px] niuu-font-medium niuu-text-brand hover:niuu-bg-brand/18',
    },
    '+ register',
  );
}

export const guildPlugin = definePlugin({
  id: 'guild',
  rune: 'ᚹ',
  title: 'Guild',
  subtitle: 'runtime registry',
  tabs: [
    { id: 'instances', label: 'Instances', path: '/guild' },
    { id: 'access', label: 'Access', path: '/guild/access' },
    { id: 'connections', label: 'Connections', path: '/guild/connections' },
  ],
  routes: (rootRoute) => [
    createRoute({ getParentRoute: () => rootRoute, path: '/guild', component: GuildPage }),
    createRoute({ getParentRoute: () => rootRoute, path: '/guild/access', component: GuildPage }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/guild/connections',
      component: GuildPage,
    }),
  ],
  topbarRight: () => createElement(GuildTopbar),
});
