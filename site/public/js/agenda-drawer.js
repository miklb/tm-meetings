/**
 * Agenda Drawer — slide-out panel with focus trapping
 *
 * Desktop: slides in from right edge as overlay
 * Mobile: bottom sheet sliding up from bottom
 *
 * Follows existing project patterns (IIFE, var for compat,
 * global functions where needed).
 */
(function () {
  "use strict";

  var drawer = document.getElementById("agenda-drawer");
  var trigger = document.querySelector(".agenda-trigger");
  var backdrop = document.querySelector(".agenda-backdrop");
  var closeBtn = drawer ? drawer.querySelector(".agenda-drawer__close") : null;

  if (!drawer || !trigger) return;

  var isOpen = false;
  var lastFocusedElement = null;

  function open() {
    if (isOpen) return;
    isOpen = true;
    lastFocusedElement = document.activeElement;

    drawer.setAttribute("aria-hidden", "false");
    drawer.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    backdrop.classList.add("is-visible");
    document.body.classList.add("agenda-drawer-open");

    // Focus the close button after transition
    setTimeout(function () {
      if (closeBtn) closeBtn.focus();
    }, 100);

    document.addEventListener("keydown", handleKeyDown);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;

    drawer.setAttribute("aria-hidden", "true");
    drawer.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    backdrop.classList.remove("is-visible");
    document.body.classList.remove("agenda-drawer-open");

    document.removeEventListener("keydown", handleKeyDown);

    // Return focus to the trigger
    if (lastFocusedElement && lastFocusedElement.focus) {
      lastFocusedElement.focus();
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      close();
      return;
    }

    // Focus trap — cycle Tab within the drawer
    if (e.key === "Tab") {
      trapFocus(e);
    }
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
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Bind events
  trigger.addEventListener("click", function () {
    if (isOpen) {
      close();
    } else {
      open();
    }
  });

  if (closeBtn) {
    closeBtn.addEventListener("click", close);
  }

  if (backdrop) {
    backdrop.addEventListener("click", close);
  }

  // Expose for potential external use
  window.openAgendaDrawer = open;
  window.closeAgendaDrawer = close;
})();
