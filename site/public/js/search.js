/**
 * Transcript in-page search — builds an index from the .segment elements,
 * substring-matches, lists results with <mark> highlights, and scrolls the
 * chosen segment into view.
 *
 * Results are built with DOM APIs (never innerHTML from transcript text),
 * the result count is announced from a separate live region so the list
 * itself is not re-read on every keystroke, and choosing a result moves
 * focus to the segment.
 */
(function () {
  "use strict";

  var searchIndex = null;
  var announceTimer = null;
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function initializeSearch() {
    var searchInput = document.getElementById("transcript-search");
    var searchResults = document.getElementById("search-results");
    var status = document.getElementById("search-status");
    if (!searchInput || !searchResults) return;

    searchIndex = Array.prototype.map.call(
      document.querySelectorAll(".transcript-body .segment"),
      function (el, i) {
        var turn = el.closest(".transcript-turn");
        var speaker = turn ? turn.querySelector(".transcript-speaker") : null;
        var textEl = el.querySelector(".segment-text");
        var tsEl = el.querySelector(".transcript-timestamp");
        var text = textEl ? textEl.textContent : el.textContent;
        return {
          index: i,
          element: el,
          speaker: speaker ? speaker.textContent.trim() : "",
          text: text,
          timestamp: tsEl ? tsEl.textContent.trim() : "",
          searchText: text.toLowerCase(),
        };
      }
    );

    function announce(message) {
      if (!status) return;
      clearTimeout(announceTimer);
      announceTimer = setTimeout(function () { status.textContent = message; }, 400);
    }

    function hideResults() {
      searchResults.classList.remove("active");
      searchResults.replaceChildren();
    }

    searchInput.addEventListener("input", function (e) {
      var query = e.target.value.trim().toLowerCase();
      if (query.length < 2) {
        hideResults();
        announce("");
        return;
      }
      var count = performSearch(query, searchResults);
      announce(count === 0 ? "No results" : count + (count === 1 ? " result" : " results") +
        (count === 50 ? ", showing the first 50" : ""));
    });

    // Down arrow from the box moves into the list
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        hideResults();
        searchInput.value = "";
        announce("");
      } else if (e.key === "ArrowDown") {
        var first = searchResults.querySelector(".search-result-item");
        if (first) { e.preventDefault(); first.focus(); }
      }
    });

    searchResults.addEventListener("keydown", function (e) {
      var items = Array.prototype.slice.call(searchResults.querySelectorAll(".search-result-item"));
      var i = items.indexOf(document.activeElement);
      if (i === -1) return;
      if (e.key === "ArrowDown" && i < items.length - 1) { e.preventDefault(); items[i + 1].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); (i === 0 ? searchInput : items[i - 1]).focus(); }
      else if (e.key === "Escape") { e.preventDefault(); hideResults(); searchInput.focus(); }
    });

    document.addEventListener("click", function (e) {
      if (!e.target.closest(".search-container")) searchResults.classList.remove("active");
    });
  }

  /** Append `text` to `parent` with every match of `words` wrapped in <mark>. */
  function appendHighlighted(parent, text, words) {
    var pattern = new RegExp("(" + words.map(escapeRegExp).join("|") + ")", "gi");
    var last = 0;
    var m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var mark = document.createElement("mark");
      mark.textContent = m[0];
      parent.appendChild(mark);
      last = m.index + m[0].length;
      if (m[0].length === 0) pattern.lastIndex++;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function performSearch(query, container) {
    var results = searchIndex
      .filter(function (item) { return item.searchText.includes(query); })
      .slice(0, 50);
    var words = query.split(/\s+/).filter(Boolean);

    container.replaceChildren();
    var stats = document.createElement("div");
    stats.className = "search-stats";
    stats.textContent = results.length === 0
      ? "No results found"
      : "Found " + results.length + " result" + (results.length === 1 ? "" : "s");
    container.appendChild(stats);

    results.forEach(function (result) {
      var text = result.text;
      // Show a window around the first match
      var pos = result.searchText.indexOf(words[0] || query);
      if (text.length > 200) {
        var start = Math.max(0, pos - 50);
        var end = Math.min(text.length, pos + 150);
        text = (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length ? "…" : "");
      }

      var button = document.createElement("button");
      button.type = "button";
      button.className = "search-result-item";
      var who = document.createElement("span");
      who.className = "search-result-speaker";
      who.textContent = result.speaker + (result.timestamp ? " — " + result.timestamp : "");
      var body = document.createElement("span");
      body.className = "search-result-text";
      appendHighlighted(body, text, words);
      button.appendChild(who);
      button.appendChild(body);
      button.addEventListener("click", function () { scrollToSegment(result.index); });
      container.appendChild(button);
    });

    container.classList.add("active");
    return results.length;
  }

  function scrollToSegment(index) {
    var item = searchIndex[index];
    if (!item) return;
    var el = item.element;
    var searchResults = document.getElementById("search-results");
    if (searchResults) searchResults.classList.remove("active");

    document.querySelectorAll(".segment.search-highlight").forEach(function (s) {
      s.classList.remove("search-highlight");
    });

    el.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    el.classList.add("search-highlight");
    el.tabIndex = -1;
    el.focus({ preventScroll: true });

    setTimeout(function () { el.classList.remove("search-highlight"); }, 2000);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeSearch);
  } else {
    initializeSearch();
  }
})();
