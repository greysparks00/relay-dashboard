// Load with <script src="server.js"></script>, then call:
// const monitor = createRelayMonitor({
//   production: {
//     junctionUrl: "http://192.168.68.69:8080",
//     junctionApiKey: YOUR_INPUT_VALUE,
//     mcpUrl: "http://192.168.68.69:18000/mcp",
//     displayUrl: "http://192.168.68.69:8766"
//   },
//   development: {
//     junctionUrl: "http://127.0.0.1:8080",
//     junctionApiKey: YOUR_DEVELOPMENT_KEY,
//     mcpUrl: "http://127.0.0.1:18000/mcp",
//     displayUrl: "http://127.0.0.1:8766"
//   }
// }, snapshot => { /* update your page */ });
// monitor.start(); monitor.stop(); monitor.poll();
// monitor.configure(newSettings); // replace settings after the user edits your form
//
// Keys stay in memory. This file never saves keys or reads .env files.
// Direct requests require each service to allow your site's origin through CORS.
// Use matching HTTP/HTTPS origins; an HTTPS page can block HTTP service requests.

(function (global) {
    "use strict";

    const SERVICES = [
        ["Google Auth", "googleauth"],
        ["Google Calendar", "googlecalendar"],
        ["Speech to Text", "speechtotext"],
        ["Storage", "storage"],
        ["Text to Speech", "texttospeech"],
        ["Time", "time"],
    ];

    global.createRelayMonitor = function (initialSettings, onUpdate = () => {}) {
        let settings = copySettings(initialSettings);
        let snapshot = { checkedAt: null, environments: {} };
        let pending = null;
        let controller = null;
        let timer = null;
        let generation = 0;

        // Copy configuration so editing a form object cannot change half a poll.
        function copySettings(value) {
            return Object.fromEntries(Object.entries(value || {}).map(([name, config]) =>
                [name, { ...config }]));
        }

        function endpoint(origin, pathname) {
            const url = new URL(origin);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
                    || url.pathname !== "/" || url.search || url.hash) {
                throw new Error("Use an HTTP(S) origin without credentials, paths, or query parameters.");
            }
            return new URL(pathname, url).href;
        }

        async function probe(name, url, key, json, signal) {
            const started = performance.now();
            const timeout = new AbortController();
            const abort = () => timeout.abort();
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            const timeoutId = setTimeout(abort, 4000);
            try {
                const response = await fetch(url, {
                    mode: "cors",
                    credentials: "omit",
                    cache: "no-store",
                    redirect: "error",
                    signal: timeout.signal,
                    headers: key ? { Authorization: "Bearer " + key } : {},
                });
                let info;
                if (json && response.ok) info = await response.json();
                else await response.body?.cancel();
                const degraded = ["failed", "degraded", "error", "unhealthy"].includes(info?.status)
                    || ["failed", "loading"].includes(info?.model);
                return {
                    name, url,
                    status: response.ok ? (degraded ? "degraded" : "healthy") : "error",
                    httpStatus: response.status,
                    latencyMs: Math.round(performance.now() - started),
                    ...(info ? { info } : {}),
                };
            } catch {
                // Browsers conceal CORS and mixed-content failures. A failed fetch
                // cannot establish whether the service itself is offline.
                return {
                    name, url, status: "unreachable", httpStatus: null,
                    latencyMs: Math.round(performance.now() - started),
                    error: "Request failed. Check the network, CORS, HTTPS, and browser local-network permissions.",
                };
            } finally {
                clearTimeout(timeoutId);
                signal.removeEventListener("abort", abort);
            }
        }

        async function checkEnvironment(config, signal) {
            try {
                const mcpHealth = endpoint(config.mcpUrl.replace(/\/mcp\/?$/, ""), "/health");
                const results = await Promise.all([
                    probe("Junction", endpoint(config.junctionUrl, "/health"), config.junctionApiKey, false, signal),
                    probe("MCP", mcpHealth, config.mcpApiKey, true, signal),
                    probe("Display Server", endpoint(config.displayUrl, "/screen/1"), config.displayApiKey, false, signal),
                    ...SERVICES.map(([name, route]) => probe(name,
                        endpoint(config.junctionUrl, "/" + route + "/health"),
                        config.junctionApiKey, true, signal)),
                    probe("Junction Metrics", endpoint(config.junctionUrl, "/api/metrics"),
                        config.junctionApiKey, true, signal),
                ]);
                // Serving the page proves reachability, not that a kiosk is connected.
                if (results[2].status === "healthy") results[2].status = "reachable";
                const junctionMetrics = results.pop();
                return {
                    services: results, junctionMetrics,
                    kiosk: { status: "unknown", info: "The kiosk has no health endpoint." },
                };
            } catch {
                return { status: "configuration_error", error: "Check the configured Junction, MCP, and display URLs." };
            }
        }

        function poll() {
            if (pending) return pending;
            const current = generation;
            const abort = new AbortController();
            controller = abort;
            pending = (async () => {
                try {
                    const entries = await Promise.all(Object.entries(settings).map(async ([name, config]) =>
                        [name, await checkEnvironment(config, abort.signal)]));
                    if (generation === current) {
                        snapshot = { checkedAt: new Date().toISOString(),
                            environments: Object.fromEntries(entries) };
                        onUpdate(snapshot);
                    }
                    return snapshot;
                } finally {
                    if (controller === abort) {
                        controller = null;
                        pending = null;
                    }
                }
            })();
            return pending;
        }

        function stop() {
            clearInterval(timer);
            timer = null;
            generation += 1;
            controller?.abort();
            controller = null;
            pending = null;
        }

        return {
            start() {
                if (timer) return;
                timer = setInterval(() => {
                    poll().catch(error => console.error("Health update failed", error));
                }, 7000);
                return poll();
            },
            stop,
            poll,
            configure(nextSettings) {
                const running = timer !== null;
                stop();
                settings = copySettings(nextSettings);
                snapshot = { checkedAt: null, environments: {} };
                if (running) return this.start();
            },
            getSnapshot: () => structuredClone(snapshot),
        };
    };
})(globalThis);

