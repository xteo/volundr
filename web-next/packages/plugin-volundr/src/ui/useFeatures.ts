import { useQuery } from '@tanstack/react-query';
import { useService } from '@niuulabs/plugin-sdk';
import type { IVolundrService } from '../ports/IVolundrService';
import type { VolundrFeatures } from '../models/volundr.model';

const FALLBACK_FEATURES: VolundrFeatures = {
  localMountsEnabled: false,
  fileManagerEnabled: true,
  miniMode: false,
};

/**
 * Queries backend feature flags (mini mode, local mounts, file manager) from
 * GET /api/v1/forge/feature-flags. Flags are deployment-static, so cache them.
 */
export function useFeatures() {
  const volundr = useService<IVolundrService>('volundr');
  return useQuery({
    queryKey: ['volundr', 'features'],
    queryFn: () => volundr.getFeatures(),
    staleTime: 5 * 60 * 1000,
    // A backend that predates the route 404s; don't hammer it.
    retry: false,
  });
}

/**
 * True when the backend runs in single-host "mini" mode (LocalProcessPodManager,
 * no Kubernetes). Defaults to false while loading or if the request fails, so a
 * cluster deployment (or an older backend without the route) keeps the full
 * LaunchWizard rather than wrongly showing the mini Quick Launch.
 */
export function useMiniMode(): boolean {
  const { data } = useFeatures();
  return data?.miniMode ?? FALLBACK_FEATURES.miniMode;
}
