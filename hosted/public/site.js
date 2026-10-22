// Shared chrome for every page: mobile navigation and privacy-respecting analytics.
// Analytics is a no-op unless the server injected a PostHog key via /config.js.
import posthog from "posthog-js";

// Mark the current page in the nav and wire the mobile menu toggle.
const nav = document.querySelector(".site-nav");
const here = location.pathname.replace(/\/+$/, "") || "/";
for (const link of document.querySelectorAll(".site-nav a")) {
  const path = new URL(link.href).pathname.replace(/\/+$/, "") || "/";
  if (path === here) link.setAttribute("aria-current", "page");
}
const toggle = document.querySelector(".nav-toggle");
if (toggle && nav) {
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  for (const link of nav.querySelectorAll("a"))
    link.addEventListener("click", () => {
      nav.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    });
}

// Analytics: cookieless, no autocapture, no session recording, no file contents.
const config = window.OOPSWARE_ANALYTICS;
let client;
if (config && config.key && !navigator.doNotTrack?.startsWith("1")) {
  try {
    posthog.init(config.key, {
      api_host: config.host,
      ui_host: config.host,
      autocapture: false,
      capture_pageview: true,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      person_profiles: "never",
      persistence: "memory",
      cookieless_mode: "always",
    });
    client = posthog;
  } catch {
    client = undefined;
  }
}

// Pages call window.oopsware.track for a few deliberate events; off when analytics is off.
window.oopsware = {
  track(event, properties) {
    try {
      client?.capture(event, properties);
    } catch {
      /* analytics must never break the page */
    }
  },
};