// The small dashboard below consumes the same polling API used by other sites.
// Use textContent for responses so service output cannot introduce page markup.
if (typeof document !== "undefined" && document.querySelector("#settings")) {
    const form = document.querySelector("#settings");
    const environments = document.querySelector("#environments");
    const results = document.querySelector("#results");
    const status = document.querySelector("#status");
    const refresh = document.querySelector("#refresh");
    const stop = document.querySelector("#stop");
    let monitor;
    let running = false;

    for (const [name, host] of [["development", "127.0.0.1"], ["production", "192.168.68.69"]]) {
        const fieldset = document.createElement("fieldset");
        fieldset.dataset.environment = name;
        const legend = document.createElement("legend");
        legend.textContent = name === "development" ? "Development" : "Production";
        fieldset.append(legend);
        const enabledLabel = document.createElement("label");
        const enabled = document.createElement("input");
        enabled.type = "checkbox";
        enabled.name = "enabled";
        enabled.checked = true;
        enabledLabel.append(enabled, " Check this environment");
        fieldset.append(enabledLabel);
        for (const [key, text, value, type] of [
            ["junctionUrl", "Junction URL", "http://" + host + ":8080", "url"],
            ["junctionApiKey", "Junction API key", "", "password"],
            ["mcpUrl", "MCP URL", "http://" + host + ":18000/mcp", "url"],
            ["displayUrl", "Display server URL", "http://" + host + ":8766", "url"],
        ]) {
            const label = document.createElement("label");
            label.textContent = text;
            const input = document.createElement("input");
            input.name = key;
            input.type = type;
            input.value = value;
            input.autocomplete = "off";
            input.spellcheck = false;
            label.append(input);
            fieldset.append(label);
        }
        environments.append(fieldset);
    }

    function addRow(environment, service) {
        const row = document.createElement("tr");
        for (const value of [environment, service.name, service.status,
            service.httpStatus ?? "—",
            service.latencyMs === undefined ? "—" : service.latencyMs + " ms"]) {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.append(cell);
        }
        row.children[2].dataset.status = service.status;
        const info = document.createElement("td");
        const value = service.info ?? service.error;
        if (typeof value === "object" && value !== null) {
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = "Details";
            const pre = document.createElement("pre");
            pre.textContent = JSON.stringify(value, null, 2);
            details.append(summary, pre);
            info.append(details);
        } else {
            info.textContent = value ?? "";
        }
        row.append(info);
        results.append(row);
    }

    function render(snapshot) {
        results.replaceChildren();
        for (const [name, data] of Object.entries(snapshot.environments)) {
            for (const service of data.services ?? []) addRow(name, service);
            if (data.junctionMetrics) addRow(name, data.junctionMetrics);
            if (data.kiosk) addRow(name, { name: "Kiosk", ...data.kiosk });
            if (data.error) addRow(name, { name: "Settings", status: data.status, error: data.error });
        }
        status.textContent = "Last checked " + new Date(snapshot.checkedAt).toLocaleTimeString() +
            (running ? ". Checking every 7 seconds." : ". Checks stopped.");
    }

    async function checkNow() {
        status.textContent = "Checking services…";
        try {
            await monitor.poll();
        } catch {
            status.textContent = "Could not complete the checks. Check your settings and browser console.";
        }
    }

    form.addEventListener("submit", async event => {
        event.preventDefault();
        const settings = {};
        for (const fieldset of environments.children) {
            if (!fieldset.querySelector('[name="enabled"]').checked) continue;
            settings[fieldset.dataset.environment] = Object.fromEntries(
                Array.from(fieldset.querySelectorAll("input:not([type=checkbox])"))
                    .map(input => [input.name, input.value.trim()]));
        }
        monitor?.stop();
        if (Object.keys(settings).length === 0) {
            running = false;
            refresh.disabled = stop.disabled = true;
            status.textContent = "Select an environment to check.";
            return;
        }
        running = true;
        refresh.disabled = stop.disabled = false;
        status.textContent = "Checking services…";
        monitor = createRelayMonitor(settings, render);
        try {
            await monitor.start();
        } catch {
            status.textContent = "Could not complete the checks.";
        }
    });
    refresh.addEventListener("click", checkNow);
    stop.addEventListener("click", () => {
        running = false;
        monitor?.stop();
        refresh.disabled = stop.disabled = true;
        status.textContent = "Checks stopped.";
    });
    window.addEventListener("pagehide", () => monitor?.stop());
}
