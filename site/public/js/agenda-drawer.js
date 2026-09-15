/**
 * Agenda Drawer — slide-out panel with focus trapping.
 *
 * The agenda is rendered once, inline, in <section data-agenda-source>. This
 * script moves it into the drawer, reveals the trigger, and keeps the closed
 * drawer out of the tab order and the accessibility tree (`inert` +
 * visibility, set from CSS on .is-open). Without JS the inline agenda stays
 * put and the drawer chrome stays hidden.
 *
 * Deep links: a URL hash that targets an agenda item (#item-123) opens the
 * drawer and scrolls the item into view, so shared anchors keep working.
 */
(function () {
  "use strict";

  var drawer = document.getElementById("agenda-drawer");
  var trigger = document.querySelector(".agenda-trigger");
  var backdrop = document.querySelector(".agenda-backdrop");
  var source = document.querySelector("[data-agenda-source]");
  var target = drawer ? drawer.querySelector("[data-agenda-target]") : null;
  var closeBtn = drawer ? drawer.querySelector(".agenda-drawer__close") : null;

  if (!drawer || !trigger || !source || !target) return;

  // Move the agenda into the drawer and reveal the chrome
  while (source.firstChild) {
    var node = source.firstChild;
    if (node.id === "agenda-heading") {
      source.removeChild(node); // the drawer has its own heading
    } else {
      target.appendChild(node);
    }
  }
  source.hidden = true;
  drawer.hidden = false;
  if (backdrop) backdrop.hidden = false;
  trigger.hidden = false;

  var isOpen = false;
  var lastFocusedElement = null;
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function open() {
    if (isOpen) return;
    isOpen = true;
    lastFocusedElement = document.activeElement;

    drawer.inert = false;
    drawer.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    if (backdrop) backdrop.classList.add("is-visible");
    document.body.classList.add("agenda-drawer-open");

    // Focus the close button once the slide-in has run
    setTimeout(function () {
      if (closeBtn) closeBtn.focus();
    }, reducedMotion ? 0 : 100);

    document.addEventListener("keydown", handleKeyDown);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;

    drawer.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    if (backdrop) backdrop.classList.remove("is-visible");
    document.body.classList.remove("agenda-drawer-open");
    document.removeEventListener("keydown", handleKeyDown);

    // Return focus before the panel becomes inert
    if (lastFocusedElement && lastFocusedElement.focus) {
      lastFocusedElement.focus();
    }
    drawer.inert = true;
  }

  function handleKeyDown(e) {
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") trapFocus(e);
  }

  function trapFocus(e) {
    var focusable = drawer.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), ' +
      'textarea:not([disabled]), select:not([disabled]), ' +
      'details > summary, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // A hash pointing at something inside the drawer opens it
  function revealHash() {
    var hash = window.location.hash;
    if (!hash || hash.length < 2) return;
    var el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el || !drawer.contains(el)) return;
    open();
    setTimeout(function () {
      el.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
    }, reducedMotion ? 0 : 320);
  }

  trigger.addEventListener("click", function () {
    if (isOpen) close(); else open();
  });
  if (closeBtn) closeBtn.addEventListener("click", close);
  if (backdrop) backdrop.addEventListener("click", close);
  window.addEventListener("hashchange", revealHash);
  revealHash();

  // Expose for potential external use
  window.openAgendaDrawer = open;
  window.closeAgendaDrawer = close;
})();
