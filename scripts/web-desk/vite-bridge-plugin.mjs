// Mounts the development desk bridge (./bridge.mjs) on `vite --mode web`
// and `vite preview --mode web`, so `npm run dev:web` talks to a local host.
import { bridgeOptionsFromEnv, createDeskBridge } from "./bridge.mjs";

export function webDeskBridgePlugin() {
  const mount = (server) => {
    const options = bridgeOptionsFromEnv();
    if (!options.token)
      server.config.logger.warn(
        "[web-desk] MONOCODE_DESK_TOKEN is not set; the desk bridge answers 503.",
      );
    server.middlewares.use(createDeskBridge(options));
  };
  return {
    name: "monocode-web-desk-bridge",
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
