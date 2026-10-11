import { Router } from 'express';
import { PROTOCOL_VERSION } from '../websocket/protocol.js';

/**
 * Liveness and readiness.
 *
 * /healthz  - the process is running (never touches external services).
 * /readyz   - essential dependencies are usable. Reports "degraded" with the
 *             precise reason instead of pretending everything is fine.
 */
export function createHealthRouter({ config, store, aiProvider, gateway, storage, startedAt, version }) {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'nexus-phone-agent',
      version,
      env: config.env,
      uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
      protocol_version: PROTOCOL_VERSION,
    });
  });

  router.get('/readyz', async (_req, res, next) => {
    try {
      const checks = { store: { ok: false }, ai: { ok: false }, websocket: { ok: Boolean(gateway) } };
      const reasons = [];

      try {
        await store.getState('nexus.readyz.probe').catch(() => undefined);
        await store.setState('nexus.readyz.probe', { at: new Date().toISOString() });
        checks.store = { ok: true, driver: storage.driver, persistent: storage.persistent };
      } catch (error) {
        checks.store = { ok: false, error: 'Storage is not reachable.' };
        reasons.push('storage_unavailable');
      }

      const aiHealth = await aiProvider.getProviderHealth();
      checks.ai = {
        ok: Boolean(aiHealth.configured),
        provider: aiHealth.provider,
        model: aiHealth.model ?? null,
        configured: Boolean(aiHealth.configured),
        issues: aiHealth.issues ?? [],
      };
      if (!aiHealth.configured) reasons.push('ai_provider_not_configured');

      checks.websocket = { ok: Boolean(gateway), path: config.wsPath, connections: gateway?.stats().connections ?? 0 };

      const status = reasons.length === 0 ? 'ok' : 'degraded';
      res.status(status === 'ok' ? 200 : 503).json({
        status,
        service: 'nexus-phone-agent',
        version,
        reasons,
        checks,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
