/*! coi-serviceworker v0.1.7 - Guido Zuidhof, licensed under MIT */
let coepCredentialless = false;
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) return;
        if (ev.data.type === "deregister") {
            self.registration.unregister()
                .then(() => self.clients.matchAll())
                .then((clients) => clients.forEach((client) => client.navigate(client.url)));
        }
        if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, { credentials: "omit" })
            : r;

        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) return response;

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp"
                    );
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });

} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = reloadedBySelf === "coepDegrade";

        // Check if already cross-origin isolated
        if (window.crossOriginIsolated !== false) return;

        // You can customize the scope by changing this path
        const coi = {
            shouldRegister: () => true,
            shouldDeregister: () => false,
            coepCredentialless: () => true,
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
        };

        if (!coi.shouldRegister()) return;

        if (!window.isSecureContext) {
            !coi.quiet && console.log("COOP/COEP Service Worker: Not running in secure context.");
            return;
        }

        // In some environments (e.g., Firefox private mode) service workers are disabled
        if (!("serviceWorker" in navigator)) {
            !coi.quiet && console.error("COOP/COEP Service Worker: Service workers are not supported.");
            return;
        }

        // Get current script's path to determine service worker location
        const scripts = document.querySelectorAll('script[src*="coi-serviceworker"]');
        const currentScript = scripts[scripts.length - 1];
        const scriptPath = currentScript?.src || "/coi-serviceworker.js";
        const swPath = new URL(scriptPath, window.location.href).pathname;

        navigator.serviceWorker
            .register(swPath)
            .then(
                (registration) => {
                    !coi.quiet && console.log("COOP/COEP Service Worker: Registered", registration.scope);

                    registration.addEventListener("updatefound", () => {
                        !coi.quiet && console.log("COOP/COEP Service Worker: Update found, reloading...");
                        window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
                        coi.doReload();
                    });

                    // If the registration is active, but not controlling the page
                    if (registration.active && !navigator.serviceWorker.controller) {
                        !coi.quiet && console.log("COOP/COEP Service Worker: Reloading to enable...");
                        window.sessionStorage.setItem("coiReloadedBySelf", "notControlling");
                        coi.doReload();
                    }
                },
                (err) => {
                    !coi.quiet && console.error("COOP/COEP Service Worker: Registration failed", err);
                }
            );

        // If already has controlling service worker, send config
        if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: coi.coepCredentialless(),
            });
        }

        // Handle degrading COEP
        if (coepDegrading && coi.coepDegrade()) {
            !coi.quiet && console.log("COOP/COEP Service Worker: Degrading COEP to credentialless.");
            navigator.serviceWorker.controller?.postMessage({
                type: "coepCredentialless",
                value: true,
            });
        }
    })();
}
